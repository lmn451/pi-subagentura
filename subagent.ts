/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Two tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *
 * Both inherit the current model by default. Persona is an optional argument.
 * Runs in the same process — no subprocess overhead, live streaming output.
 *
 * Branch feature:
 *   When `branch: true`, the full subagent transcript is persisted as a
 *   sidecar JSON file and a "↳ branch" indicator is shown in the parent
 *   conversation. Users can view the transcript via `/subagent-view`.
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type ExtensionAPI,
  type AgentSession,
  type Theme,
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
  TranscriptCapture,
  persistTranscript,
  loadTranscript,
  resolveSidecarPath,
  findMostRecentBranch,
  findBranchByToolCallId,
  formatTranscriptForDisplay,
  formatTokens as branchFormatTokens,
  type SubagentTranscript,
  type BranchMeta,
} from "./branch.ts";

// ── Helpers ──────────────────────────────────────────────────────────

interface SubagentResult {
  output: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  model?: string;
  isError: boolean;
  errorMessage?: string;
  transcript?: SubagentTranscript;
  branchSidecarRelPath?: string;
}

interface SubagentLiveStatus {
  turn: number;
  activeTool?: { name: string; args: Record<string, unknown> };
  output: string;
  usage: SubagentResult["usage"];
}

function resolveModel(
  modelId: string | undefined,
  defaultModel: Model | undefined,
): Model | undefined {
  if (!modelId) return defaultModel;

  // "provider/id" format
  if (modelId.includes("/")) {
    const [provider, id] = modelId.split("/", 2);
    return getModel(provider, id) ?? defaultModel;
  }

  // Bare id — search known providers
  for (const provider of [
    "anthropic",
    "openai",
    "google",
    "deepseek",
    "openrouter",
  ]) {
    const found = getModel(provider, modelId);
    if (found) return found;
  }

  return defaultModel;
}

// Re-export from branch.ts for consistency
const formatTokens = branchFormatTokens;

function formatUsage(u: SubagentResult["usage"], model?: string): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function buildLiveUpdate(
  status: SubagentLiveStatus,
  model?: string,
): AgentToolResult {
  return {
    content: [{ type: "text", text: status.output }],
    details: {
      status: "running",
      subagentStatus: status,
      model,
    },
  };
}

async function runSubagent(
  task: string,
  persona: string | undefined,
  modelOverride: string | undefined,
  cwd: string,
  contextText: string | null,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult) => void) | undefined,
  defaultModel: Model | undefined,
  branch: boolean = false,
  toolCallId: string | undefined = undefined,
  sessionDir: string | undefined = undefined,
  sessionId: string | undefined = undefined,
  sessionFile: string | undefined = undefined,
): Promise<SubagentResult> {
  // Validate branch parameters
  if (branch && !toolCallId) {
    throw new Error("branch: true requires toolCallId");
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const targetModel = resolveModel(modelOverride, defaultModel);
  const modelLabel = targetModel
    ? `${targetModel.provider}/${targetModel.id}`
    : undefined;

  let session: AgentSession | undefined;
  let handleAbort: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  // Branch transcript capture ( Task 4)
  const capture =
    branch && toolCallId
      ? new TranscriptCapture(toolCallId, task, persona, modelLabel)
      : undefined;

  const liveStatus: SubagentLiveStatus = {
    turn: 0,
    output: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
  };

  // Debounce activeTool updates to prevent flickering on fast tool calls.
  // When a tool executes quickly (< DEBOUNCE_MS), we skip the setActiveTool
  // render entirely, avoiding a brief height/width expansion that the user
  // perceives as flickering.
  const DEBOUNCE_MS = 150;
  let activeToolTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActiveTool: SubagentLiveStatus["activeTool"] = undefined;

  function setActiveToolDebounced(tool: SubagentLiveStatus["activeTool"]) {
    pendingActiveTool = tool;
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (tool) {
      // Starting a tool: wait DEBOUNCE_MS before showing it.
      // If the tool finishes before the timer fires, clearActiveToolDebounced
      // will cancel the timer and the activeTool line never appears.
      activeToolTimer = setTimeout(() => {
        activeToolTimer = undefined;
        liveStatus.activeTool = pendingActiveTool;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }, DEBOUNCE_MS);
    } else {
      // Clearing: apply immediately (no delay) so the UI stays responsive
      // when a genuinely long tool finishes. But only if we had an activeTool
      // that was already committed (not just pending).
      if (liveStatus.activeTool) {
        liveStatus.activeTool = undefined;
        onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
      }
    }
  }

  // Result variable for finally block (Architect §3.2 restructure)
  let result: SubagentResult;
  let branchSidecarRelPath: string | undefined;

  try {
    session = (
      await createAgentSession({
        sessionManager: SessionManager.inMemory(),
        authStorage,
        modelRegistry,
        model: targetModel,
        cwd,
      })
    ).session;

    // Wire abort signal
    if (signal) {
      handleAbort = () => {
        session!.abort().catch(() => {});
      };
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort);
      }
    }

    // Stream output and lifecycle events back to parent
    unsubscribe = session.subscribe((event) => {
      // Feed events to branch transcript capture
      capture?.onEvent(event);

      switch (event.type) {
        case "turn_start": {
          liveStatus.turn++;
          liveStatus.usage.turns = liveStatus.turn;
          // Reset output on each new turn so the live preview always shows
          // only the current turn's text, not an accumulation of all turns.
          liveStatus.output = "";
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
          break;
        }
        case "tool_execution_start": {
          setActiveToolDebounced({
            name: event.toolName,
            args: event.args as Record<string, unknown>,
          });
          break;
        }
        case "tool_execution_end": {
          setActiveToolDebounced(undefined);
          break;
        }
        case "turn_end": {
          // Cancel any pending activeTool timer and clear immediately
          if (activeToolTimer) {
            clearTimeout(activeToolTimer);
            activeToolTimer = undefined;
          }
          liveStatus.activeTool = undefined;
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
          break;
        }
        case "message_update": {
          if (event.assistantMessageEvent.type === "text_delta") {
            liveStatus.output += event.assistantMessageEvent.delta;
            onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
          }
          break;
        }
      }
    });

    const personaPrefix = persona ? `${persona}\n\n` : "";
    const finalPrompt = contextText
      ? `${personaPrefix}You are a sub-agent receiving the full conversation history below. Use it as context, then fulfill the task.\n\n## Conversation History\n${contextText}\n\n## Your Task\n${task}`
      : `${personaPrefix}Task: ${task}`;

    await session.prompt(finalPrompt);

    // Extract final assistant output
    const messages = session.agent.state.messages;
    let finalOutput = liveStatus.output; // fallback to streamed
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        const textParts = msg.content
          ?.filter(
            (c): c is { type: "text"; text: string } => c.type === "text",
          )
          .map((c) => c.text)
          .join("\n");
        if (textParts) {
          finalOutput = textParts;
          break;
        }
      }
    }

    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    };
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.usage) {
        usage.turns++;
        usage.input += msg.usage.input;
        usage.output += msg.usage.output;
        usage.cacheRead += msg.usage.cacheRead;
        usage.cacheWrite += msg.usage.cacheWrite;
        usage.cost += msg.usage.cost.total;
      }
    }

    result = {
      output: finalOutput || "(no output)",
      usage,
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined,
      isError: !!session.agent.state.errorMessage,
      errorMessage: session.agent.state.errorMessage,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
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
  } finally {
    // Cleanup
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (signal && handleAbort) signal.removeEventListener("abort", handleAbort);
    if (unsubscribe) unsubscribe();

    // Finalize branch transcript BEFORE disposal (CI-2)
    if (capture) {
      const transcript = capture.finalize(signal?.aborted ?? false);
      result.transcript = transcript;

      // Persist sidecar (best-effort)
      if (branch && sessionDir && sessionId && toolCallId) {
        try {
          branchSidecarRelPath = await persistTranscript(
            transcript,
            sessionDir,
            sessionId,
            sessionFile,
          );
        } catch {
          // Best-effort: skip persistence on failure
          branchSidecarRelPath = undefined;
        }
      }
    }

    session?.dispose();
  }

  // Augment result with branch info
  result.branchSidecarRelPath = branchSidecarRelPath;
  return result;
}

// ── Rendering ────────────────────────────────────────────────────────

function renderSubagentCall(
  args: Record<string, unknown>,
  theme: Theme,
  label: string,
) {
  const task = String(args.task ?? "");
  const taskPreview =
    task.length > 60 ? `${task.slice(0, 57)}…` : task;
  let text = theme.fg("toolTitle", theme.bold(`${label} `));
  text += theme.fg("accent", taskPreview);
  if (args.model) {
    text += theme.fg("dim", ` @${args.model}`);
  }
  return new Text(text, 0, 0);
}

function renderSubagentResult(
  result: AgentToolResult,
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  // Branch indicator (Task 6)
  const hasBranch = result.details?.hasBranch as boolean | undefined;

  if (isPartial) {
    const status = result.details?.subagentStatus as
      | SubagentLiveStatus
      | undefined;
    const model = result.details?.model as string | undefined;

    let text = theme.fg("accent", "● ") + theme.fg("toolTitle", "Sub-agent working");

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
        const preview = status.output
          .slice(0, 200)
          .replace(/\s+/g, " ");
        text += `
  ${theme.fg("dim", truncateToWidth(preview, 120))}`;
      }
    } else {
      text += theme.fg("dim", "…");
    }

    // No branch indicator during streaming
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
      let errorText = theme.fg("error", preview);
      if (hasBranch) {
        errorText += theme.fg("dim", "  ↳ branch");
      }
      return new Text(errorText, 0, 0);
    }
    let errorText = theme.fg("error", text);
    if (hasBranch) {
      errorText += theme.fg("dim", "  ↳ branch");
    }
    return new Text(errorText, 0, 0);
  }

  const usageStr = result.details?.usageSummary as string | undefined;
  const branchHint =
    hasBranch && !isPartial ? theme.fg("dim", "  ↳ branch") : "";

  if (usageStr) {
    const header = theme.fg("success", "✓ ") + theme.fg("muted", usageStr) + branchHint;
    if (!expanded) {
      return new Text(header, 0, 0);
    }
    return new Text(`${header}\n${text}`, 0, 0);
  }

  if (!expanded) {
    const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
    return new Text(theme.fg("dim", preview) + branchHint, 0, 0);
  }
  return new Text(text + (branchHint ? "\n" + branchHint : ""), 0, 0);
}

// ── Branch Viewer (Task 7) ────────────────────────────────────────────

function openBranchViewer(
  ctx: any,
  toolCallIdArg: string | undefined,
): void {
  if (!ctx?.hasUI || !ctx?.sessionManager) return;

  const sessionDir = ctx.sessionManager.getSessionDir();
  const entries = ctx.sessionManager.getBranch();

  // Find the branch metadata
  let branchMeta: BranchMeta | undefined;
  if (toolCallIdArg) {
    branchMeta = findBranchByToolCallId(entries, toolCallIdArg);
  } else {
    branchMeta = findMostRecentBranch(entries);
  }

  if (!branchMeta || !branchMeta.branchSidecarRelPath) {
    ctx.ui.notify("No subagent branch found", "warning");
    return;
  }

  // Resolve relative path to absolute (with traversal check)
  let absolutePath: string;
  try {
    absolutePath = resolveSidecarPath(sessionDir, branchMeta.branchSidecarRelPath);
  } catch (err) {
    ctx.ui.notify("Invalid branch path", "error");
    return;
  }

  // Load transcript asynchronously
  loadTranscript(absolutePath)
    .then((transcript) => {
      if (!transcript) {
        ctx.ui.notify("Branch data unavailable", "warning");
        return;
      }

      return ctx.ui.custom<string>(
        (tui: any, theme: any, keybindings: any, done: (result: string) => void) => {
          const displayText = formatTranscriptForDisplay(transcript, theme);

          class BranchViewer {
            render() {
              return new Text(displayText, 0, 0);
            }
            handleInput(data: string): { consume?: boolean; data?: string } | undefined {
              if (keybindings.matches(data, "tui.select.cancel")) {
                done("closed");
                return { consume: true };
              }
              return undefined;
            }
            dispose() {}
          }

          return new BranchViewer();
        },
        { overlay: true },
      );
    })
    .catch((err: any) => {
      // User cancelled or viewer closed — not an error
      if (err && err !== "closed") {
        console.error("[pi-agents] Branch viewer error:", err);
      }
    });
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
  branch: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "If true, persist the full subagent turn-by-turn transcript as a navigable branch.",
    }),
  ),
});

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Tool 1: inherits conversation history ────────────────────────
  pi.registerTool({
    name: "subagent_with_context",
    label: "Sub-Agent (with context)",
    description: [
      "Spawn an in-process sub-agent that inherits the full conversation history.",
      "The sub-agent sees everything discussed so far plus the new task.",
      "Model is inherited by default. Streams output in real-time.",
    ].join(" "),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Gather conversation history
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter(
          (e): e is typeof e & { type: "message" } => e.type === "message",
        )
        .map((e) => e.message);

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
      const wantBranch = params.branch ?? false;
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        conversationText,
        signal,
        onUpdate,
        ctx.model,
        wantBranch,
        _toolCallId,
        sessionDir,
        sessionId,
        sessionFile,
      );

      const usageStr = formatUsage(result.usage, result.model);

      // Build details with branch metadata (Task 5)
      const details: Record<string, unknown> = {
        contextMessages: messages.length,
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      if (wantBranch) {
        if (result.branchSidecarRelPath) {
          details.hasBranch = true;
          details.branchToolCallId = _toolCallId;
          details.branchTurnCount = result.transcript?.turns.length ?? 0;
          details.branchSidecarRelPath = result.branchSidecarRelPath;
        } else {
          details.hasBranch = false;
          details.branchUnavailableReason = sessionFile
            ? undefined
            : "in-memory-session";
        }
      }

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
      "Model is inherited by default. Streams output in real-time.",
    ].join(" "),
    parameters: BaseParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const targetCwd = params.cwd ?? ctx.cwd;
      const wantBranch = params.branch ?? false;
      const sessionDir = ctx.sessionManager.getSessionDir();
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();

      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        null, // no context
        signal,
        onUpdate,
        ctx.model,
        wantBranch,
        _toolCallId,
        sessionDir,
        sessionId,
        sessionFile,
      );

      const usageStr = formatUsage(result.usage, result.model);

      // Build details with branch metadata (Task 5)
      const details: Record<string, unknown> = {
        usage: result.usage,
        model: result.model,
        usageSummary: usageStr,
      };

      if (wantBranch) {
        if (result.branchSidecarRelPath) {
          details.hasBranch = true;
          details.branchToolCallId = _toolCallId;
          details.branchTurnCount = result.transcript?.turns.length ?? 0;
          details.branchSidecarRelPath = result.branchSidecarRelPath;
        } else {
          details.hasBranch = false;
          details.branchUnavailableReason = sessionFile
            ? undefined
            : "in-memory-session";
        }
      }

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

  // ── Command: /subagent-view (Task 7) ───────────────────────────────
  pi.registerCommand("subagent-view", {
    description: "View a sub-agent branch transcript. Optionally provide a toolCallId.",
    handler: async (args: string, ctx: any) => {
      const toolCallId = args?.trim() || undefined;
      openBranchViewer(ctx, toolCallId);
    },
  });

  // ── Shortcut: Ctrl+B (Task 8) ─────────────────────────────────────
  pi.registerShortcut("ctrl+b", {
    description: "View most recent sub-agent branch",
    handler: async (ctx: any) => {
      openBranchViewer(ctx, undefined);
    },
  });
}