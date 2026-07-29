/**
 * Tests for the session-log tail-read that synthesizes `tool_activity` events.
 *
 * The interactive sub-agent poller in the parent process tail-reads the child's
 * session JSONL (which the child pi runtime writes automatically) and appends a
 * `tool_activity` event to `events.ndjson` for each toolCall block in the log.
 * This means sub-agents don't need to call any helper to be observable.

 *
 * Strategy: write a fake session JSONL to a temp file, point a registry state
 * at it, then call `pollArtifactChanges` and assert the appended events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, artifactPath, readEvents } from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-session-log-"));
}

function makeState(overrides: { sessionFile?: string }): {
  id: string;
  artifactDir: string;
  state: InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const root = makeTmp();
  const artifactDir = join(root, id);
  mkdirSync(artifactDir, { recursive: true });
  const state: InteractiveSubagentState = {
    id,
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: overrides.sessionFile ?? join(artifactDir, "session.jsonl"),
    cwd: "/tmp",
    startedAt: Date.now(),
    status: "running",
    mux: "tmux",
    attachCommand: "tmux attach -t sess",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir,
  };
  return { id, artifactDir, state };
}

describe("session-log tail-read", () => {
  let root: string;

  beforeEach(() => {
    root = makeTmp();
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    // The poller uses the asynchronous observePane contract. Return the pane
    // id exactly as tmux does so the synthetic %99 pane is observed alive.
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "%99", ""),
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("appends a tool_activity event for a bash tool call", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    // Write a fake session log with one assistant message containing a toolCall.
    const sessionFile = state.sessionFile;
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll search the codebase." },
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "rg TODO src/" },
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1700000000000,
      },
    };
    writeFileSync(sessionFile, JSON.stringify(entry) + "\n");

    const sendMessage = vi.fn();
    await mod.pollArtifactChanges({ sendMessage } as any);

    // Should not have notified the LLM (tool_activity is silent).
    expect(sendMessage).not.toHaveBeenCalled();

    // Should have appended a tool_activity event to events.ndjson.
    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.type).toBe("tool_activity");
    if (event.type === "tool_activity") {
      expect(event.tool).toBe("bash");
      expect(event.summary).toBe("rg TODO src/");
    }
    expect(event.status).toBe("running");
    // Cursor advanced.
    expect(state.lastDeliveredSessionByte).toBeGreaterThan(0);
  });

  it("appends tool_activity for write, edit, read with file paths", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "write",
            arguments: { path: "/tmp/review-1.md", content: "..." },
          },
          {
            type: "toolCall",
            id: "t2",
            name: "edit",
            arguments: { path: "/src/foo.ts", oldText: "a", newText: "b" },
          },
          {
            type: "toolCall",
            id: "t3",
            name: "read",
            arguments: { path: "/src/bar.ts" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    const tools = events.filter((e) => e.type === "tool_activity");
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({
      tool: "write",
      summary: "/tmp/review-1.md",
    });
    expect(tools[1]).toMatchObject({ tool: "edit", summary: "/src/foo.ts" });
    expect(tools[2]).toMatchObject({ tool: "read", summary: "/src/bar.ts" });
  });

  it("skips tools with no summary (grep, find, ls, custom)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "grep",
            arguments: { pattern: "TODO", path: "/src" },
          },
          {
            type: "toolCall",
            id: "t2",
            name: "find",
            arguments: { pattern: "*.ts" },
          },
          {
            type: "toolCall",
            id: "t3",
            name: "ls",
            arguments: { path: "/src" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    expect(events.filter((e) => e.type === "tool_activity")).toHaveLength(0);
  });

  it("truncates long bash commands to 80 chars", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const longCmd = "echo " + "x".repeat(200);
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: longCmd },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    const activity = events.find((e) => e.type === "tool_activity");
    expect(activity?.summary).toBeDefined();
    expect(activity!.summary!.length).toBeLessThanOrEqual(80);
    expect(activity!.summary!.endsWith("…")).toBe(true);
  });

  it("cursor advances — second poll with no new lines does not duplicate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    await mod.pollArtifactChanges({} as any);
    const after1 = state.lastDeliveredSessionByte;
    expect(after1).toBeGreaterThan(0);

    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(after1); // unchanged

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    expect(events.filter((e) => e.type === "tool_activity")).toHaveLength(1);
  });

  it("picks up new lines written between polls", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const e1 = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "echo 1" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    const e2 = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t2",
            name: "write",
            arguments: { path: "/tmp/foo.md" },
          },
        ],
        timestamp: 1700000001000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(e1) + "\n");

    await mod.pollArtifactChanges({} as any);

    // Append second line.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(state.sessionFile, JSON.stringify(e2) + "\n");

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    const activity = events.filter((e) => e.type === "tool_activity");
    expect(activity).toHaveLength(2);
    expect(activity[0].tool).toBe("bash");
    expect(activity[1].tool).toBe("write");
  });

  it("tolerates a partial trailing line without crashing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "echo hi" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    // Write a complete line + a truncated second line.
    const complete = JSON.stringify(entry) + "\n";
    const partial = '{ "type": "mess';
    writeFileSync(state.sessionFile, complete + partial);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    // Only the complete line was processed.

    expect(events.filter((e) => e.type === "tool_activity")).toHaveLength(1);
    // The observed cursor advances, while the replay point remains at the
    // complete line boundary.
    expect(state.lastDeliveredSessionByte).toBe(
      Buffer.byteLength(complete + partial, "utf8"),
    );
    expect(state.sessionPartialLineStart).toBe(
      Buffer.byteLength(complete, "utf8"),
    );
  });

  it("completes a buffered partial line on a later poll", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "write",
            arguments: { path: "/tmp/x" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    const complete = JSON.stringify(entry) + "\n";
    const partial = '{ "type": "mess';
    writeFileSync(state.sessionFile, complete + partial);
    // First poll: record both the observed end and the safe replay boundary.
    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(
      Buffer.byteLength(complete + partial, "utf8"),
    );
    expect(state.sessionPartialLineStart).toBe(
      Buffer.byteLength(complete, "utf8"),
    );

    // Second poll: child finishes writing the partial. We need to APPEND to
    // the file (not rewrite) so the byte offset after the partial is
    // unchanged.
    const appended =
      'age","message":{"role":"assistant","content":[{"type":"toolCall","id":"t2","name":"bash","arguments":{"command":"ls"}}]}}\n';
    appendFileSync(state.sessionFile, appended);

    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(
      Buffer.byteLength(complete + partial, "utf8") +
        Buffer.byteLength(appended, "utf8"),
    );
    expect(state.sessionPartialLineStart).toBeUndefined();
    const art = artifactPath(join(artifactDir, ".."), state.id);
    const events = readEvents(art);
    // Now BOTH tool_activity events should be present.
    expect(events.filter((e) => e.type === "tool_activity")).toHaveLength(2);
  });

  it("does nothing when the session file does not exist yet", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({
      sessionFile: "/tmp/does-not-exist-" + Math.random() + ".jsonl",
    });
    mod.interactiveSubagentRegistry.set(state.id, state);

    await expect(mod.pollArtifactChanges({} as any)).resolves.toBeUndefined();
    expect(state.lastDeliveredSessionByte).toBeUndefined();
  });

  it("updates state.lastToolSummary and lastActivityAt for the widget", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "rg TODO src/" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    await mod.pollArtifactChanges({} as any);

    expect(state.lastToolName).toBe("bash");
    expect(state.lastToolSummary).toBe("rg TODO src/");
    expect(state.lastActivityAt).toBe(1700000000000);
  });

  it("paints the TUI widget when ui ref is set", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "rg TODO src/" },
          },
        ],
        timestamp: Date.now(),
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");

    const setStatus = vi.fn();
    const setWidget = vi.fn();
    (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

    await mod.pollArtifactChanges({} as any);

    // Footer status shows count.
    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
    // Widget shows the activity row. Workflow widget is also cleared in the same poll.
    const activityWidgetCall = setWidget.mock.calls.find(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityWidgetCall).toBeDefined();
    const [, lines, opts] = activityWidgetCall!;
    expect(opts).toEqual({ placement: "belowEditor" });
    expect(lines[0]).toContain("Test:");
    expect(lines[0]).toContain("rg TODO src/");
  });

  it("clears the widget and footer when no sub-agents are active", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Empty registry.
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

    await mod.pollArtifactChanges({} as any);

    expect(setStatus).toHaveBeenCalledWith("subagentura-running", undefined);
    expect(setWidget).toHaveBeenCalledWith("subagentura-activity", undefined, {
      placement: "belowEditor",
    });
  });

  it("inlines the error message in the LLM notification but uses pointers on success", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});

    mod.interactiveSubagentRegistry.set(state.id, state);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });
    appendEvent(art, {
      ts: 2,
      type: "error",
      status: "error",
      message: "bash exited with code 1: rg foo missing",
    });

    const sendMessage = vi.fn();
    const notify = vi.fn();
    (globalThis as any).__piSubagenturaUi = {
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    await mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was injected into the parent LLM",
      ),
      "error",
    );
    const content = sendMessage.mock.calls[0][0].content as string;

    // done: pointer only, no body.
    expect(content).toContain("done");
    expect(content).toContain("Output:");
    expect(content).toContain("Activity log:");

    // error: inline message + pointers.
    expect(content).toContain("error");
    expect(content).toContain("bash exited with code 1");
  });

  it("truncates the inline error message to 500 chars", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});

    mod.interactiveSubagentRegistry.set(state.id, state);

    const longMsg = "x".repeat(2000);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: longMsg,
    });

    const sendMessage = vi.fn();
    const notify = vi.fn();
    (globalThis as any).__piSubagenturaUi = {
      notify,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    await mod.pollArtifactChanges({ sendMessage } as any);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was injected into the parent LLM",
      ),
      "error",
    );
    const content = sendMessage.mock.calls[0][0].content as string;
    // The "x".repeat(2000) portion must be capped.
    const match = content.match(/x+/);
    expect(match).not.toBeNull();
    expect(match![0].length).toBeLessThanOrEqual(500);
    expect(match![0].length).toBeLessThanOrEqual(500);
  });

  it("resets the cursor when the session log is truncated below it", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);
    // write 1KB of content, poll to advance cursor
    writeFileSync(state.sessionFile, "x".repeat(1024) + "\n");
    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(1025);
    // truncate to 0, then write new content
    writeFileSync(state.sessionFile, "new\n");
    await mod.pollArtifactChanges({} as any);
    // cursor should have been reset, so it now points past the new content
    expect(state.lastDeliveredSessionByte).toBe(4);
  });
  it("resets the cursor when the session log is truncated below it", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);
    // write 1KB of content, poll to advance cursor
    writeFileSync(state.sessionFile, "x".repeat(1024) + "\n");
    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(1025);
    // truncate to 0, then write new content
    writeFileSync(state.sessionFile, "new\n");
    await mod.pollArtifactChanges({} as any);
    // cursor should have been reset, so it now points past the new content
    expect(state.lastDeliveredSessionByte).toBe(4);
  });
  // ── Bounded streaming parser regression coverage ─────────────────────────
  // A runtime read cursor allows multi-tick lines while the persisted cursor
  // remains at the last complete boundary for safe replay after reload.

  it("processes a single JSONL line larger than 1 MiB (the original cap)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    // Build a single 1.5 MiB JSONL line. The old 1 MiB cap would have pinned the poller on this line forever.
    const bigPayload = "x".repeat(1.5 * 1024 * 1024);
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-big",
            name: "bash",
            arguments: { command: "echo BIG" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    // Splice the big payload into the JSONL line as a string field so the line itself is huge.
    // We keep the toolCall so we can assert on the emitted event after the ndjson parser swallows it.
    const line = JSON.stringify({ ...entry, _big: bigPayload });
    writeFileSync(state.sessionFile, line + "\n");

    // The observed cursor advances, while the replay point remains at the start
    // of the incomplete line.
    await mod.pollArtifactChanges({} as any);
    const afterFirst = state.lastDeliveredSessionByte ?? 0;
    expect(afterFirst).toBe(1 * 1024 * 1024);
    expect(state.sessionPartialLineStart).toBe(0);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    // The complete line has not arrived yet, so no events should be emitted.
    expect(
      readEvents(art).filter((e) => e.type === "tool_activity"),
    ).toHaveLength(0);

    // The second poll resumes from the observed cursor and emits the completed
    // line without re-reading the buffered prefix.
    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBeGreaterThan(afterFirst);
    const activityAfterSecond = readEvents(art).filter(
      (e) => e.type === "tool_activity",
    );
    expect(activityAfterSecond).toHaveLength(1);
    expect(activityAfterSecond[0]).toMatchObject({
      tool: "bash",
      summary: "echo BIG",
    });

    // Append a small next line and poll to confirm the parser keeps processing after the big one.
    const nextEntry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-next",
            name: "read",
            arguments: { path: "/tmp/x" },
          },
        ],
        timestamp: 1700000001000,
      },
    };
    appendFileSync(state.sessionFile, JSON.stringify(nextEntry) + "\n");
    await mod.pollArtifactChanges({} as any);
    const activity = readEvents(art).filter((e) => e.type === "tool_activity");
    expect(activity).toHaveLength(2);
    expect(activity[1]).toMatchObject({ tool: "read", summary: "/tmp/x" });
  });

  it("replays a partial line from its durable cursor after reload", async () => {
    const first =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-reload",
            name: "bash",
            arguments: { command: "echo after reload" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    const line = JSON.stringify(entry);
    const splitAt = Math.floor(line.length / 2);
    state.lastDeliveredSessionByte = 0;
    first.interactiveSubagentRegistry.set(state.id, state);
    writeFileSync(state.sessionFile, line.slice(0, splitAt));

    await first.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(splitAt);
    expect(state.sessionPartialLineStart).toBe(0);

    first.interactiveSubagentRegistry.clear();
    const second =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const rehydrated = {
      ...state,
      lastDeliveredSessionByte: state.sessionPartialLineStart,
      sessionObservedByteCursor: state.lastDeliveredSessionByte,
    };
    second.interactiveSubagentRegistry.set(rehydrated.id, rehydrated);
    appendFileSync(state.sessionFile, line.slice(splitAt) + "\n");

    await second.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    expect(
      readEvents(art).filter((event) => event.type === "tool_activity"),
    ).toMatchObject([{ tool: "bash", summary: "echo after reload" }]);
  });

  it("rewinds a buffered partial line when parsers are cleared", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { clearSessionParsers } = await import("../src/artifact-poller");
    const { state, artifactDir } = makeState({});
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-cleared",
            name: "bash",
            arguments: { command: "echo after clear" },
          },
        ],
      },
    };
    const line = JSON.stringify(entry);
    const splitAt = Math.floor(line.length / 2);
    mod.interactiveSubagentRegistry.set(state.id, state);
    writeFileSync(state.sessionFile, line.slice(0, splitAt));
    await mod.pollArtifactChanges({} as any);
    expect(state.lastDeliveredSessionByte).toBe(splitAt);

    clearSessionParsers();
    expect(state.lastDeliveredSessionByte).toBe(0);
    expect(state.sessionObservedByteCursor).toBe(splitAt);
    appendFileSync(state.sessionFile, line.slice(splitAt) + "\n");
    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    expect(
      readEvents(art).filter((event) => event.type === "tool_activity"),
    ).toMatchObject([{ tool: "bash", summary: "echo after clear" }]);
  });

  it("detects reload-time truncation against the persisted observed cursor", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-truncated",
            name: "read",
            arguments: { path: "/tmp/replaced-session" },
          },
        ],
      },
    };
    const line = JSON.stringify(entry) + "\n";
    state.lastDeliveredSessionByte = 10;
    state.sessionPartialLineStart = 10;
    state.sessionObservedByteCursor = Buffer.byteLength(line, "utf8") + 10;
    mod.interactiveSubagentRegistry.set(state.id, state);
    writeFileSync(state.sessionFile, line);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    expect(
      readEvents(art).filter((event) => event.type === "tool_activity"),
    ).toMatchObject([{ tool: "read", summary: "/tmp/replaced-session" }]);
  });

  it("replaces parser state when a rehydrated object reuses an id", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);
    writeFileSync(state.sessionFile, '{ "type": "mess');
    await mod.pollArtifactChanges({} as any);

    const replacement: InteractiveSubagentState = {
      ...state,
      lastDeliveredSessionByte: 0,
      sessionPartialLineStart: undefined,
    };
    const entry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-reused",
            name: "bash",
            arguments: { command: "echo reused" },
          },
        ],
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(entry) + "\n");
    mod.interactiveSubagentRegistry.set(state.id, replacement);

    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    expect(
      readEvents(art).filter((event) => event.type === "tool_activity"),
    ).toMatchObject([{ tool: "bash", summary: "echo reused" }]);
  });

  it("drops an oversized line and resumes at the next record", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);
    const oversized = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-oversized",
            name: "bash",
            arguments: { command: "echo should be dropped" },
          },
        ],
      },
      payload: "x".repeat(3 * 1024 * 1024),
    };
    writeFileSync(state.sessionFile, JSON.stringify(oversized) + "\n");

    for (let poll = 0; poll < 4; poll++) {
      await mod.pollArtifactChanges({} as any);
    }

    const next = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t-after-overflow",
            name: "read",
            arguments: { path: "/tmp/after-overflow" },
          },
        ],
      },
    };
    appendFileSync(state.sessionFile, JSON.stringify(next) + "\n");
    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    expect(
      readEvents(art).filter((event) => event.type === "tool_activity"),
    ).toMatchObject([{ tool: "read", summary: "/tmp/after-overflow" }]);
  });

  it("resets the cursor and parser on file truncation", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");

    // Build a 1 KB initial log, write to the file, poll once.
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);
    const initialEntry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "echo before" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    writeFileSync(
      state.sessionFile,
      "x".repeat(1024) + "\n" + JSON.stringify(initialEntry) + "\n",
    );
    await mod.pollArtifactChanges({} as any);
    const cursorBeforeTruncation = state.lastDeliveredSessionByte;
    expect(cursorBeforeTruncation).toBeGreaterThan(1024);

    // Truncate the file to 0 bytes (size < cursor triggers the reset path).
    truncateSync(state.sessionFile, 0);

    // Write fresh content and poll again. The new design resets cursor to 0 and the parser, then re-reads.
    const newEntry = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t2",
            name: "write",
            arguments: { path: "/tmp/after-truncation" },
          },
        ],
        timestamp: 1700000002000,
      },
    };
    writeFileSync(state.sessionFile, JSON.stringify(newEntry) + "\n");
    await mod.pollArtifactChanges({} as any);

    // Cursor was reset to 0, then advanced to the end of the new content.
    const newSize = Buffer.byteLength(JSON.stringify(newEntry) + "\n", "utf8");
    expect(state.lastDeliveredSessionByte).toBe(newSize);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const activity = readEvents(art).filter((e) => e.type === "tool_activity");
    // The new content's tool_call must be processed. The old content might be re-emitted too (best-effort),
    // so we just assert the new one is present.
    expect(
      activity.some(
        (e) => e.tool === "write" && e.summary === "/tmp/after-truncation",
      ),
    ).toBe(true);
  });

  it("skips a malformed line and continues processing subsequent valid lines", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    mod.interactiveSubagentRegistry.set(state.id, state);

    const entry1 = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "echo first" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    const entry2 = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t2",
            name: "write",
            arguments: { path: "/tmp/after-bad" },
          },
        ],
        timestamp: 1700000001000,
      },
    };
    const malformed = "{this is not valid json";
    writeFileSync(
      state.sessionFile,
      JSON.stringify(entry1) +
        "\n" +
        malformed +
        "\n" +
        JSON.stringify(entry2) +
        "\n",
    );
    await mod.pollArtifactChanges({} as any);

    const art = artifactPath(join(artifactDir, ".."), state.id);
    const activity = readEvents(art).filter((e) => e.type === "tool_activity");
    // Both valid lines must be processed; the malformed one is silently dropped.
    expect(activity).toHaveLength(2);
    expect(activity[0]).toMatchObject({ tool: "bash", summary: "echo first" });
    expect(activity[1]).toMatchObject({
      tool: "write",
      summary: "/tmp/after-bad",
    });
  });

  it("keeps parser state per sub-agent (two parallel sub-agents see only their own events)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const a = makeState({});
    const b = makeState({});
    mod.interactiveSubagentRegistry.set(a.state.id, a.state);
    mod.interactiveSubagentRegistry.set(b.state.id, b.state);

    const entryA = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ta",
            name: "bash",
            arguments: { command: "echo A" },
          },
        ],
        timestamp: 1700000000000,
      },
    };
    const entryB = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tb",
            name: "write",
            arguments: { path: "/tmp/B" },
          },
        ],
        timestamp: 1700000001000,
      },
    };
    writeFileSync(a.state.sessionFile, JSON.stringify(entryA) + "\n");
    writeFileSync(b.state.sessionFile, JSON.stringify(entryB) + "\n");

    await mod.pollArtifactChanges({} as any);

    const artA = artifactPath(join(a.artifactDir, ".."), a.state.id);
    const artB = artifactPath(join(b.artifactDir, ".."), b.state.id);
    const eventsA = readEvents(artA).filter((e) => e.type === "tool_activity");
    const eventsB = readEvents(artB).filter((e) => e.type === "tool_activity");

    // Each sub-agent's artifact only contains its own tool_call — no cross-contamination.
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0]).toMatchObject({ tool: "bash", summary: "echo A" });
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0]).toMatchObject({ tool: "write", summary: "/tmp/B" });
  });
});
