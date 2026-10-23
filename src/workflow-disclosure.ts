import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowPrivateDiagnosticError } from "./workflow-core";

const SAFE_WORKFLOW_DIAGNOSTIC =
  "Workflow failed; diagnostic details are available only locally.";
const WORKFLOW_DIAGNOSTIC_TOOLS = new Set([
  "workflow",
  "get_workflow_status",
  "get_workflow_result",
  "resume_workflow",
  "cancel_workflow",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasFailedDurableRun(details: unknown): boolean {
  if (!isRecord(details) || !Array.isArray(details.runs)) return false;
  return details.runs.some(
    (run) =>
      isRecord(run) &&
      (run.status === "error" || run.status === "interrupted") &&
      typeof run.error === "string",
  );
}

function sanitizeDiagnosticFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticFields);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      ["error", "errorMessage", "message"].includes(key) &&
      typeof nested === "string"
        ? SAFE_WORKFLOW_DIAGNOSTIC
        : sanitizeDiagnosticFields(nested),
    ]),
  );
}

export function sanitizeWorkflowDiagnosticDetails<T>(value: T): T {
  return sanitizeDiagnosticFields(value) as T;
}

function shouldSanitizeWorkflowMessage(
  message: Record<string, unknown>,
): boolean {
  const details = message.details;
  if (message.role === "custom" && message.customType === "workflow-notify") {
    if (!isRecord(details)) return false;
    return details.status === "error" || details.status === "interrupted";
  }
  if (message.role !== "toolResult") return false;
  if (message.toolName === "list_workflow_runs")
    return hasFailedDurableRun(details);
  if (
    typeof message.toolName !== "string" ||
    !WORKFLOW_DIAGNOSTIC_TOOLS.has(message.toolName)
  )
    return false;
  if (message.isError === true) return true;
  if (!isRecord(details)) return false;
  return (
    details.status === "error" ||
    details.status === "interrupted" ||
    typeof details.error === "string"
  );
}

/** Remove persisted workflow failure diagnostics before any later model request. */
export function sanitizeWorkflowDiagnosticContext<T>(messages: T[]): T[] {
  let changed = false;
  const sanitized = messages.map((candidate) => {
    if (!isRecord(candidate) || !shouldSanitizeWorkflowMessage(candidate))
      return candidate;
    changed = true;
    if (candidate.toolName === "list_workflow_runs") {
      return {
        ...candidate,
        ...(candidate.details === undefined
          ? {}
          : { details: sanitizeDiagnosticFields(candidate.details) }),
      } as T;
    }
    return {
      ...candidate,
      content:
        candidate.role === "custom"
          ? SAFE_WORKFLOW_DIAGNOSTIC
          : [
              {
                type: "text",
                text: SAFE_WORKFLOW_DIAGNOSTIC,
              },
            ],
      ...(candidate.details === undefined
        ? {}
        : { details: sanitizeDiagnosticFields(candidate.details) }),
    } as T;
  });
  return changed ? sanitized : messages;
}

export function registerWorkflowDiagnosticContextFilter(
  pi: ExtensionAPI,
): void {
  pi.on("context", (event) => {
    const messages = sanitizeWorkflowDiagnosticContext(event.messages);
    return messages === event.messages ? undefined : { messages };
  });
  pi.on("session_before_compact", (event) => {
    const preparation = event.preparation;
    preparation.messagesToSummarize = sanitizeWorkflowDiagnosticContext(
      preparation.messagesToSummarize,
    );
    preparation.turnPrefixMessages = sanitizeWorkflowDiagnosticContext(
      preparation.turnPrefixMessages,
    );
  });
}

export function safeWorkflowDiagnosticMessage(): string {
  return SAFE_WORKFLOW_DIAGNOSTIC;
}

export function modelSafeWorkflowErrorMessage(error: unknown): string {
  if (error instanceof WorkflowPrivateDiagnosticError)
    return SAFE_WORKFLOW_DIAGNOSTIC;
  return error instanceof Error ? error.message : String(error);
}
