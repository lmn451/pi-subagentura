import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobRegistry } from "../src/helpers";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { registerSessionHandlers } from "../src/session-handlers";
import { updateRunningSubagentFooter } from "../src/artifact-poller";
import { workflowJobRegistry } from "../src/workflow-jobs";
import { appendEvent, artifactPath } from "../src/artifact";
import { __setTmuxMultiplexer } from "../src/multiplexer";

function registerHandlers() {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
    sendMessage: vi.fn(),
  };
  const sessionContext = registerSessionHandlers(pi as any);
  return { handlers, pi, sessionContext };
}

describe("session handler lifecycle callbacks", () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "pi-subagentura-session-handlers-"));
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    const globalState = globalThis as any;
    globalState.__piSubagenturaInteractivePollerHandle = undefined;
    globalState.__piSubagenturaPiRef = undefined;
    globalState.__piSubagenturaUi = undefined;
    globalState.__piSubagenturaSessionManager = undefined;
    globalState.__piSubagenturaParentStreaming = false;
    const contextStack = globalState.__piSubagenturaSessionContextStack;
    if (Array.isArray(contextStack)) {
      contextStack.length = 0;
    }
    globalState.__piSubagenturaSessionContextIdCounter = 0;
  });

  afterEach(() => {
    const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
    if (handle) clearInterval(handle);
    vi.useRealTimers();
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    __setTmuxMultiplexer(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("tracks streaming state, captures session context, and shuts down jobs", async () => {
    const { handlers, pi, sessionContext } = registerHandlers();
    const sessionManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const ui = { notify: vi.fn() };
    const ctx = { cwd: root, ui, sessionManager };

    handlers.get("agent_start")![0]();
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(true);

    handlers.get("agent_settled")![0]();
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false);

    handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    expect((globalThis as any).__piSubagenturaUi).toBe(ui);
    expect((globalThis as any).__piSubagenturaSessionManager).toBe(
      sessionManager,
    );

    handlers.get("session_shutdown")![0]();

    const abort = vi.fn(() => Promise.reject(new Error("already disposed")));
    jobRegistry.set("job-1", {
      id: "job-1",
      status: "running",
      session: { abort },
    } as any);
    const workflowAbort = new AbortController();
    workflowJobRegistry.set("workflow-1", {
      id: "workflow-1",
      status: "running",
      abort: workflowAbort,
      parentSessionOwner: {
        id: sessionContext.id,
        generation: sessionContext.generation,
      },
    } as any);

    await handlers.get("session_shutdown")![1]({ reason: "quit" }, ctx);
    await Promise.resolve();

    expect(abort).toHaveBeenCalledOnce();
    expect(workflowAbort.signal.aborted).toBe(true);
    expect(jobRegistry.size).toBe(0);
    expect(workflowJobRegistry.size).toBe(0);
    expect((globalThis as any).__piSubagenturaPiRef).toBeUndefined();
    expect(pi.on).toHaveBeenCalled();
  });

  it("keeps parent async jobs and footer visible after nested session shutdown", () => {
    const parent = registerHandlers();
    const child = registerHandlers();
    const parentUi = { setStatus: vi.fn() };
    const parentSessionManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const childSessionManager = {
      getSessionId: () => "child-session",
      getEntries: () => [],
    };
    const parentCtx = {
      cwd: root,
      ui: parentUi,
      sessionManager: parentSessionManager,
    };
    const childCtx = {
      cwd: root,
      ui: parentUi,
      sessionManager: childSessionManager,
    };

    parent.handlers.get("session_start")![0](
      { reason: "startup" },
      parentCtx as any,
    );
    child.handlers.get("session_start")![0](
      { reason: "startup" },
      childCtx as any,
    );

    const parentWorkflow = {
      id: "parent-workflow",
      status: "running",
      abort: new AbortController(),
      parentSessionOwner: {
        id: parent.sessionContext.id,
        generation: parent.sessionContext.generation,
      },
    } as any;
    const childWorkflow = {
      id: "child-workflow",
      status: "running",
      abort: new AbortController(),
      parentSessionOwner: {
        id: child.sessionContext.id,
        generation: child.sessionContext.generation,
      },
    } as any;
    workflowJobRegistry.set(parentWorkflow.id, parentWorkflow);
    workflowJobRegistry.set(childWorkflow.id, childWorkflow);

    jobRegistry.set("running-parent-job", {
      id: "running-parent-job",
      status: "running",
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
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      promise: new Promise<never>(() => {}),
    } as any);

    updateRunningSubagentFooter(parentUi as any);
    expect(parentUi.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
    parentUi.setStatus.mockClear();

    const parentState: InteractiveSubagentState = {
      id: "parent-interactive",
      name: "parent-interactive",
      task: "parent task",
      paneId: "%parent",
      cwd: root,
      artifactDir: join(root, "parent-interactive"),
      sessionFile: join(root, "parent-interactive.jsonl"),
      startedAt: Date.now(),
      mux: "tmux",
      status: "exited",
      parentSessionId: "parent-session",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
    };
    const childState: InteractiveSubagentState = {
      ...parentState,
      id: "child-interactive",
      name: "child-interactive",
      paneId: "%child",
      artifactDir: join(root, "child-interactive"),
      sessionFile: join(root, "child-interactive.jsonl"),
      parentSessionId: "child-session",
    };
    interactiveSubagentRegistry.set(parentState.id, parentState);
    interactiveSubagentRegistry.set(childState.id, childState);

    child.handlers.get("session_shutdown")![1](
      { reason: "agent_settled" },
      childCtx as any,
    );
    expect(jobRegistry.size).toBe(1);
    expect(childWorkflow.abort.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has(childWorkflow.id)).toBe(false);
    expect(workflowJobRegistry.get(parentWorkflow.id)).toBe(parentWorkflow);
    expect(interactiveSubagentRegistry.get(parentState.id)).toBe(parentState);
    expect(interactiveSubagentRegistry.has(childState.id)).toBe(false);
    expect((globalThis as any).__piSubagenturaPiRef).toBe(parent.pi);
    expect((globalThis as any).__piSubagenturaSessionManager).toBe(
      parentSessionManager,
    );

    updateRunningSubagentFooter(parentUi as any);
    expect(parentUi.setStatus).not.toHaveBeenCalled();
  });

  it("tears down every stale descendant owner before preserving an ancestor", () => {
    const parent = registerHandlers();
    const child = registerHandlers();
    const parentManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const childManager = {
      getSessionId: () => "child-session",
      getEntries: () => [],
    };
    parent.handlers.get("session_start")![0]({ reason: "startup" }, {
      cwd: root,
      ui: {},
      sessionManager: parentManager,
    } as any);
    child.handlers.get("session_start")![0]({ reason: "startup" }, {
      cwd: root,
      ui: {},
      sessionManager: childManager,
    } as any);

    const descendantId = 4_244;
    const descendantGeneration = 1;
    const descendantSessionId = "descendant-session";
    const descendantAccessor = vi.fn(() => descendantSessionId);
    (globalThis as any).__piSubagenturaSessionContextStack.push({
      id: descendantId,
      generation: descendantGeneration,
      lifecycle: "started",
      pi: {} as any,
      sessionManager: { getSessionId: descendantAccessor },
    });

    const workflowAbort = new AbortController();
    workflowJobRegistry.set("descendant-workflow", {
      id: "descendant-workflow",
      status: "running",
      abort: workflowAbort,
      parentSessionOwner: {
        id: descendantId,
        generation: descendantGeneration,
      },
    } as any);
    const jobAbort = vi.fn().mockResolvedValue(undefined);
    jobRegistry.set("descendant-job", {
      id: "descendant-job",
      status: "running",
      session: { abort: jobAbort },
      deliveryOwner: {
        sessionContextId: descendantId,
        sessionContextGeneration: descendantGeneration,
      },
    } as any);
    const artifactDir = join(root, "descendant-interactive");
    mkdirSync(artifactDir, { recursive: true });
    const descendantState: InteractiveSubagentState = {
      id: "descendant-interactive",
      name: "descendant",
      task: "nested task",
      paneId: "%descendant",
      cwd: root,
      artifactDir,
      sessionFile: join(root, "descendant.jsonl"),
      startedAt: Date.now(),
      mux: "tmux",
      status: "unknown",
      parentSessionId: descendantSessionId,
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
    };
    interactiveSubagentRegistry.set(descendantState.id, descendantState);
    const killPane = vi.fn();
    __setTmuxMultiplexer({
      getPaneLiveness: () => "unknown",
      killPane,
    } as any);

    child.handlers.get("session_shutdown")![1]({ reason: "new" }, {
      cwd: root,
      sessionManager: childManager,
    } as any);

    expect(descendantAccessor).toHaveBeenCalledOnce();
    expect(workflowAbort.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has("descendant-workflow")).toBe(false);
    expect(jobAbort).toHaveBeenCalledOnce();
    expect(jobRegistry.has("descendant-job")).toBe(false);
    expect(interactiveSubagentRegistry.has(descendantState.id)).toBe(false);
    expect(killPane).toHaveBeenCalledWith("%descendant", undefined);
    expect((globalThis as any).__piSubagenturaPiRef).toBe(parent.pi);
  });

  it("snapshots owned in-process jobs before a nested shutdown aborts them", () => {
    const snapshotDir = join(root, "snapshots");
    const previousMode = process.env.SUBAGENT_CANCEL_SNAPSHOT;
    const previousDir = process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR;
    process.env.SUBAGENT_CANCEL_SNAPSHOT = "full";
    process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR = snapshotDir;
    try {
      const parent = registerHandlers();
      const child = registerHandlers();
      const parentManager = {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      };
      const childManager = {
        getSessionId: () => "child-session",
        getEntries: () => [],
      };
      parent.handlers.get("session_start")![0]({ reason: "startup" }, {
        cwd: root,
        ui: {},
        sessionManager: parentManager,
      } as any);
      child.handlers.get("session_start")![0]({ reason: "startup" }, {
        cwd: root,
        ui: {},
        sessionManager: childManager,
      } as any);
      const abort = new AbortController();
      const childJob = {
        id: "nested-job",
        status: "running",
        abort,
        cwd: root,
        startedAt: Date.now(),
        liveStatus: {
          turn: 2,
          output: "half-written analysis",
          activeTool: { name: "read", args: { path: "src/main.ts" } },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 2,
          },
        },
        session: { abort: vi.fn(), sessionId: "child-session" },
        promise: new Promise<never>(() => {}),
        deliveryOwner: {
          pi: {} as never,
          sessionContextId: child.sessionContext.id,
          sessionContextGeneration: child.sessionContext.generation,
        },
      } as any;
      jobRegistry.set(childJob.id, childJob);

      child.handlers.get("session_shutdown")![1]({ reason: "agent_settled" }, {
        cwd: root,
        sessionManager: childManager,
      } as any);

      expect(abort.signal.aborted).toBe(true);
      expect(jobRegistry.has(childJob.id)).toBe(false);
      expect(childJob.cancellation?.source).toBe("session_shutdown");
      expect(childJob.cancellationSnapshot?.status).toBe("written");
      const written = readFileSync(childJob.cancellationSnapshot.path, "utf8");
      expect(written).toContain("half-written analysis");
    } finally {
      if (previousMode === undefined)
        delete process.env.SUBAGENT_CANCEL_SNAPSHOT;
      else process.env.SUBAGENT_CANCEL_SNAPSHOT = previousMode;
      if (previousDir === undefined)
        delete process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR;
      else process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR = previousDir;
    }
  });

  it("runs top-level cleanup when a descendant omitted its shutdown", () => {
    const parent = registerHandlers();
    const parentManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    parent.handlers.get("session_start")![0]({ reason: "startup" }, {
      cwd: root,
      ui: {},
      sessionManager: parentManager,
    } as any);
    const globalState = globalThis as any;
    expect(globalState.__piSubagenturaInteractivePollerHandle).toBeDefined();
    // A nested child whose shutdown hook was omitted remains structurally
    // started and its SessionManager still answers. Health probing cannot
    // distinguish this stale descendant from a live ancestor.
    // Shutdown reads it only after the structural teardown decision, to locate
    // descendant-owned interactive state.
    const staleAccessor = vi.fn(() => "stale-child-session");
    globalState.__piSubagenturaSessionContextStack.push({
      id: 4_242,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      sessionManager: {
        getSessionId: staleAccessor,
      },
    });

    parent.handlers.get("session_shutdown")![1]({ reason: "new" }, {
      cwd: root,
      sessionManager: parentManager,
    } as any);

    expect(globalState.__piSubagenturaInteractivePollerHandle).toBeUndefined();
    expect(globalState.__piSubagenturaPiRef).toBeUndefined();
    expect(staleAccessor).toHaveBeenCalledOnce();
    expect(globalState.__piSubagenturaSessionContextStack).toEqual([]);
  });

  it("tears down stale descendant ownership on session_start", () => {
    const parent = registerHandlers();
    const globalState = globalThis as any;
    const staleAccessor = vi.fn(() => "stale-child-session");
    globalState.__piSubagenturaSessionContextStack.push({
      id: 4_243,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      sessionManager: {
        getSessionId: staleAccessor,
      },
    });
    const workflowAbort = new AbortController();
    workflowJobRegistry.set("startup-stale-workflow", {
      id: "startup-stale-workflow",
      status: "running",
      abort: workflowAbort,
      parentSessionOwner: { id: 4_243, generation: 1 },
    } as any);
    const jobAbort = vi.fn().mockResolvedValue(undefined);
    jobRegistry.set("startup-stale-job", {
      id: "startup-stale-job",
      status: "running",
      session: { abort: jobAbort },
      deliveryOwner: {
        sessionContextId: 4_243,
        sessionContextGeneration: 1,
      },
    } as any);
    const artifactDir = join(root, "startup-stale-interactive");
    mkdirSync(artifactDir, { recursive: true });
    const staleState: InteractiveSubagentState = {
      id: "startup-stale-interactive",
      name: "startup stale",
      task: "stale task",
      paneId: "%startup-stale",
      cwd: root,
      artifactDir,
      sessionFile: join(root, "startup-stale.jsonl"),
      startedAt: Date.now(),
      mux: "tmux",
      status: "unknown",
      parentSessionId: "stale-child-session",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
    };
    interactiveSubagentRegistry.set(staleState.id, staleState);
    const killPane = vi.fn();
    __setTmuxMultiplexer({
      getPaneLiveness: () => "unknown",
      killPane,
    } as any);

    parent.handlers.get("session_start")![0]({ reason: "startup" }, {
      cwd: root,
      ui: {},
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
    } as any);

    expect(
      globalState.__piSubagenturaSessionContextStack.map(
        (entry: { id: number }) => entry.id,
      ),
    ).toEqual([parent.sessionContext.id]);
    expect(staleAccessor).toHaveBeenCalledOnce();
    expect(workflowAbort.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has("startup-stale-workflow")).toBe(false);
    expect(jobAbort).toHaveBeenCalledOnce();
    expect(jobRegistry.has("startup-stale-job")).toBe(false);
    expect(interactiveSubagentRegistry.has(staleState.id)).toBe(false);
    expect(killPane).toHaveBeenCalledWith("%startup-stale", undefined);
    expect(globalState.__piSubagenturaInteractivePollerHandle).toBeDefined();
  });

  it("does not fall back to global footer counts for a stale owner", () => {
    const ui = { setStatus: vi.fn() };
    jobRegistry.set("foreign-job", {
      id: "foreign-job",
      status: "running",
      session: { abort: vi.fn() },
    } as any);

    updateRunningSubagentFooter(ui as any, { id: 999, generation: 1 });

    expect(ui.setStatus).toHaveBeenCalledWith("subagentura-running", undefined);
  });

  it("polls every live owner from the single global interval", async () => {
    const parent = registerHandlers();
    const child = registerHandlers();
    const parentManager = {
      getSessionId: () => "parent-session",
      getEntries: () => [],
    };
    const childManager = {
      getSessionId: () => "child-session",
      getEntries: () => [],
    };
    parent.handlers.get("session_start")![0](
      { reason: "startup" },
      { cwd: root, ui: {}, sessionManager: parentManager },
    );
    child.handlers.get("session_start")![0](
      { reason: "startup" },
      { cwd: root, ui: {}, sessionManager: childManager },
    );
    const makeState = (id: string, parentSessionId: string) => {
      const art = artifactPath(root, id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      return {
        id,
        paneId: `%${id}`,
        cwd: root,
        artifactDir: art.dir,
        sessionFile: join(root, `${id}.jsonl`),
        startedAt: Date.now(),
        mux: "tmux",
        status: "running",
        parentSessionId,
      } as any;
    };
    const parentState = makeState("parent-agent", "parent-session");
    const childState = makeState("child-agent", "child-session");
    interactiveSubagentRegistry.set(parentState.id, parentState);
    interactiveSubagentRegistry.set(childState.id, childState);
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await vi.advanceTimersByTimeAsync(5000);

    expect(parentState.eventByteCursor).toBeGreaterThan(0);
    expect(childState.eventByteCursor).toBeGreaterThan(0);
  });
});
