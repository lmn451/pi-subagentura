import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveExecutionPreview,
  beginNextExecutionOperation,
  clearExecutionBindingsForTests,
  createExecutionPreview,
  getExecutionRecord,
  interruptExecutionsForOwner,
  resolveUnknownExecutionOperation,
  resumeExecutionRecord,
  startExecutionRecord,
} from "../src/workflow-run-store";
import { runDurableExecution } from "../src/workflow-plan-runner";
import type { RalplanRunRecord } from "../src/ralplan-state";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "workflow-durable-crash-"));
  roots.push(value);
  return value;
}

function approvedPlan(cwd: string): RalplanRunRecord {
  return {
    runId: "rp_cccccccccccccccccccc",
    workflowId: "wf_plan",
    workflowName: "ralplan-occ",
    cwd,
    owner: { id: 4, generation: 1 },
    parentSessionId: "session-a",
    phase: "approved_handoff",
    approvalStatus: "approved",
    active: false,
    artifactPaths: {
      plan: join(cwd, "plans", "plan.md"),
      drafts: [],
      architectReviews: [],
      criticReviews: [],
    },
    planDigest: "plan-digest",
    createdAt: 1,
    updatedAt: 2,
  };
}

afterEach(() => {
  clearExecutionBindingsForTests();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("durable crash-prefix recovery", () => {
  it("requires trusted resolution for an operation with unknown side effects", async () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      planDigest: "plan-digest",
      owner: { id: 4, generation: 1 },
      parentSessionId: "session-a",
      tasks: [
        {
          id: "mutate-a",
          phase: "implementation",
          title: "Mutate A",
          prompt: "Perform approved mutation A",
          dependsOn: [],
        },
        {
          id: "verify-b",
          phase: "verification",
          title: "Verify B",
          prompt: "Verify B",
          dependsOn: ["mutate-a"],
        },
      ],
    });
    const approved = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: preview.revision,
      planDigest: "plan-digest",
      owner: { id: 4, generation: 1 },
      parentSessionId: "session-a",
    });
    const running = startExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: approved.revision,
      owner: { id: 4, generation: 1 },
      parentSessionId: "session-a",
    });
    const operation = beginNextExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      owner: { id: 4, generation: 1 },
    })!;

    interruptExecutionsForOwner({
      cwd,
      owner: { id: 4, generation: 1 },
      lifecycleReason: "quit",
    });
    clearExecutionBindingsForTests();
    const cold = getExecutionRecord(cwd, preview.executionId)!;
    expect(cold.taskStates[0]).toMatchObject({
      status: "unknown",
      operationId: operation.operationId,
    });

    const accepted = resolveUnknownExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: cold.revision,
      operationId: operation.operationId,
      parentSessionId: "session-a",
      owner: { id: 4, generation: 2 },
      resolution: "accept",
      evidence: "operator verified mutation A and tests",
      outputDigest: "operator-evidence-digest",
    });
    const resumed = resumeExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: accepted.revision,
      owner: { id: 4, generation: 2 },
      parentSessionId: "session-a",
    });
    const calls: string[] = [];
    const completed = await runDurableExecution({
      cwd,
      executionId: preview.executionId,
      expectedRevision: resumed.revision,
      owner: { id: 4, generation: 2 },
      parentSessionId: "session-a",
      runTask: async ({ task }) => {
        calls.push(task.id);
        return { summary: "verified", outputDigest: "verify-digest" };
      },
    });

    expect(calls).toEqual(["verify-b"]);
    expect(completed.status).toBe("completed");
    expect(completed.exactlyOnce).toBe(false);
  });
});
