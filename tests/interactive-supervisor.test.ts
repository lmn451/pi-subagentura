import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InteractiveSupervisorComponent,
  closeActiveInteractiveSupervisor,
  formatSupervisorSummary,
  showInteractiveSupervisor,
} from "../src/interactive-supervisor-ui";
import {
  LINEAGE_SCHEMA_VERSION,
  hashLineageRoot,
  resolveLineageStorePaths,
  writeLineageManifestAtomic,
} from "../src/interactive-lineage";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";
import {
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import {
  buildAsyncSupervisorItems,
  directSupervisorItems,
  formatSubtreeCancellation,
  registerInteractiveSupervisor,
  supervisorStatusLines,
} from "../src/interactive-supervisor-registration";
import type { CancelSubtreeResult } from "../src/interactive-lineage";
import { jobRegistry, type JobState } from "../src/helpers";
import {
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "../src/session-scope";

const tempDirs: string[] = [];
const savedTmux = process.env.TMUX;
const inheritedLineageEnv = {
  rootId: process.env.PI_SUBAGENTURA_ROOT_ID,
  sessionRoot: process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT,
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "interactive-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function state(
  id: string,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  return {
    id,
    name: `agent-${id}`,
    task: `inspect ${id}`,
    paneId: `%${id}`,
    mux: "tmux",
    sessionFile: `/sessions/${id}.jsonl`,
    cwd: "/repo",
    startedAt: Date.now() - 5_000,
    status: "running",
    attachCommand: `tmux attach -t ${id}`,
    selectPaneCommand: `tmux select-pane -t %${id}`,
    launchScriptFile: `/artifacts/${id}/launch.sh`,
    artifactDir: `/artifacts/${id}`,
    ...overrides,
  };
}

function inProcessJob(id: string, overrides: Partial<JobState> = {}): JobState {
  return {
    id,
    status: "running",
    liveStatus: {
      turn: 1,
      output: `partial output from ${id}`,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
    },
    session: { abort: vi.fn() } as never,
    startedAt: Date.now() - 4_000,
    cwd: "/repo",
    promise: Promise.resolve({}) as never,
    ...overrides,
  };
}

function workflowJob(
  id: string,
  overrides: Partial<WorkflowJobState> = {},
): WorkflowJobState {
  return {
    id,
    name: `workflow-${id}`,
    status: "running",
    startedAt: Date.now() - 3_000,
    promise: Promise.resolve({}) as never,
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 5,
      phases: ["Review"],
      currentPhase: "Review",
      runningCount: 1,
      agentRecords: [{ agentId: 1, label: "reviewer", status: "running" }],
      agentRecordsOmitted: 0,
    },
    ...overrides,
  };
}
function startedScope(
  owner: SessionOwnerToken,
  sessionId = `session-${owner.id}`,
): SessionScope {
  return registerSessionScope({
    ...owner,
    lifecycle: "started",
    pi: {} as never,
    sessionManager: { getSessionId: () => sessionId },
  });
}

const savedLineageEnv: Record<string, string | undefined> = {};

/**
 * Register the supervisor against a real on-disk lineage store so the
 * projection, prune sweep and cancel paths run end to end.
 */
async function lineageHarness(rootId: string) {
  const sessionRoot = tempDir();
  const paths = await resolveLineageStorePaths(sessionRoot, rootId);
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  registerInteractiveSupervisor(
    {
      registerCommand: (_name: string, command: { handler: any }) => {
        commandHandler = command.handler;
      },
      registerShortcut: vi.fn(),
    } as never,
    undefined,
    createRootSpawnTreeContext(rootId, sessionRoot),
  );

  return {
    sessionRoot,
    paths,
    async writeNode(
      agentId: string,
      options: {
        paneId: string;
        parentAgentId?: string;
        backend?: string;
        runtimeKind?: "direct" | "workflow";
      },
    ) {
      await writeLineageManifestAtomic(paths.nodesDir, {
        schemaVersion: LINEAGE_SCHEMA_VERSION,
        agentId,
        ...(options.parentAgentId
          ? { parentAgentId: options.parentAgentId }
          : {}),
        rootId,
        rootHash: hashLineageRoot(rootId),
        ownerSessionId: rootId,
        name: `agent-${agentId}`,
        ...(options.runtimeKind ? { runtimeKind: options.runtimeKind } : {}),
        taskPreview: `inspect ${agentId}`,
        startedAt: new Date(Date.now() - 5_000).toISOString(),
        cwd: sessionRoot,
        pane: {
          backend: options.backend ?? "tmux",
          paneId: options.paneId,
        },
        artifactDir: join(sessionRoot, "artifacts", agentId),
      });
    },
    async writeBroken(name: string) {
      mkdirSync(paths.nodesDir, { recursive: true });
      writeFileSync(join(paths.nodesDir, `${name}.json`), "not json");
    },
    async nodeFiles(): Promise<string[]> {
      try {
        return readdirSync(paths.nodesDir)
          .filter((entry) => entry.endsWith(".json"))
          .sort();
      } catch {
        return [];
      }
    },
    async open(drive?: (component: InteractiveSupervisorComponent) => void) {
      const confirm = vi.fn().mockResolvedValue(true);
      const notify = vi.fn();
      let rendered = "";
      const custom = vi.fn(async (factory: Function) => {
        const component = factory(
          { requestRender: vi.fn() },
          undefined,
          undefined,
          vi.fn(),
        ) as InteractiveSupervisorComponent;
        rendered = component.render(200).join("\n");
        drive?.(component);
        return { kind: "close" };
      });
      await commandHandler?.("", {
        ui: { custom, confirm, notify, setStatus: vi.fn() },
        sessionManager: { getSessionId: () => rootId },
      });
      return { rendered, confirm, notify };
    },
  };
}

// A child reviewer inherits live lineage paths; isolate tests from real panes.
beforeEach(() => {
  delete process.env.PI_SUBAGENTURA_ROOT_ID;
  delete process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
});

afterEach(() => {
  interactiveSubagentRegistry.clear();
  jobRegistry.clear();
  workflowJobRegistry.clear();
  clearSessionScopes();
  __resetMuxInstances();
  __setTmuxMultiplexer(undefined);
  vi.useRealTimers();
  if (savedTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = savedTmux;
  for (const [name, value] of Object.entries(savedLineageEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedLineageEnv[name];
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (inheritedLineageEnv.rootId === undefined) {
    delete process.env.PI_SUBAGENTURA_ROOT_ID;
  } else {
    process.env.PI_SUBAGENTURA_ROOT_ID = inheritedLineageEnv.rootId;
  }
  if (inheritedLineageEnv.sessionRoot === undefined) {
    delete process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
  } else {
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT =
      inheritedLineageEnv.sessionRoot;
  }
});

describe("interactive supervisor", () => {
  it("renders bounded summaries and activity", () => {
    const item = state("abcdef12", {
      name: "reader",
      lastToolSummary: "reading a very long and important source file",
    });
    interactiveSubagentRegistry.set(item.id, item);
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
    });

    const lines = component.render(72);

    expect(lines.some((line) => line.includes("abcdef12"))).toBe(true);
    expect(lines.some((line) => line.includes("reading"))).toBe(true);
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    expect(formatSupervisorSummary(item, Date.now())).toContain("tmux");
  });

  it("renders in-process, workflow, and interactive async work", () => {
    const processJob = inProcessJob("job-123");
    const workflow = workflowJob("wf-123");
    const interactive = state("interactive-123");
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        {
          kind: "in-process",
          job: processJob,
          depth: 0,
          actionable: true,
        },
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
        {
          kind: "interactive",
          state: interactive,
          depth: 0,
          actionable: true,
        },
      ],
    });

    const summaries = component.render(180).join("\n");
    expect(summaries).toContain("Async Subagents");
    expect(summaries).toContain("[in-process] → running job-123");
    expect(summaries).toContain("[workflow] → running workflow-wf-123");
    expect(summaries).toContain("[registry] → running agent-interactive-123");

    component.handleInput("\r");
    expect(component.render(180).join("\n")).toContain(
      "Output preview: partial output from job-123",
    );
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(180).join("\n")).toContain(
      "Agent: → running reviewer #1",
    );
  });

  it("shows reusable workflow lifecycle, ownership, siblings, and recovery caveats", () => {
    const owner = { id: 7, generation: 1 };
    const scope = startedScope(owner, "session-owner");
    const reusable = state("child-a", {
      startedAt: 1,
      status: "idle",
      completionOwner: "workflow",
      workflowId: "workflow-a",
      workflowOriginId: "workflow-a",
      workflowName: "review-flow",
      workflowReusable: true,
      workflowResultConsumed: true,
      workflowReuseExpiresAt: Date.now() + 30_000,
      ownerSessionId: "session-owner",
      sessionOwner: owner,
      lineageRootId: "root-session",
      lineageParentAgentId: "orchestrator-child",
    });
    const sibling = state("child-b", {
      startedAt: 2,
      workflowId: "workflow-a",
      workflowOriginId: "workflow-a",
      workflowName: "review-flow",
      workflowReusable: true,
      ownerSessionId: "session-owner",
      sessionOwner: owner,
    });
    scope.interactiveStates.set(reusable.id, reusable);
    scope.interactiveStates.set(sibling.id, sibling);

    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      now: () => Date.now(),
      items: () =>
        buildAsyncSupervisorItems(
          directSupervisorItems(undefined, owner),
          owner,
        ),
    });
    component.handleInput("\r");
    const rendered = component.render(240).join("\n");

    expect(rendered).toContain("Agent state: idle/reusable");
    expect(rendered).toContain(
      "Workflow: review-flow (workflow-a) · owner=workflow",
    );
    expect(rendered).toContain("Siblings: child-b");
    expect(rendered).toContain(
      "Origin: live registry · owner=session-owner · root=root-session · parent=orchestrator-child",
    );
    expect(rendered).toContain(
      "Recovery: same-parent-session only; workflow children are not rehydrated",
    );
    expect(rendered).toContain(
      "Routing: attachable does not imply actionable; explicit child-ID follow-up promotes",
    );
  });

  it("omits workflow sibling relationships without an exact owner scope", () => {
    const first = state("ownerless-a", {
      workflowOriginId: "workflow-a",
    });
    const second = state("ownerless-b", {
      workflowOriginId: "workflow-a",
    });
    interactiveSubagentRegistry.set(first.id, first);
    interactiveSubagentRegistry.set(second.id, second);

    const items = directSupervisorItems();

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.workflowSiblingIds === undefined)).toBe(
      true,
    );
  });

  it("keeps every workflow total field on its own row at narrow widths", () => {
    const workflow = workflowJob("wf-budget", {
      snapshot: {
        ...workflowJob("snapshot").snapshot,
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
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
      ],
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
    const workflow = workflowJob("wf-empty", {
      snapshot: {
        ...workflowJob("snapshot").snapshot,
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
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
      ],
    });
    component.handleInput("\r");
    const rendered = component.render(80).join("\n");

    expect(rendered).not.toContain("$?");
    expect(rendered).not.toContain("output tokens: 0/20");
  });

  it("reports omitted workflow agent records", () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      agentId: index + 1,
      label: "worker",
      status: "done" as const,
    }));
    const workflow = workflowJob("wf-omitted", {
      snapshot: {
        ...workflowJob("snapshot").snapshot,
        agentsSpawned: 27,
        agentRecords: records,
        agentRecordsOmitted: 2,
      },
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
      ],
    });

    component.handleInput("\r");

    expect(component.render(180).join("\n")).toContain(
      "… 7 older agent records omitted",
    );
  });

  it("keeps selection on the same async item across refresh reordering", () => {
    const first = state("first");
    const selected = state("selected");
    const inserted = state("inserted");
    const cancel = vi.fn().mockReturnValue(selected);
    let items = [first, selected].map((interactive) => ({
      kind: "interactive" as const,
      state: interactive,
      depth: 0,
      actionable: true,
    }));
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      items: () => items,
    });
    component.render(120);
    component.handleInput("j");
    items = [inserted, first, selected].map((interactive) => ({
      kind: "interactive" as const,
      state: interactive,
      depth: 0,
      actionable: true,
    }));

    component.invalidate();
    component.render(120);
    component.handleInput("x");

    expect(cancel).toHaveBeenCalledWith(selected.id);
  });

  it("dispatches cancellation according to async work type", () => {
    const processJob = inProcessJob("job-cancel");
    const workflow = workflowJob("wf-cancel");
    const interactive = state("interactive-cancel");
    const cancelInProcess = vi.fn().mockReturnValue(true);
    const cancelWorkflow = vi.fn().mockReturnValue(true);
    const cancel = vi
      .fn()
      .mockReturnValue(state("interactive-cancel", { status: "cancelled" }));
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      cancelInProcess,
      cancelWorkflow,
      items: () => [
        {
          kind: "in-process",
          job: processJob,
          depth: 0,
          actionable: true,
        },
        { kind: "workflow", job: workflow, depth: 0, actionable: true },
        {
          kind: "interactive",
          state: interactive,
          depth: 0,
          actionable: true,
        },
      ],
    });

    component.handleInput("x");
    component.handleInput("j");
    component.handleInput("x");
    component.handleInput("j");
    component.handleInput("x");

    expect(cancelInProcess).toHaveBeenCalledWith(processJob);
    expect(cancelWorkflow).toHaveBeenCalledWith(workflow);
    expect(cancel).toHaveBeenCalledWith(interactive.id);
  });

  it("builds owner-scoped unified supervisor items", () => {
    const scope = startedScope(
      { id: 7, generation: 2 },
      "owned-parent-session",
    );
    const otherScope = startedScope(
      { id: 99, generation: 1 },
      "other-parent-session",
    );
    const owner = sessionOwner(scope);
    const otherOwner = sessionOwner(otherScope);
    const processJob = inProcessJob("owned-job", {
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    const otherProcessJob = inProcessJob("other-job", {
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: otherOwner.id,
        sessionScopeGeneration: otherOwner.generation,
      },
    });
    const workflow = workflowJob("owned-workflow", {
      parentSessionOwner: owner,
    });
    const otherWorkflow = workflowJob("other-workflow", {
      parentSessionOwner: otherOwner,
    });
    jobRegistry.set(processJob.id, processJob);
    jobRegistry.set(otherProcessJob.id, otherProcessJob);
    workflowJobRegistry.set(workflow.id, workflow);
    workflowJobRegistry.set(otherWorkflow.id, otherWorkflow);
    const interactive = state("owned-interactive", {
      sessionOwner: owner,
      parentSessionId: "owned-parent-session",
    });
    const otherInteractive = state("other-interactive", {
      sessionOwner: otherOwner,
      parentSessionId: "other-parent-session",
    });
    interactiveSubagentRegistry.set(interactive.id, interactive);
    interactiveSubagentRegistry.set(otherInteractive.id, otherInteractive);
    scope.inProcessJobs.set(processJob.id, processJob);
    otherScope.inProcessJobs.set(otherProcessJob.id, otherProcessJob);
    scope.interactiveStates.set(interactive.id, interactive);
    otherScope.interactiveStates.set(otherInteractive.id, otherInteractive);

    const items = buildAsyncSupervisorItems(
      directSupervisorItems("owned-parent-session", owner),
      owner,
    );

    expect(items.map((item) => item.kind)).toEqual([
      "workflow",
      "in-process",
      "interactive",
    ]);
    expect(
      items.some(
        (item) => item.kind === "in-process" && item.job.id === "other-job",
      ),
    ).toBe(false);
    expect(
      items.some(
        (item) => item.kind === "workflow" && item.job.id === "other-workflow",
      ),
    ).toBe(false);
    expect(
      items.some(
        (item) =>
          item.kind === "interactive" && item.state.id === "other-interactive",
      ),
    ).toBe(false);
    expect(items.find((item) => item.kind === "interactive")).toMatchObject({
      origin: {
        source: "registry",
        ownerSessionId: "owned-parent-session",
      },
    });
  });

  it("groups workflow children after their matching workflow root", () => {
    const scope = startedScope({ id: 7, generation: 2 });
    const owner = sessionOwner(scope);
    const workflowA = workflowJob("wf-a", {
      name: "alpha",
      parentSessionOwner: owner,
      startedAt: 10,
    });
    const workflowB = workflowJob("wf-b", {
      name: "beta",
      parentSessionOwner: owner,
      startedAt: 20,
    });
    workflowJobRegistry.set(workflowA.id, workflowA);
    workflowJobRegistry.set(workflowB.id, workflowB);

    const processA = inProcessJob("process-a", {
      startedAt: 11,
      workflowId: workflowA.id,
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    const processB = inProcessJob("process-b", {
      startedAt: 21,
      workflowId: workflowB.id,
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    const standalone = inProcessJob("standalone", {
      startedAt: 100,
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    jobRegistry.set(processA.id, processA);
    jobRegistry.set(processB.id, processB);
    jobRegistry.set(standalone.id, standalone);
    scope.inProcessJobs.set(processA.id, processA);
    scope.inProcessJobs.set(processB.id, processB);
    scope.inProcessJobs.set(standalone.id, standalone);

    const interactiveA = state("interactive-a", {
      startedAt: 12,
      workflowId: workflowA.id,
      sessionOwner: owner,
    });
    const interactiveB = state("interactive-b", {
      startedAt: 22,
      workflowId: workflowB.id,
      sessionOwner: owner,
    });
    const standaloneInteractive = state("standalone-interactive", {
      startedAt: 101,
      sessionOwner: owner,
    });
    for (const item of [interactiveA, interactiveB, standaloneInteractive]) {
      interactiveSubagentRegistry.set(item.id, item);
      scope.interactiveStates.set(item.id, item);
    }

    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );
    expect(
      items.map((item) =>
        item.kind === "workflow"
          ? item.job.id
          : item.kind === "in-process"
            ? item.job.id
            : item.state.id,
      ),
    ).toEqual([
      "wf-a",
      "process-a",
      "interactive-a",
      "wf-b",
      "process-b",
      "interactive-b",
      "standalone",
      "standalone-interactive",
    ]);
  });

  it("shows owner-scoped workflow interactive children", () => {
    const scope = startedScope({ id: 7, generation: 2 });
    const owner = sessionOwner(scope);
    const workflow = workflowJob("owned-workflow", {
      parentSessionOwner: owner,
    });
    workflowJobRegistry.set(workflow.id, workflow);
    const child = state("workflow-child", {
      sessionOwner: owner,
      workflowId: workflow.id,
      completionOwner: "workflow",
    });
    interactiveSubagentRegistry.set(child.id, child);
    scope.interactiveStates.set(child.id, child);
    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );
    const visibleChild = items.find(
      (item) => item.kind === "interactive" && item.state.id === child.id,
    );
    expect(visibleChild).toMatchObject({
      kind: "interactive",
      depth: 1,
      actionable: true,
    });
    expect(child.parentSessionId).toBeUndefined();
  });

  it("flattens retained idle children of terminal workflow jobs", () => {
    const scope = startedScope({ id: 7, generation: 2 });
    const owner = sessionOwner(scope);
    const workflow = workflowJob("completed-workflow", {
      status: "done",
      parentSessionOwner: owner,
    });
    workflowJobRegistry.set(workflow.id, workflow);
    const child = state("retained-idle-child", {
      status: "idle",
      sessionOwner: owner,
      workflowId: workflow.id,
      completionOwner: "workflow",
    });
    interactiveSubagentRegistry.set(child.id, child);
    scope.interactiveStates.set(child.id, child);

    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "interactive",
      state: child,
      depth: 0,
      actionable: true,
      origin: {
        source: "registry",
        ownerSessionId: undefined,
      },
    });
    expect(items[0]?.kind).toBe("interactive");
    if (items[0]?.kind === "interactive") {
      expect(items[0].state).toBe(child);
    }
    expect(items.some((item) => item.kind === "workflow")).toBe(false);
  });

  it("flattens orphaned workflow children whose workflow row is gone", () => {
    const scope = startedScope({ id: 7, generation: 2 });
    const owner = sessionOwner(scope);
    // cleanupWorkflowJobsForOwner deletes the workflow job synchronously while its
    // children take a microtask or more to unwind. During that window the children
    // have no parent row above them and must not render indented.
    const orphanInteractive = state("orphan-interactive", {
      sessionOwner: owner,
      workflowId: "wf-already-gone",
      completionOwner: "workflow",
    });
    interactiveSubagentRegistry.set(orphanInteractive.id, orphanInteractive);
    const orphanProcess = inProcessJob("orphan-process", {
      workflowId: "wf-already-gone",
      completionOwner: "workflow",
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    jobRegistry.set(orphanProcess.id, orphanProcess);
    scope.interactiveStates.set(orphanInteractive.id, orphanInteractive);
    scope.inProcessJobs.set(orphanProcess.id, orphanProcess);

    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );

    expect(
      items.map((item) => [
        item.kind === "in-process" || item.kind === "workflow"
          ? item.job.id
          : item.state.id,
        item.depth,
      ]),
    ).toEqual([
      ["orphan-process", 0],
      ["orphan-interactive", 0],
    ]);
  });

  it("keeps in-process rows ahead of interactive rows within a group", () => {
    // Grouping moved workflow roots to the front of the list, but the relative
    // order of non-workflow rows is unchanged from the pre-grouping return value
    // `[...processItems, ...workflowItems, ...normalizedInteractive]`: in-process
    // first, then interactive, each by ascending startedAt.
    const scope = startedScope({ id: 7, generation: 2 });
    const owner = sessionOwner(scope);
    const youngProcess = inProcessJob("process-young", {
      startedAt: 500,
      deliveryOwner: {
        pi: {} as never,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
    jobRegistry.set(youngProcess.id, youngProcess);
    const oldInteractive = state("interactive-old", {
      startedAt: 1,
      sessionOwner: owner,
    });
    interactiveSubagentRegistry.set(oldInteractive.id, oldInteractive);
    scope.inProcessJobs.set(youngProcess.id, youngProcess);
    scope.interactiveStates.set(oldInteractive.id, oldInteractive);

    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );

    expect(items.map((item) => item.kind)).toEqual([
      "in-process",
      "interactive",
    ]);
  });

  it("navigates, expands, refreshes, and closes without cancelling", () => {
    interactiveSubagentRegistry.set("one", state("one"));
    interactiveSubagentRegistry.set("two", state("two"));
    const done = vi.fn();
    const cancel = vi.fn();
    const requestRender = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done,
      cancel,
      requestRender,
    });

    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(100).join("\n")).toContain("Task: inspect two");
    component.handleInput("r");
    expect(requestRender).toHaveBeenCalled();
    component.handleInput("q");

    expect(done).toHaveBeenCalledWith({ kind: "close" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("shows bounded lifecycle events and artifact output in details", async () => {
    const artifactDir = join(tempDir(), "artifact");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "events.ndjson"),
      [
        JSON.stringify({ type: "turn_started", turnId: "turn-1" }),
        JSON.stringify({ type: "tool_activity", name: "read" }),
        JSON.stringify({ type: "completion", outcome: "done" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(artifactDir, "output.md"),
      "Completed the recursive artifact inspection.\n",
    );
    const item = state("details", {
      artifactDir,
      lifecycle: {
        currentTurnId: "turn-1",
        completionOutcome: "done",
        processStatus: "done",
      },
    });
    interactiveSubagentRegistry.set(item.id, item);
    const component = new InteractiveSupervisorComponent({ done: vi.fn() });

    // Artifact previews are read on the async refresh path, never in render().
    component.handleInput("\r");
    expect(component.render(160).join("\n")).toContain(
      "Recent events: loading…",
    );

    await vi.waitFor(() => {
      component.invalidate();
      const rendered = component.render(160).join("\n");
      expect(rendered).toContain(
        "Lifecycle: turn=turn-1 · completion=done · process=done",
      );
      expect(rendered).toContain(
        "Recent events: turn_started → tool_activity(read) → completion(done)",
      );
      expect(rendered).toContain(
        "Output preview: Completed the recursive artifact inspection.",
      );
    });
  });

  it("refuses to follow a symlinked artifact tail", async () => {
    const dir = tempDir();
    const artifactDir = join(dir, "artifact");
    const real = join(dir, "real");
    mkdirSync(artifactDir, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "output.md"), "secret through a symlink");
    symlinkSync(join(real, "output.md"), join(artifactDir, "output.md"));
    const item = state("symlinked", { artifactDir });
    interactiveSubagentRegistry.set(item.id, item);
    const component = new InteractiveSupervisorComponent({ done: vi.fn() });

    component.handleInput("\r");
    await vi.waitFor(() => {
      component.invalidate();
      expect(component.render(160).join("\n")).toContain(
        "Output preview: none yet",
      );
    });
    expect(component.render(160).join("\n")).not.toContain(
      "secret through a symlink",
    );
  });

  it("compacts multi-line interpolated fields into single rows", async () => {
    const item = state("multiline", {
      name: "line\nbreaking",
      task: "First line of the prompt\nSecond line\n\nThird line",
      cwd: "/repo\nwith-newline",
      artifactDir: "unknown",
      attachCommand: "tmux attach -t a\nrm -rf /",
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
    });

    component.handleInput("\r");
    await vi.waitFor(() => {
      component.invalidate();
      expect(component.render(200).join("\n")).toContain(
        "Recent events: none yet",
      );
    });
    const lines = component.render(200);

    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(
      lines.some((line) =>
        line.includes("Task: First line of the prompt Second line Third line"),
      ),
    ).toBe(true);
    expect(lines.some((line) => line.includes("cwd: /repo with-newline"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("line breaking"))).toBe(true);
  });

  it("renders warning status lines under the list", () => {
    const item = state("warned");
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
      status: () => [
        "⚠ 3 lineage nodes hidden (1 cap, 2 stale)",
        "⚠ lineage refresh failing: EACCES",
      ],
    });

    const rendered = component.render(160).join("\n");

    expect(rendered).toContain("⚠ 3 lineage nodes hidden (1 cap, 2 stale)");
    expect(rendered).toContain("⚠ lineage refresh failing: EACCES");
  });

  it("warns when focus succeeds but no client is attached", async () => {
    const item = state("detached", {
      attachCommand: "tmux attach -t pi-subagent-detached",
    });
    const focus = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      focus,
      hasAttachedClient: async () => false,
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
    });

    component.handleInput("f");

    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(focus).toHaveBeenCalledWith(item);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("no client is attached"),
      "warning",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "tmux attach -t pi-subagent-detached",
    );
  });

  it("stays quiet when the backend cannot report attachment", async () => {
    const item = state("unknown-attach");
    const focus = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      focus,
      hasAttachedClient: async () => undefined,
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
    });

    component.handleInput("f");
    await vi.waitFor(() => expect(focus).toHaveBeenCalled());
    await Promise.resolve();

    expect(notify).not.toHaveBeenCalled();
  });

  it("renders a bounded elapsed marker instead of NaNs for a broken clock", () => {
    const item = state("broken-clock", { startedAt: Number.NaN });

    expect(formatSupervisorSummary(item, Date.now())).toContain(" · ? · ");
    expect(formatSupervisorSummary(item, Date.now())).not.toContain("NaN");
  });

  it("closes every open overlay, not just the most recent one", async () => {
    const firstDone = vi.fn();
    const secondDone = vi.fn();
    const openOverlay = (done: () => void) =>
      showInteractiveSupervisor({
        custom: async (factory: Function) => {
          factory({ requestRender: vi.fn() }, undefined, undefined, done);
          // Stay open until the shutdown hook closes us.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return { kind: "close" };
        },
        notify: vi.fn(),
      } as never);

    const first = openOverlay(firstDone);
    const second = openOverlay(secondDone);
    await Promise.resolve();
    closeActiveInteractiveSupervisor();
    await Promise.all([first, second]);

    expect(firstDone).toHaveBeenCalledWith({ kind: "close" });
    expect(secondDone).toHaveBeenCalledWith({ kind: "close" });
  });

  it("closes only overlays owned by the exact session generation", async () => {
    const firstDone = vi.fn();
    const secondDone = vi.fn();
    const releases: Array<() => void> = [];
    const openOverlay = (
      done: () => void,
      owner: { id: number; generation: number },
    ) =>
      showInteractiveSupervisor(
        {
          custom: async (factory: Function) => {
            factory({ requestRender: vi.fn() }, undefined, undefined, done);
            await new Promise<void>((resolve) => releases.push(resolve));
            return { kind: "close" };
          },
          notify: vi.fn(),
        } as never,
        {},
        owner,
      );

    const first = openOverlay(firstDone, { id: 1, generation: 3 });
    const second = openOverlay(secondDone, { id: 2, generation: 7 });
    await Promise.resolve();
    closeActiveInteractiveSupervisor({ id: 1, generation: 3 });
    expect(firstDone).toHaveBeenCalledWith({ kind: "close" });
    expect(secondDone).not.toHaveBeenCalled();
    closeActiveInteractiveSupervisor({ id: 2, generation: 7 });
    for (const release of releases) release();
    await Promise.all([first, second]);
    expect(secondDone).toHaveBeenCalledWith({ kind: "close" });
  });

  it("shows mux-native return controls with focus details", () => {
    const renderDetails = (item: InteractiveSubagentState): string => {
      interactiveSubagentRegistry.clear();
      interactiveSubagentRegistry.set(item.id, item);
      const component = new InteractiveSupervisorComponent({ done: vi.fn() });
      component.handleInput("\r");
      return component.render(160).join("\n");
    };

    process.env.TMUX = "/tmp/tmux.sock,1,0";
    const insideTmux = renderDetails(state("inside-tmux"));
    expect(insideTmux).not.toContain("Attach: tmux attach");
    expect(insideTmux).toContain("Focus: tmux select-pane");
    expect(insideTmux).toContain("Return: tmux prefix + ; (last pane)");

    delete process.env.TMUX;
    const outsideTmux = renderDetails(state("outside-tmux"));
    expect(outsideTmux).toContain("Attach: tmux attach");
    expect(outsideTmux).toContain("Focus: tmux select-pane");

    const tmuxWindow = renderDetails(
      state("tmux-window", { windowName: "agent-window" }),
    );
    expect(tmuxWindow).toContain("Return: tmux prefix + l (last window)");

    process.env.TMUX = "/tmp/tmux.sock,1,0";
    const zellij = renderDetails(
      state("zellij", {
        mux: "zellij",
        attachCommand: "zellij attach child-session",
        selectPaneCommand: "zellij action focus-pane --pane-id 42",
      }),
    );
    expect(zellij).toContain("Attach: zellij attach child-session");
    expect(zellij).toContain("Focus: zellij action focus-pane");
    expect(zellij).toContain("Return: Ctrl+p, then p (previous pane)");

    const zellijTab = renderDetails(
      state("zellij-tab", {
        mux: "zellij",
        windowName: "agent-tab",
      }),
    );
    expect(zellijTab).toContain("Return: Ctrl+t, then Tab (last tab)");
  });

  it("shows why and from where an interactive agent is projected", () => {
    const projected = state("projected", { parentSessionId: "owner-session" });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      items: () => [
        {
          kind: "interactive",
          state: projected,
          depth: 1,
          actionable: true,
          origin: {
            source: "lineage",
            rootId: "root-session",
            ownerSessionId: "owner-session",
            parentAgentId: "parent-agent",
          },
        },
      ],
    });

    expect(component.render(160).join("\n")).toContain("[lineage]");
    component.handleInput("\r");
    expect(component.render(160).join("\n")).toContain(
      "Origin: persisted lineage · owner=owner-session · root=root-session · parent=parent-agent",
    );
    expect(component.render(200).join("\n")).toContain(
      "Recovery: persisted lineage projection; after crash/orphan, liveness does not restore workflow ownership or routing authority",
    );
  });

  it("uses the direct cancellation path only for x", () => {
    interactiveSubagentRegistry.set("one", state("one"));
    const done = vi.fn();
    const cancel = vi
      .fn()
      .mockReturnValue(state("one", { status: "cancelled" }));
    const component = new InteractiveSupervisorComponent({ done, cancel });

    component.handleInput("x");

    expect(cancel).toHaveBeenCalledWith("one");
    expect(done).not.toHaveBeenCalled();
  });

  it("hides inactive items and removes an item immediately after cancellation", () => {
    const active = state("active", { name: "active-agent" });
    const stale = state("stale", { name: "stale-agent", status: "unknown" });
    const cancel = vi.fn(() => {
      active.status = "cancelled";
      return active;
    });
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      items: () => [
        { kind: "interactive", state: active, depth: 0, actionable: true },
        {
          kind: "interactive",
          state: stale,
          depth: 0,
          actionable: false,
        },
      ],
    });

    expect(component.render(120).join("\n")).toContain("active-agent");
    expect(component.render(120).join("\n")).not.toContain("stale-agent");
    component.handleInput("x");

    expect(cancel).toHaveBeenCalledWith(active.id);
    expect(component.render(120).join("\n")).not.toContain("active-agent");
  });

  it("cancels registered in-process jobs and workflows from the overlay", async () => {
    const processAbort = new AbortController();
    const processJob = inProcessJob("registered-job", { abort: processAbort });
    const workflow = workflowJob("registered-workflow");
    const workflowAbort = vi.spyOn(workflow.abort, "abort");
    jobRegistry.set(processJob.id, processJob);
    workflowJobRegistry.set(workflow.id, workflow);
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    registerInteractiveSupervisor({
      registerCommand: (
        _name: string,
        command: { handler: typeof commandHandler },
      ) => {
        commandHandler = command.handler;
      },
      registerShortcut: vi.fn(),
    } as never);
    const custom = vi.fn(async (factory: Function) => {
      const component = factory(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      component.handleInput("x");
      component.handleInput("j");
      component.handleInput("x");
      return { kind: "close" };
    });
    const ui = {
      custom,
      confirm: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
    };

    await commandHandler?.("", { ui });

    expect(processAbort.signal.aborted).toBe(true);
    expect(processJob.status).toBe("cancelled");
    expect(workflowAbort).toHaveBeenCalledOnce();
    expect(workflow.status).toBe("cancelled");
    expect(workflow.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
  });

  it("handles the toggle shortcut while focused and disposes its timer", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const requestRender = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done,
      requestRender,
      refreshIntervalMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    expect(requestRender).toHaveBeenCalled();
    component.handleInput("\u001b[97;7u");
    expect(done).toHaveBeenCalledWith({ kind: "close" });

    component.dispose();
    requestRender.mockClear();
    vi.advanceTimersByTime(2_000);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("skips overlapping refresh ticks while a refresh is in flight", async () => {
    vi.useFakeTimers();
    let resolveRefresh!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const requestRender = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      requestRender,
      refresh,
      refreshIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    component.dispose();
  });

  it("hides exited registry children and ignores cancellation input", () => {
    const exited = state("exited-child", { status: "exited" });
    interactiveSubagentRegistry.set(exited.id, exited);
    const cancel = vi.fn();
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      cancel,
      notify,
    });

    expect(component.render(120).join("\n")).not.toContain(exited.name);
    component.handleInput("x");

    expect(cancel).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("hides exited registry children without treating an alive pane as stale", async () => {
    const sessionRoot = tempDir();
    const rootId = "projected-root";
    const artifactDir = join(sessionRoot, "artifact");
    const paths = await resolveLineageStorePaths(sessionRoot, rootId);
    const exited = state("projected-exited", {
      artifactDir,
      cwd: sessionRoot,
      parentSessionId: rootId,
      status: "exited",
    });
    const previousRootId = process.env.PI_SUBAGENTURA_ROOT_ID;
    const previousSessionRoot = process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    let rendered = "";
    mkdirSync(artifactDir);
    await writeLineageManifestAtomic(paths.nodesDir, {
      schemaVersion: LINEAGE_SCHEMA_VERSION,
      agentId: exited.id,
      rootId,
      rootHash: hashLineageRoot(rootId),
      ownerSessionId: rootId,
      name: exited.name,
      taskPreview: exited.task,
      startedAt: new Date(exited.startedAt).toISOString(),
      cwd: exited.cwd,
      pane: { backend: "tmux", paneId: exited.paneId },
      artifactDir,
    });
    const getPaneLivenessAsync = vi.fn().mockResolvedValue("alive");
    interactiveSubagentRegistry.set(exited.id, exited);
    __setTmuxMultiplexer({
      getPaneLivenessAsync,
      getPaneLiveness: vi.fn().mockReturnValue("dead"),
    } as never);
    process.env.PI_SUBAGENTURA_ROOT_ID = rootId;
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = sessionRoot;
    registerInteractiveSupervisor(
      {
        registerCommand: (
          _name: string,
          command: { handler: typeof commandHandler },
        ) => {
          commandHandler = command.handler;
        },
        registerShortcut: vi.fn(),
      } as never,
      undefined,
      createRootSpawnTreeContext(rootId, sessionRoot),
    );
    const custom = vi.fn(async (factory: Function) => {
      const component = factory(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      rendered = component.render(160).join("\n");
      return { kind: "close" };
    });

    try {
      await commandHandler?.("", {
        ui: { custom, confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn() },
        sessionManager: { getSessionId: () => rootId },
      });

      expect.soft(rendered).not.toContain(exited.name);
      expect(exited.status).toBe("exited");
      expect(getPaneLivenessAsync).toHaveBeenCalledWith(
        exited.paneId,
        undefined,
      );
      expect(readdirSync(paths.nodesDir)).toContain(`${exited.id}.json`);
    } finally {
      if (previousRootId === undefined)
        delete process.env.PI_SUBAGENTURA_ROOT_ID;
      else process.env.PI_SUBAGENTURA_ROOT_ID = previousRootId;
      if (previousSessionRoot === undefined)
        delete process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
      else
        process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = previousSessionRoot;
    }
  });

  it("skips artifact reads for unknown sentinel artifactDir", async () => {
    const dir = tempDir();
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync("unknown");
      writeFileSync(
        join("unknown", "events.ndjson"),
        `${JSON.stringify({ type: "done", outcome: "success" })}\n`,
      );
      writeFileSync(join("unknown", "output.md"), "should-not-appear");

      const item = state("sentinel", { artifactDir: "unknown" });
      const component = new InteractiveSupervisorComponent({
        done: vi.fn(),
        items: () => [
          { kind: "interactive", state: item, depth: 0, actionable: true },
        ],
      });

      component.handleInput("\r");
      await vi.waitFor(() => {
        component.invalidate();
        expect(
          component
            .render(160)
            .some((line) => line.includes("Recent events: none yet")),
        ).toBe(true);
      });
      const lines = component.render(160);
      expect(lines.some((line) => line.includes("should-not-appear"))).toBe(
        false,
      );
      expect(lines.some((line) => line.includes("success"))).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("renders a full-screen theme backdrop behind the supervisor", async () => {
    const hideBackdrop = vi.fn();
    const showOverlay = vi.fn(
      (
        _component: { render: (width: number) => string[] },
        _options: Record<string, unknown>,
      ) => ({ hide: hideBackdrop }),
    );
    const bg = vi.fn(
      (color: string, text: string) => `<${color}>${text}</${color}>`,
    );
    const fg = vi.fn(
      (color: string, text: string) => `<${color}>${text}</${color}>`,
    );
    const custom = vi.fn(async (factory: Function) => {
      factory(
        {
          requestRender: vi.fn(),
          showOverlay,
          terminal: { rows: 3 },
        },
        { bg, fg },
        undefined,
        vi.fn(),
      );
      return { kind: "close" };
    });

    await showInteractiveSupervisor({ custom, notify: vi.fn() } as never);

    expect(showOverlay).toHaveBeenCalledOnce();
    const [backdrop, options] = showOverlay.mock.calls[0];
    expect(options).toEqual({
      anchor: "center",
      width: "100%",
      maxHeight: "100%",
      nonCapturing: true,
    });
    expect(backdrop.render(4)).toEqual([
      "<customMessageBg><dim>░   </dim></customMessageBg>",
      "<customMessageBg><dim>  ░ </dim></customMessageBg>",
      "<customMessageBg><dim>░   </dim></customMessageBg>",
    ]);
    expect(hideBackdrop).toHaveBeenCalledOnce();
  });

  it("reports a failing action instead of throwing out of the overlay", async () => {
    const item = state("failing-action");
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      view: vi.fn().mockRejectedValue(new Error("capture-pane exploded")),
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
    });

    component.handleInput("v");

    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith(
      "Unable to view: capture-pane exploded",
      "error",
    );
  });

  it("disposes the component and hides the backdrop when the host rejects", async () => {
    const hideBackdrop = vi.fn();
    let component: InteractiveSupervisorComponent | undefined;
    const custom = vi.fn(async (factory: Function) => {
      component = factory(
        {
          requestRender: vi.fn(),
          showOverlay: () => ({ hide: hideBackdrop }),
          terminal: { rows: 2 },
        },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      throw new Error("overlay host went away");
    });

    await expect(
      showInteractiveSupervisor({ custom, notify: vi.fn() } as never),
    ).rejects.toThrow("overlay host went away");

    expect(hideBackdrop).toHaveBeenCalledOnce();
    // Disposed: a second dispose is a no-op and the refresh timer is cleared.
    expect(() => component?.dispose()).not.toThrow();
    // The done handle was released, so a later shutdown does not call it.
    expect(() => closeActiveInteractiveSupervisor()).not.toThrow();
  });

  it("reports a clear fallback outside Pi TUI sessions", async () => {
    const notify = vi.fn();

    await showInteractiveSupervisor({ notify } as never);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("only available in Pi TUI sessions"),
      "info",
    );
  });

  it("routes focus and bounded capture through the creating mux", async () => {
    const focusPane = vi.fn().mockResolvedValue(undefined);
    const capturePane = vi.fn().mockResolvedValue({
      output: "recent output",
      truncated: false,
    });
    __setTmuxMultiplexer({ focusPane, capturePane } as never);
    const item = state("mux-route", {
      paneId: "%42",
      windowName: "agent-window",
      muxSession: "agent-session",
    });

    await focusInteractiveSubagent(item);
    const capture = await captureInteractiveSubagent(item, {
      maxBytes: 1024,
      maxLines: 20,
    });

    const paneRef = {
      paneId: "%42",
      windowName: "agent-window",
      session: "agent-session",
    };
    expect(focusPane).toHaveBeenCalledWith(paneRef);
    expect(capturePane).toHaveBeenCalledWith(paneRef, {
      maxBytes: 1024,
      maxLines: 20,
    });
    expect(capture.output).toBe("recent output");
  });

  it("hides unsafe recursive nodes and dispatches native view", async () => {
    const root = state("root");
    const child = state("child");
    const nativeView = vi.fn().mockResolvedValue(undefined);
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      nativeView,
      items: () => [
        { state: root, depth: 0, actionable: true },
        {
          state: child,
          depth: 1,
          actionable: false,
        },
      ],
    });

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain(root.name);
    expect(rendered).not.toContain(child.name);

    component.handleInput("n");
    await vi.waitFor(() => expect(nativeView).toHaveBeenCalledWith(root));
  });

  it("requires confirmation before the registered subtree action runs", async () => {
    const root = state("root");
    interactiveSubagentRegistry.set(root.id, root);
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    registerInteractiveSupervisor({
      registerCommand: (
        _name: string,
        command: { handler: typeof commandHandler },
      ) => {
        commandHandler = command.handler;
      },
      registerShortcut: vi.fn(),
    } as never);
    const confirm = vi.fn().mockResolvedValue(false);
    const custom = vi.fn(async (factory: Function) => {
      const component = factory(
        { requestRender: vi.fn() },
        undefined,
        undefined,
        vi.fn(),
      ) as InteractiveSupervisorComponent;
      component.handleInput("X");
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
      return { kind: "close" };
    });
    const ui = { custom, confirm, notify: vi.fn() };

    await commandHandler?.("", { ui });

    expect(confirm).toHaveBeenCalledWith(
      "Cancel interactive subagent subtree?",
      expect.stringContaining("retains artifacts"),
    );
    expect(interactiveSubagentRegistry.has(root.id)).toBe(true);
  });

  it("does not authorize lineage projection from ambient environment alone", async () => {
    const rootId = "ambient-root";
    const sessionRoot = tempDir();
    process.env.PI_SUBAGENTURA_ROOT_ID = rootId;
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = sessionRoot;
    const paths = await resolveLineageStorePaths(sessionRoot, rootId);
    await writeLineageManifestAtomic(paths.nodesDir, {
      schemaVersion: LINEAGE_SCHEMA_VERSION,
      agentId: "external-live-agent",
      rootId,
      rootHash: hashLineageRoot(rootId),
      ownerSessionId: rootId,
      name: "external-live-agent",
      taskPreview: "must remain isolated",
      startedAt: new Date().toISOString(),
      cwd: sessionRoot,
      pane: { backend: "tmux", paneId: "%external" },
    });
    const killPane = vi.fn();
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
      getPaneLiveness: () => "alive",
      killPane,
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t external",
        focusCommand: "tmux select-pane -t %external",
      }),
    } as never);
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    registerInteractiveSupervisor({
      registerCommand: (_name: string, command: { handler: any }) => {
        commandHandler = command.handler;
      },
      registerShortcut: vi.fn(),
    } as never);
    let rendered = "";
    await commandHandler?.("", {
      sessionManager: { getSessionId: () => rootId },
      ui: {
        custom: async (factory: Function) => {
          const component = factory(
            { requestRender: vi.fn() },
            undefined,
            undefined,
            vi.fn(),
          ) as InteractiveSupervisorComponent;
          rendered = component.render(200).join("\n");
          component.handleInput("x");
          return { kind: "close" };
        },
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
    });

    expect(rendered).not.toContain("external-live-agent");
    expect(killPane).not.toHaveBeenCalled();
    expect(readdirSync(paths.nodesDir)).toContain("external-live-agent.json");
  });

  it("keeps live workflow-origin lineage diagnostic-only", async () => {
    const harness = await lineageHarness("workflow-orphan-root");
    await harness.writeNode("workflow-orphan", {
      paneId: "%workflow",
      runtimeKind: "workflow",
    });
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
      getPaneLiveness: () => "alive",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    const { rendered } = await harness.open();

    expect(rendered).not.toContain("agent-workflow-orphan");
    expect(await harness.nodeFiles()).toEqual(["workflow-orphan.json"]);
  });

  it("probes terminal registry nodes and prunes only confirmed-dead panes", async () => {
    const harness = await lineageHarness("terminal-probe-root");
    await harness.writeNode("alive", { paneId: "%alive" });
    await harness.writeNode("unknown", { paneId: "%unknown" });
    await harness.writeNode("dead", { paneId: "%dead" });
    for (const id of ["alive", "unknown", "dead"]) {
      interactiveSubagentRegistry.set(id, state(id, { status: "exited" }));
    }
    const getPaneLivenessAsync = vi.fn(async (paneId: string) =>
      paneId === "%dead" ? "dead" : paneId === "%unknown" ? "unknown" : "alive",
    );
    __setTmuxMultiplexer({
      getPaneLivenessAsync,
      getPaneLiveness: () => "alive",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    await harness.open();

    const probedPanes = getPaneLivenessAsync.mock.calls.map(
      ([paneId]) => paneId,
    );
    expect(probedPanes).toEqual(
      expect.arrayContaining(["%alive", "%unknown", "%dead"]),
    );
    expect(await harness.nodeFiles()).toEqual(["alive.json", "unknown.json"]);
  });

  it("retains dead direct-child lineage while persisted recovery remains possible", async () => {
    const rootId = "recoverable-root";
    const harness = await lineageHarness(rootId);
    await harness.writeNode("recoverable", { paneId: "%dead" });
    interactiveSubagentRegistry.set(
      "recoverable",
      state("recoverable", {
        status: "exited",
        parentSessionId: rootId,
        completionOwner: "standalone",
      }),
    );
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "dead",
      getPaneLiveness: () => "dead",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    await harness.open();

    expect(await harness.nodeFiles()).toEqual(["recoverable.json"]);
  });

  it("prunes dead lineage manifests while projecting", async () => {
    const harness = await lineageHarness("prune-root");
    await harness.writeNode("dead", { paneId: "%dead" });
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "dead",
      getPaneLiveness: () => "dead",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    await harness.open();

    expect(await harness.nodeFiles()).toEqual([]);
  });

  it("keeps unknown lineage panes visible and retained", async () => {
    const harness = await lineageHarness("unknown-root");
    await harness.writeNode("unknown", { paneId: "%unknown" });
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "unknown",
      getPaneLiveness: () => "unknown",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    const { rendered } = await harness.open();

    expect(rendered).toContain("agent-unknown");
    expect(await harness.nodeFiles()).toEqual(["unknown.json"]);
  });

  it("retains unsupported backends without exposing tmux actions", async () => {
    const harness = await lineageHarness("unsupported-root");
    await harness.writeNode("unsupported", {
      paneId: "remote-pane",
      backend: "remote",
    });
    const getPaneLivenessAsync = vi.fn();
    const buildAttachCommands = vi.fn();
    const killPane = vi.fn();
    __setTmuxMultiplexer({
      getPaneLivenessAsync,
      getPaneLiveness: vi.fn(),
      buildAttachCommands,
      killPane,
    } as never);

    const { rendered } = await harness.open((component) => {
      component.handleInput("f");
      component.handleInput("x");
      component.handleInput("X");
    });

    expect(rendered).not.toContain("agent-unsupported");
    expect(await harness.nodeFiles()).toEqual(["unsupported.json"]);
    expect(getPaneLivenessAsync).not.toHaveBeenCalled();
    expect(buildAttachCommands).not.toHaveBeenCalled();
    expect(killPane).not.toHaveBeenCalled();
  });

  it("keeps the persisted tree when one dead pane cannot resolve attach commands", async () => {
    const harness = await lineageHarness("poisoned-root");
    await harness.writeNode("alive", { paneId: "%alive" });
    await harness.writeNode("zombie", { paneId: "%zombie" });
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async (paneId: string) =>
        paneId === "%alive" ? "alive" : "dead",
      getPaneLiveness: () => "alive",
      buildAttachCommands: ({ paneId }: { paneId: string }) => {
        if (paneId === "%zombie") {
          throw new Error("[tmux] display-message failed: can't find pane");
        }
        return {
          attachCommand: "tmux attach -t alive",
          focusCommand: "tmux select-window -t alive",
        };
      },
    } as never);

    const { rendered, notify } = await harness.open();

    // A throwing attach lookup for one dead node used to reject the whole
    // projection and silently degrade the overlay to registry-only.
    expect(rendered).toContain("[lineage]");
    expect(rendered).toContain("agent-alive");
    expect(notify).not.toHaveBeenCalled();
  });

  it("reports hidden lineage nodes in the overlay footer", async () => {
    const harness = await lineageHarness("footer-root");
    await harness.writeNode("live", { paneId: "%live" });
    await harness.writeNode("orphan", {
      paneId: "%orphan",
      parentAgentId: "missing-parent",
    });
    await harness.writeBroken("broken");
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
      getPaneLiveness: () => "alive",
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    const { rendered } = await harness.open();

    expect(rendered).toMatch(/⚠ \d+ lineage nodes? hidden \(/);
    expect(rendered).toContain("malformed");
    expect(rendered).toContain("orphan");
  });

  it("reports a failing lineage refresh in the footer", async () => {
    const previousRootId = process.env.PI_SUBAGENTURA_ROOT_ID;
    const previousSessionRoot = process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
    // A session root that is a FILE makes path resolution reject.
    const file = join(tempDir(), "not-a-directory");
    writeFileSync(file, "");
    process.env.PI_SUBAGENTURA_ROOT_ID = "failing-root";
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = file;
    let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    let rendered = "";
    registerInteractiveSupervisor(
      {
        registerCommand: (_name: string, command: { handler: any }) => {
          commandHandler = command.handler;
        },
        registerShortcut: vi.fn(),
      } as never,
      undefined,
      createRootSpawnTreeContext("failing-root", file),
    );
    try {
      await commandHandler?.("", {
        ui: {
          custom: async (factory: Function) => {
            const component = factory(
              { requestRender: vi.fn() },
              undefined,
              undefined,
              vi.fn(),
            ) as InteractiveSupervisorComponent;
            rendered = component.render(200).join("\n");
            return { kind: "close" };
          },
          confirm: vi.fn(),
          notify: vi.fn(),
          setStatus: vi.fn(),
        },
        sessionManager: { getSessionId: () => "failing-root" },
      });
      expect(rendered).toContain("⚠ lineage refresh failing:");
    } finally {
      if (previousRootId === undefined)
        delete process.env.PI_SUBAGENTURA_ROOT_ID;
      else process.env.PI_SUBAGENTURA_ROOT_ID = previousRootId;
      if (previousSessionRoot === undefined)
        delete process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
      else
        process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = previousSessionRoot;
    }
  });

  it("confirms the subtree the user saw, with its descendant count", async () => {
    const harness = await lineageHarness("subtree-root");
    await harness.writeNode("parent", { paneId: "%parent" });
    await harness.writeNode("kid-a", {
      paneId: "%kid-a",
      parentAgentId: "parent",
    });
    await harness.writeNode("kid-b", {
      paneId: "%kid-b",
      parentAgentId: "kid-a",
    });
    const killed: string[] = [];
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
      getPaneLiveness: () => "alive",
      killPane: (paneId: string) => killed.push(paneId),
      buildAttachCommands: () => ({
        attachCommand: "tmux attach -t x",
        focusCommand: "tmux select-window -t x",
      }),
    } as never);

    const { confirm, notify } = await harness.open((component) => {
      for (let index = 0; index < 3; index++) component.handleInput("k");
      for (let index = 0; index < 3; index++) {
        const selected = component
          .render(200)
          .find((line) => line.includes("▶"));
        if (selected?.includes("agent-parent")) break;
        component.handleInput("j");
      }
      expect(
        component.render(200).find((line) => line.includes("▶")),
      ).toContain("agent-parent");
      component.handleInput("X");
    });

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(confirm.mock.calls[0][1]).toContain("2 descendants");
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls.at(-1)?.[0]).toContain("Subtree cancellation:");
    expect(killed.sort()).toEqual(["%kid-a", "%kid-b", "%parent"]);
  });

  it("reports subtree skip reasons in their own buckets", () => {
    const base: CancelSubtreeResult = {
      attempted: [],
      cancelled: ["a"],
      alreadyTerminal: ["b"],
      stale: ["c"],
      orphan: ["d"],
      cycle: ["e"],
      truncated: ["f"],
      malformed: ["g"],
      failed: [],
      recovered: ["f"],
      projectionTruncated: true,
    };

    const message = formatSubtreeCancellation(base);

    expect(message).toContain("1 cancelled");
    expect(message).toContain("1 already terminal");
    expect(message).toContain("1 stale");
    expect(message).toContain("1 orphaned");
    expect(message).toContain("1 cyclic");
    expect(message).toContain("1 beyond the cap");
    expect(message).toContain("1 malformed");
    expect(message).toContain("0 failed");
    expect(message).toContain("missing from the displayed tree");
    expect(message).toContain("treat this result as incomplete");
    // Empty buckets are omitted so a clean run stays short.
    expect(
      formatSubtreeCancellation({
        ...base,
        stale: [],
        orphan: [],
        cycle: [],
        truncated: [],
        malformed: [],
        recovered: [],
        projectionTruncated: false,
      }),
    ).toBe("Subtree cancellation: 1 cancelled, 1 already terminal, 0 failed.");
  });

  it("summarizes hidden-node counts and refresh failures for the footer", () => {
    expect(
      supervisorStatusLines(
        {
          items: [],
          nodes: new Map(),
          manifests: [],
          truncated: true,
          issues: [
            { kind: "stale", reason: "node is stale" },
            { kind: "stale", reason: "node is stale" },
            { kind: "truncated", reason: "node cap reached" },
          ],
        } as never,
        "EACCES",
      ),
    ).toEqual([
      "⚠ 3 lineage nodes hidden (2 stale, 1 cap)",
      "⚠ lineage view is truncated — subtree cancellation may reach nodes not listed here",
      "⚠ lineage refresh failing: EACCES",
    ]);
    expect(supervisorStatusLines(undefined, undefined)).toEqual([]);
  });

  it("renders an explicit legend without truncation at the minimum width", () => {
    const component = new InteractiveSupervisorComponent({ done: vi.fn() });
    const lines = component.render(60);

    expect(lines).toContain(
      "│ All: ↑↓/jk select · enter/→ details · ← collapse",
    );
    expect(lines).toContain("│ All: x cancel item · r refresh · q/esc close");
    expect(lines).toContain(
      "│ Interactive: v snapshot · n native viewer · f focus",
    );
    expect(lines).toContain(
      "│ Interactive: a show attach cmd · X cancel subtree",
    );
    expect(lines).toContain("│ Focus: expand first to see native return keys");
    expect(lines).toContain("│ Sources: registry=live · lineage=persisted");
    expect(lines.every((line) => line.length <= 60)).toBe(true);
  });

  it("labels the selected agent's attach command without changing it", () => {
    const item = state("attach", {
      name: "selected-agent",
      attachCommand: "tmux attach -t exact-session --foo",
    });
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      items: () => [
        { kind: "interactive", state: item, depth: 0, actionable: true },
      ],
    });

    component.handleInput("a");

    expect(notify).toHaveBeenCalledWith(
      "Attach command for selected-agent:\ntmux attach -t exact-session --foo",
      "info",
    );
  });

  it("hides inactive items of every async type", () => {
    const terminal = state("terminal", {
      name: "terminal-agent",
      status: "exited",
    });
    const completed = inProcessJob("completed-job", { status: "done" });
    const stale = state("stale", { name: "stale-agent" });
    const notify = vi.fn();
    const component = new InteractiveSupervisorComponent({
      done: vi.fn(),
      notify,
      items: () => [
        {
          kind: "interactive",
          state: terminal,
          depth: 0,
          actionable: false,
        },
        {
          kind: "in-process",
          job: completed,
          depth: 0,
          actionable: false,
        },
        {
          kind: "interactive",
          state: stale,
          depth: 0,
          actionable: false,
        },
      ],
    });

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("No async subagents");
    expect(rendered).not.toContain(terminal.name);
    expect(rendered).not.toContain(completed.id);
    expect(rendered).not.toContain(stale.name);
    component.handleInput("f");
    component.handleInput("x");
    component.handleInput("X");
    expect(notify).not.toHaveBeenCalled();
  });
});
