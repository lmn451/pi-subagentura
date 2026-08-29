import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveExecutionPreview,
  beginNextExecutionOperation,
  clearExecutionBindingsForTests,
  commitExecutionOperation,
  createExecutionPreview,
  getExecutionRecord,
  interruptExecutionsForOwner,
  listExecutionRecords,
  resolveUnknownExecutionOperation,
  resumeExecutionRecord,
  runStorePath,
  startExecutionRecord,
} from "../src/workflow-run-store";
import type { RalplanRunRecord } from "../src/ralplan-state";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "workflow-run-store-"));
  roots.push(value);
  return value;
}

function approvedPlan(cwd: string): RalplanRunRecord {
  return {
    runId: "rp_aaaaaaaaaaaaaaaaaaaa",
    workflowId: "wf_plan",
    workflowName: "ralplan-occ",
    cwd,
    owner: { id: 1, generation: 1 },
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
    sourceDraftDigest: "draft-digest",
    createdAt: 1,
    updatedAt: 2,
    deactivationReason: "explicit host approval recorded",
  };
}

function tasks() {
  return [
    {
      id: "task-a",
      phase: "implementation",
      title: "Implement A",
      prompt: "Implement only approved task A and verify it.",
      dependsOn: [],
    },
    {
      id: "task-b",
      phase: "verification",
      title: "Verify B",
      prompt: "Verify approved task B without expanding scope.",
      dependsOn: ["task-a"],
    },
  ];
}

afterEach(() => {
  clearExecutionBindingsForTests();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("durable declarative execution store", () => {
  it("persists a mode-0600 preview without starting execution", () => {
    const cwd = root();
    const record = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
      now: 10,
    });

    expect(record).toMatchObject({
      status: "pending_execution_approval",
      executionApproved: false,
      active: true,
      revision: 1,
      taskStates: [
        { taskId: "task-a", status: "pending" },
        { taskId: "task-b", status: "pending" },
      ],
    });
    expect(record).not.toHaveProperty("lease");
    const path = runStorePath(cwd, record.executionId);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      executionId: record.executionId,
    });
  });

  it("requires exact revision, owner, session, and plan digest for execution approval", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });

    expect(() =>
      approveExecutionPreview({
        cwd,
        executionId: preview.executionId,
        expectedRevision: 2,
        planDigest: "plan-digest",
        owner: { id: 1, generation: 1 },
        parentSessionId: "session-a",
      }),
    ).toThrow(/revision/i);
    expect(() =>
      approveExecutionPreview({
        cwd,
        executionId: preview.executionId,
        expectedRevision: 1,
        planDigest: "wrong",
        owner: { id: 1, generation: 1 },
        parentSessionId: "session-a",
      }),
    ).toThrow(/digest/i);
    expect(() =>
      approveExecutionPreview({
        cwd,
        executionId: preview.executionId,
        expectedRevision: 1,
        planDigest: "plan-digest",
        owner: { id: 1, generation: 2 },
        parentSessionId: "session-a",
      }),
    ).toThrow(/owner/i);

    const approved = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: 1,
      planDigest: "plan-digest",
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      now: 20,
    });
    expect(approved).toMatchObject({
      status: "approved",
      executionApproved: true,
      revision: 2,
      active: true,
      updatedAt: 20,
    });
  });

  it("fences stale workers by owner epoch and revision", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });
    const approved = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: preview.revision,
      planDigest: "plan-digest",
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    const running = startExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: approved.revision,
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    const operation = beginNextExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      owner: { id: 1, generation: 1 },
    });

    interruptExecutionsForOwner({
      cwd,
      owner: { id: 1, generation: 1 },
      lifecycleReason: "quit",
    });
    expect(() =>
      commitExecutionOperation({
        cwd,
        executionId: preview.executionId,
        operationId: operation!.operationId,
        leaseEpoch: running.lease!.epoch,
        owner: { id: 1, generation: 1 },
        summary: "late",
        outputDigest: "late-digest",
      }),
    ).toThrow(/lease|running/i);
  });

  it("turns in-flight operations unknown and requires explicit resolution before resume", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });
    const approved = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: 1,
      planDigest: "plan-digest",
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    const running = startExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: approved.revision,
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    const operation = beginNextExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      owner: { id: 1, generation: 1 },
    })!;
    const [interrupted] = interruptExecutionsForOwner({
      cwd,
      owner: { id: 1, generation: 1 },
      lifecycleReason: "quit",
    });
    expect(interrupted.taskStates[0]).toMatchObject({
      status: "unknown",
      operationId: operation.operationId,
    });
    expect(() =>
      resumeExecutionRecord({
        cwd,
        executionId: preview.executionId,
        expectedRevision: interrupted.revision,
        owner: { id: 1, generation: 2 },
        parentSessionId: "session-a",
      }),
    ).toThrow(/unknown/i);

    expect(() =>
      resolveUnknownExecutionOperation({
        cwd,
        executionId: preview.executionId,
        expectedRevision: interrupted.revision,
        operationId: operation.operationId,
        parentSessionId: "session-a",
        owner: { id: 2, generation: 1 },
        resolution: "retry",
        evidence: "wrong owner",
      }),
    ).toThrow(/owner identity/i);

    const resolved = resolveUnknownExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: interrupted.revision,
      operationId: operation.operationId,
      parentSessionId: "session-a",
      owner: { id: 1, generation: 2 },
      resolution: "retry",
      evidence: "verified no committed outcome",
    });
    const resumed = resumeExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: resolved.revision,
      owner: { id: 1, generation: 2 },
      parentSessionId: "session-a",
    });
    expect(resumed).toMatchObject({
      status: "approved",
      active: true,
      owner: { id: 1, generation: 2 },
    });
    expect(resumed.taskStates[0]).toMatchObject({ status: "pending" });
  });

  it("loads cold projections without a live process registry", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });
    clearExecutionBindingsForTests();

    expect(getExecutionRecord(cwd, preview.executionId)?.executionId).toBe(
      preview.executionId,
    );
    expect(
      listExecutionRecords(cwd, { parentSessionId: "session-a" }),
    ).toHaveLength(1);
    expect(listExecutionRecords(cwd, { parentSessionId: "session-b" })).toEqual(
      [],
    );
  });

  it("rejects unbounded, duplicate, or forward-dependent declarative tasks", () => {
    const cwd = root();
    const base = {
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
    };
    expect(() =>
      createExecutionPreview({
        ...base,
        tasks: [...tasks(), { ...tasks()[0], dependsOn: ["task-b"] }],
      }),
    ).toThrow(/duplicate|dependencies/i);
    expect(() =>
      createExecutionPreview({
        ...base,
        tasks: [
          {
            id: "task-forward",
            phase: "implementation",
            title: "Forward",
            prompt: "Forward dependency",
            dependsOn: ["later"],
          },
        ],
      }),
    ).toThrow(/earlier tasks/i);
    expect(() =>
      createExecutionPreview({
        ...base,
        tasks: Array.from({ length: 33 }, (_, index) => ({
          id: `task-${index}`,
          phase: "implementation",
          title: `Task ${index}`,
          prompt: "bounded",
          dependsOn: [],
        })),
      }),
    ).toThrow(/1-32 tasks/i);
    expect(() =>
      createExecutionPreview({
        ...base,
        tasks: [
          {
            id: "task-large",
            phase: "implementation",
            title: "Large",
            prompt: "x".repeat(20_001),
            dependsOn: [],
          },
        ],
      }),
    ).toThrow(/too large/i);
  });

  it("rejects a symlinked project .pi directory", () => {
    const cwd = root();
    const outside = root();
    symlinkSync(outside, join(cwd, ".pi"));

    expect(() =>
      createExecutionPreview({
        cwd,
        ralplan: approvedPlan(cwd),
        owner: { id: 1, generation: 1 },
        parentSessionId: "session-a",
        planDigest: "plan-digest",
        tasks: tasks(),
      }),
    ).toThrow(/real directory/i);
  });

  it("serializes mutations with a per-record lock", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });
    writeFileSync(
      `${runStorePath(cwd, preview.executionId)}.lock`,
      `${process.pid}\n`,
      {
        mode: 0o600,
      },
    );

    expect(() =>
      approveExecutionPreview({
        cwd,
        executionId: preview.executionId,
        expectedRevision: preview.revision,
        planDigest: "plan-digest",
        owner: { id: 1, generation: 1 },
        parentSessionId: "session-a",
      }),
    ).toThrow(/locked/i);
    expect(getExecutionRecord(cwd, preview.executionId)?.revision).toBe(1);
  });

  it("recovers an orphaned lock only when its process is gone", () => {
    const cwd = root();
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan(cwd),
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
      planDigest: "plan-digest",
      tasks: tasks(),
    });
    writeFileSync(
      `${runStorePath(cwd, preview.executionId)}.lock`,
      "99999999\n",
      { mode: 0o600 },
    );

    const approved = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: preview.revision,
      planDigest: "plan-digest",
      owner: { id: 1, generation: 1 },
      parentSessionId: "session-a",
    });
    expect(approved.status).toBe("approved");
  });
});
