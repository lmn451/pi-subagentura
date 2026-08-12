import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { registerSessionHandlers } from "../src/session-handlers";
import { clearSessionScopes } from "../src/session-scope";
import {
  DurableWorkflowDeliveryBroker,
  type DurableWorkflowDeliveryMessage,
} from "../src/workflow-durable-delivery";
import {
  runDurableWorkflowPlan,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import {
  createWorkflowRunStore,
  workflowOwnerFromSessionContext,
} from "../src/workflow-owner";
import type { WorkflowPlan } from "../src/workflow-plan";

const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "session-recovery",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "finish" }],
    },
  ],
};

afterEach(() => clearSessionScopes());

describe("production session durable delivery recovery", () => {
  it("reconciles a matching persisted Pi entry without sending again", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-session-recovery-"));
    const sessionId = "session-recovery-test";
    const owner = workflowOwnerFromSessionContext({
      projectKey: basename(root),
      cwd: root,
      sessionId,
      ownerId: `session-${createHash("sha256").update(sessionId).digest("hex")}`,
      generation: 0,
      leaseToken: createHash("sha256")
        .update(`${root}\0${sessionId}`)
        .digest("hex"),
    });
    const store = createWorkflowRunStore(root, owner);
    const runId = "session-delivery-recovery";
    const entries: unknown[] = [];

    await runDurableWorkflowPlan({
      store,
      owner,
      runId,
      plan,
      runAgent: async () => ({
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
        model: "test/model",
      }),
    });

    const transportSend = vi.fn(
      async (message: DurableWorkflowDeliveryMessage) => {
        entries.push({
          customType: "workflow-notify",
          details: {
            workflowId: message.runId,
            deliveryId: message.deliveryId,
          },
        });
        throw new Error("simulated crash after Pi entry persistence");
      },
    );
    const broker = new DurableWorkflowDeliveryBroker({
      store,
      owner,
      transport: { send: transportSend },
    });
    await expect(
      broker.deliver(runId, workflowDeliveryId(runId)),
    ).rejects.toThrow("simulated crash");
    expect(entries).toHaveLength(1);

    const handlers = new Map<string, Function[]>();
    const sendMessage = vi.fn();
    const pi = {
      on: (event: string, handler: Function) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      sendMessage,
    } as any;
    registerSessionHandlers(pi);
    const sessionManager = {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    };
    await handlers.get("session_start")?.[0]?.(
      { reason: "startup" },
      { cwd: root, sessionManager, ui: {} },
    );
    await vi.waitFor(
      async () => {
        const recovered = await store.readRun(runId);
        expect(
          recovered.events.some((event) => event.type === "delivery_receipt"),
        ).toBe(true);
      },
      { timeout: 5000, interval: 25 },
    );

    expect(transportSend).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
