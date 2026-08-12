import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableWorkflowController,
  ensureDeliveryIntent,
  terminalizeWorkflowRun,
  workflowDeliveryId,
  type WorkflowTaskClaim,
} from "../src/workflow-durable-plan-runner";
import { recoverWorkflowRun } from "../src/workflow-recovery";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeStore(runId: string): Promise<{
  root: string;
  store: WorkflowRunStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "workflow-interleavings-"));
  roots.push(root);
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRun({
    runId,
    planRevision: 1,
    resumePolicy: "manual",
    owner,
  });
  return { root, store };
}

describe("durable workflow interleavings", () => {
  it("F07 lets block and append race with exactly one revision winner", async () => {
    const { store } = await makeStore("block-append-race");
    await store.append("block-append-race", "run_created", {
      tasks: [
        { id: "a", phaseId: "phase", prompt: "A" },
        { id: "b", phaseId: "phase", prompt: "B" },
      ],
    });
    const controller = new DurableWorkflowController({ store, owner });
    const [block, append] = await Promise.allSettled([
      controller.mutateTask("block-append-race", {
        type: "block",
        taskId: "a",
        expectedRevision: 1,
      }),
      controller.mutateTask("block-append-race", {
        type: "append",
        taskId: "c",
        phaseId: "phase-2",
        prompt: "C",
        expectedRevision: 1,
      }),
    ]);

    expect(
      [block, append].filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      [block, append].filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const record = await store.readRun("block-append-race");
    expect(record.events).toHaveLength(2);
    expect(
      record.events.filter((event) => event.type === "task_blocked"),
    ).toHaveLength(block.status === "fulfilled" ? 1 : 0);
    expect(
      record.events.filter((event) => event.type === "task_appended"),
    ).toHaveLength(append.status === "fulfilled" ? 1 : 0);
    expect(
      (await recoverWorkflowRun({ store, owner }, "block-append-race"))
        .revision,
    ).toBe(2);
  });

  it("F07 lets competing settlements race with exactly one claim winner", async () => {
    const { store } = await makeStore("settlement-race");
    await store.append("settlement-race", "run_created", {
      tasks: [{ id: "task", phaseId: "phase", prompt: "task" }],
    });
    const leaseEpoch = await store.getLeaseEpoch();
    const claim: WorkflowTaskClaim = {
      runId: "settlement-race",
      taskId: "task",
      attempt: 1,
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch,
      token: "claim-token",
    };
    await store.append("settlement-race", "task_started", {
      taskId: "task",
      attempt: 1,
      phaseId: "phase",
      claim,
    });
    const [success, failure] = await Promise.all([
      store.appendIfCurrent(
        "settlement-race",
        1,
        "task_succeeded",
        { taskId: "task", attempt: 1, claim, result: "success" },
        leaseEpoch,
      ),
      store.appendIfCurrent(
        "settlement-race",
        1,
        "task_failed",
        { taskId: "task", attempt: 1, claim, error: "failure" },
        leaseEpoch,
      ),
    ]);

    expect(
      [success, failure].filter((result) => result.status === "appended"),
    ).toHaveLength(1);
    expect(
      [success, failure].filter((result) => result.status === "conflict"),
    ).toHaveLength(1);
    const projection = await recoverWorkflowRun(
      { store, owner },
      "settlement-race",
    );
    expect(["succeeded", "failed"]).toContain(projection.tasks.task.status);
    expect(projection.tasks.task.attempt).toBe(1);
    expect(
      (await store.readRun("settlement-race")).events.filter((event) =>
        ["task_succeeded", "task_failed"].includes(event.type),
      ),
    ).toHaveLength(1);
  });

  it("F07 lets finalization and outbox repair interleave with one terminal winner", async () => {
    const { store } = await makeStore("finalization-race");
    const [done, error] = await Promise.all([
      terminalizeWorkflowRun(store, owner, "finalization-race", {
        status: "done",
        result: "done",
      }),
      terminalizeWorkflowRun(store, owner, "finalization-race", {
        status: "error",
        error: { code: "failed", message: "failed" },
      }),
    ]);
    const terminal = await Promise.all([
      ensureDeliveryIntent(store, owner, "finalization-race"),
      ensureDeliveryIntent(store, owner, "finalization-race"),
    ]);
    const record = await store.readRun("finalization-race");
    const terminalEvents = record.events.filter(
      (event) => event.type === "run_result",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_terminal"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
    expect(done.status).toBe(error.status);
    expect(["done", "error"]).toContain(done.status);
    expect(terminal.every((projection) => projection.delivery)).toBe(true);
    expect(terminalEvents[0].payload).toMatchObject({
      result: { status: expect.stringMatching(/^(done|error)$/) },
    });
    expect(workflowDeliveryId("finalization-race")).toHaveLength(64);
  });
});
