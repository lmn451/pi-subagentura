import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRalplanTools } from "../src/ralplan-tool";
import {
  clearRalplanBindingsForTests,
  completeRalplanRun,
  createRalplanRun,
  getRalplanRunById,
  interruptRalplanRuns,
} from "../src/ralplan-state";
import { workflowJobRegistry } from "../src/workflow-jobs";
import type { SessionScope } from "../src/session-scope";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-tools-"));
  roots.push(value);
  return value;
}

function setup(cwd: string, generation = 1) {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool: vi.fn((tool: any) => {
      tools[tool.name] = tool;
    }),
  } as any;
  const scope: SessionScope = {
    id: 9,
    generation,
    pi,
    cwd,
    lifecycle: "started",
    sessionManager: { getSessionId: () => "session-a" },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  };
  registerRalplanTools(pi, scope);
  return { tools, scope };
}

function pending(cwd: string, workflowId: string) {
  const record = createRalplanRun({
    cwd,
    workflowId,
    workflowName: "ralplan-occ",
    owner: { id: 9, generation: 1 },
    parentSessionId: "session-a",
  });
  completeRalplanRun({
    cwd,
    workflowId,
    result: {
      status: "pending_approval",
      consensus: true,
      pending_approval: true,
      execution_halted: true,
      planDigest: "digest-a",
      sourceDraftDigest: "draft-a",
      artifactPaths: {
        plan: join(cwd, "plans", "plan.md"),
        drafts: [],
        architectReviews: [],
        criticReviews: [],
      },
    },
  });
  return record;
}

afterEach(() => {
  clearRalplanBindingsForTests();
  workflowJobRegistry.clear();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RALPLAN host tools", () => {
  it("registers explicit status, approval, rejection, cancellation, and recovery tools", () => {
    const { tools } = setup(root());
    expect(Object.keys(tools).sort()).toEqual([
      "approve_ralplan",
      "cancel_ralplan",
      "get_ralplan_status",
      "prepare_ralplan_recovery",
      "reject_ralplan",
    ]);
  });

  it("requires exact digest and deactivates before approved handoff", async () => {
    const cwd = root();
    const { tools } = setup(cwd);
    const record = pending(cwd, "wf_approve");

    const mismatch = await tools.approve_ralplan.execute("approve", {
      runId: record.runId,
      planDigest: "wrong",
    });
    expect(mismatch).toMatchObject({
      isError: true,
      details: { status: "error" },
    });

    const approved = await tools.approve_ralplan.execute("approve", {
      runId: record.runId,
      planDigest: "digest-a",
    });
    expect(approved).toMatchObject({
      details: {
        status: "approved_handoff",
        runId: record.runId,
        executionStarted: false,
      },
    });
    expect(getRalplanRunById(cwd, record.runId)).toMatchObject({
      active: false,
      phase: "approved_handoff",
    });
  });

  it("keeps stale generations from approving or rejecting current runs", async () => {
    const cwd = root();
    const record = pending(cwd, "wf_stale");
    const { tools } = setup(cwd, 2);

    const approved = await tools.approve_ralplan.execute("approve", {
      runId: record.runId,
      planDigest: "digest-a",
    });
    const rejected = await tools.reject_ralplan.execute("reject", {
      runId: record.runId,
      reason: "stale",
    });
    expect(approved.isError).toBe(true);
    expect(rejected.isError).toBe(true);
    expect(getRalplanRunById(cwd, record.runId)?.active).toBe(true);
  });

  it("cancels only its owned active workflow and persists cancellation", async () => {
    const cwd = root();
    const { tools } = setup(cwd);
    const record = createRalplanRun({
      cwd,
      workflowId: "wf_cancel",
      workflowName: "ralplan-occ",
      owner: { id: 9, generation: 1 },
      parentSessionId: "session-a",
    });
    const abort = new AbortController();
    workflowJobRegistry.set("wf_cancel", {
      id: "wf_cancel",
      name: "ralplan-occ",
      status: "running",
      executionMode: "async",
      startedAt: Date.now(),
      promise: new Promise(() => {}),
      abort,
      snapshot: { agentsSpawned: 0, errorCount: 0, tokensSpent: 0, phases: [] },
      parentSessionOwner: { id: 9, generation: 1 },
    });

    const cancelled = await tools.cancel_ralplan.execute("cancel", {
      runId: record.runId,
    });
    expect(cancelled).toMatchObject({
      details: { status: "cancelled", runId: record.runId },
    });
    expect(abort.signal.aborted).toBe(true);
    expect(getRalplanRunById(cwd, record.runId)).toMatchObject({
      phase: "cancelled",
      active: false,
    });
  });

  it("surfaces same-session interrupted evidence as read-only recovery", async () => {
    const cwd = root();
    const { tools } = setup(cwd, 2);
    const record = pending(cwd, "wf_recovery");
    interruptRalplanRuns({
      cwd,
      owner: { id: 9, generation: 1 },
      lifecycleReason: "reload",
    });

    const status = await tools.get_ralplan_status.execute("status", {
      runId: record.runId,
    });
    const recovery = await tools.prepare_ralplan_recovery.execute("recover", {
      runId: record.runId,
    });
    expect(status).toMatchObject({
      details: { status: "ok", records: [{ phase: "interrupted" }] },
    });
    expect(recovery).toMatchObject({
      details: {
        status: "recovery_ready",
        readOnly: true,
        automaticResume: false,
      },
    });
  });
});
