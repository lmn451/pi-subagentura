import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import { validateWorkflowPlan } from "../src/workflow-plan";
import {
  deriveDurableWorkflowOwner,
  WorkflowRunStore,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  type DurableWorkflowOwner,
} from "../src/workflow-run-types";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

describe("DurableWorkflowPlanController future mutation fence", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-plan-mutation-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "session-a");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects stale/foreign fences atomically, preserves running history, audits skip, and wakes once per append/unblock", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: { pid: 7101, processStartIdentity: "mutation-test" },
    });
    let signalRunnerStarted: () => void = () => {};
    const runnerStarted = new Promise<void>((resolve) => {
      signalRunnerStarted = resolve;
    });
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      signalRunnerStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        isError: false,
        output: "",
        cancelled: true,
        usage,
      } satisfies SubagentResult;
    };
    const wake = vi.fn();
    const controller = await DurableWorkflowPlanController.acquire({
      store,
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun: () => runner,
      onPlanMutationWake: wake,
    });
    const runId = createDurableWorkflowRunId("fenced-mutation");
    const execution = await controller.startPlan({
      runId,
      plan: validateWorkflowPlan({
        name: "mutation",
        description: "fenced",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [
              { id: "task-a", content: "Task A", instruction: "run a" },
              { id: "task-b", content: "Task B", instruction: "run b" },
            ],
          },
        ],
      }),
    });
    await runnerStarted;
    const base = await controller.getPlanView(runId);
    const eventCount = (await (await store.openRun(owner, runId)).readEvents())
      .length;

    await expect(
      controller.mutatePlan(runId, {
        expectedOwner: { ...owner, piSessionKey: "foreign" },
        expectedRunEpoch: base.runEpoch,
        baseRevision: base.revision,
        actor: { kind: "model", id: "workflow-plan-tool" },
        mutation: { operation: "skip", taskId: "task-b", reason: "foreign" },
      }),
    ).rejects.toMatchObject({ code: "wrong_owner" });
    await expect(
      controller.mutatePlan(runId, {
        expectedOwner: owner,
        expectedRunEpoch: base.runEpoch + 1,
        baseRevision: base.revision,
        actor: { kind: "model", id: "workflow-plan-tool" },
        mutation: {
          operation: "skip",
          taskId: "task-b",
          reason: "stale epoch",
        },
      }),
    ).rejects.toMatchObject({ code: "epoch_mismatch" });
    expect(
      (await (await store.openRun(owner, runId)).readEvents()).length,
    ).toBe(eventCount);

    await expect(
      controller.mutatePlan(runId, {
        expectedOwner: owner,
        expectedRunEpoch: base.runEpoch,
        baseRevision: base.revision,
        actor: { kind: "human", id: "workflow-plan-command" },
        mutation: { operation: "skip", taskId: "task-a", reason: "immutable" },
      }),
    ).rejects.toMatchObject({ code: "immutable_task" });

    const blocked = await controller.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: base.runEpoch,
      baseRevision: base.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: { operation: "block", taskId: "task-b", reason: "dependency" },
    });
    expect(wake).toHaveBeenCalledTimes(0);
    const unblocked = await controller.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: blocked.runEpoch,
      baseRevision: blocked.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: { operation: "unblock", taskId: "task-b" },
    });
    expect(wake).toHaveBeenCalledTimes(1);
    const appended = await controller.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: unblocked.runEpoch,
      baseRevision: unblocked.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: {
        operation: "append",
        phaseId: "phase-a",
        task: { id: "task-c", content: "Task C", instruction: "run c" },
      },
    });
    expect(wake).toHaveBeenCalledTimes(2);
    const skipped = await controller.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: appended.runEpoch,
      baseRevision: appended.revision,
      actor: { kind: "human", id: "workflow-plan-command" },
      mutation: { operation: "skip", taskId: "task-b", reason: "removed" },
    });
    expect(
      skipped.phases[0]?.tasks.find((task) => task.id === "task-b"),
    ).toMatchObject({
      status: "skipped",
    });

    const beforeStale = await (await store.openRun(owner, runId)).readEvents();
    await expect(
      controller.mutatePlan(runId, {
        expectedOwner: owner,
        expectedRunEpoch: base.runEpoch,
        baseRevision: base.revision,
        actor: { kind: "model", id: "workflow-plan-tool" },
        mutation: {
          operation: "append",
          phaseId: "phase-a",
          task: { id: "stale", content: "Stale", instruction: "stale" },
        },
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    const afterStale = await (await store.openRun(owner, runId)).readEvents();
    expect(afterStale).toHaveLength(beforeStale.length);
    const revisions = afterStale.filter(
      (event) => event.type === "plan_revised",
    );
    expect(revisions).toHaveLength(4);
    expect(revisions.at(-1)?.payload.audit).toMatchObject({
      operation: "skip",
      transitions: [
        { taskId: "task-b", from: "pending", to: "skipped", reason: "removed" },
      ],
    });

    await controller.interrupt("quit");
    await execution.completion.catch(() => undefined);
    await controller.release();
  });
  it("rejects plan revision while a trusted approval fence is pending", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: 7104,
        processStartIdentity: "mutation-approval-test",
      },
    });
    const controller = await DurableWorkflowPlanController.acquire({
      store,
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ signal }) => {
          markStarted();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else {
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
          return { isError: false, output: "", cancelled: true, usage };
        },
    });
    const execution = await controller.startPlan({
      plan: validateWorkflowPlan({
        name: "approval-fenced-mutation",
        description: "pending approval is revision immutable",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [
              { id: "task-a", content: "Task A", instruction: "run a" },
              { id: "task-b", content: "Task B", instruction: "run b" },
            ],
          },
        ],
      }),
    });
    await started;
    const base = await controller.getPlanView(execution.runId);
    const approval = await controller.requestApproval(execution.runId, {
      approvalKind: "plan_gate",
      description: "Human decision must fence the current revision.",
      denialPolicy: "stop",
      subjectTaskId: "task-b",
      expectedOwner: owner,
      expectedOwnerGeneration: 1,
      expectedRunEpoch: base.runEpoch,
    });
    const before = await (
      await store.openRun(owner, execution.runId)
    ).readEvents();

    await expect(
      controller.mutatePlan(execution.runId, {
        expectedOwner: owner,
        expectedRunEpoch: base.runEpoch,
        baseRevision: base.revision,
        actor: { kind: "model", id: "workflow-plan-tool" },
        mutation: {
          operation: "skip",
          taskId: "task-b",
          reason: "must not strand approval",
        },
      }),
    ).rejects.toMatchObject({ code: "awaiting_budget" });
    expect(await controller.inspectApproval(execution.runId)).toMatchObject({
      requestId: approval.requestId,
      planRevision: base.revision,
    });
    expect(
      (await (await store.openRun(owner, execution.runId)).readEvents()).filter(
        (event) => event.type === "plan_revised",
      ),
    ).toHaveLength(
      before.filter((event) => event.type === "plan_revised").length,
    );

    await controller.interrupt("quit");
    await execution.completion.catch(() => undefined);
    await controller.release();
  });

  it("runs a task appended while the current task is active", async () => {
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const calls: string[] = [];
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7102,
          processStartIdentity: "mutation-refresh-test",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "run a") {
            markFirstStarted();
            await firstBlocked;
          }
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
    });
    const execution = await controller.startPlan({
      plan: validateWorkflowPlan({
        name: "active-append",
        description: "refresh active scheduler",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [{ id: "task-a", content: "Task A", instruction: "run a" }],
          },
        ],
      }),
    });
    await firstStarted;
    const base = await controller.getPlanView(execution.runId);
    await controller.mutatePlan(execution.runId, {
      expectedOwner: owner,
      expectedRunEpoch: base.runEpoch,
      baseRevision: base.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: {
        operation: "append",
        phaseId: "phase-a",
        task: { id: "task-b", content: "Task B", instruction: "run b" },
      },
    });
    releaseFirst();

    await expect(execution.completion).resolves.toMatchObject({
      status: "done",
      result: [
        { id: "task-a", status: "succeeded" },
        { id: "task-b", status: "succeeded" },
      ],
    });
    expect(calls).toEqual(["run a", "run b"]);
    await controller.release();
  });

  it("keeps recovered interrupted plans asleep across model mutations until trusted resume", async () => {
    const runId = createDurableWorkflowRunId("interrupted-mutation");
    const firstController = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7103,
          processStartIdentity: "interrupted-mutation-first",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => ({
          isError: false,
          output: `done:${prompt}`,
          usage,
        }),
    });
    const abort = new AbortController();
    const initial = await firstController.startPlan({
      runId,
      signal: abort.signal,
      onPlanEvent: (event) => {
        if (event.type === "task_succeeded" && event.taskId === "task-a") {
          abort.abort("simulate process interruption");
        }
      },
      plan: validateWorkflowPlan({
        name: "interrupted mutation",
        description: "mutations cannot resume interrupted execution",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [
              { id: "task-a", content: "Task A", instruction: "run a" },
              { id: "task-b", content: "Task B", instruction: "run b" },
            ],
          },
        ],
      }),
    });
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await firstController.release();

    const resumedCalls: string[] = [];
    const wakes: Promise<void>[] = [];
    let recoveredController!: DurableWorkflowPlanController;
    recoveredController = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7104,
          processStartIdentity: "interrupted-mutation-second",
        },
      }),
      owner,
      scopeId: 2,
      generation: 2,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          resumedCalls.push(prompt);
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
      onPlanMutationWake: (wakeRunId) => {
        const wake = recoveredController.wakePlan(wakeRunId);
        wakes.push(wake);
        return wake;
      },
    });
    await recoveredController.open("startup");
    const interrupted = await recoveredController.getPlanView(runId);
    expect(interrupted.status).toBe("interrupted");

    const appended = await recoveredController.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: interrupted.runEpoch,
      baseRevision: interrupted.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: {
        operation: "append",
        phaseId: "phase-a",
        task: { id: "task-c", content: "Task C", instruction: "run c" },
      },
    });
    const blocked = await recoveredController.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: appended.runEpoch,
      baseRevision: appended.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: {
        operation: "block",
        taskId: "task-b",
        reason: "wait for dependency",
      },
    });
    const unblocked = await recoveredController.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: blocked.runEpoch,
      baseRevision: blocked.revision,
      actor: { kind: "model", id: "workflow-plan-tool" },
      mutation: { operation: "unblock", taskId: "task-b" },
    });
    await Promise.all(wakes);

    expect(resumedCalls).toEqual([]);
    expect(await recoveredController.getProjection(runId)).toMatchObject({
      status: "interrupted",
    });
    const eventJournal = await new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: 7105,
        processStartIdentity: "interrupted-mutation-reader",
      },
    }).openRun(owner, runId);
    expect(
      (await eventJournal.readEvents()).filter(
        (event) => event.type === "run_resumed",
      ),
    ).toEqual([]);

    const resumed = await recoveredController.trustedResume(runId, {
      trustedActorId: "human-operator",
      expectedOwner: owner,
      expectedRunEpoch: unblocked.runEpoch,
    });
    await expect(resumed.completion).resolves.toMatchObject({ status: "done" });
    expect(resumedCalls).toEqual(["run b", "run c"]);
    expect(
      (await eventJournal.readEvents()).filter(
        (event) => event.type === "run_resumed",
      ),
    ).toHaveLength(1);
    await recoveredController.release();
  });

  it("does not transition a task from blocked to running after scheduler selection", async () => {
    const calls: string[] = [];
    const runId = createDurableWorkflowRunId("selected-block-race");
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7109,
          processStartIdentity: "selected-block-race",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          calls.push(prompt);
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
    });
    let mutationQueued = false;
    let mutation!: Promise<unknown>;
    let markMutationQueued!: () => void;
    const mutationWasQueued = new Promise<void>((resolve) => {
      markMutationQueued = resolve;
    });
    const execution = await controller.startPlan({
      runId,
      onProgress: (event) => {
        if (event.kind !== "phase" || mutationQueued) return;
        mutationQueued = true;
        mutation = controller.mutatePlan(runId, {
          expectedOwner: owner,
          expectedRunEpoch: 1,
          baseRevision: 1,
          actor: { kind: "human", id: "workflow-plan-command" },
          mutation: {
            operation: "block",
            taskId: "task-a",
            reason: "operator blocked selected work",
          },
        });
        markMutationQueued();
      },
      plan: validateWorkflowPlan({
        name: "selected block",
        description: "blocking must fence the running transition",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [{ id: "task-a", content: "Task A", instruction: "run a" }],
          },
        ],
      }),
    });
    await mutationWasQueued;
    await mutation;
    await expect(execution.completion).resolves.toMatchObject({
      status: "blocked",
      result: [{ id: "task-a", status: "blocked" }],
    });
    expect(calls).toEqual([]);
    expect(await controller.getProjection(runId)).toMatchObject({
      taskStates: { "task-a": { status: "blocked" } },
    });
    await controller.release();
  });

  it("interrupts active siblings before reselecting after a task-start mutation", async () => {
    const calls: string[] = [];
    const runId = createDurableWorkflowRunId("parallel-start-race");
    const interruptedUsage = {
      input: 3,
      output: 5,
      cacheRead: 7,
      cacheWrite: 11,
      cost: 0.13,
      turns: 1,
    };
    let markAStarted!: () => void;
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve;
    });
    let firstAttempt = true;
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7110,
          processStartIdentity: "parallel-start-race",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      concurrency: 2,
      runAgentForRun:
        () =>
        async ({ prompt, signal }) => {
          calls.push(prompt);
          if (prompt === "run a" && firstAttempt) {
            firstAttempt = false;
            markAStarted();
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return {
              isError: false,
              output: "aborted for reselection",
              cancelled: true,
              usage: interruptedUsage,
            } satisfies SubagentResult;
          }
          if (prompt === "run b") await aStarted;
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          } satisfies SubagentResult;
        },
    });
    let mutation: Promise<unknown> | undefined;
    const execution = await controller.startPlan({
      runId,
      concurrency: 2,
      onPlanEvent: (event) => {
        if (
          event.type !== "task_succeeded" ||
          event.taskId !== "task-b" ||
          mutation !== undefined
        ) {
          return;
        }
        mutation = controller.mutatePlan(runId, {
          expectedOwner: owner,
          expectedRunEpoch: 1,
          baseRevision: 1,
          actor: { kind: "human", id: "workflow-plan-command" },
          mutation: {
            operation: "block",
            taskId: "task-c",
            reason: "operator blocked sibling before scheduler refill",
          },
        });
      },
      plan: validateWorkflowPlan({
        name: "parallel start race",
        description: "reselection must not settle aborted active siblings",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "parallel",
            tasks: [
              {
                id: "task-a",
                content: "Task A",
                instruction: "run a",
                agent: { isolation: "in-process" },
              },
              {
                id: "task-b",
                content: "Task B",
                instruction: "run b",
                agent: { isolation: "in-process" },
              },
              {
                id: "task-c",
                content: "Task C",
                instruction: "run c",
                agent: { isolation: "in-process" },
              },
            ],
          },
        ],
      }),
    });

    const result = await execution.completion;
    expect(result).toMatchObject({
      status: "blocked",
      agentsSpawned: 3,
      tokensSpent: interruptedUsage.output,
      usage: {
        input: interruptedUsage.input,
        output: interruptedUsage.output,
        cacheRead: interruptedUsage.cacheRead,
        cacheWrite: interruptedUsage.cacheWrite,
        costUsd: interruptedUsage.cost,
        turns: interruptedUsage.turns,
      },
    });
    await mutation;
    expect(calls).toEqual(["run a", "run b", "run a"]);
    const projection = await controller.getProjection(runId);
    const taskA = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-a",
    );
    expect(taskA?.attempts.map((attempt) => attempt.status)).toEqual([
      "interrupted",
      "settled",
    ]);
    expect(taskA?.attempts[0]?.usageObserved).toMatchObject({
      input: interruptedUsage.input,
      output: interruptedUsage.output,
      cacheRead: interruptedUsage.cacheRead,
      cacheWrite: interruptedUsage.cacheWrite,
      costUsd: interruptedUsage.cost,
      turns: interruptedUsage.turns,
    });
    expect(taskA?.settlement?.outcome.status).toBe("succeeded");
    expect(projection?.taskStates["task-c"]?.status).toBe("blocked");
    expect(calls).not.toContain("run c");
    await controller.release();
  });
  it("does not dispatch a task skipped after scheduler selection", async () => {
    const calls: string[] = [];
    const runId = createDurableWorkflowRunId("selected-skip-race");
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7106,
          processStartIdentity: "selected-skip-race",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          calls.push(prompt);
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
    });
    let mutationQueued = false;
    let mutation!: Promise<unknown>;
    let markMutationQueued!: () => void;
    const mutationWasQueued = new Promise<void>((resolve) => {
      markMutationQueued = resolve;
    });
    const execution = await controller.startPlan({
      runId,
      onProgress: (event) => {
        if (event.kind !== "phase" || mutationQueued) return;
        mutationQueued = true;
        mutation = controller.mutatePlan(runId, {
          expectedOwner: owner,
          expectedRunEpoch: 1,
          baseRevision: 1,
          actor: { kind: "human", id: "workflow-plan-command" },
          mutation: {
            operation: "skip",
            taskId: "task-a",
            reason: "operator skipped selected work",
          },
        });
        markMutationQueued();
      },
      plan: validateWorkflowPlan({
        name: "selected skip",
        description: "selection must yield to management",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [
              { id: "task-a", content: "Task A", instruction: "run a" },
              { id: "task-b", content: "Task B", instruction: "run b" },
            ],
          },
        ],
      }),
    });
    await mutationWasQueued;
    await mutation;
    await expect(execution.completion).resolves.toMatchObject({
      status: "done",
      result: [
        { id: "task-a", status: "skipped" },
        { id: "task-b", status: "succeeded" },
      ],
    });
    expect(calls).toEqual(["run b"]);
    await controller.release();
  });

  it("does not dispatch a task cancelled after scheduler selection", async () => {
    const calls: string[] = [];
    const runId = createDurableWorkflowRunId("selected-cancel-race");
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7107,
          processStartIdentity: "selected-cancel-race",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          calls.push(prompt);
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
    });
    let cancellationQueued = false;
    let cancellation!: Promise<unknown>;
    let markCancellationQueued!: () => void;
    const cancellationWasQueued = new Promise<void>((resolve) => {
      markCancellationQueued = resolve;
    });
    const execution = await controller.startPlan({
      runId,
      onProgress: (event) => {
        if (event.kind !== "phase" || cancellationQueued) return;
        cancellationQueued = true;
        cancellation = controller.trustedCancel(runId, {
          trustedActorId: "human-operator",
          reason: "cancel selected work",
          expectedOwner: owner,
          expectedRunEpoch: 1,
        });
        markCancellationQueued();
      },
      plan: validateWorkflowPlan({
        name: "selected cancel",
        description: "cancellation must fence dispatch",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [{ id: "task-a", content: "Task A", instruction: "run a" }],
          },
        ],
      }),
    });
    const completion = execution.completion.catch((error) => error);
    await cancellationWasQueued;
    await expect(cancellation).resolves.toMatchObject({ status: "cancelled" });
    await completion;
    expect(calls).toEqual([]);
    expect(await controller.getProjection(runId)).toMatchObject({
      terminal: { status: "cancelled" },
    });
    await controller.release();
  });

  it("reselects from the authoritative revision when future work moves after selection", async () => {
    const calls: string[] = [];
    const runId = createDurableWorkflowRunId("selected-revision-race");
    const controller = await DurableWorkflowPlanController.acquire({
      store: new WorkflowRunStore({
        homeDir: home,
        processIdentity: {
          pid: 7108,
          processStartIdentity: "selected-revision-race",
        },
      }),
      owner,
      scopeId: 1,
      generation: 1,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          calls.push(prompt);
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          };
        },
    });
    const revisedPlan = validateWorkflowPlan({
      name: "selected revision",
      description: "revision changes force scheduler reselection",
      phases: [
        {
          id: "phase-a",
          name: "Phase A",
          mode: "sequence",
          tasks: [{ id: "task-c", content: "Task C", instruction: "run c" }],
        },
        {
          id: "phase-b",
          name: "Phase B",
          mode: "sequence",
          tasks: [
            { id: "task-b", content: "Task B", instruction: "run b" },
            { id: "task-a", content: "Task A", instruction: "run a" },
          ],
        },
      ],
    });
    let mutationQueued = false;
    let mutation!: Promise<unknown>;
    let markMutationQueued!: () => void;
    const mutationWasQueued = new Promise<void>((resolve) => {
      markMutationQueued = resolve;
    });
    const execution = await controller.startPlan({
      runId,
      onProgress: (event) => {
        if (
          event.kind !== "phase" ||
          event.phase !== "phase-a" ||
          mutationQueued
        ) {
          return;
        }
        mutationQueued = true;
        mutation = controller.mutatePlan(runId, {
          expectedOwner: owner,
          expectedRunEpoch: 1,
          baseRevision: 1,
          actor: { kind: "human", id: "workflow-plan-command" },
          mutation: { operation: "replace_future", plan: revisedPlan },
        });
        markMutationQueued();
      },
      plan: validateWorkflowPlan({
        name: "selected revision",
        description: "revision changes force scheduler reselection",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [{ id: "task-a", content: "Task A", instruction: "run a" }],
          },
          {
            id: "phase-b",
            name: "Phase B",
            mode: "sequence",
            tasks: [{ id: "task-b", content: "Task B", instruction: "run b" }],
          },
        ],
      }),
    });
    await mutationWasQueued;
    await mutation;
    await expect(execution.completion).resolves.toMatchObject({
      status: "done",
    });
    expect(calls).toEqual(["run c", "run b", "run a"]);
    await controller.release();
  });

  it("keeps active parallel work alive across a queued future revision", async () => {
    const store = new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: 7109,
        processStartIdentity: "queued-revision-race",
      },
    });
    const calls: string[] = [];
    let activeStarted = 0;
    let markActiveStarted!: () => void;
    const bothActiveStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    let releaseA!: () => void;
    const aBarrier = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseC!: () => void;
    const cBarrier = new Promise<void>((resolve) => {
      releaseC = resolve;
    });
    let markDStarted!: () => void;
    const dStarted = new Promise<void>((resolve) => {
      markDStarted = resolve;
    });
    let cAborted = false;
    const controller = await DurableWorkflowPlanController.acquire({
      store,
      owner,
      scopeId: 1,
      generation: 1,
      concurrency: 2,
      runAgentForRun:
        () =>
        async ({ prompt, signal }) => {
          calls.push(prompt);
          if (prompt === "run a" || prompt === "run c") {
            activeStarted += 1;
            if (activeStarted === 2) markActiveStarted();
          }
          if (prompt === "run a") {
            await aBarrier;
          } else if (prompt === "run c") {
            const outcome = await Promise.race([
              cBarrier.then(() => "released" as const),
              new Promise<"aborted">((resolve) => {
                if (signal?.aborted) {
                  resolve("aborted");
                  return;
                }
                signal?.addEventListener("abort", () => resolve("aborted"), {
                  once: true,
                });
              }),
            ]);
            if (outcome === "aborted") {
              cAborted = true;
              return {
                isError: false,
                output: "aborted",
                cancelled: true,
                usage,
              } satisfies SubagentResult;
            }
          } else if (prompt === "run d") {
            markDStarted();
          }
          return {
            isError: false,
            output: `done:${prompt}`,
            usage,
          } satisfies SubagentResult;
        },
    });
    const runId = createDurableWorkflowRunId("queued-revision-race");
    const execution = await controller.startPlan({
      runId,
      concurrency: 3,
      plan: validateWorkflowPlan({
        name: "queued revision",
        description: "future mutation while parallel work awaits a lane",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "parallel",
            tasks: [
              {
                id: "task-a",
                content: "Task A",
                instruction: "run a",
                agent: { isolation: "in-process" },
              },
              {
                id: "task-c",
                content: "Task C",
                instruction: "run c",
                agent: { isolation: "in-process" },
              },
              {
                id: "task-d",
                content: "Task D",
                instruction: "run d",
                agent: { isolation: "in-process" },
              },
            ],
          },
          {
            id: "phase-b",
            name: "Phase B",
            mode: "sequence",
            tasks: [
              {
                id: "task-b",
                content: "Task B",
                instruction: "run b",
                agent: { isolation: "in-process" },
              },
            ],
          },
        ],
      }),
    });
    await bothActiveStarted;
    await vi.waitFor(async () => {
      const projection = await controller.getProjection(runId);
      const operation = projection?.operations.find(
        (candidate) => candidate.identity.operationId === "task-d",
      );
      expect(operation?.attempts.at(-1)?.status).toBe("started");
      expect(calls).toEqual(["run a", "run c"]);
    });

    const base = await controller.getPlanView(runId);
    await controller.mutatePlan(runId, {
      expectedOwner: owner,
      expectedRunEpoch: base.runEpoch,
      baseRevision: base.revision,
      actor: { kind: "human", id: "workflow-plan-command" },
      mutation: {
        operation: "append",
        phaseId: "phase-b",
        task: {
          id: "task-e",
          content: "Task E",
          instruction: "run e",
          agent: { isolation: "in-process" },
        },
      },
    });

    releaseA();
    const firstOutcome = await Promise.race([
      dStarted.then(() => "task-d-started" as const),
      execution.completion.then(
        () => "execution-completed" as const,
        () => "execution-failed" as const,
      ),
    ]);
    releaseC();
    const [settled] = await Promise.allSettled([execution.completion]);

    expect(firstOutcome).toBe("task-d-started");
    expect(settled.status).toBe("fulfilled");
    expect(cAborted).toBe(false);
    expect(calls).toEqual(["run a", "run c", "run d", "run b", "run e"]);
    const projection = await controller.getProjection(runId);
    const taskD = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-d",
    );
    expect(taskD?.attempts.map((attempt) => attempt.status)).toEqual([
      "settled",
    ]);
    const events = await (await store.openRun(owner, runId)).readEvents();
    expect(
      events.filter(
        (event) =>
          event.type === "task_transitioned" && event.payload.to === "failed",
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.type === "operation_settled" &&
          event.payload.outcome.status === "thrown_error",
      ),
    ).toEqual([]);
    await controller.release();
  });
});
