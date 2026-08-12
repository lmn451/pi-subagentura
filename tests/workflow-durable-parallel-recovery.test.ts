import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "../src/workflow-plan";
import {
  InMemoryWorkflowProjectionRepository,
  type WorkflowProjectionRepository,
} from "../src/workflow-projection-repository";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  type DurableWorkflowOwner,
} from "../src/workflow-run-types";

function success(
  output: string,
  input: number,
  outputTokens: number,
): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function threeTaskParallelPlan(): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "parallel-recovery",
    description: "definition-ordered durable parallel recovery",
    phases: [
      {
        id: "parallel",
        name: "Parallel",
        mode: "parallel",
        tasks: [
          { id: "task-a", content: "Task A", instruction: "run-a" },
          { id: "task-b", content: "Task B", instruction: "run-b" },
          { id: "task-c", content: "Task C", instruction: "run-c" },
        ],
      },
    ],
  });
}

describe("durable parallel recovery", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let processNumber: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-durable-parallel-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-session-parallel");
    processNumber = 400;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(): WorkflowRunStore {
    processNumber++;
    return new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: processNumber,
        processStartIdentity: `process-${processNumber}`,
      },
    });
  }

  async function controller(
    runStore: WorkflowRunStore,
    runner: WorkflowAgentRunner,
    generation: number,
    repository?: WorkflowProjectionRepository,
  ): Promise<DurableWorkflowPlanController> {
    return DurableWorkflowPlanController.acquire({
      store: runStore,
      owner,
      scopeId: generation,
      generation,
      repository,
      runAgentForRun: () => runner,
    });
  }

  it("replays committed A, retries interrupted B, and dispatches pending C exactly once", async () => {
    const runId = createDurableWorkflowRunId("parallel-crash-reload");
    const backingRepository = new InMemoryWorkflowProjectionRepository();
    let markTaskBStarted!: () => void;
    const taskBStarted = new Promise<void>((resolve) => {
      markTaskBStarted = resolve;
    });
    let markTaskACommitted!: () => void;
    const taskACommitted = new Promise<void>((resolve) => {
      markTaskACommitted = resolve;
    });
    let releaseTaskADelivery!: () => void;
    const taskADeliveryReleased = new Promise<void>((resolve) => {
      releaseTaskADelivery = resolve;
    });
    let taskADeliveryBlocked = false;
    const blockingRepository: WorkflowProjectionRepository = {
      get: (nextOwner, nextRunId) =>
        backingRepository.get(nextOwner, nextRunId),
      list: (nextOwner) => backingRepository.list(nextOwner),
      replace: async (nextOwner, projection) => {
        await backingRepository.replace(nextOwner, projection);
        const operationA = projection.operations.find(
          (operation) => operation.identity.operationId === "task-a",
        );
        const operationB = projection.operations.find(
          (operation) => operation.identity.operationId === "task-b",
        );
        if (
          !taskADeliveryBlocked &&
          operationA !== undefined &&
          operationA.responses.length > 0 &&
          operationB?.attempts.at(-1)?.status === "started"
        ) {
          taskADeliveryBlocked = true;
          markTaskACommitted();
          await taskADeliveryReleased;
        }
      },
      replaceAll: (nextOwner, projections) =>
        backingRepository.replaceAll(nextOwner, projections),
      remove: (nextOwner, nextRunId) =>
        backingRepository.remove(nextOwner, nextRunId),
    };
    const firstCalls: string[] = [];
    const firstStore = store();
    const first = await controller(
      firstStore,
      async ({ prompt, signal }) => {
        firstCalls.push(prompt);
        if (prompt === "run-a") {
          await taskBStarted;
          return success("committed-a", 5, 3);
        }
        if (prompt === "run-b") {
          markTaskBStarted();
          return new Promise<SubagentResult>((resolve) => {
            const interrupted = () =>
              resolve({ ...success("interrupted-b", 0, 0), cancelled: true });
            if (signal?.aborted) interrupted();
            else signal?.addEventListener("abort", interrupted, { once: true });
          });
        }
        throw new Error("Task C must remain undispatched before reload.");
      },
      1,
      blockingRepository,
    );

    const initial = await first.startPlan({
      runId,
      plan: threeTaskParallelPlan(),
      concurrency: 2,
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await taskACommitted;
    expect(firstCalls).toEqual(["run-a", "run-b"]);
    const beforeReload = await first.getProjection(runId);
    expect(beforeReload).toMatchObject({
      operations: [
        { identity: { operationId: "task-a" }, settlement: {} },
        {
          identity: { operationId: "task-b" },
          attempts: [{ status: "started" }],
        },
      ],
    });
    expect(beforeReload?.operations[1]?.settlement).toBeUndefined();

    const interruption = first.interrupt("reload", runId);
    releaseTaskADelivery();
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;
    expect(firstCalls).toEqual(["run-a", "run-b"]);
    await first.release();

    const resumedCalls: string[] = [];
    const secondStore = store();
    const second = await controller(
      secondStore,
      async ({ prompt }) => {
        resumedCalls.push(prompt);
        return prompt === "run-b"
          ? success("retried-b", 2, 1)
          : success("started-c", 11, 6);
      },
      2,
    );
    const reopened = await second.open("reload");
    expect(reopened.completions).toHaveLength(1);
    const result = await reopened.completions[0]?.completion;

    expect(resumedCalls).toEqual(["run-b", "run-c"]);
    expect(result).toMatchObject({
      status: "done",
      agentsSpawned: 2,
      usage: { input: 18, output: 10 },
      result: [
        { id: "task-a", output: "committed-a" },
        { id: "task-b", output: "retried-b" },
        { id: "task-c", output: "started-c" },
      ],
    });

    const projection = await second.getProjection(runId);
    expect(projection).toMatchObject({
      status: "done",
      accounting: {
        completeness: "lower_bound",
        reason: "ambiguous_dispatch",
        usage: { input: 18, output: 10 },
      },
    });
    const terminalAccounting = (
      await (await secondStore.openRun(owner, runId)).readEvents()
    ).flatMap((event) =>
      event.type === "run_result_recorded" || event.type === "run_terminal"
        ? [event.payload.accounting.completeness]
        : [],
    );
    expect(terminalAccounting).toEqual(["lower_bound", "lower_bound"]);
    const operationA = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-a",
    );
    const operationB = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-b",
    );
    const operationC = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-c",
    );
    expect(operationA).toMatchObject({
      request: { dispatchOrdinal: 1 },
      attempts: [
        {
          status: "settled",
          accounting: {
            completeness: "exact",
            usage: { input: 5, output: 3 },
          },
        },
      ],
      replays: [{}],
    });
    expect(operationB).toMatchObject({
      request: { dispatchOrdinal: 2 },
      attempts: [
        {
          status: "interrupted",
          usageObserved: { input: 0, output: 0 },
          attempt: { attemptNumber: 1 },
        },
        {
          status: "settled",
          accounting: {
            completeness: "lower_bound",
            reason: "ambiguous_dispatch",
            usage: { input: 2, output: 1 },
          },
          attempt: { attemptNumber: 2 },
        },
      ],
    });
    expect(operationB?.attempts[0]?.accounting).toBeUndefined();
    expect(operationC).toMatchObject({
      request: { dispatchOrdinal: 3 },
      attempts: [
        {
          status: "settled",
          accounting: {
            completeness: "exact",
            usage: { input: 11, output: 6 },
          },
          attempt: { attemptNumber: 1 },
        },
      ],
    });
    expect(await second.getResult(runId)).toMatchObject({
      result: [{ id: "task-a" }, { id: "task-b" }, { id: "task-c" }],
      usage: { input: 18, output: 10 },
    });
    await second.release();
  });
});
