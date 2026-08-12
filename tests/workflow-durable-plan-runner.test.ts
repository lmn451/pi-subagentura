import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  DurableWorkflowController,
  drainActiveDurableExecutions,
  runDurableWorkflowPlan,
} from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import { workflowPlanDigest, type WorkflowPlan } from "../src/workflow-plan";

const roots: string[] = [];
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
  name: "durable",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [
        { id: "a", prompt: "A" },
        { id: "b", prompt: "B" },
      ],
    },
  ],
};
const success = (output: string): SubagentResult => ({
  isError: false,
  output,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable sequential plan runner", () => {
  it("persists an idempotent budget pause and continuation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "budget-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("budget-run", "run_created", {});
    await store.append("budget-run", "run_started", {});
    const controller = new DurableWorkflowController({ store, owner });

    expect(
      (await controller.pauseForBudget("budget-run", "limit"))?.status,
    ).toBe("awaiting_budget");
    expect((await controller.pauseForBudget("budget-run"))?.status).toBe(
      "awaiting_budget",
    );
    expect((await controller.resumeFromBudget("budget-run"))?.status).toBe(
      "running",
    );
    expect((await controller.resumeFromBudget("budget-run"))?.status).toBe(
      "running",
    );
  });

  it("persists a pending approval and an idempotent host decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "approval-run",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("approval-run", "run_created", {});
    const controller = new DurableWorkflowController({ store, owner });
    const request = {
      requestId: "approval-1",
      policyHash: "policy",
      planRevision: 1,
      ownerGeneration: 1,
      leaseEpoch: 0,
      version: 1,
    };

    const pending = await controller.requestApproval("approval-run", request);
    expect(pending?.approval?.status).toBe("pending");
    const decided = await controller.decideApproval(
      "approval-run",
      "approval-1",
      {
        requestId: "approval-1",
        status: "approved",
        decidedBy: "operator",
      },
    );
    expect(decided?.approval?.status).toBe("approved");
    const replayed = await controller.decideApproval(
      "approval-run",
      "approval-1",
      {
        requestId: "approval-1",
        status: "rejected",
        decidedBy: "late-operator",
      },
    );
    expect(replayed?.approval?.status).toBe("approved");
  });

  it("repairs a terminal run whose delivery intent was not committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId: "terminal-without-outbox",
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append("terminal-without-outbox", "run_created", {});
    await store.append("terminal-without-outbox", "run_terminal", {
      result: { status: "done", result: "complete" },
    });

    const controller = new DurableWorkflowController({ store, owner });
    const projection = await controller.getStatus("terminal-without-outbox");

    expect(projection?.status).toBe("done");
    expect(projection?.delivery?.status).toBe("pending");
  });

  it("creates before dispatch and replays committed tasks after interruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];
    let failOnce = true;

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "run",
        plan,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "B" && failOnce) {
            failOnce = false;
            throw new Error("parent died");
          }
          return success(`done:${prompt}`);
        },
      }),
    ).rejects.toThrow("parent died");

    const interrupted = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      resume: false,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });
    expect(interrupted.status).toBe("interrupted");
    expect(calls).toEqual(["A", "B"]);

    const done = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      resume: true,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });
    expect(done.status).toBe("done");
    expect(done.tasks.a).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(done.tasks.b).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(calls).toEqual(["A", "B", "B"]);
  });

  it("executes a task appended while the declared plan is running", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "appended-run",
      plan: {
        ...plan,
        phases: [{ ...plan.phases[0], tasks: [plan.phases[0].tasks[0]] }],
      },
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        if (prompt === "A") {
          const controller = new DurableWorkflowController({ store, owner });
          const current = await controller.getStatus("appended-run");
          await controller.mutateTask("appended-run", {
            type: "append",
            taskId: "C",
            phaseId: "phase",
            prompt: "C",
            expectedRevision: current?.revision ?? 0,
          });
        }
        return success(`done:${prompt}`);
      },
    });

    expect(result.status).toBe("done");
    expect(result.tasks.C).toMatchObject({ status: "succeeded" });
    expect(calls).toEqual(["A", "C"]);
  });

  it("rejects resuming an existing run with a different plan revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan,
      runAgent: async () => success("done"),
    });

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "run",
        plan: { ...plan, schemaVersion: 2 } as unknown as WorkflowPlan,
        resume: true,
        runAgent: async () => success("must not run"),
      }),
    ).rejects.toThrow("Workflow plan revision mismatch");
  });

  it("publishes terminal projections for recovered and failed runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const statuses: string[] = [];

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "run",
      plan: {
        ...plan,
        phases: [{ ...plan.phases[0], tasks: [plan.phases[0].tasks[0]] }],
      },
      runAgent: async () => success("done"),
      onProjection: (projection) => statuses.push(projection.status),
    });

    expect(statuses.at(-1)).toBe("done");
    expect(statuses.length).toBeGreaterThan(0);
  });

  it("retains the terminal error envelope after task failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "failed-run",
      plan,
      runAgent: async () => ({
        isError: true as const,
        output: "",
        usage: success("ignored").usage,
        errorMessage: "provider failed",
      }),
    });

    expect(result.status).toBe("error");
    expect(result.terminal).toEqual({
      status: "error",
      error: { code: "task_failed", message: "provider failed" },
    });
  });

  it("commits cancellation as a terminal result before returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const signal = new AbortController();
    signal.abort();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "cancelled-run",
      plan,
      signal: signal.signal,
      runAgent: async () => {
        throw new Error("must not dispatch");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
    expect(
      Object.values(result.tasks).every(
        (task) => task.status !== "pending" && task.status !== "running",
      ),
    ).toBe(true);
  });

  it("commits cancellation when an active task observes an aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new AbortController();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "cancelled-during-task",
      plan,
      signal: controller.signal,
      runAgent: async ({ signal }) => {
        controller.abort();
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(new Error("agent aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("agent aborted")),
            { once: true },
          );
        });
        throw new Error("must not complete");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
    expect(
      Object.values(result.tasks).every(
        (task) => task.status !== "pending" && task.status !== "running",
      ),
    ).toBe(true);
  });

  it("rejects an invalid plan before creating a durable run", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const invalidPlan = {
      ...plan,
      phases: [{ ...plan.phases[0], tasks: [{ id: "bad/id", prompt: "bad" }] }],
    } as WorkflowPlan;

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "invalid-run",
        plan: invalidPlan,
        runAgent: async () => {
          throw new Error("must not dispatch");
        },
      }),
    ).rejects.toThrow("Invalid or duplicate task id");
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it("rejects an invalid plan before recovering an existing run", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "existing-run",
      plan,
      runAgent: async () => success("done"),
    });

    const invalidPlan = {
      ...plan,
      phases: [{ ...plan.phases[0], tasks: [{ id: "bad/id", prompt: "bad" }] }],
    } as WorkflowPlan;
    const calls: string[] = [];

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "existing-run",
        plan: invalidPlan,
        resume: true,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          return success("must not run");
        },
      }),
    ).rejects.toThrow("Invalid or duplicate task id");
    expect(calls).toEqual([]);
  });

  it("persists the requested resume policy in the launch snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const launchPlan: WorkflowPlan = {
      ...plan,
      name: "launch-snapshot",
      phases: [
        {
          id: "parallel",
          mode: "parallel",
          tasks: [
            {
              id: "task",
              prompt: "snapshot",
              label: "Snapshot task",
              isolation: "in-process",
              input: { nested: { value: true }, count: 2 },
            },
          ],
        },
      ],
    };

    await runDurableWorkflowPlan({
      store,
      owner,
      runId: "auto-resume-run",
      plan: launchPlan,
      resumePolicy: "on-session-start",
      runAgent: async () => success("done"),
    });

    const record = await store.readRun("auto-resume-run");
    expect(record.launch.resumePolicy).toBe("on-session-start");
    expect(record.launch.plan).toEqual(launchPlan);
    expect(record.launch.planDigest).toBe(workflowPlanDigest(launchPlan));
  });

  it("executes parallel siblings once and folds their usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-run",
      plan: {
        ...plan,
        phases: [
          {
            id: "parallel",
            mode: "parallel",
            tasks: [
              { id: "a", prompt: "A" },
              { id: "b", prompt: "B" },
              { id: "c", prompt: "C" },
            ],
          },
        ],
      },
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });

    expect(result.status).toBe("done");
    expect(calls.sort()).toEqual(["A", "B", "C"]);
    expect(result.tasks.a.status).toBe("succeeded");
    expect(result.tasks.b.status).toBe("succeeded");
    expect(result.tasks.c.status).toBe("succeeded");
    expect(result.usage).toEqual({ input: 3, output: 6 });
  });

  it("commits cancellation when a parallel task observes an aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new AbortController();

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-cancelled-run",
      plan: {
        ...plan,
        phases: [
          {
            id: "parallel",
            mode: "parallel",
            tasks: [
              { id: "a", prompt: "A" },
              { id: "b", prompt: "B" },
            ],
          },
        ],
      },
      signal: controller.signal,
      runAgent: async ({ signal }) => {
        controller.abort();
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) {
            reject(new Error("agent aborted"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new Error("agent aborted")),
            { once: true },
          );
        });
        throw new Error("must not complete");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.terminal).toMatchObject({ status: "cancelled" });
  });

  it("returns the committed terminal projection for parallel task failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-failed-run",
      plan: {
        ...plan,
        phases: [
          {
            id: "parallel",
            mode: "parallel",
            tasks: [
              { id: "a", prompt: "A" },
              { id: "b", prompt: "B" },
            ],
          },
        ],
      },
      runAgent: async ({ prompt }) => {
        if (prompt === "A") {
          return {
            isError: true as const,
            output: "failed",
            usage: success("ignored").usage,
            errorMessage: "provider failed",
          };
        }
        return success("done:B");
      },
    });

    expect(result.status).toBe("error");
    expect(result.terminal).toEqual({
      status: "error",
      error: { code: "task_failed", message: "provider failed" },
    });
  });

  it("retries an interrupted parallel attempt without rerunning committed siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];
    let interrupted = true;
    const parallelPlan: WorkflowPlan = {
      ...plan,
      phases: [
        {
          id: "parallel",
          mode: "parallel",
          tasks: [
            { id: "a", prompt: "A" },
            { id: "b", prompt: "B" },
          ],
        },
      ],
    };

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "parallel-interrupted-run",
        plan: parallelPlan,
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          if (prompt === "B" && interrupted) {
            interrupted = false;
            throw new Error("parent died");
          }
          return success(`done:${prompt}`);
        },
      }),
    ).rejects.toThrow("parent died");

    const interruptedProjection = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-interrupted-run",
      plan: parallelPlan,
      resume: false,
      runAgent: async ({ prompt }) => success(`done:${prompt}`),
    });
    expect(interruptedProjection.status).toBe("interrupted");

    const result = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "parallel-interrupted-run",
      plan: parallelPlan,
      resume: true,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });

    expect(result.status).toBe("done");
    expect(calls.sort()).toEqual(["A", "B", "B"]);
    expect(result.tasks.a).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(result.tasks.b).toMatchObject({ status: "succeeded", attempt: 2 });
  });
  it("hashes canonical-equivalent plan objects identically", () => {
    const left: WorkflowPlan = {
      schemaVersion: 1,
      name: "canonical",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            {
              id: "task",
              prompt: "prompt",
              input: { z: 1, a: { y: true, b: "value" } },
            },
          ],
        },
      ],
    };
    const right: WorkflowPlan = {
      phases: [
        {
          tasks: [
            {
              input: { a: { b: "value", y: true }, z: 1 },
              prompt: "prompt",
              id: "task",
            },
          ],
          mode: "sequential",
          id: "phase",
        },
      ],
      name: "canonical",
      schemaVersion: 1,
    };
    expect(workflowPlanDigest(left)).toBe(workflowPlanDigest(right));
  });

  it("rejects durable process isolation before run creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const processPlan: WorkflowPlan = {
      ...plan,
      phases: [
        {
          ...plan.phases[0],
          tasks: [{ ...plan.phases[0].tasks[0], isolation: "process" }],
        },
      ],
    };

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "process-run",
        plan: processPlan,
        runAgent: async () => {
          throw new Error("must not dispatch");
        },
      }),
    ).rejects.toThrow("Process isolation");
    await expect(store.listRunIds()).resolves.toEqual([]);
  });

  it("drains active execution before committing cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const controller = new DurableWorkflowController({ store, owner });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let drained = false;
    const execution = runDurableWorkflowPlan({
      store,
      owner,
      runId: "drain-run",
      plan: {
        ...plan,
        phases: [{ ...plan.phases[0], tasks: [plan.phases[0].tasks[0]] }],
      },
      runAgent: async ({ signal }) => {
        signalStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              drained = true;
              resolve();
            },
            { once: true },
          );
        });
        return success("late");
      },
    });
    await started;

    const cancelled = await controller.cancel("drain-run");
    expect(drained).toBe(true);
    expect(cancelled?.status).toBe("cancelled");
    const eventCount = (await store.readRun("drain-run")).events.length;
    await expect(controller.cancel("drain-run")).resolves.toMatchObject({
      status: "cancelled",
    });
    expect((await store.readRun("drain-run")).events).toHaveLength(eventCount);
    await execution;
  });
  it("drains session shutdown as an interruption and resumes committed work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const calls: string[] = [];
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    const execution = runDurableWorkflowPlan({
      store,
      owner,
      runId: "shutdown-run",
      plan,
      runAgent: async ({ prompt, signal }) => {
        calls.push(prompt);
        if (prompt === "A") return success("done:A");
        signalStarted();
        return new Promise<SubagentResult>((_, reject) => {
          const abort = () => reject(new Error("provider aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    await started;

    const drained = await drainActiveDurableExecutions(
      owner,
      "session_shutdown",
    );
    expect(drained).toHaveLength(1);
    expect(drained[0]?.status).toBe("interrupted");
    await expect(execution).resolves.toMatchObject({ status: "interrupted" });

    const interrupted = await new DurableWorkflowController({
      store,
      owner,
    }).getStatus("shutdown-run");
    expect(interrupted?.status).toBe("interrupted");
    expect(interrupted?.tasks.a).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(interrupted?.tasks.b).toMatchObject({
      status: "running",
      attempt: 1,
    });

    const resumed = await runDurableWorkflowPlan({
      store,
      owner,
      runId: "shutdown-run",
      plan,
      resume: true,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        return success(`done:${prompt}`);
      },
    });
    expect(resumed.status).toBe("done");
    expect(resumed.tasks.a).toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    expect(resumed.tasks.b).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(calls).toEqual(["A", "B", "B"]);
  });
});
