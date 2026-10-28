import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  showWorkflowTree,
  WorkflowTreeComponent,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow";
import {
  clearSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { withWorkflowTerminalTransition } from "../src/workflow-jobs";
import { createTestSessionScope } from "./session-scope-fixture";

let scope: SessionScope;

function makeJob(overrides: Partial<WorkflowJobState> = {}): WorkflowJobState {
  return {
    id: "wf_test",
    name: "demo-flow",
    status: "running",
    startedAt: 123,
    promise: Promise.resolve({}) as any,
    abort: new AbortController(),
    parentSessionOwner: sessionOwner(scope),
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
    clearSessionScopes();
    scope = createTestSessionScope();
  });

  afterEach(() => {
    workflowJobRegistry.clear();
    clearSessionScopes();
  });

  it("renders an empty state", () => {
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

    const lines = component.render(80);

    expect(lines.join("\n")).toContain("No workflow jobs");
  });

  it("renders workflow summaries and expands details", () => {
    workflowJobRegistry.set("wf_test", makeJob());
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

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

    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });
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

    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });
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
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });
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
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });
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
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });
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
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

    component.handleInput("\r");

    expect(component.render(100).join("\n")).toContain("→ started scout");
  });

  it("navigates, clamps, and collapses selected workflows", () => {
    workflowJobRegistry.set("wf_a", makeJob({ id: "wf_a", name: "alpha" }));
    workflowJobRegistry.set("wf_b", makeJob({ id: "wf_b", name: "beta" }));
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

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
    const component = new WorkflowTreeComponent({
      done,
      owner: sessionOwner(scope),
    });

    component.handleInput("q");
    component.handleInput("\x1b");

    expect(done).toHaveBeenCalledWith({ kind: "close" });
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("cancels the selected running workflow with c", async () => {
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
    const component = new WorkflowTreeComponent({
      done,
      notify,
      owner: sessionOwner(scope),
    });

    component.handleInput("c");
    await vi.waitFor(() => expect(job.status).toBe("cancelled"));

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

  it("keeps durable work active after intent failure and commits before retry abort", async () => {
    const job = makeJob();
    const events: Array<{ kind: string; data: { status: string } }> = [];
    let failAppend = true;
    const append = vi.fn(async (kind: string, data: { status: string }) => {
      if (failAppend) {
        failAppend = false;
        throw new Error("intent storage unavailable");
      }
      events.push({ kind, data });
    });
    job.durable = {
      store: { events, append, directory: "/missing-workflow-tree-test" },
    } as any;
    const abortSpy = vi.spyOn(job.abort, "abort").mockImplementation(() => {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "cancelled",
        data: { status: "cancelled" },
      });
    });
    workflowJobRegistry.set(job.id, job);
    const done = vi.fn();
    const notify = vi.fn();
    const component = new WorkflowTreeComponent({
      done,
      notify,
      owner: sessionOwner(scope),
    });

    component.handleInput("c");
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        "Could not cancel workflow wf_test: intent storage unavailable",
      ),
    );

    expect(job.status).toBe("running");
    expect(abortSpy).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Could not cancel workflow wf_test: intent storage unavailable",
    );

    component.handleInput("c");
    await vi.waitFor(() => expect(job.status).toBe("cancelled"));

    expect(append).toHaveBeenCalledTimes(2);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("cancelled");
    expect(done).toHaveBeenCalledWith({ kind: "cancel", workflowId: "wf_test" });
    expect(notify).toHaveBeenLastCalledWith("Cancelled workflow wf_test.");
  });

  it("reports only one cancellation for queued tree requests", async () => {
    const job = makeJob();
    const events: Array<{ kind: string; data: { status: string } }> = [];
    job.durable = {
      store: {
        events,
        append: async (kind: string, data: { status: string }) => {
          events.push({ kind, data });
        },
        directory: "/missing-workflow-tree-test",
      },
    } as any;
    workflowJobRegistry.set(job.id, job);
    let releaseLock!: () => void;
    let enterLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => (enterLock = resolve));
    const held = withWorkflowTerminalTransition(job, async () => {
      enterLock();
      await new Promise<void>((resolve) => (releaseLock = resolve));
    });
    await lockEntered;
    const done = vi.fn();
    const notify = vi.fn();
    const component = new WorkflowTreeComponent({
      done,
      notify,
      owner: sessionOwner(scope),
    });

    component.handleInput("c");
    component.handleInput("c");
    releaseLock();
    await held;
    await vi.waitFor(() => expect(job.status).toBe("cancelled"));

    expect(
      events.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Cancelled workflow wf_test.");
  });

  it("does not cancel a terminal workflow", () => {
    const job = makeJob({ status: "done" });
    const abortSpy = vi.spyOn(job.abort, "abort");
    workflowJobRegistry.set(job.id, job);
    const notify = vi.fn();
    const done = vi.fn();
    const component = new WorkflowTreeComponent({
      done,
      notify,
      owner: sessionOwner(scope),
    });

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
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

    expect(component.render(100).join("\n")).toContain(
      "⚠ demo-flow (wf_test) · [completed with errors]",
    );
  });

  it("keeps peer rows out of rendering, selection, and cancellation", async () => {
    const peerScope = createTestSessionScope();
    const peerJob = makeJob({
      id: "wf_peer",
      name: "peer-only",
      parentSessionOwner: sessionOwner(peerScope),
    });
    const owned = makeJob({ id: "wf_owned", name: "owned-only" });
    const peerAbort = vi.spyOn(peerJob.abort, "abort");
    const ownedAbort = vi.spyOn(owned.abort, "abort");
    workflowJobRegistry.set(peerJob.id, peerJob);
    workflowJobRegistry.set(owned.id, owned);
    const component = new WorkflowTreeComponent({
      done: vi.fn(),
      owner: sessionOwner(scope),
    });

    expect(component.render(120).join("\n")).not.toContain("peer-only");
    expect(component.render(120).join("\n")).toContain("▶ ▸ owned-only");
    component.handleInput("j");
    component.handleInput("c");
    await vi.waitFor(() => expect(owned.status).toBe("cancelled"));

    expect(ownedAbort).toHaveBeenCalledOnce();
    expect(owned.status).toBe("cancelled");
    expect(peerAbort).not.toHaveBeenCalled();
    expect(peerJob.status).toBe("running");
  });

  it("fails closed without an owner despite registered workflow rows", () => {
    const job = makeJob();
    workflowJobRegistry.set(job.id, job);
    const abortSpy = vi.spyOn(job.abort, "abort");
    const component = new WorkflowTreeComponent({ done: vi.fn() });

    expect(component.render(100).join("\n")).toContain("No workflow jobs");
    component.handleInput("\r");
    component.handleInput("c");
    expect(abortSpy).not.toHaveBeenCalled();
    expect(job.status).toBe("running");
  });

  it("falls back when custom UI is unavailable", async () => {
    const notify = vi.fn();
    const result = await showWorkflowTree(
      { notify } as any,
      sessionOwner(scope),
    );

    expect(result).toEqual({ kind: "close" });
    expect(notify).toHaveBeenCalledWith(
      "Workflow tree UI is not available in this Pi session.",
    );
  });
});
