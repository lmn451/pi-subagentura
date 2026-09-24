import type {
  ProcessExitKind,
  ProcessExitPhase,
  ProcessTerminationReason,
} from "./artifact";

export const FAILURE_CODES = Object.freeze([
  "provider_error",
  "workflow_schema_invalid",
  "workflow_timeout",
  "workflow_capacity_limit",
  "interactive_process_exit",
  "unknown",
] as const);
const FAILURE_CODE_SET: ReadonlySet<string> = new Set(FAILURE_CODES);

export type FailureCode = (typeof FAILURE_CODES)[number];

export interface FailureGuidance {
  label: string;
  explanation: string;
  action: string;
}

const FAILURE_GUIDANCE: Record<FailureCode, FailureGuidance> = {
  provider_error: {
    label: "Provider error",
    explanation: "The model provider reported a structured request failure.",
    action:
      "Check provider credentials, model availability, and service status; inspect the local error for exact details.",
  },
  workflow_schema_invalid: {
    label: "Workflow schema validation failed",
    explanation:
      "The requested structured output did not satisfy the configured schema.",
    action:
      "Review the schema and the expected output shape, then retry with a compatible response contract.",
  },
  workflow_timeout: {
    label: "Workflow timed out",
    explanation: "The workflow exceeded its configured wall-clock deadline.",
    action:
      "Reduce the workflow scope or split slow work into smaller runs, then retry.",
  },
  workflow_capacity_limit: {
    label: "Workflow capacity limit reached",
    explanation:
      "The workflow reached its configured agent-attempt lifetime cap.",
    action:
      "Split the workflow into smaller batches or remove redundant agent calls.",
  },
  interactive_process_exit: {
    label: "Interactive sub-agent process exit",
    explanation:
      "The process exit is reported separately from the task outcome and does not identify the underlying cause.",
    action:
      "Inspect the local supervisor artifact and child session output, then retry the task.",
  },
  unknown: {
    label: "Unknown diagnostic",
    explanation: "No known structured failure code was available.",
    action:
      "Inspect the local error and artifact details; raw errors are intentionally not sent in telemetry.",
  },
};

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && FAILURE_CODE_SET.has(value);
}

export function normalizeFailureCode(value: unknown): FailureCode {
  return isFailureCode(value) ? value : "unknown";
}

export function failureGuidance(value: unknown): FailureGuidance {
  return FAILURE_GUIDANCE[normalizeFailureCode(value)];
}

export function formatFailureGuidance(value: unknown): string {
  const code = normalizeFailureCode(value);
  const guidance = failureGuidance(code);
  return `Diagnostic [${code}]: ${guidance.label}. ${guidance.explanation}\nSuggested action: ${guidance.action}`;
}

const PROCESS_EXIT_PHASES: readonly ProcessExitPhase[] = [
  "active_tool",
  "active_turn",
  "after_completion",
  "unknown",
];

const PROCESS_EXIT_KINDS: readonly ProcessExitKind[] = [
  "normal",
  "nonzero",
  "signal",
  "cancelled",
  "unknown",
];

const PROCESS_TERMINATION_REASONS: readonly ProcessTerminationReason[] = [
  "normal_exit",
  "active_tool",
  "active_turn",
  "signal",
  "nonzero_exit",
  "cancelled",
  "unknown",
];

function allowedValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

/** Format only bounded process context read from a normalized artifact event. */
export function formatProcessExitContext(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  const isProcessExit =
    event.type === "process_exited" ||
    (event.type === "completion" && event.source === "process_exit");
  if (!isProcessExit) return undefined;
  const details = [
    ...(event.type === "process_exited"
      ? (() => {
          const reason = allowedValue(
            event.terminationReason,
            PROCESS_TERMINATION_REASONS,
          );
          return reason ? [`terminationReason=${reason}`] : [];
        })()
      : []),
    ...(allowedValue(event.processExitPhase, PROCESS_EXIT_PHASES)
      ? [
          `processExitPhase=${allowedValue(event.processExitPhase, PROCESS_EXIT_PHASES)}`,
        ]
      : []),
    ...(allowedValue(event.processExitKind, PROCESS_EXIT_KINDS)
      ? [
          `processExitKind=${allowedValue(event.processExitKind, PROCESS_EXIT_KINDS)}`,
        ]
      : []),
  ];
  return details.length > 0
    ? `Process context: ${details.join(", ")}`
    : undefined;
}

/** Classify only structured artifact fields; never inspect message text. */
export function failureCodeFromArtifactEvent(
  event: unknown,
): FailureCode | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return undefined;
  }
  const record = event as Record<string, unknown>;
  const status = record.status ?? record.outcome;
  if (status === "cancelled") return undefined;
  if (record.type === "process_exited") {
    if (status === "error") return "interactive_process_exit";
    const phase = allowedValue(record.processExitPhase, PROCESS_EXIT_PHASES);
    return phase === "active_tool" || phase === "active_turn"
      ? "interactive_process_exit"
      : undefined;
  }
  if (status !== "error") return undefined;
  if (record.type === "completion" && record.source === "process_exit") {
    return "interactive_process_exit";
  }
  if (
    record.type === "completion" &&
    record.source === "agent_settled" &&
    record.agentStopReason === "error"
  ) {
    return "provider_error";
  }
  return "unknown";
}

function eventsForLatestTurn(
  events: readonly unknown[],
): Record<string, unknown>[] {
  const records = events.filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object" && !Array.isArray(event),
  );
  const latest = records.at(-1);
  if (!latest) return [];
  const turnId = typeof latest.turnId === "string" ? latest.turnId : undefined;
  return turnId ? records.filter((event) => event.turnId === turnId) : [latest];
}

/** Keep local diagnosis tied to the latest physical turn, never prior history. */
export function failureCodeFromArtifactEvents(
  events: readonly unknown[],
): FailureCode | undefined {
  const current = eventsForLatestTurn(events);
  const completion = [...current]
    .reverse()
    .find(
      (event) =>
        event.type === "completion" ||
        event.type === "done" ||
        event.type === "error" ||
        event.type === "cancelled",
    );
  const outcome = completion?.status ?? completion?.outcome;
  if (outcome === "cancelled") return undefined;
  if (outcome === "error") {
    return failureCodeFromArtifactEvent(completion);
  }
  const processExit = [...current]
    .reverse()
    .find((event) => event.type === "process_exited");
  return failureCodeFromArtifactEvent(
    processExit ?? completion ?? current.at(-1),
  );
}

/** Return the newest allowlisted process context in the latest observed turn. */
export function processExitContextFromArtifactEvents(
  events: readonly unknown[],
): string | undefined {
  const current = eventsForLatestTurn(events);
  for (const event of [...current].reverse()) {
    const context = formatProcessExitContext(event);
    if (context) return context;
  }
  return undefined;
}
