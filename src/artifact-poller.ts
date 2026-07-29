/**
 * Artifact polling, legacy session-log tailing, and durable completion enqueue.
 *
 * Extracted from src/subagent.ts to keep the extension entry point focused on tool
 * registration and lifecycle management. This module owns the poll interval's per-tick
 * work: walking the artifact directory of every running interactive sub-agent, tail-reading
 * the child's session JSONL, appending legacy tool_activity events, and enqueueing
 * protocol completions for trigger-aware delivery.
 *
 * See src/subagent.ts for the interval setup / teardown and the rehydrate logic.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  artifactPath,
  appendEvent,
  assertNever,
  isCompletionEvent,
  readEventBatch,
  removeInteractiveState,
  updateInteractiveState,
  type CompletionEvent,
  type CompletionOutcome,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  foldInteractiveLifecycle,
  interactiveSubagentRegistry,
  getInteractivePaneLivenessAsync,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { shouldNotify } from "./notifications";
import { deliveryIdFor, enqueueDelivery, flushDeliveries } from "./delivery";
import { debugLog, inProcessJobBelongsToOwner, jobRegistry } from "./helpers";
import { coarseElapsedMs, formatActivityRow } from "./rendering";
import { formatWorkflowUsage } from "./workflow-core";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import ndjson from "ndjson";

import {
  getRunningWorkflowCount,
  workflowJobBelongsToOwner,
  workflowJobRegistry,
} from "./workflow-jobs";
import {
  getSessionContextStack,
  interactiveStateBelongsToOwner,
  type ActiveSessionContextToken,
  resolveLiveSessionContext,
} from "./session-context";
// ── Footer / Widget Status Keys ────────────────────────────────────────

export const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";
const WORKFLOW_FOOTER_KEY = "subagentura-workflows";
const WORKFLOW_WIDGET_KEY = "subagentura-workflow-activity";

/** Maximum widget rows before truncation with "… and N more". */
const MAX_WIDGET_ROWS = 10;
const MAX_WORKFLOW_WIDGET_ROWS = 5;
type StatusUi = Pick<ExtensionUIContext, "setStatus">;
const widgetRowsByUi = new WeakMap<
  ExtensionUIContext,
  Map<string, string[] | undefined>
>();
const footerStatusesByUi = new WeakMap<
  StatusUi,
  Map<string, string | undefined>
>();

/**
 * Owners whose sub-agents belong on the surfaces bound to `ui`.
 *
 * The footer and the activity widget are keyed per-ui, and nested sessions share
 * one `ExtensionUIContext`. Repainting a shared surface from a single owner's
 * point of view would erase its sibling context's rows (and undercount its
 * agents) on every other poll tick, so both surfaces project the union over every
 * live context bound to this ui. `[undefined]` means "unscoped": count everything.
 */
function ownersPaintingInto(
  ui: StatusUi,
  owner: ActiveSessionContextToken | undefined,
): (ActiveSessionContextToken | undefined)[] {
  if (!owner) return [undefined];
  const bound = getSessionContextStack()
    .filter((context) => context.ui === ui)
    .map((context) => ({ id: context.id, generation: context.generation }));
  // A ui the context stack does not know (e.g. a tool ctx captured before
  // session_start bound it) can only speak for the owner that was handed in.
  return bound.length > 0 ? bound : [owner];
}

function belongsToAnyOwner(
  state: InteractiveSubagentState,
  owners: (ActiveSessionContextToken | undefined)[],
): boolean {
  return owners.some((owner) => interactiveStateBelongsToOwner(state, owner));
}

function getRunningSubagentCount(
  owners: (ActiveSessionContextToken | undefined)[],
): number {
  const inProcessCount = [...jobRegistry.values()].filter(
    (job) =>
      job.status === "running" &&
      owners.some((owner) => inProcessJobBelongsToOwner(job, owner)),
  ).length;
  const interactiveCount = [...interactiveSubagentRegistry.values()].filter(
    (state) =>
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown") &&
      belongsToAnyOwner(state, owners),
  ).length;
  return inProcessCount + interactiveCount;
}

function updateFooterStatus(
  ui: StatusUi,
  key: string,
  statusText: string | undefined,
): void {
  let statuses = footerStatusesByUi.get(ui);
  const unchanged = statuses?.has(key) && statuses.get(key) === statusText;
  if (unchanged) return;
  try {
    ui.setStatus(key, statusText);
    if (!statuses) {
      statuses = new Map();
      footerStatusesByUi.set(ui, statuses);
    }
    statuses.set(key, statusText);
  } catch {
    /* ui stale */
  }
}

/**
 * Repaint the "N sub-agents active" footer, scoped to `owner` when supplied.
 *
 * Liveness is decided here rather than at the call sites: callers pass the raw
 * active token, so a token whose lifecycle already ended reads as "this session
 * owns nothing" (count 0) instead of silently falling back to a cross-session
 * global count.
 */
export function updateRunningSubagentFooter(
  ui: StatusUi,
  owner?: ActiveSessionContextToken,
): void {
  const ownerContext = resolveLiveSessionContext(owner);
  // A live context that has not bound its sessionManager yet (pre-session_start)
  // cannot map any parentSessionId back to itself, so scoping would report 0 for
  // agents it really owns. Stay unscoped until the binding exists.
  const scopedOwner = ownerContext?.sessionManager ? owner : undefined;
  const runningCount =
    owner !== undefined && !ownerContext
      ? 0
      : getRunningSubagentCount(ownersPaintingInto(ui, scopedOwner));
  const statusText =
    runningCount > 0
      ? `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} active`
      : undefined;
  updateFooterStatus(ui, FOOTER_KEY, statusText);
}

function widgetRowsEqual(
  previousRows: string[] | undefined,
  nextRows: string[] | undefined,
): boolean {
  if (previousRows === undefined || nextRows === undefined) {
    return previousRows === nextRows;
  }
  return (
    previousRows.length === nextRows.length &&
    previousRows.every((row, index) => row === nextRows[index])
  );
}

function updateWidgetRows(
  ui: ExtensionUIContext,
  key: string,
  rows: string[],
): void {
  const nextRows = rows.length > 0 ? rows : undefined;
  let rowsByKey = widgetRowsByUi.get(ui);
  const previousRows = rowsByKey?.get(key);
  const unchanged =
    rowsByKey?.has(key) && widgetRowsEqual(previousRows, nextRows);
  if (unchanged) return;
  try {
    ui.setWidget(key, nextRows, { placement: "belowEditor" });
    if (!rowsByKey) {
      rowsByKey = new Map();
      widgetRowsByUi.set(ui, rowsByKey);
    }
    rowsByKey.set(key, nextRows ? [...nextRows] : undefined);
  } catch {
    /* ui stale */
  }
}

/**
 * Project current live rows after owner-scoped liveness processing completes.
 *
 * Ownership is answered by exactly one predicate — `interactiveStateBelongsToOwner`
 * — shared with the poller's own state filter, the footer count, delivery, and the
 * supervisor. The previous ui-identity + `parentSessionId` check was a second,
 * weaker ownership key that workflow children (which deliberately carry no
 * `parentSessionId`) could never satisfy, so they were invisible here.
 */
function projectActivityWidgetRows(
  ui: ExtensionUIContext | undefined,
  owner: ActiveSessionContextToken | undefined,
  now: number,
): string[] {
  if (!ui) return [];
  const owners = ownersPaintingInto(ui, owner);
  const states = [...interactiveSubagentRegistry.values()].filter(
    (state) =>
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown") &&
      belongsToAnyOwner(state, owners),
  );
  return states.map((state) => formatActivityRow(state, now));
}

/** Derive delivery status from an already narrowed completion event. */
function deliveryStatusFromEvent(ev: CompletionEvent): CompletionOutcome {
  switch (ev.type) {
    case "done":
      return "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "completion":
      return ev.outcome;
    default:
      return assertNever(ev);
  }
}

function deliveryMessageFromEvent(ev: CompletionEvent): string | undefined {
  if (ev.type !== "completion") {
    return "message" in ev ? ev.message : undefined;
  }
  if (ev.errorMessage) return ev.errorMessage;
  if (ev.message) return ev.message;
  if (ev.outputError?.code === "output_too_large") {
    return `Output omitted: ${ev.outputError.bytes} bytes exceeds the ${ev.outputError.maxBytes}-byte snapshot limit.`;
  }
  return ev.outputError?.message;
}

const pollsInFlight = new Map<string, Promise<void>>();
// ── Poller ─────────────────────────────────────────────────────────────

function pollOwnerKey(owner: ActiveSessionContextToken | undefined): string {
  return owner ? `${owner.id}:${owner.generation}` : "unscoped";
}

/**
 * Poll the artifact directory of every running interactive sub-agent and fire a
 * pointer-only notification for any new events that match the spawner's cadence.
 *
 * Backwards-compatible with sub-agents that finished during parent downtime:
 * we walk the artifact log in physical byte order and advance eventByteCursor.
 */
export function pollArtifactChanges(
  pi: ExtensionAPI,
  owner?: ActiveSessionContextToken,
): Promise<void> {
  const key = pollOwnerKey(owner);
  const inFlight = pollsInFlight.get(key);
  if (inFlight) return inFlight;
  const poll = runPollArtifactChanges(pi, owner);
  pollsInFlight.set(key, poll);
  return poll.finally(() => {
    if (pollsInFlight.get(key) === poll) pollsInFlight.delete(key);
  });
}

async function runPollArtifactChanges(
  pi: ExtensionAPI,
  owner?: ActiveSessionContextToken,
): Promise<void> {
  // Top-level defensive try/catch: the poller runs from a setInterval, so any uncaught throw here
  // would crash the parent pi process. Better to swallow and let the next tick (with a refreshed
  // pi ctx) try again. A stale extension context after session replacement is the most likely cause.
  try {
    const g2 = typeof global !== "undefined" ? global : globalThis;
    const initialPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    const ownerContext = owner ? resolveLiveSessionContext(owner) : undefined;
    if (owner && !ownerContext) return;
    const interactivePi =
      ownerContext?.pi ??
      (g2.__piSubagenturaPiRef as ExtensionAPI | undefined) ??
      pi;
    if (!interactivePi) return;

    const states = [...interactiveSubagentRegistry.values()].filter((state) =>
      interactiveStateBelongsToOwner(state, owner),
    );
    const liveness = await Promise.all(
      states.map(async (state) => {
        try {
          return [state, await getInteractivePaneLivenessAsync(state)] as const;
        } catch (err) {
          debugLog("error", "poller_liveness_error", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [state, "unknown"] as const;
        }
      }),
    );
    if (owner && !resolveLiveSessionContext(owner)) return;
    const currentPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    if (
      !owner &&
      ((initialPiRef !== undefined && currentPiRef === undefined) ||
        (currentPiRef !== undefined && currentPiRef !== interactivePi))
    ) {
      return;
    }
    const ui =
      ownerContext?.ui ??
      (g2.__piSubagenturaUi as ExtensionUIContext | undefined);
    for (const [state, paneLiveness] of liveness) {
      if (interactiveSubagentRegistry.get(state.id) !== state) continue;
      // Cancelled is terminal. Unknown means pane liveness is unavailable, so keep polling
      // the artifact log: a later done/error event must still reach the parent.
      // 'exited' is intentionally not skipped: a follow-up user entry can revive it to "running".
      const art = artifactPath(
        dirname(state.artifactDir),
        basename(state.artifactDir),
      );
      // Tail-read the child's session log and synthesize tool_activity events.
      // TUI-widget only — the LLM never sees them.
      tailReadSessionLog(state, art);

      const cursor = state.eventByteCursor ?? 0;
      const batch = readEventBatch(art, cursor);
      const records = batch.records;
      const lifecycle = (state.lifecycle ??= {});
      let nextCursor = cursor;
      for (const record of records) {
        const ev = record.event;
        nextCursor = record.endOffset;
        foldInteractiveLifecycle(lifecycle, ev);
        if ("version" in ev && ev.version === 2 && ev.type === "turn_started") {
          state.activeTurnId = ev.turnId;
        }
        if (state.completionOwner === "workflow") continue;
        if (!shouldNotify(ev) || !isCompletionEvent(ev)) continue;
        const v2 = ev.type === "completion" ? ev : undefined;
        const mode = state.notifyOnComplete ?? "inject";
        const triggerTurn =
          mode === "inject"
            ? state.triggerTurnOnComplete !== false
            : state.triggerTurnOnComplete === true;
        const turnId = v2?.turnId ?? `legacy-${record.startOffset}`;
        const eventId =
          v2?.eventId ??
          (ev as unknown as { eventId?: string }).eventId ??
          `legacy-${record.startOffset}`;
        const status = deliveryStatusFromEvent(ev);
        enqueueDelivery(state, {
          deliveryId: deliveryIdFor({
            parentSessionId: state.parentSessionId ?? "pi",
            subagentId: state.id,
            turnId,
            mode,
          }),
          subagentId: state.id,
          turnId,
          eventId,
          mode,
          triggerTurn,
          status,
          artifactDir: state.artifactDir,
          output: v2?.output,
          message: deliveryMessageFromEvent(ev),
          state: "queued",
        });
      }
      for (const issue of batch.issues) {
        if (state.completionOwner === "workflow") continue;
        const mode = state.notifyOnComplete ?? "inject";
        const triggerTurn =
          mode === "inject"
            ? state.triggerTurnOnComplete !== false
            : state.triggerTurnOnComplete === true;
        const identity = `record-overflow-${issue.startOffset}`;
        enqueueDelivery(state, {
          deliveryId: deliveryIdFor({
            parentSessionId: state.parentSessionId ?? "pi",
            subagentId: state.id,
            turnId: identity,
            mode,
          }),
          subagentId: state.id,
          turnId: identity,
          eventId: identity,
          mode,
          triggerTurn,
          status: "error",
          artifactDir: state.artifactDir,
          message: `Artifact record at byte ${issue.startOffset} exceeded the ${issue.maxBytes}-byte limit and was skipped.`,
          state: "queued",
        });
      }
      if (batch.issues.length > 0 && state.parentSessionId) {
        updateInteractiveState(state.cwd, state.id, (entry) => {
          entry.pendingDeliveries = state.pendingDeliveries ?? [];
          entry.deliveryReceipts = state.deliveryReceipts ?? [];
        });
      }
      nextCursor = batch.endOffset;
      state.eventByteCursor = nextCursor;
      const next = deriveInteractiveSubagentStatusFromLifecycle(
        lifecycle,
        paneLiveness,
      );
      if (next !== state.status) state.status = next;
      if (next === "exited") {
        if (lifecycle.processExitCode !== undefined) {
          state.exitCode = lifecycle.processExitCode;
        } else if (lifecycle.completionExitCode !== undefined) {
          state.exitCode = lifecycle.completionExitCode;
        }
      }
      if (state.parentSessionId) {
        updateInteractiveState(state.cwd, state.id, (entry) => {
          entry.eventByteCursor = nextCursor;
          entry.sessionByteCursor =
            state.sessionObservedByteCursor ??
            state.lastDeliveredSessionByte ??
            0;
          entry.sessionPartialLineStart = state.sessionPartialLineStart ?? null;
          entry.activeTurnId = state.activeTurnId;
          entry.pendingDeliveries = state.pendingDeliveries ?? [];
          entry.deliveryReceipts = state.deliveryReceipts ?? [];
          entry.lifecycle = state.lifecycle;
        });
      }
    }
    // One clock for both widgets so their coarse elapsed buckets stay aligned.
    const now = Date.now();
    const widgetRows = projectActivityWidgetRows(ui, owner, now);
    flushDeliveries(interactivePi, ui, owner);
    for (const state of states) {
      if (interactiveSubagentRegistry.get(state.id) !== state) continue;
      const terminal =
        state.status === "cancelled" || state.status === "exited";
      if (terminal) destroySessionParser(state);
      if (
        terminal &&
        state.parentSessionId &&
        (state.pendingDeliveries?.length ?? 0) === 0
      ) {
        try {
          removeInteractiveState(state.cwd, state.id);
        } catch {
          /* retry cleanup on the next poll */
        }
      }
    }

    // Cap widget rows to prevent TUI overflow.
    if (widgetRows.length > MAX_WIDGET_ROWS) {
      const extra = widgetRows.length - MAX_WIDGET_ROWS;
      widgetRows.length = MAX_WIDGET_ROWS;
      widgetRows.push(`… and ${extra} more`);
    }

    // Paint footer + widget. Both are TUI surfaces that never reach the LLM.
    if (ui) {
      updateRunningSubagentFooter(ui, owner);
      updateWidgetRows(ui, WIDGET_KEY, widgetRows);
      // Workflow TUI footer + widget: show running async workflows.
      try {
        const wfCount = getRunningWorkflowCount(owner);
        const workflowRows = formatWorkflowWidgetRows(owner, now);
        const workflowStatus =
          wfCount > 0
            ? `⚡ ${wfCount} workflow${wfCount > 1 ? "s" : ""} running`
            : undefined;
        updateFooterStatus(ui, WORKFLOW_FOOTER_KEY, workflowStatus);
        updateWidgetRows(ui, WORKFLOW_WIDGET_KEY, workflowRows);
      } catch {
        /* ui stale */
      }
    }
  } catch (err) {
    debugLog("error", "poller_error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      registryIds: [...interactiveSubagentRegistry.keys()],
    });
    /* defensive: never let one bad poll tick crash the parent process */
  }
}

function formatWorkflowWidgetRows(
  owner: ActiveSessionContextToken | undefined,
  now: number,
): string[] {
  const rows: string[] = [];
  for (const st of workflowJobRegistry.values()) {
    if (!workflowJobBelongsToOwner(st, owner)) continue;
    if (st.status !== "running") continue;
    const s = st.snapshot;
    const parts = [
      `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
      `${s.runningCount ?? 0} running`,
      `${s.tokensSpent} output tokens`,
      ...(s.usage ? [formatWorkflowUsage(s.usage)] : []),
      formatWorkflowElapsed(now - st.startedAt),
    ];
    if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
    const last = s.lastMessage ? ` — ${s.lastMessage}` : "";
    rows.push(`◇ ${st.name} (${st.id}): ${parts.join(" · ")}${last}`);
  }
  if (rows.length > MAX_WORKFLOW_WIDGET_ROWS) {
    const extra = rows.length - MAX_WORKFLOW_WIDGET_ROWS;
    rows.length = MAX_WORKFLOW_WIDGET_ROWS;
    rows.push(`… and ${extra} more workflow${extra === 1 ? "" : "s"}`);
  }
  return rows;
}

/** Coarse elapsed clock; see ACTIVITY_ELAPSED_BUCKET_MS for why it is bucketed. */
function formatWorkflowElapsed(milliseconds: number): string {
  const bucketed = coarseElapsedMs(milliseconds);
  const seconds = Math.floor(bucketed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ── Session-log parsing state ─────────────────────────────────────────

interface SessionParserState {
  parser: ReturnType<typeof ndjson.parse>;
  owner: InteractiveSubagentState;
  readCursor: number;
}

/**
 * `readCursor` advances through bytes buffered by split2. The persisted session
 * cursor keeps that observed file position for truncation detection, while
 * `sessionPartialLineStart` records the replay point needed to reconstruct a
 * partial line after reload without persisting child-controlled content.
 */
const sessionParsers = new Map<string, SessionParserState>();

/** Bound both per-tick allocation and split2's accumulated incomplete line. */
const MAX_SESSION_READ_BYTES = 1 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES = 2 * 1024 * 1024;

function getOrCreateSessionParser(
  state: InteractiveSubagentState,
): SessionParserState {
  const existing = sessionParsers.get(state.id);
  if (existing?.owner === state) return existing;
  if (existing) destroySessionParser(state);

  const parser = ndjson.parse({
    strict: false,
    maxLength: MAX_SESSION_LINE_BYTES,
    skipOverflow: true,
  });
  const parserState: SessionParserState = {
    parser,
    owner: state,
    readCursor: state.lastDeliveredSessionByte ?? 0,
  };
  parser.on("data", (entry: unknown) => {
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    processSessionLogEntry(state, art, entry as any);
  });
  parser.on("error", () => {
    if (sessionParsers.get(state.id) !== parserState) return;
    rewindSessionParser(parserState);
    sessionParsers.delete(state.id);
    try {
      parser.destroy();
    } catch {
      /* parser is already broken; the durable cursor permits replay */
    }
  });
  sessionParsers.set(state.id, parserState);
  return parserState;
}

function rewindSessionParser(parserState: SessionParserState): void {
  const owner = parserState.owner;
  const replayCursor = owner.sessionPartialLineStart;
  if (replayCursor === undefined) return;
  owner.sessionObservedByteCursor = owner.lastDeliveredSessionByte;
  owner.lastDeliveredSessionByte = replayCursor;
}

/** Discard buffered child data without flushing an incomplete JSONL record. */
function destroySessionParser(state: InteractiveSubagentState): void {
  const parserState = sessionParsers.get(state.id);
  if (!parserState) return;
  rewindSessionParser(parserState);
  sessionParsers.delete(state.id);
  try {
    parserState.parser.destroy();
  } catch {
    /* parser may already be destroyed */
  }
}

/** Release every parser before the interactive registry is replaced or cleared. */
export function clearSessionParsers(): void {
  const parserStates = [...sessionParsers.values()];
  for (const parserState of parserStates) {
    destroySessionParser(parserState.owner);
  }
}

// ── Session-log tail-reading ──────────────────────────────────────────

/** Tail-read the child's session JSONL and append `tool_activity` events.
 *  Persists the observed cursor and incomplete-line replay boundary. */
function tailReadSessionLog(
  state: InteractiveSubagentState,
  _art: SubagentArtifact,
): void {
  const sessionFile = state.sessionFile;
  if (!sessionFile) return;

  let size: number;
  try {
    size = statSync(sessionFile).size;
  } catch {
    return;
  }

  let parserState = sessionParsers.get(state.id);
  if (parserState && parserState.owner !== state) {
    destroySessionParser(state);
    parserState = undefined;
  }
  let cursor = parserState?.readCursor ?? state.lastDeliveredSessionByte ?? 0;
  const observedCursor = state.sessionObservedByteCursor;
  state.sessionObservedByteCursor = undefined;
  if (
    size < cursor ||
    (observedCursor !== undefined && size < observedCursor)
  ) {
    state.lastDeliveredSessionByte = 0;
    state.sessionPartialLineStart = undefined;
    destroySessionParser(state);
    parserState = undefined;
    cursor = 0;
  }
  if (size <= cursor) return;

  const requested = size - cursor;
  const toRead = Math.min(requested, MAX_SESSION_READ_BYTES);
  if (toRead <= 0) return;

  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const count = readSync(
        fd,
        buf,
        bytesRead,
        toRead - bytesRead,
        cursor + bytesRead,
      );
      if (count <= 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0) return;

    parserState = getOrCreateSessionParser(state);
    parserState.parser.write(buf.subarray(0, bytesRead));
    parserState.readCursor = cursor + bytesRead;
    state.lastDeliveredSessionByte = parserState.readCursor;
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline === bytesRead - 1) {
      state.sessionPartialLineStart = undefined;
    } else if (lastNewline >= 0) {
      state.sessionPartialLineStart = cursor + lastNewline + 1;
    } else if (state.sessionPartialLineStart === undefined) {
      state.sessionPartialLineStart = cursor;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed or never opened — ignore */
    }
  }
}

/** Process a single parsed JSONL entry from the session log; append tool_activity events. */
function processSessionLogEntry(
  state: InteractiveSubagentState,
  art: SubagentArtifact,
  entry: Record<string, unknown>,
): void {
  const e = entry as { type?: string; message?: Record<string, unknown> };
  if (e.type !== "message") return;
  const msg = e.message;
  if (!msg) return;

  // New user-role message = a new turn. Clear legacy per-turn session metadata.
  if (msg.role === "user") {
    state.autoDoneForTurnAt = undefined;
    state.lastStopReason = undefined;
    state.lastStopReasonAt = undefined;
    state.lastStopText = undefined;
    if (state.lifecycle && !state.lifecycle.parentCancelled) {
      state.lifecycle.currentTurnId = undefined;
      state.lifecycle.completionTurnId = undefined;
      state.lifecycle.completionOutcome = undefined;
      state.lifecycle.completionSource = undefined;
      state.lifecycle.completionExitCode = undefined;
      state.lifecycle.legacyTerminal = undefined;
    }
    // A user-role entry starts a new turn regardless of how the previous turn ended.
    if (state.status === "exited" || state.status === "idle")
      state.status = "running";
    return;
  }

  // Assistant message: extract tool calls and retain legacy stop metadata.
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const ts = (msg.timestamp as number) ?? Date.now();
    const stopReason = (msg as { stopReason?: string }).stopReason;
    if (
      stopReason === "stop" ||
      stopReason === "length" ||
      stopReason === "error" ||
      stopReason === "aborted"
    ) {
      state.lastStopReason = stopReason;
      state.lastStopReasonAt = ts;
      if (stopReason === "stop") {
        const text = extractAssistantText(msg.content);
        if (text) state.lastStopText = text;
      }
    }
    for (const rawBlock of msg.content) {
      const block = rawBlock as
        { type?: string; name?: string; arguments?: unknown } | undefined;
      if (!block || block.type !== "toolCall") continue;
      const summary = summarizeToolCall(block.name ?? "", block.arguments);
      if (!summary) continue;
      const ev: SubagentEvent = {
        ts,
        type: "tool_activity",
        status: "running",
        tool: block.name ?? "",
        summary,
      };
      appendEvent(art, ev);
      state.lastToolName = block.name ?? "";
      state.lastToolSummary = summary;
      state.lastActivityAt = ev.ts;
    }
  }
}

/** Concatenate text blocks from an assistant message's content array. Empty string if none. */
function extractAssistantText(content: unknown[]): string {
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      if (out) out += "\n";
      out += b.text;
    }
  }
  return out;
}

// ── Misc helpers ──────────────────────────────────────────────────────

/** Short, human-readable summary of a tool call. Returns null for uninteresting tools. */
function summarizeToolCall(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "bash": {
      const cmd = typeof a.command === "string" ? a.command : null;
      if (!cmd) return null;
      return cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
    }
    case "write":
    case "edit":
    case "read": {
      const p = typeof a.path === "string" ? a.path : null;
      if (!p) return null;
      return p;
    }
    default:
      return null; // skip grep/find/ls etc. — too noisy for the widget
  }
}
