import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatUsage } from "./helpers";
import type { SubagentDetails } from "./subagent";
import type { SubagentResult } from "./helpers";
import { sanitizeOutput } from "./notifications";
import type { InteractiveSubagentState } from "./interactive-tmux";

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
export function renderAsyncSpawn(
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

// ── Notification TUI Renderer ──────────────────────────────────

export function renderSubagentNotify(
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

/** Format a single TUI widget row for a running sub-agent. */
export function formatActivityRow(state: InteractiveSubagentState): string {
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
