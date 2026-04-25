/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Two tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *
 * Both inherit the current model by default. Persona is an optional argument.
 * Runs in the same process — no subprocess overhead, live streaming output.
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

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

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
): Promise<SubagentResult> {
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const targetModel = resolveModel(modelOverride, defaultModel);
  const modelLabel = targetModel
    ? `${targetModel.provider}/${targetModel.id}`
    : undefined;

  let session: AgentSession | undefined;
  let handleAbort: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

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

    // Wire abort signal (store handler for explicit cleanup)
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
      switch (event.type) {
        case "turn_start": {
          liveStatus.turn++;
          liveStatus.usage.turns = liveStatus.turn;
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
          break;
        }
        case "tool_execution_start": {
          liveStatus.activeTool = {
            name: event.toolName,
            args: event.args as Record<string, unknown>,
          };
          onUpdate?.(buildLiveUpdate(liveStatus, modelLabel));
          break;
        }
        case "tool_execution_end": {
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

    return {
      output: finalOutput || "(no output)",
      usage,
      // Include provider for clarity, e.g. "anthropic/claude-sonnet-4-5"
      model: session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined,
      isError: !!session.agent.state.errorMessage,
      errorMessage: session.agent.state.errorMessage,
    };
  } catch (err) {
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
  } finally {
    if (signal && handleAbort) signal.removeEventListener("abort", handleAbort);
    if (unsubscribe) unsubscribe();
    session?.dispose();
  }
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
  { isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  if (isPartial) {
    const status = result.details?.subagentStatus as
      | SubagentLiveStatus
      | undefined;
    const model = result.details?.model as string | undefined;

    let text = theme.fg("accent", "● ") + theme.fg("toolTitle", "Sub-agent working");

    if (status) {
      text += theme.fg("dim", ` — turn ${status.turn}`);

      if (status.activeTool) {
        const argsStr = JSON.stringify(status.activeTool.args).slice(0, 80);
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

    return new Text(text, 0, 0);
  }

  // Final result
  const content = result.content[0];
  const text = content?.type === "text" ? content.text : "";

  if (result.isError) {
    return new Text(theme.fg("error", text), 0, 0);
  }

  const usageStr = result.details?.usageSummary as string | undefined;
  if (usageStr) {
    const header = theme.fg("success", "✓ ") + theme.fg("muted", usageStr);
    return new Text(`${header}\n${text}`, 0, 0);
  }

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
      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        conversationText,
        signal,
        onUpdate,
        ctx.model,
      );

      const usageStr = formatUsage(result.usage, result.model);

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details: {
          contextMessages: messages.length,
          usage: result.usage,
          model: result.model,
          usageSummary: usageStr,
        },
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
      const result = await runSubagent(
        params.task,
        params.persona,
        params.model,
        targetCwd,
        null, // no context
        signal,
        onUpdate,
        ctx.model,
      );

      const usageStr = formatUsage(result.usage, result.model);

      return {
        content: [
          {
            type: "text",
            text: result.isError
              ? `Sub-agent failed: ${result.errorMessage || result.output}`
              : result.output,
          },
        ],
        details: {
          usage: result.usage,
          model: result.model,
          usageSummary: usageStr,
        },
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
}
