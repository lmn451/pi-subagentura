import type { WorkflowPlan } from "./workflow-plan";
import type { WorkflowRunStatus } from "./workflow-run-types";
import type { WorkflowProjection } from "./workflow-projection-repository";

export interface WorkflowContinuityTask {
  id: string;
  status: string;
}

export interface WorkflowContinuitySnapshot {
  runId: string;
  revision: number;
  status: WorkflowRunStatus;
  phase?: string;
  phaseMode?: string;
  tasks: WorkflowContinuityTask[];
  pendingCount: number;
  blockedCount: number;
  approvalPendingCount: number;
  awaitingBudget: boolean;
}

export interface WorkflowReminderState {
  generation: number;
  emitted: number;
  lastProgressRevision: number;
}

export const MAX_CONTINUITY_TASKS = 12;
export const MAX_CONTINUITY_CHARS = 1800;
export const MAX_REMINDERS_PER_GENERATION = 1;

export function workflowContinuitySnapshot(
  projection: WorkflowProjection,
  plan?: WorkflowPlan,
): WorkflowContinuitySnapshot {
  const tasks = Object.values(projection.tasks);
  const phase = plan?.phases.find(
    (candidate) => candidate.id === projection.currentPhase,
  );
  return {
    runId: projection.runId,
    revision: projection.revision,
    status: projection.status,
    phase: projection.currentPhase,
    phaseMode: phase?.mode,
    tasks: tasks.slice(0, MAX_CONTINUITY_TASKS).map((task) => ({
      id: task.id,
      status: task.status,
    })),
    pendingCount: tasks.filter((task) => task.status === "pending").length,
    blockedCount: tasks.filter((task) => task.status === "blocked").length,
    approvalPendingCount: projection.approval?.status === "pending" ? 1 : 0,
    awaitingBudget: projection.status === "awaiting_budget",
  };
}

export function clearWorkflowContinuity(scope: {
  durableWorkflowContinuity?: WorkflowContinuitySnapshot;
}): void {
  scope.durableWorkflowContinuity = undefined;
}

export function formatWorkflowContinuity(
  snapshot: WorkflowContinuitySnapshot,
): string {
  const tasks = snapshot.tasks
    .slice(0, MAX_CONTINUITY_TASKS)
    .map((task) => `${task.id}=${task.status}`)
    .join(", ");
  const omitted = Math.max(0, snapshot.tasks.length - MAX_CONTINUITY_TASKS);
  const text = [
    "Durable workflow continuity (factual, non-authoritative; outputs omitted):",
    `run=${snapshot.runId} revision=${snapshot.revision} status=${snapshot.status}`,
    `phase=${snapshot.phase ?? "unknown"} mode=${snapshot.phaseMode ?? "unknown"}`,
    `pending=${snapshot.pendingCount} blocked=${snapshot.blockedCount} approvals=${snapshot.approvalPendingCount} awaiting_budget=${snapshot.awaitingBudget}`,
    `tasks=${tasks || "none"}${omitted ? ` (+${omitted} omitted)` : ""}`,
  ].join("\n");
  return text.slice(0, MAX_CONTINUITY_CHARS);
}

export function shouldRemindWorkflow(input: {
  activeWakeup: boolean;
  allBlocked: boolean;
  awaitingUserInput: boolean;
  state: WorkflowReminderState;
  revision: number;
  generation: number;
}): boolean {
  if (input.activeWakeup || input.allBlocked || input.awaitingUserInput)
    return false;
  if (input.generation !== input.state.generation) return true;
  return input.state.emitted < MAX_REMINDERS_PER_GENERATION;
}

export function recordWorkflowReminder(
  state: WorkflowReminderState,
  revision: number,
  generation: number,
): WorkflowReminderState {
  return {
    generation,
    emitted: generation === state.generation ? state.emitted + 1 : 1,
    lastProgressRevision: revision,
  };
}
