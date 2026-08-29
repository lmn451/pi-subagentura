import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executionJobsForTests,
  registerRalplanExecutionTools,
} from "../src/ralplan-execution-tool";
import {
  approveRalplanRun,
  clearRalplanBindingsForTests,
  completeRalplanRun,
  createRalplanRun,
} from "../src/ralplan-state";
import { clearExecutionBindingsForTests } from "../src/workflow-run-store";
import type { SessionScope } from "../src/session-scope";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-execution-tools-"));
  roots.push(value);
  return value;
}

function approvedPlan(cwd: string) {
  const record = createRalplanRun({
    cwd,
    workflowId: "wf_plan",
    workflowName: "ralplan-occ",
    owner: { id: 3, generation: 1 },
    parentSessionId: "session-a",
  });
  completeRalplanRun({
    cwd,
    workflowId: "wf_plan",
    result: {
      status: "pending_approval",
      consensus: true,
      pending_approval: true,
      execution_halted: true,
      planDigest: "plan-digest",
      artifactPaths: {
        plan: join(cwd, "plans", "plan.md"),
        drafts: [],
        architectReviews: [],
        criticReviews: [],
      },
    },
  });
  return approveRalplanRun({
    cwd,
    runId: record.runId,
    planDigest: "plan-digest",
    owner: { id: 3, generation: 1 },
    parentSessionId: "session-a",
  });
}

function setup(
  cwd: string,
  runTask = vi.fn(async ({ task }) => ({
    summary: `${task.id} complete`,
    outputDigest: `digest-${task.id}`,
  })),
) {
  const tools: Record<string, any> = {};
  const pi = {
    registerTool: vi.fn((tool: any) => {
      tools[tool.name] = tool;
    }),
  } as any;
  const scope: SessionScope = {
    id: 3,
    generation: 1,
    pi,
    cwd,
    lifecycle: "started",
    sessionManager: { getSessionId: () => "session-a" },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  };
  registerRalplanExecutionTools(pi, scope, { runTask });
  return { tools, runTask };
}

const tasks = [
  {
    id: "task-a",
    phase: "implementation",
    title: "Task A",
    prompt: "Perform approved task A",
    dependsOn: [],
  },
  {
    id: "task-b",
    phase: "verification",
    title: "Task B",
    prompt: "Perform approved task B",
    dependsOn: ["task-a"],
  },
];

afterEach(() => {
  for (const job of executionJobsForTests().values()) job.abort.abort();
  executionJobsForTests().clear();
  clearExecutionBindingsForTests();
  clearRalplanBindingsForTests();
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("RALPLAN durable execution tools", () => {
  it("registers the bounded preview/approve/run/status/cancel/resolve/resume surface", () => {
    const { tools } = setup(root());
    expect(Object.keys(tools).sort()).toEqual([
      "approve_ralplan_execution",
      "cancel_ralplan_execution",
      "get_ralplan_execution_status",
      "preview_ralplan_execution",
      "resolve_ralplan_operation",
      "resume_ralplan_execution",
      "run_ralplan_execution",
    ]);
  });

  it("keeps preview and approval non-executing, then runs only after explicit start", async () => {
    const cwd = root();
    const plan = approvedPlan(cwd);
    const { tools, runTask } = setup(cwd);
    const preview = await tools.preview_ralplan_execution.execute("preview", {
      runId: plan.runId,
      planDigest: "plan-digest",
      tasks,
    });
    expect(preview).toMatchObject({
      details: {
        status: "pending_execution_approval",
        executionStarted: false,
        exactlyOnce: false,
      },
    });
    expect(runTask).not.toHaveBeenCalled();

    const approved = await tools.approve_ralplan_execution.execute("approve", {
      executionId: preview.details.executionId,
      expectedRevision: preview.details.revision,
      planDigest: "plan-digest",
    });
    expect(approved.details.executionStarted).toBe(false);
    expect(runTask).not.toHaveBeenCalled();

    const started = await tools.run_ralplan_execution.execute(
      "run",
      {
        executionId: preview.details.executionId,
        expectedRevision: approved.details.revision,
      },
      undefined,
      undefined,
      {},
    );
    expect(started.details.status).toBe("running");
    await executionJobsForTests().get(preview.details.executionId)!.promise;
    expect(runTask).toHaveBeenCalledTimes(2);

    const status = await tools.get_ralplan_execution_status.execute("status", {
      executionId: preview.details.executionId,
    });
    expect(status).toMatchObject({
      details: { status: "ok", records: [{ status: "completed" }] },
    });
  });

  it("rejects a preview from an unapproved plan digest", async () => {
    const cwd = root();
    const plan = approvedPlan(cwd);
    const { tools, runTask } = setup(cwd);
    const preview = await tools.preview_ralplan_execution.execute("preview", {
      runId: plan.runId,
      planDigest: "wrong",
      tasks,
    });
    expect(preview.isError).toBe(true);
    expect(runTask).not.toHaveBeenCalled();
  });

  it("reports stale start fencing as an error instead of a false start", async () => {
    const cwd = root();
    const plan = approvedPlan(cwd);
    const { tools, runTask } = setup(cwd);
    const preview = await tools.preview_ralplan_execution.execute("preview", {
      runId: plan.runId,
      planDigest: "plan-digest",
      tasks,
    });
    await tools.approve_ralplan_execution.execute("approve", {
      executionId: preview.details.executionId,
      expectedRevision: preview.details.revision,
      planDigest: "plan-digest",
    });

    const started = await tools.run_ralplan_execution.execute(
      "run",
      {
        executionId: preview.details.executionId,
        expectedRevision: preview.details.revision,
      },
      undefined,
      undefined,
      {},
    );
    expect(started.isError).toBe(true);
    expect(executionJobsForTests().has(preview.details.executionId)).toBe(
      false,
    );
    expect(runTask).not.toHaveBeenCalled();
  });

  it("does not abort live work for a stale cancellation revision", async () => {
    const cwd = root();
    const plan = approvedPlan(cwd);
    const runTask = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const { tools } = setup(cwd, runTask);
    const preview = await tools.preview_ralplan_execution.execute("preview", {
      runId: plan.runId,
      planDigest: "plan-digest",
      tasks,
    });
    const approved = await tools.approve_ralplan_execution.execute("approve", {
      executionId: preview.details.executionId,
      expectedRevision: preview.details.revision,
      planDigest: "plan-digest",
    });
    await tools.run_ralplan_execution.execute(
      "run",
      {
        executionId: preview.details.executionId,
        expectedRevision: approved.details.revision,
      },
      undefined,
      undefined,
      {},
    );
    const live = executionJobsForTests().get(preview.details.executionId)!;
    const stale = await tools.cancel_ralplan_execution.execute("cancel", {
      executionId: preview.details.executionId,
      expectedRevision: approved.details.revision,
      reason: "stale",
    });

    expect(stale.isError).toBe(true);
    expect(live.abort.signal.aborted).toBe(false);
    const status = await tools.get_ralplan_execution_status.execute("status", {
      executionId: preview.details.executionId,
    });
    const currentRevision = status.details.records[0].revision;
    const cancelled = await tools.cancel_ralplan_execution.execute("cancel", {
      executionId: preview.details.executionId,
      expectedRevision: currentRevision,
      reason: "operator cancel",
    });
    expect(cancelled.details.status).toBe("cancelled");
    expect(live.abort.signal.aborted).toBe(true);
  });
});
