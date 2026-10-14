import { createHash } from "node:crypto";
import { join } from "node:path";
import isPathInside from "is-path-inside";
import { MAX_DELIVERY_RECEIPTS, updateInteractiveStates } from "./artifact";
import type {
  PersistedDeliveryIntent,
  InteractiveSubagentPersistedStateV2,
} from "./artifact";
import { completionDisplayLabel } from "./completion-presentation";
import { asStringIdentifier, type DeliveryId } from "./identifier-types";
import type { InteractiveSubagentState } from "./interactive-tmux";
import {
  COMPLETION_CONSUMED_ENTRY_TYPE,
  COMPLETION_ENTRY_TYPE,
  COMPLETION_MANIFEST_TYPE,
  COMPLETION_RECORD_SCHEMA_VERSION,
  publishCompletion,
} from "./completion-coordinator";
import {
  interactiveStateBelongsToOwner,
  ownerlessEntitiesVisible,
  resolveLiveSessionScope,
  type SessionOwnerToken,
} from "./session-scope";
import { inProcessJobOwner, inProcessJobsForOwner } from "./helpers";

export const MAX_DELIVERY_RECORDS = 32;
export const MAX_DELIVERY_QUEUE_BYTES = 256 * 1024;

interface DeliveryGlobalState {
  __piSubagenturaInteractiveRegistry?: Map<string, InteractiveSubagentState>;
  __piSubagenturaSessionManager?: { getEntries?: () => unknown[] };
}
const EMPTY_INTERACTIVE_STATES: readonly InteractiveSubagentState[] = [];

function deliveryGlobals(): typeof globalThis & DeliveryGlobalState {
  return globalThis as typeof globalThis & DeliveryGlobalState;
}

function interactiveStatesForOwner(
  owner?: SessionOwnerToken,
): Iterable<InteractiveSubagentState> {
  if (owner) {
    return (
      resolveLiveSessionScope(owner)?.interactiveStates.values() ??
      EMPTY_INTERACTIVE_STATES
    );
  }
  if (!ownerlessEntitiesVisible()) return EMPTY_INTERACTIVE_STATES;
  return (
    deliveryGlobals().__piSubagenturaInteractiveRegistry?.values() ??
    EMPTY_INTERACTIVE_STATES
  );
}

function runningInProcessJobCount(owner?: SessionOwnerToken): number {
  return [...inProcessJobsForOwner(owner).values()].filter(
    (job) =>
      job.status === "running" &&
      (owner !== undefined || !inProcessJobOwner(job)),
  ).length;
}

function runningInProcessJobsNote(owner?: SessionOwnerToken): string {
  const remaining = runningInProcessJobCount(owner);
  if (remaining <= 0) return "";
  const noun = remaining === 1 ? "job" : "jobs";
  const verb = remaining === 1 ? "is" : "are";
  return `${remaining} in-process sub-agent ${noun} ${verb} still running\nDo not claim all review work is complete yet`;
}

function appendRunningJobsNote(
  content: string,
  owner?: SessionOwnerToken,
): string {
  const note = runningInProcessJobsNote(owner);
  return note ? `${content}\n${note}` : content;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let truncated = Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - 3))
    .toString("utf8");
  while (Buffer.byteLength(`${truncated}…`, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function compactDeliveryReceipts(state: InteractiveSubagentState): void {
  const receipts = state.deliveryReceipts ?? [];
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (let index = receipts.length - 1; index >= 0; index--) {
    const receipt = receipts[index];
    if (seen.has(receipt)) continue;
    seen.add(receipt);
    compacted.unshift(receipt);
    if (compacted.length >= MAX_DELIVERY_RECEIPTS) break;
  }
  state.deliveryReceipts = compacted;
}

export function deliveryIdFor(params: {
  parentSessionId: string;
  subagentId: string;
  turnId: string;
}): DeliveryId {
  return asStringIdentifier<"delivery">(
    createHash("sha256")
      .update(
        `${params.parentSessionId}\0${params.subagentId}\0${params.turnId}`,
      )
      .digest("hex")
      .slice(0, 32),
  );
}

function copyDeliveryState(
  state: InteractiveSubagentState,
  entry: InteractiveSubagentPersistedStateV2,
): void {
  entry.eventByteCursor = state.eventByteCursor ?? 0;
  entry.activeTurnId = state.activeTurnId;
  entry.pendingDeliveries = state.pendingDeliveries ?? [];
  entry.deliveryReceipts = state.deliveryReceipts ?? [];
  entry.lifecycle = state.lifecycle;
}

function persistStates(states: readonly InteractiveSubagentState[]): void {
  const statesByCwd = new Map<string, Map<string, InteractiveSubagentState>>();
  for (const state of states) {
    compactDeliveryReceipts(state);
    if (!state.parentSessionId) continue;
    const grouped = statesByCwd.get(state.cwd) ?? new Map();
    grouped.set(state.id, state);
    statesByCwd.set(state.cwd, grouped);
  }
  for (const [cwd, grouped] of statesByCwd) {
    updateInteractiveStates(
      cwd,
      [...grouped.values()].map((state) => ({
        id: state.id,
        update: (entry) => copyDeliveryState(state, entry),
      })),
    );
  }
}

function persistState(state: InteractiveSubagentState): void {
  persistStates([state]);
}

function queueBytes(queue: PersistedDeliveryIntent[]): number {
  return Buffer.byteLength(JSON.stringify(queue), "utf8");
}

function maxKnownCompletionAge(
  completedAt: readonly (number | undefined)[],
  now = Date.now(),
): number | undefined {
  let maximum: number | undefined;
  for (const timestamp of completedAt) {
    if (
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp < 0
    ) {
      continue;
    }
    const age = now - timestamp;
    if (!Number.isFinite(age) || age < 0) continue;
    maximum = Math.max(maximum ?? 0, age);
  }
  return maximum;
}

export function enqueueDelivery(
  state: InteractiveSubagentState,
  intent: PersistedDeliveryIntent,
  options: { persist?: boolean } = {},
): void {
  if (typeof intent.message !== "string") {
    intent.message = undefined;
  } else if (intent.message.length > 500) {
    intent.message = `${intent.message.slice(0, 500)}…`;
  }
  if (
    intent.completedAt !== undefined &&
    (typeof intent.completedAt !== "number" ||
      !Number.isFinite(intent.completedAt) ||
      intent.completedAt < 0)
  ) {
    intent.completedAt = undefined;
  }
  const queue = (state.pendingDeliveries ??= []);
  if (
    queue.some((item) => item.deliveryId === intent.deliveryId) ||
    state.deliveryReceipts?.includes(intent.deliveryId)
  ) {
    return;
  }
  queue.push(intent);
  while (queueBytes(queue) > MAX_DELIVERY_QUEUE_BYTES) {
    const candidate = queue.find((item) => item.output);
    if (!candidate) break;
    candidate.output = undefined;
    candidate.message =
      `${candidate.message ?? ""}\nPayload omitted because the durable delivery queue reached its bound.`.trim();
  }
  if (
    queue.length > MAX_DELIVERY_RECORDS ||
    queueBytes(queue) > MAX_DELIVERY_QUEUE_BYTES
  ) {
    if (queue.at(-1) === intent) queue.pop();
    throw new Error(
      `Coordinated delivery queue exceeded its ${MAX_DELIVERY_RECORDS}-record bound before it could be drained; delivery ${intent.deliveryId} remains in the artifact log for retry`,
    );
  }
  if (options.persist !== false) persistState(state);
}

/** Mark a completion as handled by the parent tool without sending it to LLM context. */
export function acknowledgeDeliveryWithoutDispatch(
  state: InteractiveSubagentState,
  deliveryId: string,
): void {
  state.pendingDeliveries = (state.pendingDeliveries ?? []).filter(
    (intent) => intent.deliveryId !== deliveryId,
  );
  if (!state.deliveryReceipts?.includes(deliveryId)) {
    (state.deliveryReceipts ??= []).push(deliveryId);
  }
  persistState(state);
}

function publishCoordinatedInteractiveCompletion(
  state: InteractiveSubagentState,
  intent: PersistedDeliveryIntent,
  owner?: SessionOwnerToken,
): void {
  const outputReference = intent.output
    ? {
        label: "output",
        value: join(intent.artifactDir, "outputs", `${intent.eventId}.md`),
      }
    : undefined;
  const references = [
    ...(outputReference ? [outputReference] : []),
    {
      label: "activity",
      value: join(intent.artifactDir, "events.ndjson"),
    },
  ];
  publishCompletion(
    {
      schemaVersion: 1,
      completionId: intent.deliveryId,
      source: "interactive",
      sourceId: intent.subagentId,
      turnId: intent.turnId,
      label: completionDisplayLabel(state.name, "interactive sub-agent"),
      status: intent.status,
      policy: intent.completionPolicy,
      ...(intent.completionGroupId
        ? { groupId: intent.completionGroupId }
        : {}),
      references,
      completedAt: intent.completedAt ?? Date.now(),
      ...(intent.completedAt === undefined
        ? {}
        : { telemetryCompletedAt: intent.completedAt }),
    },
    owner,
  );
}

export function flushDeliveries(
  _pi: unknown,
  _ui: unknown,
  owner?: SessionOwnerToken,
): void {
  reconcileAllDeliveryReceipts(owner);
  for (const state of interactiveStatesForOwner(owner)) {
    if (!interactiveStateBelongsToOwner(state, owner)) continue;
    if (state.completionOwner === "workflow") continue;
    for (const intent of state.pendingDeliveries ?? []) {
      publishCoordinatedInteractiveCompletion(state, intent, owner);
    }
  }
  reconcileAllDeliveryReceipts(owner);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function deliveryIdsFromEntry(
  entry: unknown,
  state: InteractiveSubagentState,
): unknown[] | undefined {
  const record = objectRecord(entry);
  if (record?.type !== "custom" && record?.type !== "custom_message") {
    return undefined;
  }
  const message = objectRecord(record.message);
  const customType = record.customType ?? message?.customType;
  const data = objectRecord(record.data);
  const details =
    objectRecord(record.details) ?? objectRecord(message?.details);
  if (customType === COMPLETION_ENTRY_TYPE) {
    return data?.schemaVersion === COMPLETION_RECORD_SCHEMA_VERSION &&
      data.source === "interactive" &&
      data.sourceId === state.id &&
      typeof data.completionId === "string"
      ? [data.completionId]
      : undefined;
  }
  if (customType === COMPLETION_MANIFEST_TYPE) {
    return details?.schemaVersion === COMPLETION_RECORD_SCHEMA_VERSION &&
      Array.isArray(details.completionIds)
      ? details.completionIds
      : undefined;
  }
  return undefined;
}

function consumedInteractiveDeliveryIds(
  entry: unknown,
  state: InteractiveSubagentState,
): string[] {
  const record = objectRecord(entry);
  if (
    record?.type !== "custom" ||
    record.customType !== COMPLETION_CONSUMED_ENTRY_TYPE
  ) {
    return [];
  }
  const data = objectRecord(record.data);
  if (data?.source !== "interactive" || data.sourceId !== state.id) return [];
  return (state.pendingDeliveries ?? [])
    .filter((intent) => !data.turnId || intent.turnId === data.turnId)
    .map((intent) => intent.deliveryId);
}

function reconcileDeliveryReceiptsInMemory(
  state: InteractiveSubagentState,
  entries: unknown[],
): boolean {
  compactDeliveryReceipts(state);
  const seen = new Set<string>();
  for (const entry of entries) {
    const ids = [
      ...(deliveryIdsFromEntry(entry, state) ?? []),
      ...consumedInteractiveDeliveryIds(entry, state),
    ];
    for (const id of ids) if (typeof id === "string") seen.add(id);
  }
  let changed = false;
  for (const intent of state.pendingDeliveries ?? []) {
    if (seen.has(intent.deliveryId)) {
      (state.deliveryReceipts ??= []).push(intent.deliveryId);
      changed = true;
    }
  }
  state.pendingDeliveries = (state.pendingDeliveries ?? []).filter(
    (intent) => !seen.has(intent.deliveryId),
  );
  if (changed) compactDeliveryReceipts(state);
  return changed;
}

export function reconcileDeliveryReceipts(
  state: InteractiveSubagentState,
  entries: unknown[],
  _owner?: SessionOwnerToken,
): void {
  if (reconcileDeliveryReceiptsInMemory(state, entries)) {
    persistState(state);
  }
}

export function reconcileAllDeliveryReceipts(owner?: SessionOwnerToken): void {
  const entries = owner
    ? resolveLiveSessionScope(owner)?.sessionManager?.getEntries?.()
    : deliveryGlobals().__piSubagenturaSessionManager?.getEntries?.();
  if (!Array.isArray(entries)) return;
  const changedStates: InteractiveSubagentState[] = [];
  for (const state of interactiveStatesForOwner(owner)) {
    if (!interactiveStateBelongsToOwner(state, owner)) continue;
    if (reconcileDeliveryReceiptsInMemory(state, entries)) {
      changedStates.push(state);
    }
  }
  persistStates(changedStates);
}
