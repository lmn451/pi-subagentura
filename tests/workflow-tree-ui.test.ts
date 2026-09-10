import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  showWorkflowTree,
  WorkflowTreeComponent,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow";

function makeJob(overrides: Partial<WorkflowJobState> = {}): WorkflowJobState {
  return {
    id: "wf_test",
    name: "demo-flow",
    status: "running",
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

describe("WorkflowTreeComponent", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
  });

  it("renders an empty state", () => {
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    const lines = component.render(80);

    expect(lines.join("\n")).toContain("No workflow jobs");
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
    expect(job.telemetryTerminalReason).toBe("explicit_cancel");
    expect(job.completedAt).toEqual(expect.any(Number));
    expect(job.snapshot.runningCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    expect(notify).toHaveBeenCalledWith("Cancelled workflow wf_test.");
    expect(done).toHaveBeenCalledWith({
      kind: "cancel",
      workflowId: "wf_test",
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

  it("falls back when custom UI is unavailable", async () => {
    const notify = vi.fn();
    const result = await showWorkflowTree({ notify } as any);

    expect(result).toEqual({ kind: "close" });
    expect(notify).toHaveBeenCalledWith(
      "Workflow tree UI is not available in this Pi session.",
    );
  });
});
