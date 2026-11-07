import { isCompletionEvent, type SubagentEvent } from "./artifact";

/** True only for a child-local aborted settlement that is intentionally quiet. */
export function isQuietChildInterruption(event: SubagentEvent): boolean {
  return (
    event.type === "completion" &&
    event.source === "agent_settled" &&
    event.outcome === "error" &&
    event.agentStopReason === "aborted"
  );
}

/** True when the event should trigger a wakeup notification to the parent. */
export function shouldNotify(event: SubagentEvent): boolean {
  return isCompletionEvent(event) && !isQuietChildInterruption(event);
}

export function sanitizeOutput(text: string): string {
  return text.replace(
    /(sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|-----BEGIN[\s\w]+KEY-----|AKIA[\w]{16}|ghp_[\w]{36}|gho_[\w]{36}|ghu_[\w]{36}|xox[abp]-[\w-]+|AIza[\w-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
    "[REDACTED]",
  );
}
