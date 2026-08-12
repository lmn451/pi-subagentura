import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableWorkflowProjectionRepository,
  enumerateRecoverableWorkflowRuns,
  recoverWorkflowRun,
} from "../src/workflow-recovery";
import {
  DurableWorkflowController,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import { projectWorkflowRun } from "../src/workflow-projection-repository";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const dirs: string[] = [];
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
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("workflow recovery projection", () => {
  it("folds committed task history without rerunning work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_created", {});
    await store.append("run", "task_started", {
      taskId: "a",
      attempt: 1,
      phaseId: "p",
    });
    await store.append("run", "task_succeeded", {
      taskId: "a",
      attempt: 1,
      result: "ok",
    });
    await store.append("run", "run_interrupted", {});

    const projection = await recoverWorkflowRun({ store, owner }, "run");
    expect(projection.status).toBe("interrupted");
    expect(projection.usageLowerBound).toBe(true);
    expect(projection.tasks.a).toEqual({
      id: "a",
      status: "succeeded",
      attempt: 1,
      result: "ok",
    });
    expect(projection.lastEventOrdinal).toBe(3);
  });

  it("counts each committed attempt usage record once during replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "usage",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("usage", "usage_observed", {
      taskId: "a",
      attempt: 1,
      input: 10,
      output: 4,
    });
    await store.append("usage", "usage_observed", {
      taskId: "a",
      attempt: 1,
      input: 10,
      output: 4,
    });

    const projection = await recoverWorkflowRun({ store, owner }, "usage");
    expect(projection.usage).toEqual({ input: 10, output: 4 });
  });

  it("orders recovered tasks deterministically rather than by completion order", () => {
    const launch = {
      schemaVersion: 1 as const,
      runId: "ordered",
      planRevision: 1,
      resumePolicy: "manual" as const,
      owner,
      createdAt: 1,
    };
    const projection = projectWorkflowRun(launch, [
      {
        schemaVersion: 1,
        eventId: "b",
        runId: "ordered",
        runEpoch: 0,
        type: "task_started",
        payload: { taskId: "b", attempt: 1 },
      },
      {
        schemaVersion: 1,
        eventId: "a",
        runId: "ordered",
        runEpoch: 0,
        type: "task_started",
        payload: { taskId: "a", attempt: 1 },
      },
    ]);
    expect(Object.keys(projection.tasks)).toEqual(["a", "b"]);
  });

  it("rejects another owner and enumerates only matching runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    const other = { ...owner, ownerId: "other-owner", leaseToken: "other" };
    expect(
      (await enumerateRecoverableWorkflowRuns({ store, owner })).map(
        (run) => run.runId,
      ),
    ).toEqual(["run"]);
    await expect(
      recoverWorkflowRun({ store, owner: other }, "run"),
    ).rejects.toThrow("different owner");
  });

  it("does not let stale or duplicate evidence reopen terminal work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "task_started", {
      taskId: "a",
      attempt: 2,
    });
    await store.append("run", "task_succeeded", {
      taskId: "a",
      attempt: 2,
      result: "ok",
    });
    await store.append("run", "task_started", { taskId: "a", attempt: 1 });
    await store.append("run", "run_terminal", {
      result: { status: "done", result: "complete" },
    });
    await store.append("run", "task_failed", {
      taskId: "a",
      attempt: 3,
      error: "late",
    });

    const record = await store.readRun("run");
    const duplicateProjection = projectWorkflowRun(record.launch, [
      ...record.events,
      record.events[1],
    ]);
    const projection = await recoverWorkflowRun({ store, owner }, "run");

    expect(projection.status).toBe("done");
    expect(duplicateProjection.revision).toBe(projection.revision);
    expect(projection.tasks.a).toMatchObject({
      status: "succeeded",
      attempt: 2,
      result: "ok",
    });
  });

  it("preserves the first committed terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_terminal", {
      result: { status: "done", result: "authoritative" },
    });
    await store.append("run", "run_terminal", {
      result: { status: "error", error: { code: "late", message: "stale" } },
    });

    const projection = await recoverWorkflowRun({ store, owner }, "run");
    expect(projection.status).toBe("done");
    expect(projection.terminal).toEqual({
      status: "done",
      result: "authoritative",
    });
  });

  it("projects future-task mutations without reopening terminal tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "task_blocked", { taskId: "blocked" });
    await store.append("run", "task_unblocked", { taskId: "blocked" });
    await store.append("run", "task_skipped", { taskId: "blocked" });
    await store.append("run", "task_succeeded", {
      taskId: "done",
      attempt: 1,
    });
    await store.append("run", "task_blocked", { taskId: "done" });

    const projection = await recoverWorkflowRun({ store, owner }, "run");
    expect(projection.tasks.blocked).toMatchObject({
      status: "skipped",
      attempt: 0,
    });
    expect(projection.tasks.done.status).toBe("succeeded");
  });

  it("fences controller mutations by the projected revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_created", {});
    await store.append("run", "task_appended", {
      taskId: "task",
      phaseId: "phase",
      prompt: "work",
    });
    const controller = new DurableWorkflowController({ store, owner });
    const created = await controller.getStatus("run");
    expect(created?.revision).toBe(2);
    await expect(
      controller.mutateTask("run", {
        type: "skip",
        taskId: "task",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("stale");
    const updated = await controller.mutateTask("run", {
      type: "skip",
      taskId: "task",
      expectedRevision: 2,
    });
    expect(updated?.tasks.task.status).toBe("skipped");

    const appended = await controller.mutateTask("run", {
      type: "append",
      taskId: "later",
      phaseId: "phase-2",
      prompt: "do later work",
      expectedRevision: updated?.revision ?? 0,
    });
    expect(appended?.tasks.later).toMatchObject({
      status: "pending",
      phaseId: "phase-2",
      prompt: "do later work",
    });
    await expect(
      controller.mutateTask("run", {
        type: "append",
        taskId: "later",
        phaseId: "phase-2",
        prompt: "duplicate",
        expectedRevision: appended?.revision ?? 0,
      }),
    ).rejects.toThrow("Duplicate");
  });

  it("enforces the legal block and unblock transition sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "task_appended", {
      taskId: "task",
      phaseId: "phase",
      prompt: "work",
    });
    const controller = new DurableWorkflowController({ store, owner });
    const initial = await controller.getStatus("run");
    const blocked = await controller.mutateTask("run", {
      type: "block",
      taskId: "task",
      expectedRevision: initial?.revision ?? 0,
    });
    await expect(
      controller.mutateTask("run", {
        type: "block",
        taskId: "task",
        expectedRevision: blocked?.revision ?? 0,
      }),
    ).rejects.toThrow("cannot be block");
    const unblocked = await controller.mutateTask("run", {
      type: "unblock",
      taskId: "task",
      expectedRevision: blocked?.revision ?? 0,
    });
    expect(unblocked?.tasks.task.status).toBe("pending");
  });

  it("reads projections through the owner-scoped repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_terminal", {
      result: { status: "done", result: "complete" },
    });

    const repository = new DurableWorkflowProjectionRepository(store, owner);
    await expect(repository.get("missing")).resolves.toBeUndefined();
    await expect(repository.get("run")).resolves.toMatchObject({
      runId: "run",
      status: "done",
    });
    await expect(repository.list()).resolves.toHaveLength(1);
  });

  it("returns durable results and makes cancellation idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_started", {});
    const controller = new DurableWorkflowController({ store, owner });

    await expect(controller.getResult("run")).resolves.toBeUndefined();
    await expect(controller.cancel("run")).resolves.toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
    });
    const eventsAfterCancel = (await store.readRun("run")).events.length;
    await expect(controller.cancel("run")).resolves.toMatchObject({
      status: "cancelled",
    });
    expect((await store.readRun("run")).events.length).toBe(eventsAfterCancel);
    await expect(controller.getResult("run")).resolves.toEqual({
      status: "cancelled",
    });
  });

  it("persists one deterministic terminal delivery intent and receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new DurableWorkflowController({ store, owner });
    await store.createRun({
      runId: "run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("run", "run_terminal", {
      result: { status: "done", result: "complete" },
    });
    await store.append("run", "delivery_intent", {
      deliveryId: workflowDeliveryId("run"),
      message: "Workflow run done",
    });

    const pending = await controller.getStatus("run");
    expect(pending?.delivery).toMatchObject({
      deliveryId: workflowDeliveryId("run"),
      status: "pending",
    });
    await controller.acknowledgeDelivery("run", workflowDeliveryId("run"));
    await controller.acknowledgeDelivery("run", workflowDeliveryId("run"));
    expect((await controller.getStatus("run"))?.delivery?.status).toBe(
      "delivered",
    );
    expect(
      (await store.readRun("run")).events.filter(
        (event) => event.type === "delivery_receipt",
      ),
    ).toHaveLength(1);
  });
});
