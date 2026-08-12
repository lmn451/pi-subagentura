import { describe, expect, it } from "vitest";
import {
  validateWorkflowPlan as validatePublicWorkflowPlan,
  type WorkflowPlanAgentDefinition,
  type WorkflowPlanDefinition,
  type WorkflowPlanMode,
  type WorkflowPlanPhaseDefinition,
  type WorkflowPlanTaskDefinition,
} from "../src/subagent";
import { validateWorkflowPlan } from "../src/workflow-plan";

type PlanInput = {
  name: string;
  description: string;
  phases: Array<{
    id: string;
    name: string;
    mode: string;
    tasks: Array<{
      id: string;
      content: string;
      instruction: string;
      agent?: Record<string, unknown>;
    }>;
  }>;
};

function makePlan(): PlanInput {
  return {
    name: "Plan",
    description: "Description",
    phases: [
      {
        id: "phase-1",
        name: "Phase 1",
        mode: "sequence",
        tasks: [
          {
            id: "task-1",
            content: "Task 1",
            instruction: "Do task 1",
          },
        ],
      },
    ],
  };
}

function makeTask(index: number) {
  return {
    id: `task-${index}`,
    content: `Task ${index}`,
    instruction: `Do task ${index}`,
  };
}

describe("validateWorkflowPlan", () => {
  it("accepts representative sequential and parallel plans and normalizes strings", () => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };
    const input = {
      name: "  Release plan  ",
      description: "  Prepare and publish a release.  ",
      phases: [
        {
          id: "  prepare  ",
          name: "  Prepare  ",
          mode: " sequence ",
          tasks: [
            {
              id: "  inspect  ",
              content: "  Inspect changes  ",
              instruction: "  Review the pending changes.  ",
              agent: {
                schema,
                label: "  reviewer  ",
                phase: "  review  ",
                model: "  test/model  ",
                persona: "  careful reviewer  ",
                isolation: "  process  ",
                agentType: "  reviewer  ",
                thinkingLevel: "  high  ",
              },
            },
          ],
        },
        {
          id: "publish",
          name: "Publish",
          mode: "parallel",
          tasks: [
            {
              id: "tag",
              content: "Create tag",
              instruction: "Create the release tag.",
            },
            {
              id: "announce",
              content: "Write announcement",
              instruction: "Write the release announcement.",
            },
          ],
        },
      ],
    };

    expect(validateWorkflowPlan(input)).toEqual({
      name: "Release plan",
      description: "Prepare and publish a release.",
      phases: [
        {
          id: "prepare",
          name: "Prepare",
          mode: "sequence",
          tasks: [
            {
              id: "inspect",
              content: "Inspect changes",
              instruction: "Review the pending changes.",
              agent: {
                schema,
                label: "reviewer",
                phase: "review",
                model: "test/model",
                persona: "careful reviewer",
                isolation: "process",
                agentType: "reviewer",
                thinkingLevel: "high",
              },
            },
          ],
        },
        {
          id: "publish",
          name: "Publish",
          mode: "parallel",
          tasks: [
            {
              id: "tag",
              content: "Create tag",
              instruction: "Create the release tag.",
            },
            {
              id: "announce",
              content: "Write announcement",
              instruction: "Write the release announcement.",
            },
          ],
        },
      ],
    });
  });

  it("returns owned definition containers without mutating the input", () => {
    const input = makePlan();
    input.name = "  Plan  ";
    input.phases[0].name = "  Phase 1  ";
    input.phases[0].tasks[0].instruction = "  Do task 1  ";
    input.phases[0].tasks[0].agent = { label: "  worker  " };
    const before = JSON.stringify(input);

    const result = validateWorkflowPlan(input);

    expect(JSON.stringify(input)).toBe(before);
    expect(result).not.toBe(input);
    expect(result.phases).not.toBe(input.phases);
    expect(result.phases[0]).not.toBe(input.phases[0]);
    expect(result.phases[0].tasks).not.toBe(input.phases[0].tasks);
    expect(result.phases[0].tasks[0]).not.toBe(input.phases[0].tasks[0]);
    expect(result.phases[0].tasks[0].agent).not.toBe(
      input.phases[0].tasks[0].agent,
    );
    expect(result.name).toBe("Plan");
    expect(result.phases[0].name).toBe("Phase 1");
    expect(result.phases[0].tasks[0].instruction).toBe("Do task 1");
    expect(result.phases[0].tasks[0].agent?.label).toBe("worker");
  });

  it("treats schemas as opaque values without invoking them", () => {
    let invoked = false;
    const schema = () => {
      invoked = true;
    };
    const input = makePlan();
    input.phases[0].tasks[0].agent = { schema };

    const result = validateWorkflowPlan(input);

    expect(invoked).toBe(false);
    expect(result.phases[0].tasks[0].agent?.schema).toBe(schema);
  });

  it("rejects duplicate phase IDs", () => {
    const input = makePlan();
    input.phases.push({
      id: "phase-1",
      name: "Phase 2",
      mode: "parallel",
      tasks: [makeTask(2)],
    });

    expect(() => validateWorkflowPlan(input)).toThrow(/duplicate phase id/);
  });

  it("rejects duplicate task IDs across phases", () => {
    const input = makePlan();
    input.phases.push({
      id: "phase-2",
      name: "Phase 2",
      mode: "parallel",
      tasks: [{ ...makeTask(2), id: "task-1" }],
    });

    expect(() => validateWorkflowPlan(input)).toThrow(/duplicate task id/);
  });

  it.each([
    [
      "plan status",
      (plan: PlanInput) => Object.assign(plan, { status: "running" }),
    ],
    [
      "phase attempt",
      (plan: PlanInput) => Object.assign(plan.phases[0], { attempt: 1 }),
    ],
    [
      "task result",
      (plan: PlanInput) =>
        Object.assign(plan.phases[0].tasks[0], { result: "done" }),
    ],
    [
      "task status",
      (plan: PlanInput) =>
        Object.assign(plan.phases[0].tasks[0], { status: "pending" }),
    ],
    [
      "agent unknown field",
      (plan: PlanInput) => {
        plan.phases[0].tasks[0].agent = { retries: 3 };
      },
    ],
  ])("rejects unknown and runtime-owned fields at %s", (_name, mutate) => {
    const input = makePlan();
    mutate(input);

    expect(() => validateWorkflowPlan(input)).toThrow(/unknown field/);
  });

  it.each([
    ["plan.name", (plan: PlanInput) => (plan.name = " \t ")],
    ["plan.description", (plan: PlanInput) => (plan.description = "\n")],
    ["phase.id", (plan: PlanInput) => (plan.phases[0].id = " ")],
    ["phase.name", (plan: PlanInput) => (plan.phases[0].name = "  ")],
    ["task.id", (plan: PlanInput) => (plan.phases[0].tasks[0].id = "\t")],
    [
      "task.content",
      (plan: PlanInput) => (plan.phases[0].tasks[0].content = " "),
    ],
    [
      "task.instruction",
      (plan: PlanInput) => (plan.phases[0].tasks[0].instruction = "\n\t"),
    ],
  ])("rejects an empty or whitespace-only %s", (_name, mutate) => {
    const input = makePlan();
    mutate(input);

    expect(() => validateWorkflowPlan(input)).toThrow(/non-empty string/);
  });

  it("rejects invalid phase modes", () => {
    const input = makePlan();
    input.phases[0].mode = "serial";

    expect(() => validateWorkflowPlan(input)).toThrow(
      /must be "sequence" or "parallel"/,
    );
  });

  it.each([
    ["name", 256, (plan: PlanInput, value: string) => (plan.name = value)],
    [
      "description",
      4096,
      (plan: PlanInput, value: string) => (plan.description = value),
    ],
    [
      "phase id",
      256,
      (plan: PlanInput, value: string) => (plan.phases[0].id = value),
    ],
    [
      "phase name",
      256,
      (plan: PlanInput, value: string) => (plan.phases[0].name = value),
    ],
    [
      "task id",
      256,
      (plan: PlanInput, value: string) => (plan.phases[0].tasks[0].id = value),
    ],
    [
      "task content",
      256,
      (plan: PlanInput, value: string) =>
        (plan.phases[0].tasks[0].content = value),
    ],
    [
      "task instruction",
      16384,
      (plan: PlanInput, value: string) =>
        (plan.phases[0].tasks[0].instruction = value),
    ],
  ])("enforces the %s length bound", (_name, limit, setValue) => {
    const atLimit = makePlan();
    setValue(atLimit, "x".repeat(limit));
    expect(() => validateWorkflowPlan(atLimit)).not.toThrow();

    const beyondLimit = makePlan();
    setValue(beyondLimit, "x".repeat(limit + 1));
    expect(() => validateWorkflowPlan(beyondLimit)).toThrow(/character limit/);
  });

  it("enforces the 32-phase bound", () => {
    const atLimit = makePlan();
    atLimit.phases = Array.from({ length: 32 }, (_, index) => ({
      id: `phase-${index}`,
      name: `Phase ${index}`,
      mode: index % 2 === 0 ? "sequence" : "parallel",
      tasks: [makeTask(index)],
    }));
    expect(() => validateWorkflowPlan(atLimit)).not.toThrow();

    const beyondLimit = makePlan();
    beyondLimit.phases = Array.from({ length: 33 }, (_, index) => ({
      id: `phase-${index}`,
      name: `Phase ${index}`,
      mode: "sequence",
      tasks: [makeTask(index)],
    }));
    expect(() => validateWorkflowPlan(beyondLimit)).toThrow(/32-phase limit/);
  });

  it("enforces the 256-total-task bound", () => {
    const atLimit = makePlan();
    atLimit.phases[0].tasks = Array.from({ length: 256 }, (_, index) =>
      makeTask(index),
    );
    expect(() => validateWorkflowPlan(atLimit)).not.toThrow();

    const beyondLimit = makePlan();
    beyondLimit.phases[0].tasks = Array.from({ length: 257 }, (_, index) =>
      makeTask(index),
    );
    expect(() => validateWorkflowPlan(beyondLimit)).toThrow(/256-task limit/);
  });

  it.each([
    ["plan phases", (plan: PlanInput) => (plan.phases = [])],
    ["phase tasks", (plan: PlanInput) => (plan.phases[0].tasks = [])],
  ])("rejects empty %s arrays", (_name, mutate) => {
    const input = makePlan();
    mutate(input);

    expect(() => validateWorkflowPlan(input)).toThrow(/at least one/);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a class instance", new Date()],
    ["a numeric label", { label: 1 }],
    ["a boolean phase", { phase: false }],
    ["an object model", { model: {} }],
    ["a null persona", { persona: null }],
    ["a numeric isolation", { isolation: 1 }],
    ["an array agentType", { agentType: [] }],
    ["an unsupported thinking level", { thinkingLevel: "turbo" }],
  ])("rejects malformed agent options containing %s", (_name, agent) => {
    const input = makePlan();
    input.phases[0].tasks[0].agent = agent as unknown as Record<
      string,
      unknown
    >;

    expect(() => validateWorkflowPlan(input)).toThrow();
  });

  it.each(["label", "phase", "model", "persona", "isolation", "agentType"])(
    "rejects a whitespace-only agent.%s",
    (field) => {
      const input = makePlan();
      input.phases[0].tasks[0].agent = { [field]: "  " };

      expect(() => validateWorkflowPlan(input)).toThrow(/non-empty string/);
    },
  );

  it.each([
    [
      "plan description",
      (plan: PlanInput) => delete (plan as Partial<PlanInput>).description,
    ],
    [
      "phase mode",
      (plan: PlanInput) =>
        delete (plan.phases[0] as Partial<PlanInput["phases"][number]>).mode,
    ],
    [
      "task instruction",
      (plan: PlanInput) =>
        delete (
          plan.phases[0].tasks[0] as Partial<
            PlanInput["phases"][number]["tasks"][number]
          >
        ).instruction,
    ],
  ])("rejects a missing required %s", (_name, mutate) => {
    const input = makePlan();
    mutate(input);

    expect(() => validateWorkflowPlan(input)).toThrow(/required/);
  });
});

describe("public workflow plan exports", () => {
  it("exports the validator and declarative types from the package barrel", () => {
    const mode: WorkflowPlanMode = "sequence";
    const agent: WorkflowPlanAgentDefinition = { label: "worker" };
    const task: WorkflowPlanTaskDefinition = {
      id: "task",
      content: "Task",
      instruction: "Do the task",
      agent,
    };
    const phase: WorkflowPlanPhaseDefinition = {
      id: "phase",
      name: "Phase",
      mode,
      tasks: [task],
    };
    const definition: WorkflowPlanDefinition = {
      name: "Plan",
      description: "Description",
      phases: [phase],
    };

    expect(validatePublicWorkflowPlan(definition)).toEqual(definition);
    expect(validatePublicWorkflowPlan).toBe(validateWorkflowPlan);
  });
});
