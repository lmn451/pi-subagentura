/**
 * Negative regressions for the removed timeout completion heuristic.
 * Session stop metadata and output.md are never authoritative completion
 * signals; protocol-v2 child lifecycle events own completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, artifactPath, readEvents } from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-no-synthesis-"));
}

interface MakeOpts {
  sessionFile?: string;
  outputContent?: string | null;
}

function makeState(overrides: MakeOpts): {
  id: string;
  artifactDir: string;
  state: InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const root = makeTmp();
  const artifactDir = join(root, id);
  mkdirSync(artifactDir, { recursive: true });
  const sessionFile =
    overrides.sessionFile ?? join(artifactDir, "session.jsonl");
  if (
    overrides.outputContent !== undefined &&
    overrides.outputContent !== null
  ) {
    writeFileSync(join(artifactDir, "output.md"), overrides.outputContent);
  }
  const state: InteractiveSubagentState = {
    id,
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile,
    cwd: "/tmp",
    startedAt: Date.now(),
    status: "running",
    mux: "tmux",
    attachCommand: "tmux attach -t sess",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir,
    // Seed legacy stop metadata to prove the poller ignores it.
    lastStopReason: "stop",
    lastStopReasonAt: Date.now() - 11_000,
  };
  return { id, artifactDir, state };
}

/** Variant of makeState for end-to-end tests: no pre-seeded stopReason. */
function makeFreshState(overrides: MakeOpts): {
  id: string;
  artifactDir: string;
  state: InteractiveSubagentState;
} {
  const seeded = makeState(overrides);
  seeded.state.lastStopReason = undefined;
  seeded.state.lastStopReasonAt = undefined;
  seeded.state.lastStopText = undefined;
  seeded.state.autoDoneForTurnAt = undefined;
  return seeded;
}

function writeAssistantTurn(
  file: string,
  ts: number,
  stopReason: string,
  text: string,
): void {
  const entry = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai",
      provider: "openai",
      model: "gpt-4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: ts,
    },
  };
  writeFileSync(file, JSON.stringify(entry) + "\n");
}

describe("no parent-side timeout completion synthesis", () => {
  let root: string;

  beforeEach(() => {
    // The poller now uses the asynchronous observePane contract. Return the
    // pane id exactly as tmux does so the synthetic %99 pane is observed alive.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "%99", ""),
    }));
    root = makeTmp();
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ─── Core behavior ────────────────────────────────────────────────

  it("does not synthesize completion from stopReason when output.md exists", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "the result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    const sendMessage = vi.fn();
    await mod.pollArtifactChanges({ sendMessage } as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    expect(events).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.status).toBe("running");
  });

  it("does not synthesize an error when output.md is missing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: null });
    state.lastStopText =
      "Review complete. The findings file `/tmp/review-sec.md` contains 0 critical vulns.";
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    expect(events).toEqual([]);
    expect(state.status).toBe("running");
    expect(state.exitCode).toBeUndefined();
  });

  it("does not invent a generic error without an authoritative child event", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({ outputContent: null });
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(state.artifactDir), state.id);
    const events = readEvents(art);
    expect(events).toEqual([]);
  });

  it("ignores stopReason 'toolUse' as a completion signal", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    // Cast: the runtime value is intentionally outside the union so we can verify only
    // the four terminal stopReasons are accepted by the typecheck.
    state.lastStopReason = "toolUse" as unknown as "stop";
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    const inferred = events.find(
      (e) => e.type === "done" || e.type === "error",
    );
    expect(inferred).toBeUndefined();
    expect(state.status).toBe("running");
  });

  it.each(["length", "error", "aborted"] as const)(
    "ignores stopReason '%s' as a completion signal",
    async (reason) => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState({ outputContent: "result" });
      state.lastStopReason = reason;
      mod.interactiveSubagentRegistry.set(state.id, state);

      await mod.pollArtifactChanges({} as any);

      const art = artifactPath(dirname(artifactDir), state.id);
      const events = readEvents(art);
      const inferred = events.find(
        (e) => e.type === "done" || e.type === "error",
      );
      expect(inferred).toBeUndefined();
    },
  );

  it("does not use elapsed time to infer completion", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    state.lastStopReasonAt = Date.now() - 1_000; // legacy timestamp must not matter
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    expect(
      events.filter((e) => e.type === "done" || e.type === "error"),
    ).toHaveLength(0);
  });

  it("preserves an explicit done event without adding another completion", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");

    const { state, artifactDir } = makeState({ outputContent: "result" });

    mod.interactiveSubagentRegistry.set(state.id, state);

    const art = artifactPath(dirname(artifactDir), state.id);

    appendEvent(art, {
      ts: Date.now() - 100,
      type: "done",
      status: "done",
      exitCode: 0,
    });

    await mod.pollArtifactChanges({} as any);

    const events = readEvents(art);

    const doneEvents = events.filter((e) => e.type === "done");

    expect(doneEvents).toHaveLength(1);

    expect(state.autoDoneForTurnAt).toBeUndefined();
  });

  // Regression: the child called `cli.mjs done` (so a `done` event is already in events.ndjson),

  // but the session log contains a tool call (e.g. `write output.md` or `bash cli.mjs done 0`)

  // that tailReadSessionLog has not yet processed. On THIS poll, tailReadSessionLog appends a

  // `tool_activity` row to events.ndjson AFTER the explicit done — making `lastEvent` return the

  // tool_activity. Physical-order processing must still retain the earlier completion and never

  // add or deliver a duplicate completion.

  // This ordering was observed in production on 2026-06-15 (subagentura sessions under

  // pi-agents-5c91e6).

  it("preserves explicit done when trailing tool activity is appended in the same poll", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");

    const { state, artifactDir } = makeState({ outputContent: "result" });

    mod.interactiveSubagentRegistry.set(state.id, state);

    const art = artifactPath(dirname(artifactDir), state.id);

    // Explicit done from the child. ts SMALLER than the tool_activity ts we will produce next,

    // so the file order is: [done@SMALL, tool_activity@MEDIUM, ...] — lastEvent is the tool_activity.

    const explicitTs = Date.now() - 20_000;

    appendEvent(art, {
      ts: explicitTs,
      type: "done",
      status: "done",
      exitCode: 0,
    });

    // Session log: a `write` tool call (so tailReadSessionLog appends a tool_activity) plus an

    // assistant message carrying legacy stop metadata.

    // The tool-call timestamp is later than the explicit done but still 11s in the past relative

    // to the explicit event, proving timestamp order is not the cursor.

    const toolTs = explicitTs + 5_000; // later than the explicit done

    const assistantTs = toolTs + 100;

    writeFileSync(
      state.sessionFile,

      JSON.stringify({
        type: "message",

        message: {
          role: "assistant",

          content: [
            { type: "text", text: "result text" },

            {
              type: "toolCall",

              name: "write",

              arguments: { path: "/tmp/result.md", content: "result" },
            },
          ],

          api: "openai",

          provider: "openai",

          model: "gpt-4",

          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },

          stopReason: "stop",

          timestamp: assistantTs,
        },
      }) + "\n",
    );

    // The session tail updates legacy stop metadata, which must not affect completion.

    // Event delivery remains driven solely by events.ndjson physical order.

    // The actual age of the assistant entry is intentionally irrelevant.

    //

    const sendMessage = vi.fn();

    await mod.pollArtifactChanges({ sendMessage } as any);

    const events = readEvents(art);

    const doneEvents = events.filter((e) => e.type === "done");

    // No completion is inferred from session metadata.

    expect(doneEvents).toHaveLength(1);

    expect(doneEvents[0].ts).toBe(explicitTs);

    expect(state.autoDoneForTurnAt).toBeUndefined();

    // The sendMessage call (if any) must be for the original done only, never a second time

    // for an inferred one. We check that no legacy inferred marker was sent.

    // The original explicit event remains the only completion.

    const sendMessageCalls = sendMessage.mock.calls.filter((call) => {
      const text = JSON.stringify(call);

      return text.includes("auto-detected from session stopReason:stop");
    });

    expect(sendMessageCalls).toHaveLength(0);
  });

  it("does not infer completion across repeated polls", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);
    await mod.pollArtifactChanges({} as any);
    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(0);
  });

  it("processes an explicit completion after stopReason without a synthetic predecessor", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    const sendMessage = vi.fn();
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();

    const art = artifactPath(dirname(artifactDir), state.id);
    appendEvent(art, {
      ts: Date.now(),
      type: "done",
      status: "done",
      exitCode: 0,
    });

    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(state.pendingDeliveries).toHaveLength(1);
  });

  it("a new user message does not create legacy synthesis state", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);
    expect(state.autoDoneForTurnAt).toBeUndefined();

    const userMsg = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "thanks, also do X" }],
        timestamp: Date.now(),
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(userMsg) + "\n");

    await mod.pollArtifactChanges({} as any);
    expect(state.autoDoneForTurnAt).toBeUndefined();
  });

  it("a new user message revives exited status for a follow-up turn", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    await mod.pollArtifactChanges({} as any);
    // Simulate a terminal previous turn. The user has now sent a follow-up;
    // we want to verify the user-role revival clears "exited" too.
    state.status = "exited";

    const userMsg = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "thanks, also do X" }],
        timestamp: Date.now(),
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(userMsg) + "\n");

    await mod.pollArtifactChanges({} as any);
    // Status revived so child lifecycle events for the next turn are observed.
    expect(state.status).toBe("running");
  });

  it("a new user message in the session log revives status from 'idle' to 'running' (follow-up case)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({ outputContent: "result" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    // Simulate the post-turn state that follow-up work produces: the child called `cli.mjs done`
    // (so a `done` event is in the artifact and the poller would naturally transition to "idle" via
    // deriveInteractiveSubagentStatus), and the parent has just sent a follow-up keystroke into
    // the REPL. The user-role entry in the session log must revive status so the next
    // child completion event arrives for the new turn.
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    state.status = "idle";
    await mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("idle");

    const userMsg = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "follow-up after turn 1" }],
        timestamp: Date.now(),
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(userMsg) + "\n");

    await mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("running");
  });

  it("captures stopReason and lastStopText from real session JSONL tail-read", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    state.lastStopReason = undefined;
    state.lastStopReasonAt = undefined;
    state.lastStopText = undefined;

    const ts = Date.now() - 11_000;
    writeAssistantTurn(
      state.sessionFile,
      ts,
      "stop",
      "Done. Wrote the result.",
    );

    await mod.pollArtifactChanges({} as any);

    expect(state.lastStopReason).toBe("stop");
    expect(state.lastStopReasonAt).toBe(ts);
    expect(state.lastStopText).toBe("Done. Wrote the result.");
  });

  it("does NOT capture lastStopText for non-'stop' stopReasons", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    state.lastStopReason = undefined;
    state.lastStopText = undefined;

    const ts = Date.now() - 11_000;
    writeAssistantTurn(
      state.sessionFile,
      ts,
      "length",
      "I hit the token limit.",
    );

    await mod.pollArtifactChanges({} as any);

    expect(state.lastStopReason).toBe("length");
    expect(state.lastStopText).toBeUndefined();
  });

  it("a user message in the session log clears the per-turn stop-capture (lastStopReason, lastStopReasonAt, lastStopText)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    // Simulate a prior turn that captured stop-capture state.
    state.lastStopReason = "stop";
    state.lastStopReasonAt = Date.now() - 60_000;
    state.lastStopText = "STALE_TEXT_FROM_PRIOR_TURN";

    // A user follow-up arrives.
    const userTs = Date.now() - 30_000;
    writeFileSync(
      state.sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "do more" }],
          timestamp: userTs,
        },
      }) + "\n",
      { flag: "a" },
    );

    await mod.pollArtifactChanges({} as any);

    // All three per-turn fields must be cleared, matching the reset of
    // autoDoneForTurnAt on the same code path.
    const after = mod.interactiveSubagentRegistry.get(state.id) as typeof state;
    expect(after.lastStopReason).toBeUndefined();
    expect(after.lastStopReasonAt).toBeUndefined();
    expect(after.lastStopText).toBeUndefined();
  });

  it("does not convert long assistant text into a synthetic error", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const longText = "X".repeat(1000); // >500 char slice threshold
    const ts = Date.now() - 11_000;
    writeAssistantTurn(state.sessionFile, ts, "stop", longText);

    await mod.pollArtifactChanges({} as any);

    const events = readEvents(
      artifactPath(dirname(state.artifactDir), state.id),
    );
    expect(events).toEqual([]);
  });

  it("does not convert short assistant text into a synthetic error", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const shortText = "short text that fits in the slice"; // well under 500
    const ts = Date.now() - 11_000;
    writeAssistantTurn(state.sessionFile, ts, "stop", shortText);

    await mod.pollArtifactChanges({} as any);

    const events = readEvents(
      artifactPath(dirname(state.artifactDir), state.id),
    );
    expect(events).toEqual([]);
  });

  it("legacy stop metadata does not mutate injected state in inject mode", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({ outputContent: "final result" });
    state.notifyOnComplete = "inject";
    mod.interactiveSubagentRegistry.set(state.id, state);

    const ts = Date.now() - 11_000;
    writeAssistantTurn(state.sessionFile, ts, "stop", "Done.");

    await mod.pollArtifactChanges({} as any);

    // Legacy state remains untouched; protocol-v2 delivery receipts own deduplication.
    const after = mod.interactiveSubagentRegistry.get(state.id) as typeof state;
    expect(after.injected).not.toBe(true);
  });

  it("does not mutate legacy injected state in notify mode", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({ outputContent: "final result" });
    state.notifyOnComplete = "notify";
    mod.interactiveSubagentRegistry.set(state.id, state);

    const ts = Date.now() - 11_000;
    writeAssistantTurn(state.sessionFile, ts, "stop", "Done.");

    await mod.pollArtifactChanges({} as any);

    // Legacy state remains untouched in notify mode too.
    const after = mod.interactiveSubagentRegistry.get(state.id) as typeof state;
    expect(after.injected).toBeUndefined();
  });

  // ─── End-to-end: real session JSONL is the only input ────────────
  // Mirrors the production failure mode seen in 4 silent sub-agents in
  // ~/.pi/agent/sessions/subagentura. The only input to the poller is a
  // session JSONL containing a final assistant turn with stopReason:"stop"
  // — no pre-seeded state, no events.ndjson activity, no `cli.mjs done`.
  // Even after an arbitrary delay, no parent-side completion may be inferred.

  it("end-to-end: session stop plus output is not authoritative without child completion", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeFreshState({
      outputContent: "the review findings",
    });
    mod.interactiveSubagentRegistry.set(state.id, state);

    const stopTs = Date.now() - 11_000;
    writeFileSync(
      state.sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Review complete." }],
          api: "openai",
          provider: "openai",
          model: "gpt-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: stopTs,
        },
      }) + "\n",
    );

    const sendMessage = vi.fn();
    await mod.pollArtifactChanges({ sendMessage } as any);

    expect(state.lastStopReason).toBe("stop");
    expect(state.lastStopReasonAt).toBe(stopTs);
    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    expect(events).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("end-to-end: session stop without output is not converted into an error", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeFreshState({ outputContent: null });
    mod.interactiveSubagentRegistry.set(state.id, state);

    const stopTs = Date.now() - 11_000;
    const summary =
      "Review complete. The findings file `/tmp/review-sec.md` contains 0 critical vulnerabilities.";
    writeFileSync(
      state.sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: summary }],
          api: "openai",
          provider: "openai",
          model: "gpt-4",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: stopTs,
        },
      }) + "\n",
    );

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(dirname(artifactDir), state.id);
    const events = readEvents(art);
    expect(events).toEqual([]);
  });

  // ─── Regression guard: replay the real `notdone.jsonl` session ────
  // The model produced a 10K-char audit at t=183s, then sat in the REPL for
  // 4.5 minutes until the parent prompted it with "u didnt make the done".
  // Protocol v2 deliberately does not infer completion from this session log.
  // Skips if the production session is not present (e.g. CI).
  //
  // SAFETY: the production session JSONL is read-only input; the replay
  // runs against a tmp artifactDir. The production dir is never written to.
  it("regression: notdone.jsonl does not create a parent-inferred completion", async () => {
    const fs = await import("node:fs");
    const sourceSession = process.env.PI_SUBAGENTURA_NOTDONE_JSONL;
    if (!sourceSession || !fs.existsSync(sourceSession)) {
      console.warn(
        "skip: set PI_SUBAGENTURA_NOTDONE_JSONL to replay a real notdone session",
      );
      return;
    }

    const lines = fs
      .readFileSync(sourceSession, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    let firstStop: { timestamp: number } | null = null;
    let firstStopText = "";
    for (const e of lines) {
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || m.role !== "assistant" || m.stopReason !== "stop") continue;
      firstStop = m;
      for (const b of m.content || []) {
        if (b.type === "text" && typeof b.text === "string") {
          firstStopText = b.text;
          break;
        }
      }
      break;
    }
    expect(firstStop).not.toBeNull();
    // Non-null assertion: expect().not.toBeNull() narrows at runtime but not in tsc's strict null checks.
    const firstStopNonNull = firstStop as { timestamp: number };
    expect(firstStop).not.toBeNull();
    expect(firstStopText.length).toBeGreaterThan(5000);

    // Replay into a tmp dir, NOT the production artifact dir. The
    // poller computes the artifact via
    //   artifactPath(dirname(state.artifactDir), basename(state.artifactDir))
    // so point state.artifactDir at a fresh tmp leaf and let
    // ensureArtifactDir() create it on first appendEvent.
    const replayRoot = makeTmp();
    const replayId = "notdone-replay";
    const replayArtifactDir = join(replayRoot, replayId);
    const replaySession = join(replayRoot, "session.jsonl");
    fs.writeFileSync(
      replaySession,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: firstStopText }],
          stopReason: "stop",
          timestamp: firstStopNonNull.timestamp,
        },
      }) + "\n",
    );

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    mod.interactiveSubagentRegistry.set(replayId, {
      id: replayId,
      name: "notdone.jsonl Replay",
      task: "(replay)",
      paneId: "%1",
      sessionFile: replaySession,
      cwd: "/tmp",
      startedAt: firstStopNonNull.timestamp - 60_000,
      status: "running",
      mux: "tmux",
      attachCommand: "n/a",
      selectPaneCommand: "n/a",
      launchScriptFile: "n/a",
      artifactDir: replayArtifactDir,
    });

    await mod.pollArtifactChanges({} as any);

    // Session text alone must not create a completion event.
    const eventsFile = join(replayArtifactDir, "events.ndjson");
    const events = fs.existsSync(eventsFile)
      ? fs
          .readFileSync(eventsFile, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    expect(
      events.filter((event) =>
        ["completion", "done", "error", "cancelled"].includes(event.type),
      ),
    ).toEqual([]);

    // Defensive: if the caller provided the original artifact dir, confirm we
    // did NOT touch it. If events.ndjson exists there, its mtime must predate
    // this test run.
    const productionArtifactDir =
      process.env.PI_SUBAGENTURA_NOTDONE_ARTIFACT_DIR;
    if (productionArtifactDir) {
      const productionEvents = join(productionArtifactDir, "events.ndjson");
      if (fs.existsSync(productionEvents)) {
        const stat = fs.statSync(productionEvents);
        expect(stat.mtimeMs).toBeLessThan(Date.now() - 1000);
      }
    }
  });
});
