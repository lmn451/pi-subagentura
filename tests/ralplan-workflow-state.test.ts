import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorkflowTool } from "../src/workflow-tool";
import { workflowJobRegistry } from "../src/workflow-jobs";
import {
  clearRalplanBindingsForTests,
  getRalplanRunById,
  listRalplanRuns,
} from "../src/ralplan-state";
import {
  clearSessionScopes,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";
import {
  clearCompletionCoordinator,
  registerCompletionCoordinator,
} from "../src/completion-coordinator";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-workflow-state-"));
  roots.push(value);
  return value;
}

function setup(cwd: string) {
  const tools: Record<string, any> = {};
  const entries: unknown[] = [];
  const pi = {
    registerTool: vi.fn((tool: any) => {
      tools[tool.name] = tool;
    }),
    registerCommand: vi.fn(),
    appendEntry: vi.fn((_type: string, value: unknown) => entries.push(value)),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  } as any;
  const scope = registerSessionScope({
    id: 77,
    generation: 1,
    pi,
    cwd,
    lifecycle: "started",
    sessionManager: {
      getSessionId: () => "parent-session",
      getEntries: () => entries,
    },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  }) as SessionScope;
  registerCompletionCoordinator(pi, scope);
  registerWorkflowTool(pi, scope);
  return { tools, scope };
}

function script(cwd: string): string {
  return `export const meta = { name: "ralplan-occ", description: "test" };
return {
  status: "pending_approval",
  consensus: true,
  pending_approval: true,
  execution_halted: true,
  planDigest: "plan-digest",
  sourceDraftDigest: "draft-digest",
  artifactPaths: {
    plan: ${JSON.stringify(join(cwd, "plans", "plan.md"))},
    drafts: [],
    architectReviews: [],
    criticReviews: []
  }
};`;
}

afterEach(() => {
  workflowJobRegistry.clear();
  clearRalplanBindingsForTests();
  for (const scope of [] as SessionScope[]) clearCompletionCoordinator(scope);
  clearSessionScopes();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow RALPLAN state integration", () => {
  it("persists sync RALPLAN completion and returns its run id", async () => {
    const cwd = root();
    const { tools } = setup(cwd);
    const result = await tools.workflow.execute(
      "call",
      { script: script(cwd), async: false },
      undefined,
      vi.fn(),
      { cwd, model: undefined, modelRegistry: undefined },
    );

    expect(result).toMatchObject({
      details: { status: "done", ralplanRunId: expect.stringMatching(/^rp_/) },
    });
    const record = getRalplanRunById(cwd, result.details.ralplanRunId);
    expect(record).toMatchObject({
      phase: "pending_approval",
      approvalStatus: "pending",
      active: true,
      planDigest: "plan-digest",
      parentSessionId: "parent-session",
    });
  });

  it("persists background completion before result collection", async () => {
    const cwd = root();
    const { tools } = setup(cwd);
    const started = await tools.workflow.execute(
      "call",
      { script: script(cwd), async: true },
      undefined,
      vi.fn(),
      { cwd, model: undefined, modelRegistry: undefined },
    );
    expect(started.details.ralplanRunId).toMatch(/^rp_/);
    const job = workflowJobRegistry.get(started.details.workflowId)!;
    await job.promise;

    expect(getRalplanRunById(cwd, started.details.ralplanRunId)).toMatchObject({
      phase: "pending_approval",
      planDigest: "plan-digest",
    });
    const collected = await tools.get_workflow_result.execute("result", {
      workflowId: started.details.workflowId,
    });
    expect(collected.details.ralplanRunId).toBe(started.details.ralplanRunId);
  });

  it("marks a failed RALPLAN workflow terminal without approval", async () => {
    const cwd = root();
    const { tools } = setup(cwd);
    const failedScript = `export const meta = { name: "ralplan-consensus", description: "test" }; throw new Error("boom");`;
    const result = await tools.workflow.execute(
      "call",
      { script: failedScript, async: false },
      undefined,
      vi.fn(),
      { cwd, model: undefined, modelRegistry: undefined },
    );

    expect(result.isError).toBe(true);
    expect(listRalplanRuns(cwd, {})).toEqual([
      expect.objectContaining({
        phase: "failed",
        approvalStatus: "unavailable",
        active: false,
      }),
    ]);
  });
});
