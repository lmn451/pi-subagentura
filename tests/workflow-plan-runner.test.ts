import { describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runWorkflowPlan } from "../src/workflow-plan-runner";
import type { WorkflowPlan } from "../src/workflow-plan";

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 1,
};
const success = (output: string): SubagentResult => ({
  isError: false,
  output,
  usage,
});

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "preview",
  phases: [
    { id: "first", mode: "sequential", tasks: [{ id: "a", prompt: "A" }] },
    { id: "second", mode: "sequential", tasks: [{ id: "b", prompt: "B" }] },
  ],
};

describe("workflow plan runner", () => {
  it("runs tasks in phase order and publishes terminal state", async () => {
    const calls: string[] = [];
    const states: string[] = [];
    const result = await runWorkflowPlan(plan, {
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
      onState: (state) => states.push(state.status),
    });

    expect(calls).toEqual(["A", "B"]);
    expect(result.taskResults.map((task) => task.taskId)).toEqual(["a", "b"]);
    expect(result.tokensSpent).toBe(4);
    expect(states.at(-1)).toBe("done");
  });

  it("stops before later tasks after coordinator-owned failure", async () => {
    const calls: string[] = [];
    await expect(
      runWorkflowPlan(plan, {
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "A") {
            return { isError: true, output: "", usage, errorMessage: "failed" };
          }
          return success("unexpected");
        },
      }),
    ).rejects.toThrow("failed");
    expect(calls).toEqual(["A"]);
  });

  it("runs parallel phases with the configured concurrency cap", async () => {
    const running: string[] = [];
    let peak = 0;
    const parallelPlan: WorkflowPlan = {
      ...plan,
      phases: [
        {
          id: "parallel",
          mode: "parallel",
          tasks: [
            { id: "a", prompt: "A" },
            { id: "b", prompt: "B" },
            { id: "c", prompt: "C" },
          ],
        },
      ],
    };
    const result = await runWorkflowPlan(parallelPlan, {
      concurrency: 2,
      runAgent: async ({ prompt }) => {
        running.push(prompt);
        peak = Math.max(peak, running.length);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running.splice(running.indexOf(prompt), 1);
        return success(`done:${prompt}`);
      },
    });

    expect(peak).toBe(2);
    expect(result.taskResults.map((task) => task.taskId).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
