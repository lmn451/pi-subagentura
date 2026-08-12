import { createHash } from "node:crypto";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
} from "./workflow-durable-value";
import type { DurableWorkflowProjection } from "./workflow-projection-repository";
import type {
  DurableWorkflowOwner,
  DurableWorkflowRunId,
} from "./workflow-run-types";

export const MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES = 32 * 1024;

export interface DurableWorkflowDeliveryPayload {
  readonly schemaVersion: 1;
  readonly deliveryId: string;
  readonly runId: DurableWorkflowRunId;
  readonly terminalEventId: string;
  readonly customType: "workflow-notify";
  readonly content: string;
  readonly details: {
    readonly deliveryIds: readonly string[];
    readonly workflowId: DurableWorkflowRunId;
    readonly status: "done" | "error" | "cancelled";
    readonly durable: true;
  };
}

export interface DurableWorkflowDeliveryMessage {
  readonly customType: "workflow-notify";
  readonly content: string;
  readonly display: true;
  readonly details: DurableWorkflowDeliveryPayload["details"];
}

/**
 * Raw parent-session sender. A synchronous return only means Pi accepted the
 * message; it does not prove that the custom entry reached the transcript.
 */
export interface DurableWorkflowDeliverySender {
  readonly dispatch: (message: DurableWorkflowDeliveryMessage) => void;
  readonly existingEntries?: () => readonly unknown[];
}

/**
 * Controller transport whose successful dispatch is durable receipt evidence.
 * Raw Pi senders must be adapted by the session runtime instead of being passed
 * through directly.
 */
export interface DurableWorkflowDeliveryTransport extends DurableWorkflowDeliverySender {}

export class DurableWorkflowDeliveryEvidencePendingError extends Error {
  readonly deliveryIds: readonly string[];

  constructor(deliveryIds: readonly string[]) {
    super("Durable workflow delivery is awaiting parent transcript evidence.");
    this.name = "DurableWorkflowDeliveryEvidencePendingError";
    this.deliveryIds = Object.freeze([...deliveryIds]);
  }
}

/**
 * Dispatch through Pi while deliberately withholding a durable receipt until
 * the corresponding custom entry can be observed through `existingEntries`.
 */
export function dispatchDurableWorkflowDeliveryAwaitingEvidence(
  sender: DurableWorkflowDeliverySender,
  message: DurableWorkflowDeliveryMessage,
): never {
  sender.dispatch(message);
  throw new DurableWorkflowDeliveryEvidencePendingError(
    message.details.deliveryIds,
  );
}

export function durableWorkflowDeliveryId(
  owner: DurableWorkflowOwner,
  runId: DurableWorkflowRunId,
  terminalEventId: string,
): string {
  return createHash("sha256")
    .update(
      `${owner.projectKey}\0${owner.piSessionKey}\0${runId}\0${terminalEventId}`,
    )
    .digest("hex");
}

export function createDurableWorkflowDeliveryPayload(
  projection: DurableWorkflowProjection,
): DurableWorkflowDeliveryPayload {
  const terminal = projection.terminal;
  if (terminal === undefined) {
    throw new TypeError("A durable workflow delivery requires a terminal run.");
  }
  const deliveryId = durableWorkflowDeliveryId(
    projection.owner,
    projection.runId,
    terminal.eventId,
  );
  const statusText =
    terminal.status === "done"
      ? "completed"
      : terminal.status === "cancelled"
        ? "was cancelled"
        : "failed";
  const payload = {
    schemaVersion: 1,
    deliveryId,
    runId: projection.runId,
    terminalEventId: terminal.eventId,
    customType: "workflow-notify",
    content:
      `Durable workflow ${projection.runId} ${statusText}.\n\n` +
      `Call get_workflow_result with workflowId "${projection.runId}" to retrieve the committed result.`,
    details: {
      deliveryIds: [deliveryId],
      workflowId: projection.runId,
      status: terminal.status,
      durable: true,
    },
  } satisfies DurableWorkflowDeliveryPayload;
  const encoded = encodeDurableValue(payload, {
    maxBytes: MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES,
  });
  return decodeDurableWorkflowDeliveryPayload(encoded.json);
}

export function decodeDurableWorkflowDeliveryPayload(
  value: DurableValue | string | Uint8Array,
): DurableWorkflowDeliveryPayload {
  const decoded =
    typeof value === "string" || value instanceof Uint8Array
      ? decodeDurableValue(value, {
          maxBytes: MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES,
        })
      : decodeDurableValue(
          encodeDurableValue(value, {
            maxBytes: MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES,
          }).json,
          { maxBytes: MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES },
        );
  if (!isRecord(decoded) || !isRecord(decoded.details)) {
    throw new TypeError("Durable workflow delivery payload is invalid.");
  }
  const details = decoded.details;
  if (
    decoded.schemaVersion !== 1 ||
    typeof decoded.deliveryId !== "string" ||
    typeof decoded.runId !== "string" ||
    typeof decoded.terminalEventId !== "string" ||
    decoded.customType !== "workflow-notify" ||
    typeof decoded.content !== "string" ||
    !Array.isArray(details.deliveryIds) ||
    details.deliveryIds.length !== 1 ||
    details.deliveryIds[0] !== decoded.deliveryId ||
    details.workflowId !== decoded.runId ||
    !["done", "error", "cancelled"].includes(String(details.status)) ||
    details.durable !== true
  ) {
    throw new TypeError("Durable workflow delivery payload is invalid.");
  }
  return decoded as unknown as DurableWorkflowDeliveryPayload;
}

export function durableWorkflowDeliveryMessage(
  payload: DurableWorkflowDeliveryPayload,
): DurableWorkflowDeliveryMessage {
  return Object.freeze({
    customType: payload.customType,
    content: payload.content,
    display: true,
    details: payload.details,
  });
}

export function durableWorkflowDeliveryIdsFromEntries(
  entries: readonly unknown[],
): ReadonlySet<string> {
  const deliveryIds = new Set<string>();
  for (const entry of entries) {
    const record = isRecord(entry) ? entry : undefined;
    if (record?.type !== "custom" && record?.type !== "custom_message") {
      continue;
    }
    const directDetails = isRecord(record.details) ? record.details : undefined;
    const message = isRecord(record.message) ? record.message : undefined;
    const messageDetails = isRecord(message?.details)
      ? message.details
      : undefined;
    const ids = directDetails?.deliveryIds ?? messageDetails?.deliveryIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === "string") deliveryIds.add(id);
  }
  return deliveryIds;
}

function isRecord(value: unknown): value is Record<string, DurableValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
