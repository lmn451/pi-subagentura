/**
 * The artifact-driven poller fires pointer notifications for new events on
 * interactive sub-agents. Tests reset the global pi ref + registry, then write
 * events directly to the artifact dir to drive the poller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
  loadInteractiveStates,
  writeOutput,
} from "./artifact";
import { importFresh } from "./test-utils";
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

function makeState(): {
  id: string;
  artifactDir: string;
  state: import("./interactive-tmux").InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const artifactDir = join(makeTmp(), id);
  const state: import("./interactive-tmux").InteractiveSubagentState = {
    id,
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: "/tmp/sess.jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    mux: "tmux",
    status: "running",
    attachCommand: "tmux attach -t sess",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir,
  };
  return { id, artifactDir, state };
}

describe("pollArtifactChanges", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
  });

  it("does nothing when registry is empty", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fires a pointer notification on done. Started is silent.", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Only done fires. started is silent (widget shows it).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.customType).toBe("subagent-notify");
    expect(call.content).toContain("done");
    // Pointer format: paths, not a tool-call hint.
    expect(call.content).toContain("Output:");
    expect(call.content).toContain("Activity log:");
    expect(call.content).not.toContain("read_subagent_artifact");
    // cursor still advances to 2 even though only 1 was delivered
    expect(state.lastDeliveredEventTs).toBe(2);
  });

  it("does NOT fire on tool_activity/started", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, {
      ts: 2,
      type: "tool_activity",
      status: "running",
      tool: "bash",
      summary: "rg TODO src/",
    });

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Both are silent (started → TUI widget row; tool_activity → TUI widget only).
    expect(sendMessage).not.toHaveBeenCalled();
    // But the cursor still advances past them so they aren't re-delivered.
    expect(state.lastDeliveredEventTs).toBe(2);
  });

  it("fires on error and cancelled too", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, {
      ts: 2,
      type: "error",
      status: "error",
      message: "boom",
    });
    appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][0].content).toContain("error");
    expect(sendMessage.mock.calls[1][0].content).toContain("cancelled");
  });

  it("is at-most-once per event (cursor advances)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);
    // Only done fires (started is silent).
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second poll: no new events, no new notifications.
    sendMessage.mockClear();
    mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers only events newer than lastDeliveredEventTs (backlog catch-up)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    // Simulate a sub-agent that finished while the parent was down — events
    // were already on disk before this poller started.
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    // Pretend the parent already saw events up to ts=1 (e.g. last session
    // before a restart).
    state.lastDeliveredEventTs = 1;

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);

    // Should deliver done + cancelled, not started.
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(sendMessage.mock.calls[1][0].content).toContain("cancelled");
    // cursor advanced to the latest
    expect(state.lastDeliveredEventTs).toBe(3);
  });

  it("marks the sub-agent as idle when a done event is seen and the pane is still alive (follow-up support)", async () => {
    // The child is between turns, REPL is open, ready for the next prompt.
    // Force the pane to look alive by mocking tmux display-message to succeed.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("idle");
    // exitCode is NOT set on idle — child is still around.
    expect(state.exitCode).toBeUndefined();
  });

  it("marks the sub-agent as exited when a done event is seen but the pane is gone", async () => {
    // Default tmux mock: display-message throws → isTmuxPaneAlive → false → exited.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("can't find pane: %99");
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("exited");
    expect(state.exitCode).toBe(0);
  });

  it("marks the sub-agent as cancelled when a cancelled event is seen", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("cancelled");
  });

  it("skips sub-agents that are strictly terminal (cancelled, unknown)", async () => {
    // 'cancelled' and 'unknown' are strictly terminal — the poll loop must not re-deliver events
    // for them and they cannot be revived.
    // 'exited' is INTENTIONALLY not in this list: the user-role revival at processSessionLogEntry
    // can revive an 'exited' sub-agent back to 'running' on a follow-up user message. The poll
    // loop must keep tail-reading the session log for 'exited' sub-agents so the revival is
    // reachable. (See subagent-auto-done.test.ts for the revival tests.)
    // 'idle' is between-turns, not terminal — must always be processed for follow-up support.
    for (const terminal of ["cancelled", "unknown"] as const) {
      vi.resetModules();
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.status = terminal;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

      const sendMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage } as any);
      expect(
        sendMessage,
        `status=${terminal} should be skipped`,
      ).not.toHaveBeenCalled();
      // Reset for next iteration.
      mod.interactiveSubagentRegistry.delete(state.id);
    }
  });

  it("keeps processing 'idle' sub-agents — the follow-up case", async () => {
    // After the child finishes a turn, status becomes 'idle'. The poll loop must keep running for
    // it so a second `done` event (from a follow-up turn) re-fires the pointer notification.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { state, artifactDir } = makeState();
    state.status = "idle"; // simulate "already between turns"
    state.lastDeliveredEventTs = 2; // first turn's `done` was already delivered
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 }); // follow-up turn

    const sendMessage = vi.fn();
    mod.pollArtifactChanges({ sendMessage } as any);

    // The new done event (ts=3) is delivered as a pointer notification.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(state.lastDeliveredEventTs).toBe(3);
  });

  // Inject-mode tests: when a sub-agent is spawned with notifyOnComplete:
  // "inject" and finishes with a `done` event, the poller also calls
  // pi.sendUserMessage with output.md so the parent LLM processes it in its
  // next turn. Mirrors the async subagent's inject delivery.
  describe("inject mode for interactive sub-agents", () => {
    beforeEach(() => {
      (globalThis as any).__piSubagenturaInjectCount = 0;
    });

    it("calls sendUserMessage with output.md on done when state.notifyOnComplete === 'inject'", async () => {
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the sub-agent's final answer");

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // Both the pointer notification and the inject fire.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      const [userContent, userOpts] = sendUserMessage.mock.calls[0];
      expect(userContent).toBe("the sub-agent's final answer");
      expect(userOpts).toMatchObject({ deliverAs: "followUp" });
      // At-most-once guard flipped.
      // At-most-once per `done` event — the new field stores the event's ts, not a bool.
      expect(state.lastInjectedEventTs).toBe(2);
    });

    it("does NOT call sendUserMessage when state.notifyOnComplete is unset (default: notify)", async () => {
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // Pointer fires; inject does not.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(state.lastInjectedEventTs).toBeUndefined();
    });

    it("does NOT call sendUserMessage when state.notifyOnComplete === 'notify' (explicit)", async () => {
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "notify";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("is at-most-once: a second poll does NOT re-inject (state.injected guard)", async () => {
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the answer");

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);

      // Second poll: no new events (cursor advanced), inject is gated by state.injected.
      sendMessage.mockClear();
      sendUserMessage.mockClear();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("re-injects output.md on a SECOND done event (follow-up support)", async () => {
      // This is the core follow-up guarantee: the parent gets the new turn's output injected,
      // not just the first turn's. The cursor (lastDeliveredEventTs) advances normally, and
      // the inject path uses lastInjectedEventTs (per-turn), not a one-shot boolean.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      // Turn 1: child finishes, writes output v1, calls done.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage.mock.calls[0][0]).toBe("answer v1");
      expect(state.lastInjectedEventTs).toBe(2);

      // Turn 2: parent sent a follow-up, child processed it, wrote output v2, called done again.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");

      sendMessage.mockClear();
      sendUserMessage.mockClear();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // The new done event (ts=3) triggers BOTH a new pointer notification AND a new inject.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage.mock.calls[0][0]).toBe("answer v2");
      expect(state.lastInjectedEventTs).toBe(3);
    });

    it("does not call sendUserMessage when output.md is missing", async () => {
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      // Intentionally NOT writing output.md

      const sendMessage = vi.fn();
      const sendUserMessage = vi.fn();
      mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // output.md missing: inject is skipped, but the state is still marked injected
      // to prevent re-attempts on later polls.
      expect(sendUserMessage).not.toHaveBeenCalled();
      // output.md missing: inject is skipped, but the ts of the done we attempted to
      // inject for is still recorded so the next done (different ts) re-fires.
      expect(state.lastInjectedEventTs).toBe(2);
      expect(state.lastInjectedEventTs).toBe(2);
    });

    it("snapshots output.md to output-N.md on each new done event (history preservation)", async () => {
      // The poller must preserve turn history. After a new done event, output-N.md (where N =
      // count of done events in the artifact) is created from output.md. Earlier turns' snapshots
      // are NOT overwritten.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      // Turn 2.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      // Both snapshots exist, with the content from their respective turns.
      const v1Path = join(art.dir, "output-1.md");
      const v2Path = join(art.dir, "output-2.md");
      expect(existsSync(v1Path)).toBe(true);
      expect(existsSync(v2Path)).toBe(true);
      expect(readFileSync(v1Path, "utf8")).toBe("answer v1");
      expect(readFileSync(v2Path, "utf8")).toBe("answer v2");
    });

    it("snapshots output.md even when notifyOnComplete is unset (history is useful regardless)", async () => {
      // History preservation is independent of inject mode — a parent using 'notify' or default
      // still benefits from being able to read earlier turns via read_subagent_artifact.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined.
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(existsSync(join(art.dir, "output-1.md"))).toBe(true);
    });

    it("in notify mode, a follow-up overwriting output.md before its done event does NOT corrupt the prior turn's snapshot", async () => {
      // Regression: the snapshot guard must not reuse lastInjectedEventTs (only set in inject mode).
      // In the default notify mode that field stays undefined, so a pre-fix poller re-snapshotted
      // every tick — and once a follow-up turn overwrote output.md before its own done landed, it
      // clobbered output-1.md (turn 1's history) with the in-progress turn-2 content.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined (default 'notify') — the broken path.
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1 completes and is snapshotted.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(readFileSync(join(art.dir, "output-1.md"), "utf8")).toBe(
        "answer v1",
      );

      // Follow-up turn: the child overwrites output.md but its done event has NOT landed yet
      // (last event is still the turn-1 done@ts2). A poll lands in this window.
      writeOutput(art, "answer v2 in progress");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      // output-1.md must still hold turn 1's content — not the in-progress turn-2 output.
      expect(readFileSync(join(art.dir, "output-1.md"), "utf8")).toBe(
        "answer v1",
      );

      // When turn 2's done finally lands, it snapshots to output-2.md, leaving turn 1 intact.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2 final");
      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(readFileSync(join(art.dir, "output-1.md"), "utf8")).toBe(
        "answer v1",
      );
      expect(readFileSync(join(art.dir, "output-2.md"), "utf8")).toBe(
        "answer v2 final",
      );
    });
  });

  // ── Bug B regression tests (stale footer/widget for closed sub-agents) ──
  // When a sub-agent is "exited" (terminal, pane dead) the for-loop at line
  // ~518 of subagent.ts must still tail-read the session log (for user-role
  // revival), but it must NOT contribute to the `runningCount` footer or
  // the `widgetRows` list. `idle` sub-agents (between turns, REPL open) are
  // still live and DO contribute to the running count.
  describe("footer/widget (Bug B)", () => {
    it("AC-B1: counts running + idle as 'running'; excludes exited from both footer and widget", async () => {
      // Mock display-message to branch on paneId:
      //   running-pane and idle-pane → alive (return success)
      //   exited-pane              → dead (throw)
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") {
            const paneId = args[3];
            if (paneId === "%exited-pane") throw new Error("pane dead");
            return Buffer.from("#99");
          }
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");

      // Running sub-agent: no events in artifact; pane alive.
      const running = makeState().state;
      running.id = "running-1";
      running.paneId = "%running-pane";
      mod.interactiveSubagentRegistry.set(running.id, running);

      // Idle sub-agent: done event, pane alive. artifactDir must be set so the
      // poller reads from the same dir where we write the events.
      const idle = makeState().state;
      idle.id = "idle-1";
      idle.paneId = "%idle-pane";
      idle.lastDeliveredEventTs = 2;
      idle.artifactDir = join(idle.artifactDir, "..", idle.id);
      mod.interactiveSubagentRegistry.set(idle.id, idle);
      const idleArt = artifactPath(join(idle.artifactDir, ".."), idle.id);
      appendEvent(idleArt, { ts: 1, type: "started", status: "running" });
      appendEvent(idleArt, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      // Exited sub-agent: done event, pane dead.
      const exited = makeState().state;
      exited.id = "exited-1";
      exited.paneId = "%exited-pane";
      exited.lastDeliveredEventTs = 2;
      exited.artifactDir = join(exited.artifactDir, "..", exited.id);
      mod.interactiveSubagentRegistry.set(exited.id, exited);
      const exitedArt = artifactPath(join(exited.artifactDir, ".."), exited.id);
      appendEvent(exitedArt, { ts: 1, type: "started", status: "running" });
      appendEvent(exitedArt, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents running",
      );
      expect(setWidget).toHaveBeenCalledWith(
        "subagentura-activity",
        expect.any(Array),
        { placement: "belowEditor" },
      );
      const widgetArgs = setWidget.mock.calls[0];
      expect(widgetArgs[1].length).toBe(2);

      expect(exited.status).toBe("exited");
      expect(idle.status).toBe("idle");
      expect(running.status).toBe("running");

      delete (globalThis as any).__piSubagenturaUi;
    });

    it("AC-B2: clears footer and widget when all sub-agents are exited", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "-lc") return Buffer.from("");
          throw new Error("pane dead");
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");

      const exited1 = makeState().state;
      exited1.id = "exited-1";
      exited1.lastDeliveredEventTs = 2;
      exited1.artifactDir = join(exited1.artifactDir, "..", exited1.id);
      mod.interactiveSubagentRegistry.set(exited1.id, exited1);
      const exited1Art = artifactPath(
        join(exited1.artifactDir, ".."),
        exited1.id,
      );
      appendEvent(exited1Art, { ts: 1, type: "started", status: "running" });
      appendEvent(exited1Art, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith("subagentura-running", undefined);
      expect(setWidget).toHaveBeenCalledWith(
        "subagentura-activity",
        undefined,
        { placement: "belowEditor" },
      );

      expect(exited1.status).toBe("exited");

      delete (globalThis as any).__piSubagenturaUi;
    });

    it("AC-B3: all-running registry shows correct count (regression guard)", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("#99");
          return "";
        },
      }));
      const mod = await importFresh<typeof import("./subagent")>("./subagent");

      const a = makeState().state;
      a.id = "a";
      mod.interactiveSubagentRegistry.set(a.id, a);
      const b = makeState().state;
      b.id = "b";
      mod.interactiveSubagentRegistry.set(b.id, b);

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents running",
      );
      const widgetArgs = setWidget.mock.calls[0];
      expect(widgetArgs[1].length).toBe(2);

      delete (globalThis as any).__piSubagenturaUi;
    });
  });
});

describe("pollArtifactChanges — terminal cleanup of state.json", () => {
  const SESSION = "019e500a-bae9-783a-869a-ac7c106b4ab7";

  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  function makePersistedState(): {
    id: string;
    cwd: string;
    state: import("./interactive-tmux").InteractiveSubagentState;
  } {
    const cwd = makeTmp();
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("./interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd,
      startedAt: Date.now(),
      mux: "tmux",
      status: "running",
      attachCommand: "tmux attach -t sess",
      selectPaneCommand: "tmux select-pane -t '%99'",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: join(cwd, id),
      parentSessionId: "pi",
    };
    appendInteractiveState(cwd, {
      id,
      paneId: state.paneId,
      windowName: state.windowName,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
    });
    return { id, cwd, state };
  }

  it("removes the state.json entry after delivering a done event when the pane is dead", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("can't find pane: %99");
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeUndefined();
  });

  it("keeps the state.json entry after delivering a done event when the pane is alive", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.status).toBe("idle");
  });
  it("removes the state.json entry after delivering an error event", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeUndefined();
  });

  it("removes the state.json entry after delivering a cancelled event", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeUndefined();
  });

  it("keeps the state.json entry and cursor when notification delivery fails", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    mod.pollArtifactChanges({
      sendMessage: vi.fn(() => {
        throw new Error("stale pi");
      }),
    } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.lastDeliveredEventTs ?? 0).toBe(0);
  });

  it("does NOT remove the state.json entry on tool_activity events (only terminals)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "tool_activity",
      status: "running",
      tool: "bash",
      summary: "ls",
    });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
  });

  it("does NOT throw if state has no parentSessionId (no-op guard)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("./interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: Date.now(),
      mux: "tmux",
      status: "running",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: "/tmp/art-" + id,
    };
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath("/tmp", id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

    expect(() =>
      mod.pollArtifactChanges({ sendMessage: vi.fn() } as any),
    ).not.toThrow();
  });

  it("advances lastDeliveredEventTs before removing the state entry (crash-safe ordering)", async () => {
    const mod = await importFresh<typeof import("./subagent")>("./subagent");
    const { id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.lastDeliveredEventTs).toBe(2);
  });
});
