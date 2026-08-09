import { describe, expect, it, vi } from "vitest";
import { buildEagerWorkflowPlan } from "../src/workflow-tool";
import type { WorkflowAgentRunner } from "../src/workflow-core";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 1,
};

const validPlan = {
  schemaVersion: 1 as const,
  name: "routed-plan",
  phases: [
    {
      id: "phase-a",
      mode: "sequential" as const,
      tasks: [
        {
          id: "task-a",
          prompt: "Perform the first independent slice.",
          isolation: "in-process" as const,
        },
      ],
    },
  ],
};

function captured(value: unknown) {
  return {
    isError: false as const,
    output: "",
    usage,
    workflowStructuredOutput: { called: true, value },
  };
}

describe("eager workflow planner", () => {
  it("allows one correction and validates before returning", async () => {
    const prompts: string[] = [];
    const planner: WorkflowAgentRunner = vi.fn(async (request) => {
      prompts.push(request.prompt);
      return prompts.length === 1
        ? captured({
            ...validPlan,
            phases: [{ ...validPlan.phases[0], mode: "parallel" }],
          })
        : captured(validPlan);
    });

    await expect(
      buildEagerWorkflowPlan(planner, "Implement two independent slices"),
    ).resolves.toEqual(validPlan);
    expect(planner).toHaveBeenCalledTimes(2);
    expect(prompts[0]).toContain("only in-process tasks");
    expect(prompts[1]).toContain('plan.phases[0].mode must be "sequential"');
    expect((planner as any).mock.calls[0][0].isolation).toBe("in-process");
    expect((planner as any).mock.calls[0][0].structuredOutputOnly).toBe(true);
  });

  it("fails exactly after a missing structured output and one correction", async () => {
    const planner: WorkflowAgentRunner = vi.fn(async () => ({
      isError: false as const,
      output: "plain text",
      usage,
      workflowStructuredOutput: { called: false, value: undefined },
    }));

    await expect(
      buildEagerWorkflowPlan(planner, "Refactor the repository"),
    ).rejects.toThrow(
      "workflow planner failed after one correction attempt: workflow planner did not call structured_output",
    );
    expect(planner).toHaveBeenCalledTimes(2);
  });

  it("rejects process isolation after the bounded correction", async () => {
    const processPlan = {
      ...validPlan,
      phases: [
        {
          ...validPlan.phases[0],
          tasks: [
            {
              ...validPlan.phases[0].tasks[0],
              isolation: "process",
            },
          ],
        },
      ],
    };
    const planner: WorkflowAgentRunner = vi.fn(async () =>
      captured(processPlan),
    );

    await expect(
      buildEagerWorkflowPlan(planner, "Implement process work"),
    ).rejects.toThrow(
      'plan.phases[0].tasks[0].isolation must be omitted or "in-process"',
    );
    expect(planner).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized tasks before planner dispatch", async () => {
    const planner: WorkflowAgentRunner = vi.fn(async () => captured(validPlan));

    await expect(
      buildEagerWorkflowPlan(planner, "x".repeat(262_145)),
    ).rejects.toThrow("workflow planner task exceeds 262144 bytes");
    expect(planner).not.toHaveBeenCalled();
  });
});
