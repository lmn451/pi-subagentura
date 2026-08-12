import { createHash } from "node:crypto";
import {
  WORKFLOW_RUN_TYPES_VERSION,
  type WorkflowEventEnvelope,
  type WorkflowOwnerIdentity,
} from "./workflow-run-types";

export interface WorkflowTaskClaim {
  runId: string;
  taskId: string;
  attempt: number;
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
  token: string;
}

export interface WorkflowMutationHashContext {
  runId: string;
  eventType: string;
  ownerId: string;
  ownerGeneration: number;
  leaseEpoch: number;
  baseRevision: number;
  baseOrdinal: number;
  previousMutationHash: string;
  payload: unknown;
}

export interface WorkflowMutationMetadata {
  mutationProtocolVersion: typeof WORKFLOW_RUN_TYPES_VERSION;
  mutationRunId: string;
  mutationType: string;
  mutationOwnerId: string;
  mutationOwnerGeneration: number;
  mutationLeaseEpoch: number;
  mutationBaseRevision: number;
  mutationBaseOrdinal: number;
  previousMutationHash: string;
  mutationHash: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash non-finite JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash unsupported JSON value");
}

export function workflowMutationHash(
  context: WorkflowMutationHashContext,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        protocolVersion: WORKFLOW_RUN_TYPES_VERSION,
        runId: context.runId,
        eventType: context.eventType,
        ownerId: context.ownerId,
        ownerGeneration: context.ownerGeneration,
        leaseEpoch: context.leaseEpoch,
        baseRevision: context.baseRevision,
        baseOrdinal: context.baseOrdinal,
        previousMutationHash: context.previousMutationHash,
        payload: context.payload,
      }),
    )
    .digest("hex");
}

export function mutationPayload(
  payload: Record<string, unknown>,
  context: Omit<WorkflowMutationHashContext, "payload">,
): Record<string, unknown> & WorkflowMutationMetadata {
  const metadata = {
    mutationProtocolVersion: WORKFLOW_RUN_TYPES_VERSION,
    mutationRunId: context.runId,
    mutationType: context.eventType,
    mutationOwnerId: context.ownerId,
    mutationOwnerGeneration: context.ownerGeneration,
    mutationLeaseEpoch: context.leaseEpoch,
    mutationBaseRevision: context.baseRevision,
    mutationBaseOrdinal: context.baseOrdinal,
    previousMutationHash: context.previousMutationHash,
  } satisfies Omit<WorkflowMutationMetadata, "mutationHash">;
  return {
    ...payload,
    ...metadata,
    mutationHash: workflowMutationHash({ ...context, payload }),
  };
}

export function verifyMutationPayload(
  event: WorkflowEventEnvelope,
  launchOwner: WorkflowOwnerIdentity,
  baseRevision: number,
  baseOrdinal: number,
  currentMutationHash: string,
): { valid: true; hash: string } | { valid: false } {
  const payload = event.payload;
  if (!isRecord(payload)) return { valid: false };
  const metadata = payload as Partial<WorkflowMutationMetadata>;
  const hasEvidence =
    metadata.previousMutationHash !== undefined ||
    metadata.mutationHash !== undefined ||
    metadata.mutationProtocolVersion !== undefined;
  if (!hasEvidence) return { valid: true, hash: currentMutationHash };
  if (
    metadata.mutationProtocolVersion !== WORKFLOW_RUN_TYPES_VERSION ||
    metadata.mutationRunId !== event.runId ||
    metadata.mutationType !== event.type ||
    metadata.mutationOwnerId !== launchOwner.ownerId ||
    metadata.mutationOwnerGeneration !== launchOwner.ownerGeneration ||
    metadata.mutationLeaseEpoch !== event.runEpoch ||
    metadata.mutationBaseRevision !== baseRevision ||
    metadata.mutationBaseOrdinal !== baseOrdinal ||
    metadata.previousMutationHash !== currentMutationHash ||
    typeof metadata.mutationHash !== "string"
  )
    return { valid: false };
  const {
    mutationProtocolVersion: _protocol,
    mutationRunId: _runId,
    mutationType: _type,
    mutationOwnerId: _ownerId,
    mutationOwnerGeneration: _generation,
    mutationLeaseEpoch: _epoch,
    mutationBaseRevision: _revision,
    mutationBaseOrdinal: _ordinal,
    previousMutationHash,
    mutationHash: candidate,
    ...data
  } = payload;
  const expected = workflowMutationHash({
    runId: event.runId,
    eventType: event.type,
    ownerId: launchOwner.ownerId,
    ownerGeneration: launchOwner.ownerGeneration,
    leaseEpoch: event.runEpoch,
    baseRevision,
    baseOrdinal,
    previousMutationHash: previousMutationHash as string,
    payload: data,
  });
  return candidate === expected
    ? { valid: true, hash: candidate }
    : { valid: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
