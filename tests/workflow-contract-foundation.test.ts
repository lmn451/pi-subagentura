import { describe, expect, it } from "vitest";
import {
  decodeDurableValue,
  encodeDurableValue,
} from "../src/workflow-durable-value";
import {
  createWorkflowPlanState,
  reduceWorkflowPlanState,
} from "../src/workflow-plan-state";
import { validateWorkflowPlan, type WorkflowPlan } from "../src/workflow-plan";

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "review",
  phases: [
    {
      id: "phase-a",
      mode: "sequential",
      tasks: [{ id: "task-a", prompt: "inspect" }],
    },
    {
      id: "phase-b",
      mode: "sequential",
      tasks: [{ id: "task-b", prompt: "report" }],
    },
  ],
};

describe("workflow contract foundation", () => {
  it("validates globally unique sequential task ids", () => {
    expect(() => validateWorkflowPlan(plan)).not.toThrow();
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          plan.phases[0],
          {
            ...plan.phases[1],
            tasks: [{ id: "task-a", prompt: "bad" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects unsupported process isolation and malformed approval gates", () => {
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          {
            ...plan.phases[0],
            tasks: [
              { id: "process-task", prompt: "run", isolation: "process" },
            ],
          },
        ],
      }),
    ).toThrow("Process isolation is not supported");
    expect(() =>
      validateWorkflowPlan({
        ...plan,
        phases: [
          {
            ...plan.phases[0],
            tasks: [
              {
                id: "approval-task",
                prompt: "approve",
                approval: {
                  policyHash: "",
                  denial: "pause" as unknown as "stop",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow("Invalid approval gate");
  });

  it("keeps terminal task state immutable", () => {
    let state = createWorkflowPlanState(plan);
    state = reduceWorkflowPlanState(state, {
      type: "start",
      taskId: "task-a",
      phaseId: "phase-a",
    });
    state = reduceWorkflowPlanState(state, {
      type: "succeed",
      taskId: "task-a",
    });
    expect(() =>
      reduceWorkflowPlanState(state, {
        type: "start",
        taskId: "task-a",
        phaseId: "phase-a",
      }),
    ).toThrow();
  });

  it("round-trips bounded durable values and rejects unsafe numbers", () => {
    expect(
      decodeDurableValue(
        encodeDurableValue({ answer: 42, nested: [true, null] }),
      ),
    ).toEqual({ answer: 42, nested: [true, null] });
    expect(() => encodeDurableValue({ answer: 1.5 })).toThrow();
  });
});
