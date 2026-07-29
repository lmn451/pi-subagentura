import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import {
  getActiveSessionContextToken,
  isSessionContextTokenLive,
  type ActiveSessionContextToken,
} from "./session-context";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import { runWorkflow } from "./workflow-worker";
import {
  type RunWorkflowOptions,
  type WorkflowAgentRunner,
  type WorkflowAgentRecord,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  MAX_WORKFLOW_AGENT_RECORDS,
  zeroWorkflowUsage,
} from "./workflow-core";

// ── Background workflow-job registry ─────────────────────────────────

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowJobState {
  id: string;
  name: string;
  status: WorkflowJobStatus;
  executionMode?: "async" | "sync";
  startedAt: number;
  /**
   * Settles with the runner's own result shape, where `usage` is always present.
   * Widening to {@link WorkflowRunResult} here would force every consumer to
   * tolerate a usage-less summary that `runWorkflow` never produces.
   */
  promise: Promise<WorkflowRunResultWithUsage>;
  abort: AbortController;
  snapshot: {
    agentsSpawned: number;
    errorCount: number;
    /** @deprecated Output-token count; use usage.totalTokens. */
    tokensSpent: number;
    usage?: WorkflowUsage;
    phases: string[];
    lastMessage?: string;
    currentPhase?: string;
    agentRecords?: WorkflowAgentRecord[];
    agentRecordsOmitted?: number;
    runningCount?: number;
  };
  result?: WorkflowRunResult;
  error?: string;
  /** Completion notification callback bound to the current parent session. */
  completionNotification?: (job: WorkflowJobState) => boolean | void;
  /** Set only after the completion callback reports a successful delivery. */
  completionNotificationDelivered?: boolean;
  /** Set during parent shutdown so late settlement cannot notify a replacement session. */
  suppressCompletionNotification?: boolean;
  /** Receipts captured by nested agents during workflow cancellation. */
  cancellationSnapshots?: CancellationSnapshotReceipt[];
  /** Active runner lifecycles that must drain before cancellation receipts are final. */
  activeAgentRuns?: Set<Promise<void>>;
  /** Set when notification attempts are exhausted. Prevents re-logging. */
  _notificationExhausted?: boolean;
  /** Synchronous reentrant guard — set while the delivery callback is in flight. */
  _notificationInFlight?: boolean;
  /** Number of successful delivery attempts. Only increments on success. */
  notificationAttempt?: number;
  /** Parent session lifecycle that owns this workflow job. */
  parentSessionOwner?: ActiveSessionContextToken;
}
const g = typeof global !== "undefined" ? global : globalThis;
declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaWorkflowJobs: Map<string, WorkflowJobState> | undefined;
}
if (!g.__piSubagenturaWorkflowJobs) {
  g.__piSubagenturaWorkflowJobs = new Map<string, WorkflowJobState>();
}
export const workflowJobRegistry = g.__piSubagenturaWorkflowJobs as Map<
  string,
  WorkflowJobState
>;

export const MAX_WORKFLOW_JOBS = 100;

/** Maximum notification delivery attempts before giving up. */
export const MAX_WORKFLOW_NOTIFICATION_ATTEMPTS = 5;

export function workflowJobBelongsToOwner(
  job: WorkflowJobState,
  owner: ActiveSessionContextToken | undefined,
): boolean {
  if (!owner) return !job.parentSessionOwner;
  return (
    job.parentSessionOwner?.id === owner.id &&
    job.parentSessionOwner?.generation === owner.generation
  );
}

export function workflowJobBelongsToActiveSession(
  job: WorkflowJobState,
): boolean {
  return workflowJobBelongsToOwner(job, getActiveSessionContextToken());
}

export function getWorkflowJobForActiveSession(
  workflowId: string,
): WorkflowJobState | undefined {
  return getWorkflowJobForOwner(workflowId, getActiveSessionContextToken());
}

export function getWorkflowJobForOwner(
  workflowId: string,
  owner: ActiveSessionContextToken | undefined,
): WorkflowJobState | undefined {
  const job = workflowJobRegistry.get(workflowId);
  if (!job || !workflowJobBelongsToOwner(job, owner)) return undefined;
  return job;
}

export function workflowJobsForActiveSession(): WorkflowJobState[] {
  return workflowJobsForOwner(getActiveSessionContextToken());
}

export function workflowJobsForOwner(
  owner: ActiveSessionContextToken | undefined,
): WorkflowJobState[] {
  return [...workflowJobRegistry.values()].filter((job) =>
    workflowJobBelongsToOwner(job, owner),
  );
}

export function cleanupWorkflowJobsForOwner(
  owner: ActiveSessionContextToken | undefined,
): void {
  for (const [id, job] of workflowJobRegistry) {
    if (!workflowJobBelongsToOwner(job, owner)) continue;
    job.suppressCompletionNotification = true;
    if (job.status === "running") {
      job.abort.abort();
      job.status = "cancelled";
    }
    if (job.status === "cancelled") normalizeCancelledWorkflowState(job);
    workflowJobRegistry.delete(id);
  }
}

async function runTrackedWorkflowAgent(
  state: WorkflowJobState,
  runner: WorkflowAgentRunner,
  request: Parameters<WorkflowAgentRunner>[0],
): Promise<Awaited<ReturnType<WorkflowAgentRunner>>> {
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const activeRuns = (state.activeAgentRuns ??= new Set());
  activeRuns.add(settled);
  try {
    return await runner(request);
  } finally {
    activeRuns.delete(settled);
    release();
  }
}

export type StartWorkflowJobOptions = Omit<
  RunWorkflowOptions,
  "signal" | "onProgress" | "onCancellationSnapshot"
> &
  Pick<RunWorkflowOptions, "signal" | "onProgress">;

/**
 * Start a workflow running in the background. Returns the job id immediately.
 *
 * `opts` may be a builder so callers that need the job id while constructing the
 * options (e.g. to tag spawned children with their owning `workflowId`) receive it
 * before `runWorkflow` can invoke `runAgent`.
 */
export function startWorkflowJob(
  name: string,
  script: string,
  optsOrBuilder:
    StartWorkflowJobOptions | ((workflowId: string) => StartWorkflowJobOptions),
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: ActiveSessionContextToken | undefined = getActiveSessionContextToken(),
  executionMode: "async" | "sync" = "async",
): WorkflowJobState {
  const parentSessionOwner = owner;
  // A blocking sync workflow ran unconditionally before it was tracked here.
  // Subjecting it to the cap would turn an always-succeeding call into a new
  // user-visible failure, so sync jobs are exempt — they are also removed from
  // the registry as soon as they settle, so they cannot accumulate.
  while (
    executionMode === "async" &&
    workflowJobRegistry.size >= MAX_WORKFLOW_JOBS
  ) {
    // Evict the oldest terminal job; if none, throw — the caller must cancel one first.
    let evicted = false;
    for (const [id, st] of workflowJobRegistry) {
      if (
        st.status !== "running" &&
        workflowJobBelongsToOwner(st, parentSessionOwner)
      ) {
        debugLog("info", "workflow_job_evicted", { evictedId: id });
        workflowJobRegistry.delete(id);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      throw new Error(
        `${MAX_WORKFLOW_JOBS} workflow jobs already running — cancel one with cancel_workflow before starting another.`,
      );
    }
  }

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const opts =
    typeof optsOrBuilder === "function" ? optsOrBuilder(id) : optsOrBuilder;
  const abort = new AbortController();
  const externalSignal = opts.signal;
  const forwardAbort = () => abort.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const state: WorkflowJobState = {
    id,
    name,
    status: "running",
    executionMode,
    startedAt: startedAt ?? Date.now(),
    promise: undefined as unknown as Promise<WorkflowRunResultWithUsage>,
    abort,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: zeroWorkflowUsage(),
      phases: [],
      agentRecords: [],
      agentRecordsOmitted: 0,
      runningCount: 0,
    },
    completionNotification: onComplete,
    completionNotificationDelivered: false,
    cancellationSnapshots: [],
    activeAgentRuns: new Set(),
    parentSessionOwner,
  };
  state.promise = runWorkflow(script, {
    ...opts,
    runAgent: (request) =>
      runTrackedWorkflowAgent(state, opts.runAgent, request),
    signal: abort.signal,
    onProgress: (p) => {
      state.snapshot.agentsSpawned = p.agentsSpawned;
      state.snapshot.errorCount = p.errorCount;
      state.snapshot.tokensSpent = p.tokensSpent;
      state.snapshot.usage = p.usage ? { ...p.usage } : state.snapshot.usage;
      state.snapshot.runningCount = p.runningCount;
      if (p.kind === "phase" && p.phase) {
        state.snapshot.currentPhase = p.phase;
        state.snapshot.phases.push(p.phase);
        state.snapshot.lastMessage = `◆ phase: ${p.phase}`;
      } else if (p.kind === "log" && p.message) {
        state.snapshot.lastMessage = p.message;
      } else if (p.kind === "agent_start") {
        state.snapshot.lastMessage = `→ started${formatWorkflowAgentTag(p)}`;
      } else if (p.kind === "agent_done") {
        state.snapshot.lastMessage = `→ done${formatWorkflowAgentTag(p)}`;
      }
      if (p.kind === "agent_start" || p.kind === "agent_done") {
        recordWorkflowAgentProgress(state.snapshot, p);
      }
      opts.onProgress?.(p);
    },
    onCancellationSnapshot: (receipt) => {
      (state.cancellationSnapshots ??= []).push(receipt);
    },
  })
    .then((r) => {
      if (state.status === "running") state.status = "done";
      state.result = r;
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      return r;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      throw err;
    })
    .finally(() => {
      externalSignal?.removeEventListener("abort", forwardAbort);
      // A sync workflow returns its result inline. Retaining the terminal job
      // would let get_workflow_result re-serve that result and would leave a dead
      // `done` row in the supervisor for work the caller already collected.
      if (executionMode === "sync" && workflowJobRegistry.get(id) === state) {
        workflowJobRegistry.delete(id);
      }
    });
  // Don't crash the process on an unobserved rejection before get_workflow_result is called.
  state.promise.catch(() => {});
  workflowJobRegistry.set(id, state);
  return state;
}

function invokeCompletionHook(job: WorkflowJobState): void {
  const callback = job.completionNotification;
  if (
    !callback ||
    job.completionNotificationDelivered ||
    job.suppressCompletionNotification
  ) {
    return;
  }
  if (
    job.parentSessionOwner &&
    !isSessionContextTokenLive(job.parentSessionOwner)
  ) {
    return;
  }
  // Already exhausted — no-op, no increment, no log.
  if (job._notificationExhausted) return;
  // Synchronous reentrant guard: prevents recursive retry from
  // calling the same callback while it is still on the call stack.
  if (job._notificationInFlight) return;
  job._notificationInFlight = true;
  try {
    // Increment on every invocation (including throws) for truthful total count.
    job.notificationAttempt = (job.notificationAttempt ?? 0) + 1;
    const result = callback(job);
    // Only mark delivered on success; throw goes to catch.
    if (result !== false) {
      job.completionNotificationDelivered = true;
    }
    // Mark exhausted only if the callback explicitly returned false.
    if (
      result === false &&
      job.notificationAttempt >= MAX_WORKFLOW_NOTIFICATION_ATTEMPTS
    ) {
      job._notificationExhausted = true;
      debugLog("warn", "workflow_notification_exhausted", {
        workflowId: job.id,
        attempts: job.notificationAttempt,
      });
    }
  } catch (err) {
    debugLog("warn", "workflow_completion_hook_failed", {
      workflowId: job.id,
      attempt: job.notificationAttempt,
      error: err instanceof Error ? err.message : String(err),
    });
    // Mark exhausted after the MAXth failed invocation.
    if ((job.notificationAttempt ?? 0) >= MAX_WORKFLOW_NOTIFICATION_ATTEMPTS) {
      job._notificationExhausted = true;
      debugLog("warn", "workflow_notification_exhausted", {
        workflowId: job.id,
        attempts: job.notificationAttempt,
      });
    }
  } finally {
    job._notificationInFlight = false;
  }
}

/** Retry terminal workflow notifications that failed in this parent session. */
export function retryPendingWorkflowNotifications(
  owner: ActiveSessionContextToken | undefined = getActiveSessionContextToken(),
): void {
  for (const job of workflowJobsForOwner(owner)) {
    if (job.status === "running") continue;
    invokeCompletionHook(job);
  }
}

export function normalizeCancelledWorkflowState(state: WorkflowJobState): void {
  if (!state.snapshot) return;
  state.snapshot.runningCount = 0;
  for (const record of state.snapshot.agentRecords ?? []) {
    if (record.status === "running") record.status = "cancelled";
  }
}

/** Count running workflow jobs (status === "running"). */
export function getRunningWorkflowCount(
  owner: ActiveSessionContextToken | undefined = getActiveSessionContextToken(),
): number {
  let count = 0;
  for (const st of workflowJobRegistry.values()) {
    if (st.status === "running" && workflowJobBelongsToOwner(st, owner))
      count++;
  }
  return count;
}

function recordWorkflowAgentProgress(
  snapshot: WorkflowJobState["snapshot"],
  progress: Extract<WorkflowProgress, { kind: "agent_start" | "agent_done" }>,
): void {
  if (typeof progress.agentId !== "number") return;
  const records = (snapshot.agentRecords ??= []);
  if (progress.kind === "agent_start") {
    records.push({
      agentId: progress.agentId,
      phase: progress.phase,
      label: progress.label,
      model: progress.model,
      status: "running",
    });
  } else {
    const record = records.find(
      (candidate) => candidate.agentId === progress.agentId,
    );
    if (record) {
      record.status = progress.status ?? "done";
    } else {
      records.push({
        agentId: progress.agentId,
        phase: progress.phase,
        label: progress.label,
        model: progress.model,
        status: progress.status ?? "done",
      });
    }
  }
  while (records.length > MAX_WORKFLOW_AGENT_RECORDS) {
    records.shift();
    snapshot.agentRecordsOmitted = (snapshot.agentRecordsOmitted ?? 0) + 1;
  }
}

function formatWorkflowAgentTag(p: WorkflowProgress): string {
  const label = p.label ? ` ${p.label}` : " agent";
  const model = p.model ? ` @${p.model}` : "";
  return `${label}${model}`;
}

export interface WorkflowCompletionPresentation {
  label: string;
  icon: string;
}

/** Preserve raw `done` while exposing a warning presentation for resolved errors. */
export function getWorkflowCompletionPresentation(
  status: WorkflowJobStatus,
  errorCount: number,
): WorkflowCompletionPresentation {
  if (status === "done" && errorCount > 0) {
    return { label: "completed with errors", icon: "⚠" };
  }
  return { label: status, icon: "" };
}
