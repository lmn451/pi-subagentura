import { createHash } from "node:crypto";
import { toDurableValue } from "./workflow-durable-value";
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

export interface WorkflowPlanValidationOptions {
  /**
   * Durable execution is in-process only for the current admission protocol.
   * Non-durable preview plans may still select process isolation.
   */
  durable?: boolean;
}

export function validateWorkflowPlan(
  plan: WorkflowPlan,
  options: WorkflowPlanValidationOptions = {},
): void {
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
      ids.has(phase.id) ||
      !Array.isArray(phase.tasks)
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
      if (task.isolation === "process")
        throw new Error("Process isolation is not supported by the preview");
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

export function assertDurableWorkflowPlan(plan: WorkflowPlan): void {
  validateWorkflowPlan(plan, { durable: true });
}
/**
 * Produce the immutable plan snapshot used by both execution and persistence.
 *
 * Only declared plan fields are retained, optional values are omitted when
 * absent, and durable input values are validated while being copied. This
 * prevents caller mutation after admission from changing the run definition.
 */
export function normalizeWorkflowPlan(
  plan: WorkflowPlan,
  options: WorkflowPlanValidationOptions = {},
): WorkflowPlan {
  validateWorkflowPlan(plan, options);
  return {
    schemaVersion: WORKFLOW_PLAN_VERSION,
    name: plan.name,
    phases: plan.phases.map((phase) => ({
      id: phase.id,
      mode: phase.mode,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        prompt: task.prompt,
        ...(task.label === undefined ? {} : { label: task.label }),
        ...(task.isolation === undefined ? {} : { isolation: task.isolation }),
        ...(task.input === undefined
          ? {}
          : { input: toDurableValue(task.input) }),
      })),
    })),
  };
}

/**
 * Serialize JSON-compatible values with object keys in lexical order.
 *
 * Arrays retain their declared order because phase/task order is observable;
 * object insertion order is not part of a workflow definition.
 */
export function canonicalizeWorkflowValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Cannot canonicalize a number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeWorkflowValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalizeWorkflowValue(item)}`,
      )
      .join(",")}}`;
  }
  throw new Error("Cannot canonicalize an unsupported workflow value");
}

export function canonicalWorkflowPlanDigest(
  normalizedPlan: WorkflowPlan,
): string {
  return createHash("sha256")
    .update(canonicalizeWorkflowValue(normalizedPlan))
    .digest("hex");
}

export function workflowPlanDigest(plan: WorkflowPlan): string {
  return canonicalWorkflowPlanDigest(normalizeWorkflowPlan(plan));
}

/** Compatibility spelling for callers that describe the operation as hashing. */
export const digestWorkflowPlan = workflowPlanDigest;
