import { afterEach, describe, expect, it, vi } from "vitest";

const { mockRunWorkflow } = vi.hoisted(() => ({
  mockRunWorkflow: vi.fn(),
}));

vi.mock("../src/workflow-worker", () => ({
  runWorkflow: mockRunWorkflow,
}));

import {
  WorkflowExecutionError,
  type WorkflowUsage,
} from "../src/workflow-core";
import {
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";

describe("async workflow rejection accounting", () => {
  afterEach(() => {
    workflowJobRegistry.clear();
    vi.clearAllMocks();
  });

  it("publishes cancelled WorkflowExecutionError usage before completion consumers run", async () => {
    const usage: WorkflowUsage = {
      input: 13,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 25,
      costUsd: 0.04,
      turns: 2,
      costSource: "estimated",
    };
    const failure = new WorkflowExecutionError("priced failure", usage);
    let rejectWorkflow!: (reason?: unknown) => void;
    mockRunWorkflow.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectWorkflow = reject;
        }),
    );
    let observedAtCompletion:
      | {
          status: WorkflowJobState["status"];
          usage: WorkflowUsage | undefined;
          tokensSpent: number;
        }
      | undefined;

    const job = startWorkflowJob(
      "priced-failure",
      `export const meta = { name: "priced-failure", description: "d" };\nthrow new Error("boom");`,
      {
        runAgent: async () => {
          throw new Error("mocked runWorkflow should own execution");
        },
      },
      undefined,
      (completed: WorkflowJobState) => {
        observedAtCompletion = {
          status: completed.status,
          usage: completed.snapshot.usage
            ? { ...completed.snapshot.usage }
            : undefined,
          tokensSpent: completed.snapshot.tokensSpent,
        };
        return true;
      },
    );

    job.abort.abort(new Error("cancelled by test"));
    rejectWorkflow(failure);
    await expect(job.promise).rejects.toBe(failure);
    expect(observedAtCompletion).toEqual({
      status: "cancelled",
      usage,
      tokensSpent: usage.output,
    });
    expect(job.status).toBe("cancelled");
    expect(job.snapshot.usage).toEqual(usage);
    expect(job.snapshot.tokensSpent).toBe(usage.output);
  });

  it("classifies nested worker cancellation as cancelled without error telemetry", async () => {
    const failure = Object.assign(
      new WorkflowExecutionError("nested workflow was cancelled"),
      { cancelled: true, cancelledCount: 2 },
    );
    mockRunWorkflow.mockRejectedValueOnce(failure);
    const job = startWorkflowJob(
      "nested-cancel",
      `export const meta = { name: "nested-cancel", description: "d" };\nreturn "unused";`,
      {
        runAgent: async () => {
          throw new Error("mocked runWorkflow should own execution");
        },
      },
    );
    await expect(job.promise).rejects.toBe(failure);
    expect(job.status).toBe("cancelled");
    expect(job.snapshot).toMatchObject({
      errorCount: 0,
      cancelledCount: 2,
    });
    expect(job.telemetryFailure).toBeUndefined();
  });
});
