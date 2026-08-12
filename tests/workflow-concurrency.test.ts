import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  DurableWorkflowController,
  runDurableWorkflowPlan,
  type WorkflowTaskClaim,
} from "../src/workflow-durable-plan-runner";
import { projectWorkflowRun } from "../src/workflow-projection-repository";
import { WorkflowSessionDispatcher } from "../src/workflow-dispatcher";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type {
  WorkflowOwnerIdentity,
  WorkflowEventEnvelope,
} from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

const success = (output: string): SubagentResult => ({
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

const launch = {
  schemaVersion: 1 as const,
  runId: "projection-run",
  planRevision: 1,
  resumePolicy: "manual" as const,
  owner,
  createdAt: 1,
};

function event<T extends string>(
  eventId: string,
  type: T,
  payload: unknown,
): WorkflowEventEnvelope<T> {
  return {
    schemaVersion: 1,
    eventId,
    runId: launch.runId,
    runEpoch: 0,
    type,
    payload,
  };
}

function claim(attempt: number, token: string): WorkflowTaskClaim {
  return {
    runId: launch.runId,
    taskId: "a",
    attempt,
    ownerId: owner.ownerId,
    ownerGeneration: owner.ownerGeneration,
    leaseEpoch: 1,
    token,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("PR84 durable concurrency", () => {
  it("F03 lets exactly one of two same-owner stores win a CAS append", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-concurrency-"));
    roots.push(root);
    const firstStore = new WorkflowRunStore({ rootDir: root, owner });
    const secondStore = new WorkflowRunStore({ rootDir: root, owner });
    await firstStore.createRun({
      runId: "two-store-cas",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });

    let readyCount = 0;
    let releaseBarrier!: () => void;
    const ready = new Promise<void>((resolve) => {
      const check = (): void => {
        readyCount++;
        if (readyCount === 2) resolve();
      };
      releaseBarrier = check;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = async (
      store: WorkflowRunStore,
      type: string,
    ): Promise<Awaited<ReturnType<WorkflowRunStore["appendIfCurrent"]>>> => {
      releaseBarrier();
      await barrier;
      return store.appendIfCurrent("two-store-cas", -1, type, {});
    };

    const first = append(firstStore, "first");
    const second = append(secondStore, "second");
    await ready;
    release();
    const results = await Promise.all([first, second]);

    expect(
      results.filter((result) => result.status === "appended"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "conflict"),
    ).toHaveLength(1);
    await expect(firstStore.readRun("two-store-cas")).resolves.toMatchObject({
      events: [{ eventOrdinal: 0 }],
    });
    await firstStore.release();
  });

  it("allows only one concurrent coordinator to run a claimed task", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-concurrency-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "race",
      phases: [
        { id: "p", mode: "sequential", tasks: [{ id: "a", prompt: "A" }] },
      ],
    };
    let calls = 0;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runAgent = async (): Promise<SubagentResult> => {
      calls++;
      entered();
      await releasePromise;
      return success("done");
    };

    const first = runDurableWorkflowPlan({
      store,
      owner,
      runId: "race",
      plan,
      runAgent,
    });
    await enteredPromise;
    const second = runDurableWorkflowPlan({
      store,
      owner,
      runId: "race",
      plan,
      runAgent,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
  });

  it("does not let a losing parallel coordinator terminalize active work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-concurrency-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "parallel-race",
      phases: [
        { id: "p", mode: "parallel", tasks: [{ id: "a", prompt: "A" }] },
      ],
    };
    let calls = 0;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runAgent = async (): Promise<SubagentResult> => {
      calls++;
      entered();
      await releasePromise;
      return success("done");
    };

    const first = runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-race",
      plan,
      runAgent,
    });
    await enteredPromise;
    const second = runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-race",
      plan,
      runAgent,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(1);
    expect((await second).status).toBe("running");
    release();
    expect((await first).status).toBe("done");
  });

  it("ignores a stale settlement for a newer task claim", () => {
    const newer = claim(2, "newer");
    const stale = claim(2, "stale");
    const projection = projectWorkflowRun(launch, [
      event("created", "run_created", {
        tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
      }),
      event("started", "task_started", {
        taskId: "a",
        attempt: 2,
        phaseId: "p",
        claim: newer,
      }),
      event("stale", "task_succeeded", {
        taskId: "a",
        attempt: 2,
        claim: stale,
        result: "stale",
      }),
    ]);

    expect(projection.tasks.a.status).toBe("running");
    expect(projection.tasks.a.claim).toEqual(newer);
    expect(projection.tasks.a.result).toBeUndefined();
  });

  it("tracks independent budget, approval, runtime, and task blockers", () => {
    const request = {
      requestId: "approval",
      policyHash: "policy",
      planRevision: 1,
      ownerGeneration: 1,
      leaseEpoch: 0,
      version: 1,
    };
    const blocked = projectWorkflowRun(launch, [
      event("created", "run_created", {
        tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
      }),
      event("started", "run_started", {}),
      event("budget", "run_awaiting_budget", { reason: "budget" }),
      event("approval", "approval_requested", { request }),
      event("runtime", "run_blocked", { source: "runtime", reason: "runtime" }),
      event("task", "task_blocked", { taskId: "a", reason: "task" }),
    ]);

    expect(blocked.blockers.budget?.reason).toBe("budget");
    expect(blocked.blockers.approval?.requestId).toBe("approval");
    expect(blocked.blockers.runtime?.reason).toBe("runtime");
    expect(blocked.blockers.tasks.a?.reason).toBe("task");

    const recovered = projectWorkflowRun(launch, [
      event("created", "run_created", {
        tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
      }),
      event("started", "run_started", {}),
      event("budget", "run_awaiting_budget", { reason: "budget" }),
      event("approval", "approval_requested", { request }),
      event("runtime", "run_blocked", { source: "runtime", reason: "runtime" }),
      event("task", "task_blocked", { taskId: "a", reason: "task" }),
      event("budget-resumed", "run_budget_resumed", {}),
      event("approval-decided", "approval_decided", {
        requestId: "approval",
        status: "approved",
        decidedBy: "operator",
      }),
      event("task-unblocked", "task_unblocked", { taskId: "a" }),
      event("runtime-resumed", "run_started", {}),
    ]);

    expect(recovered.blockers).toEqual({ tasks: {}, claims: {} });
    expect(recovered.status).toBe("running");
  });

  it("binds controller mutations to the full durable event context", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-mutation-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "mutation-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("mutation-run", "run_created", {
      tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
    });
    const controller = new DurableWorkflowController({ store, owner });
    const projection = await controller.mutateTask("mutation-run", {
      type: "block",
      taskId: "a",
      expectedRevision: 1,
    });
    const eventLog = await store.readRun("mutation-run");
    const mutation = eventLog.events.at(-1)?.payload as Record<string, unknown>;

    expect(projection?.tasks.a.status).toBe("blocked");
    expect(mutation).toMatchObject({
      mutationProtocolVersion: 1,
      mutationRunId: "mutation-run",
      mutationType: "task_blocked",
      mutationOwnerId: owner.ownerId,
      mutationOwnerGeneration: owner.ownerGeneration,
      mutationBaseRevision: 1,
      mutationBaseOrdinal: 0,
      previousMutationHash: "",
    });
    expect(mutation.mutationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not advance projection revision for a tampered mutation", () => {
    const projection = projectWorkflowRun(launch, [
      event("created", "run_created", {
        tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
      }),
      event("tampered", "task_blocked", {
        taskId: "a",
        mutationProtocolVersion: 1,
        mutationRunId: launch.runId,
        mutationType: "task_blocked",
        mutationOwnerId: owner.ownerId,
        mutationOwnerGeneration: owner.ownerGeneration,
        mutationLeaseEpoch: 0,
        mutationBaseRevision: 1,
        mutationBaseOrdinal: 0,
        previousMutationHash: "",
        mutationHash: "tampered",
      }),
    ]);

    expect(projection.revision).toBe(1);
    expect(projection.lastEventOrdinal).toBe(1);
    expect(projection.tasks.a.status).toBe("pending");
    expect(projection.mutationHash).toBeUndefined();
  });

  it("rejects mutation evidence with a missing hash without advancing authority", () => {
    const projection = projectWorkflowRun(launch, [
      event("created", "run_created", {
        tasks: [{ id: "a", phaseId: "p", prompt: "A" }],
      }),
      event("missing-hash", "task_blocked", {
        taskId: "a",
        mutationProtocolVersion: 1,
        mutationRunId: launch.runId,
        mutationType: "task_blocked",
        mutationOwnerId: owner.ownerId,
        mutationOwnerGeneration: owner.ownerGeneration,
        mutationLeaseEpoch: 0,
        mutationBaseRevision: 1,
        mutationBaseOrdinal: 0,
        previousMutationHash: "",
      }),
    ]);

    expect(projection.revision).toBe(1);
    expect(projection.lastEventOrdinal).toBe(1);
    expect(projection.tasks.a.status).toBe("pending");
    expect(projection.mutationHash).toBeUndefined();
  });

  it("enforces one dispatcher limit across two durable runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-dispatcher-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const dispatcher = new WorkflowSessionDispatcher({ maxConcurrent: 2 });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "cross-run",
      phases: [
        {
          id: "p",
          mode: "parallel",
          tasks: [
            { id: "a", prompt: "A" },
            { id: "b", prompt: "B" },
            { id: "c", prompt: "C" },
          ],
        },
      ],
    };
    let active = 0;
    let maximum = 0;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runAgent = async (): Promise<SubagentResult> => {
      calls++;
      active++;
      maximum = Math.max(maximum, active);
      if (calls === 2) started();
      await gate;
      active--;
      return success("ok");
    };

    const first = runDurableWorkflowPlan({
      store,
      owner,
      runId: "run-a",
      plan,
      dispatcher,
      runAgent,
    });
    const second = runDurableWorkflowPlan({
      store,
      owner,
      runId: "run-b",
      plan,
      dispatcher,
      runAgent,
    });
    await startedPromise;
    expect(maximum).toBe(2);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, max: 2 });
  });

  it("removes cancelled queued work without leaking a dispatcher slot", async () => {
    const dispatcher = new WorkflowSessionDispatcher({ maxConcurrent: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = dispatcher.run(async () => {
      await gate;
      return "active";
    });
    const controller = new AbortController();
    const queued = dispatcher.run(async () => "queued", controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(dispatcher.snapshot()).toEqual({ active: 1, queued: 0, max: 1 });
    release();
    await expect(active).resolves.toBe("active");
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, max: 1 });
  });

  it("shares a fair session dispatcher across runs and releases slots", async () => {
    const dispatcher = new WorkflowSessionDispatcher({ maxConcurrent: 2 });
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = async (value: string): Promise<string> => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return value;
    };

    const first = dispatcher.run(() => work("a"));
    const second = dispatcher.run(() => work("b"));
    const third = dispatcher.run(() => work("c"));
    expect(dispatcher.snapshot()).toEqual({ active: 2, queued: 1, max: 2 });
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(maximum).toBe(2);
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, max: 2 });

    await expect(
      dispatcher.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(dispatcher.snapshot()).toEqual({ active: 0, queued: 0, max: 2 });
  });
});
