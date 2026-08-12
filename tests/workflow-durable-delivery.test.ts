import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES,
  durableWorkflowDeliveryId,
} from "../src/workflow-delivery";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunJournal,
} from "../src/workflow-run-store";
import {
  ROOT_WORKFLOW_DEFINITION_PATH,
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowRunEvent,
  type WorkflowUsageAccounting,
} from "../src/workflow-run-types";

const ZERO_ACCOUNTING: WorkflowUsageAccounting = {
  completeness: "exact",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    turns: 0,
    totalTokens: 0,
  },
};

async function appendEvent<Type extends WorkflowRunEvent["type"]>(
  journal: WorkflowRunJournal,
  type: Type,
  payload: Extract<WorkflowRunEvent, { type: Type }>["payload"],
): Promise<{ eventId: string; byteEndExclusive: number }> {
  const events = await journal.readEvents();
  const event = {
    schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
    eventId: `${type}-${events.length + 1}`,
    runId: journal.runId,
    runEpoch: journal.runEpoch!,
    sequence: events.length + 1,
    type,
    payload,
  } as Extract<WorkflowRunEvent, { type: Type }>;
  const receipt = await journal.append(event);
  return { eventId: event.eventId, byteEndExclusive: receipt.byteEndExclusive };
}

describe("durable workflow terminal delivery", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let processNumber: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-durable-delivery-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-delivery-session");
    processNumber = 300;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(): WorkflowRunStore {
    processNumber += 1;
    return new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: processNumber,
        processStartIdentity: `delivery-process-${processNumber}`,
      },
    });
  }

  async function seedTerminalWithoutIntent(
    runId: DurableWorkflowRunId,
    crashBeforeTerminal = false,
  ): Promise<void> {
    const runStore = store();
    const lease = await runStore.acquireLease(owner, {
      scopeId: 1,
      generation: 1,
    });
    const journal = await lease.createRun({
      runId,
      launch: {
        executionKind: "plan",
        resumePolicy: "trusted_resume",
        plan: { name: "seeded-terminal" },
      },
    });
    const rootDefinitionPath = createWorkflowDefinitionPath(
      ROOT_WORKFLOW_DEFINITION_PATH,
    );
    const rootDefinitionDigest = createWorkflowDefinitionDigest("0".repeat(64));
    await appendEvent(journal, "run_created", {
      durableOwner: owner,
      executionKind: "plan",
      rootDefinitionPath,
      rootDefinitionDigest,
      resumePolicy: "trusted_resume",
    });
    await appendEvent(journal, "run_epoch_acquired", {
      fence: journal.fence!,
      previousRunEpoch: null,
      reason: "created",
    });
    const result = await journal.writeOutput({
      meta: {
        name: "seeded-terminal",
        description: "crash-window fixture",
        phases: [],
      },
      status: "done",
      result: [],
      projection: {},
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: ZERO_ACCOUNTING.usage,
      phases: [],
      evidence: "committed before notification",
    });
    const resultEvent = await appendEvent(journal, "run_result_recorded", {
      result,
      accounting: ZERO_ACCOUNTING,
    });
    if (crashBeforeTerminal) {
      await lease.release();
      return;
    }
    const terminal = await appendEvent(journal, "run_terminal", {
      status: "done",
      accounting: ZERO_ACCOUNTING,
      resultEventId: resultEvent.eventId,
    });
    await journal.writeResult({
      terminalEventId: terminal.eventId,
      baseEventByteEndExclusive: terminal.byteEndExclusive,
      result,
    });
    await lease.release();
  }

  async function reopen(
    runId: DurableWorkflowRunId,
  ): Promise<DurableWorkflowPlanController> {
    const controller = await DurableWorkflowPlanController.acquire({
      store: store(),
      owner,
      scopeId: 2,
      generation: 2,
      runAgentForRun: () => async () => {
        throw new Error(`terminal run ${runId} must not dispatch model work`);
      },
    });
    await controller.open("startup");
    return controller;
  }

  it("regenerates one deterministic bounded intent without adding an execution epoch", async () => {
    const runId = createDurableWorkflowRunId("terminal-without-intent");
    await seedTerminalWithoutIntent(runId);
    const controller = await reopen(runId);
    expect((await controller.getProjection(runId))?.deliveries).toMatchObject([
      { state: "pending" },
    ]);

    await expect(controller.getResult(runId)).resolves.toMatchObject({
      status: "done",
      evidence: "committed before notification",
    });
    await expect(controller.reconcileDeliveries()).resolves.toEqual({
      intentsRecorded: 0,
      receiptsRecorded: 0,
    });

    const projection = await controller.getProjection(runId);
    const delivery = projection?.deliveries[0];
    expect(delivery).toMatchObject({
      deliveryId: durableWorkflowDeliveryId(
        owner,
        runId,
        projection!.terminal!.eventId,
      ),
      terminalEventId: projection!.terminal!.eventId,
      state: "pending",
    });
    expect(delivery!.payload.sizeBytes).toBeLessThanOrEqual(
      MAX_DURABLE_WORKFLOW_DELIVERY_PAYLOAD_BYTES,
    );
    const events = await (await store().openRun(owner, runId)).readEvents();
    expect(
      events.filter((event) => event.type === "run_epoch_acquired"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "delivery_intent_recorded"),
    ).toHaveLength(1);
    await controller.release();
  });

  it("repairs a committed result-to-terminal crash gap before exposing recovery", async () => {
    const runId = createDurableWorkflowRunId("result-without-terminal");
    await seedTerminalWithoutIntent(runId, true);
    const controller = await reopen(runId);

    expect(await controller.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
      deliveries: [{ state: "pending" }],
    });
    await expect(controller.getResult(runId)).resolves.toMatchObject({
      status: "done",
      evidence: "committed before notification",
    });
    const events = await (await store().openRun(owner, runId)).readEvents();
    expect(
      events.filter((event) => event.type === "run_epoch_acquired"),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "run_terminal"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "delivery_intent_recorded"),
    ).toHaveLength(1);
    await controller.release();
  });

  it("retries the dispatch-before-receipt window and stops after a durable receipt", async () => {
    const runId = createDurableWorkflowRunId("dispatch-without-receipt");
    await seedTerminalWithoutIntent(runId);
    const controller = await reopen(runId);
    await controller.reconcileDeliveries();

    const dispatched: string[] = [];
    await expect(
      controller.reconcileDeliveries({
        dispatch: (message) => {
          dispatched.push(message.details.deliveryIds[0]!);
          throw new Error("crash after synchronous Pi dispatch");
        },
      }),
    ).rejects.toThrow("crash after synchronous Pi dispatch");
    expect(dispatched).toHaveLength(1);
    expect((await controller.getProjection(runId))?.deliveries[0]?.state).toBe(
      "pending",
    );

    await controller.reconcileDeliveries({
      dispatch: (message) => {
        dispatched.push(message.details.deliveryIds[0]!);
      },
    });
    expect(dispatched).toHaveLength(2);
    expect(
      (await controller.getProjection(runId))?.deliveries[0],
    ).toMatchObject({
      state: "delivered",
      deliveredBy: "pi-send-message",
    });

    await controller.reconcileDeliveries({
      dispatch: () => {
        throw new Error("receipt must prevent repeat delivery");
      },
    });
    expect(dispatched).toHaveLength(2);
    await controller.release();
  });

  it("reconciles an existing Pi custom entry before attempting another dispatch", async () => {
    const runId = createDurableWorkflowRunId("pi-entry-receipt");
    await seedTerminalWithoutIntent(runId);
    const controller = await reopen(runId);
    await controller.reconcileDeliveries();
    const deliveryId = (await controller.getProjection(runId))!.deliveries[0]!
      .deliveryId;
    const dispatch = vi.fn(() => {
      throw new Error("existing Pi entry must suppress dispatch");
    });

    await controller.reconcileDeliveries({
      existingEntries: () => [
        { type: "custom", details: { deliveryIds: [deliveryId] } },
      ],
      dispatch,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(
      (await controller.getProjection(runId))?.deliveries[0],
    ).toMatchObject({
      state: "delivered",
      deliveredBy: "pi-session-entry",
    });
    await controller.release();
  });
});
