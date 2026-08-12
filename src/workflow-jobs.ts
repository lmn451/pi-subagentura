import { randomBytes } from "node:crypto";
import { debugLog } from "./helpers";
import {
  getActiveSessionOwner,
  isSessionOwnerLive,
  type SessionOwnerToken,
} from "./session-scope";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import {
  createDurableWorkflowPlanRunId,
  validateDurableWorkflowPlan,
  type DurableWorkflowExecution,
  type DurableWorkflowPlanController,
} from "./workflow-durable-plan";
import { createDurableWorkflowScriptRunId } from "./workflow-durable-script";
import type {
  DurableWorkflowStatus,
  WorkflowOperationOutcome,
} from "./workflow-run-types";
import type {
  WorkflowRecoveredRun,
  WorkflowRecoveryFailure,
} from "./workflow-recovery";
import { parseWorkflow } from "./workflow-script";
import { runWorkflow } from "./workflow-worker";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "./workflow-plan";
import {
  runWorkflowPlan,
  type RunWorkflowPlanOptions,
  type WorkflowPlanRunResult,
} from "./workflow-plan-runner";
import {
  applyPlanEvent,
  createPlanProjection,
  type WorkflowPlanProjection,
} from "./workflow-plan-state";
import {
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
export type WorkflowJobKind = "script" | "plan";

export interface WorkflowJobState {
  kind: WorkflowJobKind;
  id: string;
  name: string;
  status: WorkflowJobStatus;
  durable?: true;
  /** Authoritative durable status when this row was restored from recovery. */
  durableStatus?: DurableWorkflowStatus;
  /** Bounded recovery diagnostic for a run that could not be projected. */
  recoveryFailure?: WorkflowRecoveryFailure;
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
    agentRecords?: WorkflowAgentRecord[];
    agentRecordsOmitted?: number;
    runningCount?: number;
  };
  /** Live declarative-plan state, advanced only by runner evidence events. */
  planProjection?: WorkflowPlanProjection;
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

/**
 * Rebuild owner-scoped management rows from durable recovery. The durable
 * controller remains authoritative; these rows only make recovered runs
 * discoverable through the existing status command and workflow tree.
 */
export function restoreRecoveredDurableWorkflowJobs(
  runs: readonly WorkflowRecoveredRun[],
  completions: readonly DurableWorkflowExecution[],
  owner: SessionOwnerToken,
): readonly WorkflowJobState[] {
  const completionByRunId = new Map(
    completions.map((execution) => [execution.runId, execution.completion]),
  );
  const restored: WorkflowJobState[] = [];
  for (const recovered of runs) {
    const projection = recovered.projection;
    const failure = recovered.failure;
    const executionKind = projection?.executionKind ?? "plan";
    const durableStatus =
      projection?.status ?? (failure === undefined ? "interrupted" : "error");
    const recoveryError =
      failure === undefined
        ? undefined
        : `Recovery failed (${failure.code}): ${failure.diagnostic}`;
    const state = createWorkflowJobState({
      id: recovered.runId,
      kind: executionKind,
      durable: true,
      name:
        projection === undefined
          ? "Durable workflow recovery"
          : `Recovered durable ${executionKind} workflow`,
      executionMode: "async",
      abort: new AbortController(),
      owner,
    });
    state.durableStatus = durableStatus;
    state.status =
      recovered.kind === "recovery_failed"
        ? "error"
        : workflowJobStatusFromDurable(durableStatus);
    if (failure !== undefined) state.recoveryFailure = failure;
    if (recoveryError !== undefined) state.error = recoveryError;
    if (projection !== undefined) {
      const usage = projection.accounting.usage;
      state.snapshot.agentsSpawned = projection.operations.reduce(
        (count, operation) => count + operation.attempts.length,
        0,
      );
      state.snapshot.errorCount = projection.operations.reduce(
        (count, operation) =>
          count +
          (operationOutcomeIsError(operation.settlement?.outcome) ? 1 : 0),
        0,
      );
      state.snapshot.tokensSpent = usage.output;
      state.snapshot.usage = usage;
      state.snapshot.runningCount = projection.operations.reduce(
        (count, operation) =>
          count +
          operation.attempts.filter((attempt) => attempt.status === "started")
            .length,
        0,
      );
      state.snapshot.lastMessage = `Recovered durable status: ${durableStatus}`;
    } else {
      state.snapshot.errorCount = 1;
      state.snapshot.lastMessage = recoveryError;
    }

    const completion = completionByRunId.get(recovered.runId);
    if (completion !== undefined) {
      state.promise = completion;
      void completion.then(
        (result) => settleRecoveredDurableJob(state, result),
        (error) => failRecoveredDurableJob(state, error),
      );
    } else if (recoveryError !== undefined) {
      const failed = Promise.reject(
        new Error(`${recovered.runId}: ${recoveryError}`),
      );
      void failed.catch(() => undefined);
      state.promise = failed;
    } else {
      state.promise = Promise.resolve(recoveredDurableResult(state));
    }
    workflowJobRegistry.set(recovered.runId, state);
    restored.push(state);
  }
  return Object.freeze(restored);
}

function workflowJobStatusFromDurable(
  status: DurableWorkflowStatus,
): WorkflowJobStatus {
  return status === "done" || status === "error" || status === "cancelled"
    ? status
    : "running";
}

function operationOutcomeIsError(
  outcome: WorkflowOperationOutcome | undefined,
): boolean {
  return (
    outcome !== undefined &&
    outcome.status !== "succeeded" &&
    outcome.status !== "cancelled"
  );
}

function recoveredDurableResult(
  state: WorkflowJobState,
): WorkflowRunResultWithUsage {
  return {
    meta: {
      name: state.name,
      description: "Recovered durable workflow management projection.",
    },
    result: null,
    agentsSpawned: state.snapshot.agentsSpawned,
    errorCount: state.snapshot.errorCount,
    tokensSpent: state.snapshot.tokensSpent,
    usage: state.snapshot.usage ?? zeroWorkflowUsage(),
    phases: [...state.snapshot.phases],
  };
}

function settleRecoveredDurableJob(
  state: WorkflowJobState,
  result: WorkflowRunResultWithUsage,
): void {
  if (workflowJobRegistry.get(state.id) !== state) return;
  state.result = result;
  state.snapshot.agentsSpawned = result.agentsSpawned;
  state.snapshot.errorCount = result.errorCount;
  state.snapshot.tokensSpent = result.tokensSpent;
  state.snapshot.usage = result.usage;
  state.snapshot.phases = [...result.phases];
  state.snapshot.runningCount = 0;
  if ("projection" in result) {
    state.planProjection = (result as WorkflowPlanRunResult).projection;
  }
  const durableStatus =
    "status" in result
      ? (result as WorkflowPlanRunResult).status
      : ("done" as const);
  state.durableStatus = durableStatus;
  state.status = workflowJobStatusFromDurable(durableStatus);
}

function failRecoveredDurableJob(
  state: WorkflowJobState,
  error: unknown,
): void {
  if (workflowJobRegistry.get(state.id) !== state) return;
  state.status = "error";
  state.durableStatus = "error";
  state.snapshot.runningCount = 0;
  state.snapshot.errorCount = Math.max(1, state.snapshot.errorCount);
  state.error = error instanceof Error ? error.message : String(error);
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

export type StartWorkflowPlanJobOptions = Omit<
  RunWorkflowPlanOptions,
  "signal" | "appendEvent" | "onProgress"
> &
  Pick<RunWorkflowPlanOptions, "signal" | "onProgress"> & {
    budgetTotal?: number | null;
  };

export interface StartDurableWorkflowPlanJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkflowProgress) => void;
  budgetTotal?: number | null;
}

export interface StartDurableWorkflowScriptJobOptions {
  readonly args?: unknown;
  readonly cwd: string;
  readonly budgetTotal?: number | null;
  readonly loadWorkflow?: (name: string) => string | null;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
}

export interface WorkflowPlanJobState extends WorkflowJobState {
  kind: "plan";
  promise: Promise<WorkflowPlanRunResult>;
  result?: WorkflowPlanRunResult;
  planProjection: WorkflowPlanProjection;
}

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
): WorkflowJobState {
  ensureWorkflowJobCapacity(owner, executionMode);

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const opts =
    typeof optsOrBuilder === "function" ? optsOrBuilder(id) : optsOrBuilder;
  const { abort, externalSignal, forwardAbort } = workflowJobAbort(opts.signal);
  const state = createWorkflowJobState({
    id,
    kind: "script",
    name,
    executionMode,
    startedAt,
    budgetTotal: opts.budgetTotal,
    abort,
    onComplete,
    owner,
  });
  const liveUsageByAgent = new Map<number, WorkflowUsage>();
  const runnerPromise = runWorkflow(script, {
    ...opts,
    runAgent: (request) =>
      runTrackedWorkflowAgent(state, opts.runAgent, request),
    signal: abort.signal,
    onProgress: (progress) =>
      updateWorkflowJobProgress(
        state,
        liveUsageByAgent,
        progress,
        opts.onProgress,
      ),
    onCancellationSnapshot: (receipt) => {
      (state.cancellationSnapshots ??= []).push(receipt);
    },
  });
  trackWorkflowJobPromise(
    state,
    runnerPromise,
    externalSignal,
    forwardAbort,
    liveUsageByAgent,
    executionMode,
  );
  return state;
}

/**
 * Start a validated declarative plan through the same live registry lifecycle
 * used by legacy script jobs. The plan is non-durable and process-local.
 */
export function startWorkflowPlanJob(
  definition: WorkflowPlanDefinition,
  optsOrBuilder:
    | StartWorkflowPlanJobOptions
    | ((workflowId: string) => StartWorkflowPlanJobOptions),
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
): WorkflowPlanJobState {
  const plan = validateWorkflowPlan(definition);
  ensureWorkflowJobCapacity(owner, executionMode);

  const id = `wf_${randomBytes(5).toString("hex")}`;
  const opts =
    typeof optsOrBuilder === "function" ? optsOrBuilder(id) : optsOrBuilder;
  const { abort, externalSignal, forwardAbort } = workflowJobAbort(opts.signal);
  const state = createWorkflowJobState({
    id,
    kind: "plan",
    name: plan.name,
    executionMode,
    startedAt,
    budgetTotal: opts.budgetTotal,
    abort,
    onComplete,
    owner,
    planProjection: createPlanProjection(plan),
  }) as WorkflowPlanJobState;
  const liveUsageByAgent = new Map<number, WorkflowUsage>();
  const runnerPromise = runWorkflowPlan(plan, {
    ...opts,
    runAgent: (request) =>
      runTrackedWorkflowAgent(state, opts.runAgent, request),
    signal: abort.signal,
    appendEvent: (event) => {
      state.planProjection = applyPlanEvent(state.planProjection, event);
    },
    onProgress: (progress) =>
      updateWorkflowJobProgress(
        state,
        liveUsageByAgent,
        progress,
        opts.onProgress,
      ),
  });
  state.promise = trackWorkflowJobPromise(
    state,
    runnerPromise,
    externalSignal,
    forwardAbort,
    liveUsageByAgent,
    executionMode,
    (result) =>
      result.status === "error" || result.status === "cancelled"
        ? result.status
        : "done",
  );
  return state;
}

/**
 * Adapt a durable controller execution to the existing owner-scoped live job
 * registry. The controller remains authoritative; removing this adapter only
 * aborts the live executor as an interruption.
 */
export async function startDurableWorkflowPlanJob(
  definition: WorkflowPlanDefinition,
  controller: DurableWorkflowPlanController,
  opts: StartDurableWorkflowPlanJobOptions = {},
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
): Promise<WorkflowPlanJobState> {
  const plan = validateDurableWorkflowPlan(definition);
  ensureWorkflowJobCapacity(owner, executionMode);

  const id = createDurableWorkflowPlanRunId();
  const { abort, externalSignal, forwardAbort } = workflowJobAbort(opts.signal);
  const state = createWorkflowJobState({
    id,
    kind: "plan",
    durable: true,
    name: plan.name,
    executionMode,
    startedAt,
    budgetTotal: opts.budgetTotal,
    abort,
    onComplete,
    owner,
    planProjection: createPlanProjection(plan),
  }) as WorkflowPlanJobState;
  const liveUsageByAgent = new Map<number, WorkflowUsage>();
  workflowJobRegistry.set(id, state);

  try {
    const execution = await controller.startPlan({
      plan,
      runId: id,
      signal: abort.signal,
      budgetTotal: opts.budgetTotal,
      onPlanEvent: (event) => {
        state.planProjection = applyPlanEvent(state.planProjection, event);
      },
      onProgress: (progress) =>
        updateWorkflowJobProgress(
          state,
          liveUsageByAgent,
          progress,
          opts.onProgress,
        ),
    });
    state.promise = trackWorkflowJobPromise(
      state,
      execution.completion,
      externalSignal,
      forwardAbort,
      liveUsageByAgent,
      executionMode,
      (result) =>
        result.status === "error" || result.status === "cancelled"
          ? result.status
          : "done",
    );
    return state;
  } catch (error) {
    externalSignal?.removeEventListener("abort", forwardAbort);
    if (workflowJobRegistry.get(id) === state) workflowJobRegistry.delete(id);
    throw error;
  }
}

/** Adapt a durable legacy-script controller execution to the live job registry. */
export async function startDurableWorkflowScriptJob(
  script: string,
  controller: DurableWorkflowPlanController,
  opts: StartDurableWorkflowScriptJobOptions,
  startedAt?: number,
  onComplete?: (job: WorkflowJobState) => boolean | void,
  owner: SessionOwnerToken | undefined = getActiveSessionOwner(),
  executionMode: "async" | "sync" = "async",
): Promise<WorkflowJobState> {
  const meta = parseWorkflow(script).meta;
  ensureWorkflowJobCapacity(owner, executionMode);
  const id = createDurableWorkflowScriptRunId();
  const { abort, externalSignal, forwardAbort } = workflowJobAbort(opts.signal);
  const state = createWorkflowJobState({
    id,
    kind: "script",
    durable: true,
    name: meta.name,
    executionMode,
    startedAt,
    budgetTotal: opts.budgetTotal,
    abort,
    onComplete,
    owner,
  });
  const liveUsageByAgent = new Map<number, WorkflowUsage>();
  workflowJobRegistry.set(id, state);
  try {
    const execution = await controller.startScript({
      script,
      args: opts.args,
      cwd: opts.cwd,
      budgetTotal: opts.budgetTotal,
      loadWorkflow: opts.loadWorkflow,
      runId: id,
      signal: abort.signal,
      onProgress: (progress: WorkflowProgress) =>
        updateWorkflowJobProgress(
          state,
          liveUsageByAgent,
          progress,
          opts.onProgress,
        ),
    });
    state.promise = trackWorkflowJobPromise(
      state,
      execution.completion,
      externalSignal,
      forwardAbort,
      liveUsageByAgent,
      executionMode,
      (result) =>
        (result as WorkflowRunResultWithUsage & { cancelled?: boolean })
          .cancelled === true
          ? "cancelled"
          : "done",
    );
    return state;
  } catch (error) {
    externalSignal?.removeEventListener("abort", forwardAbort);
    if (workflowJobRegistry.get(id) === state) workflowJobRegistry.delete(id);
    throw error;
  }
}

interface CreateWorkflowJobStateOptions {
  id: string;
  kind: WorkflowJobKind;
  durable?: true;
  name: string;
  executionMode: "async" | "sync";
  startedAt?: number;
  budgetTotal?: number | null;
  abort: AbortController;
  onComplete?: (job: WorkflowJobState) => boolean | void;
  owner?: SessionOwnerToken;
  planProjection?: WorkflowPlanProjection;
}

function createWorkflowJobState(
  options: CreateWorkflowJobStateOptions,
): WorkflowJobState {
  return {
    id: options.id,
    kind: options.kind,
    ...(options.durable === undefined ? {} : { durable: true as const }),
    name: options.name,
    status: "running",
    executionMode: options.executionMode,
    startedAt: options.startedAt ?? Date.now(),
    promise: undefined as unknown as Promise<WorkflowRunResultWithUsage>,
    abort: options.abort,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      budgetTotal: options.budgetTotal ?? null,
      usage: zeroWorkflowUsage(),
      phases: [],
      agentRecords: [],
      agentRecordsOmitted: 0,
      runningCount: 0,
    },
    completionNotification: options.onComplete,
    completionNotificationDelivered: false,
    cancellationSnapshots: [],
    activeAgentRuns: new Set(),
    parentSessionOwner: options.owner,
    ...(options.planProjection === undefined
      ? {}
      : { planProjection: options.planProjection }),
  };
}

function ensureWorkflowJobCapacity(
  owner: SessionOwnerToken | undefined,
  executionMode: "async" | "sync",
): void {
  // A blocking sync workflow ran unconditionally before it was tracked here.
  // Subjecting it to the cap would turn an always-succeeding call into a new
  // user-visible failure, so sync jobs are exempt — they are also removed from
  // the registry as soon as they settle, so they cannot accumulate.
  while (
    executionMode === "async" &&
    workflowJobRegistry.size >= MAX_WORKFLOW_JOBS
  ) {
    let evicted = false;
    for (const [id, state] of workflowJobRegistry) {
      if (
        state.status !== "running" &&
        workflowJobBelongsToOwner(state, owner)
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
}

function workflowJobAbort(externalSignal?: AbortSignal): {
  abort: AbortController;
  externalSignal: AbortSignal | undefined;
  forwardAbort: () => void;
} {
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort.abort(externalSignal.reason);
  else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  return { abort, externalSignal, forwardAbort };
}

function trackWorkflowJobPromise<T extends WorkflowRunResultWithUsage>(
  state: WorkflowJobState,
  runnerPromise: Promise<T>,
  externalSignal: AbortSignal | undefined,
  forwardAbort: () => void,
  liveUsageByAgent: Map<number, WorkflowUsage>,
  executionMode: "async" | "sync",
  terminalStatus: (result: T) => WorkflowJobStatus = () => "done",
): Promise<T> {
  const promise = runnerPromise
    .then((result) => {
      if (state.status === "running") state.status = terminalStatus(result);
      state.result = result;
      if (state.kind === "plan" && "projection" in result) {
        state.planProjection = result.projection as WorkflowPlanProjection;
      }
      state.snapshot.liveUsage = undefined;
      liveUsageByAgent.clear();
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      return result;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      state.status = state.abort.signal.aborted ? "cancelled" : "error";
      state.error = message;
      if (error instanceof WorkflowExecutionError && error.usage) {
        state.snapshot.usage = { ...error.usage };
        state.snapshot.tokensSpent = error.usage.output;
      }
      state.snapshot.liveUsage = undefined;
      liveUsageByAgent.clear();
      if (state.status === "cancelled") normalizeCancelledWorkflowState(state);
      invokeCompletionHook(state);
      throw error;
    })
    .finally(() => {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (
        executionMode === "sync" &&
        workflowJobRegistry.get(state.id) === state
      ) {
        workflowJobRegistry.delete(state.id);
      }
    });
  state.promise = promise;
  promise.catch(() => {});
  workflowJobRegistry.set(state.id, state);
  return promise;
}

function updateWorkflowJobProgress(
  state: WorkflowJobState,
  liveUsageByAgent: Map<number, WorkflowUsage>,
  progress: WorkflowProgress,
  onProgress: ((progress: WorkflowProgress) => void) | undefined,
): void {
  state.snapshot.agentsSpawned = progress.agentsSpawned;
  state.snapshot.errorCount = progress.errorCount;
  state.snapshot.tokensSpent = progress.tokensSpent;
  state.snapshot.budgetTotal =
    progress.budgetTotal ?? state.snapshot.budgetTotal;
  state.snapshot.usage = progress.usage
    ? { ...progress.usage }
    : state.snapshot.usage;
  state.snapshot.runningCount = progress.runningCount;
  if (progress.kind === "phase" && progress.phase) {
    state.snapshot.currentPhase = progress.phase;
    state.snapshot.phases.push(progress.phase);
    state.snapshot.lastMessage = `◆ phase: ${progress.phase}`;
  } else if (progress.kind === "log" && progress.message) {
    state.snapshot.lastMessage = progress.message;
  } else if (progress.kind === "agent_start") {
    state.snapshot.lastMessage = `→ started${formatWorkflowAgentTag(progress)}`;
  } else if (progress.kind === "agent_done") {
    state.snapshot.lastMessage = `→ done${formatWorkflowAgentTag(progress)}`;
  }
  if (progress.kind === "agent_start" || progress.kind === "agent_done") {
    recordWorkflowAgentProgress(state.snapshot, progress);
  }
  if (typeof progress.agentId === "number") {
    if (progress.liveUsage) {
      liveUsageByAgent.set(progress.agentId, { ...progress.liveUsage });
      recordWorkflowAgentLiveUsage(
        state.snapshot,
        progress.agentId,
        progress.liveUsage,
      );
    }
    if (progress.kind === "agent_done") {
      liveUsageByAgent.delete(progress.agentId);
    }
  }
  state.snapshot.liveUsage = aggregateWorkflowLiveUsage(liveUsageByAgent);
  onProgress?.(progress);
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
