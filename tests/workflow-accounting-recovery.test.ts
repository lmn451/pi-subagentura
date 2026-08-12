import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runDurableWorkflowPlan } from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
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
const plan: WorkflowPlan = {
  schemaVersion: 1,
  name: "accounting-replay",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "task" }],
    },
  ],
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable interrupted attempt accounting", () => {
  it("F11 records interrupted usage as a lower bound and replays with a new attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-accounting-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const originalAppendIfCurrent = store.appendIfCurrent.bind(store);
    vi.spyOn(store, "appendIfCurrent").mockImplementation(
      async (...args: Parameters<WorkflowRunStore["appendIfCurrent"]>) => {
        if (args[2] === "task_succeeded")
          throw new Error("crash after usage commit");
        return originalAppendIfCurrent(...args);
      },
    );

    await expect(
      runDurableWorkflowPlan({
        store,
        owner,
        runId: "accounting-replay",
        plan,
        runAgent: async () => success("first attempt"),
      }),
    ).rejects.toThrow("crash after usage commit");

    vi.restoreAllMocks();
    const interrupted = await store.readRun("accounting-replay");
    expect(interrupted.events.at(-1)?.type).toBe("run_interrupted");
    expect(
      interrupted.events.filter((event) => event.type === "usage_observed"),
    ).toHaveLength(1);
    expect(interrupted.events.at(-2)?.payload).toMatchObject({
      taskId: "task",
      attempt: 1,
      input: 1,
      output: 1,
    });

    await store.release();
    const restartedStore = new WorkflowRunStore({ rootDir: root, owner });
    const recovered = await runDurableWorkflowPlan({
      store: restartedStore,
      owner,
      runId: "accounting-replay",
      plan,
      resume: true,
      runAgent: async () => success("replayed attempt"),
    });

    expect(recovered.status).toBe("done");
    expect(recovered.usage).toEqual({ input: 2, output: 2 });
    expect(recovered.usageLowerBound).toBe(true);
    expect(recovered.tasks.task).toMatchObject({
      status: "succeeded",
      attempt: 2,
      result: "replayed attempt",
    });
    const events = (await restartedStore.readRun("accounting-replay")).events;
    expect(
      events
        .filter((event) => event.type === "usage_observed")
        .map((event) => (event.payload as { attempt: number }).attempt),
    ).toEqual([1, 2]);
  });
});
