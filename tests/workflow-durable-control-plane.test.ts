import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionScope } from "../src/session-scope";
import { DurableWorkflowDeliveryBroker } from "../src/workflow-durable-delivery";
import {
  runDurableWorkflowForSession,
  resumeDurableWorkflowForSession,
  dispatchTerminalDeliveryForSession,
} from "../src/workflow-owner";
import {
  DurableWorkflowController as RunnerController,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { SubagentResult } from "../src/helpers";

const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "control",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "task" }],
    },
  ],
};

const approvalPlan: WorkflowPlan = {
  schemaVersion: 1,
  name: "approval",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [
        {
          id: "gated",
          prompt: "gated task",
          approval: { policyHash: "policy-v1", denial: "skip" },
        },
      ],
    },
  ],
};

const success = (output = "ok"): SubagentResult => ({
  isError: false,
  output,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
});

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createStoreRun(
  runId: string,
  options: { plan?: WorkflowPlan; terminal?: boolean; delivery?: boolean } = {},
): Promise<WorkflowRunStore> {
  const root = await mkdtemp(join(tmpdir(), "workflow-control-plane-"));
  roots.push(root);
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRun({
    runId,
    planRevision: 1,
    resumePolicy: "manual",
    owner,
  });
  await store.append(runId, "run_created", {
    ...(options.plan ? { plan: options.plan } : {}),
  });
  if (options.terminal) {
    await store.append(runId, "run_terminal", {
      result: { status: "done", result: "complete" },
    });
  }
  if (options.delivery) {
    await store.append(runId, "delivery_intent", {
      deliveryId: workflowDeliveryId(runId),
      kind: "terminal",
      message: `Workflow ${runId} done`,
    });
  }
  return store;
}

describe("durable workflow control plane", () => {
  it("serializes delivery, retries transport failures, and receipts only after success", async () => {
    const runId = "delivery-run";
    const deliveryId = workflowDeliveryId(runId);
    const store = await createStoreRun(runId, {
      terminal: true,
      delivery: true,
    });
    let calls = 0;
    let release: (() => void) | undefined;
    let secondCall: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondCall = resolve;
    });
    const entries: unknown[] = [];
    const send = async (
      message: { deliveryId: string },
      key: string,
    ): Promise<void> => {
      calls++;
      expect(key).toBe(deliveryId);
      if (calls === 1) throw new Error("transport unavailable");
      entries.push({
        customType: "workflow-notify",
        details: { deliveryId: message.deliveryId },
      });
      secondCall!();
      await entered;
    };
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: {
        send,
        getPersistedEntries: () => entries,
      },
    });

    await expect(broker.deliver(runId, deliveryId)).rejects.toThrow(
      "transport unavailable",
    );
    const failed = await store.readRun(runId);
    expect(
      failed.events.some((event) => event.type === "delivery_receipt"),
    ).toBe(false);
    expect(
      failed.events.filter((event) => event.type === "delivery_dispatched"),
    ).toHaveLength(1);

    const first = broker.deliver(runId, deliveryId);
    const second = broker.deliver(runId, deliveryId);
    await secondStarted;
    expect(calls).toBe(2);
    release!();
    const [one, two] = await Promise.all([first, second]);
    expect(one?.delivery?.status).toBe("delivered");
    expect(two?.delivery?.status).toBe("delivered");
    await broker.acknowledge(runId, deliveryId);
    await broker.deliver(runId, deliveryId);
    expect(calls).toBe(2);
    const completed = await store.readRun(runId);
    expect(
      completed.events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(1);
  });

  it("keeps status and result reads write-free while preserving compatibility projections", async () => {
    const store = await createStoreRun("read-run", { plan });
    await store.append("read-run", "run_started", {});
    await store.append("read-run", "task_started", {
      taskId: "task",
      attempt: 1,
    });
    await store.append("read-run", "task_failed", {
      taskId: "task",
      attempt: 1,
      error: "failed",
    });
    const controller = new RunnerController({ store, owner });
    const before = await store.readRun("read-run");

    const status = await controller.getStatus("read-run");
    const result = await controller.getResult("read-run");

    expect(status?.terminal).toMatchObject({ status: "error" });
    expect(result).toMatchObject({ status: "error" });
    const after = await store.readRun("read-run");
    expect(after.events).toHaveLength(before.events.length);
    expect(after.events.some((event) => event.type === "run_result")).toBe(
      false,
    );
    expect(after.events.some((event) => event.type === "delivery_intent")).toBe(
      false,
    );
  });

  it("arbitrates concurrent cancellation callers with one authoritative winner", async () => {
    const store = await createStoreRun("cancel-run");
    await store.append("cancel-run", "run_started", {});
    const controller = new RunnerController({ store, owner });

    const [left, right] = await Promise.all([
      controller.cancel("cancel-run", "cancel-left"),
      controller.cancel("cancel-run", "cancel-right"),
    ]);
    const record = await store.readRun("cancel-run");
    const cancellationEvents = record.events.filter(
      (event) => event.type === "run_cancel_requested",
    );
    expect(cancellationEvents).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_result"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_cancelled"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
    expect(left?.status).toBe("cancelled");
    expect(right?.status).toBe("cancelled");
    expect(cancellationEvents[0].payload).toMatchObject({
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      requestId: expect.stringMatching(/^cancel-(left|right)$/),
    });
  });

  it("repairs an interrupted cancellation prefix idempotently after recovery", async () => {
    const runId = "cancel-recovery";
    const store = await createStoreRun(runId);
    await store.append(runId, "run_started", {});
    const leaseEpoch = await store.getLeaseEpoch();
    await store.append(runId, "run_cancel_requested", {
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch,
      requestId: "cancel-recovery-request",
    });
    const controller = new RunnerController({ store, owner });

    const repaired = await controller.cancel(runId, "cancel-recovery-request");
    const replayed = await controller.cancel(runId, "cancel-recovery-request");
    const record = await store.readRun(runId);

    expect(repaired?.status).toBe("cancelled");
    expect(replayed?.status).toBe("cancelled");
    expect(
      record.events.filter((event) => event.type === "run_cancel_requested"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_result"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_cancelled"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
  });

  it("binds approvals to the current authority and keeps rejection blocked but non-terminal", async () => {
    const store = await createStoreRun("approval-binding");
    const controller = new RunnerController({ store, owner });
    const pending = await controller.requestApproval("approval-binding", {
      requestId: "approval-request",
      policyHash: "policy",
      planRevision: 99,
      ownerGeneration: 99,
      leaseEpoch: 99,
      version: 1,
    });
    expect(pending?.approval?.request).toMatchObject({
      requestId: "approval-request",
      policyHash: "policy",
      planRevision: 1,
      ownerGeneration: owner.ownerGeneration,
      version: 1,
    });
    const stale = await controller.decideApproval(
      "approval-binding",
      "approval-request",
      {
        requestId: "approval-request",
        status: "approved",
        decidedBy: "stale",
        policyHash: "wrong-policy",
      },
    );
    expect(stale?.approval?.status).toBe("pending");
    const rejected = await controller.decideApproval(
      "approval-binding",
      "approval-request",
      {
        requestId: "approval-request",
        status: "rejected",
        decidedBy: "operator",
        reason: "Needs review",
      },
    );
    expect(rejected?.approval?.status).toBe("rejected");
    expect(rejected?.status).toBe("blocked");
    expect(rejected?.terminal).toBeUndefined();
    expect(rejected?.blockers.approval).toMatchObject({
      source: "approval",
      reason: "Needs review",
    });
    expect(rejected?.runBlock).toMatchObject({ source: "approval" });
  });

  it("persists declarative task approval gates and skips only the matching task", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-approval-gate-"));
    roots.push(root);
    const scope = createSessionScope({} as any);
    scope.durableWorkflowOwner = owner;
    const runAgent = vi.fn(async () => success("must not run"));

    const blocked = await runDurableWorkflowForSession(root, scope, {
      runId: "approval-gate",
      plan: approvalPlan,
      runAgent,
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.approval?.request).toMatchObject({
      taskId: "gated",
      policyHash: "policy-v1",
      denial: "skip",
    });
    expect(runAgent).not.toHaveBeenCalled();

    const controller = new RunnerController({
      store: new WorkflowRunStore({ rootDir: root, owner }),
      owner,
    });
    const requestId = blocked.approval!.request.requestId;
    const skipped = await controller.decideApproval(
      "approval-gate",
      requestId,
      {
        requestId,
        status: "rejected",
        decidedBy: "operator",
        policyHash: "policy-v1",
        planRevision: blocked.planRevision,
        version: 1,
      },
    );
    expect(skipped?.tasks.gated.status).toBe("skipped");

    const resumed = await resumeDurableWorkflowForSession(root, scope, {
      runId: "approval-gate",
      runAgent,
    });
    expect(resumed.status).toBe("done");
    expect(resumed.tasks.gated.status).toBe("skipped");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("reclaims a dispatched delivery after the previous broker disappears", async () => {
    const runId = "delivery-reclaim";
    const deliveryId = workflowDeliveryId(runId);
    const store = await createStoreRun(runId, {
      terminal: true,
      delivery: true,
    });
    await store.append(runId, "delivery_dispatched", {
      deliveryId,
      ownerId: "dead-broker",
      ownerGeneration: 1,
      leaseEpoch: await store.getLeaseEpoch(),
    });

    let calls = 0;
    const entries: unknown[] = [];
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: {
        send: async (message, key) => {
          expect(key).toBe(deliveryId);
          calls++;
          entries.push({
            customType: "workflow-notify",
            details: { deliveryId: message.deliveryId },
          });
        },
        getPersistedEntries: () => entries,
      },
    });

    const result = await broker.deliver(runId, deliveryId);
    expect(result?.delivery?.status).toBe("delivered");
    expect(calls).toBe(1);
    const record = await store.readRun(runId);
    expect(
      record.events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "delivery_dispatched"),
    ).toHaveLength(2);
  });

  it("does not let a stale owner settle after claim takeover", async () => {
    const runId = "delivery-stale-owner";
    const deliveryId = workflowDeliveryId(runId);
    const store = await createStoreRun(runId, {
      terminal: true,
      delivery: true,
    });
    let oldTransportStarted: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => {
      oldTransportStarted = resolve;
    });
    const oldBroker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: async () => {
        oldTransportStarted!();
        const leaseEpoch = await store.getLeaseEpoch();
        await store.append(runId, "delivery_dispatched", {
          deliveryId,
          ownerId: owner.ownerId,
          ownerGeneration: owner.ownerGeneration + 1,
          leaseEpoch,
        });
      },
    });

    const resultPromise = oldBroker.deliver(runId, deliveryId);
    await oldStarted;
    const result = await resultPromise;
    expect(result?.delivery?.status).toBe("dispatched");
    const record = await store.readRun(runId);
    expect(
      record.events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(0);
    expect(record.events.at(-1)?.payload).toMatchObject({
      ownerGeneration: owner.ownerGeneration + 1,
    });
  });

  it("reconciles a persisted matching session entry without sending again", async () => {
    const runId = "delivery-reconcile";
    const deliveryId = workflowDeliveryId(runId);
    const store = await createStoreRun(runId, {
      terminal: true,
      delivery: true,
    });
    await store.append(runId, "delivery_dispatched", {
      deliveryId,
      ownerId: "dead-broker",
      ownerGeneration: 1,
      leaseEpoch: await store.getLeaseEpoch(),
    });
    const send = vi.fn(async () => {
      throw new Error("transport must not run for persisted evidence");
    });
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: send,
    });

    const result = await broker.reconcile(runId, [
      {
        customType: "workflow-notify",
        details: { deliveryId },
      },
    ]);

    expect(result?.delivery?.status).toBe("delivered");
    expect(send).not.toHaveBeenCalled();
    const record = await store.readRun(runId);
    expect(
      record.events.filter((event) => event.type === "delivery_receipt"),
    ).toHaveLength(1);
  });

  it("uses one broker path for terminal delivery from the session runner", async () => {
    const entries: unknown[] = [];
    const sendMessage = vi.fn().mockImplementation((message) => {
      entries.push(message);
      return undefined;
    });
    const scope = createSessionScope({ sendMessage } as any);
    scope.durableWorkflowOwner = owner;
    scope.sessionManager = { getEntries: () => entries };
    const root = await mkdtemp(join(tmpdir(), "workflow-runner-delivery-"));
    roots.push(root);
    const result = await runDurableWorkflowForSession(root, scope, {
      runId: "runner-delivery",
      plan,
      runAgent: async () => success("runner"),
    });

    expect(result.delivery?.status).toBe("delivered");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      customType: "workflow-notify",
      details: { deliveryId: workflowDeliveryId("runner-delivery") },
    });
    await dispatchTerminalDeliveryForSession(root, scope, result);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resumes from the declarative plan persisted in run_created", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-resume-"));
    roots.push(root);
    const scope = createSessionScope({} as any);
    scope.durableWorkflowOwner = owner;
    let shouldInterrupt = true;
    await expect(
      runDurableWorkflowForSession(root, scope, {
        runId: "persisted-resume",
        plan,
        runAgent: async () => {
          if (shouldInterrupt) {
            shouldInterrupt = false;
            throw new Error("interrupted");
          }
          return success();
        },
      }),
    ).rejects.toThrow("interrupted");

    const resumed = await resumeDurableWorkflowForSession(root, scope, {
      runId: "persisted-resume",
      runAgent: async () => success("resumed"),
    });
    expect(resumed.status).toBe("done");
    expect(resumed.tasks.task.result).toBe("resumed");
  });
});
