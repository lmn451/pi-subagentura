import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { runDurableWorkflowPlan } from "../src/workflow-durable-plan-runner";
import { WorkflowSessionDispatcher } from "../src/workflow-dispatcher";
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

const failure = (message: string): SubagentResult => ({
  isError: true,
  output: "",
  usage: success("ignored").usage,
  errorMessage: message,
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable workflow stop-on-failure admission", () => {
  it("F10 stops admitting new parallel siblings after failure while draining running work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-stop-failure-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const dispatcher = new WorkflowSessionDispatcher({ maxConcurrent: 2 });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "stop-on-failure",
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
    };
    const calls: string[] = [];
    let startB!: () => void;
    const bStarted = new Promise<void>((resolve) => {
      startB = resolve;
    });
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let returnedA!: () => void;
    const aReturned = new Promise<void>((resolve) => {
      returnedA = resolve;
    });

    const resultPromise = runDurableWorkflowPlan({
      store,
      owner,
      runId: "stop-on-failure",
      plan,
      dispatcher,
      runAgent: async ({ prompt }) => {
        calls.push(prompt);
        if (prompt === "A") {
          await bStarted;
          returnedA();
          return failure("A failed");
        }
        if (prompt === "B") {
          startB();
          await bGate;
          return success("B completed");
        }
        return success("C must not be admitted");
      },
    });

    await aReturned;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["A", "B"]);
    releaseB();

    await expect(resultPromise).resolves.toMatchObject({
      status: "error",
      terminal: {
        status: "error",
        error: { code: "task_failed", message: "A failed" },
      },
    });
    expect(calls).toEqual(["A", "B"]);
  });

  it("F10 selects the plan-order failure after parallel siblings drain", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-stop-failure-"));
    roots.push(root);
    const store = new WorkflowRunStore({ rootDir: root, owner });
    const dispatcher = new WorkflowSessionDispatcher({ maxConcurrent: 2 });
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "deterministic-failure",
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
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let bReturned!: () => void;
    const bFinished = new Promise<void>((resolve) => {
      bReturned = resolve;
    });

    const resultPromise = runDurableWorkflowPlan({
      store,
      owner,
      runId: "deterministic-failure",
      plan,
      dispatcher,
      runAgent: async ({ prompt }) => {
        if (prompt === "A") {
          await aGate;
          return failure("A plan-order failure");
        }
        bReturned();
        return failure("B completed first");
      },
    });

    await bFinished;
    releaseA();
    await expect(resultPromise).resolves.toMatchObject({
      status: "error",
      terminal: {
        status: "error",
        error: { code: "task_failed", message: "A plan-order failure" },
      },
    });
  });
});
