export const WORKFLOW_RUN_TYPES_VERSION = 1 as const;
export const WORKFLOW_RUN_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

export function validateWorkflowRunId(runId: string): void {
  if (!WORKFLOW_RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid durable workflow run ID");
  }
}

export type WorkflowEagerMode = "off" | "preferred" | "always";
export type WorkflowResumePolicy = "manual" | "on-session-start";
export type WorkflowRunStatus =
  | "created"
  | "running"
  | "interrupted"
  | "blocked"
  | "awaiting_budget"
  | "done"
  | "error"
  | "cancelled";

export interface WorkflowOwnerIdentity {
  projectKey: string;
  cwd: string;
  piSessionId: string;
  ownerId: string;
  ownerGeneration: number;
  leaseToken: string;
}

export interface WorkflowOperationIdentity {
  runId: string;
  definitionPath: string;
  operationId: string;
}

export interface WorkflowOperationRequest extends WorkflowOperationIdentity {
  requestDigest: string;
  prompt: string;
  responseOrdinal: number;
}

export interface WorkflowRunLaunch {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  runId: string;
  planRevision: number;
  resumePolicy: WorkflowResumePolicy;
  owner: WorkflowOwnerIdentity;
  createdAt: number;
  planDigest?: string;
}

export interface WorkflowAppendReceipt {
  eventId: string;
  runId: string;
  startByte: number;
  endByte: number;
  eventOrdinal: number;
}

export interface WorkflowEventEnvelope<T extends string = string, P = unknown> {
  schemaVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  eventId: string;
  eventOrdinal?: number;
  runId: string;
  runEpoch: number;
  type: T;
  payload: P;
}

export interface WorkflowTerminalResult {
  status: Extract<WorkflowRunStatus, "done" | "error" | "cancelled">;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface WorkflowDeliveryClaim {
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
}

export interface WorkflowDeliveryIntent {
  deliveryId: string;
  kind: "terminal";
  status: "pending" | "dispatched" | "delivered";
  message: string;
  claim?: WorkflowDeliveryClaim;
}

export interface WorkflowCancellationRequest {
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
  requestId: string;
}

export interface WorkflowApprovalRequest {
  requestId: string;
  taskId?: string;
  policyHash: string;
  planRevision: number;
  ownerGeneration: number;
  leaseEpoch: number;
  version: number;
  denial?: "stop" | "skip";
}

export type WorkflowApprovalStatus = "pending" | "approved" | "rejected";

export interface WorkflowApprovalDecision {
  requestId: string;
  status: Exclude<WorkflowApprovalStatus, "pending">;
  decidedBy: string;
  reason?: string;
  policyHash?: string;
  planRevision?: number;
  ownerGeneration?: number;
  leaseEpoch?: number;
  version?: number;
}

export function validateWorkflowCancellationRequest(
  request: WorkflowCancellationRequest,
): void {
  if (!request.requestId || !request.ownerId) {
    throw new Error("Invalid workflow cancellation request");
  }
  for (const value of [request.ownerGeneration, request.leaseEpoch]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid workflow cancellation request authority");
    }
  }
}

export function validateWorkflowApprovalRequest(
  request: WorkflowApprovalRequest,
): void {
  if (!request.requestId || !request.policyHash) {
    throw new Error("Invalid workflow approval request");
  }
  for (const value of [
    request.planRevision,
    request.ownerGeneration,
    request.leaseEpoch,
    request.version,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid workflow approval request version");
    }
  }
}

export function validateWorkflowApprovalDecision(
  decision: WorkflowApprovalDecision,
): void {
  if (!decision.requestId || !decision.decidedBy) {
    throw new Error("Invalid workflow approval decision");
  }
  if (decision.status !== "approved" && decision.status !== "rejected") {
    throw new Error("Invalid workflow approval decision status");
  }
  if (decision.reason !== undefined && !decision.reason.trim()) {
    throw new Error("Invalid workflow approval decision reason");
  }
  for (const value of [
    decision.planRevision,
    decision.ownerGeneration,
    decision.leaseEpoch,
    decision.version,
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("Invalid workflow approval decision binding");
  }
}
