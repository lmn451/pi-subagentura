/**
 * Shared helpers for pi-subagentura
 *
 * Exported so both subagent.ts and test files can import them.
 * Keeps helper logic in one place — single source of truth.
 */

import { getModel, getProviders } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

// Note: Model<TApi> and AgentToolResult<T> are SDK generics. We use `unknown` as
// the type argument to avoid strict generic instantiation issues with tsc.
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

// ── Constants ────────────────────────────────────────────────────────

/**
 * Milliseconds to wait before showing activeTool in the live status preview.
 * Prevents UI flicker for fast tool executions that start and end within this window.
 *
 * Note: If Pi adds new model providers, update KNOWN_PROVIDERS below.
 */
export const ACTIVE_TOOL_DEBOUNCE_MS = 150;

// Note: If Pi adds new providers, getProviders() from @mariozechner/pi-ai will
// return them automatically. We no longer maintain a hardcoded list.

// ── Types ───────────────────────────────────────────────────────────

export interface SubagentResult {
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

export interface SubagentLiveStatus {
  turn: number;
  activeTool?: { name: string; args: Record<string, unknown> };
  output: string;
  usage: SubagentResult["usage"];
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a model from a string identifier and an optional default.
 *
 * Handles:
 *   - "provider/id" format → splits and looks up in the given provider
 *   - bare id (e.g. "claude-3-5-sonnet") → searches KNOWN_PROVIDERS in order
 *   - undefined → returns defaultModel
 *
 * Falls back to defaultModel when the model is not found.
 */
export function resolveModel(
  modelId: string | undefined,
  // @ts-expect-error — Model<TApi> requires type arg; unknown is a safe placeholder here
  defaultModel: Model | undefined,
) {
  if (!modelId) return defaultModel;

  // "provider/id" format
  if (modelId.includes("/")) {
    const [provider, id] = modelId.split("/", 2);
    // @ts-expect-error — getModel requires KnownProvider union; we trust the caller
    return getModel(provider, id) ?? defaultModel;
  }

  // Bare id — search all known providers dynamically via SDK
  for (const provider of getProviders()) {
    // @ts-expect-error — KnownProvider cast needed; string is assignable to it at runtime
    const found = getModel(provider, modelId);
    if (found) return found;
  }

  return defaultModel;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(
  u: SubagentResult["usage"],
  model?: string,
): string {
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

export function buildLiveUpdate(
  status: SubagentLiveStatus,
  model?: string,
  // @ts-expect-error — AgentToolResult<T> requires type arg; unknown is a safe placeholder
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
