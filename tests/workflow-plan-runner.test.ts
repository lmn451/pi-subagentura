import { describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runWorkflowPlan } from "../src/workflow-plan-runner";
import {
  WorkflowExecutionError,
  type WorkflowAgentRunner,
} from "../src/workflow-core";
import type { WorkflowPlanState } from "../src/workflow-plan-state";
import type { WorkflowPlan } from "../src/workflow-plan";

const usageA: SubagentResult["usage"] = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  cost: 0.25,
  turns: 1,
};
const usageB: SubagentResult["usage"] = {
  input: 5,
  output: 6,
  cacheRead: 7,
  cacheWrite: 8,
  cost: 0.5,
  turns: 2,
};
const success = (
  output: string,
  usage: SubagentResult["usage"],
): SubagentResult => ({
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

type PublishedState = Pick<
  WorkflowPlanState,
  "status" | "currentPhase" | "tasks" | "revision"
>;

describe("workflow plan runner", () => {
  it("runs in phase order, publishes every state, and aggregates canonical usage", async () => {
    const calls: string[] = [];
    const states: PublishedState[] = [];
    const result = await runWorkflowPlan(plan, {
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`, prompt === "A" ? usageA : usageB);
      },
      onState: (state) =>
        states.push({
          status: state.status,
          currentPhase: state.currentPhase,
          tasks: { ...state.tasks },
          revision: state.revision,
        }),
    });

    expect(calls).toEqual(["A", "B"]);
    expect(result.taskResults.map((task) => task.taskId)).toEqual(["a", "b"]);
    expect(result.phases).toEqual(["first", "second"]);
    expect(result.agentsSpawned).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.usage).toEqual({
      input: 6,
      output: 8,
      cacheRead: 10,
      cacheWrite: 12,
      totalTokens: 36,
      costUsd: 0.75,
      turns: 3,
      costSource: "estimated",
    });
    expect(result.tokensSpent).toBe(result.usage.output);
    expect(states).toEqual([
      {
        status: "created",
        currentPhase: undefined,
        tasks: { a: "pending", b: "pending" },
        revision: 0,
      },
      {
        status: "running",
        currentPhase: "first",
        tasks: { a: "running", b: "pending" },
        revision: 1,
      },
      {
        status: "running",
        currentPhase: "first",
        tasks: { a: "succeeded", b: "pending" },
        revision: 2,
      },
      {
        status: "running",
        currentPhase: "second",
        tasks: { a: "succeeded", b: "running" },
        revision: 3,
      },
      {
        status: "done",
        currentPhase: "second",
        tasks: { a: "succeeded", b: "succeeded" },
        revision: 4,
      },
    ]);
  });

  it("settles the failing task and never dispatches a successor", async () => {
    const calls: string[] = [];
    const states: PublishedState[] = [];
    await expect(
      runWorkflowPlan(plan, {
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "A") {
            return {
              isError: true,
              output: "",
              usage: usageA,
              errorMessage: "failed",
            };
          }
          return success("unexpected", usageB);
        },
        onState: (state) =>
          states.push({
            status: state.status,
            currentPhase: state.currentPhase,
            tasks: { ...state.tasks },
            revision: state.revision,
          }),
      }),
    ).rejects.toThrow("failed");

    expect(calls).toEqual(["A"]);
    expect(states.at(-1)).toEqual({
      status: "error",
      currentPhase: "first",
      tasks: { a: "failed", b: "cancelled" },
      revision: 2,
    });
  });

  it("rejects 1001 tasks before dispatch", async () => {
    const runAgent = vi.fn<WorkflowAgentRunner>();
    const oversized = {
      schemaVersion: 1,
      name: "oversized",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: Array.from({ length: 1001 }, (_, index) => ({
            id: `task-${index}`,
            prompt: "work",
          })),
        },
      ],
    } as unknown as WorkflowPlan;

    await expect(runWorkflowPlan(oversized, { runAgent })).rejects.toThrow(
      /1000 tasks/,
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("projects running and pending tasks as cancelled on in-flight abort", async () => {
    const abort = new AbortController();
    const reason = new Error("stop plan");
    const started = Promise.withResolvers<void>();
    const states: WorkflowPlanState[] = [];
    const execution = runWorkflowPlan(plan, {
      signal: abort.signal,
      runAgent: ({ signal }) => {
        const pending = Promise.withResolvers<SubagentResult>();
        started.resolve();
        signal?.addEventListener("abort", () => pending.reject(signal.reason), {
          once: true,
        });
        return pending.promise;
      },
      onState: (state) => states.push(state),
    });
    const rejection = expect(execution).rejects.toBe(reason);

    await started.promise;
    abort.abort(reason);
    await rejection;
    expect(states.at(-1)).toMatchObject({
      status: "cancelled",
      tasks: { a: "cancelled", b: "cancelled" },
    });
  });

  it("throws aggregate successful and failing result usage with the original cause", async () => {
    const execution = runWorkflowPlan(plan, {
      runAgent: async ({ prompt }) =>
        prompt === "A"
          ? success("done", usageA)
          : {
              isError: true,
              output: "",
              usage: usageB,
              errorMessage: "task failed",
            },
    });

    await expect(execution).rejects.toEqual(
      expect.objectContaining({
        name: "WorkflowExecutionError",
        usage: {
          input: 6,
          output: 8,
          cacheRead: 10,
          cacheWrite: 12,
          totalTokens: 36,
          costUsd: 0.75,
          turns: 3,
          costSource: "estimated",
        },
        cause: expect.objectContaining({ message: "task failed" }),
      }),
    );
    await execution.catch((error) => {
      expect(error).toBeInstanceOf(WorkflowExecutionError);
    });
  });

  it("lets a task-aware authority replay without entering the dispatcher", async () => {
    const definition = plan([
      {
        id: "durable",
        name: "Durable",
        mode: "sequence",
        tasks: [
          { id: "a", content: "Alpha", instruction: "instruction-a" },
          { id: "b", content: "Beta", instruction: "instruction-b" },
        ],
      },
    ]);
    const authority: string[] = [];
    const runners: string[] = [];

    const result = await runWorkflowPlan(definition, {
      runAgent: async ({ prompt }) => {
        runners.push(prompt);
        return ok(`fresh:${prompt}`, { input: 2, output: 1 });
      },
      dispatchTask: async ({ task, request, dispatch }) => {
        authority.push(`${task.definition.id}:${request.prompt}`);
        return task.definition.id === "a"
          ? ok("replayed:a", { input: 5, output: 3 })
          : dispatch();
      },
    });

    expect(authority).toEqual(["a:instruction-a", "b:instruction-b"]);
    expect(runners).toEqual(["instruction-b"]);
    expect(result.result.map((task) => task.output)).toEqual([
      "replayed:a",
      "fresh:instruction-b",
    ]);
    expect(result.agentsSpawned).toBe(1);
    expect(result.usage).toMatchObject({
      input: 7,
      output: 4,
      totalTokens: 11,
    });
  });
});
