import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatUsage } from "./helpers";
import type { SubagentDetails } from "./subagent";
import type { SubagentResult } from "./helpers";
import { sanitizeOutput } from "./notifications";
import {
  interactiveStatusForState,
  type InteractiveSubagentState,
} from "./interactive-tmux";

function thinkingSuffix(level?: ThinkingLevel): string {
  return level ? ` · thinking: ${level}` : "";
}

// ── Rendering ────────────────────────────────────────────────────────

export function renderSubagentCall(
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
  if (args.thinkingLevel) {
    text += theme.fg(
      "dim",
      thinkingSuffix(String(args.thinkingLevel) as ThinkingLevel),
    );
  }
  if (args.async) {
    text += theme.fg("accent", " [async]");
  }
  return new Text(text, 0, 0);
}

export function renderSubagentResult(
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
    const thinkingLevel =
      runningDetails?.thinkingLevel ?? status?.thinkingLevel;

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
  ${theme.fg("muted", usageStr)}${theme.fg("dim", thinkingSuffix(thinkingLevel))}`;
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
  const resultDetails = result.details as
    { usageSummary?: string; thinkingLevel?: ThinkingLevel } | undefined;

  if (result.isError) {
    const thinking = thinkingSuffix(resultDetails?.thinkingLevel);
    if (!expanded) {
      const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
      return new Text(
        thinking
          ? `${theme.fg("dim", thinking)}\n${theme.fg("error", preview)}`
          : theme.fg("error", preview),
        0,
        0,
      );
    }
    return new Text(
      thinking
        ? `${theme.fg("dim", thinking)}\n${theme.fg("error", text)}`
        : theme.fg("error", text),
      0,
      0,
    );
  }

  const usageStr = resultDetails?.usageSummary;
  const thinking = thinkingSuffix(resultDetails?.thinkingLevel);

  if (usageStr) {
    const header =
      theme.fg("success", "✓ ") +
      theme.fg("muted", usageStr) +
      theme.fg("dim", thinking);
    if (!expanded) {
      return new Text(header, 0, 0);
    }
    return new Text(`${header}\n${text}`, 0, 0);
  }

  if (!expanded) {
    const preview = truncateToWidth(text.replace(/\s+/g, " "), 120);
    return new Text(
      thinking
        ? `${theme.fg("dim", thinking)}\n${theme.fg("dim", preview)}`
        : theme.fg("dim", preview),
      0,
      0,
    );
  }
  return new Text(
    thinking ? `${theme.fg("dim", thinking)}\n${text}` : text,
    0,
    0,
  );
}

/**
 * Render the immediate result of an async subagent spawn.
 * Compact display: "⚡ Sub-agent started — job abc12345"
 */
export function renderAsyncSpawn(
  details: Extract<SubagentDetails, { status: "started" }>,
  theme: Theme,
): Text {
  const jobId = details.jobId;
  const text =
    theme.fg("accent", "⚡ ") +
    theme.fg(
      "toolTitle",
      `Sub-agent started — job ${jobId}${thinkingSuffix(details.thinkingLevel)}`,
    ) +
    "\n" +
    theme.fg("dim", "  Use get_subagent_status to check progress.");
  return new Text(text, 0, 0);
}

// ── Notification TUI Renderer ──────────────────────────────────

export function renderSubagentNotify(
  message: {
    content?: string | Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: { expanded?: boolean },
  theme: Theme,
): Text {
  const details = message.details as
    | {
        mode?: string;
        status?: "done" | "error" | "cancelled";
        error?: boolean;
        result?: SubagentResult;
      }
    | undefined;
  const isInject = details?.mode === "inject";
  const isError =
    details?.error === true ||
    details?.status === "error" ||
    details?.result?.isError === true;
  const isCancelled = details?.status === "cancelled";
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("");

  let line: string;
  if (!options.expanded) {
    line = isError ? theme.fg("error", text) : theme.fg("accent", text);
  } else {
    const output = sanitizeOutput(
      (details?.result?.output ?? "").slice(0, 500).replace(/\s+/g, " "),
    );
    const header = isError
      ? theme.fg("error", "❌ Sub-agent Failed")
      : isCancelled
        ? theme.fg("warning", "🚫 Sub-agent Cancelled")
        : isInject
          ? theme.fg("accent", "⚡ Injected Sub-agent Result")
          : theme.fg("success", "✅ Sub-agent Completed");
    const body = theme.fg("dim", text);
    line = `${header}\n${body}\n${output}`;
  }
  return new Text(line, 0, 0);
}

/**
 * Coarse bucket for widget elapsed clocks.
 *
 * The poller memoizes `setStatus`/`setWidget` so an identical row never
 * repaints. Quantizing elapsed time to this bucket keeps the row byte-identical
 * across the polls that fall inside one bucket, so the clock is visible again
 * without reintroducing a repaint on every 5s tick.
 */
export const ACTIVITY_ELAPSED_BUCKET_MS = 10_000;

/** Quantize an elapsed duration down to the coarse widget bucket. */
export function coarseElapsedMs(milliseconds: number): number {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return (
    Math.floor(milliseconds / ACTIVITY_ELAPSED_BUCKET_MS) *
    ACTIVITY_ELAPSED_BUCKET_MS
  );
}

/** Format a widget row with a coarse elapsed clock (see the bucket above). */
export function formatActivityRow(
  state: InteractiveSubagentState,
  now: number = Date.now(),
): string {
  if (interactiveStatusForState(state) === "idle") {
    return `○ ${state.name}: idle — ready for follow-up`;
  }
  const summary = state.lastToolSummary ?? "starting…";
  const ago = state.lastActivityAt
    ? ` (${agoStr(coarseElapsedMs(now - state.lastActivityAt))})`
    : "";
  return `▶ ${state.name}: ${summary}${ago}`;
}

function agoStr(milliseconds: number): string {
  if (milliseconds < ACTIVITY_ELAPSED_BUCKET_MS) return "just now";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
