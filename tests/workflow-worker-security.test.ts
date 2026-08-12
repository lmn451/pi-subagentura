import { describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  WORKFLOW_CLONE_LIMITS,
  WorkflowExecutionError,
  type WorkflowDurableScriptAdapter,
} from "../src/workflow-core";
import { WorkflowOperationGateError } from "../src/workflow-operation-gate";
import { runWorkflow } from "../src/workflow-worker";

const META =
  'export const meta = { name: "worker-security", description: "test" };\n';

function success(output: string): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function divergingAdapter(
  failure: WorkflowOperationGateError,
): WorkflowDurableScriptAdapter {
  return {
    rootDefinitionPath: "root",
    async runAgent() {
      throw failure;
    },
    async loadWorkflow() {
      throw failure;
    },
    async completeWorkflow() {
      throw failure;
    },
  };
}

describe("workflow worker security boundaries", () => {
  it.each([
    [
      "parallel",
      'return await parallel([() => agent("task", { id: "task" })]);',
    ],
    [
      "pipeline",
      'return await pipeline([1], async () => agent("task", { id: "task" }));',
    ],
  ])(
    "keeps durable replay divergence fatal through %s()",
    async (_name, body) => {
      const failure = new WorkflowOperationGateError(
        "replay_diverged",
        "replay_diverged: hostile replay changed the request",
      );
      const runAgent = vi.fn(async () => success("must not run"));

      try {
        await runWorkflow(META + body, {
          runAgent,
          durableScript: divergingAdapter(failure),
        });
        throw new Error("Expected durable replay divergence to reject.");
      } catch (error) {
        if (!(error instanceof WorkflowExecutionError)) throw error;
        expect(error.cause).toBe(failure);
        expect(runAgent).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects oversized script and args before starting agent work", async () => {
    const runAgent = vi.fn(async () => success("must not run"));
    const oversized = "x".repeat(WORKFLOW_CLONE_LIMITS.maxStringBytes + 1);

    await expect(runWorkflow(oversized, { runAgent })).rejects.toThrow(
      /quota max(?:Value)?StringBytes/i,
    );
    await expect(
      runWorkflow(META + "return args;", { args: oversized, runAgent }),
    ).rejects.toThrow(/quota max(?:Value)?StringBytes/i);
    const chunk = "x".repeat(
      Math.floor(WORKFLOW_CLONE_LIMITS.maxStringBytes / 2),
    );
    const aggregate = Array.from(
      {
        length: Math.ceil(WORKFLOW_CLONE_LIMITS.maxBytes / chunk.length) + 1,
      },
      () => chunk,
    );
    await expect(
      runWorkflow(META + "return args;", { args: aggregate, runAgent }),
    ).rejects.toThrow(/quota maxValueBytes/i);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects oversized worker RPC requests instead of mapping them to null", async () => {
    const runAgent = vi.fn(async () => success("must not run"));
    const body = `
      const prompt = "x".repeat(${WORKFLOW_CLONE_LIMITS.maxStringBytes + 1});
      return await parallel([() => agent(prompt)]);
    `;

    await expect(runWorkflow(META + body, { runAgent })).rejects.toThrow(
      /quota max(?:Value)?StringBytes/i,
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects oversized parent RPC responses instead of mapping them to null", async () => {
    const oversized = "x".repeat(WORKFLOW_CLONE_LIMITS.maxStringBytes + 1);

    await expect(
      runWorkflow(META + 'return await parallel([() => agent("task")]);', {
        runAgent: async () => success(oversized),
      }),
    ).rejects.toThrow(/quota max(?:Value)?StringBytes/i);
  });

  it("rejects oversized results and progress before worker transfer", async () => {
    const size = WORKFLOW_CLONE_LIMITS.maxStringBytes + 1;
    const runAgent = vi.fn(async () => success("must not run"));

    await expect(
      runWorkflow(META + `return "x".repeat(${size});`, { runAgent }),
    ).rejects.toThrow(/quota max(?:Value)?StringBytes/i);
    await expect(
      runWorkflow(META + `log("x".repeat(${size})); return null;`, {
        runAgent,
      }),
    ).rejects.toThrow(/quota max(?:Value)?StringBytes/i);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
