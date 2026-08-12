import { randomUUID } from "node:crypto";
import type { SubagentResult, Usage } from "./helpers";
import type {
  WorkflowAgentRunner,
  WorkflowProgress,
  WorkflowRunResultWithUsage,
} from "./workflow-core";
import { WorkflowAgentDispatcher } from "./workflow-dispatcher";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
} from "./workflow-durable-value";
import {
  createWorkflowApprovalPolicyHash,
  pendingWorkflowApproval,
  workflowApprovalFenceMismatch,
  type WorkflowApprovalDecisionInput,
  type WorkflowApprovalDecisionOutcome,
  type WorkflowApprovalDenialPolicy,
  type WorkflowApprovalKind,
  type WorkflowApprovalSnapshot,
} from "./workflow-approvals";
import {
  createDurableWorkflowDeliveryPayload,
  decodeDurableWorkflowDeliveryPayload,
  durableWorkflowDeliveryId,
  durableWorkflowDeliveryIdsFromEntries,
  durableWorkflowDeliveryMessage,
  type DurableWorkflowDeliveryTransport,
} from "./workflow-delivery";
import {
  DurableWorkflowScriptControllerAdapter,
  decodeStoredDurableWorkflowScriptResult,
  type DurableWorkflowScriptExecution,
  type DurableWorkflowScriptStartOptions,
} from "./workflow-durable-script";
import {
  durableWorkflowOperationBlobCodec,
  WorkflowRunBlobResolver,
  WorkflowRunOperationJournal,
  type WorkflowRunEventDraft,
} from "./workflow-operation-journal";
import {
  WorkflowOperationGate,
  WorkflowOperationInterruptedError,
  type WorkflowOperationJournal,
} from "./workflow-operation-gate";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "./workflow-plan";
import {
  runWorkflowPlan,
  type WorkflowPlanRunResult,
  type WorkflowPlanTaskDispatch,
} from "./workflow-plan-runner";
import {
  type WorkflowPlanEvent,
  type WorkflowPlanProjection,
} from "./workflow-plan-state";
import {
  applyWorkflowPlanMutation,
  createWorkflowPlanViewProjection,
  type WorkflowPlanMutationRequest,
  type WorkflowPlanViewProjection,
} from "./workflow-plan-mutations";
import {
  WorkflowProjectionFoldError,
  foldWorkflowRunEvents,
  InMemoryWorkflowProjectionRepository,
  type DurableWorkflowProjection,
  type WorkflowProjectionRepository,
} from "./workflow-projection-repository";
import {
  WorkflowRecoveryService,
  type WorkflowOwnerRecovery,
  type WorkflowRecoveryReason,
} from "./workflow-recovery";
import {
  WorkflowRunStore,
  WorkflowRunStoreError,
  type WorkflowLeaseAcquisition,
  type WorkflowRunJournal,
  type WorkflowRunLease,
} from "./workflow-run-store";
import {
  ROOT_WORKFLOW_DEFINITION_PATH,
  WORKFLOW_OUTBOX_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowSha256Digest,
  createWorkflowDefinitionPath,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  durableWorkflowOwnerEquals,
  isDurableWorkflowRunId,
  isDurableWorkflowOwner,
  isWorkflowIdentifier,
  type DurableWorkflowOwner,
  type DurableWorkflowResumePolicy,
  type DurableWorkflowRunId,
  type WorkflowDefinitionDigest,
  type WorkflowEventReceipt,
  type WorkflowOperationRequest,
  type WorkflowPlanTaskStatus,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
  type WorkflowRunInterruptedEvent,
} from "./workflow-run-types";

export interface DurableWorkflowPlanControllerOptions extends WorkflowLeaseAcquisition {
  readonly store: WorkflowRunStore;
  readonly owner: DurableWorkflowOwner;
  readonly repository?: WorkflowProjectionRepository;
  readonly runAgentForRun: (runId: DurableWorkflowRunId) => WorkflowAgentRunner;
  /** Namespace-wide cap for in-process durable operation dispatches. */
  readonly concurrency?: number;
  /** Namespace-wide cap for process-backed durable operation dispatches. */
  readonly processConcurrency?: number;
  readonly generateId?: () => string;
  readonly onDeliveryReady?: (
    runId: DurableWorkflowRunId,
  ) => void | Promise<void>;
  readonly onPlanMutationWake?: (
    runId: DurableWorkflowRunId,
  ) => void | Promise<void>;
}

export interface DurableWorkflowPlanExecutionOptions {
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
  readonly budgetTotal?: number | null;
  readonly onProgress?: (progress: WorkflowProgress) => void;
  readonly onPlanEvent?: (event: WorkflowPlanEvent) => void;
}

export interface DurableWorkflowPlanStartOptions extends DurableWorkflowPlanExecutionOptions {
  readonly plan: WorkflowPlanDefinition;
  readonly runId?: DurableWorkflowRunId;
  readonly resumePolicy?: DurableWorkflowResumePolicy;
}

export interface DurableWorkflowPlanResumeOptions extends DurableWorkflowPlanExecutionOptions {
  readonly trustedActorId: string;
  readonly expectedOwner?: DurableWorkflowOwner;
  readonly expectedRunEpoch?: number;
}

export interface DurableWorkflowPlanCancellationOptions {
  readonly reason: string;
  readonly trustedActorId: string;
  readonly expectedOwner?: DurableWorkflowOwner;
  readonly expectedRunEpoch?: number;
}
export interface WorkflowApprovalRequestOptions {
  readonly approvalKind: WorkflowApprovalKind;
  readonly description: string;
  readonly denialPolicy: WorkflowApprovalDenialPolicy;
  readonly subjectTaskId?: string | null;
  readonly expectedOwner?: DurableWorkflowOwner;
  readonly expectedOwnerGeneration?: number;
  readonly expectedRunEpoch?: number;
  readonly policy?: DurableValue;
}

export interface DurableWorkflowPlanExecution {
  readonly runId: DurableWorkflowRunId;
  readonly completion: Promise<WorkflowPlanRunResult>;
}

export type DurableWorkflowExecution =
  DurableWorkflowPlanExecution | DurableWorkflowScriptExecution;

export interface DurableWorkflowPlanOpenResult {
  readonly recovery: WorkflowOwnerRecovery;
  readonly completions: readonly DurableWorkflowExecution[];
}
export interface DurableWorkflowDeliveryReconcileResult {
  readonly intentsRecorded: number;
  readonly receiptsRecorded: number;
}

export type DurableWorkflowPlanInterruptionReason =
  WorkflowRunInterruptedEvent["payload"]["reason"];

export class DurableWorkflowPlanControllerError extends Error {
  readonly code:
    | "closed"
    | "invalid_plan"
    | "invalid_cancellation"
    | "wrong_owner"
    | "epoch_mismatch"
    | "run_active"
    | "run_not_found"
    | "terminal_run"
    | "resume_forbidden"
    | "trusted_resume_required"
    | "interrupted"
    | "invalid_approval"
    | "stale_revision"
    | "invalid_mutation"
    | "awaiting_budget";

  constructor(
    code: DurableWorkflowPlanControllerError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DurableWorkflowPlanControllerError";
    this.code = code;
  }
}

interface ActiveExecution {
  readonly runId: DurableWorkflowRunId;
  readonly journal: WorkflowRunJournal;
  plan: WorkflowPlanDefinition;
  definitionDigest: WorkflowDefinitionDigest;
  planRevision: number;
  readonly abort: AbortController;
  readonly concurrency?: number;
  readonly budgetTotal: number | null;
  readonly skipTaskIds: ReadonlySet<string>;
  readonly externalSignal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
  readonly onPlanEvent?: (event: WorkflowPlanEvent) => void;
  agentsSpawned: number;
  interruptionReason?: DurableWorkflowPlanInterruptionReason;
  cancellation?: {
    readonly reason: string;
    readonly trustedActorId: string;
    readonly persisted: Promise<void>;
  };
  awaitingApprovalRequestId?: string;
  completion?: Promise<WorkflowPlanRunResult>;
}
interface PendingActivePlanCancellation {
  readonly kind: "active_plan_cancellation";
  readonly execution: ActiveExecution;
}
interface PendingApprovalDecision {
  readonly kind: "pending_approval_decision";
  readonly completion: Promise<WorkflowPlanRunResult>;
}
function isPendingActivePlanCancellation(
  value:
    | WorkflowPlanRunResult
    | WorkflowRunResultWithUsage
    | PendingActivePlanCancellation,
): value is PendingActivePlanCancellation {
  return "kind" in value && value.kind === "active_plan_cancellation";
}

function isPendingApprovalDecision(
  value: WorkflowApprovalDecisionOutcome | PendingApprovalDecision,
): value is PendingApprovalDecision {
  return "kind" in value && value.kind === "pending_approval_decision";
}

interface DurablePlanLaunch {
  readonly executionKind: "plan";
  readonly plan: WorkflowPlanDefinition;
  readonly resumePolicy: DurableWorkflowResumePolicy;
  readonly budgetTotal: number | null;
}

/** Non-settling control signal used to reselect from durable plan authority. */
class WorkflowPlanReselectionError extends WorkflowOperationInterruptedError {
  constructor(message: string, usage?: Usage) {
    super("recovery", message, usage);
    this.name = "WorkflowPlanReselectionError";
  }
}

function isWorkflowPlanReselectionError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof WorkflowPlanReselectionError) return true;
    current = current.cause;
  }
  return false;
}

const ROOT_DEFINITION_PATH = createWorkflowDefinitionPath(
  ROOT_WORKFLOW_DEFINITION_PATH,
);
const RESUME_POLICIES: readonly DurableWorkflowResumePolicy[] = [
  "automatic_on_reload_or_resume",
  "trusted_resume",
  "never",
];

export function createDurableWorkflowPlanRunId(): DurableWorkflowRunId {
  return createDurableWorkflowRunId(`plan-${randomUUID()}`);
}

export class DurableWorkflowPlanController {
  readonly owner: DurableWorkflowOwner;
  readonly repository: WorkflowProjectionRepository;

  readonly #store: WorkflowRunStore;
  readonly #lease: WorkflowRunLease;
  readonly #dispatcher: WorkflowAgentDispatcher;
  readonly #runAgentForRun: (
    runId: DurableWorkflowRunId,
  ) => WorkflowAgentRunner;
  readonly #generateId: () => string;
  readonly #recovery: WorkflowRecoveryService;
  readonly #scripts: DurableWorkflowScriptControllerAdapter;
  readonly #onDeliveryReady?: (
    runId: DurableWorkflowRunId,
  ) => void | Promise<void>;
  readonly #onPlanMutationWake?: (
    runId: DurableWorkflowRunId,
  ) => void | Promise<void>;
  readonly #active = new Map<DurableWorkflowRunId, ActiveExecution>();
  readonly #managementTails = new Map<DurableWorkflowRunId, Promise<void>>();
  readonly #deferredPlanWakes = new Set<DurableWorkflowRunId>();
  #deliveryTail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    options: DurableWorkflowPlanControllerOptions,
    lease: WorkflowRunLease,
    dispatcher: WorkflowAgentDispatcher,
  ) {
    this.#store = options.store;
    this.#lease = lease;
    this.#dispatcher = dispatcher;
    this.owner = options.owner;
    this.repository =
      options.repository ?? new InMemoryWorkflowProjectionRepository();
    this.#runAgentForRun = options.runAgentForRun;
    this.#generateId = options.generateId ?? randomUUID;
    this.#onDeliveryReady = options.onDeliveryReady;
    this.#onPlanMutationWake = options.onPlanMutationWake;
    this.#recovery = new WorkflowRecoveryService(
      this.#store,
      this.repository,
      new WorkflowRunBlobResolver(this.#store),
    );
    this.#scripts = new DurableWorkflowScriptControllerAdapter({
      store: this.#store,
      lease: this.#lease,
      owner: this.owner,
      repository: this.repository,
      runAgentForRun: this.#runAgentForRun,
      dispatcher: this.#dispatcher,
      generateId: this.#generateId,
    });
  }

  static async acquire(
    options: DurableWorkflowPlanControllerOptions,
  ): Promise<DurableWorkflowPlanController> {
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: options.concurrency,
      processConcurrency: options.processConcurrency,
    });
    let lease: WorkflowRunLease | undefined;
    try {
      lease = await options.store.acquireLease(options.owner, {
        scopeId: options.scopeId,
        generation: options.generation,
      });
      return new DurableWorkflowPlanController(options, lease, dispatcher);
    } catch (error) {
      dispatcher.close();
      await lease?.release().catch(() => undefined);
      throw error;
    }
  }

  async open(
    reason: WorkflowRecoveryReason = "startup",
  ): Promise<DurableWorkflowPlanOpenResult> {
    this.#assertOpen();
    const recovery = await this.#recovery.recoverOwner(this.owner, reason);
    for (const recovered of recovery.runs) {
      const projection = recovered.projection;
      if (projection?.result === undefined) continue;
      await this.#repairTerminalGap(projection, reason);
    }
    for (const recovered of recovery.runs) {
      const projection =
        recovered.projection === undefined
          ? undefined
          : await this.repository.get(this.owner, recovered.runId);
      if (
        projection?.executionKind !== "plan" ||
        projection.terminal !== undefined ||
        (projection.cancellationRequestedEventId === undefined &&
          !projection.approvalRequests.some(
            (request) => request.decision === "denied",
          ))
      ) {
        continue;
      }
      await this.#repairHumanDecisionGap(projection, reason);
    }
    for (const recovered of recovery.runs) {
      const projection =
        recovered.projection === undefined
          ? undefined
          : await this.repository.get(this.owner, recovered.runId);
      if (
        projection?.terminal !== undefined ||
        projection?.status !== "awaiting_budget"
      ) {
        continue;
      }
      const journal = await this.#lease.acquireRun(projection.runId, reason);
      await this.#refresh(journal);
    }
    await this.reconcileDeliveries();
    if (reason === "startup") {
      return Object.freeze({ recovery, completions: Object.freeze([]) });
    }

    const completions: DurableWorkflowExecution[] = [];
    for (const recovered of recovery.runs) {
      if (!recovered.automaticResumeEligible) continue;
      const projection =
        recovered.projection === undefined
          ? undefined
          : await this.repository.get(this.owner, recovered.runId);
      if (projection === undefined || projection.terminal !== undefined) {
        continue;
      }
      completions.push(
        projection.executionKind === "script"
          ? this.#observeScriptExecution(
              await this.#scripts.resumeRecovered(projection, reason),
            )
          : await this.#resumePlan(projection, { reason }),
      );
    }
    return Object.freeze({
      recovery,
      completions: Object.freeze(completions),
    });
  }

  async startPlan(
    options: DurableWorkflowPlanStartOptions,
  ): Promise<DurableWorkflowPlanExecution> {
    this.#assertOpen();
    const plan = validateDurableWorkflowPlan(options.plan);
    const canonicalDefinition = encodeDurableValue(plan);
    const runId = options.runId ?? createDurableWorkflowPlanRunId();
    if (!isDurableWorkflowRunId(runId)) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow run ID is invalid.",
      );
    }
    if (this.#active.has(runId)) {
      throw new DurableWorkflowPlanControllerError(
        "run_active",
        `Durable workflow run ${runId} already has an executor.`,
      );
    }
    const resumePolicy = options.resumePolicy ?? "trusted_resume";
    if (!RESUME_POLICIES.includes(resumePolicy)) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow resume policy is invalid.",
      );
    }
    const budgetTotal = options.budgetTotal ?? null;
    if (
      budgetTotal !== null &&
      (!Number.isFinite(budgetTotal) || budgetTotal <= 0)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow budget must be a positive finite number.",
      );
    }

    const launch: DurablePlanLaunch = {
      executionKind: "plan",
      plan,
      resumePolicy,
      budgetTotal,
    };
    const journal = await this.#lease.createRun({ runId, launch });
    const fence = requiredFence(journal);
    const definition = await journal.writeDefinition(canonicalDefinition.json);
    const definitionDigest = createWorkflowDefinitionDigest(
      canonicalDefinition.sha256,
    );
    if (
      definition.sha256 !== definitionDigest ||
      definition.sizeBytes !== Buffer.byteLength(canonicalDefinition.json)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Immutable workflow plan definition does not match its canonical digest.",
      );
    }

    await this.#appendEvent(
      journal,
      "run_created",
      {
        durableOwner: this.owner,
        executionKind: "plan",
        rootDefinitionPath: ROOT_DEFINITION_PATH,
        rootDefinitionDigest: definitionDigest,
        resumePolicy,
      },
      false,
    );
    await this.#appendEvent(journal, "run_epoch_acquired", {
      fence,
      previousRunEpoch: null,
      reason: "created",
    });
    await this.#appendEvent(journal, "definition_captured", {
      captureKind: "root",
      definitionPath: ROOT_DEFINITION_PATH,
      definitionDigest,
      definition,
    });
    await this.#appendEvent(journal, "plan_defined", {
      revision: 1,
      definitionDigest,
      definition,
    });

    const execution = this.#newExecution(
      journal,
      plan,
      definitionDigest,
      1,
      options,
    );
    return this.#startExecution(execution);
  }

  async createPlan(
    options: DurableWorkflowPlanStartOptions,
  ): Promise<WorkflowPlanRunResult> {
    return (await this.startPlan(options)).completion;
  }
  startScript(
    options: DurableWorkflowScriptStartOptions,
  ): Promise<DurableWorkflowScriptExecution> {
    this.#assertOpen();
    return this.#scripts
      .startScript(options)
      .then((execution) => this.#observeScriptExecution(execution));
  }
  #observeScriptExecution(
    execution: DurableWorkflowScriptExecution,
  ): DurableWorkflowScriptExecution {
    const notify = async (): Promise<void> => {
      try {
        await this.#onDeliveryReady?.(execution.runId);
      } catch {
        // A terminal run remains in the durable outbox and is retried by the
        // next reconciliation trigger.
      }
    };
    void execution.completion.then(notify, notify);
    return execution;
  }

  async trustedResume(
    runId: DurableWorkflowRunId,
    options: DurableWorkflowPlanResumeOptions,
  ): Promise<DurableWorkflowExecution> {
    this.#assertOpen();
    if (!isWorkflowIdentifier(options.trustedActorId)) {
      throw new DurableWorkflowPlanControllerError(
        "trusted_resume_required",
        "Trusted resume requires a valid actor ID.",
      );
    }
    this.#assertExpectedOwner(options.expectedOwner);
    const projection = await this.repository.get(this.owner, runId);
    if (projection === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow run ${runId} is not recovered.`,
      );
    }
    this.#assertExpectedEpoch(projection, options.expectedRunEpoch);
    if (projection.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${runId} is already terminal.`,
      );
    }
    if (projection.status !== "interrupted") {
      throw new DurableWorkflowPlanControllerError(
        "trusted_resume_required",
        `Durable workflow run ${runId} is not awaiting trusted resume.`,
      );
    }
    if (projection.resumePolicy === "never") {
      throw new DurableWorkflowPlanControllerError(
        "resume_forbidden",
        `Durable workflow run ${runId} cannot be resumed by policy.`,
      );
    }
    if (projection.executionKind === "script") {
      return this.#observeScriptExecution(
        await this.#scripts.resumeRecovered(projection, "trusted_resume", {
          signal: options.signal,
          onProgress: options.onProgress,
          trustedActorId: options.trustedActorId,
        }),
      );
    }
    return this.#resumePlan(projection, {
      reason: "trusted_resume",
      trustedActorId: options.trustedActorId,
      signal: options.signal,
      onProgress: options.onProgress,
      onPlanEvent: options.onPlanEvent,
    });
  }

  inspectApproval(
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowApprovalSnapshot | undefined> {
    this.#assertOpen();
    return this.repository
      .get(this.owner, runId)
      .then((projection) =>
        projection === undefined
          ? undefined
          : pendingWorkflowApproval(projection),
      );
  }

  requestApproval(
    runId: DurableWorkflowRunId,
    options: WorkflowApprovalRequestOptions,
  ): Promise<WorkflowApprovalSnapshot> {
    return this.#serializeManagement(runId, () =>
      this.#requestApproval(runId, options),
    );
  }

  async #requestApproval(
    runId: DurableWorkflowRunId,
    options: WorkflowApprovalRequestOptions,
  ): Promise<WorkflowApprovalSnapshot> {
    this.#assertOpen();
    if (
      (options.approvalKind !== "budget" &&
        options.approvalKind !== "plan_gate") ||
      (options.denialPolicy !== "stop" && options.denialPolicy !== "skip") ||
      (options.denialPolicy === "skip" &&
        (options.subjectTaskId === undefined ||
          options.subjectTaskId === null)) ||
      typeof options.description !== "string" ||
      options.description.length === 0 ||
      options.description.length > 4_096 ||
      (options.subjectTaskId !== undefined &&
        options.subjectTaskId !== null &&
        !isWorkflowIdentifier(options.subjectTaskId))
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Approval request fields are invalid.",
      );
    }
    this.#assertExpectedOwner(options.expectedOwner);
    let projection = await this.repository.get(this.owner, runId);
    if (projection === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow run ${runId} is not recovered.`,
      );
    }
    const existing = pendingWorkflowApproval(projection);
    if (existing !== undefined) return existing;
    if (
      options.expectedOwnerGeneration !== undefined &&
      options.expectedOwnerGeneration !== projection.ownerGeneration
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Approval request owner generation is stale.",
      );
    }
    this.#assertExpectedEpoch(projection, options.expectedRunEpoch);
    if (projection.terminal !== undefined || projection.status !== "running") {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        `Durable workflow run ${runId} cannot request approval while ${projection.status}.`,
      );
    }
    const active = this.#active.get(runId);
    const journal =
      active?.journal ?? (await this.#lease.acquireRun(runId, "resume"));
    projection = await this.#refresh(journal);
    const afterAcquire = pendingWorkflowApproval(projection);
    if (afterAcquire !== undefined) return afterAcquire;
    if (projection.status !== "running" || projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Approval request state changed before it could be committed.",
      );
    }
    const subjectTaskId = options.subjectTaskId ?? null;
    const currentPlan =
      active?.plan ?? (await this.#readCurrentPlan(journal, projection));
    if (
      subjectTaskId !== null &&
      !currentPlan.phases
        .flatMap((phase) => phase.tasks)
        .some((task) => task.id === subjectTaskId)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        `Approval subject task ${subjectTaskId} is not in the durable plan.`,
      );
    }
    const fence = requiredFence(journal);
    const version =
      projection.approvalRequests.reduce(
        (maximum, request) => Math.max(maximum, request.version),
        0,
      ) + 1;
    const policyHash = createWorkflowApprovalPolicyHash(
      options.policy ?? {
        approvalKind: options.approvalKind,
        description: options.description,
        denialPolicy: options.denialPolicy,
        subjectTaskId,
        planRevision: projection.plan.revision,
        revisionHash: projection.plan.revisionHash,
      },
    );
    const budgetRequestId = `approval-${this.#generateId()}`;
    await this.#appendEvent(journal, "budget_requested", {
      budgetRequestId,
      approvalKind: options.approvalKind,
      reason: options.approvalKind === "budget" ? "token_limit" : "plan_gate",
      description: options.description,
      accounting: projection.accounting,
      policyHash,
      planRevision: projection.plan.revision,
      ownerGeneration: fence.generation,
      runEpoch: fence.runEpoch,
      version,
      denialPolicy: options.denialPolicy,
      subjectTaskId,
    });
    const requestedProjection = await this.#refresh(journal);
    const request = pendingWorkflowApproval(requestedProjection);
    if (request === undefined || request.requestId !== budgetRequestId) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Committed approval request did not project as pending.",
      );
    }
    if (active !== undefined) {
      active.awaitingApprovalRequestId = request.requestId;
    }
    return request;
  }

  async trustedDecideApproval(
    runId: DurableWorkflowRunId,
    input: WorkflowApprovalDecisionInput,
  ): Promise<WorkflowApprovalDecisionOutcome> {
    let drained = false;
    for (;;) {
      const result = await this.#serializeManagement(runId, () =>
        this.#trustedDecideApproval(runId, input, drained),
      );
      if (!isPendingApprovalDecision(result)) return result;
      await result.completion.catch(() => undefined);
      drained = true;
    }
  }

  async #trustedDecideApproval(
    runId: DurableWorkflowRunId,
    input: WorkflowApprovalDecisionInput,
    drained: boolean,
  ): Promise<WorkflowApprovalDecisionOutcome | PendingApprovalDecision> {
    this.#assertOpen();
    if (
      !isWorkflowIdentifier(input.trustedActorId) ||
      (input.decision !== "approved" && input.decision !== "denied")
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Trusted approval decision requires a valid actor and decision.",
      );
    }
    let projection = await this.repository.get(this.owner, runId);
    if (projection === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow run ${runId} is not recovered.`,
      );
    }
    let request = pendingWorkflowApproval(projection);
    if (request === undefined) {
      return { status: "no_op", reason: "not_pending" };
    }
    if (projection.plan?.revision !== request.planRevision) {
      return { status: "no_op", reason: "plan_revision_mismatch", request };
    }
    let mismatch = workflowApprovalFenceMismatch(request, input);
    if (mismatch !== undefined) {
      return { status: "no_op", reason: mismatch, request };
    }

    const active = this.#active.get(runId);
    if (!drained && active?.completion !== undefined) {
      active.awaitingApprovalRequestId = request.requestId;
      return {
        kind: "pending_approval_decision",
        completion: active.completion,
      };
    }
    const journal =
      active?.journal ?? (await this.#lease.acquireRun(runId, "resume"));
    projection = await this.#refresh(journal);
    if (
      projection.terminal !== undefined ||
      projection.cancellationRequestedEventId !== undefined
    ) {
      return { status: "no_op", reason: "not_pending" };
    }
    request = pendingWorkflowApproval(projection);
    if (request === undefined) {
      return { status: "no_op", reason: "not_pending" };
    }
    if (projection.plan?.revision !== request.planRevision) {
      return { status: "no_op", reason: "plan_revision_mismatch", request };
    }
    mismatch = workflowApprovalFenceMismatch(request, input);
    if (mismatch !== undefined) {
      return { status: "no_op", reason: mismatch, request };
    }
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (
        attempt?.status !== "started" ||
        (attempt.dispatchedEventId === undefined &&
          attempt.process === undefined)
      ) {
        continue;
      }
      await this.#appendEvent(journal, "attempt_interrupted", {
        attempt: attempt.attempt,
        reason: "recovery",
      });
    }
    projection = await this.#refresh(journal);
    const current = pendingWorkflowApproval(projection);
    if (current === undefined) {
      return { status: "no_op", reason: "not_pending" };
    }
    if (projection.plan?.revision !== current.planRevision) {
      return {
        status: "no_op",
        reason: "plan_revision_mismatch",
        request: current,
      };
    }
    mismatch = workflowApprovalFenceMismatch(current, input);
    if (mismatch !== undefined) {
      return { status: "no_op", reason: mismatch, request: current };
    }
    const fence = requiredFence(journal);
    await this.#appendEvent(journal, "budget_decided", {
      budgetRequestId: current.requestId,
      requestEventId: current.requestEventId,
      decision: input.decision,
      trustedActorId: input.trustedActorId,
      policyHash: current.policyHash,
      planRevision: current.planRevision,
      requestOwnerGeneration: current.requestOwnerGeneration,
      requestRunEpoch: current.requestRunEpoch,
      ownerGeneration: fence.generation,
      runEpoch: fence.runEpoch,
      version: current.version,
    });
    projection = await this.#refresh(journal);

    if (input.decision === "denied") {
      projection = await this.#completeDecidedDenials(journal, projection);
      if (current.denialPolicy === "stop") {
        return {
          status: "accepted",
          decision: input.decision,
          request: current,
        };
      }
    }

    if (projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Approved durable workflow has no current plan definition.",
      );
    }
    const plan = await this.#readCurrentPlan(journal, projection);
    const execution = this.#newExecution(
      journal,
      plan,
      projection.plan.definitionDigest,
      projection.plan.revision,
      {
        budgetTotal: this.#readLaunchBudget(journal),
      },
      new Set(
        projection.tasks
          .filter((task) => task.status === "skipped")
          .map((task) => task.taskId),
      ),
    );
    const continued = this.#startExecution(execution);
    return {
      status: "accepted",
      decision: input.decision,
      request: current,
      execution: continued,
    };
  }

  async trustedCancel(
    runId: DurableWorkflowRunId,
    options: DurableWorkflowPlanCancellationOptions,
  ): Promise<WorkflowPlanRunResult | WorkflowRunResultWithUsage> {
    const result = await this.#serializeManagement(runId, () =>
      this.#trustedCancel(runId, options),
    );
    return isPendingActivePlanCancellation(result)
      ? this.#finishActiveCancellation(result.execution)
      : result;
  }

  async #trustedCancel(
    runId: DurableWorkflowRunId,
    options: DurableWorkflowPlanCancellationOptions,
  ): Promise<
    | WorkflowPlanRunResult
    | WorkflowRunResultWithUsage
    | PendingActivePlanCancellation
  > {
    this.#assertOpen();
    if (
      !isWorkflowIdentifier(options.trustedActorId) ||
      typeof options.reason !== "string" ||
      options.reason.length === 0 ||
      options.reason.length > 4_096
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_cancellation",
        "Trusted cancellation requires a valid actor ID and bounded reason.",
      );
    }
    this.#assertExpectedOwner(options.expectedOwner);
    let projection = await this.repository.get(this.owner, runId);
    if (projection === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow run ${runId} is not recovered.`,
      );
    }
    this.#assertExpectedEpoch(projection, options.expectedRunEpoch);
    if (projection.executionKind === "script") {
      if (projection.terminal !== undefined) {
        if (projection.terminal.status === "cancelled") {
          return requiredStoredScriptResult(await this.getResult(runId), runId);
        }
        throw new DurableWorkflowPlanControllerError(
          "terminal_run",
          `Durable workflow run ${runId} is already terminal.`,
        );
      }
      return this.#scripts.trustedCancel(
        projection,
        options.reason,
        options.trustedActorId,
      );
    }
    if (projection.terminal !== undefined) {
      if (projection.terminal.status === "cancelled") {
        return requiredStoredPlanResult(await this.getResult(runId), runId);
      }
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${runId} is already terminal.`,
      );
    }

    const active = this.#active.get(runId);
    if (active !== undefined) {
      if (active.cancellation === undefined) {
        const persisted =
          projection.cancellationRequestedEventId === undefined
            ? Promise.resolve().then(() =>
                this.#persistActiveCancellation(
                  active,
                  options.reason,
                  options.trustedActorId,
                ),
              )
            : Promise.resolve();
        active.cancellation = {
          reason: options.reason,
          trustedActorId: options.trustedActorId,
          persisted,
        };
      }
      if (active.completion === undefined) {
        throw new DurableWorkflowPlanControllerError(
          "run_active",
          `Durable workflow run ${runId} has not attached its completion.`,
        );
      }
      return { kind: "active_plan_cancellation", execution: active };
    }

    const journal = await this.#lease.acquireRun(runId, "resume");
    projection = await this.#refresh(journal);
    if (projection.terminal !== undefined) {
      if (projection.terminal.status === "cancelled") {
        return requiredStoredPlanResult(await this.getResult(runId), runId);
      }
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${runId} became terminal.`,
      );
    }
    if (projection.cancellationRequestedEventId === undefined) {
      await this.#appendEvent(journal, "run_cancellation_requested", {
        reason: options.reason,
        trustedActorId: options.trustedActorId,
      });
    }
    return this.#cancelInactivePlan(journal, options.reason);
  }

  getProjection(
    runId: DurableWorkflowRunId,
  ): Promise<DurableWorkflowProjection | undefined> {
    this.#assertOpen();
    return this.repository.get(this.owner, runId);
  }

  isPlanExecutorActive(runId: DurableWorkflowRunId): boolean {
    this.#assertOpen();
    return this.#active.has(runId);
  }

  async getPlanView(
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowPlanViewProjection> {
    this.#assertOpen();
    const projection = await this.repository.get(this.owner, runId);
    if (
      projection === undefined ||
      projection.executionKind !== "plan" ||
      projection.plan === undefined
    ) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow plan ${runId} is not recovered.`,
      );
    }
    const journal = await this.#store.openRun(this.owner, runId);
    return this.#planView(journal, projection);
  }

  async listPlanViews(): Promise<readonly WorkflowPlanViewProjection[]> {
    this.#assertOpen();
    const projections = await this.repository.list(this.owner);
    const views: WorkflowPlanViewProjection[] = [];
    for (const projection of projections) {
      if (
        projection.executionKind !== "plan" ||
        projection.plan === undefined
      ) {
        continue;
      }
      const journal = await this.#store.openRun(this.owner, projection.runId);
      views.push(await this.#planView(journal, projection));
    }
    return Object.freeze(views);
  }

  mutatePlan(
    runId: DurableWorkflowRunId,
    request: WorkflowPlanMutationRequest,
  ): Promise<WorkflowPlanViewProjection> {
    this.#assertOpen();
    return this.#serializeManagement(runId, () =>
      this.#mutatePlan(runId, request),
    );
  }

  wakePlan(runId: DurableWorkflowRunId): Promise<void> {
    this.#assertOpen();
    return this.#serializeManagement(runId, () => this.#wakePlan(runId));
  }

  async getResult(
    runId: DurableWorkflowRunId,
  ): Promise<DurableValue | undefined> {
    this.#assertOpen();
    const journal = await this.#store.openRun(this.owner, runId);
    const projection =
      (await this.repository.get(this.owner, runId)) ??
      foldWorkflowRunEvents(await journal.readEvents());
    const binding = await journal.readResult();
    const reference = binding?.result ?? projection.result?.result;
    if (reference === undefined) return undefined;
    const stored = await journal.readOutput(reference);
    return projection.executionKind === "script"
      ? (decodeStoredDurableWorkflowScriptResult(stored)
          .result as unknown as DurableValue)
      : stored;
  }
  reconcileDeliveries(
    transport?: DurableWorkflowDeliveryTransport,
  ): Promise<DurableWorkflowDeliveryReconcileResult> {
    const operation = this.#deliveryTail.then(
      () => this.#reconcileDeliveries(transport),
      () => this.#reconcileDeliveries(transport),
    );
    this.#deliveryTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #reconcileDeliveries(
    transport?: DurableWorkflowDeliveryTransport,
  ): Promise<DurableWorkflowDeliveryReconcileResult> {
    this.#assertOpen();
    const existing = durableWorkflowDeliveryIdsFromEntries(
      transport?.existingEntries?.() ?? [],
    );
    let intentsRecorded = 0;
    let receiptsRecorded = 0;
    for (const recovered of await this.repository.list(this.owner)) {
      if (recovered.terminal === undefined) continue;
      const journal = await this.#lease.openTerminalMaintenanceRun(
        recovered.runId,
      );
      let projection = await this.#refresh(journal);
      const ensured = await this.#ensureDeliveryIntent(journal, projection);
      projection = ensured.projection;
      if (ensured.recorded) intentsRecorded += 1;
      if (ensured.delivery.state === "delivered") continue;
      if (transport === undefined) continue;

      let deliveredBy: "pi-session-entry" | "pi-send-message";
      if (existing.has(ensured.delivery.deliveryId)) {
        deliveredBy = "pi-session-entry";
      } else {
        const payload = decodeDurableWorkflowDeliveryPayload(
          await journal.readOutput(ensured.delivery.payload),
        );
        if (
          payload.deliveryId !== ensured.delivery.deliveryId ||
          payload.runId !== projection.runId ||
          payload.terminalEventId !== projection.terminal?.eventId
        ) {
          throw new DurableWorkflowPlanControllerError(
            "invalid_plan",
            "Durable workflow delivery payload does not match its terminal intent.",
          );
        }
        transport.dispatch(durableWorkflowDeliveryMessage(payload));
        deliveredBy = "pi-send-message";
      }
      await this.#appendEvent(journal, "delivery_receipt_recorded", {
        outboxSchemaVersion: WORKFLOW_OUTBOX_SCHEMA_VERSION,
        deliveryId: ensured.delivery.deliveryId,
        intentEventId: ensured.delivery.intentEventId,
        deliveredBy,
      });
      receiptsRecorded += 1;
    }
    return Object.freeze({ intentsRecorded, receiptsRecorded });
  }

  async interrupt(
    reason: DurableWorkflowPlanInterruptionReason,
    runId?: DurableWorkflowRunId,
  ): Promise<void> {
    const executions =
      runId === undefined
        ? [...this.#active.values()]
        : [this.#active.get(runId)].filter(
            (execution): execution is ActiveExecution =>
              execution !== undefined,
          );
    for (const execution of executions) {
      if (execution.cancellation !== undefined) {
        try {
          await execution.cancellation.persisted;
          if (!execution.abort.signal.aborted) {
            execution.abort.abort(execution.cancellation.reason);
          }
          continue;
        } catch {
          execution.interruptionReason = reason;
        }
      }
      execution.interruptionReason = reason;
      if (!execution.abort.signal.aborted) execution.abort.abort(reason);
    }
    await Promise.allSettled(
      executions.map((execution) => execution.completion),
    );
    await this.#scripts.interrupt(reason, runId);
  }

  async release(): Promise<void> {
    this.#assertOpen();
    try {
      await this.interrupt("quit");
    } finally {
      this.#dispatcher.close();
      await this.#dispatcher.drain();
      await this.#lease.release();
      this.#closed = true;
    }
  }

  async #resumePlan(
    recovered: DurableWorkflowProjection,
    options: DurableWorkflowPlanExecutionOptions & {
      readonly reason: WorkflowRecoveryReason | "trusted_resume";
      readonly trustedActorId?: string;
    },
  ): Promise<DurableWorkflowPlanExecution> {
    if (this.#active.has(recovered.runId)) {
      throw new DurableWorkflowPlanControllerError(
        "run_active",
        `Durable workflow run ${recovered.runId} already has an executor.`,
      );
    }
    if (recovered.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} is already terminal.`,
      );
    }
    const acquisitionReason =
      options.reason === "trusted_resume" ? "resume" : options.reason;
    const journal = await this.#lease.acquireRun(
      recovered.runId,
      acquisitionReason,
    );
    let projection = await this.#refresh(journal);
    if (projection.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} became terminal.`,
      );
    }
    projection = await this.#completeDecidedDenials(journal, projection);
    if (projection.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} completed its persisted denial before resume.`,
      );
    }
    if (projection.cancellationRequestedEventId !== undefined) {
      const cancellationReason = await this.#cancellationReason(
        journal,
        projection,
      );
      await this.#cancelInactivePlan(journal, cancellationReason);
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} completed its persisted cancellation instead of resuming.`,
      );
    }
    if (projection.status !== "interrupted") {
      await this.#appendEvent(journal, "run_interrupted", {
        reason: options.reason === "reload" ? "reload" : "process_crash",
      });
      projection = await this.#refresh(journal);
    }
    for (const operation of projection.operations) {
      const activeAttempt = operation.attempts.at(-1);
      if (
        activeAttempt?.status !== "started" ||
        (activeAttempt.dispatchedEventId === undefined &&
          activeAttempt.process === undefined)
      ) {
        continue;
      }
      if (
        activeAttempt.process !== undefined &&
        activeAttempt.process.effectiveIsolation === "process" &&
        activeAttempt.process.fencedEventId === undefined
      ) {
        continue;
      }
      await this.#appendEvent(journal, "attempt_interrupted", {
        attempt: activeAttempt.attempt,
        reason: "recovery",
      });
    }
    if (projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Recovered durable workflow has no current plan definition.",
      );
    }
    const plan = await this.#readCurrentPlan(journal, projection);
    const resumeReason =
      options.reason === "trusted_resume"
        ? "trusted_resume"
        : options.reason === "reload"
          ? "reload"
          : "resume";
    await this.#appendEvent(journal, "run_resumed", {
      reason: resumeReason,
      ...(options.trustedActorId === undefined
        ? {}
        : { trustedActorId: options.trustedActorId }),
    });
    projection = await this.#refresh(journal);
    if (projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Resumed durable workflow has no current plan definition.",
      );
    }
    const execution = this.#newExecution(
      journal,
      plan,
      projection.plan.definitionDigest,
      projection.plan.revision,
      {
        ...options,
        budgetTotal: this.#readLaunchBudget(journal),
      },
      new Set(
        projection.tasks
          .filter((task) => task.status === "skipped")
          .map((task) => task.taskId),
      ),
    );
    return this.#startExecution(execution);
  }

  #newExecution(
    journal: WorkflowRunJournal,
    plan: WorkflowPlanDefinition,
    definitionDigest: WorkflowDefinitionDigest,
    planRevision: number,
    options: DurableWorkflowPlanExecutionOptions,
    skipTaskIds: ReadonlySet<string> = new Set(),
  ): ActiveExecution {
    const abort = new AbortController();
    if (options.signal?.aborted) abort.abort(options.signal.reason);
    return {
      runId: journal.runId,
      journal,
      plan,
      definitionDigest,
      planRevision,
      abort,
      concurrency: options.concurrency,
      budgetTotal: options.budgetTotal ?? null,
      skipTaskIds,
      externalSignal: options.signal,
      onProgress: options.onProgress,
      onPlanEvent: options.onPlanEvent,
      agentsSpawned: 0,
      ...(options.signal?.aborted
        ? { interruptionReason: "owner_replaced" }
        : {}),
    };
  }

  #startExecution(execution: ActiveExecution): DurableWorkflowPlanExecution {
    this.#active.set(execution.runId, execution);
    const onAbort = () => {
      if (execution.cancellation === undefined) {
        execution.interruptionReason = "owner_replaced";
      }
      if (!execution.abort.signal.aborted) {
        execution.abort.abort(execution.externalSignal?.reason);
      }
    };
    if (execution.externalSignal?.aborted) {
      onAbort();
    } else {
      execution.externalSignal?.addEventListener("abort", onAbort, {
        once: true,
      });
    }
    const completion = this.#execute(execution).finally(() => {
      execution.externalSignal?.removeEventListener("abort", onAbort);
      if (this.#active.get(execution.runId) === execution) {
        this.#active.delete(execution.runId);
      }
      if (this.#deferredPlanWakes.delete(execution.runId) && !this.#closed) {
        void this.wakePlan(execution.runId).catch((error) => {
          console.error("[subagentura] deferred workflow wake failed", error);
        });
      }
    });
    execution.completion = completion;
    return Object.freeze({ runId: execution.runId, completion });
  }

  async #execute(
    execution: ActiveExecution,
    priorAgentsSpawned = 0,
    priorPhases: readonly string[] = [],
  ): Promise<WorkflowPlanRunResult> {
    const fence = requiredFence(execution.journal);
    const durableJournal = new WorkflowRunOperationJournal(
      execution.journal,
      this.#generateId,
    );
    const operationJournal: WorkflowOperationJournal = {
      revalidateFence: (nextFence) => durableJournal.revalidateFence(nextFence),
      readOperation: (nextFence, operation) =>
        durableJournal.readOperation(nextFence, operation),
      allocateAttempt: (nextFence, request) =>
        durableJournal.allocateAttempt(nextFence, request),
      allocateResponseOrdinal: (nextFence, request) =>
        durableJournal.allocateResponseOrdinal(nextFence, request),
      commitResponse: (nextFence, request, responseOrdinal, commit) =>
        durableJournal.commitResponse(
          nextFence,
          request,
          responseOrdinal,
          commit,
        ),
      abandonResponse: (nextFence, request, responseOrdinal, reason) =>
        durableJournal.abandonResponse(
          nextFence,
          request,
          responseOrdinal,
          reason,
        ),
      appendEvent: async (nextFence, draft) => {
        const appended = await durableJournal.appendEvent(nextFence, draft);
        await this.#refresh(execution.journal);
        return appended;
      },
      putOutcomeBlob: (nextFence, value) =>
        durableJournal.putOutcomeBlob(nextFence, value),
      readOutcomeBlob: (nextFence, reference) =>
        durableJournal.readOutcomeBlob(nextFence, reference),
    };
    const runAgent = this.#runAgentForRun(execution.runId);
    const durableProjection = await this.#refresh(execution.journal);
    let schedulerRevision =
      durableProjection.plan?.revision ?? execution.planRevision;
    const initialTaskStatuses: Record<string, WorkflowPlanTaskStatus> =
      Object.create(null);
    for (const task of durableProjection.tasks) {
      if (task.status === "blocked" || task.status === "skipped") {
        initialTaskStatuses[task.taskId] = task.status;
      }
    }
    let result: WorkflowPlanRunResult;
    try {
      result = await runWorkflowPlan(execution.plan, {
        runAgent,
        concurrency: execution.concurrency,
        dispatcher: this.#dispatcher,
        signal: execution.abort.signal,
        onProgress: (progress) => {
          if (progress.kind === "agent_start") execution.agentsSpawned += 1;
          execution.onProgress?.(progress);
        },
        appendEvent: (event) =>
          this.#appendPlanEvent(execution, event, schedulerRevision),
        skipTask: (task) =>
          execution.skipTaskIds.has(task.definition.id)
            ? "Skipped by a trusted approval denial."
            : undefined,
        initialTaskStatuses,
        refreshPlan: async () => {
          const projection = await this.#refresh(execution.journal);
          schedulerRevision = projection.plan?.revision ?? schedulerRevision;
          if (projection.plan === undefined) {
            throw new DurableWorkflowPlanControllerError(
              "invalid_plan",
              `Durable workflow run ${execution.runId} lost its plan projection.`,
            );
          }
          const taskStatuses: Record<string, WorkflowPlanTaskStatus> =
            Object.create(null);
          for (const task of projection.tasks) {
            taskStatuses[task.taskId] = task.status;
          }
          return {
            definition: await this.#readCurrentPlan(
              execution.journal,
              projection,
            ),
            taskStatuses,
          };
        },
        dispatchTask: async (input) => {
          if (
            execution.interruptionReason !== undefined ||
            execution.cancellation !== undefined
          ) {
            throw operationInterruption(
              execution.interruptionReason ?? "owner_replaced",
            );
          }
          await this.#ensureDispatchBudget(execution, input);
          const prepared = await this.#serializeManagement(
            execution.runId,
            async () => {
              const projection = await this.#refresh(execution.journal);
              const pending = pendingWorkflowApproval(projection);
              if (pending !== undefined) {
                execution.awaitingApprovalRequestId = pending.requestId;
                throw new DurableWorkflowPlanControllerError(
                  "awaiting_budget",
                  `Durable workflow run ${execution.runId} is awaiting trusted approval.`,
                );
              }
              if (
                projection.terminal !== undefined ||
                projection.cancellationRequestedEventId !== undefined ||
                execution.interruptionReason !== undefined ||
                execution.cancellation !== undefined
              ) {
                throw operationInterruption(
                  execution.interruptionReason ?? "owner_replaced",
                );
              }
              const taskId = input.task.definition.id;
              const status = projection.taskStates[taskId]?.status ?? "pending";
              const committedReplay = projection.operations.some(
                (operation) =>
                  operation.identity.definitionPath === ROOT_DEFINITION_PATH &&
                  operation.identity.operationId === taskId &&
                  operation.settlement !== undefined,
              );
              if (
                (!committedReplay && status !== "running") ||
                projection.plan === undefined
              ) {
                schedulerRevision = -1;
                throw new DurableWorkflowPlanControllerError(
                  "stale_revision",
                  `Durable workflow task ${taskId} is no longer eligible to dispatch.`,
                );
              }
              const plan = await this.#readCurrentPlan(
                execution.journal,
                projection,
              );
              const currentTask = plan.phases
                .flatMap((phase) => phase.tasks)
                .find((task) => task.id === taskId);
              if (currentTask === undefined) {
                schedulerRevision = -1;
                throw new DurableWorkflowPlanControllerError(
                  "stale_revision",
                  `Durable workflow task ${taskId} is absent from the current revision.`,
                );
              }
              schedulerRevision = projection.plan.revision;
              const agent = currentTask.agent;
              const dispatchRequest = {
                ...input.request,
                prompt: currentTask.instruction,
                persona: agent?.persona,
                model: agent?.model,
                isolation: agent?.isolation ?? "process",
                label: currentTask.content,
                schema: agent?.schema,
                thinkingLevel: agent?.thinkingLevel,
              };
              const currentInput: WorkflowPlanTaskDispatch = {
                ...input,
                task: { ...input.task, definition: currentTask },
                request: dispatchRequest,
              };
              return {
                dispatchRequest,
                taskDefinitionDigest: encodeDurableValue(currentTask).sha256,
                request: await this.#operationRequest(
                  execution,
                  currentInput,
                  durableJournal,
                  fence,
                ),
              };
            },
          );
          const gate = new WorkflowOperationGate({
            journal: operationJournal,
            blobCodec: durableWorkflowOperationBlobCodec,
            dispatcher: {
              run: async (dispatchRequest) => {
                const launched = input.dispatch(dispatchRequest, async () => {
                  await this.#serializeManagement(execution.runId, async () => {
                    await execution.journal.revalidateFence();
                    const projection = await this.#refresh(execution.journal);
                    if (
                      projection.terminal !== undefined ||
                      projection.cancellationRequestedEventId !== undefined ||
                      execution.interruptionReason !== undefined ||
                      execution.cancellation !== undefined
                    ) {
                      throw operationInterruption(
                        execution.interruptionReason ?? "owner_replaced",
                      );
                    }
                    const taskId = input.task.definition.id;
                    if (
                      projection.plan === undefined ||
                      projection.taskStates[taskId]?.status !== "running"
                    ) {
                      schedulerRevision = -1;
                      throw new WorkflowPlanReselectionError(
                        `Durable workflow task ${taskId} changed before dispatch.`,
                      );
                    }
                    const plan = await this.#readCurrentPlan(
                      execution.journal,
                      projection,
                    );
                    const currentTask = plan.phases
                      .flatMap((phase) => phase.tasks)
                      .find((task) => task.id === taskId);
                    if (
                      currentTask === undefined ||
                      encodeDurableValue(currentTask).sha256 !==
                        prepared.taskDefinitionDigest
                    ) {
                      schedulerRevision = -1;
                      throw new WorkflowPlanReselectionError(
                        `Durable workflow task ${taskId} definition changed before dispatch.`,
                      );
                    }
                    // A running task is mutation-immutable; revision-only drift
                    // affects future scheduler selections, not this dispatch.
                    schedulerRevision = projection.plan.revision;
                  });
                });
                try {
                  const result = await launched;
                  if (
                    isWorkflowPlanReselectionError(
                      dispatchRequest.signal?.reason,
                    )
                  ) {
                    throw new WorkflowPlanReselectionError(
                      "Durable workflow plan changed before sibling work completed.",
                      result.usage,
                    );
                  }
                  if (
                    result.cancelled &&
                    execution.interruptionReason !== undefined &&
                    execution.cancellation === undefined
                  ) {
                    throw operationInterruption(
                      execution.interruptionReason,
                      result.usage,
                    );
                  }
                  return result;
                } catch (error) {
                  if (
                    isWorkflowPlanReselectionError(
                      dispatchRequest.signal?.reason,
                    )
                  ) {
                    if (error instanceof WorkflowPlanReselectionError) {
                      throw error;
                    }
                    throw new WorkflowPlanReselectionError(
                      "Durable workflow plan changed before sibling work completed.",
                      (error as { usage?: Usage } | null)?.usage,
                    );
                  }
                  if (
                    execution.interruptionReason !== undefined &&
                    !(error instanceof WorkflowOperationInterruptedError)
                  ) {
                    throw operationInterruption(execution.interruptionReason);
                  }
                  throw error;
                }
              },
            },
          });
          try {
            const outcome = await gate.execute(
              fence,
              prepared.request,
              prepared.dispatchRequest,
            );
            await this.#refresh(execution.journal);
            if (execution.interruptionReason !== undefined) {
              throw operationInterruption(execution.interruptionReason);
            }
            return requiredPlanResult(outcome);
          } catch (error) {
            try {
              const projection = await this.#refresh(execution.journal);
              const operation = projection.operations.find(
                (candidate) =>
                  candidate.identity.operationId === input.task.definition.id,
              );
              if (
                operation?.settlement === undefined &&
                !isWorkflowPlanReselectionError(error) &&
                execution.interruptionReason === undefined &&
                execution.cancellation === undefined
              ) {
                execution.interruptionReason = "owner_replaced";
              }
            } catch (refreshError) {
              if (
                error instanceof WorkflowRunStoreError ||
                refreshError instanceof WorkflowRunStoreError ||
                refreshError instanceof WorkflowProjectionFoldError
              ) {
                execution.interruptionReason = "owner_replaced";
              }
            }
            throw error;
          }
        },
      });
      result = {
        ...result,
        agentsSpawned: priorAgentsSpawned + result.agentsSpawned,
        phases: [...new Set([...priorPhases, ...result.phases])],
      };
      const projection = await this.#refresh(execution.journal);
      if (
        projection.status === "awaiting_budget" ||
        execution.awaitingApprovalRequestId !== undefined
      ) {
        throw new DurableWorkflowPlanControllerError(
          "awaiting_budget",
          `Durable workflow run ${execution.runId} is awaiting trusted approval.`,
        );
      }
    } catch (error) {
      if (
        isWorkflowPlanReselectionError(error) &&
        execution.interruptionReason === undefined &&
        execution.cancellation === undefined
      ) {
        const projection = await this.#refresh(execution.journal);
        if (
          projection.plan !== undefined &&
          projection.terminal === undefined &&
          projection.cancellationRequestedEventId === undefined &&
          projection.status !== "interrupted" &&
          projection.status !== "awaiting_budget"
        ) {
          execution.plan = await this.#readCurrentPlan(
            execution.journal,
            projection,
          );
          execution.definitionDigest = projection.plan.definitionDigest;
          execution.planRevision = projection.plan.revision;
          return this.#execute(execution, priorAgentsSpawned, priorPhases);
        }
      }
      if (execution.interruptionReason !== undefined) {
        await this.#finishInterruption(execution);
      }
      throw error;
    }

    if (execution.cancellation !== undefined) {
      await execution.cancellation.persisted;
      result =
        result.status === "cancelled"
          ? result
          : { ...result, status: "cancelled" };
      await this.#reconcileTaskStatuses(execution, result);
      return this.#recordResult(
        execution.journal,
        result,
        "cancelled",
        execution.cancellation.reason,
        execution.agentsSpawned,
      );
    }

    const finalized = await this.#serializeManagement(
      execution.runId,
      async (): Promise<WorkflowPlanRunResult | undefined> => {
        const projection = await this.#refresh(execution.journal);
        if (projection.plan?.revision !== schedulerRevision) return undefined;
        if (
          projection.status === "awaiting_budget" ||
          execution.awaitingApprovalRequestId !== undefined
        ) {
          throw new DurableWorkflowPlanControllerError(
            "awaiting_budget",
            `Durable workflow run ${execution.runId} is awaiting trusted approval.`,
          );
        }
        if (execution.interruptionReason !== undefined) {
          await this.#finishInterruption(execution);
        }
        await this.#reconcileTaskStatuses(execution, result);
        if (result.status === "blocked") {
          const blocked = await this.#refresh(execution.journal);
          if (blocked.status === "blocked") {
            return withDurablePlanAccounting(
              result,
              blocked,
              execution.agentsSpawned,
            );
          }
          const blockedTaskIds = blocked.tasks
            .filter((task) => task.status === "blocked")
            .map((task) => task.taskId);
          if (blockedTaskIds.length === 0) {
            throw new DurableWorkflowPlanControllerError(
              "invalid_plan",
              "Blocked workflow result has no durable blocked task.",
            );
          }
          await this.#appendEvent(execution.journal, "run_blocked", {
            blockedTaskIds,
          });
          return withDurablePlanAccounting(
            result,
            blocked,
            execution.agentsSpawned,
          );
        }
        return this.#recordResult(
          execution.journal,
          result,
          result.status === "done" ? "done" : "error",
          undefined,
          execution.agentsSpawned,
        );
      },
    );
    if (finalized !== undefined) return finalized;
    execution.plan = await this.#readCurrentPlan(
      execution.journal,
      await this.#refresh(execution.journal),
    );
    return this.#execute(execution, result.agentsSpawned, result.phases);
  }

  async #ensureDispatchBudget(
    execution: ActiveExecution,
    input: WorkflowPlanTaskDispatch,
  ): Promise<void> {
    let projection = await this.#refresh(execution.journal);
    const pending = pendingWorkflowApproval(projection);
    if (pending !== undefined) {
      execution.awaitingApprovalRequestId = pending.requestId;
      throw new DurableWorkflowPlanControllerError(
        "awaiting_budget",
        `Durable workflow run ${execution.runId} is awaiting trusted approval.`,
      );
    }
    if (execution.budgetTotal === null) return;
    const approvedWindows = projection.approvalRequests.filter(
      (request) =>
        request.approvalKind === "budget" && request.decision === "approved",
    ).length;
    const threshold = execution.budgetTotal * (approvedWindows + 1);
    if (projection.accounting.usage.output < threshold) return;
    const request = await this.requestApproval(execution.runId, {
      approvalKind: "budget",
      description:
        `Output-token budget ${threshold} was exhausted before task ` +
        `${input.task.definition.id}.`,
      denialPolicy: "stop",
      subjectTaskId: input.task.definition.id,
      expectedOwner: this.owner,
      expectedOwnerGeneration: projection.ownerGeneration,
      expectedRunEpoch: projection.runEpoch,
      policy: {
        kind: "output_token_budget",
        budgetTotal: execution.budgetTotal,
        approvedWindows,
        threshold,
        taskId: input.task.definition.id,
        planRevision: projection.plan?.revision ?? 1,
        revisionHash: projection.plan?.revisionHash ?? null,
      },
    });
    projection = await this.#refresh(execution.journal);
    if (
      projection.status !== "awaiting_budget" ||
      pendingWorkflowApproval(projection)?.requestId !== request.requestId
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_approval",
        "Budget approval request lost its pending state.",
      );
    }
    execution.awaitingApprovalRequestId = request.requestId;
    throw new DurableWorkflowPlanControllerError(
      "awaiting_budget",
      `Durable workflow run ${execution.runId} exhausted its budget.`,
    );
  }

  async #operationRequest(
    execution: ActiveExecution,
    input: WorkflowPlanTaskDispatch,
    journal: WorkflowRunOperationJournal,
    fence: WorkflowRunEpochFence,
  ): Promise<WorkflowOperationRequest> {
    const requestSettings = encodeDurableValue({
      prompt: input.request.prompt,
      persona: input.request.persona ?? null,
      model: input.request.model ?? null,
      isolation: input.request.isolation ?? "in-process",
      schema: input.request.schema ?? null,
      thinkingLevel: input.request.thinkingLevel ?? null,
    });
    const identity = createWorkflowOperationIdentity(
      execution.runId,
      ROOT_DEFINITION_PATH,
      input.task.definition.id,
    );
    const existing = await journal.readOperation(fence, identity);
    const definitionDigest =
      existing.request?.definitionDigest ??
      createWorkflowDefinitionDigest(
        encodeDurableValue(input.task.definition).sha256,
      );
    const request = await journal.prepareOperation(fence, {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      identity,
      requestDigest: createWorkflowRequestDigest(requestSettings.sha256),
      definitionDigest,
    });
    await this.#refresh(execution.journal);
    return request;
  }

  async #appendPlanEvent(
    execution: ActiveExecution,
    event: WorkflowPlanEvent,
    schedulerRevision: number,
  ): Promise<void> {
    await this.#serializeManagement(execution.runId, async () => {
      if (execution.interruptionReason !== undefined) return;
      if (event.type === "run_cancelled") {
        execution.onPlanEvent?.(event);
        return;
      }
      const projection = await this.#refresh(execution.journal);
      const taskId = event.taskId;
      const current = projection.taskStates[taskId]?.status ?? "pending";
      const target = planEventTarget(event);
      if (target === "running") {
        if (
          projection.terminal !== undefined ||
          projection.cancellationRequestedEventId !== undefined ||
          projection.status === "interrupted" ||
          execution.cancellation !== undefined
        ) {
          throw operationInterruption(
            execution.interruptionReason ?? "owner_replaced",
          );
        }
        const committedReplay =
          current === "succeeded" &&
          projection.operations.some(
            (operation) =>
              operation.identity.definitionPath === ROOT_DEFINITION_PATH &&
              operation.identity.operationId === taskId &&
              operation.settlement !== undefined,
          );
        if (
          projection.plan?.revision !== schedulerRevision ||
          (current !== "pending" && current !== "running" && !committedReplay)
        ) {
          throw new WorkflowPlanReselectionError(
            `Durable workflow task ${taskId} changed after scheduler selection.`,
          );
        }
      }
      if (
        target === undefined ||
        current === target ||
        isTerminalTaskStatus(current)
      ) {
        return;
      }
      if (
        projection.status === "awaiting_budget" &&
        target === "failed" &&
        pendingWorkflowApproval(projection)?.subjectTaskId === taskId &&
        !projection.operations.some(
          (operation) => operation.identity.operationId === taskId,
        )
      ) {
        return;
      }
      const unsettledAttempt =
        target === "failed"
          ? projection.operations
              .find(
                (operation) =>
                  operation.identity.operationId === taskId &&
                  operation.settlement === undefined,
              )
              ?.attempts.at(-1)
          : undefined;
      if (
        unsettledAttempt?.status === "interrupted" &&
        projection.plan?.revision !== schedulerRevision &&
        execution.cancellation === undefined
      ) {
        throw new WorkflowPlanReselectionError(
          `Durable workflow task ${taskId} became stale before dispatch.`,
        );
      }
      if (unsettledAttempt?.status === "started") return;
      await this.#appendEvent(execution.journal, "task_transitioned", {
        definitionPath: ROOT_DEFINITION_PATH,
        taskId,
        planRevision: projection.plan?.revision ?? 1,
        from: current,
        to: target,
      });
      execution.onPlanEvent?.(event);
    });
  }

  async #reconcileTaskStatuses(
    execution: ActiveExecution,
    result: WorkflowPlanRunResult,
  ): Promise<void> {
    for (const task of result.result) {
      let projection = await this.#refresh(execution.journal);
      const current = projection.taskStates[task.id]?.status ?? "pending";
      if (current === task.status) continue;
      if (isTerminalTaskStatus(current)) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_plan",
          `Durable task ${task.id} conflicts with terminal runner state.`,
        );
      }
      if (task.status === "pending" || task.status === "blocked") continue;
      if (current === "pending" && task.status !== "cancelled") {
        await this.#appendEvent(execution.journal, "task_transitioned", {
          definitionPath: ROOT_DEFINITION_PATH,
          taskId: task.id,
          planRevision: projection.plan?.revision ?? execution.planRevision,
          from: "pending",
          to: "running",
        });
        projection = await this.#refresh(execution.journal);
      }
      const next = projection.taskStates[task.id]?.status ?? "pending";
      if (next === task.status) continue;
      await this.#appendEvent(execution.journal, "task_transitioned", {
        definitionPath: ROOT_DEFINITION_PATH,
        taskId: task.id,
        planRevision: projection.plan?.revision ?? execution.planRevision,
        from: next,
        to: task.status,
      });
    }
  }

  async #repairTerminalGap(
    recovered: DurableWorkflowProjection,
    reason: WorkflowRecoveryReason,
  ): Promise<void> {
    const journal =
      recovered.terminal === undefined
        ? await this.#lease.acquireRun(recovered.runId, reason)
        : await this.#lease.openTerminalMaintenanceRun(recovered.runId);
    let projection = await this.#refresh(journal);
    if (projection.result === undefined) return;
    const resultProjection = projection.result;
    const rawStored = await journal.readOutput(resultProjection.result);
    let terminalStatus: "done" | "error" | "cancelled";
    if (projection.executionKind === "script") {
      const stored = decodeStoredDurableWorkflowScriptResult(rawStored);
      requiredStoredScriptResult(
        stored.result as unknown as DurableValue,
        recovered.runId,
      );
      terminalStatus = stored.terminalStatus;
    } else {
      const stored = requiredStoredPlanResult(rawStored, recovered.runId);
      if (
        stored.status !== "done" &&
        stored.status !== "error" &&
        stored.status !== "cancelled"
      ) {
        return;
      }
      terminalStatus = stored.status;
    }
    if (projection.terminal !== undefined) {
      if (
        projection.terminal.status !== terminalStatus ||
        projection.terminal.resultEventId !== resultProjection.eventId
      ) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_plan",
          "Persisted workflow terminal metadata does not match its result.",
        );
      }
      if ((await journal.readResult()) === undefined) {
        await journal.writeResult({
          terminalEventId: projection.terminal.eventId,
          baseEventByteEndExclusive: (await journal.readEventLog())
            .completeBytes,
          result: resultProjection.result,
        });
      }
      await this.#ensureDeliveryIntent(journal, projection);
      return;
    }
    if (terminalStatus === "cancelled" && projection.status !== "cancelled") {
      if (projection.cancellationRequestedEventId === undefined) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_cancellation",
          "A persisted cancelled result lacks its durable cancellation request.",
        );
      }
      await this.#appendEvent(journal, "run_cancelled", {
        reason: "Recovered cancellation after terminal commit gap.",
        accounting: resultProjection.accounting,
      });
      projection = await this.#refresh(journal);
    }
    const terminal = await this.#appendEvent(journal, "run_terminal", {
      status: terminalStatus,
      accounting: resultProjection.accounting,
      resultEventId: resultProjection.eventId,
    });
    await journal.writeResult({
      terminalEventId: terminal.eventId,
      baseEventByteEndExclusive: terminal.receipt.byteEndExclusive,
      result: resultProjection.result,
    });
    const terminalProjection = await this.#refresh(journal);
    await this.#ensureDeliveryIntent(journal, terminalProjection);
  }

  async #repairHumanDecisionGap(
    recovered: DurableWorkflowProjection,
    reason: WorkflowRecoveryReason,
  ): Promise<void> {
    const journal = await this.#lease.acquireRun(recovered.runId, reason);
    let projection = await this.#refresh(journal);
    projection = await this.#completeDecidedDenials(journal, projection);
    if (
      projection.terminal !== undefined ||
      projection.cancellationRequestedEventId === undefined
    ) {
      return;
    }
    await this.#cancelInactivePlan(
      journal,
      await this.#cancellationReason(journal, projection),
    );
  }

  async #completeDecidedDenials(
    journal: WorkflowRunJournal,
    initial: DurableWorkflowProjection,
  ): Promise<DurableWorkflowProjection> {
    let projection = initial;
    for (const request of projection.approvalRequests) {
      if (request.decision !== "denied") continue;
      if (
        request.trustedActorId === undefined ||
        !isWorkflowIdentifier(request.trustedActorId)
      ) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_approval",
          `Denied approval ${request.requestId} has no trusted actor.`,
        );
      }
      if (request.denialPolicy === "stop") {
        const denialReason =
          `Approval ${request.requestId} was denied by ` +
          `${request.trustedActorId}.`;
        if (projection.cancellationRequestedEventId === undefined) {
          await this.#appendEvent(journal, "run_cancellation_requested", {
            reason: denialReason,
            trustedActorId: request.trustedActorId,
          });
          projection = await this.#refresh(journal);
        }
        if (projection.terminal === undefined) {
          await this.#cancelInactivePlan(journal, denialReason);
          projection = await this.#refresh(journal);
        }
        return projection;
      }
      const subjectTaskId = request.subjectTaskId;
      if (subjectTaskId === null) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_approval",
          "Skip denial requires a bound subject task.",
        );
      }
      const current = projection.taskStates[subjectTaskId]?.status ?? "pending";
      if (!isTerminalTaskStatus(current)) {
        await this.#appendEvent(journal, "task_transitioned", {
          definitionPath: ROOT_DEFINITION_PATH,
          taskId: subjectTaskId,
          planRevision: request.planRevision,
          from: current,
          to: "skipped",
        });
        projection = await this.#refresh(journal);
      }
    }
    return projection;
  }

  async #cancellationReason(
    journal: WorkflowRunJournal,
    projection: DurableWorkflowProjection,
  ): Promise<string> {
    const eventId = projection.cancellationRequestedEventId;
    const request = (await journal.readEvents()).find(
      (event) =>
        event.eventId === eventId &&
        event.type === "run_cancellation_requested",
    );
    if (request?.type !== "run_cancellation_requested") {
      throw new DurableWorkflowPlanControllerError(
        "invalid_cancellation",
        "Persisted workflow cancellation request is missing.",
      );
    }
    return request.payload.reason;
  }

  async #ensureDeliveryIntent(
    journal: WorkflowRunJournal,
    projection: DurableWorkflowProjection,
  ): Promise<{
    readonly projection: DurableWorkflowProjection;
    readonly delivery: DurableWorkflowProjection["deliveries"][number];
    readonly recorded: boolean;
  }> {
    const terminal = projection.terminal;
    if (terminal === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        "A durable delivery intent requires a terminal workflow run.",
      );
    }
    const deliveryId = durableWorkflowDeliveryId(
      projection.owner,
      projection.runId,
      terminal.eventId,
    );
    const existing = projection.deliveries.find(
      (delivery) => delivery.deliveryId === deliveryId,
    );
    if (existing !== undefined) {
      return { projection, delivery: existing, recorded: false };
    }

    const payload = createDurableWorkflowDeliveryPayload(projection);
    const payloadReference = await journal.writeOutput(payload);
    await this.#appendEvent(journal, "delivery_intent_recorded", {
      outboxSchemaVersion: WORKFLOW_OUTBOX_SCHEMA_VERSION,
      deliveryId,
      terminalEventId: terminal.eventId,
      payload: payloadReference,
    });
    const refreshed = await this.#refresh(journal);
    const delivery = refreshed.deliveries.find(
      (candidate) => candidate.deliveryId === deliveryId,
    );
    if (delivery === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow delivery intent was not projected after append.",
      );
    }
    return { projection: refreshed, delivery, recorded: true };
  }

  async #recordResult(
    journal: WorkflowRunJournal,
    result: WorkflowPlanRunResult,
    status: "done" | "error" | "cancelled",
    cancellationReason?: string,
    agentsSpawned = result.agentsSpawned,
  ): Promise<WorkflowPlanRunResult> {
    const projection = await this.#refresh(journal);
    const authoritativeResult = withDurablePlanAccounting(
      result,
      projection,
      agentsSpawned,
    );
    const resultReference = await journal.writeOutput(authoritativeResult);
    const resultEvent = await this.#appendEvent(
      journal,
      "run_result_recorded",
      {
        result: resultReference,
        accounting: projection.accounting,
      },
    );
    if (status === "cancelled") {
      await this.#appendEvent(journal, "run_cancelled", {
        reason: cancellationReason ?? "Cancelled by trusted request.",
        accounting: projection.accounting,
      });
    }
    const terminal = await this.#appendEvent(journal, "run_terminal", {
      status,
      accounting: projection.accounting,
      resultEventId: resultEvent.eventId,
    });
    await journal.writeResult({
      terminalEventId: terminal.eventId,
      baseEventByteEndExclusive: terminal.receipt.byteEndExclusive,
      result: resultReference,
    });
    const terminalProjection = await this.#refresh(journal);
    await this.#ensureDeliveryIntent(journal, terminalProjection);
    if (this.#onDeliveryReady !== undefined) {
      try {
        await this.#onDeliveryReady(journal.runId);
      } catch {
        // The durable pending intent is the retry authority; dispatch failure
        // must not turn a committed terminal workflow into a failed Promise.
      }
    }
    return authoritativeResult;
  }
  async #finishActiveCancellation(
    execution: ActiveExecution,
  ): Promise<WorkflowPlanRunResult> {
    const cancellation = execution.cancellation;
    const completion = execution.completion;
    if (cancellation === undefined || completion === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_active",
        `Durable workflow run ${execution.runId} lost its cancellation continuation.`,
      );
    }
    try {
      await cancellation.persisted;
    } catch (error) {
      const projection = await this.#refresh(execution.journal);
      if (projection.cancellationRequestedEventId === undefined) {
        if (execution.cancellation === cancellation) {
          execution.cancellation = undefined;
        }
        throw error;
      }
    }
    if (!execution.abort.signal.aborted) {
      execution.abort.abort(cancellation.reason);
    }
    try {
      return await completion;
    } catch (error) {
      const projection = await this.#refresh(execution.journal);
      if (projection.terminal?.status === "cancelled") {
        return requiredStoredPlanResult(
          await this.getResult(execution.runId),
          execution.runId,
        );
      }
      if (
        projection.terminal === undefined &&
        projection.cancellationRequestedEventId !== undefined
      ) {
        return this.#cancelInactivePlan(
          execution.journal,
          cancellation.reason,
          execution.agentsSpawned,
        );
      }
      throw error;
    }
  }

  async #persistActiveCancellation(
    execution: ActiveExecution,
    reason: string,
    trustedActorId: string,
  ): Promise<void> {
    await this.#serializeManagement(execution.runId, async () => {
      const projection = await this.#refresh(execution.journal);
      if (projection.cancellationRequestedEventId !== undefined) return;
      await this.#appendEvent(execution.journal, "run_cancellation_requested", {
        reason,
        trustedActorId,
      });
    });
  }

  async #cancelInactivePlan(
    journal: WorkflowRunJournal,
    reason: string,
    agentsSpawned = 0,
  ): Promise<WorkflowPlanRunResult> {
    let projection = await this.#refresh(journal);
    if (projection.terminal !== undefined) {
      if (projection.terminal.status === "cancelled") {
        return requiredStoredPlanResult(
          await this.getResult(journal.runId),
          journal.runId,
        );
      }
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${journal.runId} is already terminal.`,
      );
    }
    const plan =
      projection.plan === undefined
        ? await this.#readLaunchPlan(journal)
        : await this.#readCurrentPlan(journal, projection);
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (attempt?.status !== "started") continue;
      await this.#appendEvent(journal, "attempt_cancelled", {
        attempt: attempt.attempt,
        reason,
      });
    }
    projection = await this.#refresh(journal);
    for (const task of plan.phases.flatMap((phase) => phase.tasks)) {
      const current = projection.taskStates[task.id]?.status ?? "pending";
      if (isTerminalTaskStatus(current)) continue;
      await this.#appendEvent(journal, "task_transitioned", {
        definitionPath: ROOT_DEFINITION_PATH,
        taskId: task.id,
        planRevision: projection.plan?.revision ?? 1,
        from: current,
        to: "cancelled",
      });
      projection = await this.#refresh(journal);
    }
    const result = cancelledPlanResult(plan, projection, reason, agentsSpawned);
    return this.#recordResult(journal, result, "cancelled", reason);
  }

  async #finishInterruption(execution: ActiveExecution): Promise<never> {
    const reason = execution.interruptionReason ?? "owner_replaced";
    let projection = await this.#refresh(execution.journal);
    if (
      projection.terminal === undefined &&
      projection.status !== "interrupted"
    ) {
      await this.#appendEvent(execution.journal, "run_interrupted", { reason });
      projection = await this.#refresh(execution.journal);
    }
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (
        attempt?.status !== "started" ||
        (attempt.dispatchedEventId === undefined &&
          attempt.process === undefined)
      ) {
        continue;
      }
      await this.#appendEvent(execution.journal, "attempt_interrupted", {
        attempt: attempt.attempt,
        reason: "process_exit",
      });
    }
    throw new DurableWorkflowPlanControllerError(
      "interrupted",
      `Durable workflow run ${execution.runId} was interrupted (${reason}).`,
    );
  }

  async #readCurrentPlan(
    journal: WorkflowRunJournal,
    projection: DurableWorkflowProjection,
  ): Promise<WorkflowPlanDefinition> {
    if (projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        `Durable workflow run ${projection.runId} has no plan projection.`,
      );
    }
    const source = await journal.readDefinition(projection.plan.definition);
    const plan = validateDurableWorkflowPlan(
      validateWorkflowPlan(decodeDurableValue(source)),
    );
    if (encodeDurableValue(plan).sha256 !== projection.plan.definitionDigest) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Current workflow plan definition does not match its durable digest.",
      );
    }
    return plan;
  }

  async #planView(
    journal: WorkflowRunJournal,
    projection: DurableWorkflowProjection,
  ): Promise<WorkflowPlanViewProjection> {
    if (projection.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        `Durable workflow run ${projection.runId} has no plan projection.`,
      );
    }
    const plan = await this.#readCurrentPlan(journal, projection);
    const taskStates: Record<string, WorkflowPlanTaskStatus> =
      Object.create(null);
    for (const task of projection.tasks) taskStates[task.taskId] = task.status;
    const view = createWorkflowPlanViewProjection({
      runId: projection.runId,
      owner: projection.owner,
      runEpoch: projection.runEpoch,
      revision: projection.plan.revision,
      revisionHash: projection.plan.revisionHash,
      definitionHash: projection.plan.definitionDigest,
      status: projection.status,
      plan,
      taskStates,
    });
    if (
      view.status === "running" &&
      view.runningTaskIds.length === 0 &&
      view.blockedTaskIds.length > 0 &&
      view.nextTaskIds.length === 0
    ) {
      return Object.freeze({ ...view, status: "blocked" });
    }
    return view;
  }

  async #mutatePlan(
    runId: DurableWorkflowRunId,
    request: WorkflowPlanMutationRequest,
  ): Promise<WorkflowPlanViewProjection> {
    const exactOwner =
      isDurableWorkflowOwner(request.expectedOwner) &&
      durableWorkflowOwnerEquals(request.expectedOwner, this.owner);
    if (!exactOwner) {
      throw new DurableWorkflowPlanControllerError(
        "wrong_owner",
        "Workflow plan mutation owner does not match this controller.",
      );
    }
    if (
      !isDurableWorkflowRunId(runId) ||
      !Number.isSafeInteger(request.expectedRunEpoch) ||
      request.expectedRunEpoch <= 0 ||
      !Number.isSafeInteger(request.baseRevision) ||
      request.baseRevision <= 0 ||
      (request.actor.kind !== "model" && request.actor.kind !== "human") ||
      !isWorkflowIdentifier(request.actor.id)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_mutation",
        "Workflow plan mutation requires an exact epoch, base revision, and actor.",
      );
    }
    const recovered = await this.repository.get(this.owner, runId);
    if (recovered === undefined || recovered.plan === undefined) {
      throw new DurableWorkflowPlanControllerError(
        "run_not_found",
        `Durable workflow plan ${runId} is not recovered.`,
      );
    }
    if (recovered.runEpoch !== request.expectedRunEpoch) {
      throw new DurableWorkflowPlanControllerError(
        "epoch_mismatch",
        `Durable workflow run epoch ${request.expectedRunEpoch} is stale.`,
      );
    }
    if (recovered.plan.revision !== request.baseRevision) {
      throw new DurableWorkflowPlanControllerError(
        "stale_revision",
        `Workflow plan base revision ${request.baseRevision} is stale; current revision is ${recovered.plan.revision}.`,
      );
    }
    if (recovered.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "terminal_run",
        `Durable workflow run ${runId} is already terminal.`,
      );
    }

    const readOnlyJournal = await this.#store.openRun(this.owner, runId);
    const recoveredPlan = await this.#readCurrentPlan(
      readOnlyJournal,
      recovered,
    );
    const recoveredStates: Record<string, WorkflowPlanTaskStatus> =
      Object.create(null);
    for (const task of recovered.tasks) {
      recoveredStates[task.taskId] = task.status;
    }
    applyWorkflowPlanMutation(
      recoveredPlan,
      recoveredStates,
      request.mutation,
      request.actor,
    );

    const active = this.#active.get(runId);
    const journal =
      active?.journal ?? (await this.#lease.acquireRun(runId, "resume"));
    const current = await this.#refresh(journal);
    if (current.plan === undefined || current.terminal !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        current.terminal === undefined ? "invalid_plan" : "terminal_run",
        `Durable workflow run ${runId} cannot accept a plan mutation.`,
      );
    }
    if (pendingWorkflowApproval(current) !== undefined) {
      throw new DurableWorkflowPlanControllerError(
        "awaiting_budget",
        `Durable workflow run ${runId} cannot revise a pending approval fence.`,
      );
    }
    if (active !== undefined && current.runEpoch !== request.expectedRunEpoch) {
      throw new DurableWorkflowPlanControllerError(
        "epoch_mismatch",
        `Durable workflow run epoch ${request.expectedRunEpoch} is stale.`,
      );
    }
    if (current.plan.revision !== request.baseRevision) {
      throw new DurableWorkflowPlanControllerError(
        "stale_revision",
        `Workflow plan base revision ${request.baseRevision} is stale; current revision is ${current.plan.revision}.`,
      );
    }
    const plan = await this.#readCurrentPlan(journal, current);
    const taskStates: Record<string, WorkflowPlanTaskStatus> =
      Object.create(null);
    for (const task of current.tasks) taskStates[task.taskId] = task.status;
    const applied = applyWorkflowPlanMutation(
      plan,
      taskStates,
      request.mutation,
      request.actor,
    );
    const revisedPlan = validateDurableWorkflowPlan(applied.plan);
    const canonical = encodeDurableValue(revisedPlan);
    const definition = await journal.writeDefinition(canonical.json);
    const definitionDigest = createWorkflowDefinitionDigest(canonical.sha256);
    if (definition.sha256 !== definitionDigest) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Revised workflow plan definition does not match its durable digest.",
      );
    }
    const revision = current.plan.revision + 1;
    const revisionHash = createWorkflowSha256Digest(
      encodeDurableValue({
        previousRevisionHash: current.plan.revisionHash,
        revision,
        definitionDigest,
        audit: applied.audit,
      }).sha256,
    );
    await this.#appendEvent(journal, "plan_revised", {
      previousRevision: current.plan.revision,
      revision,
      previousRevisionHash: current.plan.revisionHash,
      revisionHash,
      previousDefinitionDigest: current.plan.definitionDigest,
      definitionDigest,
      definition,
      audit: applied.audit,
    });
    const revised = await this.#refresh(journal);
    if (active !== undefined) {
      active.plan = revisedPlan;
      active.definitionDigest = definitionDigest;
      active.planRevision = revision;
    }
    if (applied.wakeEligible && active !== undefined) {
      this.#deferredPlanWakes.add(runId);
    }
    if (applied.wakeEligible && this.#onPlanMutationWake !== undefined) {
      void Promise.resolve(this.#onPlanMutationWake(runId)).catch((error) => {
        console.error("[subagentura] workflow plan wake failed", error);
      });
    }
    return this.#planView(journal, revised);
  }

  async #wakePlan(runId: DurableWorkflowRunId): Promise<void> {
    if (this.#active.has(runId)) {
      this.#deferredPlanWakes.add(runId);
      return;
    }
    const recovered = await this.repository.get(this.owner, runId);
    if (
      recovered === undefined ||
      recovered.plan === undefined ||
      recovered.terminal !== undefined ||
      recovered.status === "interrupted" ||
      recovered.status === "awaiting_budget" ||
      recovered.cancellationRequestedEventId !== undefined
    ) {
      return;
    }
    const journal = await this.#lease.acquireRun(runId, "resume");
    const projection = await this.#refresh(journal);
    if (
      projection.plan === undefined ||
      projection.terminal !== undefined ||
      projection.status === "interrupted" ||
      projection.status === "awaiting_budget" ||
      projection.cancellationRequestedEventId !== undefined
    ) {
      return;
    }
    if (this.#active.has(runId)) {
      this.#deferredPlanWakes.add(runId);
      return;
    }
    const plan = await this.#readCurrentPlan(journal, projection);
    const execution = this.#newExecution(
      journal,
      plan,
      projection.plan.definitionDigest,
      projection.plan.revision,
      { budgetTotal: this.#readLaunchBudget(journal) },
      new Set(
        projection.tasks
          .filter((task) => task.status === "skipped")
          .map((task) => task.taskId),
      ),
    );
    const started = this.#startExecution(execution);
    void started.completion.catch(() => undefined);
  }

  async #readLaunchPlan(
    journal: WorkflowRunJournal,
  ): Promise<WorkflowPlanDefinition> {
    const launch = journal.readLaunch();
    if (
      !isDurableRecord(launch) ||
      launch.executionKind !== "plan" ||
      !("plan" in launch)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Durable workflow launch is not a plan.",
      );
    }
    return validateDurableWorkflowPlan(
      validateWorkflowPlan(
        decodeDurableValue(encodeDurableValue(launch.plan).json),
      ),
    );
  }

  #readLaunchBudget(journal: WorkflowRunJournal): number | null {
    const launch = journal.readLaunch();
    if (
      !isDurableRecord(launch) ||
      launch.executionKind !== "plan" ||
      !Object.hasOwn(launch, "budgetTotal")
    ) {
      return null;
    }
    if (launch.budgetTotal === null) return null;
    if (
      typeof launch.budgetTotal !== "number" ||
      !Number.isFinite(launch.budgetTotal) ||
      launch.budgetTotal <= 0
    ) {
      throw new DurableWorkflowPlanControllerError(
        "invalid_plan",
        "Persisted durable workflow budget is invalid.",
      );
    }
    return launch.budgetTotal;
  }

  async #refresh(
    journal: WorkflowRunJournal,
  ): Promise<DurableWorkflowProjection> {
    const projection = foldWorkflowRunEvents(await journal.readEvents());
    await this.repository.replace(this.owner, projection);
    return projection;
  }

  async #appendEvent<Type extends WorkflowRunEvent["type"]>(
    journal: WorkflowRunJournal,
    type: Type,
    payload: Extract<WorkflowRunEvent, { type: Type }>["payload"],
    refresh = true,
  ): Promise<{
    readonly eventId: string;
    readonly receipt: WorkflowEventReceipt;
  }> {
    const fence = requiredFence(journal);
    const { event, receipt } = await new WorkflowRunOperationJournal(
      journal,
      this.#generateId,
    ).appendEvent(fence, { type, payload } as WorkflowRunEventDraft<Type>);
    if (refresh) await this.#refresh(journal);
    return { eventId: event.eventId, receipt };
  }

  #serializeManagement<Result>(
    runId: DurableWorkflowRunId,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#managementTails.get(runId) ?? Promise.resolve();
    const operation = previous.then(action, action);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#managementTails.set(runId, tail);
    return operation.finally(() => {
      if (this.#managementTails.get(runId) === tail) {
        this.#managementTails.delete(runId);
      }
    });
  }

  #assertExpectedOwner(expected: DurableWorkflowOwner | undefined): void {
    if (
      expected !== undefined &&
      !durableWorkflowOwnerEquals(expected, this.owner)
    ) {
      throw new DurableWorkflowPlanControllerError(
        "wrong_owner",
        "Durable workflow resume owner does not match this controller.",
      );
    }
  }

  #assertExpectedEpoch(
    projection: DurableWorkflowProjection,
    expected: number | undefined,
  ): void {
    if (expected !== undefined && expected !== projection.runEpoch) {
      throw new DurableWorkflowPlanControllerError(
        "epoch_mismatch",
        `Durable workflow run epoch ${expected} is stale.`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DurableWorkflowPlanControllerError(
        "closed",
        "Durable workflow plan controller is released.",
      );
    }
  }
}

function isDurableRecord(
  value: DurableValue,
): value is { readonly [key: string]: DurableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDurableWorkflowPlan(
  input: WorkflowPlanDefinition,
): WorkflowPlanDefinition {
  const validated = validateWorkflowPlan(input);
  for (const phase of validated.phases) {
    for (const task of phase.tasks) {
      if (
        task.agent?.isolation !== undefined &&
        task.agent.isolation !== "in-process" &&
        task.agent.isolation !== "process"
      ) {
        throw new DurableWorkflowPlanControllerError(
          "invalid_plan",
          `Durable workflow task ${task.id} requests unsupported isolation ${task.agent.isolation}.`,
        );
      }
    }
  }
  const effective = {
    name: validated.name,
    description: validated.description,
    phases: validated.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      mode: phase.mode,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        content: task.content,
        instruction: task.instruction,
        agent: {
          ...task.agent,
          isolation: task.agent?.isolation ?? "in-process",
        },
      })),
    })),
  };
  return validateWorkflowPlan(
    decodeDurableValue(encodeDurableValue(effective).json),
  );
}

function withDurablePlanAccounting(
  result: WorkflowPlanRunResult,
  durable: DurableWorkflowProjection,
  agentsSpawned = result.agentsSpawned,
): WorkflowPlanRunResult {
  const usage = { ...durable.accounting.usage };
  return {
    ...result,
    agentsSpawned,
    errorCount: durable.tasks.filter((task) => task.status === "failed").length,
    tokensSpent: usage.output,
    usage,
  };
}

function cancelledPlanResult(
  plan: WorkflowPlanDefinition,
  durable: DurableWorkflowProjection,
  reason: string,
  agentsSpawned: number,
): WorkflowPlanRunResult {
  const planProjection: WorkflowPlanProjection = {
    definition: plan,
    phases: plan.phases.map((phase) => ({
      definition: phase,
      tasks: phase.tasks.map((task) => {
        const status = durable.taskStates[task.id]?.status ?? "cancelled";
        return {
          definition: task,
          phaseId: phase.id,
          status,
          ...(status === "cancelled" ? { reason } : {}),
        };
      }),
    })),
  };
  const usage = { ...durable.accounting.usage };
  const operationTaskIds = new Set(
    durable.operations.map((operation) => operation.identity.operationId),
  );
  return {
    meta: {
      name: plan.name,
      description: plan.description,
      phases: plan.phases.map((phase) => ({
        title: phase.name,
        detail: phase.id,
      })),
    },
    status: "cancelled",
    result: planProjection.phases.flatMap((phase) =>
      phase.tasks.map((task) => ({
        id: task.definition.id,
        phaseId: task.phaseId,
        content: task.definition.content,
        status: task.status,
        ...(task.status === "cancelled" ? { reason } : {}),
      })),
    ),
    projection: planProjection,
    agentsSpawned,
    errorCount: durable.tasks.filter((task) => task.status === "failed").length,
    tokensSpent: usage.output,
    usage,
    phases: plan.phases
      .filter((phase) =>
        phase.tasks.some((task) => operationTaskIds.has(task.id)),
      )
      .map((phase) => phase.id),
  };
}

function requiredStoredPlanResult(
  value: DurableValue | undefined,
  runId: DurableWorkflowRunId,
): WorkflowPlanRunResult {
  if (
    value === undefined ||
    !isDurableRecord(value) ||
    !Array.isArray(value.result) ||
    !isDurableRecord(value.meta) ||
    !isDurableRecord(value.projection) ||
    !["done", "error", "cancelled", "blocked", "running"].includes(
      String(value.status),
    )
  ) {
    throw new DurableWorkflowPlanControllerError(
      "invalid_plan",
      `Durable workflow run ${runId} has no valid stored plan result.`,
    );
  }
  return value as unknown as WorkflowPlanRunResult;
}

function requiredStoredScriptResult(
  value: DurableValue | undefined,
  runId: DurableWorkflowRunId,
): WorkflowRunResultWithUsage {
  if (
    value === undefined ||
    !isDurableRecord(value) ||
    !Object.hasOwn(value, "result") ||
    !isDurableRecord(value.meta) ||
    !isDurableRecord(value.usage) ||
    !Array.isArray(value.phases) ||
    !value.phases.every((phase) => typeof phase === "string") ||
    typeof value.agentsSpawned !== "number" ||
    typeof value.errorCount !== "number" ||
    typeof value.tokensSpent !== "number"
  ) {
    throw new DurableWorkflowPlanControllerError(
      "invalid_plan",
      `Durable workflow run ${runId} has no valid stored script result.`,
    );
  }
  return value as unknown as WorkflowRunResultWithUsage;
}

function requiredFence(journal: WorkflowRunJournal): WorkflowRunEpochFence {
  if (journal.fence === undefined) {
    throw new DurableWorkflowPlanControllerError(
      "wrong_owner",
      "Durable workflow journal has no current owner fence.",
    );
  }
  return journal.fence;
}

function requiredPlanResult(result: SubagentResult | null): SubagentResult {
  if (result === null) {
    throw new DurableWorkflowPlanControllerError(
      "invalid_plan",
      "Durable plan task returned no agent result.",
    );
  }
  return result;
}

function operationInterruption(
  reason: DurableWorkflowPlanInterruptionReason,
  usage?: Usage,
): WorkflowOperationInterruptedError {
  const attemptReason =
    reason === "process_crash" || reason === "quit"
      ? "process_exit"
      : "owner_replaced";
  return new WorkflowOperationInterruptedError(
    attemptReason,
    `Durable workflow operation interrupted (${reason}).`,
    usage,
  );
}

function planEventTarget(
  event: WorkflowPlanEvent,
): WorkflowPlanTaskStatus | undefined {
  switch (event.type) {
    case "task_started":
      return "running";
    case "task_blocked":
      return "blocked";
    case "task_unblocked":
      return "pending";
    case "task_succeeded":
      return "succeeded";
    case "task_failed":
      return "failed";
    case "task_skipped":
      return "skipped";
    case "task_cancelled":
      return "cancelled";
    case "run_cancelled":
      return undefined;
  }
}

function isTerminalTaskStatus(status: WorkflowPlanTaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  );
}
