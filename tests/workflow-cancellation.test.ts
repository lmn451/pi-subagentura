import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { registerWorkflowTool } from "../src/workflow-tool";
import { cancelAllFlows } from "../src/cancel-all-flows";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const SCRIPT =
  'export const meta = { name: "cancel-race", description: "d" };\n' +
  'return await agent("in flight");';

let jobs: WorkflowJobState[] = [];

afterEach(async () => {
  for (const job of jobs) {
    if (job.status === "running") job.abort.abort();
    try {
      await job.promise;
    } catch {
      /* expected for cancelled jobs */
    }
    workflowJobRegistry.delete(job.id);
  }
  jobs = [];
});

async function startInFlightWorkflow(): Promise<WorkflowJobState> {
  let entered!: () => void;
  const agentEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const job = startWorkflowJob("cancel-race", SCRIPT, {
    runAgent: async ({ signal }) => {
      entered();
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new Error("aborted"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
      return {
        isError: false,
        output: "ok",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        model: "test/model",
      } as any;
    },
  });
  jobs.push(job);
  await agentEntered;
  await tick();
  expect(job.snapshot.runningCount).toBe(1);
  expect(job.snapshot.agentRecords?.[0]?.status).toBe("running");
  return job;
}

function workflowTools(): Record<string, any> {
  const tools: Record<string, any> = {};
  registerWorkflowTool({
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    registerCommand: () => {},
  } as any);
  return tools;
}

describe("cancelled workflow snapshot normalization", () => {
  it.each([false, true])(
    "does not accept or retry an independently cancelled child (schema=%s)",
    async (withSchema) => {
      const runAgent = vi.fn(async (): Promise<SubagentResult> => ({
        isError: false,
        cancelled: true,
        output: "Sub-agent cancelled before completion.",
        usage: {
          input: 4,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        model: "test/model",
      }));
      const job = startWorkflowJob(
        "cancel-child",
        'export const meta = { name: "cancel-child", description: "d" };\n' +
          `return await agent("task", { isolation: "in-process"${withSchema ? ', schema: { type: "object" }' : ""} });`,
        { runAgent },
      );
      jobs.push(job);

      const result = await job.promise;

      expect(runAgent).toHaveBeenCalledOnce();
      expect(job.abort.signal.aborted).toBe(false);
      expect(result).toMatchObject({
        result: null,
        agentsSpawned: 1,
        errorCount: 1,
      });
      expect(result.usage).toMatchObject({ input: 4, output: 2, turns: 1 });
      expect(job.snapshot.agentRecords?.[0]?.status).toBe("error");
    },
  );

  it("normalizes cancel_workflow immediately and after settlement", async () => {
    const job = await startInFlightWorkflow();
    const tools = workflowTools();
    const cancel = tools.cancel_workflow;
    const getStatus = tools.get_workflow_status;

    const immediate = await cancel.execute("cancel", { workflowId: job.id });
    expect(immediate.details.status).toBe("cancelled");
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    const immediateStatus = await getStatus.execute("status", {
      workflowId: job.id,
    });
    expect(immediateStatus.details.runningCount).toBe(0);

    await expect(job.promise).rejects.toThrow(/aborted/i);
    const afterSettlement = await cancel.execute("cancel", {
      workflowId: job.id,
    });
    expect(afterSettlement.details.status).toBe("cancelled");
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    const afterSettlementStatus = await getStatus.execute("status", {
      workflowId: job.id,
    });
    expect(afterSettlementStatus.details.runningCount).toBe(0);
  });

  it("normalizes cancelAllFlows immediately and after settlement", async () => {
    const job = await startInFlightWorkflow();
    const getStatus = workflowTools().get_workflow_status;

    const immediate = await cancelAllFlows();
    expect(immediate.workflowsAborted).toBe(1);
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    const immediateStatus = await getStatus.execute("status", {
      workflowId: job.id,
    });
    expect(immediateStatus.details.runningCount).toBe(0);

    await expect(job.promise).rejects.toThrow(/aborted/i);
    const afterSettlement = await cancelAllFlows();
    expect(afterSettlement.workflowsAborted).toBe(0);
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    const afterSettlementStatus = await getStatus.execute("status", {
      workflowId: job.id,
    });
    expect(afterSettlementStatus.details.runningCount).toBe(0);
  });

  it("clears live usage when cancellation makes the workflow terminal", async () => {
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    const job = startWorkflowJob("cancel-live-usage", SCRIPT, {
      runAgent: async ({ signal, onProgress }) => {
        onProgress?.({
          kind: "log",
          message: "usage",
          liveUsage: {
            input: 4,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 6,
            costUsd: 0,
            turns: 1,
            costSource: "provider",
          },
        });
        entered();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          isError: true,
          output: "",
          usage: {
            input: 4,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: undefined,
          errorMessage: "aborted",
        } as any;
      },
    });
    jobs.push(job);
    await enteredPromise;
    expect(job.snapshot.liveUsage).toBeDefined();
    const cancel = workflowTools().cancel_workflow;
    await cancel.execute("cancel", { workflowId: job.id });
    expect(job.snapshot.liveUsage).toBeUndefined();
    await expect(job.promise).rejects.toMatchObject({
      message: expect.stringMatching(/aborted/i),
      usage: {
        input: 4,
        output: 2,
        totalTokens: 6,
        costUsd: 0,
        turns: 1,
      },
    });
    expect(job.snapshot.liveUsage).toBeUndefined();
  });

  it("clears live usage when the active agent finishes", async () => {
    const job = startWorkflowJob("finish-live-usage", SCRIPT, {
      runAgent: async ({ onProgress }) => {
        onProgress?.({
          kind: "log",
          message: "usage",
          liveUsage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            costUsd: 0.01,
            turns: 1,
            costSource: "provider",
          },
        });
        return {
          isError: false,
          output: "ok",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0.01,
            turns: 1,
          },
          model: "test/model",
        } as any;
      },
    });
    jobs.push(job);
    await job.promise;
    expect(job.snapshot.liveUsage).toBeUndefined();
  });
});
