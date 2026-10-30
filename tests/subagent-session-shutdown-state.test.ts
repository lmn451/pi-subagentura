/**
 * Tests for session_shutdown state-file behavior:
 * deletion on /new, preservation on quit/reload/resume,
 * pane preservation on reload, defensive guard for missing ctx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendInteractiveState, loadInteractiveStates } from "../src/artifact";
import {
  orchestratorRoutingFilePath,
  upsertOrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import { registerInteractiveSubagentState } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import { makeTmp, makeState } from "./subagent-rehydrate-helpers";
import { clearSessionScopes, type SessionScope } from "../src/session-scope";

interface SessionContext {
  cwd?: string;
  sessionManager?: {
    getSessionId?: () => string;
    getEntries?: () => unknown[];
  };
}

type LifecycleHandler = (
  event?: { type?: string; reason?: string },
  ctx?: SessionContext,
) => void;

interface ExtensionFixture {
  shutdownHandlers: LifecycleHandler[];
  startHandlers: LifecycleHandler[];
  scope: SessionScope;
}

describe("session_shutdown clean-slate on /new and quit", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    clearSessionScopes();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
    clearSessionScopes();
  });

  async function setupExtension(): Promise<ExtensionFixture> {
    const api = { on: vi.fn() };
    const mod = await importFresh<{
      registerSessionHandlers: (pi: ExtensionAPI) => SessionScope;
    }>("../src/session-handlers");
    // This test double intentionally implements only lifecycle registration.
    const scope = mod.registerSessionHandlers(api as unknown as ExtensionAPI);

    const shutdownHandlers: LifecycleHandler[] = [];
    const startHandlers: LifecycleHandler[] = [];
    const registrations = api.on.mock.calls as unknown as Array<
      [string, LifecycleHandler]
    >;
    for (const [event, handler] of registrations) {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
      if (event === "session_start") startHandlers.push(handler);
    }
    return {
      shutdownHandlers,
      startHandlers,
      scope,
    };
  }

  function startSession(
    extension: ExtensionFixture,
    reason = "new",
    sessionId = "pi",
  ) {
    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    };
    extension.startHandlers.at(-1)!({ type: "session_start", reason }, ctx);
    expect(extension.scope.lifecycle).toBe("started");
    return ctx;
  }

  it("deletes state on final /new shutdown without touching a live peer", async () => {
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    expect(loadInteractiveStates(cwd)).not.toBeNull();

    const owner = await setupExtension();
    const peer = await setupExtension();
    const ownerCtx = startSession(owner, "new", "session-owner");
    const peerCtx = startSession(peer, "new", "session-peer");
    const ownerState = makeState(cwd, "owner-state");
    ownerState.parentSessionId = "session-owner";
    ownerState.status = "exited";
    const peerState = makeState(cwd, "peer-state");
    peerState.parentSessionId = "session-peer";
    registerInteractiveSubagentState(ownerState, owner.scope);
    registerInteractiveSubagentState(peerState, peer.scope);
    for (const state of [ownerState, peerState]) {
      appendInteractiveState(cwd, {
        id: state.id,
        paneId: state.paneId,
        mux: "tmux",
        artifactDir: state.artifactDir,
        sessionFile: state.sessionFile,
        parentSessionId: state.parentSessionId,
      });
    }

    owner.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "new" },
      ownerCtx,
    );

    expect(loadInteractiveStates(cwd)).not.toBeNull();
    expect(loadInteractiveStates(cwd)?.states[ownerState.id]).toBeUndefined();
    expect(loadInteractiveStates(cwd)?.states[peerState.id]).toBeDefined();
    expect(owner.scope.interactiveStates.size).toBe(0);
    expect(peer.scope.interactiveStates.get(peerState.id)).toBe(peerState);

    peer.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "new" },
      peerCtx,
    );
    expect(loadInteractiveStates(cwd)).toBeNull();
    expect(peer.scope.interactiveStates.size).toBe(0);
  });

  it("deletes routing metadata on /new shutdown", async () => {
    upsertOrchestratorRoutingEntry(cwd, {
      childId: "0123456789abcdef",
      description: "Own the routing cleanup regression",
      provenance: "user",
    });
    const routingFile = orchestratorRoutingFilePath(cwd);
    expect(existsSync(routingFile)).toBe(true);

    const extension = await setupExtension();
    const ctx = startSession(extension, "new");
    extension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "new" },
      ctx,
    );

    expect(existsSync(routingFile)).toBe(false);
  });

  it("session_shutdown with reason='quit' KEEPS the state file (rehydrate depends on it)", async () => {
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    expect(loadInteractiveStates(cwd)).not.toBeNull();
    const extension = await setupExtension();
    const ctx = startSession(extension);
    extension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "quit" },
      ctx,
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("rehydrates interactive subagents after quit and matching startup", async () => {
    const id = "survives-quit";
    const sessionId = "session-mine";
    appendInteractiveState(cwd, {
      id,
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: sessionId,
    });

    const firstExtension = await setupExtension();
    const firstCtx = startSession(firstExtension, "new", sessionId);
    const state = makeState(cwd, id);
    state.parentSessionId = sessionId;
    registerInteractiveSubagentState(state, firstExtension.scope);
    firstExtension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "quit" },
      firstCtx,
    );

    expect(firstExtension.scope.interactiveStates.size).toBe(0);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();

    const secondExtension = await setupExtension();
    startSession(secondExtension, "startup", sessionId);

    expect(secondExtension.scope.interactiveStates.has(id)).toBe(true);
  });

  it("session_shutdown with reason='reload' KEEPS the state file (rehydrate depends on it)", async () => {
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const extension = await setupExtension();
    const ctx = startSession(extension);
    extension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("session_shutdown with reason='resume' KEEPS the state file", async () => {
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const extension = await setupExtension();
    const ctx = startSession(extension);
    extension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "resume" },
      ctx,
    );
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });

  it("session_shutdown with reason='reload' preserves running panes for rehydrate", async () => {
    const execFileSync = vi.fn((_file: string, args: string[]) => {
      if (args[0] === "display-message") return Buffer.from("#42");
      return Buffer.from("");
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execFileSync }));

    const extension = await setupExtension();
    const ctx = startSession(extension);
    const state = makeState(cwd, "abc12345");
    state.parentSessionId = "pi";
    registerInteractiveSubagentState(state, extension.scope);

    extension.shutdownHandlers.at(-1)!(
      { type: "session_shutdown", reason: "reload" },
      ctx,
    );

    expect(extension.scope.interactiveStates.size).toBe(0);
    expect(execFileSync).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-pane"]),
      expect.anything(),
    );
  });

  it("session_shutdown is a no-op for the state file when ctx.cwd is missing", async () => {
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });
    const extension = await setupExtension();
    startSession(extension);
    expect(() =>
      extension.shutdownHandlers.at(-1)!(
        { type: "session_shutdown", reason: "new" },
        undefined,
      ),
    ).not.toThrow();
    // File is unchanged because ctx was undefined — defensive guard.
    expect(loadInteractiveStates(cwd)).not.toBeNull();
  });
});
