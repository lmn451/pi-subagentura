/**
 * Branch persistence for sub-agent transcripts.
 *
 * When `branch: true` is specified on a sub-agent invocation, the full
 * turn-by-turn transcript is captured as a sidecar JSON file and a
 * "↳ branch" indicator is shown in the parent conversation.
 *
 * Phase 1 persists sidecar files beside the session directory.
 * Phase 2 (future) migrates into native session tree entries.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ── Data Model ───────────────────────────────────────────────────────

export interface SubagentTranscript {
  version: 1;
  toolCallId: string;
  task: string;
  persona?: string;
  model?: string;
  startTime: string;
  endTime?: string;
  aborted: boolean;
  truncated?: boolean;
  turns: SubagentTurn[];
}

export interface SubagentTurn {
  turnIndex: number;
  assistantText: string;
  toolCalls: SubagentToolCall[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

export interface SubagentToolCall {
  name: string;
  args: string; // JSON-serialized (safe)
  result?: SafeToolResult;
  truncated?: boolean;
}

export interface SafeToolResult {
  content: { type: string; text?: string; truncated?: boolean }[];
  isError: boolean;
}

const MAX_TURNS = 100;
const MAX_TOOL_RESULT_BYTES = 10_000; // 10KB per tool result
const MAX_ASSISTANT_TEXT_BYTES = 50_000; // 50KB per turn assistant text

// ── Transcript Capture (Task 1) ───────────────────────────────────────

type AgentSessionEvent = {
  type: string;
  turnIndex?: number;
  timestamp?: number;
  message?: any;
  assistantMessageEvent?: any;
  toolCallId?: string;
  toolName?: string;
  args?: any;
  result?: any;
  isError?: boolean;
};

export class TranscriptCapture {
  private turns: SubagentTurn[] = [];
  private currentToolCalls: SubagentToolCall[] = [];
  private currentAssistantText = "";
  private currentTurnIndex = -1;
  private truncated = false;
  private inTurn = false;

  constructor(
    private toolCallId: string,
    private task: string,
    private persona?: string,
    private model?: string,
  ) {
    this.startTime = new Date().toISOString();
  }

  private startTime: string;

  onEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "turn_start": {
        // Reset per-turn accumulators
        this.currentToolCalls = [];
        this.currentAssistantText = "";
        this.currentTurnIndex = event.turnIndex ?? this.turns.length;
        this.inTurn = true;
        break;
      }

      case "message_update": {
        if (
          event.assistantMessageEvent?.type === "text_delta" &&
          event.assistantMessageEvent?.delta
        ) {
          this.currentAssistantText += event.assistantMessageEvent.delta;
        }
        break;
      }

      case "message_end":
      case "turn_end": {
        // Snap assistantText to final canonical message content (DC-4)
        if (event.message) {
          const finalText = this.extractFinalText(event.message);
          if (finalText) {
            this.currentAssistantText = finalText;
          }
        }

        // Cap assistant text per turn
        if (this.currentAssistantText.length > MAX_ASSISTANT_TEXT_BYTES) {
          this.currentAssistantText =
            this.currentAssistantText.slice(0, MAX_ASSISTANT_TEXT_BYTES) +
            "\n...[truncated]";
        }

        const usage = event.message?.usage
          ? {
              input: event.message.usage.input ?? 0,
              output: event.message.usage.output ?? 0,
              cacheRead: event.message.usage.cacheRead ?? 0,
              cacheWrite: event.message.usage.cacheWrite ?? 0,
              cost: event.message.usage.cost?.total ?? 0,
            }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

        const turnIndex =
          this.currentTurnIndex >= 0 ? this.currentTurnIndex : this.turns.length;

        // Cap at MAX_TURNS
        if (this.turns.length >= MAX_TURNS) {
          this.truncated = true;
          this.inTurn = false;
          break;
        }

        this.turns.push({
          turnIndex,
          assistantText: this.currentAssistantText,
          toolCalls: [...this.currentToolCalls],
          usage,
        });

        // Reset turn state
        this.inTurn = false;
        this.currentToolCalls = [];
        this.currentAssistantText = "";
        break;
      }

      case "tool_execution_start": {
        this.currentToolCalls.push({
          name: event.toolName ?? "unknown",
          args: safeJsonStringify(event.args ?? {}),
        });
        break;
      }

      case "tool_execution_end": {
        const lastToolCall =
          this.currentToolCalls[this.currentToolCalls.length - 1];
        if (lastToolCall) {
          const safeResult = truncateToolResult(event.result);
          lastToolCall.result = safeResult;
          // Set truncated flag on the tool call if result was truncated
          if (
            safeResult?.content?.some(
              (p: { truncated?: boolean }) => p.truncated,
            )
          ) {
            lastToolCall.truncated = true;
          }
        }
        break;
      }
    }
  }

  private extractFinalText(message: any): string | null {
    try {
      if (message?.content && Array.isArray(message.content)) {
        return message.content
          .filter(
            (c: any) => c.type === "text" && typeof c.text === "string",
          )
          .map((c: any) => c.text)
          .join("\n");
      }
    } catch {
      // Fall through
    }
    return null;
  }

  finalize(aborted: boolean): SubagentTranscript {
    // If we still have an in-progress turn, push it
    if (this.inTurn && (this.currentAssistantText || this.currentToolCalls.length > 0)) {
      if (this.turns.length < MAX_TURNS) {
        this.turns.push({
          turnIndex:
            this.currentTurnIndex >= 0
              ? this.currentTurnIndex
              : this.turns.length,
          assistantText: this.currentAssistantText,
          toolCalls: [...this.currentToolCalls],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        });
      }
    }

    return {
      version: 1,
      toolCallId: this.toolCallId,
      task: this.task,
      persona: this.persona,
      model: this.model,
      startTime: this.startTime,
      endTime: new Date().toISOString(),
      aborted,
      truncated: this.truncated || undefined,
      turns: this.turns,
    };
  }
}

// ── Tool Result Truncation ─────────────────────────────────────────────

export function truncateToolResult(
  result: any,
  maxBytes: number = MAX_TOOL_RESULT_BYTES,
): SafeToolResult | undefined {
  if (result === undefined || result === null) return undefined;

  const isError = result.isError === true;

  if (!result.content || !Array.isArray(result.content)) {
    return {
      content: [{ type: "text", text: "[no content]", truncated: false }],
      isError,
    };
  }

  const safeContent: { type: string; text?: string; truncated?: boolean }[] =
    [];
  let totalBytes = 0;

  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") {
      const textBytes = new TextEncoder().encode(part.text).length;
      if (totalBytes + textBytes > maxBytes) {
        const remaining = maxBytes - totalBytes;
        if (remaining > 0) {
          const truncated = part.text.slice(0, Math.floor(remaining / 3));
          safeContent.push({
            type: "text",
            text: truncated + "\n...[truncated]",
            truncated: true,
          });
        }
        return {
          content: safeContent,
          isError,
        };
      }
      totalBytes += textBytes;
      safeContent.push({ type: "text", text: part.text, truncated: false });
    } else {
      safeContent.push({ type: part.type || "unknown", truncated: false });
    }
  }

  return { content: safeContent, isError };
}

// ── Safe JSON Stringify ────────────────────────────────────────────────

export function safeJsonStringify(
  value: unknown,
  maxDepth: number = 10,
): string {
  try {
    return JSON.stringify(value, (_, val) => {
      if (typeof val === "bigint") return val.toString() + "n";
      if (typeof val === "function") return "[Function]";
      if (val instanceof Error) return `[Error: ${val.message}]`;
      if (val instanceof RegExp) return val.toString();
      if (typeof val === "symbol") return val.toString();
      return val;
    });
  } catch {
    const seen = new WeakSet();
    try {
      return JSON.stringify(
        value,
        (_, val) => {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return val;
        },
        0,
      );
    } catch {
      return "[unserializable]";
    }
  }
}

// ── Shared Formatting ──────────────────────────────────────────────────

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// ── Path Safety ────────────────────────────────────────────────────────

/**
 * Validate that a path component doesn't contain path traversal sequences.
 * Returns the sanitized component or throws.
 */
function validatePathComponent(component: string, name: string): string {
  // Reject path traversal attempts
  if (component.includes("..") || component.includes("/") || component.includes("\\")) {
    throw new Error(`Invalid ${name}: contains path traversal characters`);
  }
  return component;
}

// ── Persistence Layer (Task 2) ─────────────────────────────────────────

export function getBranchSidecarPath(
  sessionDir: string,
  sessionId: string,
  toolCallId: string,
): string {
  validatePathComponent(sessionId, "sessionId");
  validatePathComponent(toolCallId, "toolCallId");
  const dir = `${sessionDir}/subagent/${sessionId}`;
  const path = `${dir}/${toolCallId}.json`;
  // Verify the resolved path stays within sessionDir
  const resolved = resolve(path);
  const resolvedDir = resolve(sessionDir);
  if (!resolved.startsWith(resolvedDir + "/") && resolved !== resolvedDir) {
    throw new Error("Path traversal detected in sidecar path");
  }
  return path;
}

export function getRelativeSidecarPath(
  sessionId: string,
  toolCallId: string,
): string {
  validatePathComponent(sessionId, "sessionId");
  validatePathComponent(toolCallId, "toolCallId");
  return `subagent/${sessionId}/${toolCallId}.json`;
}

export async function persistTranscript(
  transcript: SubagentTranscript,
  sessionDir: string,
  sessionId: string,
  sessionFile?: string,
): Promise<string | undefined> {
  // In-memory session detection (RF-1): if sessionFile is undefined, skip persistence
  if (sessionFile === undefined) {
    return undefined;
  }

  const absolutePath = getBranchSidecarPath(
    sessionDir,
    sessionId,
    transcript.toolCallId,
  );
  const dir = `${sessionDir}/subagent/${sessionId}`;

  try {
    await mkdir(dir, { recursive: true });
    const json = safeJsonStringify(transcript);
    await writeFile(absolutePath, json, "utf-8");
    return getRelativeSidecarPath(sessionId, transcript.toolCallId);
  } catch (err) {
    console.error(`[pi-agents] Failed to persist branch transcript: ${err}`);
    return undefined;
  }
}

export async function loadTranscript(
  sidecarPath: string,
): Promise<SubagentTranscript | undefined> {
  try {
    const content = await readFile(sidecarPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed.version !== 1) {
      return undefined;
    }
    return parsed as SubagentTranscript;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a relative sidecar path to an absolute path.
 * Validates against path traversal.
 */
export function resolveSidecarPath(
  sessionDir: string,
  relativePath: string,
): string {
  // Reject obvious path traversal in relative path
  if (relativePath.includes("..")) {
    throw new Error("Path traversal detected in sidecar relative path");
  }
  const absolute = join(sessionDir, relativePath);
  // Verify resolved path is within sessionDir
  const resolvedAbs = resolve(absolute);
  const resolvedDir = resolve(sessionDir);
  if (
    !resolvedAbs.startsWith(resolvedDir + "/") &&
    resolvedAbs !== resolvedDir
  ) {
    throw new Error("Path traversal detected in resolved sidecar path");
  }
  return absolute;
}

// ── Sidecar Cleanup (Task 10) ──────────────────────────────────────────

export async function cleanupSidecars(
  sessionDir: string,
  sessionId: string,
): Promise<void> {
  validatePathComponent(sessionId, "sessionId");
  const dir = `${sessionDir}/subagent/${sessionId}`;
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort: ignore errors
  }
}

// ── Branch Discovery ──────────────────────────────────────────────────

export interface BranchMeta {
  toolCallId: string;
  hasBranch: boolean;
  branchSidecarRelPath?: string;
  branchTurnCount?: number;
  branchUnavailableReason?: string;
}

/**
 * Find the most recent branch in the current session by scanning
 * session entries for tool results with hasBranch === true.
 */
export function findMostRecentBranch(entries: any[]): BranchMeta | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type === "message" &&
      entry?.message?.role === "toolResult"
    ) {
      const details = entry.message?.details;
      if (details?.hasBranch === true) {
        return {
          toolCallId:
            details.branchToolCallId ?? entry.message?.toolCallId,
          hasBranch: true,
          branchSidecarRelPath: details.branchSidecarRelPath,
          branchTurnCount: details.branchTurnCount,
        };
      }
    }
  }
  return undefined;
}

/**
 * Find a specific branch by toolCallId.
 */
export function findBranchByToolCallId(
  entries: any[],
  toolCallId: string,
): BranchMeta | undefined {
  for (const entry of entries) {
    if (
      entry?.type === "message" &&
      entry?.message?.role === "toolResult"
    ) {
      const details = entry.message?.details;
      if (
        details?.hasBranch === true &&
        details.branchToolCallId === toolCallId
      ) {
        return {
          toolCallId: details.branchToolCallId,
          hasBranch: true,
          branchSidecarRelPath: details.branchSidecarRelPath,
          branchTurnCount: details.branchTurnCount,
        };
      }
    }
  }
  return undefined;
}

// ── Viewer Renderer (Task 3) ──────────────────────────────────────────

export function renderBranchViewer(
  transcript: SubagentTranscript,
  theme: Theme,
  expanded: boolean = true,
): any {
  return new Text(formatTranscriptForDisplay(transcript, theme), 0, 0);
}

export function formatTranscriptForDisplay(
  transcript: SubagentTranscript,
  theme: Theme,
): string {
  const lines: string[] = [];

  // Header
  const statusPart = transcript.aborted
    ? theme.fg("error", "✗ ABORTED")
    : theme.fg("success", "✓ Complete");

  const turnLabel =
    transcript.turns.length === 1
      ? "1 turn"
      : `${transcript.turns.length} turns`;

  const modelPart = transcript.model ? ` @${transcript.model}` : "";
  lines.push(
    `${statusPart} ${theme.fg("toolTitle", `Sub-agent branch`)} ${theme.fg("muted", `— ${turnLabel}${modelPart}`)}`,
  );

  if (transcript.truncated) {
    lines.push(
      theme.fg(
        "dim",
        `(Showing first ${MAX_TURNS} turns — transcript truncated)`,
      ),
    );
  }

  // Empty transcript (R5)
  if (transcript.turns.length === 0) {
    lines.push(theme.fg("dim", "No turns recorded."));
    return lines.join("\n");
  }

  lines.push("");

  // Per-turn display
  for (const turn of transcript.turns) {
    const usageParts: string[] = [];
    if (turn.usage.input)
      usageParts.push(`↑${formatTokens(turn.usage.input)}`);
    if (turn.usage.output)
      usageParts.push(`↓${formatTokens(turn.usage.output)}`);
    if (turn.usage.cost)
      usageParts.push(`$${turn.usage.cost.toFixed(4)}`);

    const usageStr = usageParts.length
      ? theme.fg("muted", ` ${usageParts.join(" ")}`)
      : "";

    lines.push(
      `${theme.fg("accent", `Turn ${turn.turnIndex + 1}`)}${usageStr}`,
    );

    // Assistant text preview
    if (turn.assistantText) {
      const preview = turn.assistantText
        .slice(0, 200)
        .replace(/\s+/g, " ");
      lines.push(
        `  ${theme.fg("dim", truncateToWidth(preview, 120))}`,
      );
    }

    // Tool calls
    for (const tc of turn.toolCalls) {
      const truncatedMarker = tc.truncated
        ? theme.fg("dim", " [truncated]")
        : "";
      const errMarker = tc.result?.isError
        ? theme.fg("error", " ✗")
        : "";
      lines.push(
        `  ${theme.fg("muted", "→")} ${theme.fg("toolTitle", tc.name)}${truncatedMarker}${errMarker}`,
      );
    }
  }

  return lines.join("\n");
}