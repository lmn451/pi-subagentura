import {
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import isPathInside from "is-path-inside";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  artifactPath,
  isArtifactOutputSettled,
  lastEvent,
  listOutputHistory,
  listOutputTurns,
  readEvents,
  readOutput,
  readOutputForTurnId,
  readOutputForTurn,
  type SubagentArtifact,
} from "../artifact";
import {
  cancelInteractiveSubagent,
  formatInteractiveState,
  interactiveSubagentRegistry,
  interactiveStatusForState,
  isInteractiveStateActive,
  launchInteractiveSubagent,
  pruneDeadInteractiveSubagents,
  sendCommandToPane,
  tmuxSetupHint,
  type InteractiveSubagentState,
} from "../interactive-tmux";
import { debugLog } from "../helpers";
import {
  completionTriggersTurn,
  formatCompletionDeliveryBehavior,
} from "../notifications";
import { InteractiveParams } from "../schemas";
import { updateRunningSubagentFooter } from "../artifact-poller";

const SUBAGENT_ID_INVALID_CHAR_RE = /[^a-f0-9]/;
function isValidSubagentId(id: string): boolean {
  return id.length === 16 && !SUBAGENT_ID_INVALID_CHAR_RE.test(id);
}
const MAX_FOLLOWUP_BYTES = 64 * 1024;
const MAX_FOLLOWUP_PREVIEW_CHARS = 500;
const FOLLOWUP_COMPLETION_REMINDER =
  ' [MANDATORY COMPLETION PROTOCOL FOR EVERY FOLLOW-UP TURN: Before sending your final assistant response, write the result to output.md; make "$ARTIFACT_DIR/cli.mjs" done 0 your final tool call and wait for success. If it fails, do not send the final response; fix the cause and retry until completion is recorded. Do not rely on the lifecycle hook.]';

function formatFollowupPreview(message: string): string {
  if (message.length <= MAX_FOLLOWUP_PREVIEW_CHARS) return message;
  return `${message.slice(0, MAX_FOLLOWUP_PREVIEW_CHARS)}… [truncated; ${message.length} chars total]`;
}

export function findArtifactById(id: string): SubagentArtifact | null {
  // Sub-agent ids are randomBytes(8).toString("hex") at spawn time, i.e. 16
  // lowercase hex chars. Validate the id before joining it into a path so that an
  // LLM-supplied id like "../../../etc" can't escape the artifact root
  // (path.join normalises "..", so a malicious id would otherwise resolve
  // to a sibling directory and get exfiltrated to the parent LLM via
  // read_subagent_artifact).
  if (!isValidSubagentId(id)) return null;

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

function getArtifactForState(
  state: Pick<InteractiveSubagentState, "artifactDir">,
): SubagentArtifact {
  return artifactPath(dirname(state.artifactDir), basename(state.artifactDir));
}

export function registerInteractiveSubagentTools(pi: ExtensionAPI): void {
  // ── Tool 6: spawn an attachable mux-backed Pi session ──────────────
  pi.registerTool({
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: [
      "Spawn a separate Pi process in a tmux/zellij pane and return immediately.",
      "Use this when the user wants to attach to the sub-agent session and continue follow-ups there.",
      "Works inside tmux or zellij. The tool returns attach/focus commands and the child session file.",
      "This is intentionally separate from SDK subagents: it favors observability and attachability over in-process execution.",
      "Both completion modes show the user a notification.",
      'Defaults: notifyOnComplete="notify" and triggerTurnOnComplete=true.',
      "The default stores only an artifact pointer (output is not injected) and automatically starts the next parent turn after pointer delivery.",
      "Explicit triggerTurnOnComplete=false disables the automatic turn for either mode.",
    ].join("\n"),
    parameters: InteractiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const completionMode = params.notifyOnComplete ?? "notify";
      const triggerTurn = completionTriggersTurn(
        completionMode,
        params.triggerTurnOnComplete ?? true,
      );
      debugLog("info", "tool_call", {
        toolName: "subagent_interactive",
        toolCallId: _toolCallId,
        taskLength: params.task?.length ?? 0,
        model: params.model ?? null,
        cwd: params.cwd ?? ctx.cwd,
        includeContext: params.includeContext ?? false,
        notifyOnComplete: completionMode,
        triggerTurnOnComplete: triggerTurn,
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
          notifyOnComplete: completionMode,
          triggerTurnOnComplete: triggerTurn,
          muxPreference: params.mux, // pass through user's mux preference
          parentCwd: ctx.cwd,
          parentSessionId: ctx.sessionManager.getSessionId(),
          thinkingLevel: params.thinkingLevel,
        });
        updateRunningSubagentFooter(ctx.ui);

        const displayMode = state.windowName
          ? "background (new window/tab)"
          : "visible split";
        const locationLines = [`Artifact: ${state.artifactDir}`];
        if (!(state.mux === "tmux" && process.env.TMUX)) {
          locationLines.push(`Attach: ${state.attachCommand}`);
        }
        locationLines.push(`Focus: ${state.selectPaneCommand}`);
        locationLines.push(`Session: ${state.sessionFile}`);
        return {
          content: [
            {
              type: "text",
              text:
                `Interactive sub-agent ${state.id} started (${displayMode}) in ${state.mux} pane ${state.paneId}.\n\n` +
                `${formatCompletionDeliveryBehavior(completionMode, triggerTurn, "planned")}\n\n` +
                locationLines.join("\n"),
            },
          ],
          details: {
            ...state,
            status: "started",
            thinkingLevel: params.thinkingLevel,
          },
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
        | (Partial<InteractiveSubagentState> & { thinkingLevel?: string })
        | undefined;
      const id = details?.id ?? "unknown";
      const paneId = details?.paneId ?? "unknown";
      const thinking = details?.thinkingLevel
        ? ` · thinking: ${details.thinkingLevel}`
        : "";
      if ((result as any).isError) {
        const first = result.content?.[0];
        const text =
          first?.type === "text"
            ? first.text
            : "Failed to start interactive sub-agent";
        return new Text(theme.fg("error", text), 0, 0);
      }
      return new Text(
        theme.fg("accent", "⚡ ") +
          theme.fg("toolTitle", `Interactive sub-agent ${id}`) +
          theme.fg("dim", ` — pane ${paneId}${thinking}`),
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

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      await pruneDeadInteractiveSubagents();
      updateRunningSubagentFooter(ctx.ui);
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
    description:
      "Kill an interactive sub-agent pane. The tool result acknowledges parent-initiated cancellation, so artifacts are retained without injecting a duplicate cancellation completion into LLM context.",
    parameters: Type.Object({
      jobId: Type.String({
        description:
          "Interactive sub-agent ID returned by subagent_interactive",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
      const state = cancelInteractiveSubagent(params.jobId);
      let userNotification: string;
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
      updateRunningSubagentFooter(ctx.ui);
      const snapshotText = state.cancellationSnapshot?.path
        ? ` Snapshot ${state.cancellationSnapshot.status}: ${state.cancellationSnapshot.path}`
        : state.cancellationSnapshot?.error
          ? ` Snapshot error: ${state.cancellationSnapshot.error}`
          : "";
      userNotification =
        `Interactive sub-agent ${params.jobId} cancelled; no separate cancellation completion was injected into the parent LLM. ` +
        `Artifacts retained at ${state.artifactDir}.${snapshotText}`;
      try {
        ctx.ui.notify(userNotification, "warning");
      } catch {
        /* cancellation succeeded; a stale UI must not turn it into a tool failure */
      }
      return {
        content: [
          {
            type: "text",
            text:
              `Interactive sub-agent ${params.jobId} cancelled. ` +
              `No separate cancellation completion will be injected into the parent LLM. ` +
              `Artifacts retained at ${state.artifactDir}.` +
              (state.cancellationSnapshot?.path
                ? ` Snapshot ${state.cancellationSnapshot.status}: ${state.cancellationSnapshot.path}.`
                : state.cancellationSnapshot?.error
                  ? ` Snapshot error: ${state.cancellationSnapshot.error}.`
                  : ""),
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
      if (!isValidSubagentId(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 16 lowercase hex chars.`,
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
      // Accept both running and idle states. The compatibility status comes
      // from the lifecycle kernel rather than an independently mutable field.
      const status = interactiveStatusForState(state);
      if (!isInteractiveStateActive(state)) {
        return {
          content: [
            {
              type: "text",
              text: `Interactive sub-agent ${params.id} is ${status}; follow-up messages can only be sent to running or idle sub-agents. Spawn a new one if needed.`,
            },
          ],
          details: { id: params.id, status },
          isError: true,
        };
      }
      // sendCommandToPane uses send-keys + Enter; it throws synchronously if the
      // pane is gone (e.g. the child exited between the status check and now).
      // Wrap so the parent gets a structured error instead of an exception trace.
      try {
        sendCommandToPane(state, params.message + FOLLOWUP_COMPLETION_REMINDER);
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
      const messagePreview = formatFollowupPreview(params.message);
      const messageTruncated =
        params.message.length > MAX_FOLLOWUP_PREVIEW_CHARS;
      return {
        content: [
          {
            type: "text",
            text:
              `Sent follow-up to interactive sub-agent ${params.id} (${params.message.length} chars) in pane ${state.paneId}.` +
              `\n\nMessage sent:\n${messagePreview}`,
          },
        ],
        details: {
          id: params.id,
          paneId: state.paneId,
          messageLength: params.message.length,
          messagePreview,
          messageTruncated,
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
      "Use `since` (unix ms) to fetch only events newer than your last read. Use `turnId` for a",
      "protocol-v2 Pi turn, or legacy numeric `turn` for an output-N.md snapshot.",
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
      turnId: Type.Optional(
        Type.String({
          description:
            "Read a protocol-v2 immutable output by its Pi-derived turnId.",
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<any> {
      // Validate the id shape FIRST so a malformed id gets a precise error
      // instead of being collapsed into the generic "not found" message.
      if (!isValidSubagentId(params.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid sub-agent id ${JSON.stringify(params.id)}; expected 16 lowercase hex chars.`,
            },
          ],
          details: { id: params.id, status: "invalid_id" },
          isError: true,
        };
      }
      if (params.turn !== undefined && params.turnId !== undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Pass either turn or turnId, not both.",
            },
          ],
          details: { id: params.id, status: "invalid_selector" },
          isError: true,
        };
      }
      const state = interactiveSubagentRegistry.get(params.id);
      const art = state
        ? getArtifactForState(state)
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
      // Historical selectors imply includeOutput: selecting a turn without its
      // immutable content would be surprising and provides no useful mapping.
      const wantsOutput =
        params.includeOutput !== false ||
        params.turn !== undefined ||
        params.turnId !== undefined;
      const output = wantsOutput
        ? params.turnId !== undefined
          ? readOutputForTurnId(art, params.turnId)
          : params.turn !== undefined
            ? readOutputForTurn(art, params.turn)
            : readOutput(art)
        : null;
      const lastEventValue =
        events.length > 0 ? events[events.length - 1] : null;
      // Distinguish three cases when output is missing/empty so the caller
      // doesn't see a misleading "not written yet" after the sub-agent has
      // already exited (the common case: model finished without writing).
      let outputText: string;
      if (output === null) {
        if (params.turnId !== undefined) {
          outputText = `(no immutable snapshot for turnId ${params.turnId})`;
        } else if (params.turn !== undefined) {
          outputText = `(no snapshot for turn ${params.turn} — the poller may not have run yet, or this turn number is past the history)`;
        } else {
          const exited =
            lastEventValue && isArtifactOutputSettled(lastEventValue);
          outputText = exited
            ? `(sub-agent exited without writing output.md — last event: ${lastEventValue.type} @ ${lastEventValue.ts})`
            : `(${events.length} events, last: ${lastEventValue ? `${lastEventValue.type} @ ${lastEventValue.ts}` : "(none)"} — output.md not written yet)`;
        }
      } else if (output.length === 0) {
        outputText = "(empty — 0 chars)";
      } else {
        outputText = `${output.length} chars`;
      }
      // Available turns summary so the caller knows what history exists.
      const availableTurns = listOutputTurns(art);
      const outputHistory = listOutputHistory(art);
      const turnsLine =
        availableTurns.length > 0
          ? `Available turns: [${availableTurns.join(", ")}]\n`
          : "";
      const historyLine =
        outputHistory.length > 0
          ? `Protocol-v2 outputs: ${outputHistory
              .map(({ turnId, eventId }) => `${turnId} → ${eventId}`)
              .join(", ")}\n`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `Artifact for ${params.id} (${events.length} event${events.length === 1 ? "" : "s"}${params.since ? ` since ${params.since}` : ""}).\n` +
              `Last event: ${lastEventValue ? `${lastEventValue.type} @ ${lastEventValue.ts}` : "(none)"}\n` +
              (params.turn !== undefined
                ? `Reading turn: ${params.turn}\n`
                : "") +
              (params.turnId !== undefined
                ? `Reading turnId: ${params.turnId}\n`
                : "") +
              turnsLine +
              historyLine +
              `Output: ${outputText}`,
          },
        ],
        details: {
          id: params.id,
          artifactDir: art.dir,
          events,
          output,
          lastEvent: lastEventValue,
          availableTurns,
          outputHistory,
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

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<any> {
      await pruneDeadInteractiveSubagents();
      updateRunningSubagentFooter(ctx.ui);
      const states = [...interactiveSubagentRegistry.values()];
      const summary = states.map((s) => {
        const art = getArtifactForState(s);
        const last = lastEvent(art);
        return {
          id: s.id,
          name: s.name,
          task: s.task,
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
        const taskPreview = (s.task ?? "").replace(/\s+/g, " ").slice(0, 60);
        const evStr = ev
          ? `last: ${ev.type}${ev.message ? ` (${ev.message.slice(0, 60)})` : ""}`
          : "no events yet";
        return `${s.id}  ${s.name}  [${s.status}]  ${taskPreview} — ${evStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: summary.length, subagents: summary },
      };
    },
  });
}
