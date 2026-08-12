import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  showWorkflowTree,
  WorkflowTreeComponent,
  workflowJobRegistry,
  type WorkflowJobState,
  type WorkflowTrustedResumeSnapshot,
} from "../src/workflow";
import { createPlanProjection } from "../src/workflow-plan-state";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";
import type { WorkflowPlanProjection } from "../src/workflow-plan-state";
import type { WorkflowApprovalSnapshot } from "../src/workflow-approvals";
import {
  createDurableWorkflowRunId,
  createWorkflowSha256Digest,
} from "../src/workflow-run-types";

function makeJob(overrides: Partial<WorkflowJobState> = {}): WorkflowJobState {
  return {
    id: "wf_test",
    name: "demo-flow",
    status: "running",
    kind: "script",
    startedAt: 123,
    promise: Promise.resolve({}) as any,
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 2,
      errorCount: 0,
      tokensSpent: 42,
      phases: ["Scan"],
      currentPhase: "Scan",
      lastMessage: "→ started scout",
      runningCount: 1,
      agentRecords: [],
      agentRecordsOmitted: 0,
    },

    ...overrides,
  };
}
function makePlanProjection(): WorkflowPlanProjection {
  const definition: WorkflowPlanDefinition = {
    name: "release plan",
    description: "A projected release",
    phases: [
      {
        id: "prepare",
        name: "Prepare",
        mode: "sequence",
        tasks: [
          { id: "check", content: "Check package", instruction: "check" },
        ],
      },
      {
        id: "publish",
        name: "Publish",
        mode: "parallel",
        tasks: [
          { id: "publish", content: "Publish package", instruction: "publish" },
        ],
      },
    ],
  };
  const projection = createPlanProjection(definition);
  return {
    ...projection,
    phases: projection.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({
        ...task,
        status: task.definition.id === "check" ? "succeeded" : "running",
        ...(task.definition.id === "check"
          ? { result: { output: "must stay hidden" } }
          : {}),
      })),
    })),
  };
}

describe("WorkflowTreeComponent", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
  });

  it("renders an empty state", () => {
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    const lines = component.render(80);

    expect(lines.join("\n")).toContain("No workflow jobs");
  });

  it("renders projected plan phases and task statuses", () => {
    const plan = makeJob({
      id: "wf_plan",
      name: "release-plan",
      kind: "plan",
      planProjection: makePlanProjection(),
    });
    workflowJobRegistry.set(plan.id, plan);
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    const summary = component.render(120).join("\n");
    expect(summary).toContain(
      "release-plan (wf_plan) · release plan · status: running",
    );
    component.handleInput("\r");
    const expanded = component.render(120).join("\n");
    expect(expanded).toContain("◆ phase: Prepare [sequence]");
    expect(expanded).toContain("✓ check [succeeded]");
    expect(expanded).toContain("◆ phase: Publish [parallel]");
    expect(expanded).toContain("→ publish [running]");
    expect(expanded).not.toContain("must stay hidden");
    expect(component.render(36).every((line) => line.length <= 36)).toBe(true);
  });

  it("renders workflow summaries and expands details", () => {
    workflowJobRegistry.set("wf_test", makeJob());
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    expect(component.render(100).join("\n")).toContain(
      "demo-flow (wf_test) · [running] · 2 agents · 1 running",
    );

    component.handleInput("\r");
    const expanded = component.render(100).join("\n");
    expect(expanded).toContain("◆ phase: Scan");
    expect(expanded).toContain("→ started scout");
  });

  it("shows the authoritative durable status for a recovered job row", () => {
    const recovered = makeJob({
      id: "durable_recovered",
      name: "Recovered durable plan workflow",
      kind: "plan",
      durable: true,
      status: "running",
      durableStatus: "interrupted",
      snapshot: {
        ...makeJob().snapshot,
        lastMessage: "Recovered durable status: interrupted",
        runningCount: 0,
      },
    });
    workflowJobRegistry.set(recovered.id, recovered);
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    expect(component.render(120).join("\n")).toContain(
      "Recovered durable plan workflow (durable_recovered) · [interrupted]",
    );
    component.handleInput("\r");
    expect(component.render(120).join("\n")).toContain(
      "Recovered durable status: interrupted",
    );
  });

  it("renders latest agent rows with omission count", () => {
    workflowJobRegistry.set(
      "wf_test",
      makeJob({
        snapshot: {
          ...makeJob().snapshot,
          phases: ["Scan"],
          agentRecords: Array.from({ length: 50 }, (_, index) => ({
            agentId: index + 2,
            label: "reused",
            model: "test/model",
            status: "done" as const,
          })),
          agentRecordsOmitted: 1,
        },
      }),
    );

    const component = new WorkflowTreeComponent({ done: vi.fn() });
    component.handleInput("\r");
    const expanded = component.render(220).join("\n");

    expect(expanded).toContain("… 31 older agent records omitted");
    expect(expanded).toContain("✓ done reused #51 @test/model");
    expect(expanded).toContain("✓ done reused #32 @test/model");
    expect(expanded).not.toContain("reused #31");
  });

  it("shows duplicate labels with stable attempt IDs", () => {
    workflowJobRegistry.set(
      "wf_test",
      makeJob({
        snapshot: {
          ...makeJob().snapshot,
          phases: [],
          agentRecords: [
            {
              agentId: 1,
              label: "worker",
              model: "m-1",
              status: "done",
            },
            {
              agentId: 2,
              label: "worker",
              model: "m-2",
              status: "error",
            },
          ],
          agentRecordsOmitted: 0,
        },
      }),
    );

    const component = new WorkflowTreeComponent({ done: vi.fn() });
    component.handleInput("\r");
    const expanded = component.render(220).join("\n");

    expect(expanded).toContain("✓ done worker #1 @m-1");
    expect(expanded).toContain("✗ error worker #2 @m-2");
  });

  it("shows aggregate and per-agent usage attribution in expanded details", () => {
    const usage = {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 3,
      totalTokens: 26,
      costUsd: 0.125,
      turns: 2,
    };
    workflowJobRegistry.set(
      "wf_test",
      makeJob({
        snapshot: {
          ...makeJob().snapshot,
          usage,
          agentRecords: [
            {
              agentId: 1,
              label: "worker",
              model: "m-1",
              status: "done",
              usage,
            },
          ],
        },
      }),
    );
    const component = new WorkflowTreeComponent({ done: vi.fn() });
    component.handleInput("\r");
    const expanded = component.render(240).join("\n");
    expect(expanded).toContain("↑ input tokens: 11");
    expect(expanded).toContain("input=11 output=7");
    expect(expanded).toContain("Legend: ↑ input");
  });

  it("keeps every aggregate field on its own row at narrow widths", () => {
    workflowJobRegistry.set(
      "wf_test",
      makeJob({
        snapshot: {
          ...makeJob().snapshot,
          budgetTotal: 20,
          usage: {
            input: 11,
            output: 7,
            cacheRead: 5,
            cacheWrite: 3,
            totalTokens: 26,
            costUsd: 0.125,
            turns: 2,
            costSource: "provider",
          },
        },
      }),
    );
    const component = new WorkflowTreeComponent({ done: vi.fn() });
    component.handleInput("\r");
    const lines = component.render(60);

    expect(lines.some((line) => line.includes("input tokens: 11"))).toBe(true);
    expect(lines.some((line) => line.includes("output tokens: 7/20"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("cache-read tokens: 5"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("cache-write tokens: 3"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("cost: $0.125 (provider)"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("turns: 2"))).toBe(true);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
  });

  it("omits empty provenance-free workflow totals", () => {
    workflowJobRegistry.set(
      "wf_test",
      makeJob({
        snapshot: {
          ...makeJob().snapshot,
          budgetTotal: 20,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            costUsd: 0,
            turns: 0,
          },
        },
      }),
    );
    const component = new WorkflowTreeComponent({ done: vi.fn() });
    component.handleInput("\r");
    const rendered = component.render(100).join("\n");

    expect(rendered).not.toContain("$?");
    expect(rendered).not.toContain("output tokens: 0/20");
  });

  it("handles legacy snapshots without agent records", () => {
    const job = makeJob();
    delete job.snapshot.agentRecords;
    delete job.snapshot.agentRecordsOmitted;
    workflowJobRegistry.set(job.id, job);
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    component.handleInput("\r");

    expect(component.render(100).join("\n")).toContain("→ started scout");
  });

  it("navigates, clamps, and collapses selected workflows", () => {
    workflowJobRegistry.set("wf_a", makeJob({ id: "wf_a", name: "alpha" }));
    workflowJobRegistry.set("wf_b", makeJob({ id: "wf_b", name: "beta" }));
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    component.handleInput("k");
    expect(component.render(100).join("\n")).toContain("▶ ▸ alpha");

    component.handleInput("j");
    expect(component.render(100).join("\n")).toContain("▶ ▸ beta");

    component.handleInput("j");
    expect(component.render(100).join("\n")).toContain("▶ ▸ beta");

    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("◆ phase: Scan");

    component.handleInput("\x1b[D");
    expect(component.render(100).join("\n")).not.toContain("◆ phase: Scan");
  });

  it("closes on q or escape", () => {
    const done = vi.fn();
    const component = new WorkflowTreeComponent({ done });

    component.handleInput("q");
    component.handleInput("\x1b");

    expect(done).toHaveBeenCalledWith({ kind: "close" });
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("cancels the selected running workflow with c", () => {
    const job = makeJob({
      snapshot: {
        ...makeJob().snapshot,
        agentRecords: [{ agentId: 1, status: "running" }],
      },
    });
    const abortSpy = vi.spyOn(job.abort, "abort");
    workflowJobRegistry.set(job.id, job);
    const done = vi.fn();
    const notify = vi.fn();
    const component = new WorkflowTreeComponent({ done, notify });

    component.handleInput("c");

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("cancelled");
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    expect(notify).toHaveBeenCalledWith("Cancelled workflow wf_test.");
    expect(done).toHaveBeenCalledWith({
      kind: "cancel",
      workflowId: "wf_test",
    });
  });

  it("cancels a plan through the same workflow job action", () => {
    const job = makeJob({
      id: "wf_plan_cancel",
      kind: "plan",
      planProjection: makePlanProjection(),
    });
    workflowJobRegistry.set(job.id, job);
    const done = vi.fn();
    const component = new WorkflowTreeComponent({ done });

    component.handleInput("c");

    expect(done).toHaveBeenCalledWith({
      kind: "cancel",
      workflowId: job.id,
    });
  });

  it("does not cancel a terminal workflow", () => {
    const job = makeJob({ status: "done" });
    const abortSpy = vi.spyOn(job.abort, "abort");
    workflowJobRegistry.set(job.id, job);
    const notify = vi.fn();
    const done = vi.fn();
    const component = new WorkflowTreeComponent({ done, notify });

    component.handleInput("c");

    expect(abortSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Workflow wf_test is done; nothing to cancel.",
    );
    expect(done).not.toHaveBeenCalled();
  });

  it("marks resolved workflows with errors as completed with errors", () => {
    const job = makeJob({
      status: "done",
      snapshot: {
        ...makeJob().snapshot,
        errorCount: 2,
      },
    });
    workflowJobRegistry.set(job.id, job);
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    expect(component.render(100).join("\n")).toContain(
      "⚠ demo-flow (wf_test) · [completed with errors]",
    );
  });

  it("neutralizes controls in provider, approval, log, and error rows", () => {
    const bidiControls =
      "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const runId = createDurableWorkflowRunId("tree-terminal-controls");
    const job = makeJob({
      id: runId,
      name: `\u001b[31m计划${bidiControls}Ω`,
      error: "错误\u202e]KO[\u202c原因\u001b[2J",
      snapshot: {
        ...makeJob().snapshot,
        phases: [`阶段${bidiControls}Ω\u001b]0;owned\u0007`],
        currentPhase: "当前\u2066]enod[\u2069阶段\u009b2J",
        lastMessage: "日志\u200f内容\u001b[31m",
        agentRecords: [
          {
            agentId: 1,
            label: "代理\u202d]rorre[\u202cΩ\u001b[2J",
            model: "提供商/\u061c模型\u009b2J",
            phase: "阶段\u200e一\u0007",
            status: "error",
          },
        ],
      },
    });
    const approval = {
      runId,
      requestId: "approval-\u2066denied\u2069",
      description: `批准\u202e]deined[\u202c说明${bidiControls}Ω\u001b]52;c;owned\u0007`,
      denialPolicy: "stop",
    } as unknown as WorkflowApprovalSnapshot;
    workflowJobRegistry.set(job.id, job);
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      approvals: [approval],
    });

    component.render(240);
    component.handleInput("\r");
    const lines = component.render(240);
    for (const line of lines) {
      expect(line).not.toMatch(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
      );
    }
    const rendered = lines.join("\n");
    expect(rendered).toContain("计划Ω");
    expect(rendered).toContain("阶段");
    expect(rendered).toContain("日志内容");
    expect(rendered).toContain("代理]rorre[Ω");
    expect(rendered).toContain("批准]deined[说明Ω");
    expect(rendered).toContain("错误]KO[原因");
  });

  it("returns a trusted approval selection for a cold durable row", () => {
    const done = vi.fn();
    const request: WorkflowApprovalSnapshot = {
      runId: createDurableWorkflowRunId("tree-approval"),
      requestId: "approval-tree",
      requestEventId: "request-event",
      approvalKind: "budget",
      reason: "token_limit",
      description: "Continue the exhausted budget.",
      accounting: {
        completeness: "exact",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          costUsd: 0,
          turns: 1,
        },
      },
      policyHash: createWorkflowSha256Digest("a".repeat(64)),
      planRevision: 1,
      requestOwnerGeneration: 1,
      requestRunEpoch: 1,
      owner: { projectKey: "project", piSessionKey: "session" },
      ownerGeneration: 2,
      runEpoch: 2,
      version: 1,
      denialPolicy: "stop",
      subjectTaskId: "task-b",
    };
    const component = new WorkflowTreeComponent({
      done,
      approvals: [request],
    });

    expect(component.render(120).join("\n")).toContain(
      "Durable workflow wfr-v1-tree-approval [awaiting approval]",
    );
    component.handleInput("a");
    expect(done).toHaveBeenCalledWith({
      kind: "approval",
      decision: "approved",
      request,
    });
  });

  it("returns the exact recovered owner and epoch for trusted resume", () => {
    const done = vi.fn();
    const resume: WorkflowTrustedResumeSnapshot = {
      runId: createDurableWorkflowRunId("tree-resume"),
      executionKind: "script",
      expectedOwner: { projectKey: "project", piSessionKey: "session" },
      expectedRunEpoch: 7,
    };
    const component = new WorkflowTreeComponent({
      done,
      resumes: [resume],
    });

    expect(component.render(120).join("\n")).toContain(
      "Durable script wfr-v1-tree-resume [interrupted at epoch 7]",
    );
    component.handleInput("r");
    expect(done).toHaveBeenCalledWith({ kind: "resume", resume });
  });

  it("falls back when custom UI is unavailable", async () => {
    const notify = vi.fn();
    const result = await showWorkflowTree({ notify } as any);

    expect(result).toEqual({ kind: "close" });
    expect(notify).toHaveBeenCalledWith(
      "Workflow tree UI is not available in this Pi session.",
    );
  });
});
