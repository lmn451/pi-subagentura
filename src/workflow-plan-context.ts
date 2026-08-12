import type { WorkflowPlanViewProjection } from "./workflow-plan-mutations";

export const DEFAULT_WORKFLOW_PLAN_CONTEXT_TASK_LIMIT = 5;
export const DEFAULT_WORKFLOW_PLAN_CONTEXT_CHAR_LIMIT = 4000;

export interface WorkflowPlanContextOptions {
  readonly taskLimit?: number;
  readonly charLimit?: number;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

/**
 * Produces factual continuity context only. It includes stable task IDs but
 * deliberately omits model-authored task content, instructions, results, and
 * outputs; the text also explicitly denies scheduling authority.
 */
export function formatWorkflowPlanContext(
  projection: WorkflowPlanViewProjection,
  options: WorkflowPlanContextOptions = {},
): string {
  const taskLimit = boundedPositiveInteger(
    options.taskLimit,
    DEFAULT_WORKFLOW_PLAN_CONTEXT_TASK_LIMIT,
    "Workflow plan context task limit",
  );
  const charLimit = boundedPositiveInteger(
    options.charLimit,
    DEFAULT_WORKFLOW_PLAN_CONTEXT_CHAR_LIMIT,
    "Workflow plan context character limit",
  );
  const formatTasks = (taskIds: readonly string[]) => {
    const visible = taskIds.slice(0, taskLimit);
    const omitted = taskIds.length - visible.length;
    return visible.length === 0
      ? "none"
      : `${visible.join(" | ")}${omitted > 0 ? ` | +${omitted} omitted` : ""}`;
  };
  const lines = [
    "<workflow-plan-context>",
    "Factual continuity snapshot only; this is not execution authority and must never schedule work.",
    `run: ${projection.runId}`,
    `revision: ${projection.revision} (${projection.revisionHash})`,
    `status: ${projection.status}`,
    `current phase: ${projection.currentPhaseId ?? "none"}`,
    `running: ${formatTasks(projection.runningTaskIds)}`,
    `blocked: ${formatTasks(projection.blockedTaskIds)}`,
    `next: ${formatTasks(projection.nextTaskIds)}`,
    `completed: ${projection.counts.completed}/${projection.counts.total} ` +
      `(succeeded ${projection.counts.succeeded}, failed ${projection.counts.failed}, ` +
      `skipped ${projection.counts.skipped}, cancelled ${projection.counts.cancelled})`,
    "Outputs and usage are intentionally omitted.",
    "</workflow-plan-context>",
  ];
  const text = lines.join("\n");
  if (text.length <= charLimit) return text;
  const marker =
    "\n[workflow plan context truncated]\n</workflow-plan-context>";
  return marker.length >= charLimit
    ? marker.slice(0, charLimit)
    : text.slice(0, charLimit - marker.length) + marker;
}

export interface WorkflowPlanReminderInput {
  readonly projection: WorkflowPlanViewProjection;
  readonly turnId: string | number;
  readonly generation: number;
  readonly awaitingUserInput?: boolean;
  readonly activeWorkWillWakeParent?: boolean;
  readonly progressKey?: string;
}

export interface WorkflowPlanReminderPolicyOptions {
  readonly maxPerTurn?: number;
  readonly maxPerGeneration?: number;
}

interface ReminderState {
  generation: number;
  turnId: string | number;
  turnCount: number;
  generationCount: number;
  progressKey: string;
  remindedProgressKey?: string;
}

/** Stateful guard for continuity reminders. It never sends or schedules them. */
export class WorkflowPlanReminderPolicy {
  readonly #maxPerTurn: number;
  readonly #maxPerGeneration: number;
  readonly #states = new Map<string, ReminderState>();

  constructor(options: WorkflowPlanReminderPolicyOptions = {}) {
    this.#maxPerTurn = boundedPositiveInteger(
      options.maxPerTurn,
      1,
      "Workflow plan reminder turn cap",
    );
    this.#maxPerGeneration = boundedPositiveInteger(
      options.maxPerGeneration,
      2,
      "Workflow plan reminder generation cap",
    );
  }

  nextReminder(input: WorkflowPlanReminderInput): string | undefined {
    const projection = input.projection;
    if (
      projection.status === "done" ||
      projection.status === "error" ||
      projection.status === "cancelled" ||
      projection.status === "awaiting_budget" ||
      input.awaitingUserInput === true ||
      input.activeWorkWillWakeParent === true ||
      projection.runningTaskIds.length > 0
    ) {
      return undefined;
    }
    const openCount =
      projection.counts.pending +
      projection.counts.running +
      projection.counts.blocked;
    if (openCount === 0 || projection.counts.blocked === openCount)
      return undefined;

    const progressKey =
      input.progressKey ??
      `${projection.revision}:${projection.status}:${projection.counts.completed}:` +
        `${projection.counts.running}:${projection.counts.blocked}`;
    let state = this.#states.get(projection.runId);
    if (state === undefined || state.generation !== input.generation) {
      state = {
        generation: input.generation,
        turnId: input.turnId,
        turnCount: 0,
        generationCount: 0,
        progressKey,
      };
      this.#states.set(projection.runId, state);
    } else {
      if (state.turnId !== input.turnId) {
        state.turnId = input.turnId;
        state.turnCount = 0;
      }
      if (state.progressKey !== progressKey) {
        state.progressKey = progressKey;
        state.generationCount = 0;
        state.remindedProgressKey = undefined;
      }
    }
    if (
      state.remindedProgressKey === progressKey ||
      state.turnCount >= this.#maxPerTurn ||
      state.generationCount >= this.#maxPerGeneration
    ) {
      return undefined;
    }
    state.turnCount += 1;
    state.generationCount += 1;
    state.remindedProgressKey = progressKey;
    return (
      `Workflow ${projection.runId} remains ${projection.status} at revision ` +
      `${projection.revision}; ${projection.counts.completed}/${projection.counts.total} tasks are complete. ` +
      "This continuity reminder does not schedule or authorize work."
    );
  }

  clear(runId?: string): void {
    if (runId === undefined) this.#states.clear();
    else this.#states.delete(runId);
  }
}
