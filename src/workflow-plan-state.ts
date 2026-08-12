import type {
  DurableWorkflowStatus,
  WorkflowPlanTaskStatus,
} from "./workflow-run-types";
import type {
  WorkflowPlanDefinition,
  WorkflowPlanPhaseDefinition,
  WorkflowPlanTaskDefinition,
} from "./workflow-plan";

export type { WorkflowPlanTaskStatus } from "./workflow-run-types";

export const WORKFLOW_PLAN_TASK_STATUSES = [
  "pending",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const satisfies readonly WorkflowPlanTaskStatus[];

export const TERMINAL_WORKFLOW_PLAN_TASK_STATUSES = [
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
] as const satisfies readonly WorkflowPlanTaskStatus[];

export const WORKFLOW_PLAN_STATUSES = [
  "running",
  "blocked",
  "done",
  "error",
  "cancelled",
] as const satisfies readonly DurableWorkflowStatus[];

export type WorkflowPlanStatus = (typeof WORKFLOW_PLAN_STATUSES)[number];

export interface WorkflowPlanTaskProjection {
  readonly definition: WorkflowPlanTaskDefinition;
  readonly phaseId: string;
  readonly status: WorkflowPlanTaskStatus;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly reason?: string;
}

export interface WorkflowPlanPhaseProjection {
  readonly definition: WorkflowPlanPhaseDefinition;
  readonly tasks: readonly WorkflowPlanTaskProjection[];
}

export interface WorkflowPlanProjection {
  readonly definition: WorkflowPlanDefinition;
  readonly phases: readonly WorkflowPlanPhaseProjection[];
}

export type WorkflowPlanEvent =
  | {
      readonly type: "task_started";
      readonly taskId: string;
    }
  | {
      readonly type: "task_blocked";
      readonly taskId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "task_unblocked";
      readonly taskId: string;
    }
  | {
      readonly type: "task_succeeded";
      readonly taskId: string;
      readonly result: unknown;
    }
  | {
      readonly type: "task_failed";
      readonly taskId: string;
      readonly error: unknown;
    }
  | {
      readonly type: "task_skipped";
      readonly taskId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "task_cancelled";
      readonly taskId: string;
      readonly reason?: string;
    }
  | {
      readonly type: "run_cancelled";
      readonly reason?: string;
    };

const LEGAL_TASK_TRANSITIONS: Readonly<
  Record<WorkflowPlanTaskStatus, readonly WorkflowPlanTaskStatus[]>
> = {
  pending: ["running", "blocked", "skipped", "cancelled"],
  running: ["succeeded", "failed", "skipped", "cancelled"],
  blocked: ["pending", "skipped", "cancelled"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export function isTerminalWorkflowPlanTaskStatus(
  status: WorkflowPlanTaskStatus,
): status is "succeeded" | "failed" | "skipped" | "cancelled" {
  return TERMINAL_WORKFLOW_PLAN_TASK_STATUSES.some(
    (terminalStatus) => terminalStatus === status,
  );
}

export function isLegalTaskTransition(
  from: WorkflowPlanTaskStatus,
  to: WorkflowPlanTaskStatus,
): boolean {
  return LEGAL_TASK_TRANSITIONS[from].some((status) => status === to);
}

export function assertLegalTaskTransition(
  from: WorkflowPlanTaskStatus,
  to: WorkflowPlanTaskStatus,
): void {
  if (!isLegalTaskTransition(from, to)) {
    throw new Error(`Illegal workflow plan task transition: ${from} -> ${to}`);
  }
}

export function createPlanProjection(
  definition: WorkflowPlanDefinition,
): WorkflowPlanProjection {
  const definitionCopy: WorkflowPlanDefinition = {
    name: definition.name,
    description: definition.description,
    phases: definition.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      mode: phase.mode,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        content: task.content,
        instruction: task.instruction,
        ...(task.agent === undefined ? {} : { agent: task.agent }),
      })),
    })),
  };

  return {
    definition: definitionCopy,
    phases: definitionCopy.phases.map((phase) => ({
      definition: phase,
      tasks: phase.tasks.map((task) => ({
        definition: task,
        phaseId: phase.id,
        status: "pending",
      })),
    })),
  };
}

export function applyPlanEvent(
  projection: WorkflowPlanProjection,
  event: WorkflowPlanEvent,
): WorkflowPlanProjection {
  const status = workflowPlanStatus(projection);
  if (status === "done" || status === "error" || status === "cancelled") {
    throw new Error(
      `Cannot apply ${event.type} to terminal workflow plan (${status})`,
    );
  }

  if (event.type === "run_cancelled") {
    return cancelNonterminalTasks(projection, event.reason);
  }

  const currentTask = findTask(projection, event.taskId);
  const targetStatus = eventTargetStatus(event);
  assertLegalTaskTransition(currentTask.status, targetStatus);

  if (
    event.type === "task_started" &&
    !selectReadyTasks(projection, Number.MAX_SAFE_INTEGER).some(
      (task) => task.definition.id === event.taskId,
    )
  ) {
    throw new Error(`Workflow plan task "${event.taskId}" is not eligible`);
  }

  const nextTask = transitionTask(currentTask, event, targetStatus);
  const transitioned = replaceTask(projection, event.taskId, nextTask);

  return event.type === "task_failed" || event.type === "task_cancelled"
    ? cancelUndispatchedTasks(transitioned)
    : transitioned;
}

export function selectReadyTasks(
  projection: WorkflowPlanProjection,
  concurrencyLimit: number,
): WorkflowPlanTaskProjection[] {
  assertPositiveConcurrencyLimit(concurrencyLimit);

  let runningCount = 0;
  for (const phase of projection.phases) {
    for (const task of phase.tasks) {
      if (task.status === "failed" || task.status === "cancelled") {
        return [];
      }
      if (task.status === "running") {
        runningCount++;
      }
    }
  }

  const availableSlots = concurrencyLimit - runningCount;
  if (availableSlots <= 0) {
    return [];
  }

  const currentPhase = projection.phases.find((phase) =>
    phase.tasks.some(isNonterminalTask),
  );
  if (currentPhase === undefined) {
    return [];
  }

  if (currentPhase.definition.mode === "parallel") {
    const ready: WorkflowPlanTaskProjection[] = [];
    for (const task of currentPhase.tasks) {
      if (task.status === "pending") {
        ready.push(task);
        if (ready.length === availableSlots) {
          break;
        }
      }
    }
    return ready;
  }

  for (const task of currentPhase.tasks) {
    if (task.status === "succeeded" || task.status === "skipped") {
      continue;
    }
    return task.status === "pending" ? [task] : [];
  }

  return [];
}

export function workflowPlanStatus(
  projection: WorkflowPlanProjection,
): WorkflowPlanStatus {
  let hasFailed = false;
  let hasCancelled = false;
  let hasBlocked = false;
  let allTerminal = true;

  for (const phase of projection.phases) {
    for (const task of phase.tasks) {
      if (task.status === "running") {
        return "running";
      }
      if (!isTerminalWorkflowPlanTaskStatus(task.status)) {
        allTerminal = false;
      }
      if (task.status === "failed") {
        hasFailed = true;
      } else if (task.status === "cancelled") {
        hasCancelled = true;
      } else if (task.status === "blocked") {
        hasBlocked = true;
      }
    }
  }

  if (hasEligiblePendingTask(projection)) {
    return "running";
  }
  if (hasFailed) {
    return "error";
  }
  if (hasCancelled) {
    return "cancelled";
  }
  if (hasBlocked) {
    return "blocked";
  }
  return allTerminal ? "done" : "running";
}

function eventTargetStatus(
  event: Exclude<WorkflowPlanEvent, { type: "run_cancelled" }>,
): WorkflowPlanTaskStatus {
  switch (event.type) {
    case "task_started":
      return "running";
    case "task_blocked":
      return "blocked";
    case "task_unblocked":
      return "pending";
    case "task_succeeded":
      return "succeeded";
    case "task_failed":
      return "failed";
    case "task_skipped":
      return "skipped";
    case "task_cancelled":
      return "cancelled";
  }
}

function transitionTask(
  task: WorkflowPlanTaskProjection,
  event: Exclude<WorkflowPlanEvent, { type: "run_cancelled" }>,
  status: WorkflowPlanTaskStatus,
): WorkflowPlanTaskProjection {
  const base: WorkflowPlanTaskProjection = {
    definition: task.definition,
    phaseId: task.phaseId,
    status,
  };

  switch (event.type) {
    case "task_succeeded":
      return { ...base, result: event.result };
    case "task_failed":
      return { ...base, error: event.error };
    case "task_blocked":
    case "task_skipped":
    case "task_cancelled":
      return event.reason === undefined
        ? base
        : { ...base, reason: event.reason };
    case "task_started":
    case "task_unblocked":
      return base;
  }
}

function replaceTask(
  projection: WorkflowPlanProjection,
  taskId: string,
  replacement: WorkflowPlanTaskProjection,
): WorkflowPlanProjection {
  return {
    definition: projection.definition,
    phases: projection.phases.map((phase) => {
      const taskIndex = phase.tasks.findIndex(
        (task) => task.definition.id === taskId,
      );
      if (taskIndex === -1) {
        return phase;
      }
      return {
        definition: phase.definition,
        tasks: phase.tasks.map((task, index) =>
          index === taskIndex ? replacement : task,
        ),
      };
    }),
  };
}

function findTask(
  projection: WorkflowPlanProjection,
  taskId: string,
): WorkflowPlanTaskProjection {
  for (const phase of projection.phases) {
    const task = phase.tasks.find(
      (candidate) => candidate.definition.id === taskId,
    );
    if (task !== undefined) {
      return task;
    }
  }
  throw new Error(`Unknown workflow plan task "${taskId}"`);
}

function cancelUndispatchedTasks(
  projection: WorkflowPlanProjection,
): WorkflowPlanProjection {
  return mapTasks(projection, (task) =>
    task.status === "pending" || task.status === "blocked"
      ? {
          definition: task.definition,
          phaseId: task.phaseId,
          status: "cancelled",
        }
      : task,
  );
}

function cancelNonterminalTasks(
  projection: WorkflowPlanProjection,
  reason: string | undefined,
): WorkflowPlanProjection {
  return mapTasks(projection, (task) => {
    if (!isNonterminalTask(task)) {
      return task;
    }
    const cancelled: WorkflowPlanTaskProjection = {
      definition: task.definition,
      phaseId: task.phaseId,
      status: "cancelled",
    };
    return reason === undefined ? cancelled : { ...cancelled, reason };
  });
}

function mapTasks(
  projection: WorkflowPlanProjection,
  mapTask: (task: WorkflowPlanTaskProjection) => WorkflowPlanTaskProjection,
): WorkflowPlanProjection {
  return {
    definition: projection.definition,
    phases: projection.phases.map((phase) => ({
      definition: phase.definition,
      tasks: phase.tasks.map(mapTask),
    })),
  };
}

function isNonterminalTask(task: WorkflowPlanTaskProjection): boolean {
  return (
    task.status === "pending" ||
    task.status === "running" ||
    task.status === "blocked"
  );
}

function hasEligiblePendingTask(projection: WorkflowPlanProjection): boolean {
  for (const phase of projection.phases) {
    for (const task of phase.tasks) {
      if (task.status === "failed" || task.status === "cancelled") {
        return false;
      }
    }
  }

  const currentPhase = projection.phases.find((phase) =>
    phase.tasks.some(isNonterminalTask),
  );
  if (currentPhase === undefined) {
    return false;
  }

  if (currentPhase.definition.mode === "parallel") {
    return currentPhase.tasks.some((task) => task.status === "pending");
  }

  for (const task of currentPhase.tasks) {
    if (task.status === "succeeded" || task.status === "skipped") {
      continue;
    }
    return task.status === "pending";
  }

  return false;
}

function assertPositiveConcurrencyLimit(concurrencyLimit: number): void {
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit <= 0) {
    throw new RangeError("concurrencyLimit must be a positive safe integer");
  }
}
