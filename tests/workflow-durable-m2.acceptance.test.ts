import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { WorkflowExecutionError } from "../src/workflow-core";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
} from "../src/workflow-durable-plan-runner";
import {
  DurableWorkflowProjectionRepository,
  type WorkflowTaskClaim,
} from "../src/workflow-projection-repository";
import type { WorkflowPlan } from "../src/workflow-plan";
import {
  WorkflowRunCorruptionError,
  WorkflowRunStore,
  workflowRunPath,
} from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import { registerWorkflowTool } from "../src/workflow-tool";

const roots: string[] = [];
const stores: WorkflowRunStore[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "m2-project",
  cwd: "/m2/repo",
  piSessionId: "m2-session",
  ownerId: "m2-owner",
  ownerGeneration: 7,
  leaseToken: "m2-lease",
};
const oneTaskPlan: WorkflowPlan = {
  schemaVersion: 1,
  name: "one-task",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task-a", prompt: "A", isolation: "in-process" }],
    },
  ],
};

function success(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.25,
      turns: 1,
    },
    model: "test/model",
  };
}

function failure(message: string): SubagentResult {
  return {
    isError: true,
    output: "",
    usage: {
      input: 3,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.25,
      turns: 1,
    },
    errorMessage: message,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workflow-m2-acceptance-"));
  roots.push(root);
  return root;
}

function storeAt(rootDir: string, runOwner = owner): WorkflowRunStore {
  const store = new WorkflowRunStore({ rootDir, owner: runOwner });
  stores.push(store);
  return store;
}

async function seedRun(
  rootDir: string,
  runId: string,
  plan: WorkflowPlan = oneTaskPlan,
): Promise<{ store: WorkflowRunStore; runEpoch: number }> {
  const store = storeAt(rootDir);
  const runEpoch = await store.getLeaseEpoch();
  await store.createRunWithInitialEvent(
    {
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    },
    {
      type: "run_created",
      payload: { plan },
      runEpoch,
    },
  );
  await store.append(runId, "run_started", {}, runEpoch);
  return { store, runEpoch };
}

function claimFor(
  runId: string,
  runEpoch: number,
  attempt: number,
): WorkflowTaskClaim {
  return {
    runId,
    taskId: "task-a",
    operationId: "task-a",
    attempt,
    runEpoch,
    ownerId: owner.ownerId,
    ownerGeneration: owner.ownerGeneration,
    leaseEpoch: runEpoch,
    token: `claim-${attempt}`,
  };
}

async function prepareOperation(
  store: WorkflowRunStore,
  runId: string,
  runEpoch: number,
): Promise<void> {
  await store.append(
    runId,
    "operation_prepared",
    {
      taskId: "task-a",
      phaseId: "phase",
      operationId: "task-a",
      requestDigest: "fixed-request-digest",
    },
    runEpoch,
  );
}

async function startAttempt(
  store: WorkflowRunStore,
  runId: string,
  runEpoch: number,
  attempt = 1,
): Promise<WorkflowTaskClaim> {
  const claim = claimFor(runId, runEpoch, attempt);
  await store.append(
    runId,
    "attempt_started",
    {
      taskId: "task-a",
      phaseId: "phase",
      operationId: "task-a",
      attempt,
      claim,
    },
    runEpoch,
  );
  return claim;
}

async function persistSuccessfulAttempt(
  store: WorkflowRunStore,
  runId: string,
  runEpoch: number,
  claim: WorkflowTaskClaim,
  result = "persisted",
) {
  const outcomeRef = await store.writeOutcomeBlob(runId, {
    status: "succeeded",
    result,
  });
  const receipt = await store.append(
    runId,
    "attempt_settled",
    {
      taskId: "task-a",
      operationId: "task-a",
      attempt: claim.attempt,
      claim,
      outcomeRef,
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        cost: "0.25",
        turns: 1,
      },
    },
    runEpoch,
  );
  return { outcomeRef, receipt };
}

async function trustedResume(
  controller: DurableWorkflowController,
  store: WorkflowRunStore,
  runId: string,
  runAgent: (input: { prompt: string }) => Promise<SubagentResult>,
) {
  const projection = await controller.getStatus(runId);
  if (!projection) throw new Error(`Missing seeded run ${runId}`);
  return controller.resume(runId, {
    expectedRevision: projection.revision,
    expectedRunEpoch: projection.runEpoch,
    ownerGeneration: owner.ownerGeneration,
    leaseEpoch: await store.getLeaseEpoch(),
    runAgent,
  });
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.release();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Milestone 2 durable creation boundaries", () => {
  it("ignores launch bytes without run_created and never dispatches from them", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const runId = "launch-only";
    const publishedPath = workflowRunPath(root, owner, runId);
    const stagingPath = join(
      dirname(publishedPath),
      ".creating-launch-only-00000000-0000-4000-8000-000000000000",
    );
    await mkdir(stagingPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(stagingPath, "launch.json"),
      `${JSON.stringify({ runId, owner })}\n`,
      { mode: 0o600 },
    );
    const runAgent = vi.fn(async () => success("created safely"));

    await expect(store.listRunIds()).resolves.toEqual([]);
    await expect(store.readRun(runId)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runAgent).not.toHaveBeenCalled();

    const controller = new DurableWorkflowController({ store, owner });
    const started = await controller.create({
      runId,
      plan: oneTaskPlan,
      runAgent,
    });
    expect(started.projection).toMatchObject({
      status: "created",
      lastEventOrdinal: 0,
    });
    await expect(started.completion).resolves.toMatchObject({ status: "done" });
    expect(runAgent).toHaveBeenCalledTimes(1);
    await expect(store.listRunIds()).resolves.toEqual([runId]);
  });

  it("acknowledges a committed run when authority is revoked immediately afterward", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const createRun = store.createRunWithInitialEvent.bind(store);
    const createSpy = vi
      .spyOn(store, "createRunWithInitialEvent")
      .mockImplementation(async (...args) => {
        const receipt = await createRun(...args);
        await store.revoke();
        return receipt;
      });
    const runAgent = vi.fn(async () => success("must not dispatch"));
    const controller = new DurableWorkflowController({ store, owner });

    const started = await controller.create({
      runId: "committed-before-revoke",
      plan: oneTaskPlan,
      runAgent,
    });

    expect(started.projection).toMatchObject({
      runId: "committed-before-revoke",
      status: "created",
      revision: 1,
      runEpoch: 1,
      lastEventOrdinal: 0,
    });
    await expect(started.completion).rejects.toThrow(/revoked/i);
    expect(runAgent).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it("fsyncs run_created and run_started before the first runner call", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const prefixes: string[][] = [];
    const controller = new DurableWorkflowController({ store, owner });
    const started = await controller.create({
      runId: "create-order",
      plan: oneTaskPlan,
      runAgent: async () => {
        const record = await store.readRun("create-order");
        prefixes.push(record.events.map((event) => event.type));
        return success("ordered");
      },
    });

    expect(started.projection).toMatchObject({
      status: "created",
      lastEventOrdinal: 0,
    });
    const completed = await started.completion;
    expect(completed.status).toBe("done");
    expect(prefixes).toEqual([
      ["run_created", "run_started", "operation_prepared", "attempt_started"],
    ]);
  });

  it("ignores and truncates an incomplete final NDJSON line", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const runEpoch = await store.getLeaseEpoch();
    await store.createRunWithInitialEvent(
      {
        runId: "torn-tail",
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      },
      {
        type: "run_created",
        payload: { plan: oneTaskPlan },
        runEpoch,
      },
    );
    await appendFile(
      join(workflowRunPath(root, owner, "torn-tail"), "events.ndjson"),
      '{"schemaVersion":1,"type":"run_started"',
    );
    const repository = new DurableWorkflowProjectionRepository(store, owner);

    await expect(repository.get("torn-tail")).resolves.toMatchObject({
      status: "interrupted",
      lastEventOrdinal: 0,
    });
    await store.append("torn-tail", "run_started", {}, runEpoch);
    await expect(store.readEventLog("torn-tail")).resolves.toMatchObject({
      tornTailBytes: 0,
      events: [{ type: "run_created" }, { type: "run_started" }],
    });
  });

  it.each([
    {
      name: "duplicate IDs",
      plan: {
        ...oneTaskPlan,
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [
              { id: "phase", prompt: "duplicate", isolation: "in-process" },
            ],
          },
        ],
      },
    },
    {
      name: "process isolation",
      plan: {
        ...oneTaskPlan,
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [{ id: "task-a", prompt: "process", isolation: "process" }],
          },
        ],
      },
    },
  ])(
    "rejects $name before creating a run or calling a runner",
    async ({ plan }) => {
      const root = await tempRoot();
      const store = storeAt(root);
      const runAgent = vi.fn(async () => success("must not run"));

      await expect(
        runDurableWorkflowPlan({
          store,
          owner,
          runId: "invalid-plan",
          plan: plan as unknown as WorkflowPlan,
          runAgent,
        }),
      ).rejects.toThrow();
      expect(runAgent).not.toHaveBeenCalled();
      await expect(store.listRunIds()).resolves.toEqual([]);
    },
  );

  it("rejects invalid, process, and conflicting public inputs with zero storage or dispatch", async () => {
    const root = await tempRoot();
    const previousRoot = process.env.PI_SUBAGENTURA_WORKFLOW_RUNS_DIR;
    process.env.PI_SUBAGENTURA_WORKFLOW_RUNS_DIR = root;
    try {
      const tools: Array<{ name: string; execute: Function }> = [];
      const pi = {
        registerTool: vi.fn((definition: { name: string; execute: Function }) =>
          tools.push(definition),
        ),
        registerFlag: vi.fn(),
        registerCommand: vi.fn(),
        on: vi.fn(),
      };
      registerWorkflowTool(
        pi as unknown as Parameters<typeof registerWorkflowTool>[0],
      );
      const execute = tools.find((tool) => tool.name === "workflow")!.execute;
      const dispatchTrap = new Proxy(
        {},
        {
          get() {
            throw new Error("runner or child dispatch attempted");
          },
        },
      );
      const script =
        'export const meta = { name: "conflict", description: "d" };\nreturn 1;';
      const processPlan = {
        ...oneTaskPlan,
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [{ id: "task-a", prompt: "process", isolation: "process" }],
          },
        ],
      };
      const invalidPlan = {
        ...oneTaskPlan,
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [
              { id: "phase", prompt: "duplicate", isolation: "in-process" },
            ],
          },
        ],
      };

      for (const params of [
        { script, plan: oneTaskPlan, durable: true, async: true },
        { plan: processPlan, durable: true, async: true },
        { plan: invalidPlan, durable: true, async: true },
      ]) {
        const result = await execute(
          "",
          params,
          undefined,
          undefined,
          dispatchTrap,
        );
        expect(result.isError).toBe(true);
        const diagnostic = [
          result.details?.error,
          ...result.content.map((item: { text?: unknown }) => item.text),
          JSON.stringify(result.details),
        ]
          .filter((value): value is string => typeof value === "string")
          .join("\n");
        expect(diagnostic).not.toContain("runner or child dispatch attempted");
      }
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.PI_SUBAGENTURA_WORKFLOW_RUNS_DIR;
      } else {
        process.env.PI_SUBAGENTURA_WORKFLOW_RUNS_DIR = previousRoot;
      }
    }
  });
});

describe("Milestone 2 durable recovery fences", () => {
  it("requires trusted resume for a prepared operation", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "prepared");
    await prepareOperation(store, "prepared", runEpoch);
    const controller = new DurableWorkflowController({ store, owner });
    const runAgent = vi.fn(async () => success("resumed"));

    await expect(controller.getStatus("prepared")).resolves.toMatchObject({
      status: "interrupted",
      tasks: { "task-a": { status: "interrupted", attempt: 0 } },
    });
    expect(runAgent).not.toHaveBeenCalled();

    await expect(
      trustedResume(controller, store, "prepared", runAgent),
    ).resolves.toMatchObject({
      status: "done",
      tasks: { "task-a": { status: "succeeded", attempt: 1 } },
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("ignores stale owner, epoch, revision, and claim settlement", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "fenced");
    await prepareOperation(store, "fenced", runEpoch);
    const claim = await startAttempt(store, "fenced", runEpoch);
    const controller = new DurableWorkflowController({ store, owner });
    const before = await controller.getStatus("fenced");
    if (!before) throw new Error("Missing fenced run");
    const runAgent = vi.fn(async () => success("must not run"));
    const baseRequest = {
      expectedRevision: before.revision,
      expectedRunEpoch: before.runEpoch,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch: await store.getLeaseEpoch(),
      runAgent,
    };

    await expect(
      controller.resume("fenced", {
        ...baseRequest,
        expectedRevision: before.revision - 1,
      }),
    ).rejects.toThrow(/revision.*stale/i);
    await expect(
      controller.resume("fenced", {
        ...baseRequest,
        expectedRunEpoch: before.runEpoch - 1,
      }),
    ).rejects.toThrow(/epoch.*stale/i);
    await expect(
      controller.resume("fenced", {
        ...baseRequest,
        ownerGeneration: owner.ownerGeneration + 1,
      }),
    ).rejects.toThrow(/owner generation.*stale/i);
    await expect(
      controller.resume("fenced", {
        ...baseRequest,
        leaseEpoch: baseRequest.leaseEpoch + 1,
      }),
    ).rejects.toThrow(/lease epoch.*stale/i);
    expect(runAgent).not.toHaveBeenCalled();
    expect((await store.readRun("fenced")).events).toHaveLength(
      before.lastEventOrdinal + 1,
    );

    await expect(
      store.append("fenced", "attempt_settled", {}, runEpoch - 1),
    ).rejects.toThrow(/stale.*epoch/i);
    await expect(
      store.appendIfCurrent(
        "fenced",
        before.lastEventOrdinal - 1,
        "attempt_settled",
        {},
        runEpoch,
      ),
    ).resolves.toMatchObject({ status: "conflict" });

    const wrongOwner = { ...owner, ownerId: "other-owner" };
    const wrongOwnerStore = storeAt(root, wrongOwner);
    await expect(
      wrongOwnerStore.append("fenced", "attempt_settled", {}, runEpoch),
    ).rejects.toThrow(/owner|lease/i);
    expect((await store.readRun("fenced")).events).toHaveLength(
      before.lastEventOrdinal + 1,
    );

    const forgedOutcome = await store.writeOutcomeBlob("fenced", {
      status: "succeeded",
      result: "forged",
    });
    await store.append(
      "fenced",
      "attempt_settled",
      {
        taskId: "task-a",
        operationId: "task-a",
        attempt: 1,
        claim: { ...claim, token: "stale-claim" },
        outcomeRef: forgedOutcome,
        usage: {
          input: 3,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: "0.25",
          turns: 1,
        },
      },
      runEpoch,
    );
    await expect(controller.getStatus("fenced")).resolves.toMatchObject({
      status: "interrupted",
      tasks: { "task-a": { status: "interrupted", attempt: 1 } },
      usage: { totalTokens: 0, costUsd: 0, turns: 0 },
    });
  });

  it("treats an orphan fsynced outcome blob as non-authoritative", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "orphan-outcome");
    await prepareOperation(store, "orphan-outcome", runEpoch);
    await startAttempt(store, "orphan-outcome", runEpoch);
    const orphan = await store.writeOutcomeBlob("orphan-outcome", {
      status: "succeeded",
      result: "must not replay",
    });
    const controller = new DurableWorkflowController({ store, owner });
    const runAgent = vi.fn(async () => success("retried"));

    await expect(controller.getStatus("orphan-outcome")).resolves.toMatchObject(
      {
        status: "interrupted",
        tasks: { "task-a": { status: "interrupted", attempt: 1 } },
        usageLowerBound: true,
        usage: { totalTokens: 0 },
      },
    );
    await expect(
      trustedResume(controller, store, "orphan-outcome", runAgent),
    ).resolves.toMatchObject({
      status: "done",
      tasks: { "task-a": { status: "succeeded", attempt: 2 } },
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 6,
        costUsd: 0.25,
        turns: 1,
      },
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    const record = await store.readRun("orphan-outcome");
    const settlements = record.events.filter(
      (event) => event.type === "attempt_settled",
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.payload).not.toMatchObject({
      outcomeRef: { digest: orphan.digest },
    });
  });

  it("fails closed when a referenced outcome blob no longer matches its digest", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "corrupt-outcome");
    await prepareOperation(store, "corrupt-outcome", runEpoch);
    const claim = await startAttempt(store, "corrupt-outcome", runEpoch);
    const { outcomeRef } = await persistSuccessfulAttempt(
      store,
      "corrupt-outcome",
      runEpoch,
      claim,
    );
    await writeFile(
      join(
        workflowRunPath(root, owner, "corrupt-outcome"),
        "outputs",
        `${outcomeRef.digest}.json`,
      ),
      '{\"status\":\"succeeded\",\"result\":\"tampered\"}\n',
    );
    const controller = new DurableWorkflowController({ store, owner });

    await expect(
      controller.getStatus("corrupt-outcome"),
    ).rejects.toBeInstanceOf(WorkflowRunCorruptionError);
  });

  it("reconciles attempt_settled without redispatching or double-accounting", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "attempt-settled");
    await prepareOperation(store, "attempt-settled", runEpoch);
    const claim = await startAttempt(store, "attempt-settled", runEpoch);
    await persistSuccessfulAttempt(
      store,
      "attempt-settled",
      runEpoch,
      claim,
      "committed outcome",
    );
    const controller = new DurableWorkflowController({ store, owner });
    const runAgent = vi.fn(async () => success("must not run"));

    await expect(
      controller.getStatus("attempt-settled"),
    ).resolves.toMatchObject({
      status: "interrupted",
      operations: {
        "task-a": { status: "attempt_settled", attempt: 1 },
      },
      usage: { totalTokens: 0, costUsd: 0, turns: 0 },
    });
    const completed = await trustedResume(
      controller,
      store,
      "attempt-settled",
      runAgent,
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: "done",
      tasks: { "task-a": { status: "succeeded", attempt: 1 } },
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 6,
        costUsd: 0.25,
        turns: 1,
      },
    });
  });

  it("replays operation_settled after executor acknowledgement loss", async () => {
    const root = await tempRoot();
    const { store, runEpoch } = await seedRun(root, "operation-settled");
    await prepareOperation(store, "operation-settled", runEpoch);
    const claim = await startAttempt(store, "operation-settled", runEpoch);
    const { receipt } = await persistSuccessfulAttempt(
      store,
      "operation-settled",
      runEpoch,
      claim,
      "committed once",
    );
    await store.append(
      "operation-settled",
      "operation_settled",
      {
        taskId: "task-a",
        operationId: "task-a",
        attempt: 1,
        claim,
        attemptSettlementEventId: receipt.eventId,
      },
      runEpoch,
    );
    const controller = new DurableWorkflowController({ store, owner });
    const runAgent = vi.fn(async () => success("must not run"));

    await expect(
      controller.getStatus("operation-settled"),
    ).resolves.toMatchObject({
      status: "interrupted",
      tasks: { "task-a": { status: "succeeded", attempt: 1 } },
      usage: { totalTokens: 6, costUsd: 0.25, turns: 1 },
    });
    const completed = await trustedResume(
      controller,
      store,
      "operation-settled",
      runAgent,
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: "done",
      tasks: { "task-a": { status: "succeeded", attempt: 1 } },
      usage: { totalTokens: 6, costUsd: 0.25, turns: 1 },
    });
    expect(completed).not.toHaveProperty("delivery");
    const record = await store.readRun("operation-settled");
    expect(
      record.events.some((event) => event.type.startsWith("delivery_")),
    ).toBe(false);
  });

  it("persists cancellation once without an outbox claim", async () => {
    const root = await tempRoot();
    const { store } = await seedRun(root, "cancelled");
    const controller = new DurableWorkflowController({ store, owner });

    const first = await controller.cancel("cancelled", "cancel-request");
    const replay = await controller.cancel("cancelled", "different-request");
    expect(first).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
    });
    expect(replay).toEqual(first);
    expect(replay).not.toHaveProperty("delivery");
    const record = await store.readRun("cancelled");
    expect(
      record.events.filter((event) => event.type === "run_cancel_requested"),
    ).toHaveLength(1);
    expect(
      record.events.filter((event) => event.type === "run_cancelled"),
    ).toHaveLength(1);
    expect(
      record.events.some((event) => event.type.startsWith("delivery_")),
    ).toBe(false);
  });

  it("drains an active cancellation into an explicit lower-bound interruption before terminalizing", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const controller = new DurableWorkflowController({ store, owner });
    const abort = new AbortController();
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      markDispatched = resolve;
    });
    const started = await controller.create({
      runId: "cancel-active-lower-bound",
      plan: oneTaskPlan,
      runAgent: ({ signal }) =>
        new Promise<SubagentResult>((_resolve, reject) => {
          markDispatched();
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                new WorkflowExecutionError("cancelled while active", {
                  input: 2,
                  output: 3,
                  cacheRead: 1,
                  cacheWrite: 0,
                  totalTokens: 6,
                  costUsd: 0.25,
                  turns: 1,
                  costSource: "provider",
                }),
              ),
            { once: true },
          );
        }),
      signal: abort.signal,
    });
    await dispatched;

    const cancelled = await controller.cancel(
      "cancel-active-lower-bound",
      "cancel-active",
      async () => {
        abort.abort();
        await started.completion;
      },
    );

    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
      tasks: { "task-a": { status: "interrupted", attempt: 1 } },
      operations: {
        "task-a": {
          status: "interrupted",
          attempts: { 1: { usageProvenance: "lower_bound" } },
        },
      },
      usage: { totalTokens: 6, costUsd: 0.25, turns: 1 },
      usageLowerBound: true,
    });
    expect(
      Object.values(cancelled?.tasks ?? {}).some(
        (task) => task.status === "running",
      ),
    ).toBe(false);
    const events = (await store.readRun("cancel-active-lower-bound")).events;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run_cancel_requested",
        "attempt_interrupted",
        "run_cancelled",
      ]),
    );
    expect(
      events.findIndex((event) => event.type === "run_cancel_requested"),
    ).toBeLessThan(
      events.findIndex((event) => event.type === "attempt_interrupted"),
    );
    expect(
      events.findIndex((event) => event.type === "attempt_interrupted"),
    ).toBeLessThan(events.findIndex((event) => event.type === "run_cancelled"));
  });

  it("reconciles an exact outcome committed before operation settlement and then cancels", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const controller = new DurableWorkflowController({ store, owner });
    const originalAppend = store.appendIfCurrent.bind(store);
    let markSettlementReached!: () => void;
    let allowSettlement!: () => void;
    const settlementReached = new Promise<void>((resolve) => {
      markSettlementReached = resolve;
    });
    const settlementGate = new Promise<void>((resolve) => {
      allowSettlement = resolve;
    });
    const appendSpy = vi
      .spyOn(store, "appendIfCurrent")
      .mockImplementation(async (...args) => {
        if (args[2] === "operation_settled") {
          markSettlementReached();
          await settlementGate;
        }
        return originalAppend(...args);
      });
    const started = await controller.create({
      runId: "cancel-after-outcome",
      plan: oneTaskPlan,
      runAgent: async () => success("committed before cancellation"),
    });
    await settlementReached;

    const cancelled = await controller.cancel(
      "cancel-after-outcome",
      "cancel-after-outcome-request",
      async () => {
        allowSettlement();
        await started.completion;
      },
    );
    appendSpy.mockRestore();

    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
      tasks: { "task-a": { status: "succeeded", attempt: 1 } },
      operations: {
        "task-a": {
          status: "settled",
          attempts: { 1: { usageProvenance: "exact" } },
        },
      },
      usage: { totalTokens: 6, costUsd: 0.25, turns: 1 },
    });
    expect(cancelled).not.toHaveProperty("usageLowerBound");
    expect(
      Object.values(cancelled?.tasks ?? {}).some(
        (task) => task.status === "running",
      ),
    ).toBe(false);
    const events = (await store.readRun("cancel-after-outcome")).events;
    const requestedIndex = events.findIndex(
      (event) => event.type === "run_cancel_requested",
    );
    const settledIndex = events.findIndex(
      (event) => event.type === "operation_settled",
    );
    const cancelledIndex = events.findIndex(
      (event) => event.type === "run_cancelled",
    );
    expect(requestedIndex).toBeLessThan(settledIndex);
    expect(settledIndex).toBeLessThan(cancelledIndex);
  });

  it("commits task failure and never dispatches its successor", async () => {
    const root = await tempRoot();
    const store = storeAt(root);
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "stop-on-failure",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            { id: "task-a", prompt: "A", isolation: "in-process" },
            { id: "task-b", prompt: "B", isolation: "in-process" },
          ],
        },
      ],
    };
    const calls: string[] = [];

    const completed = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "failed",
      plan,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return failure("provider failed");
      },
    });

    expect(calls).toEqual(["A"]);
    expect(completed).toMatchObject({
      status: "error",
      terminal: {
        status: "error",
        error: { code: "task_failed", message: "provider failed" },
      },
      tasks: {
        "task-a": { status: "failed", attempt: 1 },
        "task-b": { status: "pending", attempt: 0 },
      },
      usage: { totalTokens: 6, costUsd: 0.25, turns: 1 },
    });
  });
});
