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
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
  loadInteractiveStates,
  readEvents,
  updatePersistedTelemetrySession,
} from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";
import { createTelemetrySession } from "../src/telemetry";
import { rehydrateInteractiveSubagents } from "../src/rehydrate";
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
    // Force `isTmuxPaneAlive` to return true so the poller's status-decision does not flip our
    // sub-agent to "unknown" (which would skip it on subsequent polls). The test does not have a
    // live tmux server, and host tmux behaviour varies — some versions exit 0 for unknown panes,
    // some exit 1, and on a machine without tmux at all `execFileSync` throws. Mocking here keeps the
    // suite hermetic and matches the pattern in subagent-poll.test.ts.
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "#99"),
    }));
  });

  afterEach(() => {
    clearSessionScopes();
    vi.unstubAllGlobals();
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

  it("pairs telemetry starts and completions for every interactive turn", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const scope = registerSessionScope({
      id: 901,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      telemetry,
    });
    state.telemetryEligible = true;
    state.telemetryCorrelationId = telemetry.correlationId;
    state.telemetryInvocationSource = "interactive";
    state.telemetryCompletionPolicy = "each";
    state.telemetryAsync = true;
    state.telemetryDepth = 1;
    state.telemetryDepthBucket = "1";
    state.telemetryModel = "default";
    scope.interactiveStates.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);

    for (const [index, messages] of [
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "first result" },
      ],
      [
        { role: "user", content: "follow-up" },
        { role: "assistant", content: "working" },
        { role: "assistant", content: "follow-up result" },
      ],
    ].entries()) {
      appendFileSync(
        state.sessionFile,
        messages
          .map((message, messageIndex) =>
            JSON.stringify({
              id:
                message.role === "user"
                  ? `turn-${index}`
                  : `assistant-${index}-${messageIndex}`,
              type: "message",
              message,
            }),
          )
          .join("\n") + "\n",
      );
      appendEvent(art, {
        version: 2,
        eventId: `start-${index}`,
        turnId: `turn-${index}`,
        ts: 1_000 + index * 100,
        type: "turn_started",
        status: "running",
      });
      appendEvent(art, {
        version: 2,
        eventId: `done-${index}`,
        turnId: `turn-${index}`,
        ts: 1_050 + index * 100,
        type: "completion",
        status: "done",
        outcome: "done",
        source: "agent_settled",
      });
    }
    await mod.pollArtifactChanges({} as any, sessionOwner(scope));

    const starts = payloads.filter(
      (payload) => payload.event === "pi_subagentura_task_started",
    );
    const completions = payloads.filter(
      (payload) => payload.event === "pi_subagentura_task_completed",
    );
    expect(starts).toHaveLength(2);
    expect(completions).toHaveLength(2);
    expect(starts.map(({ properties }) => properties.unit)).toEqual([
      "turn",
      "turn",
    ]);
    expect(
      completions.map(
        ({ properties }) => properties.child_conversation_message_count,
      ),
    ).toEqual([2, 3]);
  });

  it("keeps streaming steering in one telemetry task", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const cwd = join(artifactDir, "..");
    const correlationId = "77777777-7777-4777-8777-777777777777";
    const telemetry = createTelemetrySession(
      true,
      "orchestrator_v2",
      correlationId,
    );
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const pi = {} as unknown as Parameters<typeof mod.pollArtifactChanges>[0];
    Object.assign(state, {
      cwd,
      parentSessionId: "pi",
      telemetryEligible: true,
      telemetryCorrelationId: correlationId,
      telemetryInvocationSource: "interactive",
      telemetryCompletionPolicy: "each",
      telemetryAsync: true,
      telemetryDepth: 1,
      telemetryDepthBucket: "1",
      telemetryModel: "default",
      telemetryTurnMessageCounts: new Map(),
    });
    updatePersistedTelemetrySession(cwd, "pi", {
      correlationId,
      mode: "orchestrator_v2",
    });
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      parentSessionId: "pi",
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      telemetry: {
        correlationId,
        invocationSource: "interactive",
        mux: "tmux",
        async: true,
        depth: 1,
        depthBucket: "1",
        completionPolicy: "each",
        model: "default",
      },
    });
    const scope = registerSessionScope({
      id: 904,
      generation: 1,
      lifecycle: "started",
      pi,
      telemetry,
    });
    scope.interactiveStates.set(state.id, state);
    const art = artifactPath(cwd, state.id);
    appendFileSync(
      state.sessionFile,
      [
        { id: "10", role: "user", content: "initial" },
        { id: "assistant-10", role: "assistant", content: "working" },
        { id: "2", role: "user", content: "latest initial" },
        { id: "assistant-2", role: "assistant", content: "still working" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    appendEvent(art, {
      version: 2,
      eventId: "start-initial",
      turnId: "2",
      ts: 1_000,
      type: "turn_started",
      status: "running",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(1);
    expect(state.telemetryActiveTurnId).toBe("2");
    expect(state.telemetryTurnStartedAt).toBe(1_000);
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({
      activeTurnId: "2",
      turnStartedAt: 1_000,
      messageTurnId: "2",
      messageCounts: { "10": 2, "2": 2 },
    });
    appendEvent(art, {
      version: 2,
      eventId: "start-steering",
      turnId: "3",
      ts: 1_100,
      type: "turn_started",
      status: "running",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(1);
    expect(state.telemetryActiveTurnId).toBe("3");
    expect(state.telemetryTurnStartedAt).toBe(1_000);
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({
      activeTurnId: "3",
      turnStartedAt: 1_000,
      messageTurnId: "3",
      messageCounts: { "10": 2, "3": 2 },
    });
    clearSessionScopes();
    const recoveredTelemetry = createTelemetrySession(
      true,
      "orchestrator_v2",
      correlationId,
    );
    const recoveredScope = registerSessionScope({
      id: 905,
      generation: 1,
      lifecycle: "started",
      pi,
      telemetry: recoveredTelemetry,
    });
    rehydrateInteractiveSubagents(cwd, "pi", [], recoveredScope);
    const recoveredState = recoveredScope.interactiveStates.get(state.id);
    expect(recoveredState).toBeDefined();
    if (!recoveredState) throw new Error("steering state did not rehydrate");
    expect(recoveredState.telemetryActiveTurnId).toBe("3");
    expect(recoveredState.telemetryMessageTurnId).toBe("3");
    expect(
      Object.fromEntries(recoveredState.telemetryTurnMessageCounts ?? []),
    ).toEqual({ "10": 2, "3": 2 });
    appendFileSync(
      state.sessionFile,
      [
        { id: "3", role: "user", content: "steer" },
        { id: "assistant-3", role: "assistant", content: "continued" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    await mod.pollArtifactChanges(pi, sessionOwner(recoveredScope));
    expect(recoveredState.telemetryActiveTurnId).toBe("3");
    expect(recoveredState.telemetryTurnStartedAt).toBe(1_000);
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({
      activeTurnId: "3",
      turnStartedAt: 1_000,
      messageTurnId: "3",
      messageCounts: { "10": 2, "3": 4 },
    });
    appendEvent(art, {
      version: 2,
      eventId: "done-steering",
      turnId: "3",
      ts: 1_300,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(recoveredScope));
    const starts = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_started",
    );
    const completions = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_completed",
    );
    expect(starts).toHaveLength(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]?.properties).toMatchObject({
      duration_ms: 300,
      mux: "tmux",
      child_conversation_message_count: 4,
    });
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).not.toHaveProperty("messageTurnId");
    appendFileSync(
      state.sessionFile,
      [
        { id: "4", role: "user", content: "follow up" },
        { id: "assistant-4", role: "assistant", content: "done" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    appendEvent(art, {
      version: 2,
      eventId: "start-follow-up",
      turnId: "4",
      ts: 2_000,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "done-follow-up",
      turnId: "4",
      ts: 2_050,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(recoveredScope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(2);
    const allCompletions = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_completed",
    );
    expect(allCompletions).toHaveLength(2);
    expect(allCompletions[1]?.properties).toMatchObject({
      duration_ms: 100,
      mux: "tmux",
      child_conversation_message_count: 2,
    });
  });

  it("folds event-ahead steering before users and starts a fresh task after completion", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const cwd = join(artifactDir, "..");
    const correlationId = "88888888-8888-4888-8888-888888888888";
    const telemetry = createTelemetrySession(
      true,
      "orchestrator_v2",
      correlationId,
    );
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const pi = {} as unknown as Parameters<typeof mod.pollArtifactChanges>[0];
    Object.assign(state, {
      cwd,
      parentSessionId: "pi",
      telemetryEligible: true,
      telemetryCorrelationId: correlationId,
      telemetryInvocationSource: "interactive",
      telemetryCompletionPolicy: "each",
      telemetryAsync: true,
      telemetryDepth: 1,
      telemetryDepthBucket: "1",
      telemetryModel: "default",
      telemetryTurnMessageCounts: new Map(),
    });
    updatePersistedTelemetrySession(cwd, "pi", {
      correlationId,
      mode: "orchestrator_v2",
    });
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      parentSessionId: "pi",
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      telemetry: {
        correlationId,
        invocationSource: "interactive",
        mux: "tmux",
        async: true,
        depth: 1,
        depthBucket: "1",
        completionPolicy: "each",
        model: "default",
      },
    });
    const scope = registerSessionScope({
      id: 906,
      generation: 1,
      lifecycle: "started",
      pi,
      telemetry,
    });
    scope.interactiveStates.set(state.id, state);
    const art = artifactPath(cwd, state.id);
    appendFileSync(
      state.sessionFile,
      [
        { id: "turn-old", role: "user", content: "old" },
        { id: "assistant-old", role: "assistant", content: "working" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    appendEvent(art, {
      version: 2,
      eventId: "start-old",
      turnId: "turn-old",
      ts: 1_000,
      type: "turn_started",
      status: "running",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    // Both steering starts can be observed before either user entry reaches
    // the session log. Rebinding must carry the original count through t2 and t3.
    appendEvent(art, {
      version: 2,
      eventId: "start-new",
      turnId: "turn-new",
      ts: 1_100,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "start-third",
      turnId: "turn-third",
      ts: 1_200,
      type: "turn_started",
      status: "running",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(1);
    expect(state.telemetryActiveTurnId).toBe("turn-third");
    expect(state.telemetryTurnStartedAt).toBe(1_000);
    expect(state.telemetryMessageTurnId).toBe("turn-third");
    expect(state.telemetryTurnMessageCounts).toEqual(
      new Map([["turn-third", 2]]),
    );
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({
      activeTurnId: "turn-third",
      turnStartedAt: 1_000,
      messageTurnId: "turn-third",
      messageCounts: { "turn-third": 2 },
    });

    appendFileSync(
      state.sessionFile,
      [
        { id: "turn-new", role: "user", content: "steer" },
        { id: "assistant-new", role: "assistant", content: "continued" },
        { id: "turn-third", role: "user", content: "second steer" },
        {
          id: "assistant-third",
          role: "assistant",
          content: "continued again",
        },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(state.telemetryActiveTurnId).toBe("turn-third");
    expect(state.telemetryTurnStartedAt).toBe(1_000);
    expect(state.telemetryMessageTurnId).toBe("turn-third");
    expect(state.telemetryTurnMessageCounts).toEqual(
      new Map([["turn-third", 6]]),
    );
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({
      activeTurnId: "turn-third",
      turnStartedAt: 1_000,
      messageTurnId: "turn-third",
      messageCounts: { "turn-third": 6 },
    });
    appendEvent(art, {
      version: 2,
      eventId: "done-third",
      turnId: "turn-third",
      ts: 1_300,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_completed"),
    ).toHaveLength(1);
    expect(
      payloads.find(({ event }) => event === "pi_subagentura_task_completed")
        ?.properties,
    ).toMatchObject({
      duration_ms: 300,
      mux: "tmux",
      child_conversation_message_count: 6,
    });
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).not.toHaveProperty("messageTurnId");
    appendFileSync(
      state.sessionFile,
      [
        { id: "turn-after", role: "user", content: "after" },
        { id: "assistant-after", role: "assistant", content: "done" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    appendEvent(art, {
      version: 2,
      eventId: "start-after",
      turnId: "turn-after",
      ts: 2_000,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "done-after",
      turnId: "turn-after",
      ts: 2_050,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });
    await mod.pollArtifactChanges(pi, sessionOwner(scope));
    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(2);
    const completions = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_completed",
    );
    expect(completions).toHaveLength(2);
    expect(completions[1]?.properties).toMatchObject({
      duration_ms: 100,
      mux: "tmux",
      child_conversation_message_count: 2,
    });
  });

  it("keeps a log-ahead user count when the prior turn completes", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const cwd = join(artifactDir, "..");
    const correlationId = "99999999-9999-4999-8999-999999999999";
    const telemetry = createTelemetrySession(
      true,
      "orchestrator_v2",
      correlationId,
    );
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const pi = {} as unknown as Parameters<typeof mod.pollArtifactChanges>[0];
    Object.assign(state, {
      cwd,
      parentSessionId: "pi",
      telemetryEligible: true,
      telemetryCorrelationId: correlationId,
      telemetryInvocationSource: "interactive",
      telemetryCompletionPolicy: "each",
      telemetryAsync: true,
      telemetryDepth: 1,
      telemetryDepthBucket: "1",
      telemetryModel: "default",
      telemetryActiveTurnId: "turn-one",
      telemetryTurnStartedAt: 1_000,
      telemetryMessageTurnId: "turn-two",
      telemetryTurnMessageCounts: new Map([
        ["turn-one", 2],
        ["turn-two", 0],
      ]),
    });
    updatePersistedTelemetrySession(cwd, "pi", {
      correlationId,
      mode: "orchestrator_v2",
    });
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      parentSessionId: "pi",
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      telemetry: {
        correlationId,
        invocationSource: "interactive",
        mux: "tmux",
        async: true,
        depth: 1,
        depthBucket: "1",
        completionPolicy: "each",
        model: "default",
        activeTurnId: "turn-one",
        turnStartedAt: 1_000,
        messageTurnId: "turn-two",
        messageCounts: { "turn-one": 2, "turn-two": 0 },
      },
    });
    const scope = registerSessionScope({
      id: 907,
      generation: 1,
      lifecycle: "started",
      pi,
      telemetry,
    });
    scope.interactiveStates.set(state.id, state);
    const art = artifactPath(cwd, state.id);
    appendFileSync(
      state.sessionFile,
      [
        { id: "turn-two", role: "user", content: "steer" },
        { id: "assistant-two", role: "assistant", content: "continued" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    appendEvent(art, {
      version: 2,
      eventId: "done-one",
      turnId: "turn-one",
      ts: 1_100,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });
    appendEvent(art, {
      version: 2,
      eventId: "start-two",
      turnId: "turn-two",
      ts: 1_150,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "done-two",
      turnId: "turn-two",
      ts: 1_200,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });

    await mod.pollArtifactChanges(pi, sessionOwner(scope));

    const starts = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_started",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.properties).toMatchObject({ mux: "tmux" });
    const completions = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_completed",
    );
    expect(completions).toHaveLength(2);
    expect(completions.map(({ properties }) => properties.mux)).toEqual([
      "tmux",
      "tmux",
    ]);
    expect(
      completions.map(
        ({ properties }) => properties.child_conversation_message_count,
      ),
    ).toEqual([2, 2]);
    expect(state.telemetryMessageTurnId).toBeUndefined();
    expect(state.telemetryTurnMessageCounts).toEqual(new Map());
  });

  it("preserves active-turn telemetry progress across rehydrate", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState({});
    const cwd = join(artifactDir, "..");
    const correlationId = "66666666-6666-4666-8666-666666666666";
    const telemetry = createTelemetrySession(
      true,
      "orchestrator",
      correlationId,
    );
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    Object.assign(state, {
      cwd,
      parentSessionId: "pi",
      telemetryEligible: true,
      telemetryCorrelationId: correlationId,
      telemetryInvocationSource: "interactive",
      telemetryCompletionPolicy: "each",
      telemetryAsync: true,
      telemetryDepth: 1,
      telemetryDepthBucket: "1",
      telemetryModel: "default",
      telemetryTurnMessageCounts: new Map(),
    });
    updatePersistedTelemetrySession(cwd, "pi", {
      correlationId,
      mode: "orchestrator",
    });
    appendInteractiveState(cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      parentSessionId: "pi",
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      telemetry: {
        correlationId,
        invocationSource: "interactive",
        mux: "tmux",
        async: true,
        depth: 1,
        depthBucket: "1",
        completionPolicy: "each",
        model: "default",
      },
    });
    const firstScope = registerSessionScope({
      id: 902,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      telemetry,
    });
    firstScope.interactiveStates.set(state.id, state);
    appendFileSync(
      state.sessionFile,
      [
        { id: "turn-mid", role: "user", content: "begin" },
        { id: "assistant-1", role: "assistant", content: "working" },
        { id: "assistant-2", role: "assistant", content: "still working" },
      ]
        .map(({ id, ...message }) =>
          JSON.stringify({ id, type: "message", message }),
        )
        .join("\n") + "\n",
    );
    const art = artifactPath(cwd, state.id);
    appendEvent(art, {
      version: 2,
      eventId: "start-mid",
      turnId: "turn-mid",
      ts: 1_000,
      type: "turn_started",
      status: "running",
    });

    await mod.pollArtifactChanges({} as any, sessionOwner(firstScope));
    clearSessionScopes();
    const recoveredTelemetry = createTelemetrySession(
      true,
      "orchestrator",
      correlationId,
    );
    const recoveredScope = registerSessionScope({
      id: 903,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      telemetry: recoveredTelemetry,
    });
    rehydrateInteractiveSubagents(cwd, "pi", [], recoveredScope);
    appendEvent(art, {
      version: 2,
      eventId: "done-mid",
      turnId: "turn-mid",
      ts: 1_050,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });

    await mod.pollArtifactChanges({} as any, sessionOwner(recoveredScope));

    expect(
      payloads.filter(({ event }) => event === "pi_subagentura_task_started"),
    ).toHaveLength(1);
    const completions = payloads.filter(
      ({ event }) => event === "pi_subagentura_task_completed",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]?.properties).toMatchObject({
      mux: "tmux",
      child_conversation_message_count: 3,
      duration_ms: 100,
      duration_bucket: "<1s",
    });
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
      "⚡ 1 sub-agent alive",
    );
    // Widget shows the activity row. Workflow widget is also cleared in the same poll.
    const activityWidgetCall = setWidget.mock.calls.find(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityWidgetCall).toBeDefined();
    const [, factory, opts] = activityWidgetCall!;
    expect(opts).toEqual({ placement: "belowEditor" });
    expect(factory).toEqual(expect.any(Function));
    const lines = factory(
      { terminal: { rows: 24 }, requestRender: vi.fn() },
      {},
    ).render(80);
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
