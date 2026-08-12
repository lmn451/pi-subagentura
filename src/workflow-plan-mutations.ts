import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
  type WorkflowPlanPhaseDefinition,
  type WorkflowPlanTaskDefinition,
} from "./workflow-plan";
import type {
  DurableWorkflowOwner,
  DurableWorkflowRunId,
  DurableWorkflowStatus,
  WorkflowDefinitionDigest,
  WorkflowPlanRevisionAudit,
  WorkflowPlanRevisionTransition,
  WorkflowPlanTaskStatus,
  WorkflowSha256Digest,
} from "./workflow-run-types";

export const WORKFLOW_PLAN_MUTATION_REASON_MAX_LENGTH = 4096;

export type WorkflowPlanMutation =
  | {
      readonly operation: "append";
      readonly phaseId: string;
      readonly task: WorkflowPlanTaskDefinition;
    }
  | {
      readonly operation: "block";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly operation: "unblock";
      readonly taskId: string;
    }
  | {
      readonly operation: "skip";
      readonly taskId: string;
      readonly reason: string;
    }
  | {
      readonly operation: "replace_future";
      readonly plan: WorkflowPlanDefinition;
    };

export type ModelWorkflowPlanMutation = Exclude<
  WorkflowPlanMutation,
  { readonly operation: "replace_future" }
>;

export interface WorkflowPlanMutationActor {
  readonly kind: "model" | "human";
  readonly id: string;
}

export interface WorkflowPlanMutationFence {
  readonly expectedOwner: DurableWorkflowOwner;
  readonly expectedRunEpoch: number;
  readonly baseRevision: number;
}

export interface WorkflowPlanMutationRequest extends WorkflowPlanMutationFence {
  readonly actor: WorkflowPlanMutationActor;
  readonly mutation: WorkflowPlanMutation;
}

export interface AppliedWorkflowPlanMutation {
  readonly plan: WorkflowPlanDefinition;
  readonly audit: WorkflowPlanRevisionAudit;
  readonly wakeEligible: boolean;
}

export interface WorkflowPlanTaskView {
  readonly id: string;
  readonly content: string;
  readonly instruction: string;
  readonly phaseId: string;
  readonly status: WorkflowPlanTaskStatus;
  readonly mutable: boolean;
}

export interface WorkflowPlanPhaseView {
  readonly id: string;
  readonly name: string;
  readonly mode: "sequence" | "parallel";
  readonly tasks: readonly WorkflowPlanTaskView[];
}

export interface WorkflowPlanViewProjection {
  readonly runId: DurableWorkflowRunId;
  readonly owner: DurableWorkflowOwner;
  readonly runEpoch: number;
  readonly revision: number;
  readonly revisionHash: WorkflowSha256Digest;
  readonly definitionHash: WorkflowDefinitionDigest;
  readonly status: DurableWorkflowStatus;
  readonly definition: WorkflowPlanDefinition;
  readonly currentPhaseId?: string;
  readonly runningTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly nextTaskIds: readonly string[];
  readonly counts: Readonly<{
    pending: number;
    running: number;
    blocked: number;
    succeeded: number;
    failed: number;
    skipped: number;
    cancelled: number;
    completed: number;
    total: number;
  }>;
  readonly phases: readonly WorkflowPlanPhaseView[];
}

export class WorkflowPlanMutationError extends Error {
  readonly code:
    | "invalid_mutation"
    | "phase_not_found"
    | "task_not_found"
    | "immutable_task"
    | "duplicate_task_id"
    | "no_future_work"
    | "no_change";

  constructor(code: WorkflowPlanMutationError["code"], message: string) {
    super(message);
    this.name = "WorkflowPlanMutationError";
    this.code = code;
  }
}

function normalizedReason(reason: string, operation: "block" | "skip"): string {
  const value = reason.trim();
  if (
    value.length === 0 ||
    value.length > WORKFLOW_PLAN_MUTATION_REASON_MAX_LENGTH
  ) {
    throw new WorkflowPlanMutationError(
      "invalid_mutation",
      `${operation} requires a non-empty reason no longer than ${WORKFLOW_PLAN_MUTATION_REASON_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

function taskStatus(
  taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>,
  taskId: string,
): WorkflowPlanTaskStatus {
  return taskStates[taskId] ?? "pending";
}

function taskLocation(
  plan: WorkflowPlanDefinition,
  taskId: string,
): {
  readonly phase: WorkflowPlanPhaseDefinition;
  readonly phaseIndex: number;
  readonly task: WorkflowPlanTaskDefinition;
} {
  for (let phaseIndex = 0; phaseIndex < plan.phases.length; phaseIndex += 1) {
    const phase = plan.phases[phaseIndex]!;
    const task = phase.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined) return { phase, phaseIndex, task };
  }
  throw new WorkflowPlanMutationError(
    "task_not_found",
    `Workflow plan task "${taskId}" was not found.`,
  );
}

function currentFuturePhaseIndex(
  plan: WorkflowPlanDefinition,
  taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>,
): number {
  return plan.phases.findIndex((phase) =>
    phase.tasks.some((task) => {
      const status = taskStatus(taskStates, task.id);
      return (
        status === "pending" || status === "blocked" || status === "running"
      );
    }),
  );
}

function assertFuturePhase(
  plan: WorkflowPlanDefinition,
  taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>,
  phaseIndex: number,
): void {
  const current = currentFuturePhaseIndex(plan, taskStates);
  if (current < 0) {
    throw new WorkflowPlanMutationError(
      "no_future_work",
      "The workflow plan has no mutable future phase.",
    );
  }
  if (phaseIndex < current) {
    throw new WorkflowPlanMutationError(
      "immutable_task",
      "Completed workflow plan phases are immutable.",
    );
  }
}

function equalTaskDefinition(
  left: WorkflowPlanTaskDefinition,
  right: WorkflowPlanTaskDefinition,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readyTaskIds(
  plan: WorkflowPlanDefinition,
  taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>,
): string[] {
  for (const phase of plan.phases) {
    const statuses = phase.tasks.map((task) => taskStatus(taskStates, task.id));
    if (
      statuses.every((status) => status === "succeeded" || status === "skipped")
    ) {
      continue;
    }
    if (phase.mode === "parallel") {
      return phase.tasks
        .filter((task) => taskStatus(taskStates, task.id) === "pending")
        .map((task) => task.id);
    }
    for (const task of phase.tasks) {
      const status = taskStatus(taskStates, task.id);
      if (status === "succeeded" || status === "skipped") continue;
      return status === "pending" ? [task.id] : [];
    }
    return [];
  }
  return [];
}

function withAudit(
  plan: WorkflowPlanDefinition,
  actor: WorkflowPlanMutationActor,
  operation: WorkflowPlanRevisionAudit["operation"],
  appendedTaskIds: readonly string[],
  transitions: readonly WorkflowPlanRevisionTransition[],
  wakeEligible: boolean,
): AppliedWorkflowPlanMutation {
  return {
    plan,
    audit: {
      operation,
      actorKind: actor.kind,
      actorId: actor.id,
      appendedTaskIds: Object.freeze([...appendedTaskIds]),
      transitions: Object.freeze(
        transitions.map((transition) => Object.freeze({ ...transition })),
      ),
    },
    wakeEligible,
  };
}

/**
 * Applies one declarative future-work operation. Runtime settlement states and
 * evidence are intentionally absent from this API.
 */
export function applyWorkflowPlanMutation(
  currentPlan: WorkflowPlanDefinition,
  taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>,
  mutation: WorkflowPlanMutation,
  actor: WorkflowPlanMutationActor,
): AppliedWorkflowPlanMutation {
  const beforeReady = new Set(readyTaskIds(currentPlan, taskStates));

  if (mutation.operation === "append") {
    if (
      currentPlan.phases.some((phase) =>
        phase.tasks.some((task) => task.id === mutation.task.id),
      )
    ) {
      throw new WorkflowPlanMutationError(
        "duplicate_task_id",
        `Workflow plan task ID "${mutation.task.id}" already exists.`,
      );
    }
    const phaseIndex = currentPlan.phases.findIndex(
      (phase) => phase.id === mutation.phaseId,
    );
    if (phaseIndex < 0) {
      throw new WorkflowPlanMutationError(
        "phase_not_found",
        `Workflow plan phase "${mutation.phaseId}" was not found.`,
      );
    }
    assertFuturePhase(currentPlan, taskStates, phaseIndex);
    const candidate = validateWorkflowPlan({
      ...currentPlan,
      phases: currentPlan.phases.map((phase, index) =>
        index === phaseIndex
          ? { ...phase, tasks: [...phase.tasks, mutation.task] }
          : phase,
      ),
    });
    return withAudit(candidate, actor, "append", [mutation.task.id], [], true);
  }

  if (mutation.operation === "replace_future") {
    if (actor.kind !== "human") {
      throw new WorkflowPlanMutationError(
        "invalid_mutation",
        "Replacing future work is available only to trusted human commands.",
      );
    }
    const edited = validateWorkflowPlan(mutation.plan);
    if (
      edited.name !== currentPlan.name ||
      edited.description !== currentPlan.description ||
      edited.phases.length !== currentPlan.phases.length
    ) {
      throw new WorkflowPlanMutationError(
        "immutable_task",
        "Plan metadata and the phase set are read-only in the future-work editor.",
      );
    }
    for (let index = 0; index < currentPlan.phases.length; index += 1) {
      const currentPhase = currentPlan.phases[index]!;
      const editedPhase = edited.phases[index]!;
      if (
        currentPhase.id !== editedPhase.id ||
        currentPhase.name !== editedPhase.name ||
        currentPhase.mode !== editedPhase.mode
      ) {
        throw new WorkflowPlanMutationError(
          "immutable_task",
          "Phase IDs, names, order, and modes are read-only in the future-work editor.",
        );
      }
    }

    const editedLocations = new Map<
      string,
      { phaseIndex: number; task: WorkflowPlanTaskDefinition }
    >();
    for (
      let phaseIndex = 0;
      phaseIndex < edited.phases.length;
      phaseIndex += 1
    ) {
      for (const task of edited.phases[phaseIndex]!.tasks) {
        editedLocations.set(task.id, { phaseIndex, task });
      }
    }
    const originalIds = new Set<string>();
    const transitions: WorkflowPlanRevisionTransition[] = [];
    const removedByPhase = new Map<
      number,
      Array<{ index: number; task: WorkflowPlanTaskDefinition }>
    >();
    const currentPhaseIndex = currentFuturePhaseIndex(currentPlan, taskStates);

    for (
      let phaseIndex = 0;
      phaseIndex < currentPlan.phases.length;
      phaseIndex += 1
    ) {
      const phase = currentPlan.phases[phaseIndex]!;
      for (let taskIndex = 0; taskIndex < phase.tasks.length; taskIndex += 1) {
        const task = phase.tasks[taskIndex]!;
        originalIds.add(task.id);
        const status = taskStatus(taskStates, task.id);
        const replacement = editedLocations.get(task.id);
        const immutable =
          status === "running" || !["pending", "blocked"].includes(status);
        if (immutable) {
          if (
            replacement === undefined ||
            replacement.phaseIndex !== phaseIndex ||
            !equalTaskDefinition(task, replacement.task)
          ) {
            throw new WorkflowPlanMutationError(
              "immutable_task",
              `Running or completed task "${task.id}" is read-only. Refresh and edit only future work.`,
            );
          }
          continue;
        }
        if (replacement !== undefined) {
          if (replacement.phaseIndex < currentPhaseIndex) {
            throw new WorkflowPlanMutationError(
              "immutable_task",
              `Future task "${task.id}" cannot move into completed history.`,
            );
          }
          continue;
        }
        transitions.push({
          taskId: task.id,
          from: status === "pending" ? "pending" : "blocked",
          to: "skipped",
          reason: "Removed by trusted future-work edit.",
        });
        const removed = removedByPhase.get(phaseIndex) ?? [];
        removed.push({ index: taskIndex, task });
        removedByPhase.set(phaseIndex, removed);
      }
    }

    const appendedTaskIds: string[] = [];
    for (const [taskId, location] of editedLocations) {
      if (originalIds.has(taskId)) continue;
      assertFuturePhase(currentPlan, taskStates, location.phaseIndex);
      appendedTaskIds.push(taskId);
    }
    const phases = edited.phases.map((phase, phaseIndex) => {
      const tasks = [...phase.tasks];
      for (const removed of removedByPhase.get(phaseIndex) ?? []) {
        tasks.splice(Math.min(removed.index, tasks.length), 0, removed.task);
      }
      return { ...phase, tasks };
    });
    const candidate = validateWorkflowPlan({ ...edited, phases });
    if (
      JSON.stringify(candidate) === JSON.stringify(currentPlan) &&
      transitions.length === 0
    ) {
      throw new WorkflowPlanMutationError(
        "no_change",
        "The edited plan contains no future-work changes.",
      );
    }
    const nextStates = { ...taskStates };
    for (const taskId of appendedTaskIds) nextStates[taskId] = "pending";
    for (const transition of transitions)
      nextStates[transition.taskId] = transition.to;
    const wakeEligible = readyTaskIds(candidate, nextStates).some(
      (id) => !beforeReady.has(id),
    );
    return withAudit(
      candidate,
      actor,
      "replace_future",
      appendedTaskIds,
      transitions,
      wakeEligible,
    );
  }

  const location = taskLocation(currentPlan, mutation.taskId);
  assertFuturePhase(currentPlan, taskStates, location.phaseIndex);
  const status = taskStatus(taskStates, mutation.taskId);
  let transition: WorkflowPlanRevisionTransition;
  if (mutation.operation === "block") {
    if (status !== "pending") {
      throw new WorkflowPlanMutationError(
        "immutable_task",
        `Only a pending future task can be blocked; "${mutation.taskId}" is ${status}.`,
      );
    }
    transition = {
      taskId: mutation.taskId,
      from: "pending",
      to: "blocked",
      reason: normalizedReason(mutation.reason, "block"),
    };
  } else if (mutation.operation === "unblock") {
    if (status !== "blocked") {
      throw new WorkflowPlanMutationError(
        "immutable_task",
        `Only a blocked future task can be unblocked; "${mutation.taskId}" is ${status}.`,
      );
    }
    transition = { taskId: mutation.taskId, from: "blocked", to: "pending" };
  } else {
    if (status !== "pending" && status !== "blocked") {
      throw new WorkflowPlanMutationError(
        "immutable_task",
        `Only pending or blocked future work can be skipped; "${mutation.taskId}" is ${status}.`,
      );
    }
    transition = {
      taskId: mutation.taskId,
      from: status === "pending" ? "pending" : "blocked",
      to: "skipped",
      reason: normalizedReason(mutation.reason, "skip"),
    };
  }
  const nextStates = { ...taskStates, [transition.taskId]: transition.to };
  const wakeEligible =
    mutation.operation === "unblock" ||
    readyTaskIds(currentPlan, nextStates).some((id) => !beforeReady.has(id));
  return withAudit(
    currentPlan,
    actor,
    mutation.operation,
    [],
    [transition],
    wakeEligible,
  );
}

export function createWorkflowPlanViewProjection(input: {
  readonly runId: DurableWorkflowRunId;
  readonly owner: DurableWorkflowOwner;
  readonly runEpoch: number;
  readonly revision: number;
  readonly revisionHash: WorkflowSha256Digest;
  readonly definitionHash: WorkflowDefinitionDigest;
  readonly status: DurableWorkflowStatus;
  readonly plan: WorkflowPlanDefinition;
  readonly taskStates: Readonly<Record<string, WorkflowPlanTaskStatus>>;
}): WorkflowPlanViewProjection {
  const counts = {
    pending: 0,
    running: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    completed: 0,
    total: 0,
  };
  const phases = input.plan.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    mode: phase.mode,
    tasks: phase.tasks.map((task) => {
      const status = taskStatus(input.taskStates, task.id);
      counts[status] += 1;
      counts.total += 1;
      if (["succeeded", "failed", "skipped", "cancelled"].includes(status)) {
        counts.completed += 1;
      }
      return {
        id: task.id,
        content: task.content,
        instruction: task.instruction,
        phaseId: phase.id,
        status,
        mutable: status === "pending" || status === "blocked",
      };
    }),
  }));
  const currentPhase = phases.find((phase) =>
    phase.tasks.some(
      (task) =>
        task.status === "pending" ||
        task.status === "running" ||
        task.status === "blocked",
    ),
  );
  const runningTaskIds = phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status === "running")
      .map((task) => task.id),
  );
  const blockedTaskIds = phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status === "blocked")
      .map((task) => task.id),
  );
  return Object.freeze({
    runId: input.runId,
    owner: Object.freeze({ ...input.owner }),
    runEpoch: input.runEpoch,
    revision: input.revision,
    revisionHash: input.revisionHash,
    definitionHash: input.definitionHash,
    definition: input.plan,
    status: input.status,
    ...(currentPhase === undefined ? {} : { currentPhaseId: currentPhase.id }),
    runningTaskIds: Object.freeze(runningTaskIds),
    blockedTaskIds: Object.freeze(blockedTaskIds),
    nextTaskIds: Object.freeze(readyTaskIds(input.plan, input.taskStates)),
    counts: Object.freeze(counts),
    phases: Object.freeze(
      phases.map((phase) =>
        Object.freeze({
          ...phase,
          tasks: Object.freeze(phase.tasks.map((task) => Object.freeze(task))),
        }),
      ),
    ),
  });
}
