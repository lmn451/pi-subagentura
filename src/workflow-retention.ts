import {
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowRunEvent,
} from "./workflow-run-types";
import { type DurableWorkflowProjection } from "./workflow-projection-repository";

type WorkflowDeliveryIntentEvent = Extract<
  WorkflowRunEvent,
  { readonly type: "delivery_intent_recorded" }
>;
type WorkflowDeliveryReceiptEvent = Extract<
  WorkflowRunEvent,
  { readonly type: "delivery_receipt_recorded" }
>;

export interface WorkflowRetentionPolicy {
  readonly minimumAgeMs: number;
  readonly minimumRunsPerOwner: number;
  readonly maxPrunesPerPass: number;
}

export type WorkflowRetentionPolicyOptions = Partial<WorkflowRetentionPolicy>;

export const DEFAULT_WORKFLOW_RETENTION_POLICY: Readonly<WorkflowRetentionPolicy> =
  Object.freeze({
    minimumAgeMs: 30 * 24 * 60 * 60 * 1000,
    minimumRunsPerOwner: 16,
    maxPrunesPerPass: 32,
  });

export type WorkflowRetentionProtectionReason =
  | "nonterminal"
  | "durable_result_missing"
  | "undelivered"
  | "storage_failure"
  | "recovery_failure"
  | "too_young"
  | "authoritative_corruption"
  | "pass_limit"
  | "owner_minimum_runs";

interface WorkflowRetentionClassificationBase {
  readonly owner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly runEpoch: number;
  readonly lastActivityMs: number;
}

export interface WorkflowRetentionCandidate extends WorkflowRetentionClassificationBase {
  readonly eligible: true;
  readonly terminalEventId: string;
  readonly resultEventId: string;
  readonly deliveryReceiptEventId: string;
  readonly policy: WorkflowRetentionPolicy;
}

export interface WorkflowRetentionProtected extends WorkflowRetentionClassificationBase {
  readonly eligible: false;
  readonly reason: WorkflowRetentionProtectionReason;
}

export type WorkflowRetentionClassification =
  WorkflowRetentionCandidate | WorkflowRetentionProtected;

export interface WorkflowRetentionEvidence {
  readonly projection: DurableWorkflowProjection;
  readonly events: readonly WorkflowRunEvent[];
  /** True only after the immutable result record and referenced blob verify. */
  readonly durableResultMatches: boolean;
  readonly lastActivityMs: number;
  readonly ownerRunCount: number;
  readonly nowMs: number;
}

export function resolveWorkflowRetentionPolicy(
  options: WorkflowRetentionPolicyOptions = {},
): WorkflowRetentionPolicy {
  const policy: WorkflowRetentionPolicy = {
    ...DEFAULT_WORKFLOW_RETENTION_POLICY,
    ...options,
  };
  if (!Number.isSafeInteger(policy.minimumAgeMs) || policy.minimumAgeMs < 0) {
    throw new TypeError("minimumAgeMs must be a non-negative safe integer.");
  }
  if (
    !Number.isSafeInteger(policy.minimumRunsPerOwner) ||
    policy.minimumRunsPerOwner < 0
  ) {
    throw new TypeError(
      "minimumRunsPerOwner must be a non-negative safe integer.",
    );
  }
  if (
    !Number.isSafeInteger(policy.maxPrunesPerPass) ||
    policy.maxPrunesPerPass <= 0
  ) {
    throw new TypeError("maxPrunesPerPass must be a positive safe integer.");
  }
  return Object.freeze(policy);
}

export function classifyWorkflowRunRetention(
  evidence: WorkflowRetentionEvidence,
  options: WorkflowRetentionPolicyOptions = {},
): WorkflowRetentionClassification {
  const policy = resolveWorkflowRetentionPolicy(options);
  const { projection } = evidence;
  const base: WorkflowRetentionClassificationBase = {
    owner: projection.owner,
    runId: projection.runId,
    runEpoch: projection.runEpoch,
    lastActivityMs: evidence.lastActivityMs,
  };
  const protect = (
    reason: WorkflowRetentionProtectionReason,
  ): WorkflowRetentionProtected =>
    Object.freeze({ ...base, eligible: false, reason });

  if (projection.terminal === undefined) return protect("nonterminal");
  if (projection.storageFailureEventIds.length > 0) {
    return protect("storage_failure");
  }
  if (projection.recoveryFailures.length > 0) {
    return protect("recovery_failure");
  }
  if (
    projection.result === undefined ||
    projection.terminal.resultEventId !== projection.result.eventId ||
    !evidence.durableResultMatches
  ) {
    return protect("durable_result_missing");
  }

  const intent = evidence.events.find(
    (event): event is WorkflowDeliveryIntentEvent =>
      event.type === "delivery_intent_recorded" &&
      event.payload.terminalEventId === projection.terminal?.eventId,
  );
  const receipt =
    intent === undefined
      ? undefined
      : evidence.events.find(
          (event): event is WorkflowDeliveryReceiptEvent =>
            event.type === "delivery_receipt_recorded" &&
            event.payload.intentEventId === intent.eventId &&
            event.payload.deliveryId === intent.payload.deliveryId,
        );
  if (receipt === undefined) return protect("undelivered");

  if (
    !Number.isSafeInteger(evidence.lastActivityMs) ||
    !Number.isSafeInteger(evidence.nowMs) ||
    evidence.lastActivityMs < 0 ||
    evidence.nowMs < evidence.lastActivityMs ||
    evidence.nowMs - evidence.lastActivityMs < policy.minimumAgeMs
  ) {
    return protect("too_young");
  }
  if (evidence.ownerRunCount <= policy.minimumRunsPerOwner) {
    return protect("owner_minimum_runs");
  }

  return Object.freeze({
    ...base,
    eligible: true,
    terminalEventId: projection.terminal.eventId,
    resultEventId: projection.result.eventId,
    deliveryReceiptEventId: receipt.eventId,
    policy,
  });
}
