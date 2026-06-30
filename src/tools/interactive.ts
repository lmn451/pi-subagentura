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
  lastEvent,
  listOutputTurns,
  readEvents,
  readOutput,
  readOutputForTurn,
  type SubagentArtifact,
} from "../artifact";
import {
  cancelInteractiveSubagent,
  formatInteractiveState,
  interactiveSubagentRegistry,
  launchInteractiveSubagent,
  pruneDeadInteractiveSubagents,
  sendCommandToPane,
  tmuxSetupHint,
  type InteractiveSubagentState,
} from "../interactive-tmux";
import { debugLog } from "../helpers";
import { InteractiveParams } from "../schemas";

const SUBAGENT_ID_RE = /^[a-f0-9]{8}$/;
const MAX_FOLLOWUP_BYTES = 64 * 1024;

export function findArtifactById(id: string): SubagentArtifact | null {
  // Sub-agent ids are randomBytes(4).toString("hex") at spawn time, i.e. 8 hex
  // chars. Validate the id before joining it into a path so that an
  // LLM-supplied id like "../../../etc" can't escape the artifact root
  // (path.join normalises "..", so a malicious id would otherwise resolve
  // to a sibling directory and get exfiltrated to the parent LLM via
  // read_subagent_artifact).
  if (!SUBAGENT_ID_RE.test(id)) return null;

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
          parentCwd: ctx.cwd,
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
      if (!SUBAGENT_ID_RE.test(params.id)) {
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
      if (!SUBAGENT_ID_RE.test(params.id)) {
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
      // `turn` reads a specific output-N.md snapshot; otherwise read the latest output.md. The turn
      // param implies includeOutput (you can't read a turn without wanting its content).
      const wantsOutput =
        params.includeOutput !== false || params.turn !== undefined;
      const output = wantsOutput
        ? params.turn !== undefined
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
        if (params.turn !== undefined) {
          outputText = `(no snapshot for turn ${params.turn} — the poller may not have run yet, or this turn number is past the history)`;
        } else {
          const exited =
            lastEventValue &&
            (lastEventValue.type === "done" ||
              lastEventValue.type === "error" ||
              lastEventValue.type === "cancelled");
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
              `Last event: ${lastEventValue ? `${lastEventValue.type} @ ${lastEventValue.ts}` : "(none)"}\n` +
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
          lastEvent: lastEventValue,
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
        const art = getArtifactForState(s);
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
}
