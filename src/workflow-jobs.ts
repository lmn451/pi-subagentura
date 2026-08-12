import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import {
  getActiveSessionOwner,
  isSessionOwnerLive,
  type SessionOwnerToken,
} from "./session-scope";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import { runWorkflow } from "./workflow-worker";
import {
  runWorkflowPlan,
  type WorkflowPlanRunOptions,
} from "./workflow-plan-runner";
import {
  createWorkflowPlanState,
  type WorkflowPlanState,
} from "./workflow-plan-state";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import {
  addWorkflowUsage,
  type RunWorkflowOptions,
  type WorkflowAgentRunner,
  type WorkflowAgentRecord,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  WorkflowExecutionError,
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
    /** Declarative preview state, present only for plan-backed jobs. */
    planState?: WorkflowPlanState;
    agentRecords?: WorkflowAgentRecord[];
    agentRecordsOmitted?: number;
    runningCount?: number;
    planState?: WorkflowPlanState;
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
  parentSessionOwner?: SessionOwnerToken;
}
export interface DurableWorkflowLiveJob {
  id: string;
  name: string;
  startedAt: number;
  runEpoch: number;
  promise: Promise<unknown>;
  abort: AbortController;
  parentSessionOwner?: SessionOwnerToken;
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
declare global {
  // eslint-disable-next-line no-var
  var __piSubagenturaDurableWorkflowLiveJobs:
    Map<string, DurableWorkflowLiveJob> | undefined;
}
if (!g.__piSubagenturaDurableWorkflowLiveJobs) {
  g.__piSubagenturaDurableWorkflowLiveJobs = new Map();
}
export const durableWorkflowLiveJobRegistry =
  g.__piSubagenturaDurableWorkflowLiveJobs as Map<
    string,
    DurableWorkflowLiveJob
  >;

export const MAX_WORKFLOW_JOBS = 100;
export function createDurableWorkflowRunId(): string {
  for (;;) {
    const runId = `wf_${randomBytes(16).toString("hex")}`;
    if (
      !workflowJobRegistry.has(runId) &&
      !durableWorkflowLiveJobRegistry.has(runId)
    ) {
      return runId;
    }
  }
}

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
export function getDurableWorkflowLiveJobForOwner(
  workflowId: string,
  owner: SessionOwnerToken | undefined,
): DurableWorkflowLiveJob | undefined {
  const job = durableWorkflowLiveJobRegistry.get(workflowId);
  if (!job) return undefined;
  if (!owner) return job.parentSessionOwner ? undefined : job;
  return job.parentSessionOwner?.id === owner.id &&
    job.parentSessionOwner.generation === owner.generation
    ? job
    : undefined;
}

export function registerDurableWorkflowLiveJob(
  job: DurableWorkflowLiveJob,
): void {
  if (
    workflowJobRegistry.has(job.id) ||
    durableWorkflowLiveJobRegistry.has(job.id)
  ) {
    throw new Error(`Workflow id is already live: ${job.id}`);
  }
  durableWorkflowLiveJobRegistry.set(job.id, job);
  const forget = () => {
    if (durableWorkflowLiveJobRegistry.get(job.id) === job) {
      durableWorkflowLiveJobRegistry.delete(job.id);
    }
  };
  void job.promise.then(forget, forget);
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
): Promise<void> {
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

  const durableCompletions: Promise<unknown>[] = [];
  for (const [id, job] of durableWorkflowLiveJobRegistry) {
    const belongs = owner
      ? job.parentSessionOwner?.id === owner.id &&
        job.parentSessionOwner.generation === owner.generation
      : !job.parentSessionOwner;
    if (!belongs) continue;
    durableCompletions.push(job.promise);
    job.abort.abort(
      new Error("Durable workflow interrupted by parent session shutdown"),
    );
    durableWorkflowLiveJobRegistry.delete(id);
  }
  return Promise.allSettled(durableCompletions).then(() => undefined);
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

export type StartWorkflowPlanJobOptions = Pick<
  WorkflowPlanRunOptions,
  "runAgent" | "signal" | "onState"
> & {
  budgetTotal?: number | null;
};

type SharedWorkflowJobOptions = {
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  budgetTotal?: number | null;
};

type WorkflowJobExecutor<TOptions extends SharedWorkflowJobOptions> = (
  state: WorkflowJobState,
  options: TOptions,
  signal: AbortSignal,
) => Promise<WorkflowRunResultWithUsage>;

/**
 * Start a JavaScript workflow. The shared lifecycle keeps script and plan jobs
 * in the same registry with identical ownership, cancellation, settlement, and
 * retention behavior.
 *
 * `opts` may be a builder so callers that need the job id while constructing the
 * options (e.g. to tag spawned children with their owning `workflowId`) receive it
 * before either runner can invoke `runAgent`.
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
): WorkflowJobState {
  return startSharedWorkflowJob(
    name,
    optsOrBuilder,
    startedAt,
    onComplete,
    owner,
    executionMode,
    (state, opts, signal) => {
      const liveUsageByAgent = new Map<number, WorkflowUsage>();
      return runWorkflow(script, {
        ...opts,
        runAgent: (request) =>
          runTrackedWorkflowAgent(state, opts.runAgent, request),
        signal,
        onProgress: (p) => {
          state.snapshot.agentsSpawned = p.agentsSpawned;
          state.snapshot.errorCount = p.errorCount;
          state.snapshot.tokensSpent = p.tokensSpent;
          state.snapshot.budgetTotal =
            p.budgetTotal ?? state.snapshot.budgetTotal;
          state.snapshot.usage = p.usage
            ? { ...p.usage }
            : state.snapshot.usage;
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
              recordWorkflowAgentLiveUsage(
                state.snapshot,
                p.agentId,
                p.liveUsage,
              );
            }
            if (p.kind === "agent_done") liveUsageByAgent.delete(p.agentId);
          }
          state.snapshot.liveUsage =
            aggregateWorkflowLiveUsage(liveUsageByAgent);
          opts.onProgress?.(p);
        },
        onCancellationSnapshot: (receipt) => {
          (state.cancellationSnapshots ??= []).push(receipt);
        },
      }).finally(() => liveUsageByAgent.clear());
    },
  );
}

/**
 * Start a validated declarative preview through the ordinary workflow-job
 * lifecycle. Validation and initial-state construction happen before the shared
 * registry or runner is touched.
 */
export function startWorkflowPlanJob(
  plan: WorkflowPlan,
  optsOrBuilder:
    | StartWorkflowPlanJobOptions
    | ((workflowId: string) => StartWorkflowPlanJobOptions),
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
): WorkflowJobState {
  validateWorkflowPlan(plan);
  const initialPlanState = createWorkflowPlanState(plan);
  return startSharedWorkflowJob(
    plan.name,
    optsOrBuilder,
    startedAt,
    onComplete,
    owner,
    executionMode,
    (state, opts, signal) => {
      state.snapshot.planState = initialPlanState;
      return runWorkflowPlan(plan, {
        runAgent: (request) =>
          runTrackedWorkflowAgent(state, opts.runAgent, request),
        signal,
        onState: (planState) => {
          state.snapshot.planState = planState;
          state.snapshot.currentPhase = planState.currentPhase;
          if (
            planState.currentPhase &&
            state.snapshot.phases.at(-1) !== planState.currentPhase
          ) {
            state.snapshot.phases.push(planState.currentPhase);
          }
          const taskStates = Object.values(planState.tasks);
          const startedTaskCount = taskStates.filter(
            (status) =>
              status === "running" ||
              status === "succeeded" ||
              status === "failed",
          ).length;
          state.snapshot.agentsSpawned = Math.max(
            state.snapshot.agentsSpawned,
            startedTaskCount,
          );
          state.snapshot.errorCount = taskStates.filter(
            (status) => status === "failed",
          ).length;
          state.snapshot.runningCount = taskStates.filter(
            (status) => status === "running",
          ).length;
          opts.onState?.(planState);
        },
      });
    },
  );
}

function startSharedWorkflowJob<TOptions extends SharedWorkflowJobOptions>(
  name: string,
  optsOrBuilder: TOptions | ((workflowId: string) => TOptions),
  startedAt: number | undefined,
  onComplete: ((job: WorkflowJobState) => boolean | void) | undefined,
  owner: SessionOwnerToken | undefined,
  executionMode: "async" | "sync",
  execute: WorkflowJobExecutor<TOptions>,
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
      budgetTotal: opts.budgetTotal ?? null,
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
  let execution: Promise<WorkflowRunResultWithUsage>;
  try {
    execution = execute(state, opts, abort.signal);
  } catch (error) {
    execution = Promise.reject(error);
  }
  state.promise = execution
    .then((result) => {
      if (state.status === "running") state.status = "done";
      state.result = result;
      state.snapshot.agentsSpawned = result.agentsSpawned;
      state.snapshot.errorCount = result.errorCount;
      state.snapshot.tokensSpent = result.tokensSpent;
      state.snapshot.usage = { ...result.usage };
      state.snapshot.phases = [...result.phases];
      state.snapshot.runningCount = 0;
      state.snapshot.liveUsage = undefined;
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      return result;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = msg;
      if (err instanceof WorkflowExecutionError && err.usage) {
        state.snapshot.usage = { ...err.usage };
        state.snapshot.tokensSpent = err.usage.output;
      }
      state.snapshot.liveUsage = undefined;
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
export type StartWorkflowPlanJobOptions = Omit<
  WorkflowPlanRunOptions,
  "signal" | "onState"
> &
  Pick<WorkflowPlanRunOptions, "signal"> & {
    budgetTotal?: number | null;
    onState?: (state: WorkflowPlanState) => void;
  };

/**
 * Start a non-durable declarative preview using the same owner-scoped registry
 * and result lifecycle as legacy JavaScript workflows.
 *
 * Validation and initial state creation happen before the registry row, child
 * dispatch, or runner promise is created.
 */
export function startWorkflowPlanJob(
  plan: WorkflowPlan,
  optsOrBuilder:
    | StartWorkflowPlanJobOptions
    | ((workflowId: string) => StartWorkflowPlanJobOptions),
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
): WorkflowJobState {
  validateWorkflowPlan(plan);
  const initialPlanState = createWorkflowPlanState(plan);
  const parentSessionOwner = owner;
  while (
    executionMode === "async" &&
    workflowJobRegistry.size >= MAX_WORKFLOW_JOBS
  ) {
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
    name: plan.name,
    status: "running",
    executionMode,
    startedAt: startedAt ?? Date.now(),
    promise: undefined as unknown as Promise<WorkflowRunResultWithUsage>,
    abort,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      budgetTotal: opts.budgetTotal ?? null,
      usage: zeroWorkflowUsage(),
      phases: [],
      planState: initialPlanState,
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
  const updatePlanState = (next: WorkflowPlanState): void => {
    state.snapshot.planState = next;
    const statuses = Object.values(next.tasks);
    state.snapshot.agentsSpawned = statuses.filter(
      (status) =>
        status === "running" || status === "succeeded" || status === "failed",
    ).length;
    state.snapshot.runningCount = statuses.filter(
      (status) => status === "running",
    ).length;
    state.snapshot.errorCount = statuses.filter(
      (status) => status === "failed",
    ).length;
    state.snapshot.currentPhase = next.currentPhase;
    if (
      next.currentPhase &&
      state.snapshot.phases[state.snapshot.phases.length - 1] !==
        next.currentPhase
    ) {
      state.snapshot.phases.push(next.currentPhase);
    }
    state.snapshot.lastMessage = `plan ${next.status}`;
    opts.onState?.(next);
  };
  const runOptions: WorkflowPlanRunOptions = {
    ...opts,
    runAgent: (request) =>
      runTrackedWorkflowAgent(state, opts.runAgent, request),
    signal: abort.signal,
    onState: updatePlanState,
  };
  state.promise = runWorkflowPlan(plan, runOptions)
    .then((result) => {
      const usage = result.taskResults.reduce(
        (total, task) => addWorkflowUsage(total, task.result.usage),
        zeroWorkflowUsage(),
      );
      const withUsage: WorkflowRunResultWithUsage = {
        ...result,
        usage,
      };
      if (state.status === "running") state.status = "done";
      state.result = withUsage;
      state.snapshot.usage = usage;
      state.snapshot.tokensSpent = usage.output;
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      return withUsage;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      state.status = abort.signal.aborted ? "cancelled" : "error";
      state.error = message;
      state.snapshot.liveUsage = undefined;
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      throw error;
    })
    .finally(() => {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (executionMode === "sync" && workflowJobRegistry.get(id) === state) {
        workflowJobRegistry.delete(id);
      }
    });
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
    invokeCompletionHook(job);
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
