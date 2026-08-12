import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DurableWorkflowProjectionRepository,
  enumerateRecoverableWorkflowRuns,
  recoverWorkflowRun,
  recoverWorkflowRunsAtStartup,
} from "../src/workflow-recovery";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import type { WorkflowProjection } from "../src/workflow-projection-repository";
import { projectWorkflowRun } from "../src/workflow-projection-repository";
import {
  canonicalizeWorkflowValue,
  type WorkflowPlan,
} from "../src/workflow-plan";
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

function legacyMutationHash(
  previousMutationHash: string,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ previousMutationHash, payload }))
    .digest("hex");
}

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

  it("recovers legacy mutation hashes and chains new canonical mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "legacy",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    const appendedPayload = {
      taskId: "legacy-task",
      phaseId: "phase",
      prompt: "legacy work",
    };
    const appendedHash = legacyMutationHash("", appendedPayload);
    await store.append("legacy", "task_appended", {
      ...appendedPayload,
      previousMutationHash: "",
      mutationHash: appendedHash,
    });
    const blockedPayload = { taskId: "legacy-task" };
    const blockedHash = legacyMutationHash(appendedHash, blockedPayload);
    await store.append("legacy", "task_blocked", {
      ...blockedPayload,
      previousMutationHash: appendedHash,
      mutationHash: blockedHash,
    });

    const recovered = await recoverWorkflowRun({ store, owner }, "legacy");
    expect(recovered).toMatchObject({
      revision: 2,
      mutationHash: blockedHash,
      tasks: {
        "legacy-task": {
          status: "blocked",
          phaseId: "phase",
          prompt: "legacy work",
        },
      },
    });

    const controller = new DurableWorkflowController({ store, owner });
    const unblocked = await controller.mutateTask("legacy", {
      type: "unblock",
      taskId: "legacy-task",
      expectedRevision: recovered.revision,
    });
    expect(unblocked).toMatchObject({
      revision: 3,
      mutationHash: expect.any(String),
      tasks: { "legacy-task": { status: "pending" } },
    });

    const events = (await store.readRun("legacy")).events;
    const followUp = events[2];
    expect(followUp?.type).toBe("task_unblocked");
    const followUpPayload = followUp?.payload as Record<string, unknown>;
    const expectedCanonicalHash = createHash("sha256")
      .update(
        canonicalizeWorkflowValue({
          previousMutationHash: blockedHash,
          payload: blockedPayload,
        }),
      )
      .digest("hex");
    expect(followUpPayload.previousMutationHash).toBe(blockedHash);
    expect(followUpPayload.mutationHash).toBe(expectedCanonicalHash);
    expect(unblocked?.mutationHash).toBe(expectedCanonicalHash);
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
  it("projects stale running claims to interrupted at startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "stale",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("stale", "run_created", {});
    await store.append("stale", "run_started", {});
    await store.append("stale", "task_started", {
      taskId: "a",
      attempt: 1,
      phaseId: "phase",
    });

    const replacementOwner = {
      ...owner,
      ownerGeneration: owner.ownerGeneration + 1,
      leaseToken: "reloaded-lease",
    };
    const replacementStore = new WorkflowRunStore({
      rootDir: root,
      owner: replacementOwner,
    });
    const result = await recoverWorkflowRunsAtStartup({
      store: replacementStore,
      owner: replacementOwner,
      reason: "startup",
    });
    expect(result.interruptedRunIds).toEqual(["stale"]);
    expect(result.resumeEligibleRunIds).toEqual([]);
    await expect(
      recoverWorkflowRun(
        { store: replacementStore, owner: replacementOwner },
        "stale",
      ),
    ).resolves.toMatchObject({
      status: "interrupted",
      tasks: { a: { status: "running", attempt: 1 } },
    });
    expect(
      (await replacementStore.readRun("stale")).events.filter(
        (event) => event.type === "run_interrupted",
      ),
    ).toHaveLength(1);
  });

  it("hands off a trusted resume without replaying committed tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const persistedPlan: WorkflowPlan = {
      schemaVersion: 1,
      name: "resume",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            { id: "committed", prompt: "committed" },
            { id: "pending", prompt: "pending" },
          ],
        },
      ],
    };
    await store.createRun({
      runId: "resume",
      planRevision: 1,
      plan: persistedPlan,
      resumePolicy: "on-session-start",
      owner,
    });
    await store.append("resume", "run_created", {});
    await store.append("resume", "run_started", {});
    await store.append("resume", "task_started", {
      taskId: "committed",
      attempt: 1,
      phaseId: "phase",
    });
    await store.append("resume", "task_succeeded", {
      taskId: "committed",
      attempt: 1,
      result: "done",
    });
    await store.append("resume", "task_started", {
      taskId: "pending",
      attempt: 1,
      phaseId: "phase",
    });

    const handoff: WorkflowProjection[] = [];
    const handoffPlans: WorkflowPlan[] = [];
    const result = await recoverWorkflowRunsAtStartup({
      store,
      owner,
      reason: "startup",
      trustedResume: true,
      onAutoResume: (projection, plan) => {
        handoff.push(projection);
        if (plan) handoffPlans.push(plan);
      },
    });
    expect(result.resumeEligibleRunIds).toEqual(["resume"]);
    expect(result.autoResumedRunIds).toEqual(["resume"]);
    expect(handoff[0]).toMatchObject({
      status: "interrupted",
      tasks: {
        committed: { status: "succeeded", attempt: 1 },
        pending: { status: "running", attempt: 1 },
      },
    });
    expect(handoffPlans).toEqual([persistedPlan]);
  });

  it("auto-resumes only an explicitly permitted policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const autoPlan: WorkflowPlan = {
      schemaVersion: 1,
      name: "auto",
      phases: [
        {
          id: "phase",
          mode: "parallel",
          tasks: [{ id: "a", prompt: "a" }],
        },
      ],
    };
    await store.createRun({
      runId: "auto",
      planRevision: 1,
      plan: autoPlan,
      resumePolicy: "on-session-start",
      owner,
    });
    await store.append("auto", "run_started", {});
    await store.append("auto", "task_started", {
      taskId: "a",
      attempt: 1,
    });
    const handoff: string[] = [];
    const handoffPlans: WorkflowPlan[] = [];
    const result = await recoverWorkflowRunsAtStartup({
      store,
      owner,
      reason: "reload",
      onAutoResume: (projection, plan) => {
        handoff.push(projection.runId);
        if (plan) handoffPlans.push(plan);
      },
    });
    expect(result.autoResumedRunIds).toEqual(["auto"]);
    expect(handoff).toEqual(["auto"]);
    expect(handoffPlans).toEqual([autoPlan]);
  });
  it("auto-resumes a persisted plan once without replaying committed tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "auto-once",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            { id: "committed", prompt: "committed" },
            { id: "pending", prompt: "pending" },
          ],
        },
      ],
    };
    await store.createRun({
      runId: "auto-once",
      planRevision: 1,
      plan,
      resumePolicy: "on-session-start",
      owner,
    });
    await store.append("auto-once", "run_created", {
      tasks: [
        { id: "committed", phaseId: "phase", prompt: "committed" },
        { id: "pending", phaseId: "phase", prompt: "pending" },
      ],
    });
    await store.append("auto-once", "run_started", {});
    await store.append("auto-once", "task_started", {
      taskId: "committed",
      attempt: 1,
      phaseId: "phase",
    });
    await store.append("auto-once", "task_succeeded", {
      taskId: "committed",
      attempt: 1,
      result: "already done",
    });
    await store.append("auto-once", "task_started", {
      taskId: "pending",
      attempt: 1,
      phaseId: "phase",
    });

    const calls: string[] = [];
    const result = await recoverWorkflowRunsAtStartup({
      store,
      owner,
      reason: "startup",
      onAutoResume: async (projection, persistedPlan) => {
        expect(projection.runId).toBe("auto-once");
        expect(persistedPlan).toEqual(plan);
        await runDurableWorkflowPlan({
          store,
          owner,
          runId: projection.runId,
          plan: persistedPlan!,
          resume: true,
          runAgent: async ({ prompt }) => {
            calls.push(prompt);
            return {
              isError: false,
              output: `done:${prompt}`,
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                turns: 1,
              },
            };
          },
        });
      },
    });

    expect(result.autoResumedRunIds).toEqual(["auto-once"]);
    expect(calls).toEqual(["pending"]);
    await expect(
      recoverWorkflowRun({ store, owner }, "auto-once"),
    ).resolves.toMatchObject({
      status: "done",
      tasks: {
        committed: { status: "succeeded", attempt: 1 },
        pending: { status: "succeeded", attempt: 2 },
      },
    });
  });

  it("keeps legacy on-session-start runs queryable without auto-resuming", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "legacy",
      planRevision: 1,
      resumePolicy: "on-session-start",
      owner,
    });
    await store.append("legacy", "run_started", {});
    await store.append("legacy", "task_started", {
      taskId: "a",
      attempt: 1,
    });

    let callbackCount = 0;
    const result = await recoverWorkflowRunsAtStartup({
      store,
      owner,
      reason: "reload",
      onAutoResume: () => {
        callbackCount++;
      },
    });
    expect(result.interruptedRunIds).toEqual(["legacy"]);
    expect(result.resumeEligibleRunIds).toEqual([]);
    expect(result.autoResumedRunIds).toEqual([]);
    expect(callbackCount).toBe(0);
    await expect(
      recoverWorkflowRun({ store, owner }, "legacy"),
    ).resolves.toMatchObject({ status: "interrupted" });
  });

  it("does not auto-resume manual runs even when trusted recovery is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "manual",
      planRevision: 1,
      plan: {
        schemaVersion: 1,
        name: "manual",
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [{ id: "a", prompt: "a" }],
          },
        ],
      },
      resumePolicy: "manual",
      owner,
    });
    await store.append("manual", "run_started", {});
    await store.append("manual", "task_started", {
      taskId: "a",
      attempt: 1,
    });

    let callbackCount = 0;
    const result = await recoverWorkflowRunsAtStartup({
      store,
      owner,
      reason: "startup",
      trustedResume: true,
      onAutoResume: () => {
        callbackCount++;
      },
    });
    expect(result.resumeEligibleRunIds).toEqual([]);
    expect(result.autoResumedRunIds).toEqual([]);
    expect(callbackCount).toBe(0);
  });

  it("does not claim prior runs on new or fork lifecycle boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-recovery-"));
    dirs.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "prior",
      planRevision: 1,
      resumePolicy: "on-session-start",
      owner,
    });
    await store.append("prior", "run_started", {});
    await store.append("prior", "task_started", { taskId: "a", attempt: 1 });

    await expect(
      recoverWorkflowRunsAtStartup({ store, owner, reason: "new" }),
    ).resolves.toMatchObject({
      runs: [],
      interruptedRunIds: [],
    });
    expect(
      (await store.readRun("prior")).events.some(
        (event) => event.type === "run_interrupted",
      ),
    ).toBe(false);
  });
});
