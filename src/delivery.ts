import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import isPathInside from "is-path-inside";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_DELIVERY_RECEIPTS,
  updateInteractiveStates,
  type PersistedDeliveryIntent,
  type InteractiveSubagentPersistedStateV2,
} from "./artifact";
import type { InteractiveSubagentState } from "./interactive-tmux";
import { notifyCompletionDelivery, sanitizeOutput } from "./notifications";
import {
  interactiveStateBelongsToOwner,
  ownerlessEntitiesVisible,
  resolveLiveSessionScope,
  resolveStreamingFlag,
  type SessionOwnerToken,
} from "./session-scope";
import { inProcessJobOwner, inProcessJobsForOwner } from "./helpers";

export const MAX_DELIVERY_RECORDS = 32;
export const MAX_DELIVERY_QUEUE_BYTES = 256 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const MAX_FLUSH_BYTES = 64 * 1024;
/** Maximum immutable output snapshot accepted from the artifact protocol. */
export const MAX_ARTIFACT_OUTPUT_BYTES = 1024 * 1024;
const MAX_FORMATTED_IDENTIFIER = 96;
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

function boundedIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const sanitized = sanitizeOutput(value.slice(0, MAX_FORMATTED_IDENTIFIER));
  return sanitized.replace(/[\r\n]/g, " ");
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
  mode: "notify" | "inject";
}): string {
  return createHash("sha256")
    .update(
      `${params.parentSessionId}\0${params.subagentId}\0${params.turnId}\0${params.mode}`,
    )
    .digest("hex")
    .slice(0, 32);
}

function copyDeliveryState(
  state: InteractiveSubagentState,
  entry: InteractiveSubagentPersistedStateV2,
): void {
  entry.eventByteCursor = state.eventByteCursor ?? 0;
  entry.sessionByteCursor =
    state.sessionObservedByteCursor ?? state.lastDeliveredSessionByte ?? 0;
  entry.sessionPartialLineStart = state.sessionPartialLineStart ?? null;
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

function persistOverflowIdentity(
  state: InteractiveSubagentState,
  intent: PersistedDeliveryIntent,
): void {
  const path = join(state.artifactDir, "delivery-overflow.ndjson");
  mkdirSync(state.artifactDir, { recursive: true, mode: 0o700 });
  appendFileSync(
    path,
    `${JSON.stringify({
      deliveryId: intent.deliveryId,
      eventId: intent.eventId,
      turnId: intent.turnId,
      mode: intent.mode,
      triggerTurn: intent.triggerTurn,
      status: intent.status,
    })}\n`,
    { mode: 0o600 },
  );
}

function mergeOverflowSemantics(
  summary: PersistedDeliveryIntent,
  collapsed: PersistedDeliveryIntent,
): void {
  if (collapsed.mode === "inject") summary.mode = "inject";
  if (collapsed.triggerTurn) summary.triggerTurn = true;
  if (collapsed.status === "error") summary.status = "error";
  else if (collapsed.status === "cancelled" && summary.status !== "error") {
    summary.status = "cancelled";
  }
}

function collapseOldestIntent(state: InteractiveSubagentState): void {
  const queue = state.pendingDeliveries ?? [];
  const summary = queue.find((item) => item.eventId === "delivery-overflow");
  const oldestIndex = queue.findIndex(
    (item) => item.eventId !== "delivery-overflow",
  );
  if (oldestIndex < 0) return;
  const [oldest] = queue.splice(oldestIndex, 1);
  persistOverflowIdentity(state, oldest);
  if (summary) {
    mergeOverflowSemantics(summary, oldest);
    return;
  }
  const secondIndex = queue.findIndex(
    (item) => item.eventId !== "delivery-overflow",
  );
  const second = secondIndex >= 0 ? queue.splice(secondIndex, 1)[0] : undefined;
  if (second) persistOverflowIdentity(state, second);
  const overflowId = deliveryIdFor({
    parentSessionId: state.parentSessionId ?? "pi",
    subagentId: state.id,
    turnId: `delivery-overflow-${oldest.deliveryId}`,
    mode: "notify",
  });
  const overflow: PersistedDeliveryIntent = {
    deliveryId: overflowId,
    subagentId: state.id,
    turnId: "delivery-overflow",
    eventId: "delivery-overflow",
    mode: "notify",
    triggerTurn: false,
    status: "done",
    artifactDir: state.artifactDir,
    message: `Completion payloads exceeded the delivery queue bound. Every completion identity and delivery mode is preserved in ${join(state.artifactDir, "delivery-overflow.ndjson")}.`,
    state: "queued",
  };
  mergeOverflowSemantics(overflow, oldest);
  if (second) mergeOverflowSemantics(overflow, second);
  queue.unshift(overflow);
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
  while (
    queue.length > MAX_DELIVERY_RECORDS ||
    queueBytes(queue) > MAX_DELIVERY_QUEUE_BYTES
  ) {
    collapseOldestIntent(state);
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

function readBoundedOutput(intent: PersistedDeliveryIntent): string | null {
  if (!intent.output) return null;
  const expected = resolve(
    intent.artifactDir,
    "outputs",
    `${intent.eventId}.md`,
  );
  if (resolve(intent.output.path) !== expected) return null;
  if (
    !Number.isSafeInteger(intent.output.bytes) ||
    intent.output.bytes < 0 ||
    intent.output.bytes > MAX_ARTIFACT_OUTPUT_BYTES ||
    !/^[a-f0-9]{64}$/i.test(intent.output.sha256)
  ) {
    return null;
  }
  let fd: number | undefined;
  try {
    const realArtifactDir = realpathSync(intent.artifactDir);
    const realExpected = realpathSync(expected);
    if (!isPathInside(realExpected, realArtifactDir)) return null;
    fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== intent.output.bytes) return null;
    const content = readFileSync(fd);
    if (
      content.byteLength !== intent.output.bytes ||
      createHash("sha256").update(content).digest("hex") !==
        intent.output.sha256.toLowerCase()
    ) {
      return null;
    }
    return sanitizeOutput(
      content.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"),
    );
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pointer(intent: PersistedDeliveryIntent): string {
  const output = intent.output
    ? join(intent.artifactDir, "outputs", `${intent.eventId}.md`)
    : join(intent.artifactDir, "output.md");
  return `Output: ${output}\nActivity log: ${intent.artifactDir}/events.ndjson`;
}

function formatIntent(
  intent: PersistedDeliveryIntent,
  owner?: SessionOwnerToken,
): string {
  const header = `[Sub-agent ${boundedIdentifier(intent.subagentId, "unknown")}, turn ${boundedIdentifier(intent.turnId, "unknown")}, ${intent.status}]`;
  const output = intent.mode === "inject" ? readBoundedOutput(intent) : null;
  const message =
    typeof intent.message === "string" ? sanitizeOutput(intent.message) : "";

  const body =
    intent.mode === "notify"
      ? message
        ? `\n${message}`
        : ""
      : output === null
        ? message
          ? `\n${message}`
          : "\n(no immutable output available)"
        : `\n<untrusted-subagent-output>\n${output || "(empty output)"}\n</untrusted-subagent-output>`;
  return appendRunningJobsNote(
    truncateUtf8(`${header}${body}\n${pointer(intent)}`, MAX_FLUSH_BYTES),
    owner,
  );
}

export function flushDeliveries(
  pi: ExtensionAPI,
  ui: ExtensionUIContext | undefined,
  owner?: SessionOwnerToken,
): void {
  reconcileAllDeliveryReceipts(owner);
  const llm: Array<{
    state: InteractiveSubagentState;
    intent: PersistedDeliveryIntent;
    content: string;
  }> = [];
  for (const state of interactiveStatesForOwner(owner)) {
    if (!interactiveStateBelongsToOwner(state, owner)) continue;
    if (state.completionOwner === "workflow") continue;
    for (const intent of state.pendingDeliveries ?? []) {
      if (intent.state === "dispatchAttempted") continue;
      llm.push({ state, intent, content: formatIntent(intent, owner) });
    }
  }
  const runningJobsCount = runningInProcessJobCount(owner);
  if (llm.length === 0) return;
  const selected: typeof llm = [];
  let bytes = 0;
  for (const item of llm) {
    const itemBytes = Buffer.byteLength(item.content, "utf8");
    const separatorBytes = selected.length > 0 ? 9 : 0;
    if (bytes + separatorBytes + itemBytes > MAX_FLUSH_BYTES) break;
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  const triggersTurn = selected.some(({ intent }) => intent.triggerTurn);
  if (resolveStreamingFlag(owner) && !triggersTurn) return;
  const deliveryIds = selected.map(({ intent }) => intent.deliveryId);
  try {
    pi.sendMessage(
      {
        customType: "subagent-notify",
        content: selected.map(({ content }) => content).join("\n\n---\n\n"),
        display: true,
        details: {
          deliveryIds,
          mode: selected.some(({ intent }) => intent.mode === "inject")
            ? "inject"
            : "notify",
          statuses: selected.map(({ intent }) => intent.status),
          status: selected.some(({ intent }) => intent.status === "error")
            ? "error"
            : selected.some(({ intent }) => intent.status === "cancelled")
              ? "cancelled"
              : "done",
          remainingRunningJobs: runningJobsCount,
          error: selected.some(({ intent }) => intent.status === "error"),
        },
      },
      {
        deliverAs: "followUp",
        triggerTurn: triggersTurn,
      },
    );
  } catch {
    return;
  }
  notifyCompletionDelivery(
    ui,
    selected.map(({ intent }) => ({
      label: `Sub-agent ${boundedIdentifier(intent.subagentId, "unknown")}`,
      mode: intent.mode,
      triggerTurn: intent.triggerTurn,
      status: intent.status,
    })),
  );
  for (const { intent } of selected) intent.state = "dispatchAttempted";
  persistStates(selected.map(({ state }) => state));
  reconcileAllDeliveryReceipts(owner);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function deliveryIdsFromEntry(entry: unknown): unknown[] | undefined {
  const record = objectRecord(entry);
  if (record?.type !== "custom" && record?.type !== "custom_message") {
    return undefined;
  }
  const details = objectRecord(record.details);
  const messageDetails = objectRecord(objectRecord(record.message)?.details);
  const ids = details?.deliveryIds ?? messageDetails?.deliveryIds;
  return Array.isArray(ids) ? ids : undefined;
}

function reconcileDeliveryReceiptsInMemory(
  state: InteractiveSubagentState,
  entries: unknown[],
  owner?: SessionOwnerToken,
): boolean {
  compactDeliveryReceipts(state);
  const seen = new Set<string>();
  for (const entry of entries) {
    const ids = deliveryIdsFromEntry(entry);
    if (!ids) continue;
    for (const id of ids) if (typeof id === "string") seen.add(id);
  }
  let changed = false;
  const canRetryUncommittedDispatch = !resolveStreamingFlag(owner);
  for (const intent of state.pendingDeliveries ?? []) {
    if (seen.has(intent.deliveryId)) {
      (state.deliveryReceipts ??= []).push(intent.deliveryId);
      changed = true;
    } else if (
      intent.state === "dispatchAttempted" &&
      canRetryUncommittedDispatch
    ) {
      intent.state = "queued";
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
  owner?: SessionOwnerToken,
): void {
  if (reconcileDeliveryReceiptsInMemory(state, entries, owner)) {
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
    if (reconcileDeliveryReceiptsInMemory(state, entries, owner)) {
      changedStates.push(state);
    }
  }
  persistStates(changedStates);
}
