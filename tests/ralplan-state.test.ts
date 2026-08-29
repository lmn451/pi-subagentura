import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveRalplanRun,
  clearRalplanBindingsForTests,
  completeRalplanRun,
  createRalplanRun,
  failRalplanRun,
  getRalplanRunById,
  getRalplanRunForWorkflow,
  interruptRalplanRuns,
  listRalplanRuns,
  markRalplanReviewing,
  prepareRalplanRecovery,
  ralplanStatePath,
  rejectRalplanRun,
} from "../src/ralplan-state";
import type { SessionOwnerToken } from "../src/session-scope";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-state-"));
  roots.push(value);
  return value;
}

function owner(id = 7, generation = 2): SessionOwnerToken {
  return { id, generation };
}

function successfulResult(planPath: string) {
  return {
    status: "pending_approval",
    consensus: true,
    pending_approval: true,
    execution_halted: true,
    planDigest: "abc123",
    sourceDraftDigest: "draft123",
    artifactPaths: {
      plan: planPath,
      drafts: [planPath.replace("plan.md", "drafts/plan_draft-r1.md")],
      architectReviews: [
        planPath.replace("plan.md", "drafts/architect_review-r1.md"),
      ],
      criticReviews: [
        planPath.replace("plan.md", "drafts/critic_review-r1.md"),
      ],
    },
  };
}

afterEach(() => {
  clearRalplanBindingsForTests();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RALPLAN persisted state", () => {
  it("writes bounded mode-0600 state atomically and updates to pending approval", () => {
    const cwd = root();
    const created = createRalplanRun({
      cwd,
      workflowId: "wf_one",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
      now: 100,
    });
    const reviewing = markRalplanReviewing({
      cwd,
      workflowId: "wf_one",
      now: 150,
    });
    const completed = completeRalplanRun({
      cwd,
      workflowId: "wf_one",
      result: successfulResult(join(cwd, "plans", "plan.md")),
      now: 200,
    });

    expect(created.phase).toBe("planning");
    expect(reviewing).toMatchObject({ phase: "reviewing", updatedAt: 150 });
    expect(completed).toMatchObject({
      runId: created.runId,
      phase: "pending_approval",
      approvalStatus: "pending",
      active: true,
      planDigest: "abc123",
      updatedAt: 200,
    });
    const path = ralplanStatePath(cwd);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      records: [{ runId: created.runId }],
    });
    expect(getRalplanRunForWorkflow(cwd, "wf_one")?.runId).toBe(created.runId);
  });

  it("binds approval to exact owner, session, run, and plan digest", () => {
    const cwd = root();
    const created = createRalplanRun({
      cwd,
      workflowId: "wf_two",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
      now: 1,
    });
    completeRalplanRun({
      cwd,
      workflowId: "wf_two",
      result: successfulResult(join(cwd, "plans", "plan.md")),
      now: 2,
    });

    expect(() =>
      approveRalplanRun({
        cwd,
        runId: created.runId,
        planDigest: "wrong",
        owner: owner(),
        parentSessionId: "session-a",
        now: 3,
      }),
    ).toThrow(/digest/i);
    expect(() =>
      approveRalplanRun({
        cwd,
        runId: created.runId,
        planDigest: "abc123",
        owner: owner(7, 3),
        parentSessionId: "session-a",
        now: 3,
      }),
    ).toThrow(/owner/i);
    expect(() =>
      approveRalplanRun({
        cwd,
        runId: created.runId,
        planDigest: "abc123",
        owner: owner(),
        parentSessionId: "session-b",
        now: 3,
      }),
    ).toThrow(/session/i);

    const approved = approveRalplanRun({
      cwd,
      runId: created.runId,
      planDigest: "abc123",
      owner: owner(),
      parentSessionId: "session-a",
      now: 4,
    });
    expect(approved).toMatchObject({
      phase: "approved_handoff",
      approvalStatus: "approved",
      active: false,
      updatedAt: 4,
    });
    expect(() =>
      approveRalplanRun({
        cwd,
        runId: created.runId,
        planDigest: "abc123",
        owner: owner(),
        parentSessionId: "session-a",
      }),
    ).toThrow(/pending/i);
  });

  it("rejects a pending plan without executing it", () => {
    const cwd = root();
    const created = createRalplanRun({
      cwd,
      workflowId: "wf_reject",
      workflowName: "ralplan-consensus",
      owner: owner(),
      parentSessionId: "session-a",
    });
    completeRalplanRun({
      cwd,
      workflowId: "wf_reject",
      result: successfulResult(join(cwd, "plans", "plan.md")),
    });

    const rejected = rejectRalplanRun({
      cwd,
      runId: created.runId,
      owner: owner(),
      parentSessionId: "session-a",
      reason: "scope changed",
    });
    expect(rejected).toMatchObject({
      phase: "rejected",
      approvalStatus: "rejected",
      active: false,
      deactivationReason: "scope changed",
    });
  });

  it("persists capped, failed, and interrupted terminal evidence", () => {
    const cwd = root();
    const capped = createRalplanRun({
      cwd,
      workflowId: "wf_capped",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
    });
    completeRalplanRun({
      cwd,
      workflowId: "wf_capped",
      result: {
        status: "no_consensus",
        consensus: false,
        capped: true,
        artifactPaths: { plan: join(cwd, "plans", "plan.md") },
      },
    });
    expect(getRalplanRunById(cwd, capped.runId)?.phase).toBe("capped");

    const failed = createRalplanRun({
      cwd,
      workflowId: "wf_failed",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
    });
    failRalplanRun({ cwd, workflowId: "wf_failed", reason: "agent failed" });
    expect(getRalplanRunById(cwd, failed.runId)).toMatchObject({
      phase: "failed",
      active: false,
      deactivationReason: "agent failed",
    });

    const interrupted = createRalplanRun({
      cwd,
      workflowId: "wf_running",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
    });
    interruptRalplanRuns({
      cwd,
      owner: owner(),
      lifecycleReason: "reload",
      now: 20,
    });
    expect(getRalplanRunById(cwd, interrupted.runId)).toMatchObject({
      phase: "interrupted",
      active: false,
      deactivationReason: "session reload",
    });
  });

  it("allows read-only recovery evidence only for the same parent session", () => {
    const cwd = root();
    const created = createRalplanRun({
      cwd,
      workflowId: "wf_recover",
      workflowName: "ralplan-occ",
      owner: owner(),
      parentSessionId: "session-a",
    });
    completeRalplanRun({
      cwd,
      workflowId: "wf_recover",
      result: successfulResult(join(cwd, "plans", "plan.md")),
    });
    interruptRalplanRuns({
      cwd,
      owner: owner(),
      lifecycleReason: "quit",
    });

    expect(
      listRalplanRuns(cwd, {
        owner: owner(7, 3),
        parentSessionId: "session-a",
      }).map((record) => record.runId),
    ).toContain(created.runId);
    expect(
      listRalplanRuns(cwd, {
        owner: owner(8, 1),
        parentSessionId: "session-b",
      }),
    ).toEqual([]);
    const recovery = prepareRalplanRecovery({
      cwd,
      runId: created.runId,
      parentSessionId: "session-a",
    });
    expect(recovery).toMatchObject({
      runId: created.runId,
      readOnly: true,
      automaticResume: false,
      planDigest: "abc123",
    });
    expect(recovery).not.toHaveProperty("execute");
  });

  it("rejects oversized or malformed persisted state", () => {
    const cwd = root();
    const path = ralplanStatePath(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(path, "x".repeat(1_100_000), { mode: 0o600 });
    expect(() => listRalplanRuns(cwd, {})).toThrow(/too large/i);

    writeFileSync(path, "{}", { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => listRalplanRuns(cwd, {})).toThrow(/schema/i);
  });

  it("rejects symbolic-link state files", () => {
    const cwd = root();
    const path = ralplanStatePath(cwd);
    const target = join(cwd, "target.json");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(target, JSON.stringify({ schemaVersion: 1, records: [] }), {
      mode: 0o600,
    });
    symlinkSync(target, path);

    expect(() => listRalplanRuns(cwd, {})).toThrow(/symbolic link/i);
  });
});
