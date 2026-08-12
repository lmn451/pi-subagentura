import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowTool } from "../src/workflow";
import {
  clearSessionScopes,
  getSessionScopes,
  createSessionScope,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";
import {
  DurableWorkflowDeliveryBroker,
  type DurableWorkflowDeliveryMessage,
} from "../src/workflow-durable-delivery";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import { workflowOwnerFromSessionContext } from "../src/workflow-owner";
import type { SubagentResult } from "../src/helpers";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const repoRoot = new URL("..", import.meta.url).pathname;
const harnesses: PiSessionHarness[] = [];
const roots: string[] = [];
const stores: WorkflowRunStore[] = [];

const success = (output = "complete"): SubagentResult => ({
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

function plan(name: string, approval?: "stop" | "skip"): WorkflowPlan {
  return {
    schemaVersion: 1,
    name,
    phases: [
      {
        id: "phase",
        mode: "sequential",
        tasks: [
          {
            id: "task",
            prompt: `${name} task`,
            ...(approval
              ? { approval: { policyHash: `${name}-policy`, denial: approval } }
              : {}),
          },
        ],
      },
    ],
  };
}

function ownerFor(
  _root: string,
  ownerId = "acceptance-owner",
): WorkflowOwnerIdentity {
  return {
    projectKey: "acceptance-project",
    cwd: repoRoot,
    piSessionId: "acceptance-session",
    ownerId,
    ownerGeneration: 1,
    leaseToken: `${ownerId}-lease`,
  };
}

async function realSession(): Promise<{
  harness: PiSessionHarness;
  scope: SessionScope;
}> {
  const existingScopeIds = new Set(getSessionScopes().map(({ id }) => id));
  const harness = await createPiSessionHarness(repoRoot);
  harnesses.push(harness);
  const newScopes = getSessionScopes().filter(
    ({ id }) => !existingScopeIds.has(id),
  );
  const scope =
    newScopes.find(
      (candidate) => candidate.sessionManager === harness.sessionManager,
    ) ?? (newScopes.length === 1 ? newScopes[0] : undefined);
  if (!scope) throw new Error("real Pi harness has no session scope");
  const sessionId = harness.sessionManager.getSessionId();
  scope.lifecycle = "started";
  scope.generation = 1;
  scope.sessionManager = harness.sessionManager;
  scope.durableWorkflowOwner = workflowOwnerFromSessionContext({
    projectKey: "pi-subagentura-pr84-codex",
    cwd: repoRoot,
    sessionId,
    ownerId: `session-${sessionId}`,
    generation: 0,
    leaseToken: `${repoRoot}\0${sessionId}`,
  });
  return { harness, scope };
}

function commandContext() {
  return { ui: { notify: vi.fn() }, cwd: process.cwd() } as any;
}

function registeredCommands(pi: any): Map<string, { handler: Function }> {
  const commands = new Map<string, { handler: Function }>();
  pi.registerCommand = vi.fn((name: string, command: { handler: Function }) => {
    commands.set(name, command);
  });
  return commands;
}

async function createRun(
  root: string,
  owner: WorkflowOwnerIdentity,
  runId: string,
  workflowPlan: WorkflowPlan,
  runAgent: (input: any) => Promise<SubagentResult>,
): Promise<{ store: WorkflowRunStore; projection: any }> {
  const store = new WorkflowRunStore({ rootDir: root, owner });
  stores.push(store);
  const projection = await runDurableWorkflowPlan({
    store,
    owner,
    runId,
    plan: workflowPlan,
    runAgent,
  });
  return { store, projection };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  for (const scope of getSessionScopes())
    await scope.durableWorkflowStore?.release();
  clearSessionScopes();
  for (const store of stores.splice(0)) await store.release();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("frozen durable workflow delivery acceptance", () => {
  it("F13 persists matching Pi entries and fences normal, recovered, and stale broker settlement", async () => {
    const { harness, scope } = await realSession();
    const owner = scope.durableWorkflowOwner;
    if (!owner) throw new Error("real session has no durable owner");
    const root = await mkdtemp(join(tmpdir(), "workflow-f13-delivery-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    stores.push(store);
    const originalSendMessage = (scope.pi as any).sendMessage.bind(scope.pi);
    const sendMessage = vi.fn(originalSendMessage);
    (scope.pi as any).sendMessage = sendMessage;
    const sendToPi = async (
      message: DurableWorkflowDeliveryMessage,
    ): Promise<void> => {
      await Promise.resolve(
        (scope.pi as any).sendMessage(
          {
            customType: "workflow-notify",
            content: message.message,
            display: true,
            details: {
              workflowId: message.runId,
              status: message.status,
              durable: true,
              deliveryId: message.deliveryId,
              idempotencyKey: message.idempotencyKey,
            },
          },
          { deliverAs: "followUp", triggerTurn: false },
        ),
      );
    };
    const transport = {
      send: async (message: DurableWorkflowDeliveryMessage, key: string) => {
        expect(key).toBe(message.deliveryId);
        await sendToPi(message);
      },
      getPersistedEntries: () => harness.sessionManager.getEntries(),
    };

    const normalId = "f13-normal";
    const normal = await runDurableWorkflowPlan({
      store,
      owner,
      runId: normalId,
      plan: plan(normalId),
      runAgent: async () => success("normal"),
    });
    const normalController = new DurableWorkflowController({
      store,
      owner,
      deliveryTransport: transport,
    });
    const normalDelivery = await normalController.dispatchDelivery(
      normalId,
      workflowDeliveryId(normalId),
    );
    expect(normal.status).toBe("done");
    expect(normalDelivery?.delivery).toMatchObject({
      deliveryId: workflowDeliveryId(normalId),
      status: "delivered",
    });
    expect(
      harness.sessionManager.getEntries().filter((entry: any) => {
        return (
          entry.type === "custom_message" &&
          entry.customType === "workflow-notify" &&
          entry.details?.deliveryId === workflowDeliveryId(normalId)
        );
      }),
    ).toHaveLength(1);
    await normalController.dispatchDelivery(
      normalId,
      workflowDeliveryId(normalId),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const crashId = "f13-crash";
    await runDurableWorkflowPlan({
      store,
      owner,
      runId: crashId,
      plan: plan(crashId),
      runAgent: async () => success("crash"),
    });
    const crashingController = new DurableWorkflowController({
      store,
      owner,
      deliveryTransport: {
        send: async (message) => {
          await sendToPi(message);
          throw new Error("crash after Pi persistence");
        },
        getPersistedEntries: () => harness.sessionManager.getEntries(),
      },
    });
    await expect(
      crashingController.dispatchDelivery(crashId, workflowDeliveryId(crashId)),
    ).rejects.toThrow("crash after Pi persistence");
    expect(
      harness.sessionManager.getEntries().filter((entry: any) => {
        return (
          entry.type === "custom_message" &&
          entry.customType === "workflow-notify" &&
          entry.details?.deliveryId === workflowDeliveryId(crashId)
        );
      }),
    ).toHaveLength(1);
    const retrySend = vi.fn(async () => {
      throw new Error("recovery must use persisted Pi evidence");
    });
    const recoveredStore = new WorkflowRunStore({ rootDir: root, owner });
    stores.push(recoveredStore);
    const recoveredController = new DurableWorkflowController({
      store: recoveredStore,
      owner,
      deliveryTransport: {
        send: retrySend,
        getPersistedEntries: () => harness.sessionManager.getEntries(),
      },
    });
    const recovered = await recoveredController.reconcileDelivery(
      crashId,
      harness.sessionManager.getEntries(),
    );
    expect(recovered?.delivery?.status).toBe("delivered");
    expect(retrySend).not.toHaveBeenCalled();
    expect(
      (await store.readRun(crashId)).events.filter(
        (event) => event.type === "delivery_receipt",
      ),
    ).toHaveLength(1);

    const staleId = "f13-stale";
    await runDurableWorkflowPlan({
      store,
      owner,
      runId: staleId,
      plan: plan(staleId),
      runAgent: async () => success("stale"),
    });
    let releaseOldSend!: () => void;
    let oldSendStarted!: () => void;
    const oldSendRelease = new Promise<void>((resolve) => {
      releaseOldSend = resolve;
    });
    const oldSendStartedPromise = new Promise<void>((resolve) => {
      oldSendStarted = resolve;
    });
    const oldController = new DurableWorkflowController({
      store,
      owner,
      deliveryTransport: {
        send: async (message) => {
          await sendToPi(message);
          oldSendStarted();
          await oldSendRelease;
        },
        getPersistedEntries: () => harness.sessionManager.getEntries(),
      },
    });
    const oldDelivery = oldController.dispatchDelivery(
      staleId,
      workflowDeliveryId(staleId),
    );
    await oldSendStartedPromise;
    await store.append(staleId, "delivery_dispatched", {
      deliveryId: workflowDeliveryId(staleId),
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration + 1,
      leaseEpoch: await store.getLeaseEpoch(),
    });
    releaseOldSend();
    const staleResult = await oldDelivery;
    expect(staleResult?.delivery?.status).toBe("dispatched");
    expect(
      (await store.readRun(staleId)).events.filter(
        (event) => event.type === "delivery_receipt",
      ),
    ).toHaveLength(0);

    const staleRecovery = new DurableWorkflowController({
      store,
      owner,
      deliveryTransport: {
        send: vi.fn(async () => {
          throw new Error("stale recovery must not resend persisted entry");
        }),
        getPersistedEntries: () => harness.sessionManager.getEntries(),
      },
    });
    const staleReconciled = await staleRecovery.reconcileDelivery(
      staleId,
      harness.sessionManager.getEntries(),
    );
    expect(staleReconciled?.delivery?.status).toBe("delivered");
    expect(
      (await store.readRun(staleId)).events.filter(
        (event) => event.type === "delivery_receipt",
      ),
    ).toHaveLength(1);
  }, 30_000);
});

describe("frozen durable workflow retention acceptance", () => {
  it("F14 retains blocked, interrupted, and undelivered runs across a locked registered prune", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-f14-retention-"));
    roots.push(root);
    const owner = ownerFor(root);
    const deliveredId = "f14-delivered";
    const blockedId = "f14-blocked";
    const interruptedId = "f14-interrupted";
    const undeliveredId = "f14-undelivered";
    const store = new WorkflowRunStore({ rootDir: root, owner });
    stores.push(store);

    await createRun(root, owner, deliveredId, plan(deliveredId), async () =>
      success("delivered"),
    );
    const entries: unknown[] = [];
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: {
        send: async (message) => {
          entries.push({
            customType: "workflow-notify",
            details: { deliveryId: message.deliveryId },
          });
        },
        getPersistedEntries: () => entries,
      },
    });
    await broker.deliver(deliveredId, workflowDeliveryId(deliveredId));

    const blocked = await createRun(
      root,
      owner,
      blockedId,
      plan(blockedId, "stop"),
      vi.fn(async () => success("must not run")),
    );
    expect(blocked.projection.status).toBe("blocked");

    await expect(
      createRun(
        root,
        owner,
        interruptedId,
        plan(interruptedId),
        vi.fn(async () => {
          throw new Error("provider interrupted");
        }),
      ),
    ).rejects.toThrow("provider interrupted");
    const interruptedController = new DurableWorkflowController({
      store,
      owner,
    });
    expect((await interruptedController.getStatus(interruptedId))?.status).toBe(
      "interrupted",
    );

    const undelivered = await createRun(
      root,
      owner,
      undeliveredId,
      plan(undeliveredId),
      async () => success("undelivered"),
    );
    expect(undelivered.projection.delivery?.status).toBe("pending");

    const pi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    const commands = registeredCommands(pi);
    const scope = createSessionScope(pi);
    scope.lifecycle = "started";
    scope.generation = 1;
    scope.durableWorkflowOwner = owner;
    scope.durableWorkflowStore = store;
    registerSessionScope(scope);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    registerWorkflowTool(pi, scope);
    const command = commands.get("workflow-retention");
    expect(command).toBeDefined();

    let releaseLock!: () => void;
    let lockEntered!: () => void;
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockEnteredPromise = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    const locked = (store as any).withLock(blockedId, async () => {
      lockEntered();
      await lockRelease;
    }) as Promise<void>;
    await lockEnteredPromise;
    const context = commandContext();
    let settled = false;
    const pruning = command!.handler("0", context);
    void pruning.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseLock();
    await locked;
    await pruning;

    expect(context.ui.notify).toHaveBeenCalledWith(
      "Pruned 1 terminal durable workflow run(s).",
    );
    await expect(store.readRun(deliveredId)).rejects.toThrow();
    await expect(store.readRun(blockedId)).resolves.toBeDefined();
    await expect(store.readRun(interruptedId)).resolves.toBeDefined();
    await expect(store.readRun(undeliveredId)).resolves.toBeDefined();

    const foreignOwner = ownerFor(root, "foreign-owner");
    const foreignStore = new WorkflowRunStore({
      rootDir: root,
      owner: foreignOwner,
    });
    stores.push(foreignStore);
    const foreignPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    const foreignCommands = registeredCommands(foreignPi);
    const foreignScope = createSessionScope(foreignPi);
    foreignScope.lifecycle = "started";
    foreignScope.generation = 1;
    foreignScope.durableWorkflowOwner = foreignOwner;
    foreignScope.durableWorkflowStore = foreignStore;
    registerSessionScope(foreignScope);
    registerWorkflowTool(foreignPi, foreignScope);
    await expect(
      foreignCommands.get("workflow-retention")!.handler("0", commandContext()),
    ).rejects.toThrow("Workflow namespace lease is held by a different owner");
    await expect(store.readRun(blockedId)).resolves.toBeDefined();
  });
});
