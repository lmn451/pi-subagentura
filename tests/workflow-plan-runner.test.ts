import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveExecutionPreview,
  beginNextExecutionOperation,
  clearExecutionBindingsForTests,
  commitExecutionOperation,
  createExecutionPreview,
  getExecutionRecord,
  interruptExecutionsForOwner,
  resumeExecutionRecord,
  startExecutionRecord,
} from "../src/workflow-run-store";
import { runDurableExecution } from "../src/workflow-plan-runner";
import type { RalplanRunRecord } from "../src/ralplan-state";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "workflow-plan-runner-"));
  roots.push(value);
  return value;
}

function plan(cwd: string): RalplanRunRecord {
  return {
    runId: "rp_bbbbbbbbbbbbbbbbbbbb",
    workflowId: "wf_plan",
    workflowName: "ralplan-occ",
    cwd,
    owner: { id: 1, generation: 1 },
    parentSessionId: "session-a",
    phase: "approved_handoff",
    approvalStatus: "approved",
    active: false,
    artifactPaths: {
      plan: join(cwd, "plans", "plan.md"),
      drafts: [],
      architectReviews: [],
      criticReviews: [],
    },
    planDigest: "plan-digest",
    createdAt: 1,
    updatedAt: 2,
  };
}

function createApproved(cwd: string) {
  const preview = createExecutionPreview({
    cwd,
    ralplan: plan(cwd),
    owner: { id: 1, generation: 1 },
    parentSessionId: "session-a",
    planDigest: "plan-digest",
    tasks: [
      {
        id: "task-a",
        phase: "implementation",
        title: "Task A",
        prompt: "Perform task A",
        dependsOn: [],
      },
      {
        id: "task-b",
        phase: "verification",
        title: "Task B",
        prompt: "Perform task B",
        dependsOn: ["task-a"],
      },
    ],
  });
  return approveExecutionPreview({
    cwd,
    executionId: preview.executionId,
    expectedRevision: preview.revision,
    owner: { id: 1, generation: 1 },
    parentSessionId: "session-a",
    planDigest: "plan-digest",
  });
}

afterEach(() => {
  clearExecutionBindingsForTests();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("durable sequential plan runner", () => {
  it("executes approved tasks sequentially and commits immutable outcomes", async () => {
    const cwd = root();
    const approved = createApproved(cwd);
    const order: string[] = [];
    const runTask = vi.fn(async ({ task, operationId }) => {
      order.push(task.id);
      return {
        summary: `${task.id} complete via ${operationId}`,
        outputDigest: `out-${task.id}`,
      };
    });

    const completed = await runDurableExecution({
      cwd,
      executionId: approved.executionId,
      expectedRevision: approved.revision,
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      runTask,
    });

    expect(order).toEqual(["task-a", "task-b"]);
    expect(completed).toMatchObject({ status: "completed", active: false });
    expect(completed.taskStates).toEqual([
      expect.objectContaining({
        taskId: "task-a",
        status: "committed",
        outputDigest: "out-task-a",
      }),
      expect.objectContaining({
        taskId: "task-b",
        status: "committed",
        outputDigest: "out-task-b",
      }),
    ]);
  });

  it("replays committed outcomes without model re-execution after manual resume", async () => {
    const cwd = root();
    const approved = createApproved(cwd);
    const running = startExecutionRecord({
      cwd,
      executionId: approved.executionId,
      expectedRevision: approved.revision,
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    const operation = beginNextExecutionOperation({
      cwd,
      executionId: approved.executionId,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      owner: { id: 1, generation: 1 },
    })!;
    const committed = commitExecutionOperation({
      cwd,
      executionId: approved.executionId,
      operationId: operation.operationId,
      leaseEpoch: running.lease!.epoch,
      owner: { id: 1, generation: 1 },
      summary: "task-a committed",
      outputDigest: "out-task-a",
    });
    const [interrupted] = interruptExecutionsForOwner({
      cwd,
      owner: { id: 1, generation: 1 },
      lifecycleReason: "quit",
    });
    expect(interrupted.revision).toBeGreaterThan(committed.revision);
    const resumed = resumeExecutionRecord({
      cwd,
      executionId: approved.executionId,
      expectedRevision: interrupted.revision,
      owner: { id: 1, generation: 2 },
      parentSessionId: "session-a",
    });
    const calls: string[] = [];

    const completed = await runDurableExecution({
      cwd,
      executionId: approved.executionId,
      expectedRevision: resumed.revision,
      owner: { id: 1, generation: 2 },
      parentSessionId: "session-a",
      runTask: async ({ task }) => {
        calls.push(task.id);
        return { summary: "done", outputDigest: `out-${task.id}` };
      },
    });

    expect(calls).toEqual(["task-b"]);
    expect(completed.taskStates[0]).toMatchObject({
      taskId: "task-a",
      status: "committed",
      outputDigest: "out-task-a",
    });
  });

  it("fails terminally on an executor error and does not claim exactly-once", async () => {
    const cwd = root();
    const approved = createApproved(cwd);
    await expect(
      runDurableExecution({
        cwd,
        executionId: approved.executionId,
        expectedRevision: approved.revision,
        owner: { id: 1, generation: 1 },
        parentSessionId: "session-a",
        runTask: async () => {
          throw new Error("executor failed");
        },
      }),
    ).rejects.toThrow("executor failed");

    expect(getExecutionRecord(cwd, approved.executionId)).toMatchObject({
      status: "failed",
      active: false,
      exactlyOnce: false,
    });
  });
});
