import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateRunningSubagentFooter } from "../src/artifact-poller";
import { jobRegistry, type JobState, type JobStatus } from "../src/helpers";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
  type InteractiveSubagentStatus,
} from "../src/interactive-tmux";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";

function makeJob(id: string, status: JobStatus): JobState {
  return {
    id,
    status,
    liveStatus: {
      turn: 0,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    },
    session: { abort: vi.fn() } as never,
    startedAt: 0,
    promise: new Promise(() => {}),
  };
}

function makeInteractive(
  id: string,
  status: InteractiveSubagentStatus,
): InteractiveSubagentState {
  return {
    id,
    name: id,
    task: "test",
    paneId: `%${id}`,
    mux: "tmux",
    sessionFile: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    startedAt: 0,
    status,
    attachCommand: "attach",
    selectPaneCommand: "select",
    launchScriptFile: `/tmp/${id}.sh`,
    artifactDir: `/tmp/${id}`,
  };
}

function makeScope(orchestratorv2 = false): SessionScope {
  return registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi: {
      getFlag: vi.fn((name: string) =>
        name === "orchestratorv2" ? orchestratorv2 : false,
      ),
    } as never,
  });
}

function makeWorkflow(id: string, name: string): WorkflowJobState {
  return {
    id,
    name,
    status: "running",
    startedAt: 0,
    promise: new Promise(() => {}),
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
      runningCount: 1,
    },
  };
}

beforeEach(() => {
  clearSessionScopes();
  jobRegistry.clear();
  interactiveSubagentRegistry.clear();
  workflowJobRegistry.clear();
});

afterEach(() => {
  clearSessionScopes();
  jobRegistry.clear();
  interactiveSubagentRegistry.clear();
  workflowJobRegistry.clear();
});

describe("footer working count", () => {
  it("keeps alive semantics while counting only running interactive turns and in-process jobs", () => {
    const scope = makeScope();
    for (const status of [
      "running",
      "idle",
      "unknown",
      "exited",
      "cancelled",
    ] as const) {
      scope.interactiveStates.set(
        `interactive-${status}`,
        makeInteractive(`interactive-${status}`, status),
      );
    }
    for (const status of ["running", "done", "error", "cancelled"] as const) {
      scope.inProcessJobs.set(
        `job-${status}`,
        makeJob(`job-${status}`, status),
      );
    }
    const ui = { setStatus: vi.fn() };

    updateRunningSubagentFooter(ui, sessionOwner(scope));

    expect(ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 4 sub-agents alive · 2 working",
    );
  });

  it("counts workflow-owned children once and not their workflow aggregate", () => {
    const scope = makeScope();
    const owner = sessionOwner(scope);
    const processChild = makeJob("process-child", "running");
    processChild.workflowId = "workflow-1";
    processChild.completionOwner = "workflow";
    const interactiveChild = makeInteractive("interactive-child", "running");
    interactiveChild.workflowId = "workflow-1";
    interactiveChild.completionOwner = "workflow";
    scope.inProcessJobs.set(processChild.id, processChild);
    scope.interactiveStates.set(interactiveChild.id, interactiveChild);
    const workflow = makeWorkflow("workflow-1", "review-auth");
    workflow.parentSessionOwner = owner;
    workflow.snapshot.agentsSpawned = 2;
    workflow.snapshot.runningCount = 2;
    workflowJobRegistry.set(workflow.id, workflow);
    const ui = { setStatus: vi.fn() };

    updateRunningSubagentFooter(ui, owner);

    expect(ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 2 sub-agents alive · 2 working · workflow review-auth",
    );
  });

  it("omits the working segment at zero and omits the whole plain footer at zero alive", () => {
    const scope = makeScope();
    scope.interactiveStates.set("idle", makeInteractive("idle", "idle"));
    scope.interactiveStates.set(
      "unknown",
      makeInteractive("unknown", "unknown"),
    );
    const ui = { setStatus: vi.fn() };

    updateRunningSubagentFooter(ui, sessionOwner(scope));
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 2 sub-agents alive",
    );

    scope.interactiveStates.clear();
    updateRunningSubagentFooter(ui, sessionOwner(scope));
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      undefined,
    );
  });

  it("preserves Orchestratorv2 and legacy identity behavior", () => {
    const scope = makeScope(true);
    scope.inProcessJobs.set("owned", makeJob("owned", "running"));
    const orchestratorUi = { setStatus: vi.fn() };

    updateRunningSubagentFooter(orchestratorUi, sessionOwner(scope));
    expect(orchestratorUi.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · 1 working · orchestrator",
    );

    clearSessionScopes();
    const legacyJob = makeJob("legacy", "running");
    jobRegistry.set(legacyJob.id, legacyJob);
    const legacyUi = { setStatus: vi.fn() };
    updateRunningSubagentFooter(legacyUi);
    expect(legacyUi.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · 1 working",
    );
  });

  it("fails closed for a stale owner generation", () => {
    const scope = makeScope();
    const staleOwner = sessionOwner(scope);
    scope.inProcessJobs.set("stale", makeJob("stale", "running"));
    advanceSessionScopeGeneration(scope.id);
    const ui = { setStatus: vi.fn() };

    updateRunningSubagentFooter(ui, staleOwner);

    expect(ui.setStatus).toHaveBeenCalledWith("subagentura-running", undefined);
  });

  it("memoizes identical counts and repaints when working changes", () => {
    const scope = makeScope();
    const state = makeInteractive("agent", "running");
    scope.interactiveStates.set(state.id, state);
    const ui = { setStatus: vi.fn() };
    const owner = sessionOwner(scope);

    updateRunningSubagentFooter(ui, owner);
    updateRunningSubagentFooter(ui, owner);
    expect(ui.setStatus).toHaveBeenCalledTimes(1);

    state.status = "idle";
    updateRunningSubagentFooter(ui, owner);
    updateRunningSubagentFooter(ui, owner);
    expect(ui.setStatus).toHaveBeenCalledTimes(2);
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive",
    );
  });
});
