import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionScope,
  releaseDurableWorkflowAuthority,
} from "../src/session-scope";
import {
  resumeDurableWorkflowForSession,
  runDurableWorkflowForSession,
} from "../src/workflow-owner";
import { DurableWorkflowController } from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { SubagentResult } from "../src/helpers";

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
  name: "restart-recovery",
  phases: [
    {
      id: "phase",
      mode: "sequential",
      tasks: [{ id: "task", prompt: "task" }],
    },
  ],
};
const success = (): SubagentResult => ({
  isError: false,
  output: "recovered",
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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("reconstructed durable workflow owners", () => {
  it("F02 resumes a persisted run through a reconstructed session owner and rejects a foreign store", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-owner-restart-"));
    roots.push(root);
    const firstScope = createSessionScope({} as any);
    firstScope.durableWorkflowOwner = owner;
    await expect(
      runDurableWorkflowForSession(root, firstScope, {
        runId: "restart-run",
        plan,
        runAgent: async () => {
          throw new Error("simulated parent restart");
        },
      }),
    ).rejects.toThrow("simulated parent restart");
    await releaseDurableWorkflowAuthority(firstScope);

    const restartedScope = createSessionScope({} as any);
    restartedScope.durableWorkflowOwner = { ...owner };
    const calls: string[] = [];
    const recovered = await resumeDurableWorkflowForSession(
      root,
      restartedScope,
      {
        runId: "restart-run",
        runAgent: async ({ prompt }) => {
          calls.push(prompt);
          return success();
        },
      },
    );

    expect(recovered.status).toBe("done");
    expect(recovered.tasks.task).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
    expect(calls).toEqual(["task"]);

    await releaseDurableWorkflowAuthority(restartedScope);
    const foreignOwner = {
      ...owner,
      ownerId: "foreign-owner",
      leaseToken: "foreign-lease",
    };
    const foreignStore = new WorkflowRunStore({
      rootDir: root,
      owner: foreignOwner,
    });
    const foreignController = new DurableWorkflowController({
      store: foreignStore,
      owner: foreignOwner,
    });
    await expect(foreignController.getStatus("restart-run")).rejects.toThrow(
      "different owner",
    );
  });
});
