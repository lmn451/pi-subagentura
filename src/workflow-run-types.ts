import {
  isWorkflowProcessAttemptIdentity,
  isWorkflowProcessAttemptManifest,
  isWorkflowProcessChildStartedEvidence,
  isWorkflowProcessPaneAssignment,
  isWorkflowProcessTerminalEvidence,
  type WorkflowProcessAttemptIdentity,
  type WorkflowProcessAttemptManifest,
  type WorkflowProcessChildStartedEvidence,
  type WorkflowProcessPaneAssignment,
  type WorkflowProcessTerminalEvidence,
} from "./workflow-process-attempt";

export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_RUN_EVENT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_PROJECTION_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_OUTBOX_SCHEMA_VERSION = 1 as const;

export const DURABLE_WORKFLOW_RUN_ID_PREFIX = "wfr-v1-";
export const ROOT_WORKFLOW_DEFINITION_PATH = "root";
export const MAX_WORKFLOW_IDENTIFIER_LENGTH = 256;
export const MAX_WORKFLOW_DEFINITION_PATH_LENGTH = 4096;
export const MAX_WORKFLOW_DEFINITION_DEPTH = 32;

const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const DURABLE_OWNER_KEYS = ["projectKey", "piSessionKey"] as const;
const LIVE_OWNER_KEYS = [
  "scopeId",
  "generation",
  "leaseToken",
  "runEpoch",
] as const;
const OPERATION_IDENTITY_KEYS = [
  "runId",
  "definitionPath",
  "operationId",
] as const;
const EVENT_RECEIPT_KEYS = [
  "schemaVersion",
  "runId",
  "eventId",
  "runEpoch",
  "byteStart",
  "byteEndExclusive",
  "lineDigest",
] as const;

declare const durableWorkflowRunIdBrand: unique symbol;
declare const workflowDefinitionPathBrand: unique symbol;
declare const workflowSha256DigestBrand: unique symbol;
declare const workflowRequestDigestBrand: unique symbol;
declare const workflowDefinitionDigestBrand: unique symbol;
declare const workflowAttemptIdBrand: unique symbol;
declare const workflowDispatchOrdinalBrand: unique symbol;
declare const workflowResponseOrdinalBrand: unique symbol;
declare const workflowAttemptNumberBrand: unique symbol;

export type DurableWorkflowRunId = string & {
  readonly [durableWorkflowRunIdBrand]: true;
};

export type WorkflowDefinitionPath = string & {
  readonly [workflowDefinitionPathBrand]: true;
};

export type WorkflowSha256Digest = string & {
  readonly [workflowSha256DigestBrand]: true;
};

export type WorkflowRequestDigest = WorkflowSha256Digest & {
  readonly [workflowRequestDigestBrand]: true;
};

export type WorkflowDefinitionDigest = WorkflowSha256Digest & {
  readonly [workflowDefinitionDigestBrand]: true;
};

export type WorkflowAttemptId = string & {
  readonly [workflowAttemptIdBrand]: true;
};

export type WorkflowDispatchOrdinal = number & {
  readonly [workflowDispatchOrdinalBrand]: true;
};

export type WorkflowResponseOrdinal = number & {
  readonly [workflowResponseOrdinalBrand]: true;
};

export type WorkflowAttemptNumber = number & {
  readonly [workflowAttemptNumberBrand]: true;
};

export type WorkflowPlanTaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type DurableWorkflowStatus =
  | "running"
  | "blocked"
  | "awaiting_budget"
  | "interrupted"
  | "done"
  | "error"
  | "cancelled";

export type WorkflowTerminalStatus = Extract<
  DurableWorkflowStatus,
  "done" | "error" | "cancelled"
>;

export type DurableWorkflowResumePolicy =
  "automatic_on_reload_or_resume" | "trusted_resume" | "never";

export interface DurableWorkflowOwner {
  readonly projectKey: string;
  readonly piSessionKey: string;
}

export interface LiveWorkflowOwner {
  readonly scopeId: number;
  readonly generation: number;
  readonly leaseToken: string;
  readonly runEpoch: number;
}

export interface WorkflowNamespaceLeaseFence {
  readonly durableOwner: DurableWorkflowOwner;
  readonly scopeId: number;
  readonly generation: number;
  readonly leaseToken: string;
}

export interface WorkflowRunEpochFence extends WorkflowNamespaceLeaseFence {
  readonly runId: DurableWorkflowRunId;
  readonly runEpoch: number;
}

export interface WorkflowOperationIdentity {
  readonly runId: DurableWorkflowRunId;
  readonly definitionPath: WorkflowDefinitionPath;
  readonly operationId: string;
}

export interface WorkflowDispatchOrdinalIdentity {
  readonly runId: DurableWorkflowRunId;
  readonly definitionPath: WorkflowDefinitionPath;
  readonly dispatchOrdinal: WorkflowDispatchOrdinal;
}

export interface WorkflowResponseOrdinalIdentity {
  readonly runId: DurableWorkflowRunId;
  readonly definitionPath: WorkflowDefinitionPath;
  readonly responseOrdinal: WorkflowResponseOrdinal;
}

export interface WorkflowOperationRequest {
  readonly schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  readonly identity: WorkflowOperationIdentity;
  readonly requestDigest: WorkflowRequestDigest;
  readonly definitionDigest: WorkflowDefinitionDigest;
  readonly dispatchOrdinal: WorkflowDispatchOrdinal;
}

export interface WorkflowOperationAttempt {
  readonly operation: WorkflowOperationIdentity;
  readonly requestDigest: WorkflowRequestDigest;
  readonly definitionDigest: WorkflowDefinitionDigest;
  readonly dispatchOrdinal: WorkflowDispatchOrdinal;
  readonly attemptId: WorkflowAttemptId;
  readonly attemptNumber: WorkflowAttemptNumber;
}

export interface DurableWorkflowUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly costSource?: "provider" | "estimated" | "unavailable" | "mixed";
}

export type WorkflowAccountingLowerBoundReason =
  "provider_work_not_settled" | "ambiguous_dispatch" | "recovery_gap";

export type WorkflowUsageAccounting =
  | {
      readonly completeness: "exact";
      readonly usage: DurableWorkflowUsage;
    }
  | {
      readonly completeness: "lower_bound";
      readonly usage: DurableWorkflowUsage;
      readonly reason: WorkflowAccountingLowerBoundReason;
    };

export interface WorkflowBlobReference {
  readonly sha256: WorkflowSha256Digest;
  readonly sizeBytes: number;
}

export type WorkflowOperationOutcome =
  | {
      readonly status: "succeeded";
      readonly value: WorkflowBlobReference;
    }
  | {
      readonly status: "returned_error";
      readonly error: WorkflowBlobReference;
    }
  | {
      readonly status: "thrown_error";
      readonly error: WorkflowBlobReference;
    }
  | {
      readonly status: "schema_retry_exhausted";
      readonly error: WorkflowBlobReference;
    }
  | {
      readonly status: "cancelled";
      readonly reason: string;
    };

export interface WorkflowEventReceipt {
  readonly schemaVersion: typeof WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION;
  readonly runId: DurableWorkflowRunId;
  readonly eventId: string;
  readonly runEpoch: number;
  readonly byteStart: number;
  readonly byteEndExclusive: number;
  readonly lineDigest: WorkflowSha256Digest;
}

export type ImmutableWorkflowPayload<T> = T extends
  | null
  | undefined
  | string
  | number
  | boolean
  | bigint
  | symbol
  | ((...args: never[]) => unknown)
  ? T
  : T extends readonly (infer Element)[]
    ? readonly ImmutableWorkflowPayload<Element>[]
    : { readonly [Key in keyof T]: ImmutableWorkflowPayload<T[Key]> };

export interface WorkflowRunEventBase<Type extends string, Payload> {
  readonly schemaVersion: typeof WORKFLOW_RUN_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly runId: DurableWorkflowRunId;
  readonly runEpoch: number;
  readonly sequence: number;
  readonly type: Type;
  readonly payload: ImmutableWorkflowPayload<Payload>;
}

export type WorkflowRunCreatedEvent = WorkflowRunEventBase<
  "run_created",
  {
    durableOwner: DurableWorkflowOwner;
    executionKind: "plan" | "script";
    rootDefinitionPath: WorkflowDefinitionPath;
    rootDefinitionDigest: WorkflowDefinitionDigest;
    resumePolicy: DurableWorkflowResumePolicy;
  }
>;

export type WorkflowRunEpochAcquiredEvent = WorkflowRunEventBase<
  "run_epoch_acquired",
  {
    fence: WorkflowRunEpochFence;
    previousRunEpoch: number | null;
    reason: "created" | "reload" | "resume" | "startup" | "stale_takeover";
  }
>;

export type WorkflowDefinitionCapturedEvent = WorkflowRunEventBase<
  "definition_captured",
  | {
      captureKind: "root";
      definitionPath: WorkflowDefinitionPath;
      definitionDigest: WorkflowDefinitionDigest;
      definition: WorkflowBlobReference;
    }
  | {
      captureKind: "nested";
      definitionPath: WorkflowDefinitionPath;
      definitionDigest: WorkflowDefinitionDigest;
      definition: WorkflowBlobReference;
      parentOperation: WorkflowOperationIdentity;
    }
>;

export type WorkflowPlanDefinedEvent = WorkflowRunEventBase<
  "plan_defined",
  {
    revision: number;
    definitionDigest: WorkflowDefinitionDigest;
    definition: WorkflowBlobReference;
  }
>;

export type WorkflowPlanRevisionOperation =
  "append" | "block" | "unblock" | "skip" | "replace_future";

export interface WorkflowPlanRevisionTransition {
  readonly taskId: string;
  readonly from: "pending" | "blocked";
  readonly to: "pending" | "blocked" | "skipped";
  readonly reason?: string;
}

export interface WorkflowPlanRevisionAudit {
  readonly operation: WorkflowPlanRevisionOperation;
  readonly actorKind: "model" | "human";
  readonly actorId: string;
  readonly appendedTaskIds: readonly string[];
  readonly transitions: readonly WorkflowPlanRevisionTransition[];
}

export type WorkflowPlanRevisedEvent = WorkflowRunEventBase<
  "plan_revised",
  {
    previousRevision: number;
    revision: number;
    previousRevisionHash: WorkflowSha256Digest;
    revisionHash: WorkflowSha256Digest;
    previousDefinitionDigest: WorkflowDefinitionDigest;
    definitionDigest: WorkflowDefinitionDigest;
    definition: WorkflowBlobReference;
    audit: WorkflowPlanRevisionAudit;
  }
>;

export type WorkflowOperationPreparedEvent = WorkflowRunEventBase<
  "operation_prepared",
  {
    request: WorkflowOperationRequest;
  }
>;

export type WorkflowOperationDispatchedEvent = WorkflowRunEventBase<
  "operation_dispatched",
  {
    attempt: WorkflowOperationAttempt;
  }
>;

export type WorkflowOperationSettledEvent = WorkflowRunEventBase<
  "operation_settled",
  {
    attempt: WorkflowOperationAttempt;
    outcome: WorkflowOperationOutcome;
    accounting: WorkflowUsageAccounting;
  }
>;

export type WorkflowOperationReplayedEvent = WorkflowRunEventBase<
  "operation_replayed",
  {
    request: WorkflowOperationRequest;
    settledEventId: string;
    responseOrdinal: WorkflowResponseOrdinal;
  }
>;

export type WorkflowAttemptStartedEvent = WorkflowRunEventBase<
  "attempt_started",
  {
    attempt: WorkflowOperationAttempt;
  }
>;

export type WorkflowAttemptUsageObservedEvent = WorkflowRunEventBase<
  "attempt_usage_observed",
  {
    attempt: WorkflowOperationAttempt;
    usageDelta: DurableWorkflowUsage;
  }
>;

export type WorkflowAttemptSettledEvent = WorkflowRunEventBase<
  "attempt_settled",
  {
    attempt: WorkflowOperationAttempt;
    outcome: WorkflowOperationOutcome;
    accounting: WorkflowUsageAccounting;
  }
>;

export type WorkflowAttemptInterruptedEvent = WorkflowRunEventBase<
  "attempt_interrupted",
  {
    attempt: WorkflowOperationAttempt;
    reason: "owner_replaced" | "process_exit" | "recovery";
  }
>;

export type WorkflowAttemptCancelledEvent = WorkflowRunEventBase<
  "attempt_cancelled",
  {
    attempt: WorkflowOperationAttempt;
    reason: string;
  }
>;
export type WorkflowProcessLaunchPreparedEvent = WorkflowRunEventBase<
  "process_launch_prepared",
  {
    manifest: WorkflowProcessAttemptManifest;
  }
>;

export type WorkflowProcessPaneAssignedEvent = WorkflowRunEventBase<
  "process_pane_assigned",
  {
    identity: WorkflowProcessAttemptIdentity;
    assignment: WorkflowProcessPaneAssignment;
  }
>;

export type WorkflowProcessLaunchDispatchedEvent = WorkflowRunEventBase<
  "process_launch_dispatched",
  {
    identity: WorkflowProcessAttemptIdentity;
    assignment: WorkflowProcessPaneAssignment;
  }
>;

export type WorkflowProcessChildStartedEvent = WorkflowRunEventBase<
  "process_child_started",
  {
    evidence: WorkflowProcessChildStartedEvidence;
  }
>;

export type WorkflowProcessTerminalEvent = WorkflowRunEventBase<
  "process_terminal",
  {
    evidence: WorkflowProcessTerminalEvidence;
  }
>;

export type WorkflowProcessAdoptedEvent = WorkflowRunEventBase<
  "process_adopted",
  {
    identity: WorkflowProcessAttemptIdentity;
    evidence: "live" | "terminal";
  }
>;

export type WorkflowProcessFencedEvent = WorkflowRunEventBase<
  "process_fenced",
  {
    identity: WorkflowProcessAttemptIdentity;
    reason:
      | "orphan_before_assignment"
      | "ambiguous_dispatch"
      | "multiple_marker_matches"
      | "stale_evidence";
    assignment?: WorkflowProcessPaneAssignment;
    probeCount: number;
  }
>;

export type WorkflowProcessIsolationResolvedEvent = WorkflowRunEventBase<
  "process_isolation_resolved",
  {
    identity: WorkflowProcessAttemptIdentity;
    effectiveIsolation: "in-process";
    fallbackMode: "process_unavailable";
    fallbackReason: string;
  }
>;

export type WorkflowTaskTransitionedEvent = WorkflowRunEventBase<
  "task_transitioned",
  {
    definitionPath: WorkflowDefinitionPath;
    taskId: string;
    planRevision: number;
    from: WorkflowPlanTaskStatus;
    to: WorkflowPlanTaskStatus;
  }
>;

export type WorkflowResponseReadyEvent = WorkflowRunEventBase<
  "response_ready",
  {
    operation: WorkflowOperationIdentity;
    dispatchOrdinal: WorkflowDispatchOrdinal;
    responseOrdinal: WorkflowResponseOrdinal;
    settlementEventId: string;
  }
>;

export type WorkflowBudgetRequestedEvent = WorkflowRunEventBase<
  "budget_requested",
  {
    budgetRequestId: string;
    approvalKind: "budget" | "plan_gate";
    reason: "agent_limit" | "token_limit" | "cost_limit" | "plan_gate";
    description: string;
    accounting: WorkflowUsageAccounting;
    policyHash: WorkflowSha256Digest;
    planRevision: number;
    ownerGeneration: number;
    runEpoch: number;
    version: number;
    denialPolicy: "stop" | "skip";
    subjectTaskId: string | null;
  }
>;

export type WorkflowBudgetDecidedEvent = WorkflowRunEventBase<
  "budget_decided",
  {
    budgetRequestId: string;
    requestEventId: string;
    decision: "approved" | "denied";
    trustedActorId: string;
    policyHash: WorkflowSha256Digest;
    planRevision: number;
    requestOwnerGeneration: number;
    requestRunEpoch: number;
    ownerGeneration: number;
    runEpoch: number;
    version: number;
  }
>;

export type WorkflowRunBlockedEvent = WorkflowRunEventBase<
  "run_blocked",
  {
    blockedTaskIds: readonly string[];
  }
>;

export type WorkflowRunInterruptedEvent = WorkflowRunEventBase<
  "run_interrupted",
  {
    reason: "reload" | "quit" | "process_crash" | "owner_replaced";
  }
>;

export type WorkflowRunResumedEvent = WorkflowRunEventBase<
  "run_resumed",
  {
    reason: "reload" | "resume" | "trusted_resume";
    trustedActorId?: string;
  }
>;

export type WorkflowRunCancellationRequestedEvent = WorkflowRunEventBase<
  "run_cancellation_requested",
  {
    reason: string;
    trustedActorId: string;
  }
>;

export type WorkflowRunCancelledEvent = WorkflowRunEventBase<
  "run_cancelled",
  {
    reason: string;
    accounting: WorkflowUsageAccounting;
  }
>;

export type WorkflowRunResultRecordedEvent = WorkflowRunEventBase<
  "run_result_recorded",
  {
    result: WorkflowBlobReference;
    accounting: WorkflowUsageAccounting;
  }
>;

export type WorkflowRunTerminalEvent = WorkflowRunEventBase<
  "run_terminal",
  {
    status: WorkflowTerminalStatus;
    accounting: WorkflowUsageAccounting;
    resultEventId?: string;
  }
>;

export type WorkflowDeliveryIntentRecordedEvent = WorkflowRunEventBase<
  "delivery_intent_recorded",
  {
    outboxSchemaVersion: typeof WORKFLOW_OUTBOX_SCHEMA_VERSION;
    deliveryId: string;
    terminalEventId: string;
    payload: WorkflowBlobReference;
  }
>;

export type WorkflowDeliveryReceiptRecordedEvent = WorkflowRunEventBase<
  "delivery_receipt_recorded",
  {
    outboxSchemaVersion: typeof WORKFLOW_OUTBOX_SCHEMA_VERSION;
    deliveryId: string;
    intentEventId: string;
    deliveredBy: string;
  }
>;

export type WorkflowStorageFailureEvent = WorkflowRunEventBase<
  "storage_failure",
  {
    code: "quota_exceeded" | "append_failed" | "sync_failed" | "blob_mismatch";
    diagnostic: string;
    relatedEventId?: string;
  }
>;

export type WorkflowRecoveryFailedEvent = WorkflowRunEventBase<
  "recovery_failed",
  {
    code:
      | "malformed_complete_line"
      | "hash_mismatch"
      | "size_mismatch"
      | "path_mismatch"
      | "fence_lost";
    diagnostic: string;
    byteOffset?: number;
  }
>;

export type WorkflowRunEvent =
  | WorkflowRunCreatedEvent
  | WorkflowRunEpochAcquiredEvent
  | WorkflowDefinitionCapturedEvent
  | WorkflowPlanDefinedEvent
  | WorkflowPlanRevisedEvent
  | WorkflowOperationPreparedEvent
  | WorkflowOperationDispatchedEvent
  | WorkflowOperationSettledEvent
  | WorkflowOperationReplayedEvent
  | WorkflowAttemptStartedEvent
  | WorkflowAttemptUsageObservedEvent
  | WorkflowAttemptSettledEvent
  | WorkflowAttemptInterruptedEvent
  | WorkflowAttemptCancelledEvent
  | WorkflowProcessLaunchPreparedEvent
  | WorkflowProcessPaneAssignedEvent
  | WorkflowProcessLaunchDispatchedEvent
  | WorkflowProcessChildStartedEvent
  | WorkflowProcessTerminalEvent
  | WorkflowProcessAdoptedEvent
  | WorkflowProcessFencedEvent
  | WorkflowProcessIsolationResolvedEvent
  | WorkflowTaskTransitionedEvent
  | WorkflowResponseReadyEvent
  | WorkflowBudgetRequestedEvent
  | WorkflowBudgetDecidedEvent
  | WorkflowRunBlockedEvent
  | WorkflowRunInterruptedEvent
  | WorkflowRunResumedEvent
  | WorkflowRunCancellationRequestedEvent
  | WorkflowRunCancelledEvent
  | WorkflowRunResultRecordedEvent
  | WorkflowRunTerminalEvent
  | WorkflowDeliveryIntentRecordedEvent
  | WorkflowDeliveryReceiptRecordedEvent
  | WorkflowStorageFailureEvent
  | WorkflowRecoveryFailedEvent;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length) return false;
  return keys.every(
    (key) => typeof key === "string" && expectedKeys.includes(key),
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isWorkflowIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WORKFLOW_IDENTIFIER_LENGTH &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    PORTABLE_IDENTIFIER_PATTERN.test(value)
  );
}

export function isWorkflowSha256Digest(
  value: unknown,
): value is WorkflowSha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function createWorkflowSha256Digest(
  value: string,
): WorkflowSha256Digest {
  if (!isWorkflowSha256Digest(value)) {
    throw new TypeError("invalid canonical SHA-256 digest");
  }
  return value;
}

export function createWorkflowRequestDigest(
  value: string,
): WorkflowRequestDigest {
  return createWorkflowSha256Digest(value) as WorkflowRequestDigest;
}

export function createWorkflowDefinitionDigest(
  value: string,
): WorkflowDefinitionDigest {
  return createWorkflowSha256Digest(value) as WorkflowDefinitionDigest;
}

export function isWorkflowAttemptId(
  value: unknown,
): value is WorkflowAttemptId {
  return isWorkflowIdentifier(value);
}

export function createWorkflowAttemptId(value: string): WorkflowAttemptId {
  if (!isWorkflowAttemptId(value)) {
    throw new TypeError("invalid workflow attempt identifier");
  }
  return value;
}

export function isDurableWorkflowRunId(
  value: unknown,
): value is DurableWorkflowRunId {
  if (
    typeof value !== "string" ||
    !value.startsWith(DURABLE_WORKFLOW_RUN_ID_PREFIX)
  ) {
    return false;
  }
  return isWorkflowIdentifier(
    value.slice(DURABLE_WORKFLOW_RUN_ID_PREFIX.length),
  );
}

export function createDurableWorkflowRunId(
  identifier: string,
): DurableWorkflowRunId {
  const value = `${DURABLE_WORKFLOW_RUN_ID_PREFIX}${identifier}`;
  if (!isDurableWorkflowRunId(value)) {
    throw new TypeError("invalid durable workflow run identifier");
  }
  return value;
}

export function isWorkflowDefinitionPath(
  value: unknown,
): value is WorkflowDefinitionPath {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_WORKFLOW_DEFINITION_PATH_LENGTH
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments[0] === ROOT_WORKFLOW_DEFINITION_PATH &&
    segments.length <= MAX_WORKFLOW_DEFINITION_DEPTH + 1 &&
    segments.every((segment) => isWorkflowIdentifier(segment))
  );
}

export function createWorkflowDefinitionPath(
  value: string,
): WorkflowDefinitionPath {
  if (!isWorkflowDefinitionPath(value)) {
    throw new TypeError("invalid canonical workflow definition path");
  }
  return value;
}

export function appendWorkflowDefinitionPath(
  parent: WorkflowDefinitionPath,
  operationId: string,
): WorkflowDefinitionPath {
  if (!isWorkflowDefinitionPath(parent) || !isWorkflowIdentifier(operationId)) {
    throw new TypeError("invalid workflow definition path segment");
  }
  return createWorkflowDefinitionPath(`${parent}/${operationId}`);
}

export function isWorkflowLeaseToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= MAX_WORKFLOW_IDENTIFIER_LENGTH &&
    LEASE_TOKEN_PATTERN.test(value)
  );
}

export function isDurableWorkflowOwner(
  value: unknown,
): value is DurableWorkflowOwner {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, DURABLE_OWNER_KEYS)) return false;
  return (
    isWorkflowSha256Digest(value.projectKey) &&
    isWorkflowIdentifier(value.piSessionKey)
  );
}

export function isLiveWorkflowOwner(
  value: unknown,
): value is LiveWorkflowOwner {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, LIVE_OWNER_KEYS)) return false;
  return (
    isNonNegativeSafeInteger(value.scopeId) &&
    isPositiveSafeInteger(value.generation) &&
    isWorkflowLeaseToken(value.leaseToken) &&
    isPositiveSafeInteger(value.runEpoch)
  );
}

export function durableWorkflowOwnerEquals(
  left: DurableWorkflowOwner,
  right: DurableWorkflowOwner,
): boolean {
  return (
    left.projectKey === right.projectKey &&
    left.piSessionKey === right.piSessionKey
  );
}

export function liveWorkflowOwnerEquals(
  left: LiveWorkflowOwner,
  right: LiveWorkflowOwner,
): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.generation === right.generation &&
    left.leaseToken === right.leaseToken &&
    left.runEpoch === right.runEpoch
  );
}

export function createWorkflowNamespaceLeaseFence(
  durableOwner: DurableWorkflowOwner,
  liveOwner: LiveWorkflowOwner,
): WorkflowNamespaceLeaseFence {
  if (
    !isDurableWorkflowOwner(durableOwner) ||
    !isLiveWorkflowOwner(liveOwner)
  ) {
    throw new TypeError("invalid workflow owner fence");
  }
  return {
    durableOwner,
    scopeId: liveOwner.scopeId,
    generation: liveOwner.generation,
    leaseToken: liveOwner.leaseToken,
  };
}

export function createWorkflowRunEpochFence(
  durableOwner: DurableWorkflowOwner,
  liveOwner: LiveWorkflowOwner,
  runId: DurableWorkflowRunId,
): WorkflowRunEpochFence {
  if (
    !isDurableWorkflowOwner(durableOwner) ||
    !isLiveWorkflowOwner(liveOwner) ||
    !isDurableWorkflowRunId(runId)
  ) {
    throw new TypeError("invalid workflow run epoch fence");
  }
  return {
    durableOwner,
    scopeId: liveOwner.scopeId,
    generation: liveOwner.generation,
    leaseToken: liveOwner.leaseToken,
    runId,
    runEpoch: liveOwner.runEpoch,
  };
}

export function workflowNamespaceLeaseFenceEquals(
  left: WorkflowNamespaceLeaseFence,
  right: WorkflowNamespaceLeaseFence,
): boolean {
  return (
    durableWorkflowOwnerEquals(left.durableOwner, right.durableOwner) &&
    left.scopeId === right.scopeId &&
    left.generation === right.generation &&
    left.leaseToken === right.leaseToken
  );
}

export function workflowRunEpochFenceEquals(
  left: WorkflowRunEpochFence,
  right: WorkflowRunEpochFence,
): boolean {
  return (
    workflowNamespaceLeaseFenceEquals(left, right) &&
    left.runId === right.runId &&
    left.runEpoch === right.runEpoch
  );
}

export function createWorkflowOperationIdentity(
  runId: DurableWorkflowRunId,
  definitionPath: WorkflowDefinitionPath,
  operationId: string,
): WorkflowOperationIdentity {
  if (
    !isDurableWorkflowRunId(runId) ||
    !isWorkflowDefinitionPath(definitionPath) ||
    !isWorkflowIdentifier(operationId)
  ) {
    throw new TypeError("invalid workflow operation identity");
  }
  return { runId, definitionPath, operationId };
}

export function isWorkflowOperationIdentity(
  value: unknown,
): value is WorkflowOperationIdentity {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, OPERATION_IDENTITY_KEYS)) return false;
  return (
    isDurableWorkflowRunId(value.runId) &&
    isWorkflowDefinitionPath(value.definitionPath) &&
    isWorkflowIdentifier(value.operationId)
  );
}

export function workflowOperationIdentityEquals(
  left: WorkflowOperationIdentity,
  right: WorkflowOperationIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.definitionPath === right.definitionPath &&
    left.operationId === right.operationId
  );
}

export function workflowOperationRequestDigestMatches(
  left: WorkflowOperationRequest,
  right: WorkflowOperationRequest,
): boolean {
  return (
    workflowOperationIdentityEquals(left.identity, right.identity) &&
    left.requestDigest === right.requestDigest &&
    left.definitionDigest === right.definitionDigest
  );
}

export function workflowOperationRequestMatches(
  left: WorkflowOperationRequest,
  right: WorkflowOperationRequest,
): boolean {
  return (
    workflowOperationRequestDigestMatches(left, right) &&
    left.dispatchOrdinal === right.dispatchOrdinal
  );
}

export function isWorkflowOrdinal(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

export function createWorkflowDispatchOrdinal(
  value: number,
): WorkflowDispatchOrdinal {
  if (!isWorkflowOrdinal(value)) {
    throw new TypeError(
      "workflow dispatch ordinal must be a positive safe integer",
    );
  }
  return value as WorkflowDispatchOrdinal;
}

export function createWorkflowResponseOrdinal(
  value: number,
): WorkflowResponseOrdinal {
  if (!isWorkflowOrdinal(value)) {
    throw new TypeError(
      "workflow response ordinal must be a positive safe integer",
    );
  }
  return value as WorkflowResponseOrdinal;
}

export function createWorkflowAttemptNumber(
  value: number,
): WorkflowAttemptNumber {
  if (!isWorkflowOrdinal(value)) {
    throw new TypeError(
      "workflow attempt number must be a positive safe integer",
    );
  }
  return value as WorkflowAttemptNumber;
}

export function createWorkflowDispatchOrdinalIdentity(
  runId: DurableWorkflowRunId,
  definitionPath: WorkflowDefinitionPath,
  dispatchOrdinal: WorkflowDispatchOrdinal,
): WorkflowDispatchOrdinalIdentity {
  if (
    !isDurableWorkflowRunId(runId) ||
    !isWorkflowDefinitionPath(definitionPath) ||
    !isWorkflowOrdinal(dispatchOrdinal)
  ) {
    throw new TypeError("invalid workflow dispatch ordinal identity");
  }
  return { runId, definitionPath, dispatchOrdinal };
}

export function createWorkflowResponseOrdinalIdentity(
  runId: DurableWorkflowRunId,
  definitionPath: WorkflowDefinitionPath,
  responseOrdinal: WorkflowResponseOrdinal,
): WorkflowResponseOrdinalIdentity {
  if (
    !isDurableWorkflowRunId(runId) ||
    !isWorkflowDefinitionPath(definitionPath) ||
    !isWorkflowOrdinal(responseOrdinal)
  ) {
    throw new TypeError("invalid workflow response ordinal identity");
  }
  return { runId, definitionPath, responseOrdinal };
}

export function workflowDispatchOrdinalIdentityEquals(
  left: WorkflowDispatchOrdinalIdentity,
  right: WorkflowDispatchOrdinalIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.definitionPath === right.definitionPath &&
    left.dispatchOrdinal === right.dispatchOrdinal
  );
}

export function workflowResponseOrdinalIdentityEquals(
  left: WorkflowResponseOrdinalIdentity,
  right: WorkflowResponseOrdinalIdentity,
): boolean {
  return (
    left.runId === right.runId &&
    left.definitionPath === right.definitionPath &&
    left.responseOrdinal === right.responseOrdinal
  );
}

export function isExactWorkflowAccounting(
  accounting: WorkflowUsageAccounting,
): accounting is Extract<WorkflowUsageAccounting, { completeness: "exact" }> {
  return accounting.completeness === "exact";
}

export function isWorkflowEventReceipt(
  value: unknown,
): value is WorkflowEventReceipt {
  if (!isPlainRecord(value)) return false;
  if (!hasExactKeys(value, EVENT_RECEIPT_KEYS)) return false;
  return (
    value.schemaVersion === WORKFLOW_APPEND_RECEIPT_SCHEMA_VERSION &&
    isDurableWorkflowRunId(value.runId) &&
    isWorkflowIdentifier(value.eventId) &&
    isPositiveSafeInteger(value.runEpoch) &&
    isNonNegativeSafeInteger(value.byteStart) &&
    isNonNegativeSafeInteger(value.byteEndExclusive) &&
    value.byteEndExclusive > value.byteStart &&
    isWorkflowSha256Digest(value.lineDigest)
  );
}

function isWorkflowBlobReference(
  value: unknown,
): value is WorkflowBlobReference {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["sha256", "sizeBytes"]) &&
    isWorkflowSha256Digest(value.sha256) &&
    isNonNegativeSafeInteger(value.sizeBytes)
  );
}

function isWorkflowRunEpochFenceValue(
  value: unknown,
): value is WorkflowRunEpochFence {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "durableOwner",
      "scopeId",
      "generation",
      "leaseToken",
      "runId",
      "runEpoch",
    ]) &&
    isDurableWorkflowOwner(value.durableOwner) &&
    isNonNegativeSafeInteger(value.scopeId) &&
    isPositiveSafeInteger(value.generation) &&
    isWorkflowLeaseToken(value.leaseToken) &&
    isDurableWorkflowRunId(value.runId) &&
    isPositiveSafeInteger(value.runEpoch)
  );
}

function isWorkflowOperationRequestValue(
  value: unknown,
): value is WorkflowOperationRequest {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "identity",
      "requestDigest",
      "definitionDigest",
      "dispatchOrdinal",
    ]) &&
    value.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION &&
    isWorkflowOperationIdentity(value.identity) &&
    isWorkflowSha256Digest(value.requestDigest) &&
    isWorkflowSha256Digest(value.definitionDigest) &&
    isWorkflowOrdinal(value.dispatchOrdinal)
  );
}

function isWorkflowOperationAttemptValue(
  value: unknown,
): value is WorkflowOperationAttempt {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "operation",
      "requestDigest",
      "definitionDigest",
      "dispatchOrdinal",
      "attemptId",
      "attemptNumber",
    ]) &&
    isWorkflowOperationIdentity(value.operation) &&
    isWorkflowSha256Digest(value.requestDigest) &&
    isWorkflowSha256Digest(value.definitionDigest) &&
    isWorkflowOrdinal(value.dispatchOrdinal) &&
    isWorkflowAttemptId(value.attemptId) &&
    isWorkflowOrdinal(value.attemptNumber)
  );
}

function isDurableWorkflowUsageValue(
  value: unknown,
): value is DurableWorkflowUsage {
  if (!isPlainRecord(value)) return false;
  const required = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
    "costUsd",
    "turns",
  ];
  const keys =
    value.costSource === undefined ? required : [...required, "costSource"];
  return (
    hasExactKeys(value, keys) &&
    isNonNegativeSafeInteger(value.input) &&
    isNonNegativeSafeInteger(value.output) &&
    isNonNegativeSafeInteger(value.cacheRead) &&
    isNonNegativeSafeInteger(value.cacheWrite) &&
    isNonNegativeSafeInteger(value.totalTokens) &&
    typeof value.costUsd === "number" &&
    Number.isFinite(value.costUsd) &&
    value.costUsd >= 0 &&
    isNonNegativeSafeInteger(value.turns) &&
    (value.costSource === undefined ||
      value.costSource === "provider" ||
      value.costSource === "estimated" ||
      value.costSource === "unavailable" ||
      value.costSource === "mixed")
  );
}

function isWorkflowUsageAccountingValue(
  value: unknown,
): value is WorkflowUsageAccounting {
  if (!isPlainRecord(value)) return false;
  if (value.completeness === "exact") {
    return (
      hasExactKeys(value, ["completeness", "usage"]) &&
      isDurableWorkflowUsageValue(value.usage)
    );
  }
  return (
    value.completeness === "lower_bound" &&
    hasExactKeys(value, ["completeness", "usage", "reason"]) &&
    isDurableWorkflowUsageValue(value.usage) &&
    (value.reason === "provider_work_not_settled" ||
      value.reason === "ambiguous_dispatch" ||
      value.reason === "recovery_gap")
  );
}

function isWorkflowOperationOutcomeValue(
  value: unknown,
): value is WorkflowOperationOutcome {
  if (!isPlainRecord(value)) return false;
  switch (value.status) {
    case "succeeded":
      return (
        hasExactKeys(value, ["status", "value"]) &&
        isWorkflowBlobReference(value.value)
      );
    case "returned_error":
    case "thrown_error":
    case "schema_retry_exhausted":
      return (
        hasExactKeys(value, ["status", "error"]) &&
        isWorkflowBlobReference(value.error)
      );
    case "cancelled":
      return (
        hasExactKeys(value, ["status", "reason"]) &&
        typeof value.reason === "string"
      );
    default:
      return false;
  }
}

function isWorkflowTaskStatus(value: unknown): value is WorkflowPlanTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "blocked" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "skipped" ||
    value === "cancelled"
  );
}

function isWorkflowPlanRevisionAuditValue(
  value: unknown,
): value is WorkflowPlanRevisionAudit {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "operation",
      "actorKind",
      "actorId",
      "appendedTaskIds",
      "transitions",
    ]) ||
    !["append", "block", "unblock", "skip", "replace_future"].includes(
      String(value.operation),
    ) ||
    (value.actorKind !== "model" && value.actorKind !== "human") ||
    !isWorkflowIdentifier(value.actorId) ||
    !Array.isArray(value.appendedTaskIds) ||
    value.appendedTaskIds.length > 256 ||
    !value.appendedTaskIds.every(isWorkflowIdentifier) ||
    new Set(value.appendedTaskIds).size !== value.appendedTaskIds.length ||
    !Array.isArray(value.transitions) ||
    value.transitions.length > 256
  ) {
    return false;
  }
  const taskIds = new Set<string>();
  for (const transition of value.transitions) {
    if (
      !isPlainRecord(transition) ||
      !hasExactKeys(
        transition,
        transition.reason === undefined
          ? ["taskId", "from", "to"]
          : ["taskId", "from", "to", "reason"],
      ) ||
      !isWorkflowIdentifier(transition.taskId) ||
      (transition.from !== "pending" && transition.from !== "blocked") ||
      !(
        (transition.from === "pending" &&
          (transition.to === "blocked" || transition.to === "skipped")) ||
        (transition.from === "blocked" &&
          (transition.to === "pending" || transition.to === "skipped"))
      ) ||
      (transition.reason !== undefined &&
        (typeof transition.reason !== "string" ||
          transition.reason.length === 0 ||
          transition.reason.length > 4096)) ||
      taskIds.has(transition.taskId)
    ) {
      return false;
    }
    taskIds.add(transition.taskId);
  }
  const transitions =
    value.transitions as unknown as WorkflowPlanRevisionTransition[];
  switch (value.operation) {
    case "append":
      return value.appendedTaskIds.length > 0 && transitions.length === 0;
    case "block":
      return (
        value.appendedTaskIds.length === 0 &&
        transitions.length === 1 &&
        transitions[0]?.from === "pending" &&
        transitions[0].to === "blocked"
      );
    case "unblock":
      return (
        value.appendedTaskIds.length === 0 &&
        transitions.length === 1 &&
        transitions[0]?.from === "blocked" &&
        transitions[0].to === "pending"
      );
    case "skip":
      return (
        value.appendedTaskIds.length === 0 &&
        transitions.length === 1 &&
        transitions[0]?.to === "skipped"
      );
    case "replace_future":
      return value.actorKind === "human";
    default:
      return false;
  }
}

function isWorkflowTerminalStatusValue(
  value: unknown,
): value is WorkflowTerminalStatus {
  return value === "done" || value === "error" || value === "cancelled";
}

function eventOperationBelongsToRun(
  value: WorkflowOperationIdentity,
  runId: DurableWorkflowRunId,
): boolean {
  return value.runId === runId;
}

function eventAttemptBelongsToRun(
  value: WorkflowOperationAttempt,
  runId: DurableWorkflowRunId,
): boolean {
  return value.operation.runId === runId;
}
function processIdentityBelongsToEvent(
  identity: WorkflowProcessAttemptIdentity,
  runId: DurableWorkflowRunId,
  runEpoch: number,
): boolean {
  return (
    identity.runId === runId &&
    identity.runEpoch > 0 &&
    identity.runEpoch <= runEpoch
  );
}

function isWorkflowRunEventPayload(
  type: string,
  payload: unknown,
  runId: DurableWorkflowRunId,
  runEpoch: number,
): boolean {
  if (!isPlainRecord(payload)) return false;
  switch (type) {
    case "run_created":
      return (
        hasExactKeys(payload, [
          "durableOwner",
          "executionKind",
          "rootDefinitionPath",
          "rootDefinitionDigest",
          "resumePolicy",
        ]) &&
        isDurableWorkflowOwner(payload.durableOwner) &&
        (payload.executionKind === "plan" ||
          payload.executionKind === "script") &&
        isWorkflowDefinitionPath(payload.rootDefinitionPath) &&
        isWorkflowSha256Digest(payload.rootDefinitionDigest) &&
        (payload.resumePolicy === "automatic_on_reload_or_resume" ||
          payload.resumePolicy === "trusted_resume" ||
          payload.resumePolicy === "never")
      );
    case "run_epoch_acquired":
      return (
        hasExactKeys(payload, ["fence", "previousRunEpoch", "reason"]) &&
        isWorkflowRunEpochFenceValue(payload.fence) &&
        payload.fence.runId === runId &&
        payload.fence.runEpoch === runEpoch &&
        (payload.previousRunEpoch === null ||
          isPositiveSafeInteger(payload.previousRunEpoch)) &&
        (payload.reason === "created" ||
          payload.reason === "reload" ||
          payload.reason === "resume" ||
          payload.reason === "startup" ||
          payload.reason === "stale_takeover")
      );
    case "definition_captured":
      if (
        payload.captureKind === "root" &&
        hasExactKeys(payload, [
          "captureKind",
          "definitionPath",
          "definitionDigest",
          "definition",
        ])
      ) {
        return (
          isWorkflowDefinitionPath(payload.definitionPath) &&
          isWorkflowSha256Digest(payload.definitionDigest) &&
          isWorkflowBlobReference(payload.definition)
        );
      }
      return (
        payload.captureKind === "nested" &&
        hasExactKeys(payload, [
          "captureKind",
          "definitionPath",
          "definitionDigest",
          "definition",
          "parentOperation",
        ]) &&
        isWorkflowDefinitionPath(payload.definitionPath) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition) &&
        isWorkflowOperationIdentity(payload.parentOperation) &&
        eventOperationBelongsToRun(payload.parentOperation, runId)
      );
    case "plan_defined":
      return (
        hasExactKeys(payload, ["revision", "definitionDigest", "definition"]) &&
        isPositiveSafeInteger(payload.revision) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition)
      );
    case "plan_revised":
      return (
        hasExactKeys(payload, [
          "previousRevision",
          "revision",
          "previousRevisionHash",
          "revisionHash",
          "previousDefinitionDigest",
          "definitionDigest",
          "definition",
          "audit",
        ]) &&
        isPositiveSafeInteger(payload.previousRevision) &&
        isPositiveSafeInteger(payload.revision) &&
        payload.revision === payload.previousRevision + 1 &&
        isWorkflowSha256Digest(payload.previousRevisionHash) &&
        isWorkflowSha256Digest(payload.revisionHash) &&
        payload.revisionHash !== payload.previousRevisionHash &&
        isWorkflowSha256Digest(payload.previousDefinitionDigest) &&
        isWorkflowSha256Digest(payload.definitionDigest) &&
        isWorkflowBlobReference(payload.definition) &&
        isWorkflowPlanRevisionAuditValue(payload.audit)
      );
    case "operation_prepared":
      return (
        hasExactKeys(payload, ["request"]) &&
        isWorkflowOperationRequestValue(payload.request) &&
        eventOperationBelongsToRun(payload.request.identity, runId)
      );
    case "operation_dispatched":
    case "attempt_started":
      return (
        hasExactKeys(payload, ["attempt"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId)
      );
    case "process_launch_prepared":
      return (
        hasExactKeys(payload, ["manifest"]) &&
        isWorkflowProcessAttemptManifest(payload.manifest) &&
        processIdentityBelongsToEvent(
          payload.manifest.identity,
          runId,
          runEpoch,
        )
      );
    case "process_pane_assigned":
    case "process_launch_dispatched":
      return (
        hasExactKeys(payload, ["identity", "assignment"]) &&
        isWorkflowProcessAttemptIdentity(payload.identity) &&
        processIdentityBelongsToEvent(payload.identity, runId, runEpoch) &&
        isWorkflowProcessPaneAssignment(payload.assignment)
      );
    case "process_child_started":
      return (
        hasExactKeys(payload, ["evidence"]) &&
        isWorkflowProcessChildStartedEvidence(payload.evidence) &&
        processIdentityBelongsToEvent(
          payload.evidence.identity,
          runId,
          runEpoch,
        )
      );
    case "process_terminal":
      return (
        hasExactKeys(payload, ["evidence"]) &&
        isWorkflowProcessTerminalEvidence(payload.evidence) &&
        processIdentityBelongsToEvent(
          payload.evidence.identity,
          runId,
          runEpoch,
        )
      );
    case "process_adopted":
      return (
        hasExactKeys(payload, ["identity", "evidence"]) &&
        isWorkflowProcessAttemptIdentity(payload.identity) &&
        processIdentityBelongsToEvent(payload.identity, runId, runEpoch) &&
        (payload.evidence === "live" || payload.evidence === "terminal")
      );
    case "process_fenced": {
      const keys =
        payload.assignment === undefined
          ? ["identity", "reason", "probeCount"]
          : ["identity", "reason", "assignment", "probeCount"];
      return (
        hasExactKeys(payload, keys) &&
        isWorkflowProcessAttemptIdentity(payload.identity) &&
        processIdentityBelongsToEvent(payload.identity, runId, runEpoch) &&
        (payload.reason === "orphan_before_assignment" ||
          payload.reason === "ambiguous_dispatch" ||
          payload.reason === "multiple_marker_matches" ||
          payload.reason === "stale_evidence") &&
        (payload.assignment === undefined ||
          isWorkflowProcessPaneAssignment(payload.assignment)) &&
        isNonNegativeSafeInteger(payload.probeCount)
      );
    }
    case "process_isolation_resolved":
      return (
        hasExactKeys(payload, [
          "identity",
          "effectiveIsolation",
          "fallbackMode",
          "fallbackReason",
        ]) &&
        isWorkflowProcessAttemptIdentity(payload.identity) &&
        processIdentityBelongsToEvent(payload.identity, runId, runEpoch) &&
        payload.effectiveIsolation === "in-process" &&
        payload.fallbackMode === "process_unavailable" &&
        typeof payload.fallbackReason === "string" &&
        payload.fallbackReason.length > 0
      );
    case "operation_settled":
    case "attempt_settled":
      return (
        hasExactKeys(payload, ["attempt", "outcome", "accounting"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        isWorkflowOperationOutcomeValue(payload.outcome) &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "operation_replayed":
      return (
        hasExactKeys(payload, [
          "request",
          "settledEventId",
          "responseOrdinal",
        ]) &&
        isWorkflowOperationRequestValue(payload.request) &&
        eventOperationBelongsToRun(payload.request.identity, runId) &&
        isWorkflowIdentifier(payload.settledEventId) &&
        isWorkflowOrdinal(payload.responseOrdinal)
      );
    case "attempt_usage_observed":
      return (
        hasExactKeys(payload, ["attempt", "usageDelta"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        isDurableWorkflowUsageValue(payload.usageDelta)
      );
    case "attempt_interrupted":
      return (
        hasExactKeys(payload, ["attempt", "reason"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        (payload.reason === "owner_replaced" ||
          payload.reason === "process_exit" ||
          payload.reason === "recovery")
      );
    case "attempt_cancelled":
      return (
        hasExactKeys(payload, ["attempt", "reason"]) &&
        isWorkflowOperationAttemptValue(payload.attempt) &&
        eventAttemptBelongsToRun(payload.attempt, runId) &&
        typeof payload.reason === "string"
      );
    case "task_transitioned":
      return (
        hasExactKeys(payload, [
          "definitionPath",
          "taskId",
          "planRevision",
          "from",
          "to",
        ]) &&
        isWorkflowDefinitionPath(payload.definitionPath) &&
        isWorkflowIdentifier(payload.taskId) &&
        isPositiveSafeInteger(payload.planRevision) &&
        isWorkflowTaskStatus(payload.from) &&
        isWorkflowTaskStatus(payload.to)
      );
    case "response_ready":
      return (
        hasExactKeys(payload, [
          "operation",
          "dispatchOrdinal",
          "responseOrdinal",
          "settlementEventId",
        ]) &&
        isWorkflowOperationIdentity(payload.operation) &&
        eventOperationBelongsToRun(payload.operation, runId) &&
        isWorkflowOrdinal(payload.dispatchOrdinal) &&
        isWorkflowOrdinal(payload.responseOrdinal) &&
        isWorkflowIdentifier(payload.settlementEventId)
      );
    case "budget_requested":
      return (
        hasExactKeys(payload, [
          "budgetRequestId",
          "approvalKind",
          "reason",
          "description",
          "accounting",
          "policyHash",
          "planRevision",
          "ownerGeneration",
          "runEpoch",
          "version",
          "denialPolicy",
          "subjectTaskId",
        ]) &&
        isWorkflowIdentifier(payload.budgetRequestId) &&
        (payload.approvalKind === "budget" ||
          payload.approvalKind === "plan_gate") &&
        (payload.reason === "agent_limit" ||
          payload.reason === "token_limit" ||
          payload.reason === "cost_limit" ||
          payload.reason === "plan_gate") &&
        typeof payload.description === "string" &&
        payload.description.length > 0 &&
        payload.description.length <= 4_096 &&
        (payload.approvalKind === "budget"
          ? payload.reason !== "plan_gate"
          : payload.reason === "plan_gate") &&
        isWorkflowUsageAccountingValue(payload.accounting) &&
        isWorkflowSha256Digest(payload.policyHash) &&
        isPositiveSafeInteger(payload.planRevision) &&
        isPositiveSafeInteger(payload.ownerGeneration) &&
        payload.runEpoch === runEpoch &&
        isPositiveSafeInteger(payload.version) &&
        (payload.denialPolicy === "stop" || payload.denialPolicy === "skip") &&
        (payload.subjectTaskId === null ||
          isWorkflowIdentifier(payload.subjectTaskId))
      );
    case "budget_decided":
      return (
        hasExactKeys(payload, [
          "budgetRequestId",
          "requestEventId",
          "decision",
          "trustedActorId",
          "policyHash",
          "planRevision",
          "requestOwnerGeneration",
          "requestRunEpoch",
          "ownerGeneration",
          "runEpoch",
          "version",
        ]) &&
        isWorkflowIdentifier(payload.budgetRequestId) &&
        isWorkflowIdentifier(payload.requestEventId) &&
        (payload.decision === "approved" || payload.decision === "denied") &&
        isWorkflowIdentifier(payload.trustedActorId) &&
        isWorkflowSha256Digest(payload.policyHash) &&
        isPositiveSafeInteger(payload.planRevision) &&
        isPositiveSafeInteger(payload.requestOwnerGeneration) &&
        isPositiveSafeInteger(payload.requestRunEpoch) &&
        isPositiveSafeInteger(payload.ownerGeneration) &&
        payload.runEpoch === runEpoch &&
        isPositiveSafeInteger(payload.version)
      );
    case "run_blocked":
      return (
        hasExactKeys(payload, ["blockedTaskIds"]) &&
        Array.isArray(payload.blockedTaskIds) &&
        payload.blockedTaskIds.length > 0 &&
        new Set(payload.blockedTaskIds).size ===
          payload.blockedTaskIds.length &&
        payload.blockedTaskIds.every(isWorkflowIdentifier)
      );
    case "run_interrupted":
      return (
        hasExactKeys(payload, ["reason"]) &&
        (payload.reason === "reload" ||
          payload.reason === "quit" ||
          payload.reason === "process_crash" ||
          payload.reason === "owner_replaced")
      );
    case "run_resumed": {
      const keys =
        payload.trustedActorId === undefined
          ? ["reason"]
          : ["reason", "trustedActorId"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.reason === "reload" ||
          payload.reason === "resume" ||
          payload.reason === "trusted_resume") &&
        (payload.trustedActorId === undefined ||
          isWorkflowIdentifier(payload.trustedActorId))
      );
    }
    case "run_cancellation_requested":
      return (
        hasExactKeys(payload, ["reason", "trustedActorId"]) &&
        typeof payload.reason === "string" &&
        isWorkflowIdentifier(payload.trustedActorId)
      );
    case "run_cancelled":
      return (
        hasExactKeys(payload, ["reason", "accounting"]) &&
        typeof payload.reason === "string" &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "run_result_recorded":
      return (
        hasExactKeys(payload, ["result", "accounting"]) &&
        isWorkflowBlobReference(payload.result) &&
        isWorkflowUsageAccountingValue(payload.accounting)
      );
    case "run_terminal": {
      const keys =
        payload.resultEventId === undefined
          ? ["status", "accounting"]
          : ["status", "accounting", "resultEventId"];
      return (
        hasExactKeys(payload, keys) &&
        isWorkflowTerminalStatusValue(payload.status) &&
        isWorkflowUsageAccountingValue(payload.accounting) &&
        (payload.resultEventId === undefined ||
          isWorkflowIdentifier(payload.resultEventId))
      );
    }
    case "delivery_intent_recorded":
      return (
        hasExactKeys(payload, [
          "outboxSchemaVersion",
          "deliveryId",
          "terminalEventId",
          "payload",
        ]) &&
        payload.outboxSchemaVersion === WORKFLOW_OUTBOX_SCHEMA_VERSION &&
        isWorkflowIdentifier(payload.deliveryId) &&
        isWorkflowIdentifier(payload.terminalEventId) &&
        isWorkflowBlobReference(payload.payload)
      );
    case "delivery_receipt_recorded":
      return (
        hasExactKeys(payload, [
          "outboxSchemaVersion",
          "deliveryId",
          "intentEventId",
          "deliveredBy",
        ]) &&
        payload.outboxSchemaVersion === WORKFLOW_OUTBOX_SCHEMA_VERSION &&
        isWorkflowIdentifier(payload.deliveryId) &&
        isWorkflowIdentifier(payload.intentEventId) &&
        isWorkflowIdentifier(payload.deliveredBy)
      );
    case "storage_failure": {
      const keys =
        payload.relatedEventId === undefined
          ? ["code", "diagnostic"]
          : ["code", "diagnostic", "relatedEventId"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.code === "quota_exceeded" ||
          payload.code === "append_failed" ||
          payload.code === "sync_failed" ||
          payload.code === "blob_mismatch") &&
        typeof payload.diagnostic === "string" &&
        (payload.relatedEventId === undefined ||
          isWorkflowIdentifier(payload.relatedEventId))
      );
    }
    case "recovery_failed": {
      const keys =
        payload.byteOffset === undefined
          ? ["code", "diagnostic"]
          : ["code", "diagnostic", "byteOffset"];
      return (
        hasExactKeys(payload, keys) &&
        (payload.code === "malformed_complete_line" ||
          payload.code === "hash_mismatch" ||
          payload.code === "size_mismatch" ||
          payload.code === "path_mismatch" ||
          payload.code === "fence_lost") &&
        typeof payload.diagnostic === "string" &&
        (payload.byteOffset === undefined ||
          isNonNegativeSafeInteger(payload.byteOffset))
      );
    }
    default:
      return false;
  }
}

/**
 * Validate the exact persisted event shape. Complete journal lines that fail
 * this guard are authoritative corruption and must never be skipped.
 */
export function isWorkflowRunEvent(value: unknown): value is WorkflowRunEvent {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "eventId",
      "runId",
      "runEpoch",
      "sequence",
      "type",
      "payload",
    ]) ||
    value.schemaVersion !== WORKFLOW_RUN_EVENT_SCHEMA_VERSION ||
    !isWorkflowIdentifier(value.eventId) ||
    !isDurableWorkflowRunId(value.runId) ||
    !isPositiveSafeInteger(value.runEpoch) ||
    !isPositiveSafeInteger(value.sequence) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  return isWorkflowRunEventPayload(
    value.type,
    value.payload,
    value.runId,
    value.runEpoch,
  );
}
