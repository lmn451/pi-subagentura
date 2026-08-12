import {
  workflowPlanStatus,
  type WorkflowPlanProjection,
  type WorkflowPlanTaskStatus,
} from "./workflow-plan-state";

/** Options shared by the plan summary and its flattened detail rows. */
export interface WorkflowPlanUIOptions {
  readonly width?: number;
  readonly ascii?: boolean;
}

/** A terminal-agnostic row in a projected workflow plan tree. */
export interface WorkflowPlanRow {
  readonly depth: number;
  readonly text: string;
  readonly phaseId?: string;
  readonly taskId?: string;
  readonly status?: WorkflowPlanTaskStatus;
}

const DEFAULT_WIDTH = 120;
const MAX_VALUE_LENGTH = 512;
const TASK_STATUSES: readonly WorkflowPlanTaskStatus[] = [
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

/**
 * Sanitize untrusted workflow text without degrading ordinary Unicode. C0/C1
 * controls are collapsed so ANSI/CSI/OSC payloads are inert, while Unicode
 * bidi marks, embeddings, overrides, and isolates are removed before layout.
 */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Format the bounded, read-only overview of a plan projection.
 *
 * The projection is only traversed. In particular, task results are deliberately
 * not read: this presentation is useful for status and tree views, not output
 * inspection.
 */
export function formatWorkflowPlanSummary(
  projection: WorkflowPlanProjection,
  options: WorkflowPlanUIOptions = {},
): string {
  const phases = projectionPhases(projection);
  const tasks = phases.flatMap((phase) => projectionTasks(phase));
  const counts = countStatuses(tasks);
  const status = deriveStatus(projection, phases, tasks);
  const projectionDefinition = recordValue(projection, "definition");
  const name =
    safeValue(recordValue(projectionDefinition, "name")) || "workflow plan";
  const completed =
    counts.succeeded + counts.failed + counts.skipped + counts.cancelled;
  const parts = [
    name,
    `status: ${status}`,
    `${completed}/${tasks.length} complete`,
  ];
  if (counts.running > 0) parts.push(`${counts.running} active`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.failed > 0)
    parts.push(`${counts.failed} error${counts.failed === 1 ? "" : "s"}`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  return bound(parts.join(separator(options)), options);
}

/**
 * Flatten phases and tasks in declaration order for tree/detail adapters.
 *
 * `depth` carries hierarchy so callers can choose their own indentation. Every
 * valid task row includes its stable task ID and status. Result/output values
 * are never rendered.
 */
export function formatWorkflowPlanRows(
  projection: WorkflowPlanProjection,
  options: WorkflowPlanUIOptions = {},
): WorkflowPlanRow[] {
  const rows: WorkflowPlanRow[] = [];
  for (const phase of projectionPhases(projection)) {
    const phaseDefinition = recordValue(phase, "definition");
    const phaseId = stringValue(phaseDefinition, "id");
    const phaseName =
      stringValue(phaseDefinition, "name") || phaseId || "phase";
    const mode = phaseMode(phaseDefinition);
    rows.push({
      depth: 0,
      text: bound(
        `${options.ascii ? "*" : "◆"} phase: ${phaseName} [${mode}]`,
        options,
      ),
      ...(phaseId === undefined ? {} : { phaseId }),
    });

    for (const task of projectionTasks(phase)) {
      const definition = recordValue(task, "definition");
      const taskId = stringValue(definition, "id");
      if (taskId === undefined) continue;
      const status = taskStatus(task);
      const content = stringValue(definition, "content");
      const detail = taskDetail(task, status, options);
      const contentText = content ? `${separator(options)}${content}` : "";
      rows.push({
        depth: 1,
        text: bound(
          `${taskMarker(options, status)} ${taskId} [${status}]${detail}${contentText}`,
          options,
        ),
        ...(phaseId === undefined ? {} : { phaseId }),
        taskId,
        status,
      });
    }
  }
  return rows;
}

function taskDetail(
  task: unknown,
  status: WorkflowPlanTaskStatus,
  options: WorkflowPlanUIOptions,
): string {
  if (status === "running") return " (active)";
  if (status === "blocked") {
    const reason = safeValue(recordValue(task, "reason"));
    return reason ? `${separator(options)}blocked: ${reason}` : "";
  }
  if (status === "failed") {
    const error = safeValue(recordValue(task, "error"));
    return error ? `${separator(options)}error: ${error}` : "";
  }
  if (status === "skipped" || status === "cancelled") {
    const reason = safeValue(recordValue(task, "reason"));
    return reason ? `${separator(options)}reason: ${reason}` : "";
  }
  return "";
}

function deriveStatus(
  projection: WorkflowPlanProjection,
  phases: readonly unknown[],
  tasks: readonly unknown[],
): string {
  try {
    return workflowPlanStatus(projection);
  } catch {
    // Runtime callers may receive data from an older or partially decoded
    // adapter. Keep the projection view useful rather than throwing.
    if (tasks.some((task) => taskStatus(task) === "running")) return "running";
    if (tasks.some((task) => taskStatus(task) === "failed")) return "error";
    if (tasks.some((task) => taskStatus(task) === "cancelled"))
      return "cancelled";
    if (tasks.some((task) => taskStatus(task) === "blocked")) return "blocked";
    if (tasks.some((task) => taskStatus(task) === "pending")) return "running";
    return phases.length === 0 ||
      tasks.every((task) => isTerminal(taskStatus(task)))
      ? "done"
      : "running";
  }
}

function projectionPhases(projection: unknown): unknown[] {
  const phases = recordValue(projection, "phases");
  return Array.isArray(phases) ? phases.filter(isRecord) : [];
}

function projectionTasks(phase: unknown): unknown[] {
  const tasks = recordValue(phase, "tasks");
  return Array.isArray(tasks) ? tasks.filter(isRecord) : [];
}

function countStatuses(
  tasks: readonly unknown[],
): Record<WorkflowPlanTaskStatus, number> {
  const counts: Record<WorkflowPlanTaskStatus, number> = {
    pending: 0,
    running: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const task of tasks) counts[taskStatus(task)]++;
  return counts;
}

function taskStatus(task: unknown): WorkflowPlanTaskStatus {
  const status = recordValue(task, "status");
  return isTaskStatus(status) ? status : "pending";
}

function isTaskStatus(value: unknown): value is WorkflowPlanTaskStatus {
  return (
    typeof value === "string" &&
    TASK_STATUSES.includes(value as WorkflowPlanTaskStatus)
  );
}

function isTerminal(status: WorkflowPlanTaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "skipped" ||
    status === "cancelled"
  );
}

function phaseMode(phase: unknown): string {
  const mode = recordValue(phase, "mode");
  return mode === "parallel" ? "parallel" : "sequence";
}

function taskMarker(
  options: WorkflowPlanUIOptions,
  status: WorkflowPlanTaskStatus,
): string {
  if (options.ascii) {
    switch (status) {
      case "running":
        return ">";
      case "blocked":
        return "!";
      case "succeeded":
        return "OK";
      case "failed":
        return "X";
      case "skipped":
        return "-";
      case "cancelled":
        return "x";
      case "pending":
        return ".";
    }
  }
  switch (status) {
    case "running":
      return "→";
    case "blocked":
      return "!";
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "–";
    case "cancelled":
      return "⊘";
    case "pending":
      return "○";
  }
  return options.ascii ? "." : "○";
}

function separator(options: WorkflowPlanUIOptions): string {
  return options.ascii ? " - " : " · ";
}

function bound(value: string, options: WorkflowPlanUIOptions): string {
  const sanitizedValue = sanitizeTerminalText(value);
  const asciiValue = options.ascii ? toAscii(sanitizedValue) : sanitizedValue;
  return truncate(asciiValue, widthOf(options), options.ascii === true);
}

function toAscii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

function widthOf(options: WorkflowPlanUIOptions): number {
  const width = options.width;
  if (typeof width !== "number" || !Number.isFinite(width))
    return DEFAULT_WIDTH;
  return Math.max(0, Math.floor(width));
}

function truncate(value: string, width: number, ascii: boolean): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  const suffix = ascii ? "..." : "…";
  if (width <= suffix.length) return value.slice(0, width);
  return `${value.slice(0, width - suffix.length)}${suffix}`;
}

function safeValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return limitLine(value);
  if (value instanceof Error) return limitLine(value.message || value.name);
  try {
    const json = JSON.stringify(value);
    return limitLine(json === undefined ? String(value) : json);
  } catch {
    return limitLine(String(value));
  }
}

function limitLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, MAX_VALUE_LENGTH);
}

function stringValue(value: unknown, key: string): string | undefined {
  const candidate = recordValue(value, key);
  return typeof candidate === "string" && candidate.length > 0
    ? limitLine(candidate)
    : undefined;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
