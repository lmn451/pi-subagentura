/**
 * Tests for the session_start rehydrate + session_shutdown clean-slate path.
 *
 * Rehydrate walks the on-disk state file and repopulates the in-memory
 * interactiveSubagentRegistry so the parent's view of an orphan interactive
 * sub-agent survives a parent reload. The clean-slate unlink on
 * session_shutdown(reason="new"|"quit") gives /new a fresh start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
  loadInteractiveStates,
} from "./artifact";
import type { InteractiveSubagentState } from "./interactive-tmux";
import { interactiveSubagentRegistry } from "./interactive-tmux";
import { importFresh } from "./test-utils";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-rehydrate-"));
}

function makeState(cwd: string, id: string): InteractiveSubagentState {
  const artifactDir = join(cwd, id);
  return {
    id,
    name: id,
    task: "",
    paneId: "%42",
    windowName: "demo",
    mux: "tmux",
    sessionFile: "/tmp/sess.jsonl",
    cwd,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
    artifactDir,
    notifyOnComplete: "inject",
    parentSessionId: "pi",
  };
}

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    // Install a tmux mock so isPaneAlive returns false for fake pane IDs.
    // Without this, tmux 3.6b treats unknown pane IDs as "alive" (succeeds with empty output),
    // making the alive/terminal counts environment-dependent.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string) => {
        // Only handle display-message used by isPaneAlive; throw for all others
        // (new-window, etc.) so they don't accidentally succeed.
        throw new Error("mock: child_process unavailable");
      },
    }));
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("returns { total: 0 } when the state file is missing", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const result = mod.rehydrateInteractiveSubagents(cwd);
    expect(result).toEqual({ total: 0, alive: 0, terminal: 0 });
  });

  it("populates the registry from a state.json with one entry", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    const result = mod.rehydrateInteractiveSubagents(cwd);

    expect(result.total).toBe(1);
    const rehydrated = interactiveSubagentRegistry.get("abc12345");
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.paneId).toBe("%42");
    expect(rehydrated?.mux).toBe("tmux");
    expect(rehydrated?.parentSessionId).toBe("pi");
  });

  it("rebuilds attach and focus commands on rehydrate", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") {
          if (
            args.includes("#{session_name}\t#{window_index}\t#{pane_index}")
          ) {
            return "demo\t1\t0\n";
          }
          return Buffer.from("%42");
        }
        return "";
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = mod.interactiveSubagentRegistry.get("abc12345");
    expect(rehydrated?.attachCommand).toContain("tmux attach");
    expect(rehydrated?.selectPaneCommand).toContain("tmux select-window");
  });

  it("is a no-op when the registry already has the id (idempotent)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    // Pre-populate the registry with a different (older) state.
    const older: InteractiveSubagentState = { ...state, paneId: "%OLD" };
    interactiveSubagentRegistry.set("abc12345", older);

    mod.rehydrateInteractiveSubagents(cwd);

    const after = interactiveSubagentRegistry.get("abc12345");
    expect(after?.paneId).toBe("%OLD");
  });

  it("resets all runtime cursors on rehydrate", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get("abc12345")!;
    expect(rehydrated.lastDeliveredEventTs).toBe(0);
    expect(rehydrated.lastDeliveredSessionByte).toBe(0);
    expect(rehydrated.lastInjectedEventTs).toBeUndefined();
    expect(rehydrated.lastSnapshotEventTs).toBeUndefined();
    expect(rehydrated.injected).toBeUndefined();
    expect(rehydrated.autoDoneForTurnAt).toBeUndefined();
  });

  it("counts alive vs terminal in the return value", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    // Two entries: alive1 (no events, pane not alive → unknown), done1 (done event,
    // pane not alive → exited). We can predict exact counts here because the test
    // runs in a tmux environment and isPaneAlive returns false for fake pane IDs.
    const cwdA = cwd;
    const cwdB = cwd;
    for (const id of ["alive1", "done1"]) {
      appendInteractiveState(cwdA, {
        id,
        paneId: "%" + id,
        mux: "tmux",
        artifactDir: join(cwdB, id),
        sessionFile: "/tmp/sess.jsonl",
      });
    }
    const art1 = artifactPath(cwdB, "done1");
    appendEvent(art1, { ts: 1, type: "started", status: "running" });
    appendEvent(art1, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const result = mod.rehydrateInteractiveSubagents(cwdA);

    expect(result.total).toBe(2);
    // alive1 has no events → status=unknown (not counted); done1 has done event → status=exited (terminal)
    expect(result.alive).toBe(0);
    expect(result.terminal).toBe(1);
    expect(interactiveSubagentRegistry.get("alive1")?.status).toBe("unknown");
    expect(interactiveSubagentRegistry.get("done1")?.status).toBe("exited");
  });

  it("does not throw when ctx.cwd is unreachable (best-effort recovery)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    expect(() =>
      mod.rehydrateInteractiveSubagents(
        "/nonexistent/path/that/does/not/exist",
      ),
    ).not.toThrow();
    expect(() =>
      mod.rehydrateInteractiveSubagents(
        "/nonexistent/path/that/does/not/exist",
      ),
    ).not.toThrow();
  });

  it("inject-mode orphans DO re-inject their existing terminal event on the first poll after rehydrate", async () => {
    // Behavior change: we no longer suppress re-injection here. The inject-mode path
    // fires on every NEW `done` event. On rehydrate, lastInjectedEventTs starts as
    // undefined, so the first poll will re-inject the latest terminal event. This means
    // exactly one extra inject per sub-agent on parent reload, which is acceptable —
    // it's better than silently dropping a result that completed during the reload downtime.
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const id = "inject-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%77",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "inject",
    });
    // Add a done event to the artifact (what an orphan-with-completed-work looks like).
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    // lastInjectedEventTs should remain undefined — we no longer suppress re-injection.
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
  });

  it("notify-mode orphans leave lastInjectedEventTs undefined (inject path is irrelevant)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const id = "notify-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%88",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "notify",
    });
    mod.rehydrateInteractiveSubagents(cwd);
    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
  });

  it("recovers name from prompt file and startedAt from first event", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const id = "recover-me";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });

    // Create a prompt file: the label before "-prompt.md" becomes the name
    writeFileSync(join(artDir, "my-agent-prompt.md"), "task content", {
      mode: 0o600,
    });

    // Persist state entry (name not in persisted state — recovered from prompt file)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
    });

    // Write events: first event's ts becomes startedAt
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1000, type: "started", status: "running" });
    appendEvent(art, { ts: 2000, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe("my-agent"); // from prompt file label
    expect(rehydrated?.startedAt).toBe(1000); // from first event's ts
  });

  it("falls back to id for name and 0 for startedAt when artifacts are missing", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const id = "fallback-id";

    // Persist state with no artifact files (dir won't exist)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe(id); // falls back to entry.id
    expect(rehydrated?.startedAt).toBe(0); // falls back to 0
  });

  describe("session_start rehydrate integration", () => {
    let cwd: string;

    beforeEach(() => {
      cwd = makeTmp();
      const g = globalThis as any;
      g.__piSubagenturaInteractiveRegistry?.clear?.();
      g.__piSubagenturaPiRef = undefined;
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
      vi.doUnmock("node:child_process");
    });

    async function setupExtension() {
      const api = {
        registerTool: vi.fn(),
        registerMessageRenderer: vi.fn(),
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        on: vi.fn(),
      };
      const mod = (await importFresh<typeof import("./subagent")>("./subagent"))
        .default;
      mod(api as any);
      let startHandler: ((event: any, ctx: any) => void) | undefined;
      for (const [event, handler] of (api.on as any).mock.calls) {
        if (event === "session_start") startHandler = handler;
      }
      return { api, startHandler };
    }

    it("session_start handler repopulates the registry from the on-disk state file", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        windowName: "demo",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });

      const { startHandler } = await setupExtension();
      expect(startHandler).toBeTypeOf("function");
      startHandler!(
        { type: "session_start", reason: "reload" },
        {
          cwd,
        },
      );

      expect(interactiveSubagentRegistry.has("abc12345")).toBe(true);
    });

    it("session_start handler survives a missing state file (empty registry)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      const { startHandler } = await setupExtension();
      expect(() =>
        startHandler!(
          { type: "session_start", reason: "startup" },
          {
            cwd: "/nonexistent",
          },
        ),
      ).not.toThrow();
      expect(interactiveSubagentRegistry.size).toBe(0);
    });

    it("session_start does NOT rehydrate on startup when session ID doesn't match", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      // Entry from a different (old) session
      appendInteractiveState(cwd, {
        id: "from-old-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-old-session"),
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "session-old",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "startup" } as any, {
        cwd,
        sessionManager: { getSessionId: () => "session-new" },
      });

      // Registry should be empty - different session, no match
      expect(interactiveSubagentRegistry.size).toBe(0);
    });

    it("session_start DOES rehydrate on startup when session ID matches (--session / -r)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "from-same-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-same-session"),
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "session-mine",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "startup" } as any, {
        cwd,
        sessionManager: { getSessionId: () => "session-mine" },
      });

      // Registry should have the entry - matching session after restart with --session
      expect(interactiveSubagentRegistry.size).toBe(1);
      expect(interactiveSubagentRegistry.has("from-same-session")).toBe(true);
    });

    it("session_start filters by parentSessionId on reload", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      // Entry from a DIFFERENT session
      appendInteractiveState(cwd, {
        id: "other-session-agent",
        paneId: "%99",
        mux: "tmux",
        artifactDir: join(cwd, "other-session-agent"),
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "session-other",
      });
      // Entry from THIS session
      appendInteractiveState(cwd, {
        id: "this-session-agent",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "this-session-agent"),
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "session-current",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "reload" } as any, {
        cwd,
        sessionManager: { getSessionId: () => "session-current" },
      });

      // Only the matching entry should be rehydrated
      expect(interactiveSubagentRegistry.size).toBe(1);
      expect(interactiveSubagentRegistry.has("other-session-agent")).toBe(
        false,
      );
      expect(interactiveSubagentRegistry.has("this-session-agent")).toBe(true);
    });

    it("session_start does NOT rehydrate on new (explicit new session)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "from-previous-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-previous-session"),
        sessionFile: "/tmp/sess.jsonl",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "new" }, { cwd });

      // Registry should be empty - new sessions don't rehydrate old subagents
      expect(interactiveSubagentRegistry.size).toBe(0);
    });

    it("session_start does NOT rehydrate on fork (forked session)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "from-previous-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-previous-session"),
        sessionFile: "/tmp/sess.jsonl",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "fork" }, { cwd });

      // Registry should be empty - forked sessions don't rehydrate old subagents
      expect(interactiveSubagentRegistry.size).toBe(0);
    });

    it("session_start DOES rehydrate on resume (resumed session)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "from-previous-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-previous-session"),
        sessionFile: "/tmp/sess.jsonl",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "resume" }, { cwd });

      // Registry should have the rehydrated entry - resume preserves subagents
      expect(interactiveSubagentRegistry.size).toBe(1);
      expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(
        true,
      );
    });

    it("session_start DOES rehydrate on reload (reloaded session)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "from-previous-session",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "from-previous-session"),
        sessionFile: "/tmp/sess.jsonl",
      });

      const { startHandler } = await setupExtension();
      startHandler!({ type: "session_start", reason: "reload" }, { cwd });

      // Registry should have the rehydrated entry - reload preserves subagents
      expect(interactiveSubagentRegistry.size).toBe(1);
      expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(
        true,
      );
    });
  });

  describe("session_shutdown clean-slate on /new and quit", () => {
    let cwd: string;

    beforeEach(() => {
      cwd = makeTmp();
      const g = globalThis as any;
      g.__piSubagenturaInteractiveRegistry?.clear?.();
      g.__piSubagenturaPiRef = undefined;
    });

    afterEach(() => {
      rmSync(cwd, { recursive: true, force: true });
      vi.doUnmock("node:child_process");
    });

    async function setupExtension() {
      const api = {
        registerTool: vi.fn(),
        registerMessageRenderer: vi.fn(),
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
        on: vi.fn(),
      };
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      mod.default(api as any);

      const shutdownHandlers: Array<(event: any, ctx: any) => void> = [];
      for (const [event, handler] of (api.on as any).mock.calls) {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      }
      return { api, shutdownHandlers, mod };
    }

    it("session_shutdown with reason='new' deletes the state file", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });
      expect(loadInteractiveStates(cwd)).not.toBeNull();
      const { shutdownHandlers } = await setupExtension();
      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      heavyHandler(
        { type: "session_shutdown", reason: "new" },
        {
          cwd,
        },
      );
      expect(loadInteractiveStates(cwd)).toBeNull();
    });
    it("session_shutdown with reason='quit' KEEPS the state file (rehydrate depends on it)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });
      expect(loadInteractiveStates(cwd)).not.toBeNull();
      const { shutdownHandlers } = await setupExtension();
      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      heavyHandler(
        { type: "session_shutdown", reason: "quit" },
        {
          cwd,
        },
      );
      expect(loadInteractiveStates(cwd)).not.toBeNull();
    });

    it("session_shutdown with reason='reload' KEEPS the state file (rehydrate depends on it)", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });
      const { shutdownHandlers } = await setupExtension();
      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      heavyHandler(
        { type: "session_shutdown", reason: "reload" },
        {
          cwd,
        },
      );
      expect(loadInteractiveStates(cwd)).not.toBeNull();
    });
    it("session_shutdown with reason='resume' KEEPS the state file", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });
      const { shutdownHandlers } = await setupExtension();
      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      heavyHandler(
        { type: "session_shutdown", reason: "resume" },
        {
          cwd,
        },
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

      const { shutdownHandlers, mod } = await setupExtension();
      const state = makeState(cwd, "abc12345");
      state.parentSessionId = "pi";
      mod.interactiveSubagentRegistry.set(state.id, state);

      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      heavyHandler(
        { type: "session_shutdown", reason: "reload" },
        {
          cwd,
          sessionManager: { getSessionId: () => "pi" },
        },
      );

      expect(execFileSync).not.toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining(["kill-pane"]),
        expect.anything(),
      );
    });
    it("session_shutdown is a no-op for the state file when ctx.cwd is missing", async () => {
      await importFresh<typeof import("./subagent")>("./subagent");
      appendInteractiveState(cwd, {
        id: "abc12345",
        paneId: "%42",
        mux: "tmux",
        artifactDir: join(cwd, "abc12345"),
        sessionFile: "/tmp/sess.jsonl",
      });
      const { shutdownHandlers } = await setupExtension();
      const heavyHandler = shutdownHandlers[shutdownHandlers.length - 1];
      expect(() =>
        heavyHandler({ type: "session_shutdown", reason: "new" }, undefined),
      ).not.toThrow();
      // File is unchanged because ctx was undefined — defensive guard.
      expect(loadInteractiveStates(cwd)).not.toBeNull();
    });
  });
});
