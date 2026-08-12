import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";
import type { WorkflowRunStatus } from "./workflow-run-types";
import type { WorkflowTaskStatus } from "./workflow-plan";

export interface WorkflowPlanState {
  plan: WorkflowPlan;
  status: WorkflowRunStatus;
  currentPhase?: string;
  tasks: Record<string, WorkflowTaskStatus>;
  revision: number;
}

export type WorkflowPlanAction =
  | { type: "start"; taskId: string; phaseId: string }
  | { type: "succeed"; taskId: string }
  | { type: "fail"; taskId: string }
  | { type: "block"; taskId: string }
  | { type: "unblock"; taskId: string }
  | { type: "skip"; taskId: string }
  | { type: "cancel" };

export type WorkflowPlanMutation =
  | { type: "block"; taskId: string }
  | { type: "unblock"; taskId: string }
  | { type: "skip"; taskId: string }
  | {
      type: "append";
      phaseId: string;
      task: WorkflowPlan["phases"][number]["tasks"][number];
    };

export function createWorkflowPlanState(plan: WorkflowPlan): WorkflowPlanState {
  validateWorkflowPlan(plan);
  const tasks: Record<string, WorkflowTaskStatus> = {};
  for (const phase of plan.phases)
    for (const task of phase.tasks) tasks[task.id] = "pending";
  return { plan, status: "created", tasks, revision: 0 };
}

export function reduceWorkflowPlanState(
  state: WorkflowPlanState,
  action: WorkflowPlanAction,
): WorkflowPlanState {
  const next = {
    ...state,
    tasks: { ...state.tasks },
    revision: state.revision + 1,
  };
  if (action.type === "cancel") {
    if (
      state.status === "done" ||
      state.status === "error" ||
      state.status === "cancelled"
    )
      return state;
    next.status = "cancelled";
    return next;
  }
  const current = state.tasks[action.taskId];
  if (!current) throw new Error(`Unknown workflow task: ${action.taskId}`);
  if (action.type === "start") {
    if (
      current !== "pending" ||
      state.status === "done" ||
      state.status === "error" ||
      state.status === "cancelled"
    ) {
      throw new Error(`Task ${action.taskId} cannot start from ${current}`);
    }
    next.tasks[action.taskId] = "running";
    next.status = "running";
    next.currentPhase = action.phaseId;
  } else if (action.type === "block") {
    if (current !== "pending")
      throw new Error(`Task ${action.taskId} cannot block from ${current}`);
    next.tasks[action.taskId] = "blocked";
    next.status = "blocked";
  } else if (action.type === "unblock") {
    if (current !== "blocked")
      throw new Error(`Task ${action.taskId} cannot unblock from ${current}`);
    next.tasks[action.taskId] = "pending";
    next.status = "running";
  } else if (action.type === "skip") {
    if (current !== "pending" && current !== "blocked")
      throw new Error(`Task ${action.taskId} cannot skip from ${current}`);
    next.tasks[action.taskId] = "skipped";
    next.status = allTasksTerminal(next) ? "done" : "running";
  } else if (action.type === "succeed" || action.type === "fail") {
    if (current !== "running")
      throw new Error(`Task ${action.taskId} is not running`);
    next.tasks[action.taskId] =
      action.type === "succeed" ? "succeeded" : "failed";
    next.status =
      action.type === "fail"
        ? "error"
        : allTasksTerminal(next)
          ? "done"
          : "running";
  }
  return next;
}

/**
 * Apply one human/model plan edit without changing execution history.
 * Future-only edits are deliberately separate from execution transitions so a
 * caller cannot manufacture task outcomes through the mutation surface.
 */
export function mutateWorkflowPlanState(
  state: WorkflowPlanState,
  mutation: WorkflowPlanMutation,
  expectedRevision: number,
): WorkflowPlanState {
  if (expectedRevision !== state.revision) {
    throw new Error(
      `Workflow plan revision is stale: expected ${expectedRevision}, current ${state.revision}`,
    );
  }
  const current =
    mutation.type === "append" ? undefined : state.tasks[mutation.taskId];
  if (mutation.type !== "append" && !current) {
    throw new Error(`Unknown workflow task: ${mutation.taskId}`);
  }
  if (
    mutation.type !== "append" &&
    current !== "pending" &&
    current !== "blocked"
  ) {
    throw new Error(`Task ${mutation.taskId} is no longer mutable`);
  }
  if (mutation.type === "append") {
    if (
      state.status === "done" ||
      state.status === "error" ||
      state.status === "cancelled"
    ) {
      throw new Error("Cannot append work to a terminal workflow");
    }
    const phase = state.plan.phases.find(
      (candidate) => candidate.id === mutation.phaseId,
    );
    if (!phase) throw new Error(`Unknown workflow phase: ${mutation.phaseId}`);
    if (state.tasks[mutation.task.id]) {
      throw new Error(`Duplicate workflow task: ${mutation.task.id}`);
    }
    const plan = {
      ...state.plan,
      phases: state.plan.phases.map((candidate) =>
        candidate.id === mutation.phaseId
          ? { ...candidate, tasks: [...candidate.tasks, mutation.task] }
          : candidate,
      ),
    };
    validateWorkflowPlan(plan);
    return {
      ...state,
      plan,
      tasks: { ...state.tasks, [mutation.task.id]: "pending" },
      revision: state.revision + 1,
    };
  }
  const nextStatus =
    mutation.type === "skip"
      ? "skipped"
      : mutation.type === "block"
        ? "blocked"
        : "pending";
  return {
    ...state,
    tasks: { ...state.tasks, [mutation.taskId]: nextStatus },
    status:
      mutation.type === "block"
        ? "blocked"
        : state.status === "blocked"
          ? "running"
          : state.status,
    revision: state.revision + 1,
  };
}

function allTasksTerminal(state: WorkflowPlanState): boolean {
  return Object.values(state.tasks).every(
    (status) => status === "succeeded" || status === "skipped",
  );
}
