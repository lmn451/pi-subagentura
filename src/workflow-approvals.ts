import type { DurableWorkflowProjection } from "./workflow-projection-repository";
import {
  createWorkflowSha256Digest,
  durableWorkflowOwnerEquals,
  isDurableWorkflowRunId,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowSha256Digest,
  type WorkflowUsageAccounting,
} from "./workflow-run-types";
import {
  encodeDurableValue,
  type DurableValue,
} from "./workflow-durable-value";

export type WorkflowApprovalKind = "budget" | "plan_gate";
export type WorkflowApprovalDecision = "approved" | "denied";
export type WorkflowApprovalDenialPolicy = "stop" | "skip";

/** Immutable request identity plus the current owner/epoch selection fence. */
export interface WorkflowApprovalSnapshot {
  readonly runId: DurableWorkflowRunId;
  readonly requestId: string;
  readonly requestEventId: string;
  readonly approvalKind: WorkflowApprovalKind;
  readonly reason: "agent_limit" | "token_limit" | "cost_limit" | "plan_gate";
  readonly description: string;
  readonly accounting: WorkflowUsageAccounting;
  readonly policyHash: WorkflowSha256Digest;
  readonly planRevision: number;
  readonly requestOwnerGeneration: number;
  readonly requestRunEpoch: number;
  readonly owner: DurableWorkflowOwner;
  readonly ownerGeneration: number;
  readonly runEpoch: number;
  readonly version: number;
  readonly denialPolicy: WorkflowApprovalDenialPolicy;
  readonly subjectTaskId: string | null;
}

/** Trusted-only decision input. This shape is intentionally not a model tool schema. */
export interface WorkflowApprovalDecisionInput {
  readonly requestId: string;
  readonly requestEventId: string;
  readonly policyHash: WorkflowSha256Digest;
  readonly planRevision: number;
  readonly expectedOwner: DurableWorkflowOwner;
  readonly expectedOwnerGeneration: number;
  readonly expectedRunEpoch: number;
  readonly version: number;
  readonly decision: WorkflowApprovalDecision;
  readonly trustedActorId: string;
}

export type WorkflowApprovalNoopReason =
  | "not_pending"
  | "request_mismatch"
  | "policy_mismatch"
  | "plan_revision_mismatch"
  | "wrong_owner"
  | "owner_generation_mismatch"
  | "epoch_mismatch"
  | "version_mismatch";

export type WorkflowApprovalDecisionOutcome =
  | {
      readonly status: "accepted";
      readonly decision: WorkflowApprovalDecision;
      readonly request: WorkflowApprovalSnapshot;
      readonly execution?: {
        readonly runId: DurableWorkflowRunId;
        readonly completion: Promise<unknown>;
      };
    }
  | {
      readonly status: "no_op";
      readonly reason: WorkflowApprovalNoopReason;
      readonly request?: WorkflowApprovalSnapshot;
    };

export interface WorkflowApprovalDecisionAuthority {
  readonly owner: DurableWorkflowOwner;
  inspectApproval(
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowApprovalSnapshot | undefined>;
  trustedDecideApproval(
    runId: DurableWorkflowRunId,
    input: WorkflowApprovalDecisionInput,
  ): Promise<WorkflowApprovalDecisionOutcome>;
}

export interface WorkflowApprovalCommandResult {
  readonly handled: true;
  readonly status: "accepted" | "no_op" | "error";
  readonly decision?: WorkflowApprovalDecision;
  readonly workflowId?: DurableWorkflowRunId;
  readonly requestId?: string;
  readonly reason?: string;
}

export function createWorkflowApprovalPolicyHash(
  policy: DurableValue,
): WorkflowSha256Digest {
  return createWorkflowSha256Digest(encodeDurableValue(policy).sha256);
}

export function pendingWorkflowApproval(
  projection: DurableWorkflowProjection,
): WorkflowApprovalSnapshot | undefined {
  const pending = projection.approvalRequests.find(
    (request) => request.decision === undefined,
  );
  if (pending === undefined) return undefined;
  return Object.freeze({
    runId: projection.runId,
    requestId: pending.requestId,
    requestEventId: pending.requestEventId,
    approvalKind: pending.approvalKind,
    reason: pending.reason,
    description: pending.description,
    accounting: pending.accounting,
    policyHash: pending.policyHash,
    planRevision: pending.planRevision,
    requestOwnerGeneration: pending.requestOwnerGeneration,
    requestRunEpoch: pending.requestRunEpoch,
    owner: projection.owner,
    ownerGeneration: projection.ownerGeneration,
    runEpoch: projection.runEpoch,
    version: pending.version,
    denialPolicy: pending.denialPolicy,
    subjectTaskId: pending.subjectTaskId,
  });
}

export function workflowApprovalFenceMismatch(
  request: WorkflowApprovalSnapshot,
  input: WorkflowApprovalDecisionInput,
): WorkflowApprovalNoopReason | undefined {
  if (
    input.requestId !== request.requestId ||
    input.requestEventId !== request.requestEventId
  ) {
    return "request_mismatch";
  }
  if (input.policyHash !== request.policyHash) return "policy_mismatch";
  if (input.planRevision !== request.planRevision) {
    return "plan_revision_mismatch";
  }
  if (!durableWorkflowOwnerEquals(input.expectedOwner, request.owner)) {
    return "wrong_owner";
  }
  if (input.expectedOwnerGeneration !== request.ownerGeneration) {
    return "owner_generation_mismatch";
  }
  if (input.expectedRunEpoch !== request.runEpoch) return "epoch_mismatch";
  if (input.version !== request.version) return "version_mismatch";
  return undefined;
}

/**
 * Handle only trusted approval verbs. The caller must be the host command
 * registrar; model-facing tools must never receive this authority.
 */
export async function handleWorkflowApprovalCommand(
  args: string,
  authority: WorkflowApprovalDecisionAuthority,
  trustedActorId = "workflow-plan-command",
): Promise<WorkflowApprovalCommandResult | undefined> {
  const match = args.trim().match(/^(approve|deny)\s+(\S+)\s+(\S+)$/);
  if (match === null) {
    return /^(approve|deny)(?:\s|$)/.test(args.trim())
      ? {
          handled: true,
          status: "error",
          reason:
            "Usage: /workflow-plan approve|deny <workflow-id> <request-id>",
        }
      : undefined;
  }
  const decision = match[1] === "approve" ? "approved" : "denied";
  const runId = match[2];
  if (!isDurableWorkflowRunId(runId)) {
    return {
      handled: true,
      status: "error",
      reason: "Invalid durable workflow ID.",
    };
  }
  const request = await authority.inspectApproval(runId);
  if (request === undefined) {
    return {
      handled: true,
      status: "no_op",
      decision,
      workflowId: runId,
      reason: "No approval is pending for this workflow.",
    };
  }
  if (match[3] !== request.requestId) {
    return {
      handled: true,
      status: "no_op",
      decision,
      workflowId: runId,
      requestId: request.requestId,
      reason: "The selected approval request is stale.",
    };
  }
  const outcome = await authority.trustedDecideApproval(runId, {
    requestId: request.requestId,
    requestEventId: request.requestEventId,
    policyHash: request.policyHash,
    planRevision: request.planRevision,
    expectedOwner: request.owner,
    expectedOwnerGeneration: request.ownerGeneration,
    expectedRunEpoch: request.runEpoch,
    version: request.version,
    decision,
    trustedActorId,
  });
  return outcome.status === "accepted"
    ? {
        handled: true,
        status: "accepted",
        decision,
        workflowId: runId,
        requestId: request.requestId,
      }
    : {
        handled: true,
        status: "no_op",
        decision,
        workflowId: runId,
        requestId: request.requestId,
        reason: outcome.reason,
      };
}
