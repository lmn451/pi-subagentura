import type { DurableValue } from "./workflow-durable-value";

export const WORKFLOW_PLAN_VERSION = 1 as const;
export type WorkflowPhaseMode = "sequential" | "parallel";
export type WorkflowTaskStatus =
  "pending" | "blocked" | "running" | "succeeded" | "failed" | "skipped";

export interface WorkflowPlanTask {
  id: string;
  prompt: string;
  label?: string;
  isolation?: "in-process" | "process";
  input?: DurableValue;
  approval?: {
    policyHash: string;
    denial: "stop" | "skip";
  };
}

export interface WorkflowPlanPhase {
  id: string;
  mode: WorkflowPhaseMode;
  tasks: WorkflowPlanTask[];
}

export interface WorkflowPlan {
  schemaVersion: typeof WORKFLOW_PLAN_VERSION;
  name: string;
  phases: WorkflowPlanPhase[];
}

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MAX_PHASES = 64;
const MAX_TASKS = 1024;

export function validateWorkflowPlan(plan: WorkflowPlan): void {
  if (plan.schemaVersion !== WORKFLOW_PLAN_VERSION || !ID.test(plan.name)) {
    throw new Error("Invalid workflow plan header");
  }
  if (
    !Array.isArray(plan.phases) ||
    plan.phases.length === 0 ||
    plan.phases.length > MAX_PHASES
  ) {
    throw new Error("Workflow plan must contain 1-64 phases");
  }
  const ids = new Set<string>();
  let taskCount = 0;
  for (const phase of plan.phases) {
    if (
      !ID.test(phase.id) ||
      !["sequential", "parallel"].includes(phase.mode) ||
      ids.has(phase.id)
    ) {
      throw new Error(`Invalid or duplicate phase id: ${phase.id}`);
    }
    ids.add(phase.id);
    for (const task of phase.tasks) {
      taskCount++;
      if (
        taskCount > MAX_TASKS ||
        !ID.test(task.id) ||
        ids.has(task.id) ||
        !task.prompt.trim()
      ) {
        throw new Error(`Invalid or duplicate task id: ${task.id}`);
      }
      if (
        task.approval !== undefined &&
        (!task.approval.policyHash.trim() ||
          !["stop", "skip"].includes(task.approval.denial))
      ) {
        throw new Error(`Invalid approval gate for task: ${task.id}`);
      }
      ids.add(task.id);
    }
  }
}
