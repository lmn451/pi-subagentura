import { afterEach, describe, expect, it, vi } from "vitest";
import { basename } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWorkflowTool } from "../src/workflow";
import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
} from "../src/session-scope";
import { DurableWorkflowDeliveryBroker } from "../src/workflow-durable-delivery";
import { runDurableWorkflowPlan } from "../src/workflow-durable-plan-runner";
import {
  createWorkflowRunStore,
  workflowOwnerFromSessionContext,
} from "../src/workflow-owner";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { SubagentResult } from "../src/helpers";

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "retention-command",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "finish" }],
    },
  ],
};

afterEach(() => {
  clearSessionScopes();
  vi.restoreAllMocks();
});

describe("production workflow-retention command", () => {
  it("prunes only a delivered terminal run through the session-owned route", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-retention-command-"));
    const sessionId = "retention-command-session";
    const owner = workflowOwnerFromSessionContext({
      projectKey: basename(root),
      cwd: root,
      sessionId,
      ownerId: "retention-owner",
      generation: 0,
      leaseToken: "retention-lease-token",
    });
    const store = createWorkflowRunStore(root, owner);
    const runAgent = async (_input: any): Promise<SubagentResult> => ({
      isError: false,
      output: "done",
      usage: {
        input: 0,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
    });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "delivered-run",
      plan,
      runAgent,
    });
    const entries: unknown[] = [];
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: {
        send: async (message) => {
          entries.push({
            customType: "workflow-notify",
            details: {
              workflowId: message.runId,
              deliveryId: message.deliveryId,
            },
          });
        },
        getPersistedEntries: () => entries,
      },
    });
    await broker.deliver("delivered-run");

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "undelivered-run",
      plan,
      runAgent,
    });

    vi.spyOn(process, "cwd").mockReturnValue(root);
    const commands: Array<{ name: string; handler: Function }> = [];
    const pi = {
      registerTool: vi.fn(),
      registerCommand: (name: string, command: { handler: Function }) =>
        commands.push({ name, handler: command.handler }),
      sendMessage: vi.fn(),
    } as any;
    const scope = createSessionScope(pi);
    scope.lifecycle = "started";
    scope.durableWorkflowOwner = owner;
    scope.durableWorkflowStore = store;
    registerSessionScope(scope);
    registerWorkflowTool(pi, scope);

    const command = commands.find((item) => item.name === "workflow-retention");
    expect(command).toBeDefined();
    const prune = vi.spyOn(store, "pruneTerminalRuns");
    const uiNotify = vi.fn();
    let releaseWriter!: () => void;
    let writerEntered!: () => void;
    const writerEnteredPromise = new Promise<void>((resolve) => {
      writerEntered = resolve;
    });
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const activeWriter = (store as any).withLock("delivered-run", async () => {
      writerEntered();
      await writerRelease;
    }) as Promise<void>;
    await writerEnteredPromise;
    let commandSettled = false;
    const commandRun = command?.handler("0", { ui: { notify: uiNotify } });
    void commandRun?.then(() => {
      commandSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commandSettled).toBe(false);
    releaseWriter();
    await activeWriter;
    await commandRun;
    expect(uiNotify).toHaveBeenCalledWith(
      "Pruned 1 terminal durable workflow run(s).",
    );
    expect(prune).toHaveBeenCalledWith({
      olderThanMs: 0,
      maxRuns: undefined,
    });

    await expect(store.readRun("delivered-run")).rejects.toThrow();
    await expect(store.readRun("undelivered-run")).resolves.toBeDefined();

    await rm(root, { recursive: true, force: true });
  });
});
