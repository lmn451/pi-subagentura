import type { SubagentResult } from "./helpers";
import {
  canonicalWorkflowPlanDigest,
  canonicalizeWorkflowValue,
  normalizeWorkflowPlan,
  type WorkflowPlan,
} from "./workflow-plan";
import { recoverWorkflowRun } from "./workflow-recovery";
import type { WorkflowProjection } from "./workflow-projection-repository";
import {
  WorkflowRunStore,
  type WorkflowConditionalAppendResult,
} from "./workflow-run-store";
import type {
  WorkflowApprovalDecision,
  WorkflowApprovalRequest,
  WorkflowCancellationRequest,
  WorkflowOwnerIdentity,
  WorkflowResumePolicy,
  WorkflowTerminalResult,
} from "./workflow-run-types";
import {
  validateWorkflowApprovalDecision,
  validateWorkflowApprovalRequest,
  validateWorkflowCancellationRequest,
} from "./workflow-run-types";
import { createHash, randomUUID } from "node:crypto";
import { toDurableValue } from "./workflow-durable-value";
import { WorkflowSessionDispatcher } from "./workflow-dispatcher";
import {
  DurableWorkflowDeliveryBroker,
  type WorkflowDeliveryTransport,
} from "./workflow-durable-delivery";
import {
  canonicalJson,
  mutationPayload,
  type WorkflowTaskClaim,
} from "./workflow-mutation";

export type { WorkflowTaskClaim } from "./workflow-mutation";

export interface DurableWorkflowPlanOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  runId: string;
  plan: WorkflowPlan;
  resumePolicy?: WorkflowResumePolicy;
  runAgent: (input: {
    prompt: string;
    isolation: "in-process";
    label: string;
    signal?: AbortSignal;
  }) => Promise<SubagentResult>;
  signal?: AbortSignal;
  resume?: boolean;
  onProjection?: (projection: WorkflowProjection) => void;
  dispatcher?: WorkflowSessionDispatcher;
}

export interface DurableWorkflowDispatcherSlot {
  closeAdmission?: () => void;
  drain?: () => Promise<void>;
}

export interface DurableSessionShutdownAbortReason {
  readonly source: "session_shutdown";
  readonly reason: "session_shutdown";
}

export interface ActiveDurableWorkflowExecution {
  readonly runId: string;
  readonly owner: WorkflowOwnerIdentity;
  readonly store?: WorkflowRunStore;
  readonly abortController: AbortController;
  readonly promise: Promise<WorkflowProjection>;
  readonly dispatcherSlot?: DurableWorkflowDispatcherSlot;
}

/**
 * In-memory liveness is intentionally only an execution overlay. Durable
 * journal state remains authoritative, while this owner-scoped registry lets
 * trusted cancellation close admission and drain the active executor.
 */
export class DurableActiveExecutionRegistry {
  private readonly entries = new Map<string, ActiveDurableWorkflowExecution>();

  public get(
    owner: WorkflowOwnerIdentity,
    runId: string,
  ): ActiveDurableWorkflowExecution | undefined {
    return this.entries.get(activeExecutionKey(owner, runId));
  }

  public list(
    owner: WorkflowOwnerIdentity,
  ): readonly ActiveDurableWorkflowExecution[] {
    const key = activeOwnerKey(owner);
    return [...this.entries.values()].filter(
      (execution) => activeOwnerKey(execution.owner) === key,
    );
  }

  public register(
    execution: ActiveDurableWorkflowExecution,
  ): ActiveDurableWorkflowExecution | undefined {
    const key = activeExecutionKey(execution.owner, execution.runId);
    const current = this.entries.get(key);
    if (current) return current;
    this.entries.set(key, execution);
    return undefined;
  }

  public unregister(execution: ActiveDurableWorkflowExecution): void {
    const key = activeExecutionKey(execution.owner, execution.runId);
    if (this.entries.get(key) === execution) this.entries.delete(key);
  }
}

export const activeDurableExecutionRegistry =
  new DurableActiveExecutionRegistry();

export async function drainActiveDurableExecutions(
  owner: WorkflowOwnerIdentity,
  reason: "session_shutdown" = "session_shutdown",
): Promise<WorkflowProjection[]> {
  const executions = activeDurableExecutionRegistry.list(owner);
  const shutdownReason: DurableSessionShutdownAbortReason = {
    source: "session_shutdown",
    reason,
  };
  const projections = await Promise.all(
    executions.map(async (execution) => {
      execution.dispatcherSlot?.closeAdmission?.();
      if (!execution.abortController.signal.aborted) {
        execution.abortController.abort(shutdownReason);
      }
      try {
        await execution.dispatcherSlot?.drain?.();
      } catch {
        // Shutdown remains best-effort when a provider slot has already gone
        // away; the durable execution is still awaited below.
      }
      try {
        await execution.promise;
      } catch {
        // The durable recovery projection below is authoritative.
      }
      if (!execution.store) return undefined;
      const current = await recoverWorkflowRun(
        { store: execution.store, owner: execution.owner },
        execution.runId,
      );
      if (current.terminal || current.cancellationRequested) return current;
      return commitInterruptedRun(
        execution.store,
        execution.owner,
        execution.runId,
        undefined,
        reason,
      );
    }),
  );
  return projections.filter(
    (projection): projection is WorkflowProjection => projection !== undefined,
  );
}

function activeOwnerKey(owner: WorkflowOwnerIdentity): string {
  return JSON.stringify([
    owner.projectKey,
    owner.cwd,
    owner.piSessionId,
    owner.ownerId,
    owner.ownerGeneration,
    owner.leaseToken,
  ]);
}

function isSessionShutdownAbort(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null || !("source" in reason))
    return false;
  return reason.source === "session_shutdown";
}

function sessionShutdownPayload(
  reason: "session_shutdown" = "session_shutdown",
): { reason: "session_shutdown" } {
  return { reason };
}

function activeExecutionKey(
  owner: WorkflowOwnerIdentity,
  runId: string,
): string {
  return JSON.stringify([
    owner.projectKey,
    owner.cwd,
    owner.piSessionId,
    owner.ownerId,
    owner.ownerGeneration,
    owner.leaseToken,
    runId,
  ]);
}

export interface DurableWorkflowControllerOptions {
  store: WorkflowRunStore;
  owner: WorkflowOwnerIdentity;
  deliveryTransport?: WorkflowDeliveryTransport;
  onApprovalDecision?: (runId: string, status: "approved" | "rejected") => void;
}

/** Owner-scoped controller for durable status, result, and cancellation. */
export class DurableWorkflowController {
  private readonly deliveryBroker?: DurableWorkflowDeliveryBroker;

  public constructor(
    private readonly options: DurableWorkflowControllerOptions,
  ) {
    if (options.deliveryTransport) {
      this.deliveryBroker = new DurableWorkflowDeliveryBroker({
        store: options.store,
        owner: options.owner,
        transport: options.deliveryTransport,
      });
    }
  }

  public async getStatus(
    runId: string,
  ): Promise<WorkflowProjection | undefined> {
    try {
      const projection = await recoverWorkflowRun(this.options, runId);
      return compatibleReadProjection(projection);
    } catch (error) {
      if (isMissingRun(error)) return undefined;
      throw error;
    }
  }

  public async getResult(
    runId: string,
  ): Promise<WorkflowProjection["terminal"]> {
    const projection = await this.getStatus(runId);
    if (!projection) return undefined;
    return projection.terminal;
  }

  public async cancel(
    runId: string,
    requestId?: string,
  ): Promise<WorkflowProjection | undefined> {
    await cancelDurableWorkflowRun(
      this.options.store,
      this.options.owner,
      runId,
      requestId,
    );
    return this.getStatus(runId);
  }

  public async pauseForBudget(
    runId: string,
    reason?: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || isTerminal(projection.status)) return projection;
    if (projection.status === "awaiting_budget") return projection;
    await this.append(runId, "run_awaiting_budget", {
      ...(reason ? { reason } : {}),
    });
    return this.getStatus(runId);
  }

  public async resumeFromBudget(
    runId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.status !== "awaiting_budget")
      return projection;
    await this.append(runId, "run_budget_resumed", {});
    return this.getStatus(runId);
  }

  public async mutateTask(
    runId: string,
    mutation: {
      type: "block" | "unblock" | "skip" | "append";
      taskId: string;
      expectedRevision: number;
      phaseId?: string;
      prompt?: string;
      label?: string;
    },
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection) return undefined;
    if (projection.revision !== mutation.expectedRevision) {
      throw new Error(
        `Workflow plan revision is stale: expected ${mutation.expectedRevision}, current ${projection.revision}`,
      );
    }
    if (mutation.type === "append") {
      if (!mutation.phaseId || !mutation.prompt?.trim())
        throw new Error("Appending workflow work requires phaseId and prompt");
      if (projection.tasks[mutation.taskId]) {
        throw new Error(`Duplicate workflow task: ${mutation.taskId}`);
      }
      if (isTerminal(projection.status)) {
        throw new Error("Cannot append work to a terminal workflow");
      }
      const mutationPayloadResult = await withMutationHash(
        this.options.store,
        this.options.owner,
        runId,
        "task_appended",
        {
          taskId: mutation.taskId,
          phaseId: mutation.phaseId,
          prompt: mutation.prompt,
          ...(mutation.label ? { label: mutation.label } : {}),
        },
        projection,
      );
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "task_appended",
        mutationPayloadResult.payload,
        mutationPayloadResult.runEpoch,
      );
      if (appendResult.status === "conflict")
        throw staleWorkflowRevision(
          mutation.expectedRevision,
          appendResult.actualLastEventOrdinal + 1,
        );
      return this.getStatus(runId);
    }
    const currentTask = projection.tasks[mutation.taskId];
    if (!currentTask)
      throw new Error(`Unknown workflow task: ${mutation.taskId}`);
    if (
      (mutation.type === "block" || mutation.type === "unblock") &&
      currentTask.status !== (mutation.type === "block" ? "pending" : "blocked")
    ) {
      throw new Error(`Task ${mutation.taskId} cannot be ${mutation.type}d`);
    }
    if (
      mutation.type === "skip" &&
      !["pending", "blocked"].includes(currentTask.status)
    ) {
      throw new Error(`Task ${mutation.taskId} is no longer mutable`);
    }
    const eventType =
      mutation.type === "block"
        ? "task_blocked"
        : mutation.type === "unblock"
          ? "task_unblocked"
          : "task_skipped";
    const mutationPayloadResult = await withMutationHash(
      this.options.store,
      this.options.owner,
      runId,
      eventType,
      { taskId: mutation.taskId },
      projection,
    );
    const appendResult = await this.options.store.appendIfCurrent(
      runId,
      projection.lastEventOrdinal,
      eventType,
      mutationPayloadResult.payload,
      mutationPayloadResult.runEpoch,
    );
    if (appendResult.status === "conflict")
      throw staleWorkflowRevision(
        mutation.expectedRevision,
        appendResult.actualLastEventOrdinal + 1,
      );
    return this.getStatus(runId);
  }

  public async acknowledgeDelivery(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    await ensureDeliveryIntent(this.options.store, this.options.owner, runId);
    if (this.deliveryBroker) {
      return this.deliveryBroker.acknowledge(runId, deliveryId);
    }
    await appendDeliveryReceipt(
      this.options.store,
      this.options.owner,
      runId,
      deliveryId,
    );
    return this.getStatus(runId);
  }

  public async dispatchDelivery(
    runId: string,
    deliveryId: string,
  ): Promise<WorkflowProjection | undefined> {
    const projection = await this.getStatus(runId);
    if (!projection || projection.delivery?.deliveryId !== deliveryId)
      return projection;
    await ensureDeliveryIntent(this.options.store, this.options.owner, runId);
    if (this.deliveryBroker) {
      return this.deliveryBroker.deliver(runId, deliveryId);
    }
    await appendDeliveryDispatched(
      this.options.store,
      this.options.owner,
      runId,
      deliveryId,
    );
    return this.getStatus(runId);
  }

  public async reconcileDelivery(
    runId: string,
    entries: readonly unknown[],
  ): Promise<WorkflowProjection | undefined> {
    let projection = await this.getStatus(runId);
    if (!projection?.terminal) return projection;
    projection = await ensureDeliveryIntent(
      this.options.store,
      this.options.owner,
      runId,
    );
    const deliveryId = projection.delivery?.deliveryId;
    if (!deliveryId || !this.deliveryBroker) return projection;
    return this.deliveryBroker.reconcile(runId, entries);
  }

  public async requestApproval(
    runId: string,
    request: WorkflowApprovalRequest,
  ): Promise<WorkflowProjection | undefined> {
    validateWorkflowApprovalRequest(request);
    for (let attempt = 0; attempt < 8; attempt++) {
      const projection = await recoverWorkflowRun(this.options, runId);
      if (projection.approval?.status === "pending")
        return compatibleReadProjection(projection);
      if (isTerminal(projection.status))
        return compatibleReadProjection(projection);
      const leaseEpoch = await this.options.store.getLeaseEpoch();
      const boundRequest: WorkflowApprovalRequest = {
        ...request,
        ownerGeneration: this.options.owner.ownerGeneration,
        leaseEpoch,
        planRevision: projection.planRevision,
      };
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "approval_requested",
        {
          request: boundRequest,
          ownerId: this.options.owner.ownerId,
          ownerGeneration: boundRequest.ownerGeneration,
          leaseEpoch: boundRequest.leaseEpoch,
        },
        leaseEpoch,
      );
      if (appendResult.status === "appended") return this.getStatus(runId);
    }
    return this.getStatus(runId);
  }

  public async decideApproval(
    runId: string,
    requestId: string,
    decision: WorkflowApprovalDecision,
  ): Promise<WorkflowProjection | undefined> {
    validateWorkflowApprovalDecision(decision);
    if (decision.requestId !== requestId)
      throw new Error("Workflow approval request mismatch");
    for (let attempt = 0; attempt < 8; attempt++) {
      const projection = await recoverWorkflowRun(this.options, runId);
      if (
        !projection.approval ||
        projection.approval.request.requestId !== requestId
      )
        throw new Error("Workflow approval request was not found");
      if (projection.approval.status !== "pending")
        return compatibleReadProjection(projection);
      const request = projection.approval.request;
      const leaseEpoch = await this.options.store.getLeaseEpoch();
      if (
        request.ownerGeneration !== this.options.owner.ownerGeneration ||
        request.leaseEpoch !== leaseEpoch
      ) {
        return compatibleReadProjection(projection);
      }
      if (
        (decision.policyHash !== undefined &&
          decision.policyHash !== request.policyHash) ||
        (decision.planRevision !== undefined &&
          decision.planRevision !== request.planRevision) ||
        (decision.ownerGeneration !== undefined &&
          decision.ownerGeneration !== request.ownerGeneration) ||
        (decision.leaseEpoch !== undefined &&
          decision.leaseEpoch !== request.leaseEpoch) ||
        (decision.version !== undefined && decision.version !== request.version)
      ) {
        return compatibleReadProjection(projection);
      }
      const enrichedDecision: WorkflowApprovalDecision = {
        ...decision,
        policyHash: request.policyHash,
        planRevision: request.planRevision,
        ownerGeneration: request.ownerGeneration,
        leaseEpoch: request.leaseEpoch,
        version: request.version,
      };
      const appendResult = await this.options.store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "approval_decided",
        enrichedDecision,
        leaseEpoch,
      );
      if (appendResult.status === "conflict") continue;
      if (decision.status === "rejected") {
        const afterDecision = await recoverWorkflowRun(this.options, runId);
        let blockedResult;
        if (request.denial === "skip" && request.taskId) {
          const mutation = await withMutationHash(
            this.options.store,
            this.options.owner,
            runId,
            "task_skipped",
            { taskId: request.taskId, approvalRequestId: requestId },
            afterDecision,
          );
          blockedResult = await this.options.store.appendIfCurrent(
            runId,
            afterDecision.lastEventOrdinal,
            "task_skipped",
            mutation.payload,
            mutation.runEpoch,
          );
        } else {
          blockedResult = await this.options.store.appendIfCurrent(
            runId,
            afterDecision.lastEventOrdinal,
            "run_blocked",
            {
              reason: decision.reason ?? "Workflow approval rejected",
              source: "approval",
              requestId,
              policyHash: request.policyHash,
              planRevision: request.planRevision,
              ownerGeneration: request.ownerGeneration,
              leaseEpoch: request.leaseEpoch,
              version: request.version,
            },
            leaseEpoch,
          );
        }
        if (blockedResult.status === "conflict") {
          const latest = await recoverWorkflowRun(this.options, runId);
          if (latest.approval?.status === "rejected")
            return compatibleReadProjection(latest);
        }
      }
      this.options.onApprovalDecision?.(runId, decision.status);
      return this.getStatus(runId);
    }
    return this.getStatus(runId);
  }

  private async append(
    runId: string,
    type: string,
    payload: unknown,
  ): Promise<unknown> {
    return appendCurrentEvent(this.options.store, runId, type, payload);
  }

  private async appendIfCurrent(
    runId: string,
    expectedLastEventOrdinal: number,
    type: string,
    payload: unknown,
  ): Promise<WorkflowConditionalAppendResult> {
    return appendCurrentConditionalEvent(
      this.options.store,
      runId,
      expectedLastEventOrdinal,
      type,
      payload,
    );
  }
}
async function currentRunEpoch(
  store: WorkflowRunStore,
  runId: string,
): Promise<number> {
  const candidate = (
    store as WorkflowRunStore & {
      getRunEpoch?: (id: string) => Promise<number>;
    }
  ).getRunEpoch;
  if (candidate) return candidate.call(store, runId);
  const events = (await store.readRun(runId)).events;
  return events.reduce(
    (epoch, event) =>
      Number.isSafeInteger(event.runEpoch) && event.runEpoch > epoch
        ? event.runEpoch
        : epoch,
    0,
  );
}

async function currentLeaseEpoch(store: WorkflowRunStore): Promise<number> {
  const candidate = (
    store as WorkflowRunStore & {
      getLeaseEpoch?: () => Promise<number>;
    }
  ).getLeaseEpoch;
  return candidate ? candidate.call(store) : 0;
}

async function appendCurrentEvent(
  store: WorkflowRunStore,
  runId: string,
  type: string,
  payload: unknown,
  runEpoch?: number,
): Promise<unknown> {
  const effectiveRunEpoch =
    runEpoch === undefined ? await currentRunEpoch(store, runId) : runEpoch;
  const leaseEpoch = await currentLeaseEpoch(store);
  return store.append(
    runId,
    type,
    payload,
    effectiveRunEpoch,
    undefined,
    leaseEpoch,
  );
}

async function appendCurrentConditionalEvent(
  store: WorkflowRunStore,
  runId: string,
  expectedLastEventOrdinal: number,
  type: string,
  payload: unknown,
  runEpoch?: number,
): Promise<WorkflowConditionalAppendResult> {
  const effectiveRunEpoch =
    runEpoch === undefined ? await currentRunEpoch(store, runId) : runEpoch;
  const leaseEpoch = await currentLeaseEpoch(store);
  return store.appendIfCurrent(
    runId,
    expectedLastEventOrdinal,
    type,
    payload,
    effectiveRunEpoch,
    leaseEpoch,
  );
}

async function withMutationHash(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
  projection: WorkflowProjection,
): Promise<{ payload: Record<string, unknown>; runEpoch: number }> {
  const runEpoch = await store.getLeaseEpoch();
  return {
    payload: mutationPayload(payload, {
      runId,
      eventType,
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch: runEpoch,
      baseRevision: projection.revision,
      baseOrdinal: projection.lastEventOrdinal,
      previousMutationHash: projection.mutationHash ?? "",
    }),
    runEpoch,
  };
}

function staleWorkflowRevision(expected: number, current: number): Error {
  return new Error(
    `Workflow plan revision is stale: expected ${expected}, current ${current}`,
  );
}

export function workflowDeliveryId(runId: string): string {
  return createHash("sha256")
    .update(`workflow:${runId}:terminal`)
    .digest("hex");
}

export function workflowDeliveryMessage(
  projection: WorkflowProjection,
): string {
  return `Workflow ${projection.runId} ${projection.status}`;
}

export async function runDurableWorkflowPlan(
  options: DurableWorkflowPlanOptions,
): Promise<WorkflowProjection> {
  // Durable admission owns one immutable snapshot. Process isolation is
  // rejected here, before lookup/create, while non-durable previews retain
  // their independent validation and runner behavior.
  const normalizedPlan =
    options.plan.schemaVersion === 1
      ? normalizeWorkflowPlan(options.plan, { durable: true })
      : options.plan;
  const normalizedOptions = { ...options, plan: normalizedPlan };
  const existing = activeDurableExecutionRegistry.get(
    options.owner,
    options.runId,
  );
  if (existing) return existing.promise;

  const abortController = new AbortController();
  const abortListener = () => {
    abortController.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) abortListener();
    else
      options.signal.addEventListener("abort", abortListener, { once: true });
  }
  let resolveExecution!: (projection: WorkflowProjection) => void;
  let rejectExecution!: (error: unknown) => void;
  const executionPromise = new Promise<WorkflowProjection>(
    (resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    },
  );
  // Keep the registry promise awaitable for trusted cancellation while
  // preventing an executor failure from becoming an unhandled rejection when
  // no controller is observing it.
  void executionPromise.catch(() => undefined);
  const execution: ActiveDurableWorkflowExecution = {
    runId: options.runId,
    owner: options.owner,
    store: options.store,
    abortController,
    promise: executionPromise,
    dispatcherSlot: {
      closeAdmission: () => {
        // Admission is closed by the caller before the abort signal is
        // delivered. The signal itself is owned by the caller so shutdown
        // can preserve its typed reason.
      },
    },
  };
  const duplicate = activeDurableExecutionRegistry.register(execution);
  if (duplicate) {
    if (options.signal)
      options.signal.removeEventListener("abort", abortListener);
    return duplicate.promise;
  }
  try {
    const result = await executeDurableWorkflowPlan({
      ...normalizedOptions,
      signal: abortController.signal,
    });
    resolveExecution(result);
    return result;
  } catch (error) {
    rejectExecution(error);
    throw error;
  } finally {
    if (options.signal)
      options.signal.removeEventListener("abort", abortListener);
    activeDurableExecutionRegistry.unregister(execution);
  }
}

async function executeDurableWorkflowPlan(
  options: DurableWorkflowPlanOptions,
): Promise<WorkflowProjection> {
  const { store, owner, runId, plan } = options;
  const digestablePlan = toDurableValue(plan) as unknown as WorkflowPlan;
  validateWorkflowPlan({ ...digestablePlan, schemaVersion: 1 });
  const planDigest = createHash("sha256")
    .update(JSON.stringify(digestablePlan))
    .digest("hex");
  const publish = (next: WorkflowProjection): WorkflowProjection => {
    options.onProjection?.(next);
    return next;
  };
  let projection: WorkflowProjection;
  let runEpoch = 1;
  const controller = new DurableWorkflowController({ store, owner });
  try {
    projection = await recoverWorkflowRun({ store, owner }, runId);
  } catch (error) {
    if (!isMissingRun(error)) throw error;
    // Do not leave an orphaned run directory for an invalid new plan.
    validateWorkflowPlan(plan);
    await store.createRunWithInitialEvent(
      {
        runId,
        planRevision: plan.schemaVersion,
        planDigest,
        resumePolicy: options.resumePolicy ?? "manual",
        owner,
      },
      {
        type: "run_created",
        payload: { plan },
      },
    );
    projection = await recoverWorkflowRun({ store, owner }, runId);
  }
  if (projection.status === "running") {
    // No local registry entry exists at this point, so a running claim belongs
    // to a crashed/reloaded executor. Fence it before any trusted resume.
    await append("run_interrupted", { reason: "stale_execution" });
    projection = (await controller.getStatus(runId)) as WorkflowProjection;
    runEpoch = Math.max(1, await currentRunEpoch(store, runId));
  }

  if (projection.status === "error" && !projection.terminal) {
    const failed = Object.values(projection.tasks).find(
      (task) => task.status === "failed",
    );
    if (failed) {
      await terminalizeWorkflowRun(store, owner, runId, {
        status: "error",
        error: {
          code: "task_failed",
          message: failed.error ?? "Task failed",
        },
      });
      await ensureDeliveryIntent(store, owner, runId);
      return publish(await recoverWorkflowRun({ store, owner }, runId));
    }
  }
  if (projection.status === "interrupted" && !options.resume) {
    return publish(projection);
  }
  if (projection.planRevision !== plan.schemaVersion) {
    throw new Error(
      `Workflow plan revision mismatch: stored ${projection.planRevision}, ` +
        `requested ${plan.schemaVersion}`,
    );
  }
  const launch = await store.readRun(runId);
  if (launch.launch.planDigest && launch.launch.planDigest !== planDigest) {
    throw new Error("Workflow plan definition mismatch");
  }
  // The stored revision owns mismatch reporting before resume validation.
  if (isTerminal(projection.status)) {
    await ensureDeliveryIntent(store, owner, runId);
    return publish(await recoverWorkflowRun({ store, owner }, runId));
  }
  if (options.signal?.aborted) {
    const cancelled = await cancelDurableWorkflowRun(store, owner, runId);
    if (!cancelled) throw new Error("Workflow run not found");
    return publish(cancelled);
  }
  if (isRunDispatchSuspended(projection)) return publish(projection);
  if (projection.status === "created" || projection.status === "interrupted") {
    await append("run_started", {});
  }

  for (const phase of plan.phases) {
    const tasks = phase.tasks.filter((task) => {
      const current = projection.tasks[task.id];
      return current?.status !== "succeeded" && current?.status !== "skipped";
    });
    if (phase.mode === "parallel") {
      const completed = await runDurableParallelPhase(
        options,
        phase.id,
        tasks,
        runEpoch,
      );
      if (!completed) {
        const latest = await recoverWorkflowRun({ store, owner }, runId);
        if (isTerminal(latest.status))
          await ensureDeliveryIntent(store, owner, runId);
        return publish(await recoverWorkflowRun({ store, owner }, runId));
      }
      continue;
    }
    for (const task of tasks) {
      projection = (await controller.getStatus(runId)) as WorkflowProjection;
      const existing = projection.tasks[task.id];
      if (existing?.status === "succeeded" || existing?.status === "skipped")
        continue;
      if (
        isRunDispatchSuspended(projection) ||
        projection.cancellationRequested ||
        !isTaskDispatchable(existing)
      )
        return publish(projection);
      if (!(await ensureTaskApproval(options, controller, task, projection))) {
        return publish(await recoverWorkflowRun({ store, owner }, runId));
      }
      if (options.signal?.aborted) {
        const cancelled = await cancelDurableWorkflowRun(store, owner, runId);
        if (!cancelled) throw new Error("Workflow run not found");
        return publish(cancelled);
      }
      const taskClaim = await claimTask(options, task, phase.id);
      if (!taskClaim) {
        const latest = await recoverWorkflowRun({ store, owner }, runId);
        if (latest.tasks[task.id]?.claim || isRunDispatchSuspended(latest))
          return publish(latest);
        if (
          latest.tasks[task.id]?.status === "succeeded" ||
          latest.tasks[task.id]?.status === "skipped"
        )
          continue;
        return publish(latest);
      }
      try {
        const result = await runClaimedAgent(options, task, taskClaim);
        const usageCommitted = await appendClaimEvent(
          options,
          taskClaim,
          "usage_observed",
          {
            input: result.usage.input,
            output: result.usage.output,
            taskId: task.id,
            attempt: taskClaim.attempt,
          },
        );
        if (!usageCommitted)
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        if (result.isError) {
          const message = result.errorMessage ?? "Task failed";
          const failureCommitted = await appendClaimEvent(
            options,
            taskClaim,
            "task_failed",
            { taskId: task.id, attempt: taskClaim.attempt, error: message },
          );
          if (!failureCommitted)
            return publish(await recoverWorkflowRun({ store, owner }, runId));
          await terminalizeWorkflowRun(store, owner, runId, {
            status: "error",
            error: { code: "task_failed", message },
          });
          await ensureDeliveryIntent(store, owner, runId);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        const successCommitted = await appendClaimEvent(
          options,
          taskClaim,
          "task_succeeded",
          {
            taskId: task.id,
            attempt: taskClaim.attempt,
            result: result.output,
          },
        );
        if (!successCommitted)
          return publish(await recoverWorkflowRun({ store, owner }, runId));
      } catch (error) {
        if (options.signal?.aborted) {
          const cancelled = await cancelDurableWorkflowRun(store, owner, runId);
          if (!cancelled) throw new Error("Workflow run not found");
          return publish(cancelled);
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          return publish(
            await commitCancelledRun(store, owner, runId, runEpoch),
          );
        }
        await append("run_interrupted", {});
        throw error;
      }
    }
  }

  // Mutations are authoritative. Re-read after the declared plan so work
  // appended while the coordinator was running cannot be silently ignored.
  projection = await recoverWorkflowRun({ store, owner }, runId);
  if (isRunDispatchSuspended(projection) || projection.cancellationRequested)
    return publish(projection);
  const declaredTaskIds = new Set(
    plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
  );
  const executedAppended = new Set<string>();
  while (true) {
    projection = (await controller.getStatus(runId)) as WorkflowProjection;
    const appended = Object.values(projection.tasks).filter((task) => {
      return (
        !declaredTaskIds.has(task.id) &&
        !executedAppended.has(task.id) &&
        task.prompt &&
        task.status !== "succeeded" &&
        task.status !== "skipped" &&
        task.status !== "blocked"
      );
    });
    if (appended.length === 0) break;
    for (const task of appended) {
      executedAppended.add(task.id);
      if (
        declaredTaskIds.has(task.id) ||
        !task.prompt ||
        task.status === "succeeded" ||
        task.status === "skipped" ||
        task.status === "blocked"
      )
        continue;
      const taskClaim = await claimTask(
        options,
        task,
        task.phaseId ?? "appended",
      );
      if (!taskClaim) {
        const latest = await recoverWorkflowRun({ store, owner }, runId);
        if (latest.tasks[task.id]?.claim) return publish(latest);
        continue;
      }
      let result: SubagentResult;
      try {
        result = await runClaimedAgent(options, task, taskClaim);
        const usageCommitted = await appendClaimEvent(
          options,
          taskClaim,
          "usage_observed",
          {
            input: result.usage.input,
            output: result.usage.output,
            taskId: task.id,
            attempt: taskClaim.attempt,
          },
        );
        if (!usageCommitted) continue;
        if (result.isError) {
          const message = result.errorMessage ?? "Task failed";
          const failureCommitted = await appendClaimEvent(
            options,
            taskClaim,
            "task_failed",
            { taskId: task.id, attempt: taskClaim.attempt, error: message },
          );
          if (!failureCommitted) continue;
          await terminalizeWorkflowRun(store, owner, runId, {
            status: "error",
            error: { code: "task_failed", message },
          });
          await ensureDeliveryIntent(store, owner, runId);
          return publish(await recoverWorkflowRun({ store, owner }, runId));
        }
        await appendClaimEvent(options, taskClaim, "task_succeeded", {
          taskId: task.id,
          attempt: taskClaim.attempt,
          result: result.output,
        });
        if (options.signal?.aborted) {
          const cancelled = await cancelDurableWorkflowRun(store, owner, runId);
          if (!cancelled) throw new Error("Workflow run not found");
          return publish(cancelled);
        }
      } catch (error) {
        if (isSessionShutdownAbort(options.signal?.reason)) {
          return publish(
            await commitAbortedDurableRun(
              store,
              owner,
              runId,
              runEpoch,
              options.signal,
            ),
          );
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          return publish(
            await commitCancelledRun(store, owner, runId, runEpoch),
          );
        }
        await append("run_interrupted", {});
        throw error;
      }
    }
  }

  projection = await recoverWorkflowRun({ store, owner }, runId);
  if (isRunDispatchSuspended(projection)) return publish(projection);
  await terminalizeWorkflowRun(store, owner, runId, {
    status: "done",
    result: "Workflow completed",
  });
  await ensureDeliveryIntent(store, owner, runId);
  projection = await recoverWorkflowRun({ store, owner }, runId);
  return publish(projection);
}

async function ensureTaskApproval(
  options: DurableWorkflowPlanOptions,
  controller: DurableWorkflowController,
  task: WorkflowPlan["phases"][number]["tasks"][number],
  projection: WorkflowProjection,
): Promise<boolean> {
  if (!task.approval) return true;
  const current = projection.approval;
  if (current?.request.taskId === task.id) {
    return current.status === "approved";
  }
  if (current?.status === "pending") return false;
  await controller.requestApproval(options.runId, {
    requestId: randomUUID(),
    taskId: task.id,
    policyHash: task.approval.policyHash,
    planRevision: projection.planRevision,
    ownerGeneration: options.owner.ownerGeneration,
    leaseEpoch: await options.store.getLeaseEpoch(),
    version: 1,
    denial: task.approval.denial,
  });
  return false;
}

function compatibleReadProjection(
  projection: WorkflowProjection,
): WorkflowProjection {
  let compatible = projection;
  if (compatible.status === "error" && !compatible.terminal) {
    const failed = Object.values(compatible.tasks).find(
      (task) => task.status === "failed",
    );
    if (failed) {
      compatible = {
        ...compatible,
        terminal: {
          status: "error",
          error: {
            code: "task_failed",
            message: failed.error ?? "Task failed",
          },
        },
      };
    }
  }
  if (isTerminal(compatible.status) && !compatible.delivery) {
    compatible = {
      ...compatible,
      delivery: {
        deliveryId: workflowDeliveryId(compatible.runId),
        kind: "terminal",
        status: "pending",
        message: workflowDeliveryMessage(compatible),
      },
    };
  }
  return compatible;
}

export async function terminalizeWorkflowRun(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  result: WorkflowTerminalResult,
  options: { cancellationRequestId?: string } = {},
): Promise<WorkflowProjection> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const projection = await recoverWorkflowRun({ store, owner }, runId);
    const cancellation = projection.cancellation;
    if (cancellation) {
      const currentLeaseEpoch = await store.getLeaseEpoch();
      if (
        result.status !== "cancelled" ||
        cancellation.requestId !== options.cancellationRequestId ||
        cancellation.ownerId !== owner.ownerId ||
        cancellation.ownerGeneration !== owner.ownerGeneration ||
        cancellation.leaseEpoch !== currentLeaseEpoch
      )
        return projection;
    } else if (options.cancellationRequestId !== undefined) {
      return projection;
    }

    if (!projection.terminal) {
      const leaseEpoch = await store.getLeaseEpoch();
      const appendResult = await store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "run_result",
        {
          result,
          ...(cancellation === undefined ? {} : { cancellation }),
        },
        leaseEpoch,
      );
      if (appendResult.status === "conflict") continue;
    } else if (projection.terminal.status !== result.status) {
      return projection;
    }

    const afterResult = await recoverWorkflowRun({ store, owner }, runId);
    const record = await store.readRun(runId);
    const markerType =
      result.status === "cancelled" ? "run_cancelled" : "run_terminal";
    if (record.events.some((event) => event.type === markerType))
      return afterResult;
    const leaseEpoch = await store.getLeaseEpoch();
    const markerPayload =
      result.status === "cancelled" && afterResult.cancellation
        ? afterResult.cancellation
        : {};
    const markerResult = await store.appendIfCurrent(
      runId,
      afterResult.lastEventOrdinal,
      markerType,
      markerPayload,
      leaseEpoch,
    );
    if (markerResult.status === "conflict") continue;
    return recoverWorkflowRun({ store, owner }, runId);
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

export async function ensureDeliveryIntent(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
): Promise<WorkflowProjection> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const projection = await recoverWorkflowRun({ store, owner }, runId);
    if (!isTerminal(projection.status)) return projection;
    if (projection.delivery) return projection;
    const leaseEpoch = await store.getLeaseEpoch();
    const appendResult = await store.appendIfCurrent(
      runId,
      projection.lastEventOrdinal,
      "delivery_intent",
      {
        deliveryId: workflowDeliveryId(runId),
        kind: "terminal",
        message: workflowDeliveryMessage(projection),
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        leaseEpoch,
      },
      leaseEpoch,
    );
    if (appendResult.status === "appended")
      return recoverWorkflowRun({ store, owner }, runId);
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

async function appendDeliveryDispatched(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  deliveryId: string,
): Promise<WorkflowProjection> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const projection = await recoverWorkflowRun({ store, owner }, runId);
    if (projection.delivery?.deliveryId !== deliveryId) return projection;
    if (["dispatched", "delivered"].includes(projection.delivery.status))
      return projection;
    const leaseEpoch = await store.getLeaseEpoch();
    const appendResult = await store.appendIfCurrent(
      runId,
      projection.lastEventOrdinal,
      "delivery_dispatched",
      {
        deliveryId,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        leaseEpoch,
      },
      leaseEpoch,
    );
    if (appendResult.status === "appended")
      return recoverWorkflowRun({ store, owner }, runId);
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

async function appendDeliveryReceipt(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  deliveryId: string,
): Promise<WorkflowProjection> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const projection = await recoverWorkflowRun({ store, owner }, runId);
    if (projection.delivery?.deliveryId !== deliveryId) return projection;
    if (projection.delivery.status === "delivered") return projection;
    const leaseEpoch = await store.getLeaseEpoch();
    const appendResult = await store.appendIfCurrent(
      runId,
      projection.lastEventOrdinal,
      "delivery_receipt",
      {
        deliveryId,
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        leaseEpoch,
      },
      leaseEpoch,
    );
    if (appendResult.status === "appended")
      return recoverWorkflowRun({ store, owner }, runId);
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

export async function cancelDurableWorkflowRun(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  requestId: string = randomUUID(),
): Promise<WorkflowProjection | undefined> {
  validateWorkflowCancellationRequest({
    ownerId: owner.ownerId,
    ownerGeneration: owner.ownerGeneration,
    leaseEpoch: 0,
    requestId,
  });
  for (let attempt = 0; attempt < 16; attempt++) {
    let projection: WorkflowProjection;
    try {
      projection = await recoverWorkflowRun({ store, owner }, runId);
    } catch (error) {
      if (isMissingRun(error)) return undefined;
      throw error;
    }
    if (isTerminal(projection.status)) {
      const existingCancellationRequestId = projection.cancellation?.requestId;
      if (
        projection.status !== "cancelled" ||
        existingCancellationRequestId === undefined
      )
        return projection;
      const repaired = await terminalizeWorkflowRun(
        store,
        owner,
        runId,
        { status: "cancelled" },
        { cancellationRequestId: existingCancellationRequestId },
      );
      if (repaired.status === "cancelled")
        await ensureDeliveryIntent(store, owner, runId);
      return recoverWorkflowRun({ store, owner }, runId);
    }
    if (
      projection.cancellation &&
      projection.cancellation.requestId !== requestId
    )
      return projection;
    const leaseEpoch = await store.getLeaseEpoch();
    if (
      projection.cancellation &&
      (projection.cancellation.ownerId !== owner.ownerId ||
        projection.cancellation.ownerGeneration !== owner.ownerGeneration ||
        projection.cancellation.leaseEpoch !== leaseEpoch)
    )
      return projection;
    const request: WorkflowCancellationRequest = {
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch,
      requestId,
    };
    if (!projection.cancellation) {
      const appendResult = await store.appendIfCurrent(
        runId,
        projection.lastEventOrdinal,
        "run_cancel_requested",
        request,
        leaseEpoch,
      );
      if (appendResult.status === "conflict") continue;
    }
    const terminal = await terminalizeWorkflowRun(
      store,
      owner,
      runId,
      { status: "cancelled" },
      { cancellationRequestId: requestId },
    );
    if (terminal.status === "cancelled")
      await ensureDeliveryIntent(store, owner, runId);
    return recoverWorkflowRun({ store, owner }, runId);
  }
  return recoverWorkflowRun({ store, owner }, runId);
}

async function runDurableParallelPhase(
  options: DurableWorkflowPlanOptions,
  phaseId: string,
  tasks: WorkflowPlan["phases"][number]["tasks"],
  runEpoch: number,
): Promise<boolean> {
  const limit = options.dispatcher
    ? Math.max(1, Math.min(options.dispatcher.snapshot().max, tasks.length))
    : Math.max(1, Math.min(4, tasks.length));
  let nextIndex = 0;
  let firstError: unknown;
  const logicalFailures: Array<{ taskIndex: number; message: string }> = [];
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  let interrupted = false;
  let abandoned = false;
  const worker = async (): Promise<void> => {
    while (firstError === undefined) {
      const task = tasks[nextIndex++];
      if (!task) return;
      const latest = await recoverWorkflowRun(
        { store: options.store, owner: options.owner },
        options.runId,
      );
      if (
        !(await ensureTaskApproval(
          options,
          new DurableWorkflowController({
            store: options.store,
            owner: options.owner,
          }),
          task,
          latest,
        ))
      ) {
        abandoned = true;
        return;
      }
      const taskClaim = await claimTask(options, task, phaseId);
      if (!taskClaim) {
        const latest = await recoverWorkflowRun(
          { store: options.store, owner: options.owner },
          options.runId,
        );
        if (latest.tasks[task.id]?.claim) abandoned = true;
        continue;
      }
      try {
        const result = await runClaimedAgent(options, task, taskClaim);
        const usageCommitted = await appendClaimEvent(
          options,
          taskClaim,
          "usage_observed",
          {
            input: result.usage.input,
            output: result.usage.output,
            taskId: task.id,
            attempt: taskClaim.attempt,
          },
        );
        if (!usageCommitted) continue;
        if (result.isError) {
          const message = result.errorMessage ?? "Task failed";
          const failureCommitted = await appendClaimEvent(
            options,
            taskClaim,
            "task_failed",
            { taskId: task.id, attempt: taskClaim.attempt, error: message },
          );
          if (failureCommitted) {
            logicalFailures.push({
              taskIndex: taskOrder.get(task.id) ?? Number.MAX_SAFE_INTEGER,
              message,
            });
            firstError ??= new Error(message);
          }
          continue;
        }
        await appendClaimEvent(options, taskClaim, "task_succeeded", {
          taskId: task.id,
          attempt: taskClaim.attempt,
          result: result.output,
        });
      } catch (error) {
        if (isSessionShutdownAbort(options.signal?.reason)) {
          interrupted = true;
          firstError ??= error;
          return;
        }
        if (options.signal?.aborted || projection.cancellationRequested) {
          firstError ??= error;
          return;
        }
        if (firstError === undefined) {
          interrupted = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError === undefined && abandoned) return false;
  if (firstError !== undefined) {
    if (interrupted) {
      await options.store.append(options.runId, "run_interrupted", {});
      throw firstError;
    }
    if (options.signal?.aborted) {
      const cancelled = await cancelDurableWorkflowRun(
        options.store,
        options.owner,
        options.runId,
      );
      if (!cancelled) throw new Error("Workflow run not found");
      return false;
    }
    const selectedFailure = logicalFailures
      .slice()
      .sort((left, right) => left.taskIndex - right.taskIndex)[0];
    await terminalizeWorkflowRun(options.store, options.owner, options.runId, {
      status: "error",
      error: {
        code: "task_failed",
        message:
          selectedFailure?.message ??
          (firstError instanceof Error
            ? firstError.message
            : String(firstError)),
      },
    });
    await ensureDeliveryIntent(options.store, options.owner, options.runId);
    return false;
  }
  return true;
}

export async function claimTask(
  options: DurableWorkflowPlanOptions,
  task:
    | WorkflowPlan["phases"][number]["tasks"][number]
    | WorkflowProjectionTaskLike,
  phaseId: string,
): Promise<WorkflowTaskClaim | undefined> {
  for (let retry = 0; retry < 3; retry++) {
    const projection = await recoverWorkflowRun(
      { store: options.store, owner: options.owner },
      options.runId,
    );
    const existing = projection.tasks[task.id];
    if (isRunDispatchSuspended(projection) || !isTaskDispatchable(existing))
      return undefined;
    const leaseEpoch = await options.store.getLeaseEpoch();
    if (
      existing?.claim &&
      existing.claim.ownerId === options.owner.ownerId &&
      existing.claim.ownerGeneration === options.owner.ownerGeneration &&
      existing.claim.leaseEpoch === leaseEpoch
    )
      return undefined;
    const attempt = (existing?.attempt ?? 0) + 1;
    const taskClaim = createTaskClaim(options, task.id, attempt, leaseEpoch);
    const appendResult = await options.store.appendIfCurrent(
      options.runId,
      projection.lastEventOrdinal,
      "task_started",
      { taskId: task.id, attempt, phaseId, claim: taskClaim },
      leaseEpoch,
    );
    if (appendResult.status === "appended") return taskClaim;
    const latest = await recoverWorkflowRun(
      { store: options.store, owner: options.owner },
      options.runId,
    );
    if (latest.tasks[task.id]?.claim) return undefined;
  }
  return undefined;
}

async function appendClaimEvent(
  options: DurableWorkflowPlanOptions,
  taskClaim: WorkflowTaskClaim,
  type: "task_succeeded" | "task_failed" | "usage_observed",
  payload: Record<string, unknown>,
): Promise<boolean> {
  for (let retry = 0; retry < 16; retry++) {
    const projection = await recoverWorkflowRun(
      { store: options.store, owner: options.owner },
      options.runId,
    );
    const current = projection.tasks[taskClaim.taskId];
    if (!current?.claim || !sameClaim(current.claim, taskClaim)) return false;
    const appendResult = await options.store.appendIfCurrent(
      options.runId,
      projection.lastEventOrdinal,
      type,
      { ...payload, claim: taskClaim },
      taskClaim.leaseEpoch,
    );
    if (appendResult.status === "appended") return true;
  }
  return false;
}

async function runClaimedAgent(
  options: DurableWorkflowPlanOptions,
  task:
    | WorkflowPlan["phases"][number]["tasks"][number]
    | WorkflowProjectionTaskLike,
  _taskClaim: WorkflowTaskClaim,
): Promise<SubagentResult> {
  const prompt = task.prompt;
  if (!prompt) throw new Error(`Workflow task ${task.id} has no prompt`);
  const work = (): Promise<SubagentResult> =>
    options.runAgent({
      prompt,
      isolation: "in-process",
      label: task.label ?? task.id,
      signal: options.signal,
    });
  return options.dispatcher?.run(work, options.signal) ?? work();
}

function createTaskClaim(
  options: DurableWorkflowPlanOptions,
  taskId: string,
  attempt: number,
  leaseEpoch: number,
): WorkflowTaskClaim {
  const token = createHash("sha256")
    .update(
      canonicalJson({
        runId: options.runId,
        taskId,
        attempt,
        ownerId: options.owner.ownerId,
        ownerGeneration: options.owner.ownerGeneration,
        leaseEpoch,
        leaseToken: options.owner.leaseToken,
      }),
    )
    .digest("hex");
  return {
    runId: options.runId,
    taskId,
    attempt,
    ownerId: options.owner.ownerId,
    ownerGeneration: options.owner.ownerGeneration,
    leaseEpoch,
    token,
  };
}

function sameClaim(left: WorkflowTaskClaim, right: WorkflowTaskClaim): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.attempt === right.attempt &&
    left.ownerId === right.ownerId &&
    left.ownerGeneration === right.ownerGeneration &&
    left.leaseEpoch === right.leaseEpoch &&
    left.token === right.token
  );
}

interface WorkflowProjectionTaskLike {
  id: string;
  prompt?: string;
  label?: string;
  attempt: number;
}

async function settleCancelledTasks(
  store: WorkflowRunStore,
  owner: WorkflowOwnerIdentity,
  runId: string,
  runEpoch: number,
): Promise<WorkflowProjection> {
  let current = await recoverWorkflowRun({ store, owner }, runId);
  for (const task of Object.values(current.tasks)) {
    if (isTerminalTaskStatus(task.status)) continue;
    await appendCurrentEvent(
      store,
      runId,
      "task_skipped",
      {
        taskId: task.id,
        attempt: task.attempt,
        reason: "cancelled",
      },
      runEpoch,
    );
    current = await recoverWorkflowRun({ store, owner }, runId);
  }
  return current;
}

function isRunDispatchSuspended(projection: WorkflowProjection): boolean {
  return Boolean(
    projection.blockers?.budget ||
    projection.blockers?.approval ||
    projection.blockers?.runtime ||
    projection.cancellation,
  );
}

function isTaskDispatchable(
  task: WorkflowProjection["tasks"][string] | undefined,
): boolean {
  return (
    task === undefined || task.status === "pending" || task.status === "running"
  );
}
function isTerminalTaskStatus(
  status: WorkflowProjection["tasks"][string]["status"],
): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function isTerminal(status: WorkflowProjection["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function isMissingRun(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
