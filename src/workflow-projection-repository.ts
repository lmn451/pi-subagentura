import {
  workflowProcessAttemptIdentityMatches,
  type WorkflowProcessAttemptIdentity,
  type WorkflowProcessAttemptManifest,
  type WorkflowProcessChildStartedEvidence,
  type WorkflowProcessPaneAssignment,
  type WorkflowProcessTerminalEvidence,
} from "./workflow-process-attempt";

import {
  WORKFLOW_PROJECTION_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  durableWorkflowOwnerEquals,
  appendWorkflowDefinitionPath,
  isDurableWorkflowOwner,
  isWorkflowDefinitionPath,
  isWorkflowIdentifier,
  isWorkflowLeaseToken,
  isWorkflowRunEvent,
  isWorkflowOperationIdentity,
  isWorkflowSha256Digest,
  workflowOperationIdentityEquals,
  workflowOperationRequestMatches,
  type DurableWorkflowOwner,
  type DurableWorkflowResumePolicy,
  type DurableWorkflowRunId,
  type DurableWorkflowStatus,
  type DurableWorkflowUsage,
  type WorkflowBlobReference,
  type WorkflowDefinitionDigest,
  type WorkflowSha256Digest,
  type WorkflowDefinitionPath,
  type WorkflowDispatchOrdinal,
  type WorkflowOperationAttempt,
  type WorkflowOperationIdentity,
  type WorkflowOperationOutcome,
  type WorkflowOperationRequest,
  type WorkflowPlanTaskStatus,
  type WorkflowResponseOrdinal,
  type WorkflowRunEvent,
  type WorkflowUsageAccounting,
} from "./workflow-run-types";

export type WorkflowProjectionFoldErrorCode =
  | "invalid_event_schema"
  | "invalid_sequence"
  | "duplicate_event"
  | "wrong_run"
  | "invalid_epoch"
  | "illegal_transition"
  | "identity_conflict"
  | "invalid_reference"
  | "accounting_mismatch"
  | "terminal_immutable"
  | "result_mismatch";

export class WorkflowProjectionFoldError extends Error {
  readonly code: WorkflowProjectionFoldErrorCode;
  readonly sequence?: number;
  readonly eventId?: string;

  constructor(
    code: WorkflowProjectionFoldErrorCode,
    message: string,
    event?: Partial<Pick<WorkflowRunEvent, "sequence" | "eventId">>,
  ) {
    super(message);
    this.name = "WorkflowProjectionFoldError";
    this.code = code;
    this.sequence = event?.sequence;
    this.eventId = event?.eventId;
  }
}

export interface DurableWorkflowDefinitionProjection {
  readonly definitionPath: WorkflowDefinitionPath;
  readonly definitionDigest: WorkflowDefinitionDigest;
  readonly definition: WorkflowBlobReference;
  readonly captureKind: "root" | "nested";
  readonly eventId: string;
  readonly parentOperation?: WorkflowOperationIdentity;
}

export interface DurableWorkflowPlanProjection {
  readonly revision: number;
  readonly revisionHash: WorkflowSha256Digest;
  readonly definitionDigest: WorkflowDefinitionDigest;
  readonly definition: WorkflowBlobReference;
  readonly eventId: string;
}

export type DurableWorkflowAttemptStatus =
  "started" | "settled" | "interrupted" | "cancelled";

export type DurableWorkflowProcessAttemptStage =
  | "prepared"
  | "pane_assigned"
  | "launch_dispatched"
  | "child_started"
  | "terminal"
  | "adopted"
  | "fenced"
  | "fallback";

export interface DurableWorkflowProcessAttemptProjection {
  readonly manifest: WorkflowProcessAttemptManifest;
  readonly stage: DurableWorkflowProcessAttemptStage;
  readonly launchPreparedEventId: string;
  readonly assignment?: WorkflowProcessPaneAssignment;
  readonly paneAssignedEventId?: string;
  readonly launchDispatchedEventId?: string;
  readonly childStarted?: WorkflowProcessChildStartedEvidence;
  readonly childStartedEventId?: string;
  readonly terminal?: WorkflowProcessTerminalEvidence;
  readonly terminalEventId?: string;
  readonly adoptedEventId?: string;
  readonly adoptedEvidence?: "live" | "terminal";
  readonly fencedEventId?: string;
  readonly fenceReason?:
    | "orphan_before_assignment"
    | "ambiguous_dispatch"
    | "multiple_marker_matches"
    | "stale_evidence";
  readonly probeCount?: number;
  readonly effectiveIsolation: "process" | "in-process";
  readonly fallbackMode: "none" | "process_unavailable";
  readonly fallbackReason?: string;
}

export interface DurableWorkflowAttemptProjection {
  readonly attempt: WorkflowOperationAttempt;
  readonly status: DurableWorkflowAttemptStatus;
  readonly startedEventId: string;
  readonly dispatchedEventId?: string;
  readonly usageObserved: DurableWorkflowUsage;
  readonly usageEventIds: readonly string[];
  readonly settlementEventId?: string;
  readonly interruptionEventId?: string;
  readonly cancellationEventId?: string;
  readonly outcome?: WorkflowOperationOutcome;
  readonly accounting?: WorkflowUsageAccounting;
  readonly process?: DurableWorkflowProcessAttemptProjection;
}

export interface DurableWorkflowOperationSettlement {
  readonly eventId: string;
  readonly attempt: WorkflowOperationAttempt;
  readonly outcome: WorkflowOperationOutcome;
  readonly accounting: WorkflowUsageAccounting;
}

export interface DurableWorkflowOperationReplay {
  readonly eventId: string;
  readonly settledEventId: string;
  readonly responseOrdinal: WorkflowResponseOrdinal;
}

export interface DurableWorkflowResponseProjection {
  readonly eventId: string;
  readonly operation: WorkflowOperationIdentity;
  readonly dispatchOrdinal: WorkflowDispatchOrdinal;
  readonly responseOrdinal: WorkflowResponseOrdinal;
  readonly settlementEventId: string;
}

export interface DurableWorkflowOperationProjection {
  readonly identity: WorkflowOperationIdentity;
  readonly request: WorkflowOperationRequest;
  readonly preparedEventId: string;
  readonly attempts: readonly DurableWorkflowAttemptProjection[];
  readonly nextAttemptNumber: number;
  readonly settlement?: DurableWorkflowOperationSettlement;
  readonly replays: readonly DurableWorkflowOperationReplay[];
  readonly responses: readonly DurableWorkflowResponseProjection[];
}

export interface DurableWorkflowTaskProjection {
  readonly definitionPath: WorkflowDefinitionPath;
  readonly taskId: string;
  readonly planRevision: number;
  readonly status: WorkflowPlanTaskStatus;
  readonly transitionEventIds: readonly string[];
}

export interface DurableWorkflowOrdinalAllocation {
  readonly definitionPath: WorkflowDefinitionPath;
  readonly nextDispatchOrdinal: number;
  readonly nextResponseOrdinal: number;
}

export interface DurableWorkflowApprovalProjection {
  readonly requestId: string;
  readonly budgetRequestId: string;
  readonly requestEventId: string;
  readonly approvalKind: "budget" | "plan_gate";
  readonly reason: "agent_limit" | "token_limit" | "cost_limit" | "plan_gate";
  readonly description: string;
  readonly accounting: WorkflowUsageAccounting;
  readonly policyHash: WorkflowSha256Digest;
  readonly planRevision: number;
  readonly requestOwnerGeneration: number;
  readonly requestRunEpoch: number;
  readonly version: number;
  readonly denialPolicy: "stop" | "skip";
  readonly subjectTaskId: string | null;
  readonly decisionEventId?: string;
  readonly decision?: "approved" | "denied";
  readonly trustedActorId?: string;
}

export interface DurableWorkflowResultProjection {
  readonly eventId: string;
  readonly result: WorkflowBlobReference;
  readonly accounting: WorkflowUsageAccounting;
}

export interface DurableWorkflowTerminalProjection {
  readonly eventId: string;
  readonly status: "done" | "error" | "cancelled";
  readonly accounting: WorkflowUsageAccounting;
  readonly resultEventId?: string;
}
export interface DurableWorkflowDeliveryProjection {
  readonly deliveryId: string;
  readonly intentEventId: string;
  readonly terminalEventId: string;
  readonly payload: WorkflowBlobReference;
  readonly state: "pending" | "delivered";
  readonly receiptEventId?: string;
  readonly deliveredBy?: string;
}

export interface DurableWorkflowFailureProjection {
  readonly eventId?: string;
  readonly source: "journal" | "blob_verification";
  readonly code:
    | "malformed_complete_line"
    | "hash_mismatch"
    | "size_mismatch"
    | "path_mismatch"
    | "fence_lost";
  readonly diagnostic: string;
  readonly byteOffset?: number;
}

export interface DurableWorkflowProjection {
  readonly schemaVersion: typeof WORKFLOW_PROJECTION_SCHEMA_VERSION;
  readonly owner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly executionKind: "plan" | "script";
  readonly resumePolicy: DurableWorkflowResumePolicy;
  readonly rootDefinitionPath: WorkflowDefinitionPath;
  readonly rootDefinitionDigest: WorkflowDefinitionDigest;
  readonly journalStatus: DurableWorkflowStatus;
  readonly status: DurableWorkflowStatus;
  readonly runEpoch: number;
  readonly ownerGeneration: number;
  readonly sequence: number;
  readonly nextSequence: number;
  readonly eventCount: number;
  readonly createdEventId: string;
  readonly lastEventId: string;
  readonly definitions: readonly DurableWorkflowDefinitionProjection[];
  readonly plan?: DurableWorkflowPlanProjection;
  readonly operations: readonly DurableWorkflowOperationProjection[];
  readonly tasks: readonly DurableWorkflowTaskProjection[];
  readonly taskStates: Readonly<Record<string, DurableWorkflowTaskProjection>>;
  readonly ordinalAllocations: readonly DurableWorkflowOrdinalAllocation[];
  readonly responses: readonly DurableWorkflowResponseProjection[];
  readonly approvalRequests: readonly DurableWorkflowApprovalProjection[];
  readonly accounting: WorkflowUsageAccounting;
  readonly result?: DurableWorkflowResultProjection;
  readonly terminal?: DurableWorkflowTerminalProjection;
  readonly deliveries: readonly DurableWorkflowDeliveryProjection[];
  readonly interruptedByEventId?: string;
  readonly cancellationRequestedEventId?: string;
  readonly recoveryFailures: readonly DurableWorkflowFailureProjection[];
  readonly storageFailureEventIds: readonly string[];
}

interface MutableProcessAttempt {
  manifest: WorkflowProcessAttemptManifest;
  stage: DurableWorkflowProcessAttemptStage;
  launchPreparedEventId: string;
  assignment?: WorkflowProcessPaneAssignment;
  paneAssignedEventId?: string;
  launchDispatchedEventId?: string;
  childStarted?: WorkflowProcessChildStartedEvidence;
  childStartedEventId?: string;
  terminal?: WorkflowProcessTerminalEvidence;
  terminalEventId?: string;
  adoptedEventId?: string;
  adoptedEvidence?: "live" | "terminal";
  fencedEventId?: string;
  fenceReason?:
    | "orphan_before_assignment"
    | "ambiguous_dispatch"
    | "multiple_marker_matches"
    | "stale_evidence";
  probeCount?: number;
  effectiveIsolation: "process" | "in-process";
  fallbackMode: "none" | "process_unavailable";
  fallbackReason?: string;
}

interface MutableAttempt {
  attempt: WorkflowOperationAttempt;
  status: DurableWorkflowAttemptStatus;
  startedEventId: string;
  dispatchedEventId?: string;
  usageObserved: DurableWorkflowUsage;
  usageEventIds: string[];
  settlementEventId?: string;
  interruptionEventId?: string;
  cancellationEventId?: string;
  outcome?: WorkflowOperationOutcome;
  accounting?: WorkflowUsageAccounting;
  process?: MutableProcessAttempt;
}

interface MutableOperation {
  identity: WorkflowOperationIdentity;
  request: WorkflowOperationRequest;
  preparedEventId: string;
  attempts: MutableAttempt[];
  settlement?: DurableWorkflowOperationSettlement;
  replays: DurableWorkflowOperationReplay[];
  responses: DurableWorkflowResponseProjection[];
}

interface MutableTask {
  definitionPath: WorkflowDefinitionPath;
  taskId: string;
  planRevision: number;
  status: WorkflowPlanTaskStatus;
  transitionEventIds: string[];
}

const ZERO_USAGE: DurableWorkflowUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
  turns: 0,
});

const TASK_TRANSITIONS = Object.freeze({
  pending: ["running", "blocked", "skipped", "cancelled"],
  blocked: ["pending", "skipped", "cancelled"],
  running: ["succeeded", "failed", "skipped", "cancelled"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
}) satisfies Readonly<
  Record<WorkflowPlanTaskStatus, readonly WorkflowPlanTaskStatus[]>
>;

function fail(
  code: WorkflowProjectionFoldErrorCode,
  message: string,
  event?: Partial<Pick<WorkflowRunEvent, "sequence" | "eventId">>,
): never {
  throw new WorkflowProjectionFoldError(code, message, event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function assertBlob(
  reference: WorkflowBlobReference,
  event: WorkflowRunEvent,
): void {
  if (
    !isRecord(reference) ||
    !isWorkflowSha256Digest(reference.sha256) ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes < 0
  ) {
    fail("invalid_reference", "invalid workflow blob reference", event);
  }
}

function assertUsage(
  usage: DurableWorkflowUsage,
  event: WorkflowRunEvent,
): void {
  if (!isRecord(usage))
    fail("accounting_mismatch", "usage must be an object", event);
  for (const key of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "turns",
  ] as const) {
    if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) {
      fail("accounting_mismatch", `invalid usage field ${key}`, event);
    }
  }
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    fail("accounting_mismatch", "invalid usage field costUsd", event);
  }
  if (
    usage.costSource !== undefined &&
    !["provider", "estimated", "unavailable", "mixed"].includes(
      usage.costSource,
    )
  ) {
    fail("accounting_mismatch", "invalid usage cost source", event);
  }
}

function assertAccounting(
  accounting: WorkflowUsageAccounting,
  event: WorkflowRunEvent,
): void {
  if (
    !isRecord(accounting) ||
    (accounting.completeness !== "exact" &&
      accounting.completeness !== "lower_bound")
  ) {
    fail("accounting_mismatch", "invalid accounting completeness", event);
  }
  assertUsage(accounting.usage, event);
  if (
    accounting.completeness === "lower_bound" &&
    ![
      "provider_work_not_settled",
      "ambiguous_dispatch",
      "recovery_gap",
    ].includes(accounting.reason)
  ) {
    fail("accounting_mismatch", "invalid lower-bound reason", event);
  }
}

function assertOutcome(
  outcome: WorkflowOperationOutcome,
  event: WorkflowRunEvent,
): void {
  if (!isRecord(outcome))
    fail("invalid_event_schema", "outcome must be an object", event);
  switch (outcome.status) {
    case "succeeded":
      assertBlob(outcome.value, event);
      return;
    case "returned_error":
    case "thrown_error":
    case "schema_retry_exhausted":
      assertBlob(outcome.error, event);
      return;
    case "cancelled":
      if (typeof outcome.reason !== "string")
        fail("invalid_event_schema", "missing cancel reason", event);
      return;
    default:
      fail("invalid_event_schema", "invalid outcome", event);
  }
}

function assertRequest(
  request: WorkflowOperationRequest,
  event: WorkflowRunEvent,
): void {
  if (
    !isRecord(request) ||
    request.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION ||
    !isWorkflowOperationIdentity(request.identity) ||
    !isWorkflowSha256Digest(request.requestDigest) ||
    !isWorkflowSha256Digest(request.definitionDigest) ||
    !positiveInteger(request.dispatchOrdinal)
  ) {
    fail("invalid_event_schema", "invalid operation request", event);
  }
}

function assertAttempt(
  attempt: WorkflowOperationAttempt,
  event: WorkflowRunEvent,
): void {
  if (
    !isRecord(attempt) ||
    !isWorkflowOperationIdentity(attempt.operation) ||
    !isWorkflowSha256Digest(attempt.requestDigest) ||
    !isWorkflowSha256Digest(attempt.definitionDigest) ||
    !positiveInteger(attempt.dispatchOrdinal) ||
    !isWorkflowIdentifier(attempt.attemptId) ||
    !positiveInteger(attempt.attemptNumber)
  ) {
    fail("invalid_event_schema", "invalid operation attempt", event);
  }
}

function sameUsage(a: DurableWorkflowUsage, b: DurableWorkflowUsage): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite &&
    a.totalTokens === b.totalTokens &&
    a.costUsd === b.costUsd &&
    a.turns === b.turns &&
    a.costSource === b.costSource
  );
}

function sameAccounting(
  a: WorkflowUsageAccounting,
  b: WorkflowUsageAccounting,
): boolean {
  return (
    a.completeness === b.completeness &&
    sameUsage(a.usage, b.usage) &&
    (a.completeness === "exact" ||
      (b.completeness === "lower_bound" && a.reason === b.reason))
  );
}

function sameBlob(a: WorkflowBlobReference, b: WorkflowBlobReference): boolean {
  return a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;
}

function sameOutcome(
  a: WorkflowOperationOutcome,
  b: WorkflowOperationOutcome,
): boolean {
  if (a.status !== b.status) return false;
  switch (a.status) {
    case "succeeded":
      return b.status === "succeeded" && sameBlob(a.value, b.value);
    case "returned_error":
    case "thrown_error":
    case "schema_retry_exhausted":
      return b.status === a.status && sameBlob(a.error, b.error);
    case "cancelled":
      return b.status === "cancelled" && a.reason === b.reason;
  }
}

function sameAttempt(
  a: WorkflowOperationAttempt,
  b: WorkflowOperationAttempt,
): boolean {
  return (
    workflowOperationIdentityEquals(a.operation, b.operation) &&
    a.requestDigest === b.requestDigest &&
    a.definitionDigest === b.definitionDigest &&
    a.dispatchOrdinal === b.dispatchOrdinal &&
    a.attemptId === b.attemptId &&
    a.attemptNumber === b.attemptNumber
  );
}

function addUsage(
  a: DurableWorkflowUsage,
  b: DurableWorkflowUsage,
): DurableWorkflowUsage {
  const source =
    a.costSource === undefined
      ? b.costSource
      : b.costSource === undefined || a.costSource === b.costSource
        ? a.costSource
        : "mixed";
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
    turns: a.turns + b.turns,
    ...(source === undefined ? {} : { costSource: source }),
  };
}

function operationKey(identity: WorkflowOperationIdentity): string {
  return `${identity.definitionPath}\u0000${identity.operationId}`;
}

function assertAttemptFor(
  attempt: WorkflowOperationAttempt,
  operation: MutableOperation,
  event: WorkflowRunEvent,
): void {
  if (
    !workflowOperationIdentityEquals(attempt.operation, operation.identity) ||
    attempt.requestDigest !== operation.request.requestDigest ||
    attempt.definitionDigest !== operation.request.definitionDigest ||
    attempt.dispatchOrdinal !== operation.request.dispatchOrdinal
  ) {
    fail(
      "identity_conflict",
      "attempt does not match prepared operation",
      event,
    );
  }
}
function assertProcessIdentityFor(
  identity: WorkflowProcessAttemptIdentity,
  attempt: MutableAttempt | undefined,
  event: WorkflowRunEvent,
): asserts attempt is MutableAttempt {
  if (
    attempt === undefined ||
    identity.attemptId !== attempt.attempt.attemptId ||
    identity.attemptNumber !== attempt.attempt.attemptNumber ||
    identity.runId !== attempt.attempt.operation.runId ||
    identity.definitionPath !== attempt.attempt.operation.definitionPath ||
    identity.operationId !== attempt.attempt.operation.operationId ||
    (attempt.process === undefined
      ? identity.runEpoch !== event.runEpoch
      : !workflowProcessAttemptIdentityMatches(
          identity,
          attempt.process.manifest.identity,
        ))
  ) {
    fail(
      "identity_conflict",
      "process evidence does not match its workflow attempt",
      event,
    );
  }
}

function assertEnvelope(event: WorkflowRunEvent, sequence: number): void {
  if (!isWorkflowRunEvent(event)) {
    fail("invalid_event_schema", "invalid event schema", event);
  }
  if (event.sequence !== sequence) {
    fail(
      "invalid_sequence",
      `expected physical sequence ${sequence}, got ${event.sequence}`,
      event,
    );
  }
}

function accountingFor(
  operations: Iterable<MutableOperation>,
  recoveryGap: boolean,
): WorkflowUsageAccounting {
  let usage: DurableWorkflowUsage = ZERO_USAGE;
  let reason:
    | "provider_work_not_settled"
    | "ambiguous_dispatch"
    | "recovery_gap"
    | undefined = recoveryGap ? "recovery_gap" : undefined;
  for (const operation of operations) {
    let settledAccounting = operation.settlement?.accounting;
    if (settledAccounting === undefined) {
      for (let index = operation.attempts.length - 1; index >= 0; index -= 1) {
        const candidate = operation.attempts[index]!.accounting;
        if (candidate !== undefined) {
          settledAccounting = candidate;
          break;
        }
      }
    }
    if (settledAccounting !== undefined) {
      usage = addUsage(usage, settledAccounting.usage);
      if (
        reason === undefined &&
        settledAccounting.completeness === "lower_bound"
      ) {
        reason = settledAccounting.reason;
      }
      continue;
    }
    for (const attempt of operation.attempts) {
      usage = addUsage(usage, attempt.usageObserved);
      if (
        reason === undefined &&
        (attempt.dispatchedEventId !== undefined ||
          attempt.status !== "started" ||
          attempt.usageEventIds.length > 0)
      ) {
        reason =
          attempt.dispatchedEventId === undefined
            ? "provider_work_not_settled"
            : "ambiguous_dispatch";
      }
    }
  }
  return reason === undefined
    ? { completeness: "exact", usage }
    : { completeness: "lower_bound", usage, reason };
}

/** Folds complete lines in physical input order. Wall-clock metadata is never consulted. */
export function foldWorkflowRunEvents(
  events: readonly WorkflowRunEvent[],
): DurableWorkflowProjection {
  if (events.length === 0)
    fail("invalid_event_schema", "event journal is empty");

  const eventIds = new Set<string>();
  const operations = new Map<string, MutableOperation>();
  const attempts = new Map<string, MutableAttempt>();
  const tasks = new Map<string, MutableTask>();
  const definitions = new Map<string, DurableWorkflowDefinitionProjection>();
  const responses: DurableWorkflowResponseProjection[] = [];
  const dispatchOrdinals = new Map<string, number>();
  const responseOrdinals = new Map<string, number>();
  const budgets = new Map<string, DurableWorkflowApprovalProjection>();
  const intents = new Map<string, DurableWorkflowDeliveryProjection>();
  const delivered = new Set<string>();
  const failures: DurableWorkflowFailureProjection[] = [];
  const storageFailures: string[] = [];

  let runId: DurableWorkflowRunId | undefined;
  let owner: DurableWorkflowOwner | undefined;
  let kind: "plan" | "script" | undefined;
  let resumePolicy: DurableWorkflowResumePolicy | undefined;
  let rootPath: WorkflowDefinitionPath | undefined;
  let rootDigest: WorkflowDefinitionDigest | undefined;
  let createdEventId: string | undefined;
  let currentEpoch = 0;
  let acquiredEpoch: number | undefined;
  let currentOwnerGeneration = 0;
  let status: DurableWorkflowStatus = "running";
  let interruptedByEventId: string | undefined;
  let cancellationRequestedEventId: string | undefined;
  let plan: DurableWorkflowPlanProjection | undefined;
  let result: DurableWorkflowResultProjection | undefined;
  let terminal: DurableWorkflowTerminalProjection | undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    assertEnvelope(event, index + 1);
    if (eventIds.has(event.eventId))
      fail("duplicate_event", `duplicate event ${event.eventId}`, event);
    eventIds.add(event.eventId);
    if (index === 0 && event.type !== "run_created") {
      fail("invalid_event_schema", "first event must be run_created", event);
    }
    if (runId !== undefined && event.runId !== runId)
      fail("wrong_run", "mixed run IDs", event);
    if (
      terminal !== undefined &&
      ![
        "delivery_intent_recorded",
        "delivery_receipt_recorded",
        "storage_failure",
        "recovery_failed",
      ].includes(event.type)
    ) {
      fail("terminal_immutable", "terminal run is immutable", event);
    }

    if (event.type === "run_created") {
      if (index !== 0 || createdEventId !== undefined)
        fail("invalid_event_schema", "duplicate run creation", event);
      const payload = event.payload;
      if (
        !isDurableWorkflowOwner(payload.durableOwner) ||
        (payload.executionKind !== "plan" &&
          payload.executionKind !== "script") ||
        !isWorkflowDefinitionPath(payload.rootDefinitionPath) ||
        !isWorkflowSha256Digest(payload.rootDefinitionDigest) ||
        event.runEpoch !== 1 ||
        !["automatic_on_reload_or_resume", "trusted_resume", "never"].includes(
          payload.resumePolicy,
        )
      ) {
        fail("invalid_event_schema", "invalid run creation", event);
      }
      runId = event.runId;
      owner = payload.durableOwner;
      kind = payload.executionKind;
      resumePolicy = payload.resumePolicy;
      rootPath = payload.rootDefinitionPath;
      rootDigest = payload.rootDefinitionDigest;
      createdEventId = event.eventId;
      currentEpoch = event.runEpoch;
      continue;
    }
    if (runId === undefined || owner === undefined)
      fail("invalid_event_schema", "missing run creation", event);

    if (event.type === "run_epoch_acquired") {
      const { fence, previousRunEpoch } = event.payload;
      if (
        !isRecord(fence) ||
        !isDurableWorkflowOwner(fence.durableOwner) ||
        !durableWorkflowOwnerEquals(fence.durableOwner, owner) ||
        fence.runId !== runId ||
        fence.runEpoch !== event.runEpoch ||
        !positiveInteger(fence.scopeId) ||
        !positiveInteger(fence.generation) ||
        !isWorkflowLeaseToken(fence.leaseToken) ||
        !["created", "reload", "resume", "startup", "stale_takeover"].includes(
          event.payload.reason,
        )
      ) {
        fail("invalid_epoch", "epoch fence does not match run", event);
      }
      if (acquiredEpoch === undefined) {
        if (previousRunEpoch !== null || event.runEpoch !== currentEpoch) {
          fail("invalid_epoch", "invalid initial epoch", event);
        }
      } else if (
        previousRunEpoch !== currentEpoch ||
        event.runEpoch !== currentEpoch + 1
      ) {
        fail(
          "invalid_epoch",
          "epochs must increase monotonically by one",
          event,
        );
      }
      acquiredEpoch = event.runEpoch;
      currentOwnerGeneration = fence.generation;
      currentEpoch = event.runEpoch;
      continue;
    }
    if (acquiredEpoch === undefined || event.runEpoch !== currentEpoch) {
      fail("invalid_epoch", "event does not use acquired epoch", event);
    }
    if (
      terminal !== undefined &&
      ![
        "delivery_intent_recorded",
        "delivery_receipt_recorded",
        "storage_failure",
        "recovery_failed",
      ].includes(event.type)
    ) {
      fail(
        "terminal_immutable",
        `cannot ${event.type} after terminalization`,
        event,
      );
    }
    if (
      status !== "running" &&
      [
        "operation_prepared",
        "attempt_started",
        "operation_dispatched",
      ].includes(event.type)
    ) {
      fail(
        "illegal_transition",
        `cannot ${event.type} while run is ${status}`,
        event,
      );
    }

    switch (event.type) {
      case "definition_captured": {
        const p = event.payload;
        if (
          !isWorkflowDefinitionPath(p.definitionPath) ||
          !isWorkflowSha256Digest(p.definitionDigest)
        ) {
          fail("invalid_event_schema", "invalid definition capture", event);
        }
        assertBlob(p.definition, event);
        if (p.definition.sha256 !== p.definitionDigest)
          fail("invalid_reference", "definition digest mismatch", event);
        if (definitions.has(p.definitionPath))
          fail("identity_conflict", "definition path reused", event);
        if (p.captureKind === "root") {
          if (
            p.definitionPath !== rootPath ||
            p.definitionDigest !== rootDigest
          ) {
            fail("identity_conflict", "root definition mismatch", event);
          }
        } else if (p.captureKind === "nested") {
          if (
            !isWorkflowOperationIdentity(p.parentOperation) ||
            p.parentOperation.runId !== runId ||
            !definitions.has(p.parentOperation.definitionPath) ||
            appendWorkflowDefinitionPath(
              p.parentOperation.definitionPath,
              p.parentOperation.operationId,
            ) !== p.definitionPath
          ) {
            fail(
              "identity_conflict",
              "unknown nested definition parent",
              event,
            );
          }
        } else fail("invalid_event_schema", "invalid capture kind", event);
        definitions.set(p.definitionPath, {
          definitionPath: p.definitionPath,
          definitionDigest: p.definitionDigest,
          definition: p.definition,
          captureKind: p.captureKind,
          eventId: event.eventId,
          ...(p.captureKind === "nested"
            ? { parentOperation: p.parentOperation }
            : {}),
        });
        break;
      }
      case "plan_defined": {
        const p = event.payload;
        if (
          plan !== undefined ||
          kind !== "plan" ||
          !positiveInteger(p.revision) ||
          !isWorkflowSha256Digest(p.definitionDigest)
        ) {
          fail("illegal_transition", "invalid initial plan", event);
        }
        assertBlob(p.definition, event);
        if (p.definition.sha256 !== p.definitionDigest)
          fail("invalid_reference", "plan digest mismatch", event);
        plan = {
          revision: p.revision,
          revisionHash: p.definitionDigest,
          definitionDigest: p.definitionDigest,
          definition: p.definition,
          eventId: event.eventId,
        };
        break;
      }
      case "plan_revised": {
        const p = event.payload;
        if (
          plan === undefined ||
          rootPath === undefined ||
          p.previousRevision !== plan.revision ||
          p.revision !== plan.revision + 1 ||
          p.previousRevisionHash !== plan.revisionHash ||
          p.revisionHash === plan.revisionHash ||
          p.previousDefinitionDigest !== plan.definitionDigest ||
          !isWorkflowSha256Digest(p.definitionDigest)
        ) {
          fail("illegal_transition", "invalid plan revision", event);
        }
        assertBlob(p.definition, event);
        if (p.definition.sha256 !== p.definitionDigest)
          fail("invalid_reference", "plan digest mismatch", event);
        for (const taskId of p.audit.appendedTaskIds) {
          if (tasks.has(taskId)) {
            fail(
              "identity_conflict",
              `stable task ID ${taskId} was already materialized`,
              event,
            );
          }
          tasks.set(taskId, {
            definitionPath: rootPath,
            taskId,
            planRevision: p.revision,
            status: "pending",
            transitionEventIds: [event.eventId],
          });
        }
        for (const transition of p.audit.transitions) {
          const current = tasks.get(transition.taskId);
          const currentStatus = current?.status ?? "pending";
          if (currentStatus !== transition.from) {
            fail(
              "illegal_transition",
              `plan mutation expected ${transition.taskId} to be ${transition.from}`,
              event,
            );
          }
          if (current === undefined) {
            tasks.set(transition.taskId, {
              definitionPath: rootPath,
              taskId: transition.taskId,
              planRevision: p.revision,
              status: transition.to,
              transitionEventIds: [event.eventId],
            });
          } else {
            current.planRevision = p.revision;
            current.status = transition.to;
            current.transitionEventIds.push(event.eventId);
          }
        }
        plan = {
          revision: p.revision,
          revisionHash: p.revisionHash,
          definitionDigest: p.definitionDigest,
          definition: p.definition,
          eventId: event.eventId,
        };
        if (
          status === "blocked" &&
          (p.audit.appendedTaskIds.length > 0 ||
            p.audit.transitions.some(
              (transition) => transition.to !== "blocked",
            ))
        ) {
          status = "running";
        }
        break;
      }
      case "operation_prepared": {
        const request = event.payload.request;
        assertRequest(request, event);
        if (request.identity.runId !== runId)
          fail("wrong_run", "operation uses another run", event);
        const key = operationKey(request.identity);
        const prior = operations.get(key);
        if (prior !== undefined) {
          if (!workflowOperationRequestMatches(prior.request, request)) {
            fail(
              "identity_conflict",
              "operation ID reused with another digest",
              event,
            );
          }
          break;
        }
        const priorOrdinal =
          dispatchOrdinals.get(request.identity.definitionPath) ?? 0;
        if (request.dispatchOrdinal !== priorOrdinal + 1) {
          fail("invalid_sequence", "dispatch ordinal is not next", event);
        }
        dispatchOrdinals.set(
          request.identity.definitionPath,
          request.dispatchOrdinal,
        );
        operations.set(key, {
          identity: request.identity,
          request,
          preparedEventId: event.eventId,
          attempts: [],
          replays: [],
          responses: [],
        });
        break;
      }
      case "attempt_started": {
        const attempt = event.payload.attempt;
        assertAttempt(attempt, event);
        const operation = operations.get(operationKey(attempt.operation));
        if (operation === undefined)
          fail("illegal_transition", "attempt before operation", event);
        assertAttemptFor(attempt, operation, event);
        if (operation.settlement !== undefined)
          fail("terminal_immutable", "settled operation retried", event);
        if (attempts.has(attempt.attemptId))
          fail("identity_conflict", "attempt ID reused", event);
        if (operation.attempts.at(-1)?.status === "started")
          fail("illegal_transition", "attempt already active", event);
        if (attempt.attemptNumber !== operation.attempts.length + 1)
          fail("invalid_sequence", "attempt number is not next", event);
        const mutable: MutableAttempt = {
          attempt,
          status: "started",
          startedEventId: event.eventId,
          usageObserved: ZERO_USAGE,
          usageEventIds: [],
        };
        operation.attempts.push(mutable);
        attempts.set(attempt.attemptId, mutable);
        break;
      }
      case "operation_dispatched": {
        const attempt = event.payload.attempt;
        assertAttempt(attempt, event);
        const current = attempts.get(attempt.attemptId);
        if (
          current === undefined ||
          current.status !== "started" ||
          !sameAttempt(current.attempt, attempt) ||
          current.dispatchedEventId !== undefined
        ) {
          fail(
            "illegal_transition",
            "dispatch does not match active attempt",
            event,
          );
        }
        current.dispatchedEventId = event.eventId;
        break;
      }
      case "process_launch_prepared": {
        const manifest = event.payload.manifest;
        const current = attempts.get(manifest.identity.attemptId);
        assertProcessIdentityFor(manifest.identity, current, event);
        if (current.process !== undefined || current.status !== "started") {
          fail("illegal_transition", "process launch prepared twice", event);
        }
        current.process = {
          manifest,
          stage: "prepared",
          launchPreparedEventId: event.eventId,
          effectiveIsolation: manifest.effectiveIsolation,
          fallbackMode: manifest.fallbackMode,
          ...(manifest.fallbackReason === undefined
            ? {}
            : { fallbackReason: manifest.fallbackReason }),
        };
        break;
      }
      case "process_pane_assigned": {
        const { identity, assignment } = event.payload;
        const current = attempts.get(identity.attemptId);
        assertProcessIdentityFor(identity, current, event);
        if (
          current.process === undefined ||
          current.process.assignment !== undefined ||
          current.process.fencedEventId !== undefined ||
          current.process.effectiveIsolation !== "process"
        ) {
          fail("illegal_transition", "invalid process pane assignment", event);
        }
        current.process.assignment = assignment;
        current.process.paneAssignedEventId = event.eventId;
        current.process.stage = "pane_assigned";
        break;
      }
      case "process_launch_dispatched": {
        const { identity, assignment } = event.payload;
        const current = attempts.get(identity.attemptId);
        assertProcessIdentityFor(identity, current, event);
        if (
          current.process === undefined ||
          current.process.assignment === undefined ||
          JSON.stringify(current.process.assignment) !==
            JSON.stringify(assignment) ||
          current.process.launchDispatchedEventId !== undefined ||
          current.process.fencedEventId !== undefined
        ) {
          fail("illegal_transition", "invalid process launch dispatch", event);
        }
        current.process.launchDispatchedEventId = event.eventId;
        current.process.stage = "launch_dispatched";
        break;
      }
      case "process_child_started": {
        const evidence = event.payload.evidence;
        const current = attempts.get(evidence.identity.attemptId);
        assertProcessIdentityFor(evidence.identity, current, event);
        if (
          current.process === undefined ||
          current.process.launchDispatchedEventId === undefined ||
          current.process.childStartedEventId !== undefined ||
          current.process.fencedEventId !== undefined ||
          evidence.launchMarker !== current.process.manifest.launchMarker
        ) {
          fail("illegal_transition", "invalid process child handshake", event);
        }
        current.process.childStarted = evidence;
        current.process.childStartedEventId = event.eventId;
        current.process.stage = "child_started";
        break;
      }
      case "process_terminal": {
        const evidence = event.payload.evidence;
        const current = attempts.get(evidence.identity.attemptId);
        assertProcessIdentityFor(evidence.identity, current, event);
        if (
          current.process === undefined ||
          current.process.launchDispatchedEventId === undefined ||
          current.process.terminalEventId !== undefined ||
          current.process.fencedEventId !== undefined
        ) {
          fail(
            "illegal_transition",
            "invalid process terminal evidence",
            event,
          );
        }
        current.process.terminal = evidence;
        current.process.terminalEventId = event.eventId;
        current.process.stage = "terminal";
        break;
      }
      case "process_adopted": {
        const { identity, evidence } = event.payload;
        const current = attempts.get(identity.attemptId);
        assertProcessIdentityFor(identity, current, event);
        if (
          current.process === undefined ||
          current.process.adoptedEventId !== undefined ||
          current.process.fencedEventId !== undefined ||
          current.process.launchDispatchedEventId === undefined ||
          (evidence === "terminal" &&
            current.process.terminalEventId === undefined)
        ) {
          fail("illegal_transition", "invalid process adoption", event);
        }
        current.process.adoptedEventId = event.eventId;
        current.process.adoptedEvidence = evidence;
        current.process.stage = "adopted";
        break;
      }
      case "process_fenced": {
        const { identity, reason, probeCount } = event.payload;
        const current = attempts.get(identity.attemptId);
        assertProcessIdentityFor(identity, current, event);
        if (
          current.process === undefined ||
          current.process.fencedEventId !== undefined ||
          current.process.adoptedEventId !== undefined ||
          current.process.terminalEventId !== undefined
        ) {
          fail("illegal_transition", "invalid process fence", event);
        }
        current.process.fencedEventId = event.eventId;
        current.process.fenceReason = reason;
        current.process.probeCount = probeCount;
        current.process.stage = "fenced";
        break;
      }
      case "process_isolation_resolved": {
        const { identity, fallbackReason } = event.payload;
        const current = attempts.get(identity.attemptId);
        assertProcessIdentityFor(identity, current, event);
        if (
          current.process === undefined ||
          current.process.assignment !== undefined ||
          current.process.fallbackMode !== "none"
        ) {
          fail(
            "illegal_transition",
            "process fallback resolved too late",
            event,
          );
        }
        current.process.effectiveIsolation = "in-process";
        current.process.fallbackMode = "process_unavailable";
        current.process.fallbackReason = fallbackReason;
        current.process.stage = "fallback";
        break;
      }

      case "attempt_usage_observed": {
        const { attempt, usageDelta } = event.payload;
        assertAttempt(attempt, event);
        assertUsage(usageDelta, event);
        const current = attempts.get(attempt.attemptId);
        if (
          current === undefined ||
          current.status !== "started" ||
          !sameAttempt(current.attempt, attempt)
        ) {
          fail(
            "illegal_transition",
            "usage does not match active attempt",
            event,
          );
        }
        current.usageObserved = addUsage(current.usageObserved, usageDelta);
        current.usageEventIds.push(event.eventId);
        break;
      }
      case "attempt_settled": {
        const { attempt, outcome, accounting } = event.payload;
        assertAttempt(attempt, event);
        assertOutcome(outcome, event);
        assertAccounting(accounting, event);
        const current = attempts.get(attempt.attemptId);
        if (
          current === undefined ||
          current.status !== "started" ||
          !sameAttempt(current.attempt, attempt)
        ) {
          fail(
            "illegal_transition",
            "settlement does not match active attempt",
            event,
          );
        }
        current.status = "settled";
        current.settlementEventId = event.eventId;
        current.outcome = outcome;
        current.accounting = accounting;
        break;
      }
      case "attempt_interrupted":
      case "attempt_cancelled": {
        const attempt = event.payload.attempt;
        assertAttempt(attempt, event);
        const current = attempts.get(attempt.attemptId);
        if (
          current === undefined ||
          current.status !== "started" ||
          !sameAttempt(current.attempt, attempt)
        ) {
          fail(
            "illegal_transition",
            "attempt finalization does not match",
            event,
          );
        }
        if (event.type === "attempt_interrupted") {
          current.status = "interrupted";
          current.interruptionEventId = event.eventId;
        } else {
          current.status = "cancelled";
          current.cancellationEventId = event.eventId;
        }
        break;
      }
      case "operation_settled": {
        const { attempt, outcome, accounting } = event.payload;
        assertAttempt(attempt, event);
        assertOutcome(outcome, event);
        assertAccounting(accounting, event);
        const operation = operations.get(operationKey(attempt.operation));
        const current = attempts.get(attempt.attemptId);
        if (
          operation === undefined ||
          current === undefined ||
          current.status !== "settled" ||
          current.outcome === undefined ||
          current.accounting === undefined ||
          !sameAttempt(current.attempt, attempt)
        ) {
          fail("illegal_transition", "operation settled before attempt", event);
        }
        if (operation.settlement !== undefined)
          fail("terminal_immutable", "operation settled twice", event);
        if (
          !sameOutcome(current.outcome, outcome) ||
          !sameAccounting(current.accounting, accounting)
        ) {
          fail(
            "accounting_mismatch",
            "operation and attempt settlement differ",
            event,
          );
        }
        operation.settlement = {
          eventId: event.eventId,
          attempt,
          outcome,
          accounting,
        };
        break;
      }
      case "operation_replayed": {
        const { request, settledEventId, responseOrdinal } = event.payload;
        assertRequest(request, event);
        const operation = operations.get(operationKey(request.identity));
        if (
          operation === undefined ||
          operation.settlement === undefined ||
          !workflowOperationRequestMatches(operation.request, request) ||
          operation.settlement.eventId !== settledEventId ||
          !positiveInteger(responseOrdinal)
        ) {
          fail(
            "identity_conflict",
            "replay does not match committed operation",
            event,
          );
        }
        operation.replays.push({
          eventId: event.eventId,
          settledEventId,
          responseOrdinal,
        });
        break;
      }
      case "response_ready": {
        const p = event.payload;
        if (
          !isWorkflowOperationIdentity(p.operation) ||
          !positiveInteger(p.dispatchOrdinal) ||
          !positiveInteger(p.responseOrdinal)
        ) {
          fail("invalid_event_schema", "invalid ready response", event);
        }
        const operation = operations.get(operationKey(p.operation));
        if (
          operation === undefined ||
          operation.settlement === undefined ||
          operation.request.dispatchOrdinal !== p.dispatchOrdinal ||
          operation.settlement.eventId !== p.settlementEventId
        ) {
          fail(
            "identity_conflict",
            "response does not match settlement",
            event,
          );
        }
        const previous = responseOrdinals.get(p.operation.definitionPath) ?? 0;
        if (p.responseOrdinal !== previous + 1)
          fail("invalid_sequence", "response ordinal is not next", event);
        responseOrdinals.set(p.operation.definitionPath, p.responseOrdinal);
        const response: DurableWorkflowResponseProjection = {
          eventId: event.eventId,
          operation: p.operation,
          dispatchOrdinal: p.dispatchOrdinal,
          responseOrdinal: p.responseOrdinal,
          settlementEventId: p.settlementEventId,
        };
        responses.push(response);
        operation.responses.push(response);
        break;
      }
      case "task_transitioned": {
        const p = event.payload;
        if (
          !isWorkflowDefinitionPath(p.definitionPath) ||
          !isWorkflowIdentifier(p.taskId) ||
          !positiveInteger(p.planRevision) ||
          !Object.hasOwn(TASK_TRANSITIONS, p.from) ||
          !Object.hasOwn(TASK_TRANSITIONS, p.to) ||
          plan === undefined ||
          p.planRevision !== plan.revision
        ) {
          fail("invalid_event_schema", "invalid task transition", event);
        }
        const current = tasks.get(p.taskId);
        if (
          current !== undefined &&
          current.definitionPath !== p.definitionPath
        ) {
          fail(
            "identity_conflict",
            "stable task ID reused in another definition",
            event,
          );
        }
        const currentStatus = current?.status ?? "pending";
        if (
          p.from !== currentStatus ||
          !(
            TASK_TRANSITIONS[currentStatus] as readonly WorkflowPlanTaskStatus[]
          ).includes(p.to)
        ) {
          fail(
            "illegal_transition",
            `illegal task transition ${p.from} -> ${p.to}`,
            event,
          );
        }
        if (current === undefined) {
          tasks.set(p.taskId, {
            definitionPath: p.definitionPath,
            taskId: p.taskId,
            planRevision: p.planRevision,
            status: p.to,
            transitionEventIds: [event.eventId],
          });
        } else {
          current.planRevision = p.planRevision;
          current.status = p.to;
          current.transitionEventIds.push(event.eventId);
        }
        break;
      }
      case "budget_requested": {
        const p = event.payload;
        const pending = [...budgets.values()].some(
          (request) => request.decision === undefined,
        );
        if (
          !isWorkflowIdentifier(p.budgetRequestId) ||
          budgets.has(p.budgetRequestId) ||
          pending
        ) {
          fail(
            "identity_conflict",
            "approval request identity is not unique",
            event,
          );
        }
        if (
          status !== "running" ||
          kind !== "plan" ||
          plan === undefined ||
          p.planRevision !== plan.revision ||
          p.ownerGeneration !== currentOwnerGeneration ||
          p.runEpoch !== currentEpoch
        ) {
          fail(
            "illegal_transition",
            `cannot request approval while run is ${status}`,
            event,
          );
        }
        assertAccounting(p.accounting, event);
        if (
          !sameAccounting(
            p.accounting,
            accountingFor(operations.values(), false),
          )
        ) {
          fail("accounting_mismatch", "approval accounting is stale", event);
        }
        budgets.set(p.budgetRequestId, {
          requestId: p.budgetRequestId,
          budgetRequestId: p.budgetRequestId,
          requestEventId: event.eventId,
          approvalKind: p.approvalKind,
          reason: p.reason,
          accounting: p.accounting,
          policyHash: p.policyHash,
          planRevision: p.planRevision,
          description: p.description,
          requestOwnerGeneration: p.ownerGeneration,
          requestRunEpoch: p.runEpoch,
          version: p.version,
          denialPolicy: p.denialPolicy,
          subjectTaskId: p.subjectTaskId,
        });
        status = "awaiting_budget";
        break;
      }
      case "budget_decided": {
        const p = event.payload;
        const request = budgets.get(p.budgetRequestId);
        if (
          request === undefined ||
          request.requestEventId !== p.requestEventId ||
          request.decision !== undefined ||
          request.policyHash !== p.policyHash ||
          plan === undefined ||
          plan.revision !== p.planRevision ||
          request.planRevision !== p.planRevision ||
          request.requestOwnerGeneration !== p.requestOwnerGeneration ||
          request.requestRunEpoch !== p.requestRunEpoch ||
          request.version !== p.version ||
          p.ownerGeneration !== currentOwnerGeneration ||
          p.runEpoch !== currentEpoch ||
          (p.decision !== "approved" && p.decision !== "denied") ||
          !isWorkflowIdentifier(p.trustedActorId) ||
          status !== "awaiting_budget"
        ) {
          fail(
            "illegal_transition",
            "approval decision does not match the pending request fence",
            event,
          );
        }
        budgets.set(p.budgetRequestId, {
          ...request,
          decision: p.decision,
          decisionEventId: event.eventId,
          trustedActorId: p.trustedActorId,
        });
        status = "running";
        break;
      }
      case "run_blocked": {
        const blockedTaskIds = [...event.payload.blockedTaskIds];
        const projectedBlocked = [...tasks.values()]
          .filter((task) => task.status === "blocked")
          .map((task) => task.taskId)
          .sort();
        if (
          status !== "running" ||
          blockedTaskIds.length !== projectedBlocked.length ||
          blockedTaskIds.sort().some((taskId, index) => {
            return taskId !== projectedBlocked[index];
          }) ||
          [...attempts.values()].some((attempt) => attempt.status === "started")
        ) {
          fail(
            "illegal_transition",
            "blocked run does not match its durable task/attempt state",
            event,
          );
        }
        status = "blocked";
        break;
      }
      case "run_interrupted":
        if (
          !["reload", "quit", "process_crash", "owner_replaced"].includes(
            event.payload.reason,
          )
        ) {
          fail("invalid_event_schema", "invalid interruption reason", event);
        }
        if (!["running", "blocked", "awaiting_budget"].includes(status)) {
          fail("illegal_transition", `cannot interrupt ${status}`, event);
        }
        status = "interrupted";
        interruptedByEventId = event.eventId;
        break;
      case "run_resumed":
        if (status !== "interrupted")
          fail("illegal_transition", "only interrupted run resumes", event);
        if (
          event.payload.reason === "trusted_resume" &&
          !isWorkflowIdentifier(event.payload.trustedActorId)
        ) {
          fail("invalid_event_schema", "trusted resume needs actor", event);
        }
        if (
          !["trusted_resume", "reload", "resume"].includes(event.payload.reason)
        ) {
          fail("invalid_event_schema", "invalid resume reason", event);
        }
        if (
          event.payload.reason === "trusted_resume"
            ? resumePolicy === "never"
            : resumePolicy !== "automatic_on_reload_or_resume"
        ) {
          fail(
            "illegal_transition",
            "resume reason is not allowed by persisted policy",
            event,
          );
        }
        status = "running";
        interruptedByEventId = undefined;
        break;
      case "run_cancellation_requested":
        if (cancellationRequestedEventId !== undefined)
          fail("illegal_transition", "cancellation already requested", event);
        if (!isWorkflowIdentifier(event.payload.trustedActorId))
          fail("invalid_event_schema", "cancellation needs actor", event);
        cancellationRequestedEventId = event.eventId;
        break;
      case "run_cancelled":
        assertAccounting(event.payload.accounting, event);
        if (cancellationRequestedEventId === undefined)
          fail("illegal_transition", "cancellation not requested", event);
        status = "cancelled";
        break;
      case "run_result_recorded":
        if (result !== undefined)
          fail("terminal_immutable", "result recorded twice", event);
        assertBlob(event.payload.result, event);
        assertAccounting(event.payload.accounting, event);
        result = {
          eventId: event.eventId,
          result: event.payload.result,
          accounting: event.payload.accounting,
        };
        break;
      case "run_terminal": {
        const p = event.payload;
        assertAccounting(p.accounting, event);
        if (!["done", "error", "cancelled"].includes(p.status))
          fail("invalid_event_schema", "invalid terminal status", event);
        if (p.status === "done") {
          if (result === undefined || p.resultEventId !== result.eventId) {
            fail(
              "result_mismatch",
              "done terminal must reference result",
              event,
            );
          }
          for (const task of tasks.values()) {
            if (task.status !== "succeeded" && task.status !== "skipped") {
              fail(
                "illegal_transition",
                "done run contains unfinished task",
                event,
              );
            }
          }
        } else if (
          p.resultEventId !== undefined &&
          p.resultEventId !== result?.eventId
        ) {
          fail("result_mismatch", "unknown terminal result", event);
        }
        if (p.status === "cancelled" && status !== "cancelled") {
          fail(
            "illegal_transition",
            "cancelled terminal lacks run cancellation",
            event,
          );
        }
        const aggregate = accountingFor(operations.values(), false);
        if (
          !sameAccounting(p.accounting, aggregate) ||
          (result !== undefined &&
            !sameAccounting(result.accounting, p.accounting))
        ) {
          fail(
            "accounting_mismatch",
            "terminal accounting differs from durable attempts",
            event,
          );
        }
        terminal = {
          eventId: event.eventId,
          status: p.status,
          accounting: p.accounting,
          ...(p.resultEventId === undefined
            ? {}
            : { resultEventId: p.resultEventId }),
        };
        status = p.status;
        break;
      }
      case "delivery_intent_recorded":
        if (
          terminal === undefined ||
          event.payload.terminalEventId !== terminal.eventId ||
          !isWorkflowIdentifier(event.payload.deliveryId) ||
          intents.has(event.payload.deliveryId)
        ) {
          fail(
            "illegal_transition",
            "delivery intent does not match terminal",
            event,
          );
        }
        assertBlob(event.payload.payload, event);
        intents.set(event.payload.deliveryId, {
          deliveryId: event.payload.deliveryId,
          intentEventId: event.eventId,
          terminalEventId: event.payload.terminalEventId,
          payload: event.payload.payload,
          state: "pending",
        });
        break;
      case "delivery_receipt_recorded": {
        const intent = intents.get(event.payload.deliveryId);
        if (
          intent === undefined ||
          intent.intentEventId !== event.payload.intentEventId ||
          delivered.has(event.payload.deliveryId) ||
          !isWorkflowIdentifier(event.payload.deliveredBy)
        ) {
          fail(
            "illegal_transition",
            "delivery receipt does not match intent",
            event,
          );
        }
        intents.set(event.payload.deliveryId, {
          ...intent,
          state: "delivered",
          receiptEventId: event.eventId,
          deliveredBy: event.payload.deliveredBy,
        });
        delivered.add(event.payload.deliveryId);
        break;
      }
      case "storage_failure":
        storageFailures.push(event.eventId);
        break;
      case "recovery_failed":
        if (
          ![
            "malformed_complete_line",
            "hash_mismatch",
            "size_mismatch",
            "path_mismatch",
            "fence_lost",
          ].includes(event.payload.code)
        ) {
          fail("invalid_event_schema", "invalid recovery failure", event);
        }
        failures.push({
          eventId: event.eventId,
          source: "journal",
          code: event.payload.code,
          diagnostic: event.payload.diagnostic,
          ...(event.payload.byteOffset === undefined
            ? {}
            : { byteOffset: event.payload.byteOffset }),
        });
        break;
    }
  }

  if (
    runId === undefined ||
    owner === undefined ||
    kind === undefined ||
    resumePolicy === undefined ||
    rootPath === undefined ||
    rootDigest === undefined ||
    createdEventId === undefined ||
    acquiredEpoch === undefined
  ) {
    fail("invalid_event_schema", "journal lacks acquired run epoch");
  }

  const operationProjections = [...operations.values()].map(
    (operation): DurableWorkflowOperationProjection =>
      Object.freeze({
        identity: operation.identity,
        request: operation.request,
        preparedEventId: operation.preparedEventId,
        attempts: Object.freeze(
          operation.attempts.map((attempt) =>
            Object.freeze({
              ...attempt,
              usageObserved: Object.freeze({ ...attempt.usageObserved }),
              usageEventIds: Object.freeze([...attempt.usageEventIds]),
              ...(attempt.process === undefined
                ? {}
                : {
                    process: Object.freeze({
                      ...attempt.process,
                      manifest: Object.freeze({
                        ...attempt.process.manifest,
                        identity: Object.freeze({
                          ...attempt.process.manifest.identity,
                        }),
                      }),
                      ...(attempt.process.assignment === undefined
                        ? {}
                        : {
                            assignment: Object.freeze({
                              ...attempt.process.assignment,
                            }),
                          }),
                      ...(attempt.process.childStarted === undefined
                        ? {}
                        : {
                            childStarted: Object.freeze({
                              ...attempt.process.childStarted,
                              identity: Object.freeze({
                                ...attempt.process.childStarted.identity,
                              }),
                            }),
                          }),
                      ...(attempt.process.terminal === undefined
                        ? {}
                        : {
                            terminal: Object.freeze({
                              ...attempt.process.terminal,
                              identity: Object.freeze({
                                ...attempt.process.terminal.identity,
                              }),
                            }),
                          }),
                    }),
                  }),
            }),
          ),
        ),
        nextAttemptNumber: operation.attempts.length + 1,
        ...(operation.settlement === undefined
          ? {}
          : { settlement: Object.freeze({ ...operation.settlement }) }),
        replays: Object.freeze([...operation.replays]),
        responses: Object.freeze([...operation.responses]),
      }),
  );
  const taskProjections = [...tasks.values()].map(
    (task): DurableWorkflowTaskProjection =>
      Object.freeze({
        definitionPath: task.definitionPath,
        taskId: task.taskId,
        planRevision: task.planRevision,
        status: task.status,
        transitionEventIds: Object.freeze([...task.transitionEventIds]),
      }),
  );
  const taskStates = Object.create(null) as Record<
    string,
    DurableWorkflowTaskProjection
  >;
  for (const task of taskProjections) taskStates[task.taskId] = task;
  Object.freeze(taskStates);
  const paths = new Set([
    rootPath,
    ...dispatchOrdinals.keys(),
    ...responseOrdinals.keys(),
  ]);
  const ordinalAllocations = [...paths].map(
    (path): DurableWorkflowOrdinalAllocation =>
      Object.freeze({
        definitionPath: path as WorkflowDefinitionPath,
        nextDispatchOrdinal: (dispatchOrdinals.get(path) ?? 0) + 1,
        nextResponseOrdinal: (responseOrdinals.get(path) ?? 0) + 1,
      }),
  );
  const accounting = accountingFor(operations.values(), false);

  return Object.freeze({
    schemaVersion: WORKFLOW_PROJECTION_SCHEMA_VERSION,
    owner,
    runId,
    executionKind: kind,
    resumePolicy,
    rootDefinitionPath: rootPath,
    rootDefinitionDigest: rootDigest,
    journalStatus: status,
    status,
    runEpoch: currentEpoch,
    ownerGeneration: currentOwnerGeneration,
    sequence: events.length,
    nextSequence: events.length + 1,
    eventCount: events.length,
    createdEventId,
    lastEventId: events.at(-1)!.eventId,
    definitions: Object.freeze([...definitions.values()]),
    ...(plan === undefined ? {} : { plan: Object.freeze({ ...plan }) }),
    operations: Object.freeze(operationProjections),
    tasks: Object.freeze(taskProjections),
    taskStates,
    ordinalAllocations: Object.freeze(ordinalAllocations),
    responses: Object.freeze([...responses]),
    approvalRequests: Object.freeze([...budgets.values()]),
    accounting: Object.freeze({
      ...accounting,
      usage: Object.freeze({ ...accounting.usage }),
    }) as WorkflowUsageAccounting,
    ...(result === undefined ? {} : { result: Object.freeze({ ...result }) }),
    ...(terminal === undefined
      ? {}
      : { terminal: Object.freeze({ ...terminal }) }),
    deliveries: Object.freeze(
      [...intents.values()].map((delivery) =>
        Object.freeze({
          ...delivery,
          payload: Object.freeze({ ...delivery.payload }),
        }),
      ),
    ),
    ...(interruptedByEventId === undefined ? {} : { interruptedByEventId }),
    ...(cancellationRequestedEventId === undefined
      ? {}
      : { cancellationRequestedEventId }),
    recoveryFailures: Object.freeze([...failures]),
    storageFailureEventIds: Object.freeze([...storageFailures]),
  });
}

function ownerKey(owner: DurableWorkflowOwner): string {
  return `${owner.projectKey}\u0000${owner.piSessionKey}`;
}

export interface WorkflowProjectionRepository {
  get(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<DurableWorkflowProjection | undefined>;
  list(
    owner: DurableWorkflowOwner,
  ): Promise<readonly DurableWorkflowProjection[]>;
  replace(
    owner: DurableWorkflowOwner,
    projection: DurableWorkflowProjection,
  ): Promise<void>;
  replaceAll(
    owner: DurableWorkflowOwner,
    projections: readonly DurableWorkflowProjection[],
  ): Promise<void>;
  remove(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<void>;
}

/** Disposable process-local storage; authoritative events always live elsewhere. */
export class InMemoryWorkflowProjectionRepository implements WorkflowProjectionRepository {
  readonly #owners = new Map<
    string,
    Map<DurableWorkflowRunId, DurableWorkflowProjection>
  >();

  async get(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<DurableWorkflowProjection | undefined> {
    return this.#owners.get(ownerKey(owner))?.get(runId);
  }

  async list(
    owner: DurableWorkflowOwner,
  ): Promise<readonly DurableWorkflowProjection[]> {
    return [...(this.#owners.get(ownerKey(owner))?.values() ?? [])];
  }

  async replace(
    owner: DurableWorkflowOwner,
    projection: DurableWorkflowProjection,
  ): Promise<void> {
    if (!durableWorkflowOwnerEquals(owner, projection.owner)) {
      throw new Error("projection owner does not match repository namespace");
    }
    const key = ownerKey(owner);
    let runs = this.#owners.get(key);
    if (runs === undefined) {
      runs = new Map();
      this.#owners.set(key, runs);
    }
    runs.set(projection.runId, projection);
  }

  async replaceAll(
    owner: DurableWorkflowOwner,
    projections: readonly DurableWorkflowProjection[],
  ): Promise<void> {
    const replacement = new Map<
      DurableWorkflowRunId,
      DurableWorkflowProjection
    >();
    for (const projection of projections) {
      if (!durableWorkflowOwnerEquals(owner, projection.owner)) {
        throw new Error("projection owner does not match repository namespace");
      }
      if (replacement.has(projection.runId))
        throw new Error(`duplicate projection for ${projection.runId}`);
      replacement.set(projection.runId, projection);
    }
    this.#owners.set(ownerKey(owner), replacement);
  }

  async remove(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<void> {
    this.#owners.get(ownerKey(owner))?.delete(runId);
  }
}
