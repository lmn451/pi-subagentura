/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *   - get_subagent_status: Poll async subagent job for live preview
 *   - get_subagent_result: Block until async job completes, return final output
 *   - cancel_subagent: Abort a running async job
 *   - prune_subagent_jobs: Remove all completed and failed jobs from the registry
 *   - subagent_interactive: Spawn a separate tmux-backed Pi session users can attach to
 *   - get_interactive_subagent_status / cancel_interactive_subagent: Inspect or stop tmux-backed sessions
 *   - send_interactive_subagent_message: Send a follow-up prompt into a live interactive sub-agent's REPL
 *   - list_available_models: List all known models with auth status for model validation
 *
 * Both spawn tools support optional `async` param for background execution.
 * When async: true, the job starts and the main agent continues immediately -
 * it does NOT block waiting for the sub-agent. Use get_subagent_status to poll
 * for progress and get_subagent_result when ready to collect output.
 *
 * Runs in the same process — no subprocess overhead.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
  convertToLlm,
  serializeConversation,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  buildLiveUpdate,
  formatUsage,
  SubagentLiveStatus,
  SubagentResult,
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  debugLog,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
import {
  buildAttachCommandsForState,
  cancelInteractiveSubagent,
  cancelInteractiveSubagentByState,
  deriveInteractiveSubagentStatus,
  formatInteractiveState,
  interactiveSubagentRegistry,
  isPaneAlive,
  launchInteractiveSubagent,
  sendCommandToPane,
  pruneDeadInteractiveSubagents,
  tmuxSetupHint,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  appendEvent,
  artifactPath,
  deleteInteractiveStatesFile,
  lastEvent,
  listOutputTurns,
  loadInteractiveStates,
  readEvents,
  readOutput,
  readOutputForTurn,
  removeInteractiveState,
  snapshotOutput,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";

import type { Usage } from "./helpers";

import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import ndjson from "ndjson";

export type SubagentDetails =
  | { status: "started"; jobId: string; contextMessages: number }
  | { status: "running"; subagentStatus: SubagentLiveStatus; model?: string }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found" }
  | { status: "invalid_id"; id: string };
// ── Footer Status Key ─────────────────────────────────────────────────────────────────────
const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";

// ── Helpers ──────────────────────────────────────────────────────────
// Shared helpers are imported from ./helpers (SubagentResult, SubagentLiveStatus,
// formatUsage, buildLiveUpdate, ACTIVE_TOOL_DEBOUNCE_MS, jobRegistry, MAX_REGISTRY_SIZE,
// pruneOldestJob, pruneCompletedJobs, scheduleJobCleanup, startSubagentJob, JobState)

async function runSubagent(
  task: string,
  persona: string | undefined,
  modelOverride: string | undefined,
  cwd: string,
  contextText: string | null,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<any>) => void) | undefined,
  defaultModel: Model<any> | undefined,
  parentModelRegistry: ModelRegistry | undefined,
): Promise<SubagentResult> {
  try {
    const { jobPromise, modelWarning } = await startSubagentJob({
      task,
      persona,
      modelOverride,
      cwd,
      contextText,
      signal,
      onUpdate,
      defaultModel,
      parentModelRegistry,
    });
    const result = await jobPromise;
    // Surface model resolution info so the AI sees what model was used
    if (modelWarning && !result.isError) {
      result.output = `${modelWarning}\n---\n${result.output}`;
    }
    return result;
  } catch (err) {
    // Preserve original error formatting: if startSubagentJob throws
    // (e.g., createAgentSession auth failure), return clean SubagentResult
    // instead of letting raw error propagate to Pi's agent loop.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: `Sub-agent crashed: ${msg}`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      model: undefined,
      isError: true,
      errorMessage: msg,
    };
  }
}

// ── Rendering ────────────────────────────────────────────────────────

function renderSubagentCall(
  args: Record<string, unknown>,
  theme: Theme,
  label: string,
) {
  const task = String(args.task ?? "");
  const taskPreview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
  let text = theme.fg("toolTitle", theme.bold(`${label} `));
  text += theme.fg("accent", taskPreview);
  if (args.model) {
    text += theme.fg("dim", ` @${args.model}`);
  }
  if (args.async) {
    text += theme.fg("accent", " [async]");
  }
  return new Text(text, 0, 0);
}

function renderSubagentResult(
  result: AgentToolResult<any> & { isError?: boolean },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  // Async spawn result: show compact "started" display
  if (result.details?.status === "started") {
    return renderAsyncSpawn(result.details, theme);
  }

  if (isPartial) {
    const runningDetails =
      result.details?.status === "running" ? result.details : undefined;
    const status = runningDetails?.subagentStatus;
    const model = runningDetails?.model;

    let text =
      theme.fg("accent", "● ") + theme.fg("toolTitle", "Sub-agent working");

    if (status) {
      text += theme.fg("dim", ` — turn ${status.turn}`);

      if (status.activeTool) {
        let argsStr = "{…}";
        try {
          argsStr = JSON.stringify(status.activeTool.args).slice(0, 80);
        } catch {
          /* circular or otherwise unserializable */
        }
        text += `
  ${theme.fg("muted", "→")} ${theme.fg(
    "toolTitle",
    status.activeTool.name,
  )} ${theme.fg("dim", argsStr)}`;
      }

      const usageStr = formatUsage(status.usage, model);
      if (usageStr) {
        text += `
  ${theme.fg("muted", usageStr)}`;
      }

      if (status.output) {
        const preview = status.output.slice(0, 200).replace(/\s+/g, " ");
        text += `
  ${theme.fg("dim", truncateToWidth(preview, 120))}`;
      }
    } else {
      text += theme.fg("dim", "…");
    }

    return new Text(text, 0, 0);
  }

  // Final result
  const text =
    result.content.find(
      (c): c is { type: "text"; text: string } => c.type === "text",
    )?.text ?? "";

  if (result.isError) {
    if (!expanded) {
      const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
      return new Text(theme.fg("error", preview), 0, 0);
    }
    return new Text(theme.fg("error", text), 0, 0);
  }

  const usageStr = (result.details as { usageSummary?: string } | undefined)
    ?.usageSummary;

  if (usageStr) {
    const header = theme.fg("success", "✓ ") + theme.fg("muted", usageStr);
    if (!expanded) {
      return new Text(header, 0, 0);
    }
    return new Text(`${header}\n${text}`, 0, 0);
  }

  if (!expanded) {
    const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
    return new Text(theme.fg("dim", preview), 0, 0);
  }
  return new Text(text, 0, 0);
}

/**
 * Render the immediate result of an async subagent spawn.
 * Compact display: "⚡ Sub-agent started — job abc12345"
 */
function renderAsyncSpawn(
  details: Extract<SubagentDetails, { status: "started" }>,
  theme: Theme,
): Text {
  const jobId = details.jobId;
  const text =
    theme.fg("accent", "⚡ ") +
    theme.fg("toolTitle", `Sub-agent started — job ${jobId}`) +
    "\n" +
    theme.fg("dim", "  Use get_subagent_status to check progress.");
  return new Text(text, 0, 0);
}

// ── Schema ───────────────────────────────────────────────────────────

const BaseParams = Type.Object({
  task: Type.String({ description: "Task to delegate to the sub-agent" }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt (e.g. 'You are a senior TypeScript reviewer')",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Override model (e.g. 'anthropic/claude-sonnet-4-5'). Default: inherit from current session.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory (default: current cwd)",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({
      description:
        "Run subagent in background. Returns a jobId immediately instead of blocking. Use get_subagent_status to poll progress and get_subagent_result to retrieve output when ready. The main agent continues execution immediately — it does NOT wait for async sub-agents to complete. Use only if users asks to",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union(
      [
        Type.Literal("notify", {
          description:
            "Send a brief summary notification when the sub-agent completes (no turn triggered)",
        }),
        Type.Literal("inject", {
          description:
            "Inject the full result as a user message when the sub-agent completes (triggers a new turn)",
        }),
      ],
      {
        description:
          "When set, automatically deliver completion notification to the main agent. Only valid with async: true.",
      },
    ),
  ),
  maxAge: Type.Optional(
    Type.Number({
      description:
        "Optional TTL in milliseconds for completed job retention. Jobs persist indefinitely if omitted.",
    }),
  ),
});

const StatusParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const ResultParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const CancelParams = Type.Object({
  jobId: Type.String({
    description:
      "Job ID returned by async subagent_with_context or subagent_isolated spawn",
  }),
});

const InteractiveParams = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Display name for the sub-agent session. Defaults to a task preview.",
    }),
  ),
  task: Type.String({
    description: "Task to start in the interactive sub-agent",
  }),
  persona: Type.Optional(
    Type.String({
      description:
        "Optional persona / system prompt appended to the child Pi session",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Optional model override for the child Pi process",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the child Pi process" }),
  ),
  includeContext: Type.Optional(
    Type.Boolean({
      description:
        "Include serialized parent conversation in the initial child prompt. Default false to keep the child session small.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Spawn the sub-agent in a detached named window (hidden from your mux layout) instead of a visible horizontal split. Default true. Pass background: false for a side-by-side split you can watch in real time.",
    }),
  ),
  notifyOnComplete: Type.Optional(
    Type.Union([Type.Literal("notify"), Type.Literal("inject")], {
      description:
        'How to surface the sub-agent result on completion. "inject" (default) also injects output.md as a user message so the parent LLM processes it in its next turn. "notify" emits a UI hint only — no LLM turn is triggered. Falls back to a pointer hint if the inject cap is exceeded.',
    }),
  ),
  mux: Type.Optional(
    Type.Union(
      [Type.Literal("auto"), Type.Literal("tmux"), Type.Literal("zellij")],
      {
        description:
          'Which multiplexer backend to use. "auto" (default) picks based on environment: zellij if ZELLIJ_SESSION_NAME is set, tmux if TMUX is set, then whichever backend binary is available. "tmux" forces tmux. "zellij" forces zellij.',
      },
    ),
  ),
});

// ── Extension ────────────────────────────────────────────────────────

// ── Inject cap tracking ─────────────────────────────────────────
/** Track concurrent inject-mode notifications to prevent conversation explosion */
export function getInjectCount(): number {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  return (g2.__piSubagenturaInjectCount ?? 0) as number;
}
function incrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount =
    ((g2.__piSubagenturaInjectCount ?? 0) as number) + 1;
}
function decrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount = Math.max(
    0,
    ((g2.__piSubagenturaInjectCount ?? 0) as number) - 1,
  );
}

/** Max concurrent inject-mode notifications before degrading to notify */
export const MAX_INJECT = 5;

// ── Notification Delivery ───────────────────────────────────────
/**
 * Deliver async subagent completion notification.
 * Reads pi from globalThis to survive module reloads.
 */
function deliverNotification(jobState: JobState, result: SubagentResult): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  const pi = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
  if (!pi) return; // extension not loaded yet

  try {
    const summary = buildNotifySummary(jobState.id, result);

    if (jobState.notifyOnComplete === "inject") {
      // Check inject cap
      if ((getInjectCount() as number) >= MAX_INJECT) {
        // Degrade to notify mode silently
        pi.sendMessage!(
          {
            customType: "subagent-notify",
            content: `Inject cap exceeded for job ${jobState.id} — degraded to notify. ${summary}`,
            display: true,
            details: { jobId: jobState.id, result, mode: "notify" },
          },
          { deliverAs: "followUp" },
        );
        return;
      }
      incrementInjectCount();
      try {
        // Inject full result as user message
        (pi as any).sendUserMessage?.(
          result.output || "(sub-agent produced no output)",
          {
            deliverAs: "followUp",
          },
        );
        // Also send a summary notification
        pi.sendMessage!(
          {
            customType: "subagent-notify",
            content: `⚡ Sub-agent **${jobState.id}** completed — result injected above. ${summary}`,
            display: true,
            details: { jobId: jobState.id, result, mode: "inject" },
          },
          { deliverAs: "followUp" },
        );
      } finally {
        decrementInjectCount();
      }
    } else {
      // notify mode
      pi.sendMessage!(
        {
          customType: "subagent-notify",
          content: summary,
          display: true,
          details: { jobId: jobState.id, result, mode: "notify" },
        },
        { deliverAs: "followUp" },
      );
    }
  } catch {
    // pi may be stale after session replacement
  }

  jobState.notificationDelivered = true;
}

// ── Interactive (tmux-backed) artifact poller ───────────────────

/** True when the event should trigger a wakeup notification to the parent. */
function shouldNotify(event: SubagentEvent): boolean {
  return (
    event.type === "done" ||
    event.type === "error" ||
    event.type === "cancelled"
  );
}

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

/** Format a single TUI widget row for a running sub-agent. */
function formatActivityRow(state: InteractiveSubagentState): string {
  const ago = state.lastActivityAt
    ? ` (${agoStr(Date.now() - state.lastActivityAt)})`
    : "";
  const summary = state.lastToolSummary ?? "starting…";
  return `▶ ${state.name}: ${summary}${ago}`;
}

function agoStr(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/** Build the LLM-facing notification content. Pointer paths always; error body inlined. */

function buildArtifactMessage(
  state: InteractiveSubagentState,
  event: SubagentEvent,
): string {
  const header = `${iconFor(event)} ${state.name} (${state.id}) — ${labelFor(event)}`;
  const outputPath = join(state.artifactDir, "output.md");
  const logPath = join(state.artifactDir, "events.ndjson");
  const pointer = `\nOutput: ${outputPath}\nActivity log: ${logPath}`;
  let body = "";
  if (event.type === "error") {
    body = `\n${sanitizeOutput((event.message ?? "unknown error").slice(0, 500))}`;
  }

  return `${header}${body}${pointer}`;
}

/** Send a single pointer-only notification for one artifact event.
 * Returns true if the notification was sent, false on failure (stale pi context). */
function deliverArtifactNotification(
  pi: ExtensionAPI,
  state: InteractiveSubagentState,
  event: SubagentEvent,
): boolean {
  try {
    pi.sendMessage!(
      {
        customType: "subagent-notify",
        content: buildArtifactMessage(state, event),
        display: true,
        details: { subagentId: state.id, event },
      },
      { deliverAs: "followUp" },
    );
    return true;
  } catch {
    // pi may be stale after session replacement
    return false;
  }
}

/** Assert that a value is never (exhaustiveness checker). */
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

function iconFor(event: SubagentEvent): string {
  switch (event.type) {
    case "started":
    case "tool_activity":
      return "▶";
    case "done":
      return event.exitCode === 0 ? "✅" : "❌";
    case "error":
      return "❌";
    case "cancelled":
      return "🚫";
    default:
      return assertNever(event);
  }
}

function labelFor(event: SubagentEvent): string {
  switch (event.type) {
    case "tool_activity":
      return "activity";
    case "done":
      return `done (exit ${event.exitCode ?? "?"})`;
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    // "started" is intentionally dropped — it would only fire on the very first poll
    // and the widget row is a better signal than a one-shot message.
    case "started":
      return "started";
    default:
      return assertNever(event);
  }
}
/**
 * Find an artifact dir for an id that isn't in the current registry. We can't use the
 * registry (it's lost across process restarts) so we ask the file system. We scan the
 * default artifacts root (PI_CODING_AGENT_SESSION_DIR or ~/.pi/agent/sessions/subagentura).
 * For v1 this is a best-effort lookup; a future iteration can track all artifact roots.
 */
import isPathInside from "is-path-inside";

export function findArtifactById(id: string): SubagentArtifact | null {
  // Sub-agent ids are randomBytes(4).toString("hex") at spawn time, i.e. 8 hex
  // chars. Validate the id before joining it into a path so that an
  // LLM-supplied id like "../../../etc" can't escape the artifact root
  // (path.join normalises "..", so a malicious id would otherwise resolve
  // to a sibling directory and get exfiltrated to the parent LLM via
  // read_subagent_artifact).
  if (!/^[a-f0-9]{8}$/.test(id)) return null;

  const root =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  // Resolve the root once, with symlinks followed, so the containment check below
  // is anchored on the real on-disk location. realpathSync throws if root doesn't
  // exist; in that case there's nothing for us to find.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  let topLevel: string[];
  try {
    topLevel = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of topLevel) {
    const candidate = join(root, entry, "artifacts", id);
    try {
      if (statSync(candidate).isDirectory()) {
        // statSync follows symlinks, so a symlink at
        // <root>/<cwd>/artifacts/<id> pointing outside the artifact root
        // would otherwise be returned as a valid artifact. Resolve the
        // candidate with realpath and verify it is still inside the
        // resolved root. realpathSync is safe here because statSync
        // above already confirmed candidate exists as a directory.
        let realCandidate: string;
        try {
          realCandidate = realpathSync(candidate);
        } catch {
          continue;
        }
        if (!isPathInside(realCandidate, realRoot)) continue;
        return artifactPath(join(root, entry, "artifacts"), id);
      }
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Rehydrate orphan interactive sub-agents from the on-disk state file.
 *
 * Reads <cwd>/.pi/subagentura-state.json, reconstructs each
 * InteractiveSubagentState, sets its status via the existing
 * deriveInteractiveSubagentStatus matrix (lastEvent + isPaneAlive), registers
 * it, and resets runtime cursors so the existing poller backlog-catch-up path
 * replays any events that landed during downtime.
 *
 * Idempotent — skips ids already in the registry. Designed to be called from
 * the session_start handler. The first poll tick after this returns sees
 * the rehydrated states and replays any backlog.
 */
export function rehydrateInteractiveSubagents(
  cwd: string,
  currentSessionId?: string,
): {
  total: number;
  alive: number;
  terminal: number;
} {
  const payload = loadInteractiveStates(cwd);
  if (!payload) return { total: 0, alive: 0, terminal: 0 };
  let alive = 0;
  let terminal = 0;
  for (const entry of Object.values(payload.states) as Array<
    import("./artifact").InteractiveSubagentPersistedStateV1
  >) {
    if (currentSessionId && entry.parentSessionId !== currentSessionId) {
      continue;
    }
    if (interactiveSubagentRegistry.has(entry.id)) continue;
    // ── Recover display fields from on-disk files ──
    // Recovery is best-effort and must never throw; on missing files we
    // fall back to placeholder values (entry.id for name, 0 for startedAt).
    const art = artifactPath(
      dirname(entry.artifactDir),
      basename(entry.artifactDir),
    );

    let recoveredName: string;
    try {
      const files = readdirSync(entry.artifactDir);
      const promptFile = files.find((f) => f.endsWith("-prompt.md"));
      recoveredName = promptFile
        ? promptFile.slice(0, -"-prompt.md".length)
        : entry.id;
    } catch {
      recoveredName = entry.id;
    }

    let startedAt: number;
    try {
      const events = readEvents(art);
      startedAt = events.length > 0 ? events[0].ts : 0;
    } catch {
      startedAt = 0;
    }

    const attach = (() => {
      try {
        return buildAttachCommandsForState(entry);
      } catch {
        return { attachCommand: "", focusCommand: "" };
      }
    })();

    const rehydrated: InteractiveSubagentState = {
      id: entry.id,
      name: recoveredName,
      task: "",
      paneId: entry.paneId,
      windowName: entry.windowName,
      mux: entry.mux,
      muxSession: entry.muxSession,
      sessionFile: entry.sessionFile,
      cwd,
      startedAt,
      status: "running",
      attachCommand: attach.attachCommand,
      selectPaneCommand: attach.focusCommand,
      launchScriptFile: "",
      artifactDir: entry.artifactDir,
      notifyOnComplete: entry.notifyOnComplete,
      parentSessionId: "pi",
      // All runtime cursors reset (replay-all semantics).
      lastDeliveredEventTs: 0,
      lastDeliveredSessionByte: 0,
      lastInjectedEventTs: undefined,
      lastSnapshotEventTs: undefined,
      injected: undefined,
      autoDoneForTurnAt: undefined,
      lastStopReason: undefined,
      lastStopReasonAt: undefined,
      lastStopText: undefined,
    };
    const last = lastEvent(art);
    const paneAlive = isPaneAlive(rehydrated);
    const next = deriveInteractiveSubagentStatus(last, paneAlive);
    rehydrated.status = next;
    // For inject-mode orphans, set lastInjectedEventTs to the most recent
    // event's ts so the existing terminal event is NOT re-injected on the
    // first poll after rehydrate. Without this, every parent reload would
    // flood the new parent LLM with user messages for orphans from the
    // previous session. Future follow-up `done` events (higher ts) on the
    // same orphan will still inject, which is the right behavior.
    if (entry.notifyOnComplete === "inject" && last) {
      rehydrated.lastInjectedEventTs = last.ts;
    }
    if (next === "exited" || next === "cancelled") terminal++;
    else if (next === "running" || next === "idle") alive++;
    interactiveSubagentRegistry.set(entry.id, rehydrated);
  }
  return { total: Object.keys(payload.states).length, alive, terminal };
}

function sanitizeOutput(text: string): string {
  return text.replace(
    /(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|-----BEGIN[\s\w]+KEY-----|AKIA[\w]{16}|ghp_[\w]{36}|gho_[\w]{36}|ghu_[\w]{36}|xox[abp]-[\w-]+|AIza[\w-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    "[REDACTED]",
  );
}

function buildNotifySummary(jobId: string, result: SubagentResult): string {
  const status = result.isError ? "❌" : "✅";
  const msg = result.isError
    ? result.errorMessage || result.output.slice(0, 200).replace(/\s+/g, " ")
    : "done";

  const sanitized = sanitizeOutput(msg);

  const usageStr = formatUsage(result.usage);
  const summary = `${status} Job ${jobId} ${sanitized.slice(0, 300)}`;
  if (usageStr) {
    return `${summary} (${usageStr})`;
  }
  return summary;
}
// ── Notification TUI Renderer ──────────────────────────────────
function renderSubagentNotify(
  message: { content?: string; details?: unknown },
  options: { expanded?: boolean },
  theme: Theme,
): Text {
  const details = message.details as
    | { mode?: string; result?: SubagentResult }
    | undefined;
  const isInject = details?.mode === "inject";
  const isError = details?.result?.isError;
  const text = message.content ?? "";

  let line: string;
  if (!options.expanded) {
    line = isError ? theme.fg("error", text) : theme.fg("accent", text);
  } else {
    const output = sanitizeOutput(
      (details?.result?.output ?? "").slice(0, 500).replace(/\s+/g, " "),
    );
    const header = isInject
      ? theme.fg("accent", "⚡ Injected Sub-agent Result")
      : isError
        ? theme.fg("error", "❌ Sub-agent Failed")
        : theme.fg("success", "✅ Sub-agent Completed");
    const body = theme.fg("dim", text);
    line = `${header}\n${body}\n${output}`;
  }
  return new Text(line, 0, 0);
}

export default function (pi: ExtensionAPI) {
  // Persist pi ref for async notification delivery (survives module reload)
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaInjectCount = 0;

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    g2.__piSubagenturaUi = ctx.ui;
    // Rehydrate on startup (resumed session after quit), reload, and resume.
    // The session ID filter ensures only subagents created in this specific session
    // are rehydrated. On 'new' and 'fork' we skip — those are explicit fresh starts.
    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      try {
        rehydrateInteractiveSubagents(
          ctx.cwd,
          ctx.sessionManager?.getSessionId?.(),
        );
      } catch {
        /* best effort — rehydrate is a recovery path; failures fall back to empty registry */
      }
    }
  });

  pi.on("session_shutdown", () => {
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // Register notification renderer before any tools
  // One global interval for the whole session. Each tick walks the artifact dir of
  // every running interactive sub-agent and fires pointer notifications for new events.
  // The poller survives parent restarts (artifacts on disk + per-state lastDeliveredEventTs).
  if (!g2.__piSubagenturaInteractivePollerHandle) {
    const handle = setInterval(() => pollArtifactChanges(pi), 5000);
    // Don't pin the event loop on a long-lived parent. unref() lets the process exit
    // cleanly when nothing else is keeping it alive (no other ref'd handles).
    handle.unref?.();
    g2.__piSubagenturaInteractivePollerHandle = handle;
  }
  // ── Tool 1: inherits conversation history ────────────────────────
  pi.registerTool({
    name: "subagent_with_context",
    label: "Sub-Agent (with context)",
    description: [
      "Spawn an in-process sub-agent that inherits the full conversation history.",
      "WARNING: Each call serializes the entire conversation into memory. Spawning many",
      "subagents with context in parallel can cause heap exhaustion (OOM).",
      "",
      "MEMORY-SAVING ALTERNATIVES:",
      "1. Use subagent_isolated for tasks that don't need full history",
      "2. Run few parallel subagents (1-3 at a time) instead of batching many",
      "3. Consider summarizing the context before passing to subagent",
      "",
      "The sub-agent sees everything discussed so far plus the new task.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Review this PR for security issues", persona: "You are a senior security auditor"',
      '  - task: "Continue debugging while we plan next steps", async: true, notifyOnComplete: "notify"',
      '  - task: "Summarize the key decisions made in this conversation", model: "anthropic/claude-sonnet-4-5"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use async only if user asked to do so or is willing to continue the conversation.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_with_context",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });

      // Gather conversation history
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

      // ── Async path ──
      if (params.async === true) {
        if (messages.length === 0) {
          return {
            content: [
              { type: "text", text: "No conversation history to inherit." },
            ],
            details: {},
          };
        }

        const llmMessages = convertToLlm(messages);
        const conversationText = serializeConversation(llmMessages);
        const targetCwd = params.cwd ?? ctx.cwd;

        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: conversationText,
          signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
        });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        jobRegistry.set(jobId, jobState);

        // Update footer
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
                model: undefined,
                isError: true,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: {
            jobId,
            status: "started",
            contextMessages: messages.length,
          },
        };
      }

      // ── Sync path ──
      if (messages.length === 0) {
        return {
          content: [
            { type: "text", text: "No conversation history to inherit." },
          ],
          details: {},
        };
      }

      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);

      const targetCwd = params.cwd ?? ctx.cwd;
      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        conversationText,
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: SubagentDetails = {
        status: result.isError ? "error" : "done",
        contextMessages: messages.length,
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_with_context");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 2: isolated, no conversation history ────────────────────
  pi.registerTool({
    name: "subagent_isolated",
    label: "Sub-Agent (isolated)",
    description: [
      "Spawn an in-process sub-agent with a fresh, empty context window.",
      "Only receives the task and optional persona. No conversation history.",
      "Model is inherited by default. Use the model param to override (e.g. 'minimax/MiniMax-M2.7').",
      "Use list_available_models to see which models have configured auth before setting model.",
      "Streams output in real-time when sync.",
      "",
      "Examples:",
      '  - task: "Propose a README outline for this repo", persona: "You are a technical writer"',
      '  - task: "Give me a second opinion on this approach", model: "anthropic/claude-sonnet-4-5"',
      '  - task: "Analyze this code without context contamination", async: true, notifyOnComplete: "inject"',
      "",
      "For async (background) execution, the main agent continues immediately.",
      "Use get_subagent_status to poll progress and get_subagent_result to collect output.",
    ].join("\n"),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_isolated",
        toolCallId: _toolCallId,
        async: params.async ?? false,
        taskLength: params.task?.length ?? 0,
        persona: params.persona ?? null,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        notifyOnComplete: params.notifyOnComplete ?? null,
        maxAge: params.maxAge ?? null,
      });

      // ── Async path ──
      if (params.async === true) {
        const targetCwd = params.cwd ?? ctx.cwd;

        const {
          jobId,
          jobPromise,
          session,
          liveStatus,
          modelLabel,
          modelWarning,
        } = await startSubagentJob({
          task: params.task,
          persona: params.persona,
          modelOverride: params.model,
          cwd: targetCwd,
          contextText: null, // isolated — no context
          signal: undefined, // async: don't inherit parent signal (would abort subagent when tool returns)
          onUpdate: undefined,
          defaultModel: ctx.model,
          maxAge: params.maxAge,
          parentModelRegistry: ctx.modelRegistry,
        });
        const jobState: JobState = {
          id: jobId,
          status: "running",
          liveStatus,
          session,
          startedAt: Date.now(),
          promise: jobPromise,
          modelLabel,
          notifyOnComplete:
            params.notifyOnComplete === "inject"
              ? "inject"
              : params.notifyOnComplete === "notify"
                ? "notify"
                : undefined,
          notificationDelivered: false,
          maxAge: params.maxAge,
        };

        // Register job FIRST, then wire completion handler with cancellation guard.
        // Note: jobPromise never rejects (internal catch handles all errors).
        jobRegistry.set(jobId, jobState);

        // Update footer to show running subagents
        const runningCount = [...jobRegistry.values()].filter(
          (j) => j.status === "running",
        ).length;
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${runningCount} sub-agent${runningCount > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }

        jobPromise.then(
          (result) => {
            if (jobState.status === "cancelled") return;
            jobState.status = result.isError ? "error" : "done";
            jobState.result = result;
            scheduleJobCleanup(jobId, false, jobState.maxAge);

            // Deliver notification if requested
            if (
              jobState.notifyOnComplete &&
              !jobState.notificationDelivered &&
              !jobState.resultRetrieved
            ) {
              deliverNotification(jobState, result);
            }

            // Update or clear footer status
            const remaining = [...jobRegistry.values()].filter(
              (j) => j.status === "running",
            ).length;
            if (remaining > 0) {
              try {
                ctx.ui.setStatus(
                  FOOTER_KEY,
                  `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
                );
              } catch {
                /* ctx stale */
              }
            } else {
              try {
                ctx.ui.setStatus(FOOTER_KEY, undefined);
              } catch {
                /* ctx stale */
              }
            }
          },
          (error) => {
            // Promise rejection handler — deliver failure notification
            if (jobState.notifyOnComplete && !jobState.notificationDelivered) {
              deliverNotification(jobState, {
                output: `Sub-agent crashed: ${error instanceof Error ? error.message : String(error)}`,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                },
                model: undefined,
                isError: true,
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              });
            }
          },
        );

        return {
          content: [
            {
              type: "text",
              text:
                `Job ${jobId} started. The main agent continues — use get_subagent_status to check progress and get_subagent_result to collect output when ready.` +
                (modelWarning ? `\n\n${modelWarning}` : ""),
            },
          ],
          details: { jobId, status: "started" },
        };
      }

      // ── Sync path ──
      const targetCwd = params.cwd ?? ctx.cwd;

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        null, // no context
        signal,
        onUpdate,
        ctx.model,
        ctx.modelRegistry,
      );

      const usageStr = formatUsage(result.usage, result.model);
      const details: SubagentDetails = {
        status: result.isError ? "error" : "done",
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme, "subagent_isolated");
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 3: poll async job status ────────────────────────────────
  pi.registerTool({
    name: "get_subagent_status",
    label: "Get Subagent Status",
    description:
      "Poll an async subagent job by jobId. Returns live preview of the subagent's current turn, active tool, and output.",
    parameters: StatusParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      debugLog("info", "tool_call", {
        toolName: "get_subagent_status",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      const job = jobRegistry.get(params.jobId);

      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }

      if (job.status === "done" || job.status === "error") {
        const result = job.result!;
        const usageStr = formatUsage(result.usage, result.model);
        return {
          content: [{ type: "text", text: result.output }],
          details: {
            status: job.status,
            usage: result.usage,
            model: result.model,
            usageSummary: usageStr,
          },
          isError: result.isError,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            { type: "text", text: `Job ${params.jobId} was cancelled.` },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      // Job is running — return live preview
      return buildLiveUpdate(job.liveStatus, job.modelLabel);
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_status ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      const details = result.details as SubagentDetails | undefined;
      if (details?.status === "running") {
        // Force isPartial to get the live preview rendering
        return renderSubagentResult(
          result,
          { ...options, isPartial: true },
          theme,
          context,
        );
      }
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 4: block until async job completes ──────────────────────
  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Block until an async subagent job completes, then return the final output and usage summary.",
    parameters: ResultParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const job = jobRegistry.get(params.jobId);
      debugLog("info", "tool_call", {
        toolName: "get_subagent_result",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      if (!job) {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} not found. It may have been cancelled.`,
            },
          ],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      // Await the job promise. If already settled, resolves immediately.
      // If still running, blocks until completion.
      // Set resultRetrieved BEFORE await to suppress redundant notification
      // (microtask ordering ensures .then() checks this before delivering)
      job.resultRetrieved = true;
      const result = await job.promise;

      // Re-check status: if cancelled during await, return cancelled message
      // rather than the AbortError from the promise chain.
      // TypeScript narrows job.status after the earlier check, but cancellation
      // can happen during the await, so we cast back to the full union.
      if ((job.status as JobStatus) === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was cancelled before completion.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
          isError: true,
        };
      }

      const usageStr = formatUsage(result.usage, result.model);
      const details: SubagentDetails = {
        status: result.isError ? "error" : "done",
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details,
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("get_subagent_result ")) +
        theme.fg("accent", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });

  // ── Tool 5: cancel a running async job ───────────────────────────
  pi.registerTool({
    name: "cancel_subagent",
    label: "Cancel Subagent",
    description: "Abort a running async subagent job by jobId.",
    parameters: CancelParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = jobRegistry.get(params.jobId);
      debugLog("info", "tool_call", {
        toolName: "cancel_subagent",
        toolCallId: _toolCallId,
        jobId: params.jobId,
      });

      if (!job) {
        return {
          content: [{ type: "text", text: `Job ${params.jobId} not found.` }],
          details: { jobId: params.jobId },
          isError: true,
        };
      }

      if (job.status === "cancelled") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} was already cancelled.`,
            },
          ],
          details: { jobId: params.jobId, status: "cancelled" },
        };
      }

      if (job.status === "done" || job.status === "error") {
        return {
          content: [
            {
              type: "text",
              text: `Job ${params.jobId} already completed — cannot cancel.`,
            },
          ],
          details: { jobId: params.jobId, status: job.status },
          isError: true,
        };
      }

      // Abort the session
      try {
        await job.session.abort();
      } catch {
        // Session may already be disposed; abort is best-effort
      }

      // Mark cancelled and remove immediately
      job.status = "cancelled";
      scheduleJobCleanup(params.jobId, true); // immediate removal

      // Update footer status
      const remaining = [...jobRegistry.values()].filter(
        (j) => j.status === "running",
      ).length;
      if (remaining > 0) {
        try {
          ctx.ui.setStatus(
            FOOTER_KEY,
            `⚡ ${remaining} sub-agent${remaining > 1 ? "s" : ""} running`,
          );
        } catch {
          /* ctx stale */
        }
      } else {
        try {
          ctx.ui.setStatus(FOOTER_KEY, undefined);
        } catch {
          /* ctx stale */
        }
      }

      return {
        content: [{ type: "text", text: `Job ${params.jobId} cancelled.` }],
        details: { jobId: params.jobId, status: "cancelled" },
      };
    },

    renderCall(args, theme) {
      const jobId = String(args.jobId ?? "");
      const text =
        theme.fg("toolTitle", theme.bold("cancel_subagent ")) +
        theme.fg("error", jobId);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as
        | (SubagentDetails & { jobId?: string })
        | undefined;
      const jobId = String(details?.jobId ?? "unknown");
      const cancelled = details?.status === "cancelled";
      const firstContent = result.content?.[0];
      const message =
        firstContent?.type === "text"
          ? firstContent.text
          : `Job ${jobId} not found`;
      const text = cancelled
        ? theme.fg("error", `✕ Job ${jobId} cancelled`)
        : theme.fg("error", message);
      return new Text(text, 0, 0);
    },
  });

  // ── Tool 6: spawn an attachable mux-backed Pi session ──────────────
  pi.registerTool({
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: [
      "Spawn a separate Pi process in a tmux/zellij pane and return immediately.",
      "Use this when the user wants to attach to the sub-agent session and continue follow-ups there.",
      "Works inside tmux or zellij. The tool returns attach/focus commands and the child session file.",
      "This is intentionally separate from SDK subagents: it favors observability and attachability over in-process execution.",
    ].join("\n"),
    parameters: InteractiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      debugLog("info", "tool_call", {
        toolName: "subagent_interactive",
        toolCallId: _toolCallId,
        taskLength: params.task?.length ?? 0,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        includeContext: params.includeContext ?? false,
      });

      let contextText: string | null = null;
      if (params.includeContext === true) {
        const branch = ctx.sessionManager.getBranch();
        const messages = branch
          .filter(
            (e): e is typeof e & { type: "message" } => e.type === "message",
          )
          .map((e) => e.message);
        contextText = serializeConversation(convertToLlm(messages));
      }

      const taskPreview = params.task.replace(/\s+/g, " ").slice(0, 48);
      const name = params.name ?? `Subagent: ${taskPreview || "interactive"}`;
      const targetCwd = params.cwd ?? ctx.cwd;

      try {
        const state = launchInteractiveSubagent({
          name,
          task: params.task,
          persona: params.persona,
          model: params.model,
          cwd: targetCwd,
          contextText,
          background: params.background, // defaults to true (hidden) inside the helper
          notifyOnComplete: params.notifyOnComplete ?? "inject",
          muxPreference: params.mux, // pass through user's mux preference
          parentSessionId: ctx.sessionManager.getSessionId(),
        });

        const displayMode = state.windowName
          ? "background (new window/tab)"
          : "visible split";
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${state.id} started (${displayMode}) in ${state.mux} pane ${state.paneId}.\n\nArtifact: ${state.artifactDir}\nAttach: ${state.attachCommand}\nFocus: ${state.selectPaneCommand}\nSession: ${state.sessionFile}`,
            },
          ],
          details: { ...state, status: "started" },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to start interactive sub-agent: ${msg}\n${tmuxSetupHint()}`,
            },
          ],
          details: { status: "error", error: msg },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const task = String(args.task ?? "");
      const preview = task.length > 60 ? `${task.slice(0, 57)}…` : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent_interactive ")) +
          theme.fg("accent", String(args.name ?? preview)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | Partial<InteractiveSubagentState>
        | undefined;
      if ((result as any).isError) {
        const first = result.content?.[0];
        const text =
          first?.type === "text"
            ? first.text
            : "Failed to start interactive sub-agent";
        return new Text(theme.fg("error", text), 0, 0);
      }
      const id = details?.id ?? "unknown";
      const paneId = details?.paneId ?? "unknown";
      return new Text(
        theme.fg("accent", "⚡ ") +
          theme.fg("toolTitle", `Interactive sub-agent ${id}`) +
          theme.fg("dim", ` — pane ${paneId}`),
        0,
        0,
      );
    },
  });

  // ── Tool 7: inspect attachable tmux-backed sessions ────────────────
  pi.registerTool({
    name: "get_interactive_subagent_status",
    label: "Get Interactive Subagent Status",
    description:
      "Inspect tmux-backed interactive subagents. Omit jobId to list all tracked sessions. Returns attach/select commands and session paths without capturing pane output.",
    parameters: Type.Object({
      jobId: Type.Optional(
        Type.String({
          description:
            "Interactive sub-agent ID returned by subagent_interactive",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = params.jobId
        ? [interactiveSubagentRegistry.get(params.jobId)].filter(
            (s): s is InteractiveSubagentState => Boolean(s),
          )
        : [...interactiveSubagentRegistry.values()];

      if (states.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: params.jobId
                ? `Interactive sub-agent ${params.jobId} not found.`
                : "No interactive sub-agents are tracked.",
            },
          ],
          details: { status: "not_found", jobId: params.jobId },
          isError: Boolean(params.jobId),
        };
      }

      const sections = states.map((state) => {
        return formatInteractiveState(state);
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: {
          count: states.length,
          subagents: states.map((state) => ({ ...state })),
        },
      };
    },
  });

  // ── Tool 8: cancel an attachable tmux-backed session ───────────────
  pi.registerTool({
    name: "cancel_interactive_subagent",
    label: "Cancel Interactive Subagent",
    description: "Kill the tmux pane for an interactive sub-agent by ID.",
    parameters: Type.Object({
      jobId: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      const state = cancelInteractiveSubagent(params.jobId);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.jobId} not found.`,
            },
          ],
          details: { jobId: params.jobId, status: "not_found" },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Interactive sub-agent ${params.jobId} cancelled.`,
          },
        ],
        details: { ...state },
      };
    },
  });

  // ── Tool: send a follow-up message to a live interactive sub-agent ──────
  // The child REPL stays open after `done` (see buildChildSubagentProtocol in
  // interactive-tmux.ts), so the parent can push a new prompt into the same
  // session via tmux send-keys. Model context is preserved across messages —
  // this is a true follow-up turn, not a fresh spawn.
  //
  // Caps: the message must be non-empty (an empty Enter in the REPL would submit a
  // blank prompt) and at most MAX_FOLLOWUP_BYTES UTF-8 bytes (symmetric with
  // MAX_PERSONA_BYTES in interactive-tmux.ts — 64 KiB is well above any realistic
  // follow-up prompt; larger values are rejected up-front with a structured error).
  const MAX_FOLLOWUP_BYTES = 64 * 1024;
  pi.registerTool({
    name: "send_interactive_subagent_message",
    label: "Send Interactive Subagent Message",
    description: [
      "Send a follow-up prompt to a live interactive sub-agent. The message is delivered into the",
      "child's existing REPL via tmux send-keys, so the child's model context is preserved — this",
      "is a true follow-up turn, not a fresh spawn. The child will run the new turn and (per its",
      "system prompt) call '$ARTIFACT_DIR/cli.mjs done 0' again when it finishes. Use",
      "get_interactive_subagent_status to check the pane state first if you're not sure it's still alive.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      message: Type.String({
        description:
          "The follow-up prompt text to send into the child's REPL (must be non-empty; max 64 KiB)",
      }),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape first for a precise error.
      if (!/^[a-f0-9]{8}$/.test(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      // Content validation (no registry I/O): fail fast on empty / oversized messages.
      // An empty message would submit a blank Enter in the child REPL; an oversized message
      // is more than the child can usefully consume and risks blowing the REPL history.
      if (params.message.trim().length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Message is empty; send a non-empty follow-up prompt.",
            },
          ],
          details: { id: params.id, status: "empty_message", messageLength: 0 },
          isError: true,
        };
      }
      const messageBytes = Buffer.byteLength(params.message, "utf8");
      if (messageBytes > MAX_FOLLOWUP_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Message too large: ${messageBytes} bytes (max ${MAX_FOLLOWUP_BYTES}). Shorten the prompt and try again.`,
            },
          ],
          details: {
            id: params.id,
            status: "message_too_large",
            messageLength: messageBytes,
            maxBytes: MAX_FOLLOWUP_BYTES,
          },
          isError: true,
        };
      }
      const state = interactiveSubagentRegistry.get(params.id);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} not found.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      // Accept both "running" (mid-turn) and "idle" (REPL open, between turns) — that's the whole
      // point of follow-up support. Mid-turn sends are safe: tmux send-keys just queues keystrokes
      // in the REPL input buffer, which submits when the current turn finishes.
      if (state.status !== "running" && state.status !== "idle") {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} is ${state.status}; follow-up messages can only be sent to running or idle sub-agents. Spawn a new one if needed.`,
            },
          ],
          details: { id: params.id, status: state.status },
          isError: true,
        };
      }
      // sendCommandToPane uses send-keys + Enter; it throws synchronously if the
      // pane is gone (e.g. the child exited between the status check and now).
      // Wrap so the parent gets a structured error instead of an exception trace.
      try {
        sendCommandToPane(state, params.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Failed to send message to interactive sub-agent ${params.id}: ${msg}`,
            },
          ],
          details: {
            id: params.id,
            status: "send_failed",
            paneId: state.paneId,
            error: msg,
          },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Sent follow-up to interactive sub-agent ${params.id} (${params.message.length} chars) in pane ${state.paneId}.`,
          },
        ],
        details: {
          id: params.id,
          paneId: state.paneId,
          messageLength: params.message.length,
          status: "sent",
        },
      };
    },
  });

  // ── Tool: read an interactive sub-agent's artifact ───────────────
  // The artifact (events.ndjson + output.md) is the source of truth for what the
  // sub-agent did. The main agent calls this when it wants to know more than the pointer.
  // The artifact (events.ndjson + output.md + output-N.md snapshots) is the source of truth for what
  // the sub-agent did. The main agent calls this when it wants to know more than the pointer.
  pi.registerTool({
    name: "read_subagent_artifact",
    label: "Read Subagent Artifact",
    description: [
      "Read an interactive sub-agent's artifact on disk. Returns the lifecycle events and,",
      "if present, the sub-agent's output.md (the latest turn's content) or a specific turn's snapshot.",
      "Use `since` (unix ms) to fetch only events newer than your last read. Use `turn` to read a",
      "specific historical turn's output-N.md instead of the latest output.md.",
    ].join("\n"),
    parameters: Type.Object({
      id: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
      since: Type.Optional(
        Type.Number({
          description: "Only return events with ts >= this unix-ms timestamp",
        }),
      ),
      includeOutput: Type.Optional(
        Type.Boolean({
          description:
            "Include the output (default true). Set false to fetch only events.",
        }),
      ),
      turn: Type.Optional(
        Type.Number({
          description:
            "Read a specific turn's output-N.md snapshot. Omit to read the latest output.md.",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape FIRST so a malformed id gets a precise error
      // instead of being collapsed into the generic "not found" message.
      if (!/^[a-f0-9]{8}$/.test(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 8 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      const state = interactiveSubagentRegistry.get(params.id);
      const art = state
        ? artifactPath(dirname(state.artifactDir), basename(state.artifactDir))
        : findArtifactById(params.id);
      if (!art) {
        return {
          content: [
            {
              type: "text",
              text: `No artifact found for sub-agent ${params.id}.`,
            },
          ],
          details: { id: params.id, status: "not_found" },
          isError: true,
        };
      }
      const events = readEvents(art, params.since);
      // `turn` reads a specific output-N.md snapshot; otherwise read the latest output.md. The turn
      // param implies includeOutput (you can't read a turn without wanting its content).
      const wantsOutput =
        params.includeOutput !== false || params.turn !== undefined;
      const output = wantsOutput
        ? params.turn !== undefined
          ? readOutputForTurn(art, params.turn)
          : readOutput(art)
        : null;
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;
      // Distinguish three cases when output is missing/empty so the caller
      // doesn't see a misleading "not written yet" after the sub-agent has
      // already exited (the common case: model finished without writing).
      let outputText: string;
      if (output === null) {
        if (params.turn !== undefined) {
          outputText = `(no snapshot for turn ${params.turn} — the poller may not have run yet, or this turn number is past the history)`;
        } else {
          const exited =
            lastEvent &&
            (lastEvent.type === "done" ||
              lastEvent.type === "error" ||
              lastEvent.type === "cancelled");
          outputText = exited
            ? `(sub-agent exited without writing output.md — last event: ${lastEvent.type} @ ${lastEvent.ts})`
            : `(${events.length} events, last: ${lastEvent ? `${lastEvent.type} @ ${lastEvent.ts}` : "(none)"} — output.md not written yet)`;
        }
      } else if (output.length === 0) {
        outputText = "(empty — 0 chars)";
      } else {
        outputText = `${output.length} chars`;
      }
      // Available turns summary so the caller knows what history exists.
      const availableTurns = listOutputTurns(art);
      const turnsLine =
        availableTurns.length > 0
          ? `Available turns: [${availableTurns.join(", ")}]\n`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Artifact for ${params.id} (${events.length} event${events.length === 1 ? "" : "s"}${params.since ? ` since ${params.since}` : ""}).\n` +
              `Last event: ${lastEvent ? `${lastEvent.type} @ ${lastEvent.ts}` : "(none)"}\n` +
              (params.turn !== undefined
                ? `Reading turn: ${params.turn}\n`
                : "") +
              turnsLine +
              `Output: ${outputText}`,
          },
        ],
        details: {
          id: params.id,
          artifactDir: art.dir,
          events,
          output,
          lastEvent,
          availableTurns,
        },
      };
    },
  });

  // ── Tool: list known interactive sub-agent artifacts ─────────────
  pi.registerTool({
    name: "list_subagent_artifacts",
    label: "List Subagent Artifacts",
    description: [
      "List all known interactive sub-agents (in this session and from past sessions whose",
      "artifacts are still on disk). Returns id, name, status, and last-update time. Use",
      "read_subagent_artifact to fetch a specific one.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute(): Promise<any> {
      pruneDeadInteractiveSubagents();
      const states = [...interactiveSubagentRegistry.values()];
      const summary = states.map((s) => {
        const art = artifactPath(
          dirname(s.artifactDir),
          basename(s.artifactDir),
        );
        const last = lastEvent(art);
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          lastEvent: last,
          lastUpdate: last?.ts,
          artifactDir: s.artifactDir,
        };
      });
      if (summary.length === 0) {
        return {
          content: [
            { type: "text", text: "No interactive sub-agents are tracked." },
          ],
          details: { count: 0, subagents: [] },
        };
      }
      const lines = summary.map((s) => {
        const ev = s.lastEvent;
        const evStr = ev
          ? `last: ${ev.type}${ev.message ? ` (${ev.message.slice(0, 60)})` : ""}`
          : "no events yet";
        return `${s.id}  ${s.name}  ${s.status}  ${evStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: summary.length, subagents: summary },
      };
    },
  });

  // ── Tool 6: list available models ────────────────────────────────
  pi.registerTool({
    name: "list_available_models",
    label: "List Available Models",
    description: [
      "List all available AI models that can be used with subagent_with_context or subagent_isolated.",
      "Returns provider/model IDs and auth status. Use this to validate model identifiers before passing",
      "them to subagent tools — prevents silent fallback to the parent session model.",
    ].join("\n"),
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({
          description:
            "Optional substring filter for provider or model name (case-insensitive)",
        }),
      ),
      authOnly: Type.Optional(
        Type.Boolean({
          description:
            "If true, only return models with configured auth (default: true). Set false to see all known models.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const modelRegistry = ctx.modelRegistry;
      debugLog("info", "tool_call", {
        toolName: "list_available_models",
        toolCallId: _toolCallId,
        authOnly: params.authOnly ?? true,
        filter: params.filter ?? null,
      });

      const models =
        params.authOnly !== false
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();

      let filtered = models;
      if (params.filter) {
        const f = params.filter.toLowerCase();
        filtered = models.filter(
          (m) =>
            m.provider.toLowerCase().includes(f) ||
            m.id.toLowerCase().includes(f) ||
            m.name?.toLowerCase().includes(f),
        );
      }

      const lines = filtered.map(
        (m) =>
          `${m.provider}/${m.id}` +
          (m.name && m.name !== m.id ? `  (${m.name})` : ""),
      );

      const summary =
        params.authOnly !== false
          ? `${filtered.length} model${filtered.length === 1 ? "" : "s"} with auth configured`
          : `${filtered.length} model${filtered.length === 1 ? "" : "s"} total`;

      return {
        content: [
          {
            type: "text",
            text:
              `${summary}\n\n` +
              lines.map((l) => `  ${l}`).join("\n") +
              (filtered.length === 0 ? "\n(no models match)" : ""),
          },
        ],
        details: {
          count: filtered.length,
          models: filtered.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: m.name,
          })),
        },
      };
    },
  });

  // ── Tool 7: prune completed jobs ─────────────────────────────────
  // ── Tool 6: prune completed jobs ─────────────────────────────────
  pi.registerTool({
    name: "prune_subagent_jobs",
    label: "Prune Subagent Jobs",
    description: [
      "Remove all completed and failed subagent jobs from the registry.",
      "Running and cancelled jobs are preserved.",
      "Returns the number of jobs removed.",
    ].join("\n"),
    parameters: Type.Object({}),

    async execute() {
      const before = jobRegistry.size;
      debugLog("info", "tool_call", {
        toolName: "prune_subagent_jobs",
      });

      const removed = pruneCompletedJobs();
      const after = jobRegistry.size;

      return {
        content: [
          {
            type: "text",
            text: `Removed ${removed} completed job${removed === 1 ? "" : "s"}. Registry: ${before} → ${after} jobs.`,
          },
        ],
        details: { removed, before, after },
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("prune_subagent_jobs")),
        0,
        0,
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as { removed?: number } | undefined;
      const removed = Number(details?.removed ?? 0);
      const text =
        removed > 0
          ? theme.fg(
              "success",
              `✓ Pruned ${removed} job${removed === 1 ? "" : "s"}`,
            )
          : theme.fg("dim", "No completed jobs to prune");
      return new Text(text, 0, 0);
    },
  });

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = typeof global !== "undefined" ? global : globalThis;

      // Stop the global poller so it doesn't fire after we're gone. Without
      // clearInterval the handle would keep the event loop alive across restarts.
      if (g2.__piSubagenturaInteractivePollerHandle) {
        try {
          clearInterval(g2.__piSubagenturaInteractivePollerHandle);
        } catch {
          /* defensive */
        }
        g2.__piSubagenturaInteractivePollerHandle = undefined;
      }
      // Snapshot running state objects BEFORE clearing. On /new and quit we
      // kill their panes after the registry is empty. On reload/resume we
      // intentionally preserve panes so the next session_start can rehydrate
      // them from the state file.
      const runningStates: InteractiveSubagentState[] = [];
      for (const state of interactiveSubagentRegistry.values()) {
        if (state.status === "running") runningStates.push(state);
      }

      // Drop in-memory state FIRST. An in-flight poll tick (dequeued from
      // setInterval before clearInterval ran) finds an empty registry and its
      // for-loop iterates over zero entries — no work, no notification delivery.
      try {
        interactiveSubagentRegistry.clear();
      } catch {
        /* best effort */
      }

      const preserveInteractivePanes =
        event?.reason === "reload" ||
        event?.reason === "resume" ||
        event?.reason === "quit";
      if (!preserveInteractivePanes) {
        // Kill the panes using the already-snapshotted states.
        // cancelInteractiveSubagentByState is used (not the id-based variant)
        // because the registry was already cleared above.
        for (const state of runningStates) {
          try {
            cancelInteractiveSubagentByState(state);
          } catch {
            /* best effort */
          }
        }
      }
      // Abort all running subagent sessions before clearing
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }
      jobRegistry.clear();
      g2.__piSubagenturaPiRef = undefined;
      g2.__piSubagenturaInjectCount = 0;
      // Clean-slate the state file on /new. On quit/reload/resume we KEEP the file so the
      // next session_start can rehydrate the sub-agents (their panes survive).
      if (event?.reason === "new" && ctx?.cwd) {
        try {
          deleteInteractiveStatesFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );
}

// ── Re-exports ───────────────────────────────────────────────────────
// Re-export helpers so external consumers (e.g. tests importing from subagent.ts)
// don't need to know about the internal helpers.ts split.
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async exports ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { interactiveSubagentRegistry } from "./interactive-tmux";
