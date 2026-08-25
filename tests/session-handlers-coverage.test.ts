import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jobRegistry,
  registerInProcessJob,
  type JobState,
} from "../src/helpers";
import {
  interactiveSubagentRegistry,
  registerInteractiveSubagentState,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { registerSessionHandlers } from "../src/session-handlers";
import {
  LINEAGE_BOOTSTRAP_ENV,
  acquireRuntimeSpawnTreeContext,
  createDescendantSpawnTreeContext,
  createRootSpawnTreeContext,
  resetRuntimeSpawnTreeContextForTests,
  writeLineageBootstrap,
  type ParsedSpawnTreeContext,
} from "../src/spawn-tree-context";
import { workflowJobRegistry } from "../src/workflow-jobs";
import { appendEvent, artifactPath } from "../src/artifact";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { updateRunningSubagentFooter } from "../src/artifact-poller";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

interface HandlerRegistration {
  handlers: Map<string, Function[]>;
  pi: any;
  sessionScope: SessionScope;
}

function registerHandlers(
  initialSpawnTreeContext?: ParsedSpawnTreeContext,
  allowRootLineage = true,
): HandlerRegistration {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    }),
    sendMessage: vi.fn(),
  };
  const sessionScope = registerSessionHandlers(
    pi as any,
    initialSpawnTreeContext,
    allowRootLineage,
  );
  return { handlers, pi, sessionScope };
}

function startSession(
  registration: HandlerRegistration,
  root: string,
  sessionId: string,
  ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
) {
  const sessionManager = {
    getSessionId: () => sessionId,
    getEntries: () => [],
  };
  const ctx = { cwd: root, ui, sessionManager };
  registration.handlers.get("session_start")![0]({ reason: "startup" }, ctx);
  return ctx;
}

function ownedJob(scope: SessionScope, id: string) {
  const abort = vi.fn().mockResolvedValue(undefined);
  // The lifecycle path only calls abort; constructing a real AgentSession would
  // replace this unit boundary with the entire Pi runtime.
  const session = { abort } as unknown as JobState["session"];
  const job = {
    id,
    status: "running",
    session,
    startedAt: Date.now(),
    promise: new Promise<never>(() => {}),
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
    deliveryOwner: {
      pi: scope.pi,
      sessionScopeId: scope.id,
      sessionScopeGeneration: scope.generation,
    },
  } satisfies JobState;
  registerInProcessJob(job, sessionOwner(scope));
  return { job, abort };
}

function ownedWorkflow(scope: SessionScope, id: string) {
  const abort = new AbortController();
  const workflow = {
    id,
    status: "running",
    abort,
    parentSessionOwner: sessionOwner(scope),
  } as any;
  workflowJobRegistry.set(id, workflow);
  return { workflow, abort };
}

function ownedInteractive(
  scope: SessionScope,
  root: string,
  id: string,
  sessionId: string,
): InteractiveSubagentState {
  const state = {
    id,
    name: id,
    task: `${id} task`,
    paneId: `%${id}`,
    cwd: root,
    artifactDir: join(root, id),
    sessionFile: join(root, `${id}.jsonl`),
    startedAt: Date.now(),
    mux: "tmux",
    status: "exited",
    parentSessionId: sessionId,
    sessionOwner: sessionOwner(scope),
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
  } as InteractiveSubagentState;
  registerInteractiveSubagentState(state, scope);
  return state;
}

describe("session handler lifecycle callbacks", () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "pi-subagentura-session-handlers-"));
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    clearSessionScopes();
    const globalState = globalThis as any;
    globalState.__piSubagenturaInteractivePollerHandle = undefined;
    globalState.__piSubagenturaPiRef = undefined;
    globalState.__piSubagenturaUi = undefined;
    globalState.__piSubagenturaSessionManager = undefined;
    globalState.__piSubagenturaParentStreaming = false;
  });

  afterEach(() => {
    const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
    clearInterval(handle);
    vi.useRealTimers();
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    clearSessionScopes();
    __setTmuxMultiplexer(undefined);
    resetRuntimeSpawnTreeContextForTests();
    delete process.env[LINEAGE_BOOTSTRAP_ENV];
    rmSync(root, { recursive: true, force: true });
  });

  it("creates root lineage context from session_start without ambient lineage", () => {
    const registration = registerHandlers();

    startSession(registration, root, "session-a");

    expect(registration.sessionScope.spawnTreeContext).toMatchObject({
      role: "root",
      rootId: "session-a",
      depth: 0,
    });
  });

  it("keeps a child without a bootstrap in direct-only mode", () => {
    const registration = registerHandlers(undefined, false);

    startSession(registration, root, "child-session");

    expect(registration.sessionScope.spawnTreeContext).toBeUndefined();
  });

  it("preserves a consumed descendant context across session_start", () => {
    const initial = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("lineage-root", root),
      "child-agent",
      join(root, "child-agent"),
    );
    const registration = registerHandlers(initial, false);

    startSession(registration, root, "child-session");

    expect(registration.sessionScope.spawnTreeContext).toBe(initial);
  });

  it("clears descendant authority on a fresh child session", () => {
    const artifactDir = join(root, "child-agent");
    const expected = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("lineage-root", root),
      "child-agent",
      artifactDir,
    );
    process.env[LINEAGE_BOOTSTRAP_ENV] = writeLineageBootstrap(
      artifactDir,
      expected,
    );
    const initial = acquireRuntimeSpawnTreeContext(artifactDir)!;
    const registration = registerHandlers(initial, false);
    const ctx = startSession(registration, root, "child-session");
    const abandonedPath = writeLineageBootstrap(artifactDir, expected);

    registration.handlers.get("session_start")![0]({ reason: "new" }, ctx);

    expect(registration.sessionScope.spawnTreeContext).toBeUndefined();
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
    expect(existsSync(abandonedPath)).toBe(false);
  });

  it("clears descendant authority on fresh child shutdown", () => {
    const artifactDir = join(root, "shutdown-child");
    const expected = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("lineage-root", root),
      "shutdown-child",
      artifactDir,
    );
    process.env[LINEAGE_BOOTSTRAP_ENV] = writeLineageBootstrap(
      artifactDir,
      expected,
    );
    const initial = acquireRuntimeSpawnTreeContext(artifactDir)!;
    const registration = registerHandlers(initial, false);
    const ctx = startSession(registration, root, "child-session");

    registration.handlers.get("session_shutdown")![0]({ reason: "fork" }, ctx);

    expect(registration.sessionScope.spawnTreeContext).toBeUndefined();
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
  });

  it("tracks streaming and flush lifecycle state on the exact scope", () => {
    const registration = registerHandlers();
    const ctx = startSession(registration, root, "session-a");
    const { sessionScope: scope, handlers } = registration;

    handlers.get("agent_start")![0]();
    expect(scope.parentStreaming).toBe(true);
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(true);

    handlers.get("agent_settled")![0]();
    expect(scope.parentStreaming).toBe(false);
    expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false);

    const { abort } = ownedJob(scope, "job-a");
    const workflow = ownedWorkflow(scope, "workflow-a");
    handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);

    expect(abort).toHaveBeenCalledOnce();
    expect(workflow.abort.signal.aborted).toBe(true);
    expect(scope.lifecycle).toBe("shutdown");
    expect(scope.inProcessJobs.size).toBe(0);
    expect(jobRegistry.size).toBe(0);
    expect(workflowJobRegistry.size).toBe(0);
    expect(getSessionScopes()).toEqual([]);
    expect((globalThis as any).__piSubagenturaPiRef).toBeUndefined();
  });

  it.each([
    ["A-first", "a"],
    ["B-first", "b"],
  ])("%s shutdown preserves the peer scope and its state", (_label, first) => {
    const a = registerHandlers();
    const b = registerHandlers();
    const aCtx = startSession(a, root, "session-a");
    const bCtx = startSession(b, root, "session-b");
    const aJob = ownedJob(a.sessionScope, "job-a");
    const bJob = ownedJob(b.sessionScope, "job-b");
    const aWorkflow = ownedWorkflow(a.sessionScope, "workflow-a");
    const bWorkflow = ownedWorkflow(b.sessionScope, "workflow-b");
    const aState = ownedInteractive(
      a.sessionScope,
      root,
      "state-a",
      "session-a",
    );
    const bState = ownedInteractive(
      b.sessionScope,
      root,
      "state-b",
      "session-b",
    );

    const shutting = first === "a" ? a : b;
    const surviving = first === "a" ? b : a;
    const shuttingCtx = first === "a" ? aCtx : bCtx;
    const survivingCtx = first === "a" ? bCtx : aCtx;
    const survivingJob = first === "a" ? bJob : aJob;
    const survivingWorkflow = first === "a" ? bWorkflow : aWorkflow;
    const survivingState = first === "a" ? bState : aState;
    const removedJob = first === "a" ? aJob : bJob;

    shutting.handlers.get("session_shutdown")![0](
      { reason: "new" },
      shuttingCtx,
    );

    expect(shutting.sessionScope.lifecycle).toBe("shutdown");
    expect(surviving.sessionScope.lifecycle).toBe("started");
    expect(getSessionScopes()).toEqual([surviving.sessionScope]);
    expect(removedJob.abort).toHaveBeenCalledOnce();
    expect(survivingJob.abort).not.toHaveBeenCalled();
    expect(jobRegistry.get(survivingJob.job.id)).toBe(survivingJob.job);
    expect(workflowJobRegistry.get(survivingWorkflow.workflow.id)).toBe(
      survivingWorkflow.workflow,
    );
    expect(survivingWorkflow.abort.signal.aborted).toBe(false);
    expect(interactiveSubagentRegistry.get(survivingState.id)).toBe(
      survivingState,
    );
    expect(
      (globalThis as any).__piSubagenturaInteractivePollerHandle,
    ).toBeDefined();

    surviving.handlers.get("session_shutdown")![0](
      { reason: "quit" },
      survivingCtx,
    );
    expect(
      (globalThis as any).__piSubagenturaInteractivePollerHandle,
    ).toBeUndefined();
  });

  it("a second session_start cleans only that scope's prior generation", () => {
    const a = registerHandlers();
    const b = registerHandlers();
    startSession(a, root, "session-a");
    const bCtx = startSession(b, root, "session-b");
    const aOwner = sessionOwner(a.sessionScope);
    const bGeneration = b.sessionScope.generation;
    const aJob = ownedJob(a.sessionScope, "job-a");
    const bJob = ownedJob(b.sessionScope, "job-b-old");
    const aWorkflow = ownedWorkflow(a.sessionScope, "workflow-a");
    const bWorkflow = ownedWorkflow(b.sessionScope, "workflow-b-old");
    const aState = ownedInteractive(
      a.sessionScope,
      root,
      "state-a",
      "session-a",
    );
    ownedInteractive(b.sessionScope, root, "state-b-old", "session-b");
    const sharedPoller = (globalThis as any)
      .__piSubagenturaInteractivePollerHandle;

    b.handlers.get("session_start")![0]({ reason: "new" }, bCtx);

    expect(sessionOwner(a.sessionScope)).toEqual(aOwner);
    expect((globalThis as any).__piSubagenturaInteractivePollerHandle).toBe(
      sharedPoller,
    );
    expect(a.sessionScope.lifecycle).toBe("started");
    expect(aJob.abort).not.toHaveBeenCalled();
    expect(jobRegistry.get(aJob.job.id)).toBe(aJob.job);
    expect(aWorkflow.abort.signal.aborted).toBe(false);
    expect(workflowJobRegistry.get(aWorkflow.workflow.id)).toBe(
      aWorkflow.workflow,
    );
    expect(interactiveSubagentRegistry.get(aState.id)).toBe(aState);

    expect(b.sessionScope.lifecycle).toBe("started");
    expect(b.sessionScope.generation).toBe(bGeneration + 1);
    expect(bJob.abort).toHaveBeenCalledOnce();
    expect(bWorkflow.abort.signal.aborted).toBe(true);
    expect(jobRegistry.has(bJob.job.id)).toBe(false);
    expect(interactiveSubagentRegistry.has("state-b-old")).toBe(false);
    expect(getSessionScopes()).toEqual([a.sessionScope, b.sessionScope]);
  });

  it("clears a stopped scope's contribution from a shared UI", () => {
    const sharedUi = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    };
    const a = registerHandlers();
    const b = registerHandlers();
    const aCtx = startSession(a, root, "session-a", sharedUi);
    startSession(b, root, "session-b", sharedUi);
    ownedJob(a.sessionScope, "job-a");

    updateRunningSubagentFooter(sharedUi, sessionOwner(a.sessionScope));
    expect(sharedUi.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );

    a.handlers.get("session_shutdown")![0]({ reason: "quit" }, aCtx);

    expect(sharedUi.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      undefined,
    );
  });

  it("does not let a stale generation clear the current footer", () => {
    const ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() };
    const registration = registerHandlers();
    startSession(registration, root, "session-a", ui);
    const staleOwner = sessionOwner(registration.sessionScope);
    ownedJob(registration.sessionScope, "old-job");
    updateRunningSubagentFooter(ui, staleOwner);

    registration.sessionScope.inProcessJobs.clear();
    advanceSessionScopeGeneration(registration.sessionScope.id);
    ownedJob(registration.sessionScope, "current-job");
    updateRunningSubagentFooter(ui, sessionOwner(registration.sessionScope));

    updateRunningSubagentFooter(ui, staleOwner);

    expect(ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });

  it("polls every started scope from one shared interval", async () => {
    const a = registerHandlers();
    const b = registerHandlers();
    startSession(a, root, "session-a");
    startSession(b, root, "session-b");
    const makeState = (
      scope: SessionScope,
      id: string,
      parentSessionId: string,
    ) => {
      const artifact = artifactPath(root, id);
      appendEvent(artifact, { ts: 1, type: "started", status: "running" });
      const state = {
        id,
        paneId: `%${id}`,
        cwd: root,
        artifactDir: artifact.dir,
        sessionFile: join(root, `${id}.jsonl`),
        startedAt: Date.now(),
        mux: "tmux",
        status: "running",
        parentSessionId,
        sessionOwner: sessionOwner(scope),
      } as InteractiveSubagentState;
      registerInteractiveSubagentState(state, scope);
      return state;
    };
    const aState = makeState(a.sessionScope, "agent-a", "session-a");
    const bState = makeState(b.sessionScope, "agent-b", "session-b");
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await vi.advanceTimersByTimeAsync(5000);

    expect(aState.eventByteCursor).toBeGreaterThan(0);
    expect(bState.eventByteCursor).toBeGreaterThan(0);
  });
});
