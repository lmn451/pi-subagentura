/**
 * Tests for rehydrateInteractiveSubagents core behavior:
 * missing state, registry population, attach/focus commands,
 * idempotency, runtime cursors, alive/terminal counts, unreachable cwd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
  updateInteractiveState,
} from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import type * as SubagentModule from "../src/subagent";
import { flushDeliveries } from "../src/delivery";
import { importFresh } from "./test-utils";
import { makeTmp, makeState } from "./subagent-rehydrate-helpers";

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    vi.resetModules();
    const alivePaneId = "%alive1";
    vi.doMock("../src/multiplexer", () => ({
      getMux: () => ({
        name: "tmux",
        isAvailable: () => true,
        isPaneAlive: (paneId: string) => paneId === alivePaneId,
        observePane: async (paneId: string) =>
          paneId === alivePaneId
            ? ({ kind: "alive" } as const)
            : ({ kind: "dead" } as const),
        buildAttachCommands: (state: { windowName?: string }) => ({
          attachCommand: `tmux attach -t ${state.windowName ?? "session"}`,
          focusCommand: `tmux select-window -t ${state.windowName ?? "session"}`,
        }),
      }),
      NoMultiplexerAvailableError: class extends Error {},
    }));
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("../src/multiplexer");
  });

  it("returns { total: 0 } when the state file is missing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const result = mod.rehydrateInteractiveSubagents(cwd);
    expect(result).toEqual({ total: 0, alive: 0, terminal: 0 });
  });

  it("populates the registry from a state.json with one entry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      triggerTurnOnComplete: true,
    });

    const result = mod.rehydrateInteractiveSubagents(cwd);

    expect(result.total).toBe(1);
    const rehydrated = interactiveSubagentRegistry.get("abc12345");
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.paneId).toBe("%42");
    expect(rehydrated?.mux).toBe("tmux");
    expect(rehydrated?.parentSessionId).toBe("pi");
    expect(rehydrated?.triggerTurnOnComplete).toBe(true);
  });

  it("preserves an explicit false trigger override across rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "explicit-false");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      triggerTurnOnComplete: false,
    });

    mod.rehydrateInteractiveSubagents(cwd);

    expect(
      interactiveSubagentRegistry.get(state.id)?.triggerTurnOnComplete,
    ).toBe(false);
  });

  it("rebuilds attach and focus commands on rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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

  it("restores persisted v2 cursors on rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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
    expect(rehydrated.eventByteCursor).toBe(0);
    expect(rehydrated.lastDeliveredEventTs).toBeUndefined();
    expect(rehydrated.lastDeliveredSessionByte).toBe(0);
    expect(rehydrated.lastInjectedEventTs).toBeUndefined();
    expect(rehydrated.lastSnapshotEventTs).toBeUndefined();
    expect(rehydrated.injected).toBeUndefined();
    expect(rehydrated.autoDoneForTurnAt).toBeUndefined();
  });

  it("restores a persisted partial session line from its replay point", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });
    updateInteractiveState(cwd, state.id, (entry) => {
      entry.sessionByteCursor = 200;
      entry.sessionPartialLineStart = 125;
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(state.id)!;
    expect(rehydrated.lastDeliveredSessionByte).toBe(125);
    expect(rehydrated.sessionPartialLineStart).toBe(125);
    expect(rehydrated.sessionObservedByteCursor).toBe(200);
  });

  it("conservatively replays legacy session cursors from zero", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });
    updateInteractiveState(cwd, state.id, (entry) => {
      entry.sessionByteCursor = 200;
      delete entry.sessionPartialLineStart;
    });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(state.id)!;
    expect(rehydrated.lastDeliveredSessionByte).toBe(0);
    expect(rehydrated.sessionPartialLineStart).toBeUndefined();
    expect(rehydrated.sessionObservedByteCursor).toBe(200);
  });

  it("requeues unmatched dispatchAttempted delivery after rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      eventByteCursor: 10,
      sessionByteCursor: 0,
      pendingDeliveries: [
        {
          deliveryId: "retry-me",
          subagentId: state.id,
          turnId: "turn",
          eventId: "event",
          mode: "inject",
          triggerTurn: false,
          status: "done",
          artifactDir: state.artifactDir,
          state: "dispatchAttempted",
        },
      ],
      deliveryReceipts: [],
    });

    mod.rehydrateInteractiveSubagents(cwd, undefined, []);
    const rehydrated = interactiveSubagentRegistry.get("abc12345")!;
    expect(rehydrated.pendingDeliveries?.[0].state).toBe("queued");
    const sendMessage = vi.fn();
    flushDeliveries({ sendMessage } as any, undefined);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("removes matched dispatchAttempted delivery after rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      eventByteCursor: 10,
      sessionByteCursor: 0,
      pendingDeliveries: [
        {
          deliveryId: "already-sent",
          subagentId: state.id,
          turnId: "turn",
          eventId: "event",
          mode: "inject",
          triggerTurn: true,
          status: "done",
          artifactDir: state.artifactDir,
          state: "dispatchAttempted",
        },
      ],
      deliveryReceipts: [],
    });

    mod.rehydrateInteractiveSubagents(cwd, undefined, [
      {
        type: "custom_message",
        details: { deliveryIds: ["already-sent"] },
      },
    ]);
    const rehydrated = interactiveSubagentRegistry.get("abc12345")!;
    expect(rehydrated.pendingDeliveries).toEqual([]);
    expect(rehydrated.deliveryReceipts).toContain("already-sent");
    const sendMessage = vi.fn();
    flushDeliveries({ sendMessage } as any, undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rehydrates parent process cancellation as terminal without process exit", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      eventByteCursor: 10,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      lifecycle: {
        parentCancelled: true,
        completionTurnId: "process-cancel-id",
        completionOutcome: "cancelled",
        completionSource: "parent",
      },
    });

    const result = mod.rehydrateInteractiveSubagents(cwd);

    expect(interactiveSubagentRegistry.get(state.id)?.status).toBe("cancelled");
    expect(result.terminal).toBe(1);
  });

  it("preserves an uncertain synchronous pane miss during rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const state = makeState(cwd, "abc12345");
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      eventByteCursor: 1_000_000,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      lifecycle: {
        currentTurnId: "turn",
        completionTurnId: "turn",
        completionOutcome: "done",
        completionSource: "agent_settled",
      },
    });

    mod.rehydrateInteractiveSubagents(cwd);

    expect(interactiveSubagentRegistry.get(state.id)?.status).toBe("unknown");
    expect(interactiveSubagentRegistry.get(state.id)?.eventByteCursor).toBe(
      1_000_000,
    );
  });

  it("restores a persisted confirmed pane death despite id reuse", async () => {
    const mod = await importFresh<typeof SubagentModule>("../src/subagent");
    const id = "alive1";
    appendInteractiveState(cwd, {
      id,
      paneId: "%alive1",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
      paneDeathConfirmed: true,
      lifecycle: {
        completionOutcome: "done",
        completionSource: "explicit",
      },
    });

    mod.rehydrateInteractiveSubagents(cwd);

    expect(interactiveSubagentRegistry.get(id)?.status).toBe("exited");
  });

  it("counts alive vs terminal in the return value", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // alive1 is synchronously observed alive. A false compatibility probe for
    // done1 is uncertain until the async poll can classify the failure.
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
    updateInteractiveState(cwd, "done1", (entry) => {
      entry.lifecycle = {
        completionOutcome: "done",
        completionSource: "explicit",
        completionExitCode: 0,
      };
    });

    const result = mod.rehydrateInteractiveSubagents(cwdA);

    expect(result.total).toBe(2);
    expect(result.alive).toBe(1);
    expect(result.terminal).toBe(0);
    expect(interactiveSubagentRegistry.get("alive1")?.status).toBe("running");
    expect(interactiveSubagentRegistry.get("done1")?.status).toBe("unknown");
  });

  it("does not throw when ctx.cwd is unreachable (best-effort recovery)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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
});
