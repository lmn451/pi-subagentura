import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendEvent, artifactPath } from "../src/artifact";
import {
  jobRegistry,
  registerInProcessJob,
  type JobState,
} from "../src/helpers";
import * as interactiveTmux from "../src/interactive-tmux";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  __setTmuxMultiplexer,
  type Multiplexer,
  type PaneLiveness,
} from "../src/multiplexer";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import registerExtension, { pollArtifactChanges } from "../src/subagent";
import { workflowJobRegistry } from "../src/workflow";
import type { WorkflowJobState } from "../src/workflow-jobs";

interface TestExtensionApi {
  registerTool: Mock;
  registerMessageRenderer: Mock;
  registerFlag: Mock;
  getFlag: Mock;
  sendMessage: Mock;
  sendUserMessage: Mock;
  on: Mock;
}

interface ShutdownGlobalState {
  __piSubagenturaInteractivePollerHandle?: NodeJS.Timeout;
  __piSubagenturaPiRef?: ExtensionAPI;
  __piSubagenturaUi?: unknown;
  __piSubagenturaSessionManager?: unknown;
  __piSubagenturaParentStreaming?: boolean;
}

function shutdownGlobalState(): typeof globalThis & ShutdownGlobalState {
  return globalThis as typeof globalThis & ShutdownGlobalState;
}

function installLivenessMultiplexer(
  getPaneLivenessAsync: () => Promise<PaneLiveness>,
): void {
  const testMultiplexer = {
    getPaneLiveness: (): PaneLiveness => "alive",
    getPaneLivenessAsync,
  };
  // This unit seam exercises only the two liveness methods used by the poller.
  __setTmuxMultiplexer(testMultiplexer as unknown as Multiplexer);
}

interface SessionStartHandler {
  (
    event: { reason: string },
    ctx: {
      cwd: string;
      ui: Record<string, unknown>;
      sessionManager: {
        getSessionId: () => string;
        getEntries: () => unknown[];
      };
    },
  ): void;
}

interface Registration {
  api: TestExtensionApi;
  scope: SessionScope;
  start: (
    sessionId?: string,
    ui?: Record<string, unknown>,
    reason?: string,
  ) => void;
  shutdown: (
    event?: { reason?: string },
    ctx?: {
      cwd?: string;
      sessionManager?: { getSessionId?: () => string };
    },
  ) => void;
}

function setupExtension(
  options: {
    startSession?: boolean;
    sessionId?: string;
    ui?: Record<string, unknown>;
  } = {},
): Registration {
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
  // The stub implements the extension methods exercised by registration.
  const extensionApi = api as unknown as ExtensionAPI;
  registerExtension(extensionApi);

  const scope = getSessionScopes().find(
    (candidate) => candidate.pi === extensionApi,
  );
  if (!scope) throw new Error("extension did not register a session scope");

  const sessionStartHandler = api.on.mock.calls.find(
    ([event]) => event === "session_start",
  )?.[1] as SessionStartHandler;
  let shutdownHandler: Registration["shutdown"] | undefined;
  for (const [event, handler] of api.on.mock.calls) {
    if (event === "session_shutdown") {
      shutdownHandler = handler as Registration["shutdown"];
    }
  }
  if (!shutdownHandler)
    throw new Error("session_shutdown handler not registered");

  const start = (
    sessionId = options.sessionId ?? `parent-${scope.id}`,
    ui = options.ui ?? {},
    reason = "new",
  ) => {
    sessionStartHandler(
      { reason },
      {
        cwd: "/tmp",
        ui,
        sessionManager: {
          getSessionId: () => sessionId,
          getEntries: () => [],
        },
      },
    );
  };

  const registration = { api, scope, start, shutdown: shutdownHandler };
  if (options.startSession !== false) start();
  return registration;
}

function shutdownContext(sessionId: string) {
  return {
    cwd: "/tmp",
    sessionManager: { getSessionId: () => sessionId },
  };
}

function makeState(
  id: string,
  status: InteractiveSubagentState["status"],
  artifactDir = `/tmp/art-${id}`,
): InteractiveSubagentState {
  return {
    id,
    name: `test-${id}`,
    task: "test",
    paneId: `%${id}`,
    sessionFile: `/tmp/sess-${id}.jsonl`,
    cwd: "/tmp",
    startedAt: Date.now(),
    status,
    mux: "tmux",
    attachCommand: `tmux attach -t ${id}`,
    selectPaneCommand: `tmux select-pane -t '%${id}'`,
    launchScriptFile: `/tmp/launch-${id}.sh`,
    artifactDir,
  };
}

function ownedInteractive(
  scope: SessionScope,
  id: string,
  status: InteractiveSubagentState["status"],
  options: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  const state = Object.assign(makeState(id, status), options);
  interactiveTmux.registerInteractiveSubagentState(state, scope);
  return state;
}

function ownedWorkflow(scope: SessionScope, id: string) {
  const abort = new AbortController();
  const workflow = {
    id,
    name: id,
    status: "running" as const,
    startedAt: Date.now(),
    promise: new Promise<never>(() => {}),
    abort,
    suppressCompletionNotification: false,
    parentSessionOwner: sessionOwner(scope),
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    },
  };
  // The fixture supplies the lifecycle fields consumed by shutdown.
  workflowJobRegistry.set(id, workflow as unknown as WorkflowJobState);
  return { workflow, abort };
}

function ownedJob(scope: SessionScope, id: string) {
  const abort = vi.fn().mockResolvedValue(undefined);
  const job = {
    id,
    status: "running",
    session: { abort } as unknown as JobState["session"],
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
  if (!registerInProcessJob(job, sessionOwner(scope))) {
    throw new Error(`failed to register owned job ${id}`);
  }
  return { job, abort };
}

describe("session_shutdown handler", () => {
  let setIntervalSpy: MockInstance<typeof setInterval>;
  let clearIntervalSpy: MockInstance<typeof clearInterval>;
  let cancelByStateSpy: MockInstance<
    typeof interactiveTmux.cancelInteractiveSubagentByState
  >;
  let fakeHandle: { unref: Mock };
  let tmpRoot: string | undefined;

  beforeEach(() => {
    clearSessionScopes();
    jobRegistry.clear();
    workflowJobRegistry.clear();
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      observePane: async () => ({ kind: "alive" }),
    } as any);

    installLivenessMultiplexer(async () => "alive");
    fakeHandle = { unref: vi.fn() };
    setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    setIntervalSpy.mockReturnValue(fakeHandle as unknown as NodeJS.Timeout);
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    clearIntervalSpy.mockImplementation(() => {});
    cancelByStateSpy = vi.spyOn(
      interactiveTmux,
      "cancelInteractiveSubagentByState",
    );
    cancelByStateSpy.mockImplementation(() => undefined);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    cancelByStateSpy.mockRestore();
    shutdownGlobalState().__piSubagenturaInteractivePollerHandle = undefined;
    clearSessionScopes();
    jobRegistry.clear();
    workflowJobRegistry.clear();
    interactiveTmux.interactiveSubagentRegistry.clear();
    __setTmuxMultiplexer(undefined);
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
    vi.restoreAllMocks();
  });

  it("shares one poller across peer scopes and tears it down after the final scope", () => {
    const a = setupExtension({ startSession: false });
    const b = setupExtension({ startSession: false });

    a.start("session-a");
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(fakeHandle.unref).toHaveBeenCalledOnce();
    const sharedPoller =
      shutdownGlobalState().__piSubagenturaInteractivePollerHandle;

    b.start("session-b");
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(shutdownGlobalState().__piSubagenturaInteractivePollerHandle).toBe(
      sharedPoller,
    );

    a.shutdown({ reason: "new" }, shutdownContext("session-a"));
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(shutdownGlobalState().__piSubagenturaInteractivePollerHandle).toBe(
      sharedPoller,
    );

    b.shutdown({ reason: "quit" }, shutdownContext("session-b"));
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(sharedPoller);
    expect(
      shutdownGlobalState().__piSubagenturaInteractivePollerHandle,
    ).toBeUndefined();
  });

  it.each(["a", "b"])(
    "shutting down scope %s cleans its exact owner and preserves its peer",
    (which) => {
      const a = setupExtension({ sessionId: "session-a" });
      const b = setupExtension({ sessionId: "session-b" });
      const aState = ownedInteractive(a.scope, "state-a", "unknown", {
        parentSessionId: "session-a",
      });
      const bState = ownedInteractive(b.scope, "state-b", "unknown", {
        parentSessionId: "session-b",
      });
      const aWorkflow = ownedWorkflow(a.scope, "workflow-a");
      const bWorkflow = ownedWorkflow(b.scope, "workflow-b");
      const aJob = ownedJob(a.scope, "job-a");
      const bJob = ownedJob(b.scope, "job-b");
      const shutting = which === "a" ? a : b;
      const surviving = which === "a" ? b : a;
      const shuttingState = which === "a" ? aState : bState;
      const survivingState = which === "a" ? bState : aState;
      const shuttingWorkflow = which === "a" ? aWorkflow : bWorkflow;
      const survivingWorkflow = which === "a" ? bWorkflow : aWorkflow;
      const shuttingJob = which === "a" ? aJob : bJob;
      const survivingJob = which === "a" ? bJob : aJob;

      shutting.shutdown({ reason: "new" }, shutdownContext(`session-${which}`));

      expect(shutting.scope.lifecycle).toBe("shutdown");
      expect(surviving.scope.lifecycle).toBe("started");
      expect(getSessionScopes()).toEqual([surviving.scope]);
      expect(shutting.scope.interactiveStates.size).toBe(0);
      expect(surviving.scope.interactiveStates.get(survivingState.id)).toBe(
        survivingState,
      );
      expect(cancelByStateSpy).toHaveBeenCalledWith(shuttingState);
      expect(cancelByStateSpy).not.toHaveBeenCalledWith(survivingState);
      expect(
        interactiveTmux.interactiveSubagentRegistry.has(shuttingState.id),
      ).toBe(false);
      expect(
        interactiveTmux.interactiveSubagentRegistry.get(survivingState.id),
      ).toBe(survivingState);
      expect(shuttingWorkflow.abort.signal.aborted).toBe(true);
      expect(shuttingWorkflow.workflow.suppressCompletionNotification).toBe(
        true,
      );
      expect(workflowJobRegistry.has(shuttingWorkflow.workflow.id)).toBe(false);
      expect(survivingWorkflow.abort.signal.aborted).toBe(false);
      expect(survivingWorkflow.workflow.suppressCompletionNotification).toBe(
        false,
      );
      expect(workflowJobRegistry.get(survivingWorkflow.workflow.id)).toBe(
        survivingWorkflow.workflow,
      );
      expect(shuttingJob.abort).toHaveBeenCalledOnce();
      expect(jobRegistry.has(shuttingJob.job.id)).toBe(false);
      expect(survivingJob.abort).not.toHaveBeenCalled();
      expect(jobRegistry.get(survivingJob.job.id)).toBe(survivingJob.job);
      expect(shutdownGlobalState().__piSubagenturaInteractivePollerHandle).toBe(
        fakeHandle,
      );
    },
  );

  it("accepts an omitted shutdown event and still cleans the exact scope", () => {
    const registration = setupExtension({ sessionId: "session-a" });
    const state = ownedInteractive(registration.scope, "state-a", "running");
    const workflow = ownedWorkflow(registration.scope, "workflow-a");
    const job = ownedJob(registration.scope, "job-a");

    expect(() => registration.shutdown()).not.toThrow();

    expect(cancelByStateSpy).toHaveBeenCalledWith(state);
    expect(workflow.abort.signal.aborted).toBe(true);
    expect(job.abort).toHaveBeenCalledOnce();
    expect(registration.scope.lifecycle).toBe("shutdown");
    expect(getSessionScopes()).toEqual([]);
    expect(
      shutdownGlobalState().__piSubagenturaInteractivePollerHandle,
    ).toBeUndefined();
  });

  it.each(["new", "fork"])(
    "kills live panes owned by the scope for non-preserving reason %s",
    (reason) => {
      const registration = setupExtension();
      const running = ownedInteractive(
        registration.scope,
        "running",
        "running",
      );
      const idle = ownedInteractive(registration.scope, "idle", "idle");
      const unknown = ownedInteractive(
        registration.scope,
        "unknown",
        "unknown",
      );
      const cancelled = ownedInteractive(
        registration.scope,
        "cancelled",
        "cancelled",
      );
      const exited = ownedInteractive(registration.scope, "exited", "exited");

      registration.shutdown({ reason });

      expect(cancelByStateSpy).toHaveBeenCalledTimes(3);
      expect(cancelByStateSpy).toHaveBeenCalledWith(running);
      expect(cancelByStateSpy).toHaveBeenCalledWith(idle);
      expect(cancelByStateSpy).toHaveBeenCalledWith(unknown);
      expect(cancelByStateSpy).not.toHaveBeenCalledWith(cancelled);
      expect(cancelByStateSpy).not.toHaveBeenCalledWith(exited);
      expect(registration.scope.interactiveStates.size).toBe(0);
      for (const state of [running, idle, unknown, cancelled, exited]) {
        expect(interactiveTmux.interactiveSubagentRegistry.has(state.id)).toBe(
          false,
        );
      }
    },
  );

  it.each(["reload", "resume", "quit"])(
    "preserves standalone panes while removing their scope metadata for reason %s",
    (reason) => {
      const registration = setupExtension();
      const running = ownedInteractive(
        registration.scope,
        "running",
        "running",
      );
      const idle = ownedInteractive(registration.scope, "idle", "idle");
      const unknown = ownedInteractive(
        registration.scope,
        "unknown",
        "unknown",
      );

      registration.shutdown({ reason });

      expect(cancelByStateSpy).not.toHaveBeenCalled();
      expect(registration.scope.interactiveStates.size).toBe(0);
      for (const state of [running, idle, unknown]) {
        expect(interactiveTmux.interactiveSubagentRegistry.has(state.id)).toBe(
          false,
        );
      }
    },
  );

  it.each(["reload", "resume", "quit"])(
    "kills workflow-origin panes but preserves standalone panes for reason %s",
    (reason) => {
      const registration = setupExtension();
      const workflowChild = ownedInteractive(
        registration.scope,
        "workflow-child",
        "running",
        { completionOwner: "workflow", workflowId: "workflow-a" },
      );
      const promotedChild = ownedInteractive(
        registration.scope,
        "promoted-child",
        "idle",
        {
          completionOwner: "standalone",
          workflowResultConsumed: true,
          workflowId: undefined,
        },
      );
      const standalone = ownedInteractive(
        registration.scope,
        "standalone",
        "running",
      );

      registration.shutdown({ reason });

      expect(cancelByStateSpy).toHaveBeenCalledTimes(2);
      expect(cancelByStateSpy).toHaveBeenCalledWith(workflowChild);
      expect(cancelByStateSpy).toHaveBeenCalledWith(promotedChild);
      expect(cancelByStateSpy).not.toHaveBeenCalledWith(standalone);
      expect(registration.scope.interactiveStates.size).toBe(0);
    },
  );

  it("drops an in-flight poll when its exact owner shuts down", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-race-"));
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const registration = setupExtension({ sessionId: "session-a", ui });
    const state = ownedInteractive(
      registration.scope,
      "race-child",
      "running",
      {
        artifactDir: join(tmpRoot, "race-child"),
        parentSessionId: "session-a",
      },
    );
    appendEvent(artifactPath(tmpRoot, state.id), {
      ts: 1,
      type: "done",
      status: "done",
      exitCode: 0,
    });

    let releaseLiveness!: (value: "alive") => void;
    const liveness = new Promise<"alive">((resolve) => {
      releaseLiveness = resolve;
    });
    installLivenessMultiplexer(() => liveness);
    const tick = setIntervalSpy.mock.calls[0][0] as () => void;

    tick();
    await Promise.resolve();
    registration.shutdown({ reason: "new" }, shutdownContext("session-a"));
    releaseLiveness("alive");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registration.api.sendMessage).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("does not re-deliver an artifact completion after shutdown", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-delivery-"));
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const registration = setupExtension({ sessionId: "session-a", ui });
    const state = ownedInteractive(
      registration.scope,
      "done-child",
      "running",
      {
        artifactDir: join(tmpRoot, "done-child"),
        parentSessionId: "session-a",
      },
    );
    appendEvent(artifactPath(tmpRoot, state.id), {
      ts: 1,
      type: "done",
      status: "done",
      exitCode: 0,
    });
    const owner = sessionOwner(registration.scope);
    const tick = setIntervalSpy.mock.calls[0][0] as () => void;

    // 1. Pre-shutdown tick: no artifact events, no notification.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(0);

    // 2. Shutdown handler runs. The order of operations inside

    // session_shutdown is what we're protecting: snapshot → clear → cancel.

    // If someone re-orders to cancel → clear, the post-shutdown tick below

    // would still see an empty registry (clear runs last), so this test

    // alone would pass. The cancellation must use the byState export

    // (covered by the test at line ~166) for the shutdown handler to

    // actually kill panes after clear.

    shutdownHandler!();

    // 3. Post-shutdown tick (the in-flight one that survived clearInterval):

    //    must deliver zero notifications because the registry is empty.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(0);
  });

  it("AC-A2: setInterval tick after shutdown does not re-deliver a done event already in the artifact", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-a2-"));

    const artifactDir = join(tmpRoot, "run-1");

    const running = makeArtifactState("run-1", "running", artifactDir);

    // Pre-write a done event with a fixed ts.

    const doneTs = 1000;

    const art = artifactPath(join(artifactDir, ".."), "run-1");

    appendEvent(art, { ts: doneTs, type: "done", status: "done", exitCode: 0 });

    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      observePane: async () => ({ kind: "alive" }),
    } as any);

    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const { api, shutdownHandler } = setupExtension({ ui });

    // Capture the actual setInterval callback for the real code path.

    const tick = setIntervalSpy.mock.calls[0][0] as () => void;

    // 1. Pre-shutdown tick: the done event (cursor=0, ts=1000) is

    // delivered. Exactly one notification.

    await new Promise<void>((resolve) => setImmediate(resolve));
    await pollArtifactChanges(api as any);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledOnce();

    registration.shutdown({ reason: "quit" }, shutdownContext("session-a"));
    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(registration.api.sendMessage).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledOnce();
  });
});
