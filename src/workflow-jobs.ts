import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import {
  getActiveSessionOwner,
  isSessionOwnerLive,
  resolveLiveSessionScope,
  type SessionOwnerToken,
} from "./session-scope";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import { runWorkflow } from "./workflow-worker";
import {
  DEFAULT_WORKFLOW_OUTPUT_BUDGET,
  type RunWorkflowOptions,
  type WorkflowAgentRunner,
  type WorkflowAgentRecord,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  WorkflowExecutionError,
  WorkflowWallTimeoutError,
  MAX_WORKFLOW_AGENT_RECORDS,
  zeroWorkflowUsage,
} from "./workflow-core";
import {
  captureTelemetry,
  type TelemetryCompletionPolicy,
  type TelemetrySession,
  type TelemetryTerminalReason,
  type TelemetryWorkflowInvocation,
  type TelemetryWorkflowStatus,
} from "./telemetry";
import type { CompletionPolicy } from "./completion-coordinator";

// ── Background workflow-job registry ─────────────────────────────────
export interface WorkflowJobTelemetry {
  /** Session captured at acceptance so settlement cannot drift to a new owner. */
  session?: TelemetrySession;
  invocation: TelemetryWorkflowInvocation;
  async: boolean;
  completionPolicy: TelemetryCompletionPolicy;
}

export type WorkflowJobTelemetryOptions = Omit<WorkflowJobTelemetry, "session">;

function normalizeWorkflowInvocation(
  value: WorkflowJobTelemetryOptions["invocation"] | undefined,
): TelemetryWorkflowInvocation {
  return value === "saved_command" ? "saved_command" : "tool";
}

function normalizeWorkflowCompletionPolicy(
  value: WorkflowJobTelemetryOptions["completionPolicy"] | undefined,
  fallback: TelemetryCompletionPolicy,
): TelemetryCompletionPolicy {
  return value === "inline" ||
    value === "each" ||
    value === "group" ||
    value === "legacy"
    ? value
    : fallback;
}

function safeTelemetryNow(): number | undefined {
  try {
    const now = Date.now();
    return Number.isFinite(now) && now >= 0 ? now : undefined;
  } catch {
    return undefined;
  }
}

function workflowTelemetryDuration(
  startedAt: number,
  completedAt: number | undefined,
): number | undefined {
  if (
    completedAt === undefined ||
    !Number.isFinite(startedAt) ||
    startedAt < 0 ||
    completedAt < startedAt
  ) {
    return undefined;
  }
  return completedAt - startedAt;
}

function boundedWorkflowTelemetryCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value!), 0), 1_000);
}

function terminalReasonFromAbortReason(
  reason: unknown,
): TelemetryTerminalReason | undefined {
  if (!reason || typeof reason !== "object" || !("source" in reason)) {
    return undefined;
  }
  const source = reason.source;
  switch (source) {
    case "session_shutdown":
      return "session_shutdown";
    case "fresh_session":
      return "fresh_session";
    case "timeout":
      return "timeout";
    case "cancel_subagent":
      return "explicit_cancel";
    case "cancel_all":
    case "signal":
    case "workflow":
    case "supervisor":
      return "parent_cancelled";
    default:
      return undefined;
  }
}

function workflowTelemetryStatus(
  job: WorkflowJobState,
  result: WorkflowRunResult | undefined,
): TelemetryWorkflowStatus {
  if (job.status === "cancelled" || job.abort.signal.aborted) {
    return "cancelled";
  }
  if (job.status === "error") return "error";
  return result && result.errorCount > 0 ? "partial" : "success";
}

function isWorkflowWallTimeout(error: unknown): boolean {
  if (error instanceof WorkflowWallTimeoutError) return true;
  if (!(error instanceof WorkflowExecutionError)) return false;
  return (
    (error as WorkflowExecutionError & { cause?: unknown }).cause instanceof
    WorkflowWallTimeoutError
  );
}

function workflowTelemetryTerminalReason(
  job: WorkflowJobState,
  status: TelemetryWorkflowStatus,
): TelemetryTerminalReason {
  if (status === "success") return "completed";
  if (status === "partial") return "agent_error";
  if (status === "error") return job.telemetryTerminalReason ?? "agent_error";
  return (
    job.telemetryTerminalReason ??
    terminalReasonFromAbortReason(job.abort.signal.reason) ??
    "unknown"
  );
}

function emitWorkflowStartedTelemetry(job: WorkflowJobState): void {
  const telemetry = job.telemetry;
  if (!telemetry) return;
  captureTelemetry(telemetry.session, {
    event: "workflow_started",
    invocation: telemetry.invocation,
    async: telemetry.async,
    completion_policy: telemetry.completionPolicy,
  });
}

function emitWorkflowCompletedTelemetry(
  job: WorkflowJobState,
  result: WorkflowRunResult | undefined,
): void {
  if (job.telemetryCompleted) return;
  job.telemetryCompleted = true;
  if (job.completedAt === undefined) job.completedAt = safeTelemetryNow();
  const status = workflowTelemetryStatus(job, result);
  const telemetry = job.telemetry;
  if (!telemetry) return;
  const agentsSpawned = boundedWorkflowTelemetryCount(
    result?.agentsSpawned ?? job.snapshot.agentsSpawned,
  );
  const errorCount = boundedWorkflowTelemetryCount(
    result?.errorCount ?? job.snapshot.errorCount,
  );
  const durationMs = workflowTelemetryDuration(job.startedAt, job.completedAt);
  captureTelemetry(
    telemetry.session,
    {
      event: "workflow_completed",
      invocation: telemetry.invocation,
      async: telemetry.async,
      completion_policy: telemetry.completionPolicy,
      status,
      terminal_reason: workflowTelemetryTerminalReason(job, status),
      agents_spawned: agentsSpawned,
      error_count: errorCount,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    },
    { allowInactive: true },
  );
}

export type WorkflowJobStatus = "running" | "done" | "error" | "cancelled";

export interface WorkflowJobState {
  id: string;
  name: string;
  status: WorkflowJobStatus;
  executionMode?: "async" | "sync";
  startedAt: number;
  completedAt?: number;
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
    /** @deprecated Output-token count; use usage.output. */
    tokensSpent: number;
    /** Soft completed-output-token target, if configured. */
    budgetTotal?: number | null;
    usage?: WorkflowUsage;
    /** Aggregate usage from every active agent that reports a live sample. */
    liveUsage?: WorkflowUsage;
    phases: string[];
    lastMessage?: string;
    currentPhase?: string;
    agentRecords?: WorkflowAgentRecord[];
    agentRecordsOmitted?: number;
    runningCount?: number;
  };
  result?: WorkflowRunResult;
  error?: string;
  /**
   * Coordinated terminal rows retain their backing result until explicit
   * get_workflow_result collection releases this protection.
   */
  resultRetrieved?: boolean;
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
  parentSessionOwner?: SessionOwnerToken;
  /** Guards the aggregate terminal event against reentrant settlement paths. */
  telemetryCompleted?: boolean;
  completionPolicy?: CompletionPolicy;
  completionGroupId?: string;
  /** Telemetry metadata captured at acceptance for aggregate lifecycle events. */
  telemetry?: WorkflowJobTelemetry;
  /** Evidence-backed cancellation reason for the aggregate terminal event. */
  telemetryTerminalReason?: TelemetryTerminalReason;
}

function isProtectedCoordinatedResult(job: WorkflowJobState): boolean {
  return (
    (job.status === "done" || job.status === "error") &&
    job.completionPolicy !== undefined &&
    !job.resultRetrieved
  );
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
  owner: SessionOwnerToken | undefined,
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
  return workflowJobBelongsToOwner(job, getActiveSessionOwner());
}

export function getWorkflowJobForActiveSession(
  workflowId: string,
): WorkflowJobState | undefined {
  return getWorkflowJobForOwner(workflowId, getActiveSessionOwner());
}

export function getWorkflowJobForOwner(
  workflowId: string,
  owner: SessionOwnerToken | undefined,
): WorkflowJobState | undefined {
  const job = workflowJobRegistry.get(workflowId);
  if (!job || !workflowJobBelongsToOwner(job, owner)) return undefined;
  return job;
}

export function workflowJobsForActiveSession(): WorkflowJobState[] {
  return workflowJobsForOwner(getActiveSessionOwner());
}

export function workflowJobsForOwner(
  owner: SessionOwnerToken | undefined,
): WorkflowJobState[] {
  return [...workflowJobRegistry.values()].filter((job) =>
    workflowJobBelongsToOwner(job, owner),
  );
}

export function cleanupWorkflowJobsForOwner(
  owner: SessionOwnerToken | undefined,
  terminalReason: TelemetryTerminalReason = "session_shutdown",
): void {
  for (const [id, job] of workflowJobRegistry) {
    if (!workflowJobBelongsToOwner(job, owner)) continue;
    job.suppressCompletionNotification = true;
    if (job.status === "running" || job.status === "cancelled") {
      cancelWorkflowJob(job, terminalReason);
    }
    workflowJobRegistry.delete(id);
  }
}

/**
 * Cancel one workflow exactly once while retaining typed terminal evidence for
 * settlement telemetry and result-read latency.
 */
export function cancelWorkflowJob(
  job: WorkflowJobState,
  terminalReason: TelemetryTerminalReason,
): void {
  if (job.status !== "running" && job.status !== "cancelled") return;
  if (job.telemetryTerminalReason === undefined) {
    job.telemetryTerminalReason = terminalReason;
  }
  if (job.completedAt === undefined) job.completedAt = safeTelemetryNow();
  const wasRunning = job.status === "running";
  if (wasRunning) {
    job.status = "cancelled";
    normalizeCancelledWorkflowState(job);
    try {
      job.abort.abort({
        source:
          terminalReason === "explicit_cancel"
            ? "cancel_subagent"
            : terminalReason === "session_shutdown" ||
                terminalReason === "fresh_session"
              ? "session_shutdown"
              : "workflow",
        reason:
          terminalReason === "fresh_session"
            ? "session_start (new)"
            : terminalReason,
      });
    } catch {
      /* The workflow may already be aborting. */
    }
  } else {
    normalizeCancelledWorkflowState(job);
  }
  invokeWorkflowCompletionHook(job);
}

/** Roll back a just-created workflow whose completion registration failed. */
export function discardWorkflowJob(job: WorkflowJobState): void {
  job.suppressCompletionNotification = true;
  if (job.status === "running") {
    try {
      job.abort.abort();
    } catch {
      /* The workflow may already be aborting. */
    }
    job.status = "cancelled";
    normalizeCancelledWorkflowState(job);
  }
  if (workflowJobRegistry.get(job.id) === job) {
    workflowJobRegistry.delete(job.id);
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
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
  telemetryOptions?: WorkflowJobTelemetryOptions,
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
    // Evict the oldest unprotected terminal job; protected results and running
    // jobs require explicit collection or cancellation.
    let evicted = false;
    for (const [id, st] of workflowJobRegistry) {
      if (
        st.status !== "running" &&
        !isProtectedCoordinatedResult(st) &&
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
        `${MAX_WORKFLOW_JOBS} workflow jobs are retained or running — collect a terminal result with get_workflow_result, or cancel a running workflow, before starting another.`,
      );
    }
  }

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const defaultAsync = executionMode === "async";
  const defaultCompletionPolicy: TelemetryCompletionPolicy = defaultAsync
    ? "legacy"
    : "inline";
  const telemetryAsync =
    typeof telemetryOptions?.async === "boolean"
      ? telemetryOptions.async
      : defaultAsync;
  const telemetry: WorkflowJobTelemetry = {
    session: resolveLiveSessionScope(parentSessionOwner)?.telemetry,
    invocation: normalizeWorkflowInvocation(telemetryOptions?.invocation),
    async: telemetryAsync,
    completionPolicy: normalizeWorkflowCompletionPolicy(
      telemetryOptions?.completionPolicy,
      defaultCompletionPolicy,
    ),
  };
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
      budgetTotal: opts.budgetTotal ?? DEFAULT_WORKFLOW_OUTPUT_BUDGET,
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
    telemetry,
  };
  emitWorkflowStartedTelemetry(state);
  const liveUsageByAgent = new Map<number, WorkflowUsage>();
  state.promise = runWorkflow(script, {
    ...opts,
    runAgent: (request) =>
      runTrackedWorkflowAgent(state, opts.runAgent, request),
    signal: abort.signal,
    onProgress: (p) => {
      state.snapshot.agentsSpawned = p.agentsSpawned;
      state.snapshot.errorCount = p.errorCount;
      state.snapshot.tokensSpent = p.tokensSpent;
      state.snapshot.budgetTotal = p.budgetTotal ?? state.snapshot.budgetTotal;
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
      if (typeof p.agentId === "number") {
        if (p.liveUsage) {
          liveUsageByAgent.set(p.agentId, { ...p.liveUsage });
          recordWorkflowAgentLiveUsage(state.snapshot, p.agentId, p.liveUsage);
        }
        if (p.kind === "agent_done") liveUsageByAgent.delete(p.agentId);
      }
      state.snapshot.liveUsage = aggregateWorkflowLiveUsage(liveUsageByAgent);
      opts.onProgress?.(p);
    },
    onCancellationSnapshot: (receipt) => {
      (state.cancellationSnapshots ??= []).push(receipt);
    },
  })
    .then((r) => {
      if (state.status === "running") state.status = "done";
      state.result = r;
      state.snapshot.liveUsage = undefined;
      liveUsageByAgent.clear();
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      emitWorkflowCompletedTelemetry(state, r);
      invokeWorkflowCompletionHook(state);
      return r;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (isWorkflowWallTimeout(err)) state.telemetryTerminalReason = "timeout";
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      if (err instanceof WorkflowExecutionError && err.usage) {
        state.snapshot.usage = { ...err.usage };
        state.snapshot.tokensSpent = err.usage.output;
      }
      state.snapshot.liveUsage = undefined;
      liveUsageByAgent.clear();
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      emitWorkflowCompletedTelemetry(state, undefined);
      invokeWorkflowCompletionHook(state);
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

export function invokeWorkflowCompletionHook(job: WorkflowJobState): void {
  const callback = job.completionNotification;
  if (
    !callback ||
    job.completionNotificationDelivered ||
    job.suppressCompletionNotification
  ) {
    return;
  }
  if (job.parentSessionOwner && !isSessionOwnerLive(job.parentSessionOwner)) {
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
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
): void {
  for (const job of workflowJobsForOwner(owner)) {
    if (job.status === "running") continue;
    invokeWorkflowCompletionHook(job);
  }
}

export function normalizeCancelledWorkflowState(state: WorkflowJobState): void {
  if (!state.snapshot) return;
  state.snapshot.runningCount = 0;
  state.snapshot.liveUsage = undefined;
  for (const record of state.snapshot.agentRecords ?? []) {
    if (record.status === "running") record.status = "cancelled";
  }
}

/** Count running workflow jobs (status === "running"). */
export function getRunningWorkflowCount(
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
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
    const nextRecord: WorkflowAgentRecord = {
      agentId: progress.agentId,
      phase: progress.phase,
      label: progress.label,
      status: "running",
    };
    if (progress.model !== undefined) nextRecord.model = progress.model;
    records.push(nextRecord);
  } else {
    const record = records.find(
      (candidate) => candidate.agentId === progress.agentId,
    );
    if (record) {
      record.status = progress.status ?? "done";
      if (progress.agentUsage) record.usage = { ...progress.agentUsage };
      if (progress.model !== undefined) record.model = progress.model;
    } else {
      const nextRecord: WorkflowAgentRecord = {
        agentId: progress.agentId,
        phase: progress.phase,
        label: progress.label,
        status: progress.status ?? "done",
      };
      if (progress.agentUsage) nextRecord.usage = { ...progress.agentUsage };
      if (progress.model !== undefined) nextRecord.model = progress.model;
      records.push(nextRecord);
    }
  }
  while (records.length > MAX_WORKFLOW_AGENT_RECORDS) {
    records.shift();
    snapshot.agentRecordsOmitted = (snapshot.agentRecordsOmitted ?? 0) + 1;
  }
}

function recordWorkflowAgentLiveUsage(
  snapshot: WorkflowJobState["snapshot"],
  agentId: number,
  usage: WorkflowUsage,
): void {
  const record = snapshot.agentRecords?.find(
    (candidate) => candidate.agentId === agentId,
  );
  if (record?.status === "running") record.usage = { ...usage };
}

function aggregateWorkflowLiveUsage(
  samples: ReadonlyMap<number, WorkflowUsage>,
): WorkflowUsage | undefined {
  if (samples.size === 0) return undefined;
  const total = zeroWorkflowUsage();
  let costSource: WorkflowUsage["costSource"];
  for (const usage of samples.values()) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.costUsd += usage.costUsd;
    total.turns += usage.turns;
    const nextSource =
      usage.costSource ??
      (usage.costUsd > 0
        ? "estimated"
        : usage.totalTokens > 0
          ? "unavailable"
          : undefined);
    if (nextSource) {
      costSource =
        costSource === undefined || costSource === nextSource
          ? nextSource
          : "mixed";
    }
  }
  total.totalTokens =
    total.input + total.output + total.cacheRead + total.cacheWrite;
  if (costSource) total.costSource = costSource;
  return total;
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
