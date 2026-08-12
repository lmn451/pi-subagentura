import { WorkflowRunStore, type WorkflowRunRecord } from "./workflow-run-store";
import {
  projectWorkflowRun,
  type WorkflowProjection,
  type WorkflowProjectionRepository,
} from "./workflow-projection-repository";
import type {
  WorkflowOwnerIdentity,
  WorkflowRunPlanSnapshot,
} from "./workflow-run-types";

export type WorkflowRecoveryLifecycle =
  "startup" | "reload" | "resume" | "new" | "fork";

export interface WorkflowRecoveryOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
}

export interface WorkflowStartupRecoveryOptions extends WorkflowRecoveryOptions {
  reason?: WorkflowRecoveryLifecycle;
  /**
   * Retained for compatibility with callers that used to explicitly request
   * trusted recovery. Auto-resume remains restricted to persisted
   * `on-session-start` launch snapshots.
   */
  trustedResume?: boolean;
  onAutoResume?: (
    projection: WorkflowProjection,
    plan?: WorkflowRunPlanSnapshot,
  ) => Promise<void> | void;
}

export interface WorkflowStartupRecoveryResult {
  readonly runs: readonly WorkflowProjection[];
  readonly interruptedRunIds: readonly string[];
  readonly resumeEligibleRunIds: readonly string[];
  readonly autoResumedRunIds: readonly string[];
}

export class DurableWorkflowProjectionRepository implements WorkflowProjectionRepository {
  public constructor(
    private readonly store: WorkflowRunStore,
    private readonly owner: WorkflowOwnerIdentity,
  ) {}

  public async get(runId: string) {
    try {
      return await recoverWorkflowRun(
        { store: this.store, owner: this.owner },
        runId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async list() {
    return enumerateRecoverableWorkflowRuns({
      store: this.store,
      owner: this.owner,
    });
  }
}

export async function recoverWorkflowRun(
  options: WorkflowRecoveryOptions,
  runId: string,
): Promise<WorkflowProjection> {
  const record = await options.store.readRun(runId);
  assertOwner(record, options.owner);
  return projectWorkflowRun(record.launch, record.events);
}

export async function enumerateRecoverableWorkflowRuns(
  options: WorkflowRecoveryOptions,
): Promise<readonly WorkflowProjection[]> {
  const projections: WorkflowProjection[] = [];
  for (const runId of await options.store.listRunIds()) {
    const record = await options.store.readRun(runId);
    if (!sameOwner(record.launch.owner, options.owner)) continue;
    projections.push(projectWorkflowRun(record.launch, record.events));
  }
  return projections;
}

/**
 * Reconcile current-owner durable claims before session delivery/rehydration.
 * `new` and `fork` are explicit namespace boundaries and never enumerate or
 * mutate runs from the prior lifecycle.
 */
export async function recoverWorkflowRunsAtStartup(
  options: WorkflowStartupRecoveryOptions,
): Promise<WorkflowStartupRecoveryResult> {
  const reason = options.reason ?? "startup";
  if (reason === "new" || reason === "fork") {
    return {
      runs: [],
      interruptedRunIds: [],
      resumeEligibleRunIds: [],
      autoResumedRunIds: [],
    };
  }

  const leaseFence = await options.store.getActiveOwnerFence();
  const runs: WorkflowProjection[] = [];
  const interruptedRunIds: string[] = [];
  const resumeEligibleRunIds: string[] = [];
  const autoResumedRunIds: string[] = [];

  for (const runId of await options.store.listRunIds()) {
    let record: WorkflowRunRecord;
    try {
      record = await options.store.readRun(runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (!sameOwner(record.launch.owner, options.owner)) continue;

    let projection = projectWorkflowRun(record.launch, record.events);
    if (projection.status === "running" && !projection.terminal) {
      const currentRunEpoch = record.events.reduce(
        (epoch, event) =>
          Number.isSafeInteger(event.runEpoch)
            ? Math.max(epoch, event.runEpoch)
            : epoch,
        0,
      );
      const result = await options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "run_interrupted",
        {
          reason: "session_start",
          lifecycle: reason,
        },
        currentRunEpoch,
        leaseFence.leaseEpoch,
      );
      if (result.status === "appended") {
        interruptedRunIds.push(runId);
      }
      projection = await recoverWorkflowRun(options, runId);
    }

    const persistedPlan = record.launch.plan;
    const permitsAutoResume =
      projection.status === "interrupted" &&
      record.launch.resumePolicy === "on-session-start" &&
      persistedPlan !== undefined;
    if (permitsAutoResume) {
      resumeEligibleRunIds.push(runId);
      if (options.onAutoResume) {
        await options.onAutoResume(projection, persistedPlan);
        autoResumedRunIds.push(runId);
      }
    }
    runs.push(projection);
  }

  return {
    runs,
    interruptedRunIds,
    resumeEligibleRunIds,
    autoResumedRunIds,
  };
}

export const startupRecoverWorkflowRuns = recoverWorkflowRunsAtStartup;

function assertOwner(
  record: WorkflowRunRecord,
  owner: WorkflowOwnerIdentity,
): void {
  if (!sameOwner(record.launch.owner, owner)) {
    throw new Error("Workflow run belongs to a different owner or session.");
  }
}

function sameOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): boolean {
  return (
    left.projectKey === right.projectKey &&
    left.piSessionId === right.piSessionId &&
    left.ownerId === right.ownerId
  );
}
