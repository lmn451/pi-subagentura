import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type {
  JobState,
  NotifyOnComplete,
  SubagentResult,
  Usage,
} from "./helpers";
import { formatUsage } from "./helpers";
import type { SubagentEvent } from "./artifact";
import type { InteractiveSubagentState } from "./interactive-tmux";

// ── Inject cap tracking ─────────────────────────────────────────

/** Track concurrent inject-mode notifications to prevent conversation explosion */
export function getInjectCount(): number {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  return (g2.__piSubagenturaInjectCount ?? 0) as number;
}

export function incrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount =
    ((g2.__piSubagenturaInjectCount ?? 0) as number) + 1;
}

export function decrementInjectCount(): void {
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaInjectCount = Math.max(
    0,
    ((g2.__piSubagenturaInjectCount ?? 0) as number) - 1,
  );
}

/** Max concurrent inject-mode notifications before degrading to notify */
export const MAX_INJECT = 5;

// ── Notification Delivery ───────────────────────────────────────

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

/**
 * Deliver async subagent completion notification.
 * Reads pi from globalThis to survive module reloads.
 */
export function deliverNotification(
  jobState: JobState,
  result: SubagentResult,
): void {
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

// ── Interactive artifact notification helpers ───────────────────

/** True when the event should trigger a wakeup notification to the parent. */
export function shouldNotify(event: SubagentEvent): boolean {
  return (
    event.type === "done" ||
    event.type === "error" ||
    event.type === "cancelled"
  );
}

export function sanitizeOutput(text: string): string {
  return text.replace(
    /(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|-----BEGIN[\s\w]+KEY-----|AKIA[\w]{16}|ghp_[\w]{36}|gho_[\w]{36}|ghu_[\w]{36}|xox[abp]-[\w-]+|AIza[\w-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    "[REDACTED]",
  );
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
export function deliverArtifactNotification(
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
