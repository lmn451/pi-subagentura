import { describe, expect, it } from "vitest";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "../src/workflow-plan";
import {
  applyWorkflowPlanMutation,
  createWorkflowPlanViewProjection,
  WorkflowPlanMutationError,
} from "../src/workflow-plan-mutations";
import {
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type WorkflowPlanTaskStatus,
} from "../src/workflow-run-types";

const owner: DurableWorkflowOwner = {
  projectKey: "a".repeat(64),
  piSessionKey: "session-a",
};
const actor = { kind: "model" as const, id: "workflow-plan-tool" };

function plan(): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "evolution",
    description: "future work",
    phases: [
      {
        id: "phase-a",
        name: "Phase A",
        mode: "sequence",
        tasks: [
          { id: "task-a", content: "Task A", instruction: "run a" },
          { id: "task-b", content: "Task B", instruction: "run b" },
        ],
      },
      {
        id: "phase-b",
        name: "Phase B",
        mode: "parallel",
        tasks: [{ id: "task-c", content: "Task C", instruction: "run c" }],
      },
    ],
  });
}

describe("workflow plan future-work mutations", () => {
  it("appends one stable task and emits one wake-bearing audit", () => {
    const result = applyWorkflowPlanMutation(
      plan(),
      { "task-a": "running" },
      {
        operation: "append",
        phaseId: "phase-b",
        task: { id: "task-d", content: "Task D", instruction: "run d" },
      },
      actor,
    );

    expect(result.plan.phases[1]?.tasks.map((task) => task.id)).toEqual([
      "task-c",
      "task-d",
    ]);
    expect(result.audit).toMatchObject({
      operation: "append",
      actorKind: "model",
      appendedTaskIds: ["task-d"],
      transitions: [],
    });
    expect(result.wakeEligible).toBe(true);
  });

  it("blocks, unblocks, and audits skip without exposing settlement transitions", () => {
    const blocked = applyWorkflowPlanMutation(
      plan(),
      {},
      { operation: "block", taskId: "task-a", reason: "waiting on input" },
      actor,
    );
    expect(blocked.audit.transitions).toEqual([
      {
        taskId: "task-a",
        from: "pending",
        to: "blocked",
        reason: "waiting on input",
      },
    ]);
    expect(blocked.wakeEligible).toBe(false);

    const unblocked = applyWorkflowPlanMutation(
      blocked.plan,
      { "task-a": "blocked" },
      { operation: "unblock", taskId: "task-a" },
      actor,
    );
    expect(unblocked.audit.transitions).toEqual([
      { taskId: "task-a", from: "blocked", to: "pending" },
    ]);
    expect(unblocked.wakeEligible).toBe(true);

    const skipped = applyWorkflowPlanMutation(
      plan(),
      { "task-a": "succeeded", "task-b": "blocked" },
      { operation: "skip", taskId: "task-b", reason: "removed from scope" },
      actor,
    );
    expect(skipped.audit.transitions).toEqual([
      {
        taskId: "task-b",
        from: "blocked",
        to: "skipped",
        reason: "removed from scope",
      },
    ]);
    expect(skipped.plan.phases[0]?.tasks[1]?.id).toBe("task-b");
  });

  it.each(["running", "succeeded", "failed", "skipped", "cancelled"] as const)(
    "keeps a %s task immutable",
    (status) => {
      expect(() =>
        applyWorkflowPlanMutation(
          plan(),
          { "task-a": status },
          { operation: "skip", taskId: "task-a", reason: "not allowed" },
          actor,
        ),
      ).toThrow(WorkflowPlanMutationError);
    },
  );

  it("allows trusted future edits while preserving completed history and auditing removals", () => {
    const current = plan();
    const edited = validateWorkflowPlan({
      ...current,
      phases: current.phases.map((phase) =>
        phase.id === "phase-a"
          ? {
              ...phase,
              tasks: [
                phase.tasks[0],
                { id: "task-new", content: "New", instruction: "run new" },
              ],
            }
          : phase,
      ),
    });
    const result = applyWorkflowPlanMutation(
      current,
      { "task-a": "succeeded", "task-b": "pending" },
      { operation: "replace_future", plan: edited },
      { kind: "human", id: "workflow-plan-command" },
    );

    expect(
      result.plan.phases[0]?.tasks.find((task) => task.id === "task-a"),
    ).toEqual(current.phases[0]?.tasks[0]);
    expect(
      result.plan.phases[0]?.tasks.some((task) => task.id === "task-b"),
    ).toBe(true);
    expect(result.audit.appendedTaskIds).toEqual(["task-new"]);
    expect(result.audit.transitions).toEqual([
      {
        taskId: "task-b",
        from: "pending",
        to: "skipped",
        reason: "Removed by trusted future-work edit.",
      },
    ]);
    expect(() =>
      applyWorkflowPlanMutation(
        current,
        {},
        { operation: "replace_future", plan: edited },
        actor,
      ),
    ).toThrow(/trusted human/);
  });

  it("builds a bounded view with statuses and no result, output, attempt, or usage fields", () => {
    const taskStates: Record<string, WorkflowPlanTaskStatus> = {
      "task-a": "succeeded",
      "task-b": "blocked",
    };
    const view = createWorkflowPlanViewProjection({
      runId: createDurableWorkflowRunId("mutation-view"),
      owner,
      runEpoch: 4,
      revision: 7,
      revisionHash: createWorkflowSha256Digest("b".repeat(64)),
      definitionHash: createWorkflowDefinitionDigest("c".repeat(64)),
      status: "blocked",
      plan: plan(),
      taskStates,
    });
    const serialized = JSON.stringify(view);

    expect(view.currentPhaseId).toBe("phase-a");
    expect(view.counts).toMatchObject({ completed: 1, blocked: 1, total: 3 });
    expect(serialized).not.toMatch(/"(result|output|attempt|usage)"/);
  });
});
