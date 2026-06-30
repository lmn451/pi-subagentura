/**
 * Artifact poller, session-log tailing, and auto-done fallback for interactive sub-agents.
 *
 * Extracted from src/subagent.ts to keep the extension entry point focused on tool
 * registration and lifecycle management. This module owns the poll interval's per-tick
 * work: walking the artifact directory of every running interactive sub-agent, tail-reading
 * the child's session JSONL, appending tool_activity events, running the auto-done fallback,
 * and delivering notifications to the parent Pi session.
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
  lastEvent,
  readEvents,
  readOutput,
  removeInteractiveState,
  snapshotOutput,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";
import {
  deriveInteractiveSubagentStatus,
  interactiveSubagentRegistry,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  decrementInjectCount,
  deliverArtifactNotification,
  getInjectCount,
  incrementInjectCount,
  MAX_INJECT,
  shouldNotify,
} from "./notifications";
import { formatActivityRow } from "./rendering";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import ndjson from "ndjson";

// ── Footer / Widget Status Keys ────────────────────────────────────────

export const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";

// ── Poller ─────────────────────────────────────────────────────────────

/**
 * Poll the artifact directory of every running interactive sub-agent and fire a
 * pointer-only notification for any new events that match the spawner's cadence.
 *
 * Backwards-compatible with sub-agents that finished during parent downtime:
 * we walk the artifact log, deliver events newer than `lastDeliveredEventTs`,
 * then advance the cursor. This naturally handles restart / backlog cases.
 */
export function pollArtifactChanges(pi: ExtensionAPI): void {
  // Top-level defensive try/catch: the poller runs from a setInterval, so any uncaught throw here
  // would crash the parent pi process. Better to swallow and let the next tick (with a refreshed
  // pi ctx) try again. The loader's assertActive stale-ctx check (thrown by sendUserMessage and a
  // few other call sites below) is the most likely culprit after a session reload/replace.
  try {
    const g2 = typeof global !== "undefined" ? global : globalThis;
    const interactivePi =
      (g2.__piSubagenturaPiRef as ExtensionAPI | undefined) ?? pi;
    if (!interactivePi) return;

    let runningCount = 0;
    const widgetRows: string[] = [];
    const ui = g2.__piSubagenturaUi as ExtensionUIContext | undefined;

    for (const state of interactiveSubagentRegistry.values()) {
      // Skip strictly-terminal states. "exited" is INTENTIONALLY not in this list: the user-role
      // revival at processSessionLogEntry can revive an "exited" sub-agent back to "running" if a
      // follow-up user message lands in the session log (auto-done case). To make that reachable,
      // the poll loop must keep tail-reading the session log for "exited" sub-agents too. The
      // status-update block below may re-mark the state as "exited" (based on a stale synthesized
      // error event in the artifact) but the revival, running later in the same poll via
      // tailReadSessionLog, will reset it to "running" within this same tick.
      if (state.status === "cancelled" || state.status === "unknown") continue;

      const art = artifactPath(
        dirname(state.artifactDir),
        basename(state.artifactDir),
      );
      const last = lastEvent(art);

      // Refresh status from the artifact + pane liveness. `done` + pane alive → "idle" (not exited),
      // which is what allows follow-ups: a second `done` after the follow-up turn will be picked up
      // here and the inject path below will fire again.
      const paneAlive = isPaneAlive(state);
      const next = deriveInteractiveSubagentStatus(last, paneAlive);
      if (next !== state.status) {
        state.status = next;
        if (
          next === "exited" &&
          last &&
          last.type === "done" &&
          last.exitCode !== undefined
        ) {
          state.exitCode = last.exitCode;
        }
      }
      // Early removal from persisted state: if a `done` event is already delivered for a dead
      // pane, the state entry is no longer needed on disk. This avoids keeping zombie entries
      // around for cleanly-exited sub-agents whose pane died after delivery.
      if (
        state.parentSessionId &&
        last &&
        shouldNotify(last) &&
        last.type === "done" &&
        !paneAlive &&
        (state.lastDeliveredEventTs ?? 0) >= last.ts
      ) {
        try {
          removeInteractiveState(state.cwd, state.id);
        } catch {
          /* best effort — disk full, permission denied, etc. */
        }
      }

      // Tail-read the child's session log and synthesize tool_activity events.
      // TUI-widget only — the LLM never sees them.
      tailReadSessionLog(state, art);

      // Auto-done fallback: synthesize a completion event when the model ended its turn with
      // stopReason:"stop" but never called `cli.mjs done`. Runs BEFORE reading events so the synthesized
      // event is part of the same poll's read-back. The normal event loop still owns delivery/cursor
      // advancement so stale Pi contexts can retry on the next tick.
      maybeAutoDone(state, art, Date.now());

      // Read events newer than the last delivered. `lastDeliveredEventTs` starts at 0,
      // so on the first poll we deliver the whole log. Subsequent polls advance the cursor.
      const cursor = state.lastDeliveredEventTs ?? 0;
      const events = readEvents(art, cursor + 1);

      if (events.length > 0) {
        let nextCursor = cursor;
        let shouldRemovePersistedState = false;
        for (const ev of events) {
          if (!shouldNotify(ev)) {
            if (ev.ts > nextCursor) nextCursor = ev.ts;
            continue;
          }
          // If auto-done already fired for this turn, skip any later explicit `done` events:
          // they would be duplicates. Errors and cancelled still flow through (the explicit signal is more accurate).
          if (
            state.autoDoneForTurnAt !== undefined &&
            ev.ts > state.autoDoneForTurnAt &&
            ev.type === "done"
          ) {
            if (ev.ts > nextCursor) nextCursor = ev.ts;
            continue;
          }
          const delivered = deliverArtifactNotification(
            interactivePi,
            state,
            ev,
          );
          if (!delivered) break;
          if (ev.ts > nextCursor) nextCursor = ev.ts;
          // Keep done+alive entries persisted: the child REPL is idle and can
          // accept follow-ups, so a later parent reload still needs rehydrate.
          if (ev.type === "error" || ev.type === "cancelled") {
            shouldRemovePersistedState = true;
          } else if (ev.type === "done" && !paneAlive) {
            shouldRemovePersistedState = true;
          }
        }
        state.lastDeliveredEventTs = nextCursor;
        // Drop the on-disk entry only after confirmed delivery, and only for
        // truly terminal states. A failed delivery leaves the cursor before
        // the event so the next poll/reload can retry.
        if (shouldRemovePersistedState && state.parentSessionId) {
          try {
            removeInteractiveState(state.cwd, state.id);
          } catch {
            /* best effort — disk full, permission denied, etc. */
          }
        }
      }

      // Per-turn snapshot: on a NEW `done` event, copy the latest output.md into output-N.md so turn
      // history survives the child overwriting output.md each turn. Runs in every notifyOnComplete mode,
      // so it needs its own cursor (`lastSnapshotEventTs`) — see the field doc for why reusing
      // `lastInjectedEventTs` would corrupt history in the default `notify` mode.
      if (
        last &&
        last.type === "done" &&
        state.lastSnapshotEventTs !== last.ts
      ) {
        const allEvents = readEvents(art);
        const turnNumber = allEvents.filter((e) => e.type === "done").length;
        snapshotOutput(art, turnNumber);
        state.lastSnapshotEventTs = last.ts;
      }

      // Inject-mode delivery: on a NEW `done` event, push output.md into the parent LLM's next turn.
      // Per-turn (not per-sub-agent) — `lastInjectedEventTs` is compared against the current `done`'s `ts`
      // so each follow-up turn re-injects. Mirrors deliverNotification's MAX_INJECT cap.
      if (
        last &&
        last.type === "done" &&
        state.notifyOnComplete === "inject" &&
        state.lastInjectedEventTs !== last.ts
      ) {
        const output = readOutput(art);
        if (output !== null) {
          if (getInjectCount() >= MAX_INJECT) {
            // Degrade silently: pointer notification was already delivered above,
            // so the user still sees a hint. We just don't inject.
            try {
              interactivePi.sendMessage!(
                {
                  customType: "subagent-notify",
                  content: `Inject cap exceeded for interactive sub-agent ${state.id} — degraded to notify.`,
                  display: true,
                  details: { subagentId: state.id, mode: "notify" },
                },
                { deliverAs: "followUp" },
              );
            } catch {
              /* pi stale */
            }
          } else {
            incrementInjectCount();
            try {
              (interactivePi as any).sendUserMessage?.(
                output || "(sub-agent produced no output)",
                { deliverAs: "followUp" },
              );
            } catch {
              /* pi stale — next poll tick will re-attempt with a refreshed ctx */
            } finally {
              decrementInjectCount();
            }
          }
        }
        // Record the ts of the done we just (attempted to) inject for. The next `done` from a follow-up
        // turn has a fresh ts, so the comparison re-fires.
        state.lastInjectedEventTs = last.ts;
      }

      // Only count sub-agents that are actively processing a turn as "running".

      // "exited" is terminal (pane dead) — the sub-agent is done; hide it from the

      // running count and widget even though the for-loop keeps tail-reading its

      // session log (for the user-role revival case in processSessionLogEntry).

      // "idle" is between turns (REPL open, pane alive) — still a live sub-agent

      // awaiting follow-up, so it stays in the count.

      if (state.status === "running" || state.status === "idle") {
        runningCount++;

        widgetRows.push(formatActivityRow(state));
      }
    }

    // Paint footer + widget. Both are TUI-only — never reach the LLM.
    if (ui) {
      try {
        ui.setStatus(
          FOOTER_KEY,
          runningCount > 0
            ? `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`
            : undefined,
        );
      } catch {
        /* ui stale */
      }
      try {
        ui.setWidget(
          WIDGET_KEY,
          widgetRows.length > 0 ? widgetRows : undefined,
          {
            placement: "belowEditor",
          },
        );
      } catch {
        /* ui stale */
      }
    }
  } catch {
    /* defensive: never let one bad poll tick crash the parent process */
  }
}

// ── Session-log parsing state ─────────────────────────────────────────

/**
 * Per-state ndjson parser instance used to tail-read the child's session JSONL.
 *
 * The parser buffers partial trailing lines internally (via split2 underneath), so we can
 * safely write raw bytes from the file on every poll and let the parser emit complete JSON
 * objects as 'data' events. This replaces a hand-rolled partial-line + cursor scheme that had
 * three latent bugs:
 *   - A 1 MiB per-tick read cap combined with cursor-pinning on a missing newline caused a
 *     permanent re-read loop on any single JSONL line larger than 1 MiB (e.g. a multi-MB tool
 *     call result that the child pi runtime writes as a single line).
 *   - File truncation left the cursor pointing past EOF, silently dropping any post-truncation
 *     content.
 *   - A `require("node:fs").closeSync(fd)` call in the finally block leaked file descriptors on
 *     Node < 22.12 in some bundling paths.
 *
 * Keyed by sub-agent id; one parser per state lives for the lifetime of the process. The parser
 * is destroyed and recreated on file truncation so the buffered partial state is cleared.
 */
const sessionParsers = new Map<string, ReturnType<typeof ndjson.parse>>();

/** Defensive upper bound on the per-tick Buffer.alloc. With ndjson, a partial line is buffered
 * internally across polls, so the cap is no longer required for correctness — it is kept purely
 * to bound worst-case memory if the file explodes in a single tick. 1 MiB is plenty. */
const MAX_SESSION_READ_BYTES = 1 * 1024 * 1024;

/**
 * Auto-done debounce window. When the child ends a turn with stopReason:"stop" and the model has
 * not produced any new session-log activity (assistant or user message, tool call, etc.) for this long,
 * the parent synthesizes a completion event. Default 10s is long enough to cover the model streaming its
 * final tool call's toolResult back and short enough that the parent does not wait long after the child is
 * visibly idle. Tunable in one place.
 */
const AUTO_DONE_DEBOUNCE_MS = 10_000;

/** Get-or-create the per-state session parser and wire its 'data' event to the entry handler. */
function getOrCreateSessionParser(
  state: InteractiveSubagentState,
): ReturnType<typeof ndjson.parse> {
  const existing = sessionParsers.get(state.id);
  if (existing) return existing;
  // strict: false → malformed lines are silently dropped instead of triggering an 'error' event
  // that would force us to recreate the parser mid-stream. Same best-effort delivery semantics as
  // the old hand-rolled try/catch around JSON.parse.
  const parser = ndjson.parse({ strict: false });
  parser.on("data", (entry: unknown) => {
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    processSessionLogEntry(state, art, entry as any);
  });
  // In non-strict mode the parser does not emit 'error' for bad JSON, but we still attach a no-op
  // handler so an unhandled error event can never crash the process.
  parser.on("error", () => {
    // Drop the broken parser so the next tick creates a fresh one. The cursor is reset in the
    // truncation handler, so this only fires for pathological non-truncation errors.
    sessionParsers.delete(state.id);
  });
  sessionParsers.set(state.id, parser);
  return parser;
}

/** Destroy a state's parser (used on truncation and on state removal). */
function destroySessionParser(state: InteractiveSubagentState): void {
  const parser = sessionParsers.get(state.id);
  if (!parser) return;
  try {
    parser.end();
  } catch {
    // ignore — we're tearing down
  }
  sessionParsers.delete(state.id);
}

// ── Session-log tail-reading ──────────────────────────────────────────

/** Tail-read the child's session JSONL and append `tool_activity` events to events.ndjson.
 *  Updates `state.lastDeliveredSessionByte` so subsequent ticks re-read only new lines. */
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
    return; // file not yet created by the child
  }

  const initialCursor = state.lastDeliveredSessionByte ?? 0;
  if (size < initialCursor) {
    // File shrunk under us (truncation, rotation, manual edit). Reset cursor and parser and fall
    // through to the read below so any content already written after the truncation is processed in
    // the same tick (e.g. test does truncateSync → writeFileSync → poll). The parser is recreated so the
    // buffered partial state is cleared. Any duplicate tool_activity events are acceptable — the
    // artifact log is best-effort and the LLM never sees these (TUI-widget only).
    state.lastDeliveredSessionByte = 0;
    destroySessionParser(state);
  }
  const cursor = state.lastDeliveredSessionByte ?? 0;
  if (size <= cursor) return;

  // Defensive cap on per-tick allocation. ndjson handles partial lines correctly across writes,
  // so a single multi-MB line split across ticks works fine — no cursor pin.
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
      const n = readSync(
        fd,
        buf,
        bytesRead,
        toRead - bytesRead,
        cursor + bytesRead,
      );
      if (n <= 0) break;
      bytesRead += n;
    }
    if (bytesRead === 0) return;
    const parser = getOrCreateSessionParser(state);
    parser.write(buf.subarray(0, bytesRead));
    // Always advance the cursor by the bytes we fed the parser. The parser buffers any partial
    // trailing line internally and will emit the completed object on a later write. We do NOT
    // rewind to the last newline the way the old code did — doing so would re-feed the same bytes
    // to the parser and double-emit on the next tick.
    state.lastDeliveredSessionByte = cursor + bytesRead;
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

  // New user-role message = a new turn. Clear the per-turn auto-done guard so the
  // next `stopReason: "stop"` is treated as a fresh completion candidate. Without this, a
  // user follow-up after a previous auto-done would not be allowed to fire again.
  if (msg.role === "user") {
    state.autoDoneForTurnAt = undefined;
    // Reset the per-turn stop-capture so a new turn does not inherit stale data
    // from the previous one. Without this, a turn that ends with stopReason:"stop"
    // but no assistant text would fall back to the prior turn's `lastStopText` in
    // the synthesized error message.
    state.lastStopReason = undefined;
    state.lastStopReasonAt = undefined;
    state.lastStopText = undefined;
    // If the state was previously marked "exited" (e.g. by an auto-done fallback in a prior turn)
    // OR "idle" (the natural post-turn state once follow-up work lands), revive it to "running"
    // so the for-loop keeps tail-reading the session log. Without this, a user follow-up after
    // a previous completion would be silently ignored and the next auto-done / done-event
    // opportunity missed. Both paths share the same revival semantics: a user-role entry means
    // a new turn is starting, regardless of how the previous turn ended.
    if (state.status === "exited" || state.status === "idle")
      state.status = "running";
    return;
  }

  // Assistant message: extract toolCall blocks AND record stopReason for the auto-done fallback.
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
      // Capture the textual summary the model produced for the final turn. Used as fallback
      // content when auto-synthesizing an `error` event for a child that stopped without writing output.md.
      if (stopReason === "stop") {
        const text = extractAssistantText(msg.content);
        if (text) state.lastStopText = text;
      }
    }
    for (const rawBlock of msg.content) {
      const block = rawBlock as
        | { type?: string; name?: string; arguments?: unknown }
        | undefined;
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

// ── Auto-done fallback ────────────────────────────────────────────────

/**
 * Auto-done fallback. The protocol requires the child to call `cli.mjs done` after writing
 * output.md, but LLMs routinely forget. We observe the child's session log and synthesize a
 * completion event when:
 *   1. The most recent assistant message had stopReason "stop" (the model finished a turn naturally), AND
 *   2. The model has not produced any new session-log activity for AUTO_DONE_DEBOUNCE_MS, AND
 *   3. No explicit done/error/cancelled event is in the artifact log yet, AND
 *   4. We have not already synthesized one for this turn.
 *
 * The synthesized event is appended to events.ndjson so the regular poller path picks it up; we also
 * advance the cursor and the `injected` flag so a late-arriving explicit `done` (or a duplicate poller pass)
 * does not double-notify. When output.md is missing, we synthesize `error` instead and include the child's
 * last assistant text as a fallback message — most models inline a summary in chat even when the actual
 * result landed at a different path.
 */
function maybeAutoDone(
  state: InteractiveSubagentState,
  art: SubagentArtifact,
  now: number,
): void {
  if (state.autoDoneForTurnAt !== undefined) return; // already fired for this turn

  if (state.lastStopReason !== "stop") return;

  const stopAt = state.lastStopReasonAt ?? 0;

  if (now - stopAt < AUTO_DONE_DEBOUNCE_MS) return;

  // Explicit signal still wins. If the wrapper already wrote done/error/cancelled, do not synthesize.

  // NOTE: we scan ALL events, not just lastEvent(): tailReadSessionLog runs immediately before us

  // and may have just appended a `tool_activity` row whose ts is from the session log (often EARLIER

  // than the child's explicit done) — making `lastEvent` return a tool_activity and silently miss the

  // existing terminal event. That would synthesize a duplicate AND the events loop below would

  // re-deliver the original (its `ev.ts >= autoDoneForTurnAt` guard fails because the explicit done

  // has a smaller ts than the synthesized one), causing a double-notify. See the regression test

  // `does NOT synthesize when an explicit done event is present AND a tool_activity was appended
  // after it in the same poll` in subagent-auto-done.test.ts.

  const existingTerminal = readEvents(art).some(
    (ev) =>
      ev.type === "done" || ev.type === "error" || ev.type === "cancelled",
  );

  if (existingTerminal) return;

  // Detect output.md state. We want to synthesize `done` only when the model has actually produced a result.
  const output = readOutput(art);
  const hasOutput = output !== null && output.length > 0;

  const ts = now;
  let ev: SubagentEvent;
  if (hasOutput) {
    ev = {
      ts,
      type: "done",
      status: "done",
      exitCode: 0,
      summary: "auto-detected from session stopReason:stop",
    };
  } else {
    const fallback = state.lastStopText;
    const baseMessage = "sub-agent stopped without writing output.md";
    const FALLBACK_SLICE = 500;
    const message =
      fallback && fallback.length > 0
        ? fallback.length > FALLBACK_SLICE
          ? `${baseMessage} — last assistant message: ${fallback.slice(0, FALLBACK_SLICE)}… (truncated)`
          : `${baseMessage} — last assistant message: ${fallback}`
        : baseMessage;
    ev = { ts, type: "error", status: "error", message, exitCode: 1 };
    state.exitCode = 1;
  }
  // NOTE: we deliberately do NOT set state.status="exited" here. The synthesized event is in the artifact,
  // so the next poll's art-status check at the top of the for-loop will set it. Keeping status as "running"
  // for this iteration lets the for-loop continue processing the state on subsequent polls — critical for
  // the multi-turn case where the user attaches to the REPL and sends a follow-up; the new user message
  // needs to be tail-read to clear the auto-done guard. The TUI widget does not show this state because the
  // synthesized event was already delivered, and the next poll will transition status to "exited" after the
  // follow-up turn completes.
  appendEvent(art, ev);
  state.autoDoneForTurnAt = ts;
  // state.lastDeliveredEventTs = ts; // removed — the event loop owns cursor advancement
  // In inject mode, leave `injected` unset so the regular inject path at
  // lines 547-585 picks up the synthesized `done` event on the next poll.
  // For all other modes (notify, undefined), mark as injected here because
  // the inject path will never fire — this prevents accidental re-inject
  // if a late explicit `done` later matches the cursor.
  state.injected = state.notifyOnComplete !== "inject";
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
