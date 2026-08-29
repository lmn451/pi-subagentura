import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionHandlers } from "../src/session-handlers";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import {
  approveRalplanRun,
  clearRalplanBindingsForTests,
  completeRalplanRun,
  createRalplanRun,
} from "../src/ralplan-state";
import {
  approveExecutionPreview,
  beginNextExecutionOperation,
  clearExecutionBindingsForTests,
  createExecutionPreview,
  getExecutionRecord,
  startExecutionRecord,
} from "../src/workflow-run-store";
import { executionJobsForTests } from "../src/ralplan-execution-tool";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-exec-lifecycle-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
  if (handle) clearInterval(handle);
  (globalThis as any).__piSubagenturaInteractivePollerHandle = undefined;
  executionJobsForTests().clear();
  clearExecutionBindingsForTests();
  clearRalplanBindingsForTests();
  clearSessionScopes();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("durable execution lifecycle", () => {
  it("aborts the live runner before persisting interrupted unknown evidence", () => {
    const cwd = root();
    const handlers = new Map<string, Function[]>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        const values = handlers.get(name) ?? [];
        values.push(handler);
        handlers.set(name, values);
      }),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      getFlag: vi.fn(() => false),
    } as any;
    const scope = registerSessionHandlers(pi);
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const owner = sessionOwner(scope);
    const planning = createRalplanRun({
      cwd,
      workflowId: "wf_plan",
      workflowName: "ralplan-occ",
      owner,
      parentSessionId: "session-a",
    });
    completeRalplanRun({
      cwd,
      workflowId: "wf_plan",
      result: {
        status: "pending_approval",
        consensus: true,
        pending_approval: true,
        planDigest: "plan-digest",
        artifactPaths: {
          plan: join(cwd, "plans", "plan.md"),
          drafts: [],
          architectReviews: [],
          criticReviews: [],
        },
      },
    });
    const approvedPlan = approveRalplanRun({
      cwd,
      runId: planning.runId,
      planDigest: "plan-digest",
      owner,
      parentSessionId: "session-a",
    });
    const preview = createExecutionPreview({
      cwd,
      ralplan: approvedPlan,
      planDigest: "plan-digest",
      owner,
      parentSessionId: "session-a",
      tasks: [
        {
          id: "task-a",
          phase: "implementation",
          title: "Task A",
          prompt: "Perform approved task A",
          dependsOn: [],
        },
      ],
    });
    const approvedExecution = approveExecutionPreview({
      cwd,
      executionId: preview.executionId,
      expectedRevision: preview.revision,
      planDigest: "plan-digest",
      owner,
      parentSessionId: "session-a",
    });
    const running = startExecutionRecord({
      cwd,
      executionId: preview.executionId,
      expectedRevision: approvedExecution.revision,
      owner,
      parentSessionId: "session-a",
    });
    beginNextExecutionOperation({
      cwd,
      executionId: preview.executionId,
      expectedRevision: running.revision,
      leaseEpoch: running.lease!.epoch,
      owner,
    });
    const abort = new AbortController();
    executionJobsForTests().set(preview.executionId, {
      executionId: preview.executionId,
      owner,
      abort,
      promise: new Promise(() => {}),
    });

    handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);

    expect(abort.signal.aborted).toBe(true);
    expect(getExecutionRecord(cwd, preview.executionId)).toMatchObject({
      status: "interrupted",
      active: false,
      taskStates: [{ status: "unknown" }],
      terminalReason: "session quit",
    });
  });
});
