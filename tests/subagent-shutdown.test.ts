/**
 * Behavioral tests for the `session_shutdown` handler registered by the
 * subagent extension. The handler added in the criticals-wip commit
 * introduced four new behaviors, none of which had any test:
 *
 *   1. deferring poller startup until `session_start`, then `handle.unref?.()`
 *   2. `clearInterval` of the poller handle in `session_shutdown`
 *   3. preserving live panes on reload/resume/quit and cancelling them otherwise
 *   4. clear of `interactiveSubagentRegistry` (the fix in this branch)
 *
 * These tests stub `setInterval` / `clearInterval` to capture the handle
 * and call args, and `vi.spyOn` the `cancelInteractiveSubagent` export
 * so we can assert which ids were cancelled without touching tmux.
 *
 * The two `AC-A*` tests at the bottom are regression tests for Bug A
 * (duplicate notification on parent session close). They exercise the
 * race between an in-flight poll tick and the shutdown handler by
 * calling `pollArtifactChanges` directly at the boundaries of the
 * shutdown sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as interactiveTmux from "../src/interactive-tmux";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { appendEvent, artifactPath } from "../src/artifact";
import { jobRegistry } from "../src/helpers";
import { workflowJobRegistry } from "../src/workflow";
import registerExtension, { pollArtifactChanges } from "../src/subagent";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { getActiveSessionContextToken } from "../src/session-context";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeState(
  id: string,
  status: InteractiveSubagentState["status"],
): InteractiveSubagentState {
  return {
    id,
    name: "test-" + id,
    task: "test",
    paneId: "%" + id,
    sessionFile: "/tmp/sess-" + id + ".jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    status,
    mux: "tmux",
    attachCommand: "tmux attach -t " + id,
    selectPaneCommand: "tmux select-pane -t '%" + id + "'",
    launchScriptFile: "/tmp/launch-" + id + ".sh",
    artifactDir: "/tmp/art-" + id,
  };
}

/** Build a minimal ExtensionAPI mock and find the session_shutdown callback. */
function setupExtension(options: { startSession?: boolean; ui?: any } = {}) {
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };

  registerExtension(api as any);

  // The extension registers two session_shutdown callbacks: a no-op early
  // one and the actual cleanup handler at the end of the default export.
  // We want the LAST one — the one that runs clearInterval, the cancel
  // loop, and the registry clear.
  let shutdownHandler:
    ((event?: { reason?: string }, ctx?: { cwd?: string }) => void) | undefined;
  for (const [event, handler] of (api.on as any).mock.calls) {
    if (event === "session_shutdown") {
      shutdownHandler = handler as (
        event?: { reason?: string },
        ctx?: { cwd?: string },
      ) => void;
    }
  }

  if (options.startSession !== false) {
    startRegisteredSession(api, options.ui);
  }

  return { api, shutdownHandler };
}

function startRegisteredSession(api: any, ui: any = {}): void {
  const sessionStartHandler = api.on.mock.calls.find(
    ([event]: [string]) => event === "session_start",
  )?.[1] as Function;
  sessionStartHandler(
    { reason: "new" },
    {
      cwd: "/tmp",
      ui,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      },
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("session_shutdown handler", () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;
  let cancelSpy: ReturnType<typeof vi.spyOn>;
  let cancelByStateSpy: ReturnType<typeof vi.spyOn>;
  let fakeHandle: { unref: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    // Reset global poller / registry / ref state so `session_start` can create
    // a fresh interval in the poller lifecycle test.
    const g = globalThis as any;
    g.__piSubagenturaInteractivePollerHandle = undefined;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    const contextStack = g.__piSubagenturaSessionContextStack;
    if (Array.isArray(contextStack)) contextStack.length = 0;
    g.__piSubagenturaSessionContextIdCounter = 0;
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
    g.__piSubagenturaParentStreaming = false;
    jobRegistry.clear();
    workflowJobRegistry.clear();
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      observePane: async () => ({ kind: "alive" }),
    } as any);

    // Stub the global timers. setInterval returns a fake handle with a
    // vi.fn() unref method; clearInterval is a no-op spy.
    fakeHandle = { unref: vi.fn() };
    setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeHandle as any) as any;
    clearIntervalSpy = vi
      .spyOn(globalThis, "clearInterval")
      .mockImplementation(() => {}) as any;

    // Spy on cancelInteractiveSubagent + cancelInteractiveSubagentByState so the
    // handler's iteration logic can be observed without touching the filesystem
    // or running tmux. The shutdown handler now uses the byState variant
    // (bypasses registry lookup) after snapshotting.
    cancelSpy = vi.spyOn(interactiveTmux, "cancelInteractiveSubagent") as any;
    cancelSpy.mockImplementation(((id: string) =>
      interactiveTmux.interactiveSubagentRegistry.get(id)) as any);
    cancelByStateSpy = vi.spyOn(
      interactiveTmux,
      "cancelInteractiveSubagentByState",
    ) as any;
    cancelByStateSpy.mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    cancelSpy.mockRestore();
    cancelByStateSpy.mockRestore();
    // The shutdown handler nulls the global handle; restore to undefined
    // so the next test starts from a clean slate.
    (globalThis as any).__piSubagenturaInteractivePollerHandle = undefined;
    vi.restoreAllMocks();
  });

  // AC-A* tests create tmp artifact dirs; declared here (before any inner
  // afterEach that references it) per AGENTS.md "declare before" rule.
  let tmpRoot: string;

  it("replaces a pre-session legacy poller on session_start", () => {
    const first = setupExtension({ startSession: false });
    const { api } = setupExtension({ startSession: false });
    const globalState = globalThis as any;
    const legacyHandle = { unref: vi.fn() };

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(globalState.__piSubagenturaSessionContextStack).toHaveLength(2);
    globalState.__piSubagenturaInteractivePollerHandle = legacyHandle;

    startRegisteredSession(api);

    expect(clearIntervalSpy).toHaveBeenCalledWith(legacyHandle);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(fakeHandle.unref).toHaveBeenCalledTimes(1);
    // Starting advances this handler's placeholder in place; the other
    // extension's registered placeholder keeps its original stack position.
    const stack = globalState.__piSubagenturaSessionContextStack;
    expect(stack).toHaveLength(2);
    expect(stack[0].pi).toBe(first.api);
    expect(stack.at(-1).pi).toBe(api);
    expect(globalState.__piSubagenturaPiRef).toBe(api);
  });

  it("tears down stale descendant-owned work while preserving an ancestor", () => {
    setupExtension();
    const { api, shutdownHandler } = setupExtension();
    const globalState = globalThis as any;
    const descendantId = 9_999;
    const descendantGeneration = 1;
    const descendantSessionId = "stale-descendant-session";
    const staleAccessor = vi.fn(() => descendantSessionId);
    globalState.__piSubagenturaSessionContextStack.push({
      id: descendantId,
      generation: descendantGeneration,
      lifecycle: "started",
      pi: api,
      sessionManager: { getSessionId: staleAccessor },
    });
    const descendantState = makeState("stale-descendant", "unknown");
    descendantState.parentSessionId = descendantSessionId;
    interactiveTmux.interactiveSubagentRegistry.set(
      descendantState.id,
      descendantState,
    );
    const workflowAbort = new AbortController();
    workflowJobRegistry.set("stale-descendant-workflow", {
      id: "stale-descendant-workflow",
      status: "running",
      abort: workflowAbort,
      parentSessionOwner: {
        id: descendantId,
        generation: descendantGeneration,
      },
    } as any);
    const jobAbort = vi.fn().mockResolvedValue(undefined);
    jobRegistry.set("stale-descendant-job", {
      id: "stale-descendant-job",
      status: "running",
      session: { abort: jobAbort },
      deliveryOwner: {
        sessionContextId: descendantId,
        sessionContextGeneration: descendantGeneration,
      },
    } as any);
    clearIntervalSpy.mockClear();

    shutdownHandler!({ reason: "new" }, { cwd: "/tmp" });

    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(globalState.__piSubagenturaInteractivePollerHandle).toBe(fakeHandle);
    expect(staleAccessor).toHaveBeenCalledOnce();
    expect(cancelByStateSpy).toHaveBeenCalledWith(descendantState);
    expect(
      interactiveTmux.interactiveSubagentRegistry.has(descendantState.id),
    ).toBe(false);
    expect(workflowAbort.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has("stale-descendant-workflow")).toBe(false);
    expect(jobAbort).toHaveBeenCalledOnce();
    expect(jobRegistry.has("stale-descendant-job")).toBe(false);
  });

  it("does not kill unrelated panes when the shutdown session id is absent", () => {
    setupExtension();
    const { shutdownHandler } = setupExtension();
    const globalState = globalThis as any;
    expect(
      globalState.__piSubagenturaSessionContextStack.map(
        (context: { lifecycle: string }) => context.lifecycle,
      ),
    ).toEqual(["started", "started"]);
    const orphan = makeState("no-parent", "running");
    delete (orphan as { parentSessionId?: string }).parentSessionId;
    interactiveTmux.interactiveSubagentRegistry.set(orphan.id, orphan);

    // No sessionManager on ctx → shutdownSessionId is undefined.
    shutdownHandler!({ reason: "new" }, { cwd: "/tmp" });

    expect(cancelByStateSpy).not.toHaveBeenCalled();
    expect(interactiveTmux.interactiveSubagentRegistry.has(orphan.id)).toBe(
      true,
    );
  });

  it("clearIntervals the poller in session_shutdown", () => {
    const { shutdownHandler } = setupExtension();
    expect(shutdownHandler).toBeTypeOf("function");

    shutdownHandler!();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(fakeHandle);
    // The handler also nulls the global after clearing, so a re-invocation
    // would be a no-op (defensive: no double-clear).
    expect(
      (globalThis as any).__piSubagenturaInteractivePollerHandle,
    ).toBeUndefined();
  });

  it.each(["new", "fork"])(
    "kills running, idle, and unknown panes for non-preserving reason %s",
    (reason) => {
      const running = makeState("run-1", "running");
      const idle = makeState("idle-1", "idle");
      const unknown = makeState("unknown-1", "unknown");

      const cancelled = makeState("canc-1", "cancelled");

      const exited = makeState("exit-1", "exited");

      interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
      interactiveTmux.interactiveSubagentRegistry.set(idle.id, idle);
      interactiveTmux.interactiveSubagentRegistry.set(unknown.id, unknown);

      interactiveTmux.interactiveSubagentRegistry.set(cancelled.id, cancelled);

      interactiveTmux.interactiveSubagentRegistry.set(exited.id, exited);

      const { shutdownHandler } = setupExtension();

      shutdownHandler!({ reason });

      // The handler snapshots running states, clears the registry, then calls the

      // byState variant (which bypasses the registry lookup). The id-based

      // cancelInteractiveSubagent is NOT used by the shutdown handler anymore.

      expect(cancelByStateSpy).toHaveBeenCalledTimes(3);

      expect(cancelByStateSpy).toHaveBeenCalledWith(running);
      expect(cancelByStateSpy).toHaveBeenCalledWith(idle);
      expect(cancelByStateSpy).toHaveBeenCalledWith(unknown);

      expect(cancelSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["reload", "resume", "quit"])(
    "preserves running, idle, and unknown panes for reason %s",
    (reason) => {
      const running = makeState("run-1", "running");
      const idle = makeState("idle-1", "idle");
      const unknown = makeState("unknown-1", "unknown");
      interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
      interactiveTmux.interactiveSubagentRegistry.set(idle.id, idle);
      interactiveTmux.interactiveSubagentRegistry.set(unknown.id, unknown);

      const { shutdownHandler } = setupExtension();
      shutdownHandler!({ reason });

      expect(cancelByStateSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    },
  );

  it("clears interactiveSubagentRegistry in session_shutdown", () => {
    // Pre-populate with both running and non-running states. The cancel
    // loop is mocked, so it does NOT remove entries — the explicit
    // `interactiveSubagentRegistry.clear()` is what empties the map.
    const running = makeState("run-1", "running");
    const exited = makeState("exit-1", "exited");
    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);
    interactiveTmux.interactiveSubagentRegistry.set(exited.id, exited);

    const { shutdownHandler } = setupExtension();
    expect(interactiveTmux.interactiveSubagentRegistry.size).toBe(2);

    shutdownHandler!();

    expect(interactiveTmux.interactiveSubagentRegistry.size).toBe(0);
  });

  it("aborts, suppresses, and clears background workflows on session_shutdown", () => {
    const abort = new AbortController();
    const abortSpy = vi.spyOn(abort, "abort");
    const workflow = {
      id: "wf-shutdown",
      name: "shutdown-test",
      status: "running" as const,
      startedAt: Date.now(),
      promise: new Promise<never>(() => {}),
      abort,
      suppressCompletionNotification: false,
      snapshot: {
        agentsSpawned: 0,
        errorCount: 0,
        tokensSpent: 0,
        phases: [],
      },
    };
    const { shutdownHandler } = setupExtension();
    Object.assign(workflow, {
      parentSessionOwner: getActiveSessionContextToken(),
    });
    workflowJobRegistry.set(workflow.id, workflow);
    shutdownHandler!();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(workflow.suppressCompletionNotification).toBe(true);
    expect(workflowJobRegistry.size).toBe(0);
  });

  // ── Bug A regression tests (duplicate notification on shutdown) ──

  // The race: a poll tick dequeued from setInterval before clearInterval

  // runs can observe the in-progress cancel state. The fix (snapshot-then-clear

  // in session_shutdown) means a post-shutdown tick finds an empty registry

  // and delivers zero notifications. We capture the actual setInterval

  // callback (via the setIntervalSpy) and invoke it before AND after the

  // shutdown handler — this exercises the same code path as a real

  // in-flight tick that survived clearInterval.

  function makeArtifactState(
    id: string,
    status: InteractiveSubagentState["status"],
    artifactDir: string,
  ): InteractiveSubagentState {
    return {
      ...makeState(id, status),
      artifactDir,
    };
  }

  it("AC-A1: setInterval tick after session_shutdown delivers zero notifications (race-reproducing)", async () => {
    // Empty tmp artifact dir; no events written.

    tmpRoot = mkdtempSync(join(tmpdir(), "pi-shutdown-a1-"));

    const artifactDir = join(tmpRoot, "run-1");

    const running = makeArtifactState("run-1", "running", artifactDir);

    interactiveTmux.interactiveSubagentRegistry.set(running.id, running);

    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const { api, shutdownHandler } = setupExtension({ ui });

    // Capture the production callback installed by `session_start`.

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

    // 2. Shutdown handler runs.

    shutdownHandler!();

    // 3. Post-shutdown tick (in-flight race survivor): the registry is

    // empty (snapshot-before-clear), so the tick does no work. Total

    // notification count stays at 1 — no duplicate delivered.

    tick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledOnce();
    __setTmuxMultiplexer(undefined);
  });

  afterEach(() => {
    // Clean up tmp artifact dirs created by the AC-A* tests.
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
