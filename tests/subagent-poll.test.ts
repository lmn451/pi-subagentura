/**
 * The artifact poller reads protocol-v2 completion events and queues durable
 * coordinator deliveries for interactive sub-agents. Tests register explicit
 * session scopes, then write v2 events directly to the artifact directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  appendEvent,
  appendCompletionEvent,
  appendInteractiveState,
  artifactPath,
  eventLogEndOffset,
  loadInteractiveStates,
  MAX_EVENT_RECORD_BYTES,
  writeOutput,
} from "../src/artifact";
import type { Multiplexer } from "../src/multiplexer";
import type { PaneLivenessDiagnostic } from "../src/multiplexer-contracts";
import { importFresh } from "./test-utils";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
  removeSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  formatActivityRow,
  responsiveFlowMinimumWidth,
} from "../src/rendering";
import { createTelemetrySession } from "../src/telemetry";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

interface SessionSettingsSandbox {
  root: string;
  cwd: string;
}

let temporarySettingsRoot: string | undefined;
let temporaryProcessCwd: string | undefined;
let temporaryAgentDir: string | undefined;
let previousAgentDir: string | undefined;
let fixtureScope: SessionScope;

function startFixtureScope(): void {
  clearSessionScopes();
  fixtureScope = createSessionScope({ sendMessage: vi.fn() } as any);
  fixtureScope.lifecycle = "started";
  fixtureScope.sessionManager = { getSessionId: () => "pi" };
  registerSessionScope(fixtureScope);
}

function pollFixture(
  mod: Pick<typeof import("../src/artifact-poller"), "pollArtifactChanges">,
  pi: ExtensionAPI,
) {
  fixtureScope.pi = pi;
  for (const state of fixtureScope.interactiveStates.values()) {
    state.sessionOwner = sessionOwner(fixtureScope);
  }
  return mod.pollArtifactChanges(pi, sessionOwner(fixtureScope));
}

function makeSessionSettingsSandbox(root = makeTmp()): SessionSettingsSandbox {
  const cwd = join(root, "project");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  temporarySettingsRoot = root;
  return { root, cwd };
}

/** Write the global (agent-dir) settings file the current test reads from. */
function writeGlobalSettings(settings: Record<string, string>): void {
  writeFileSync(
    join(temporaryAgentDir!, "settings-extensions.json"),
    JSON.stringify({ "pi-subagentura": settings }),
  );
}

function makeState(): {
  id: string;
  artifactDir: string;
  state: import("../src/interactive-tmux").InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const artifactDir = join(makeTmp(), id);
  const state: import("../src/interactive-tmux").InteractiveSubagentState = {
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

function installDeliverySpies() {
  const sendMessage = vi.fn();
  fixtureScope.pi = { sendMessage } as any;
  fixtureScope.ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  } as any;
  return sendMessage;
}

function appendTestTurnStarted(
  art: ReturnType<typeof artifactPath>,
  ts: number,
  turnId = `turn-${ts}`,
): void {
  appendEvent(art, {
    version: 2,
    eventId: `event-${turnId}-started`,
    turnId,
    ts,
    type: "turn_started",
    status: "running",
  });
}

function appendTestCompletion(
  art: ReturnType<typeof artifactPath>,
  ts: number,
  outcome: "done" | "error" | "cancelled" = "done",
  turnId = `turn-${ts}`,
): void {
  appendCompletionEvent(art, {
    turnId,
    outcome,
    source: "agent_settled",
    ...(outcome === "cancelled"
      ? { cancellationOrigin: "cancel_all" as const }
      : {}),
  });
}

function renderWidgetContent(content: unknown, width: number): string[] {
  if (typeof content !== "function") return (content as string[]) ?? [];
  const component = content(
    { terminal: { rows: 24 }, requestRender: vi.fn() },
    {},
  );
  return component.render(width);
}

function renderedWidgetRows(
  setWidget: ReturnType<typeof vi.fn>,
  key: string,
  width: number,
): string[] {
  const content = setWidget.mock.calls
    .filter(([candidate]) => candidate === key)
    .at(-1)?.[1];
  return renderWidgetContent(content, width);
}

describe("pollArtifactChanges", () => {
  beforeEach(() => {
    (globalThis as any).__piSubagenturaWorkflowJobs?.clear?.();
    startFixtureScope();
    temporarySettingsRoot = undefined;
    temporaryProcessCwd = makeTmp();
    vi.spyOn(process, "cwd").mockReturnValue(temporaryProcessCwd);
    temporaryAgentDir = makeTmp();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
  });

  afterEach(() => {
    clearSessionScopes();
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
    vi.doUnmock("node:child_process");
    vi.useRealTimers();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    vi.restoreAllMocks();
    if (temporarySettingsRoot !== undefined) {
      rmSync(temporarySettingsRoot, { recursive: true, force: true });
    }
    if (temporaryProcessCwd !== undefined) {
      rmSync(temporaryProcessCwd, { recursive: true, force: true });
    }
    if (temporaryAgentDir !== undefined) {
      rmSync(temporaryAgentDir, { recursive: true, force: true });
    }
  });

  async function pollUntilOwnerInvalidation(
    invalidate: (owner: { id: number; generation: number }) => void,
  ) {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.parentSessionId = "session-a";
    item.state.cwd = join(item.artifactDir, "..");
    const art = artifactPath(item.state.cwd, item.id);
    appendEvent(art, {
      version: 2,
      eventId: `tool-activity-${item.id}`,
      turnId: `turn-${item.id}`,
      ts: 1,
      type: "tool_activity",
      phase: "start",
      status: "running",
      tool: "bash",
      summary: "bash",
    });
    appendCompletionEvent(art, {
      turnId: `turn-${item.id}`,
      outcome: "done",
      source: "agent_settled",
    });
    appendInteractiveState(item.state.cwd, {
      id: item.id,
      paneId: item.state.paneId,
      mux: item.state.mux,
      artifactDir: item.state.artifactDir,
      sessionFile: item.state.sessionFile,
      eventByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
    });
    const persistedBefore = loadInteractiveStates(item.state.cwd)?.states[
      item.id
    ];
    const owner = { id: 701, generation: 1 };
    const sendMessage = vi.fn();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const scope = registerSessionScope({
      ...owner,
      pi: { sendMessage } as any,
      ui: { notify: vi.fn(), setStatus, setWidget } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    scope.interactiveStates.set(item.id, item.state);
    let releaseLiveness!: () => void;
    let livenessStarted = false;
    const blockedLiveness = new Promise<void>((resolve) => {
      releaseLiveness = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => {
        livenessStarted = true;
        await blockedLiveness;
        return "alive";
      },
    } as any);

    const polling = mod.pollArtifactChanges({} as any, owner);
    await Promise.resolve();
    expect(livenessStarted).toBe(true);
    invalidate(owner);
    releaseLiveness();
    await polling;

    return {
      state: item.state,
      persistedBefore,
      sendMessage,
      setStatus,
      setWidget,
    };
  }

  it("does nothing when registry is empty", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const sendMessage = installDeliverySpies();
    await pollFixture(mod, { sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "cancel_all",
      origin: "cancel_all",
      expected: "explicit_cancel",
    },
    {
      label: "new",
      origin: "session_shutdown",
      lifecycleReason: "new",
      expected: "fresh_session",
    },
    {
      label: "fork",
      origin: "session_shutdown",
      lifecycleReason: "fork",
      expected: "fresh_session",
    },
    {
      label: "startup",
      origin: "session_start",
      lifecycleReason: "startup",
      expected: "session_shutdown",
    },
    {
      label: "reload",
      origin: "session_start",
      lifecycleReason: "reload",
      expected: "session_shutdown",
    },
    {
      label: "resume",
      origin: "session_start",
      lifecycleReason: "resume",
      expected: "session_shutdown",
    },
  ] as const)("maps $label cancellation to $expected", async (testCase) => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    const session = createTelemetrySession(true, "orchestrator_v2");
    const owner = { id: 811, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      pi: {} as unknown as ExtensionAPI,
      telemetry: session,
      sessionManager: { getSessionId: () => "poll-telemetry" },
    });
    item.state.telemetryEligible = true;
    item.state.telemetryCorrelationId = session.correlationId;
    item.state.telemetryActiveTurnId = "turn";
    item.state.telemetryTurnStartedAt = 1;
    item.state.telemetryTurnMessageCounts = new Map();
    item.state.telemetryInvocationSource = "interactive";
    item.state.telemetryCompletionPolicy = "each";
    item.state.telemetryAsync = true;
    item.state.telemetryDepth = 1;
    item.state.telemetryDepthBucket = "1";
    item.state.telemetryModel = "default";
    item.state.completionOwner = "workflow";
    scope.interactiveStates.set(item.id, item.state);
    const art = artifactPath(join(item.artifactDir, ".."), item.id);
    appendEvent(art, {
      version: 2,
      eventId: `event-${testCase.label}`,
      turnId: "turn",
      ts: 2,
      type: "completion",
      status: "cancelled",
      outcome: "cancelled",
      source: "parent",
      cancellationOrigin: testCase.origin,
      ...(testCase.lifecycleReason
        ? { cancellationLifecycleReason: testCase.lifecycleReason }
        : {}),
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive" as const,
    } as unknown as Multiplexer);
    const payloads: Array<{
      event?: string;
      properties?: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });

    await mod.pollArtifactChanges({} as unknown as ExtensionAPI, owner);

    const completed = payloads.find(
      (payload) => payload.event === "pi_subagentura_task_completed",
    );
    expect(completed?.properties?.terminal_reason).toBe(testCase.expected);
  });

  it("clears the activity widget on an empty tick with a malformed setting", async () => {
    writeGlobalSettings({ "hide-agent-list": "invalid" });

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const setWidget = vi.fn();
    const owner = { id: 700, generation: 1 };
    const pi = { getFlag: () => false } as any;
    registerSessionScope({
      ...owner,
      pi,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget,
      } as any,
    });

    await mod.pollArtifactChanges(pi, owner);

    expect(setWidget).toHaveBeenCalledWith("subagentura-activity", undefined, {
      placement: "belowEditor",
    });
  });

  it("keeps painting rows when a persisted setting is malformed", async () => {
    // A bad persisted value used to throw inside the tick, where the outer
    // catch swallowed it and froze the footer + widgets for the session.
    writeGlobalSettings({
      "hide-agent-list": "invalid",
      "max-depth": "not-a-number",
    });

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.name = "resilient-agent";
    item.state.parentSessionId = "session-malformed";
    item.state.cwd = join(item.artifactDir, "..");
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const pi = {
      sendMessage: vi.fn(),
      getFlag: () => undefined,
    } as unknown as ExtensionAPI;
    const scope = registerSessionScope({
      id: 506,
      generation: 1,
      pi,
      ui: {
        notify: vi.fn(),
        setStatus,
        setWidget,
      } as unknown as ExtensionUIContext,
      cwd: item.state.cwd,
      sessionManager: {
        getSessionId: () => "session-malformed",
        getEntries: () => [],
      },
    });
    scope.interactiveStates.set(item.id, item.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive" as const,
    } as unknown as Multiplexer);

    await mod.pollArtifactChanges(pi, {
      id: scope.id,
      generation: scope.generation,
    });

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · 1 working",
    );
    expect(
      renderedWidgetRows(setWidget, "subagentura-activity", 80).join("\n"),
    ).toContain("resilient-agent");
  });

  it("reads hide-agent-list globally when the scope has no cwd", async () => {
    // A cwd-less scope must not silently resolve against Node's process cwd.
    mkdirSync(join(temporaryProcessCwd!, ".pi"), { recursive: true });
    writeFileSync(
      join(temporaryProcessCwd!, ".pi", "settings-extensions.json"),
      JSON.stringify({
        "pi-subagentura": { "hide-agent-list": "true" },
      }),
    );

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.name = "ambient-agent";
    item.state.parentSessionId = "session-no-cwd";
    item.state.cwd = join(item.artifactDir, "..");
    const setWidget = vi.fn();
    const pi = {
      sendMessage: vi.fn(),
      getFlag: () => undefined,
    } as unknown as ExtensionAPI;
    const scope = registerSessionScope({
      id: 507,
      generation: 1,
      pi,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget,
      } as unknown as ExtensionUIContext,
      sessionManager: {
        getSessionId: () => "session-no-cwd",
        getEntries: () => [],
      },
    });
    expect(scope.cwd).toBeUndefined();
    scope.interactiveStates.set(item.id, item.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive" as const,
    } as unknown as Multiplexer);

    await mod.pollArtifactChanges(pi, {
      id: scope.id,
      generation: scope.generation,
    });

    expect(
      renderedWidgetRows(setWidget, "subagentura-activity", 80).join("\n"),
    ).toContain("ambient-agent");
  });

  it("registers the activity widget as an adaptive grid component", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ui = { notify: vi.fn(), setStatus, setWidget };
    for (let index = 0; index < 5; index++) {
      const item = makeState();
      item.state.name = index === 0 ? "agent-0\nprimary" : `agent-${index}`;
      item.state.lastToolSummary =
        index === 0 ? `${"界🙂 reading ".repeat(80)}\nsecond` : `task-${index}`;
      fixtureScope.interactiveStates.set(item.id, item.state);
    }
    fixtureScope.ui = ui as any;
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollFixture(mod, {} as any);

    const activityCall = setWidget.mock.calls.find(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityCall?.[1]).toEqual(expect.any(Function));
    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 5 sub-agents alive · 5 working",
    );

    const narrowWidth = responsiveFlowMinimumWidth(2) - 1;
    expect(
      renderedWidgetRows(setWidget, "subagentura-activity", narrowWidth),
    ).toHaveLength(5);
    const wideWidth = responsiveFlowMinimumWidth(3);
    const wideRows = renderedWidgetRows(
      setWidget,
      "subagentura-activity",
      wideWidth,
    );
    expect(wideRows).toHaveLength(2);
    expect(wideRows[0]).toMatch(/agent-0.*agent-1.*agent-2/);
    expect(wideRows[1]).toMatch(/agent-3.*agent-4/);
    expect(wideRows.every((line) => visibleWidth(line) <= wideWidth)).toBe(
      true,
    );
    expect(wideRows.every((line) => !line.includes("\n"))).toBe(true);
  });

  it("projects v2 tool activity in physical order into the activity row", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.name = "activity-agent";
    item.state.cwd = join(item.artifactDir, "..");
    const art = artifactPath(item.state.cwd, item.id);
    fixtureScope.interactiveStates.set(item.id, item.state);
    appendTestTurnStarted(art, 3_000, `turn-${item.id}`);
    appendEvent(art, {
      version: 2,
      eventId: "tool-started",
      turnId: `turn-${item.id}`,
      ts: 2_000,
      type: "tool_activity",
      phase: "start",
      status: "running",
      tool: "bash",
      summary: "bash",
    });
    appendEvent(art, {
      version: 2,
      eventId: "tool-ended-with-error",
      turnId: `turn-${item.id}`,
      ts: 1_000,
      type: "tool_activity",
      phase: "end",
      status: "running",
      tool: "bash",
      summary: "bash failed",
    });
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    fixtureScope.ui = {
      notify: vi.fn(),
      setStatus,
      setWidget,
    } as unknown as ExtensionUIContext;
    const mux = {
      getPaneLivenessAsync: async () => "alive" as const,
    } satisfies Pick<Multiplexer, "getPaneLivenessAsync">;
    multiplexer.__setTmuxMultiplexer(mux as unknown as Multiplexer);

    await pollFixture(mod, { sendMessage: vi.fn() } as unknown as ExtensionAPI);

    expect(item.state.status).toBe("running");
    expect(item.state.lastToolName).toBe("bash");
    expect(item.state.lastToolSummary).toBe("bash failed");
    expect(item.state.lastActivityAt).toBe(1_000);
    expect(formatActivityRow(item.state, 1_000)).toContain("bash failed");
    const rows = renderedWidgetRows(setWidget, "subagentura-activity", 80).join(
      "\n",
    );
    expect(rows).toContain("bash");
    expect(rows).toContain("failed");
    appendEvent(art, {
      version: 2,
      eventId: "tool-started-without-summary",
      turnId: `turn-${item.id}`,
      ts: 500,
      type: "tool_activity",
      phase: "start",
      status: "running",
      tool: "python",
    });
    await pollFixture(mod, { sendMessage: vi.fn() } as unknown as ExtensionAPI);

    expect(item.state.lastToolName).toBe("python");
    expect(item.state.lastToolSummary).toBe("python");
    expect(item.state.lastActivityAt).toBe(500);
    expect(formatActivityRow(item.state, 500)).toContain("python");
    expect(
      renderedWidgetRows(setWidget, "subagentura-activity", 80).join("\n"),
    ).toContain("python");
  });

  it.each([
    { label: "empty", summary: "" },
    { label: "whitespace-only", summary: " \t\n" },
    { label: "control-only", summary: "\u0001\u0085\u009f" },
  ])(
    "falls back to the supplied tool name for $label activity summaries",
    async ({ summary }) => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const multiplexer = await import("../src/multiplexer");
      const item = makeState();
      item.state.name = "activity-agent";
      item.state.cwd = join(item.artifactDir, "..");
      const art = artifactPath(item.state.cwd, item.id);
      const turnId = `turn-${item.id}`;
      appendTestTurnStarted(art, 1_000, turnId);
      appendEvent(art, {
        version: 2,
        eventId: `tool-${item.id}`,
        turnId,
        ts: 2_000,
        type: "tool_activity",
        phase: "start",
        status: "running",
        tool: "bash",
        summary,
      });
      fixtureScope.interactiveStates.set(item.id, item.state);
      const setWidget = vi.fn();
      fixtureScope.ui = {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget,
      } as unknown as ExtensionUIContext;
      const mux = {
        getPaneLivenessAsync: async () => "alive" as const,
      } satisfies Pick<Multiplexer, "getPaneLivenessAsync">;
      multiplexer.__setTmuxMultiplexer(mux as unknown as Multiplexer);

      await pollFixture(mod, {
        sendMessage: vi.fn(),
      } as unknown as ExtensionAPI);

      expect(item.state.status).toBe("running");
      expect(item.state.lastToolName).toBe("bash");
      expect(item.state.lastToolSummary).toBe("bash");
      expect(item.state.lastActivityAt).toBe(2_000);
      expect(formatActivityRow(item.state, 2_000)).toContain("bash");
      expect(
        renderedWidgetRows(setWidget, "subagentura-activity", 80).join("\n"),
      ).toContain("bash");
    },
  );

  it("hides owner-scoped activity rows from the global setting only", async () => {
    const item = makeState();
    const testRoot = join(item.artifactDir, "..");
    const settings = makeSessionSettingsSandbox(testRoot);
    writeGlobalSettings({ "hide-agent-list": "true" });
    // A repo-controlled project file must not be able to flip this setting.
    writeFileSync(
      join(settings.cwd, ".pi", "settings-extensions.json"),
      JSON.stringify({
        "pi-subagentura": { "hide-agent-list": "false" },
      }),
    );
    expect(settings.cwd).not.toBe(process.cwd());

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    item.state.name = "hidden-agent";
    item.state.parentSessionId = "session-hidden";
    item.state.cwd = testRoot;
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const pi = {
      sendMessage: vi.fn(),
      getFlag: () => undefined,
    } as unknown as ExtensionAPI;
    const ui = {
      notify: vi.fn(),
      setStatus,
      setWidget,
    } as unknown as ExtensionUIContext;
    const scope = registerSessionScope({
      id: 505,
      generation: 1,
      pi,
      ui,
      cwd: settings.cwd,
      sessionManager: {
        getSessionId: () => "session-hidden",
        getEntries: () => [],
      },
    });
    scope.interactiveStates.set(item.id, item.state);
    const livenessMux = {
      getPaneLivenessAsync: async () => "alive" as const,
    } satisfies Pick<Multiplexer, "getPaneLivenessAsync">;
    // The poller exercises only liveness; the remaining mux methods are irrelevant here.
    multiplexer.__setTmuxMultiplexer(livenessMux as unknown as Multiplexer);

    await mod.pollArtifactChanges(pi, {
      id: scope.id,
      generation: scope.generation,
    });

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · 1 working",
    );
    expect(setWidget).toHaveBeenCalledWith("subagentura-activity", undefined, {
      placement: "belowEditor",
    });
    expect(renderedWidgetRows(setWidget, "subagentura-activity", 80)).toEqual(
      [],
    );
  });

  it("skips aborted child settlement but delivers the next turn", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.parentSessionId = "session-aborted";
    item.state.cwd = join(item.artifactDir, "..");
    const art = artifactPath(item.state.cwd, item.id);
    appendCompletionEvent(art, {
      turnId: "aborted-turn",
      outcome: "error",
      source: "agent_settled",
      agentStopReason: "aborted",
    });

    const owner = { id: 601, generation: 1 };
    const sendMessage = vi.fn();
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const scope = registerSessionScope({
      ...owner,
      pi: { sendMessage } as any,
      ui: ui as any,
      sessionManager: {
        getSessionId: () => "session-aborted",
        getEntries: () => [],
      },
    });
    scope.interactiveStates.set(item.id, item.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    const abortedCursor = eventLogEndOffset(art);
    await mod.pollArtifactChanges({} as any, owner);

    expect(item.state.eventByteCursor).toBe(abortedCursor);
    expect(item.state.status).toBe("idle");
    expect(item.state.pendingDeliveries).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();

    appendEvent(art, {
      version: 2,
      eventId: "next-turn-start",
      turnId: "clarification-turn",
      ts: 2,
      type: "turn_started",
      status: "running",
    });
    writeOutput(art, "clarification output");
    appendCompletionEvent(art, {
      turnId: "clarification-turn",
      outcome: "done",
      source: "agent_settled",
    });

    await mod.pollArtifactChanges({} as any, owner);

    expect(item.state.eventByteCursor).toBe(eventLogEndOffset(art));
    expect(item.state.status).toBe("idle");
    expect(item.state.pendingDeliveries).toHaveLength(1);
    expect(item.state.pendingDeliveries?.[0]).toMatchObject({
      turnId: "clarification-turn",
      status: "done",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("polls and dispatches only interactive states owned by the supplied context", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const a = makeState();
    const b = makeState();
    a.state.parentSessionId = "session-a";
    b.state.parentSessionId = "session-b";
    for (const item of [a, b]) {
      item.state.cwd = join(item.artifactDir, "..");
      const art = artifactPath(item.state.cwd, item.id);
      writeOutput(art, item.id);
      appendCompletionEvent(art, {
        turnId: `turn-${item.id}`,
        outcome: "done",
        source: "agent_settled",
      });
    }
    const ownerB = { id: 402, generation: 1 };
    const sendMessage = installDeliverySpies();
    const wrongSendMessage = vi.fn();
    const scopeA = registerSessionScope({
      id: 401,
      generation: 1,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    const scopeB = registerSessionScope({
      ...ownerB,
      pi: { sendMessage } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    scopeA.interactiveStates.set(a.id, a.state);
    scopeB.interactiveStates.set(b.id, b.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as any);
    await mod.pollArtifactChanges(
      { sendMessage: wrongSendMessage } as any,
      ownerB,
    );

    expect(a.state.eventByteCursor ?? 0).toBe(0);
    expect(a.state.pendingDeliveries ?? []).toEqual([]);
    expect(b.state.eventByteCursor).toBeGreaterThan(0);
    expect(b.state.pendingDeliveries).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(wrongSendMessage).not.toHaveBeenCalled();
  });

  it("does not coalesce concurrent polls from different owners", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const a = makeState();
    const b = makeState();
    a.state.parentSessionId = "session-a";
    a.state.paneId = "%a";
    b.state.parentSessionId = "session-b";
    b.state.paneId = "%b";
    for (const item of [a, b]) {
      item.state.cwd = join(item.artifactDir, "..");
      const art = artifactPath(item.state.cwd, item.id);
      appendTestTurnStarted(art, 1, `turn-${item.id}`);
    }
    const ownerA = { id: 501, generation: 1 };
    const ownerB = { id: 502, generation: 1 };
    const scopeA = registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    const scopeB = registerSessionScope({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    scopeA.interactiveStates.set(a.id, a.state);
    scopeB.interactiveStates.set(b.id, b.state);
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: (paneId: string) =>
        paneId === "%a"
          ? blockedA.then(() => "alive" as const)
          : Promise.resolve("alive" as const),
    } as any);

    const pollA = mod.pollArtifactChanges({} as any, ownerA);
    await Promise.resolve();
    const pollB = mod.pollArtifactChanges({} as any, ownerB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bProcessedWhileAWasBlocked = (b.state.eventByteCursor ?? 0) > 0;
    releaseA();
    await Promise.all([pollA, pollB]);

    expect(bProcessedWhileAWasBlocked).toBe(true);
  });

  it("retains shared activity rows and footer when a sibling owner has none", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const sharedUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const a = makeState();
    a.state.name = "agent-a";
    a.state.parentSessionId = "session-a";
    const ownerA = { id: 503, generation: 1 };
    const ownerB = { id: 504, generation: 1 };
    const scopeA = registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    registerSessionScope({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    scopeA.interactiveStates.set(a.id, a.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await mod.pollArtifactChanges({} as any, ownerA);
    await mod.pollArtifactChanges({} as any, ownerB);

    const finalRows = renderedWidgetRows(
      sharedUi.setWidget,
      "subagentura-activity",
      80,
    );
    expect(finalRows).toEqual(
      expect.arrayContaining([expect.stringContaining("agent-a")]),
    );
    const footerCalls = sharedUi.setStatus.mock.calls.filter(
      ([key]) => key === "subagentura-running",
    );
    expect(footerCalls.at(-1)?.[1]).toBe("⚡ 1 sub-agent alive · 1 working");
  });

  it("aggregates workflow footer contributions across owners sharing one UI", async () => {
    const mod = await importFresh<typeof import("../src/artifact-poller")>(
      "../src/artifact-poller",
    );
    const { workflowJobRegistry } = await import("../src/workflow");
    const sharedUi = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const ownerA = { id: 509, generation: 1 };
    const ownerB = { id: 510, generation: 1 };
    registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    registerSessionScope({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    workflowJobRegistry.set("workflow-a", {
      id: "workflow-a",
      name: "flow-a",
      status: "running",
      startedAt: Date.now(),
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      parentSessionOwner: ownerA,
      snapshot: {
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 2,
        budgetTotal: 20,
        usage: {
          input: 4,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          totalTokens: 7,
          costUsd: 0.01,
          turns: 1,
          costSource: "provider",
        },
        phases: [],
        runningCount: 1,
      },
    });
    workflowJobRegistry.set("workflow-b", {
      id: "workflow-b",
      name: "flow-b",
      status: "running",
      startedAt: Date.now(),
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      parentSessionOwner: ownerB,
      snapshot: {
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 3,
        budgetTotal: 30,
        usage: {
          input: 6,
          output: 3,
          cacheRead: 0,
          cacheWrite: 2,
          totalTokens: 11,
          costUsd: 0.02,
          turns: 1,
          costSource: "provider",
        },
        phases: [],
        runningCount: 1,
      },
    });

    await mod.pollArtifactChanges({} as any, ownerA);
    await mod.pollArtifactChanges({} as any, ownerB);

    const workflowFooterCalls = sharedUi.setStatus.mock.calls.filter(
      ([key]) => key === "subagentura-workflows",
    );
    expect(workflowFooterCalls.at(-1)?.[1]).toBe(
      "⚡ 2 workflows running · ↑10 ↓5 R1 W2 $0.03",
    );

    mod.clearSessionScopeUiContributions(sharedUi as any, ownerA);
    removeSessionScope(ownerA.id);

    expect(
      sharedUi.setStatus.mock.calls
        .filter(([key]) => key === "subagentura-workflows")
        .at(-1)?.[1],
    ).toBe("⚡ 1 workflow running · ↑6 ↓3 R0 W2 $0.02");
  });

  it("omits provenance-free all-zero workflow usage from the footer", async () => {
    const mod = await importFresh<typeof import("../src/artifact-poller")>(
      "../src/artifact-poller",
    );
    const { workflowJobRegistry } = await import("../src/workflow");
    const owner = sessionOwner(fixtureScope);
    workflowJobRegistry.set("zero-usage", {
      id: "zero-usage",
      name: "zero-flow",
      status: "running",
      startedAt: Date.now(),
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      parentSessionOwner: owner,
      snapshot: {
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 0,
        budgetTotal: 99,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 3,
        },
        liveUsage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          costUsd: 0,
          turns: 1,
        },
        phases: [],
        runningCount: 1,
      },
    });
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    fixtureScope.ui = { setStatus, setWidget } as any;

    await pollFixture(mod, {} as any);

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-workflows",
      "⚡ 1 workflow running",
    );
    const workflowRows = setWidget.mock.calls
      .filter(([key]) => key === "subagentura-workflow-activity")
      .at(-1)?.[1] as string[];
    expect(workflowRows).toHaveLength(1);
    expect(workflowRows[0]).not.toContain("↑0");
    expect(workflowRows[0]).not.toContain("$?");
    expect(workflowRows[0]).not.toContain("live");
  });

  it("shows workflow children on the owning session's widget and footer", async () => {
    // Workflow children are launched without a parentSessionId, so scoping either
    // surface on (ui identity + parentSessionId) makes them structurally
    // unrepresentable: visible in the supervisor, missing from the widget, and
    // undercounted in the footer. Ownership must come from supervisorOwner.
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const uiA = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
    const uiB = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
    const ownerA = { id: 601, generation: 1 };
    const ownerB = { id: 602, generation: 1 };
    const scopeA = registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiA as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    const scopeB = registerSessionScope({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiB as any,
      sessionManager: { getSessionId: () => "session-b" },
    });

    const child = makeState();
    child.state.name = "wf-child";
    child.state.supervisorOwner = ownerA;
    child.state.workflowId = "wf-1";
    child.state.completionOwner = "workflow";
    child.state.parentSessionId = undefined;
    scopeA.interactiveStates.set(child.id, child.state);

    // A sibling session's plain agent must be neither listed nor counted for A.
    const sibling = makeState();
    sibling.state.name = "sibling";
    sibling.state.parentSessionId = "session-b";
    scopeB.interactiveStates.set(sibling.id, sibling.state);

    multiplexer.__setTmuxMultiplexer({
      isPaneAliveAsync: async () => true,
    } as any);

    await mod.pollArtifactChanges({} as any, ownerA);

    const rows = renderedWidgetRows(uiA.setWidget, "subagentura-activity", 80);
    expect(rows).toEqual(
      expect.arrayContaining([expect.stringContaining("wf-child")]),
    );
    expect(rows).toHaveLength(1);
    expect(uiA.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · workflow wf-1",
    );
  });

  it("keeps activity rows isolated between distinct UIs", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const uiA = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const uiB = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const a = makeState();
    const b = makeState();
    a.state.name = "agent-a";
    a.state.parentSessionId = "session-a";
    b.state.name = "agent-b";
    b.state.parentSessionId = "session-b";
    const ownerA = { id: 505, generation: 1 };
    const ownerB = { id: 506, generation: 1 };
    const scopeA = registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiA as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    const scopeB = registerSessionScope({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiB as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    scopeA.interactiveStates.set(a.id, a.state);
    scopeB.interactiveStates.set(b.id, b.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await mod.pollArtifactChanges({} as any, ownerA);
    await mod.pollArtifactChanges({} as any, ownerB);

    const rowsFor = (ui: typeof uiA): string[] =>
      renderedWidgetRows(ui.setWidget, "subagentura-activity", 80);
    expect(rowsFor(uiA).join("\n")).toContain("agent-a");
    expect(rowsFor(uiA).join("\n")).not.toContain("agent-b");
    expect(rowsFor(uiB).join("\n")).toContain("agent-b");
    expect(rowsFor(uiB).join("\n")).not.toContain("agent-a");
  });

  it("fails closed for ownerless polling when a session scope exists", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const unowned = makeState();
    unowned.state.name = "unowned-agent";
    const scope = registerSessionScope({
      id: 507,
      generation: 1,
      pi: { sendMessage: vi.fn() } as any,
      ui: ui as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    scope.interactiveStates.set(unowned.id, unowned.state);
    const getPaneLivenessAsync = vi.fn(async () => "alive");
    multiplexer.__setTmuxMultiplexer({ getPaneLivenessAsync } as any);

    await mod.pollArtifactChanges({} as any);

    const activityCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityCalls).toEqual([]);
    expect(unowned.state.eventByteCursor).toBeUndefined();
    expect(getPaneLivenessAsync).not.toHaveBeenCalled();
    await mod.pollArtifactChanges(scope.pi, sessionOwner(scope));
    expect(getPaneLivenessAsync).toHaveBeenCalledOnce();
    expect(unowned.state.eventByteCursor).toBe(0);
    expect(
      renderedWidgetRows(ui.setWidget, "subagentura-activity", 80).join("\n"),
    ).toContain("unowned-agent");
  });

  it("does not repaint unchanged poller UI", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { workflowJobRegistry } = await import("../src/workflow");
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const item = makeState();
    item.state.name = "steady-agent";
    item.state.lastToolSummary = "reading src/main.ts";
    item.state.lastActivityAt = Date.now() - 10_000;
    fixtureScope.interactiveStates.set(item.id, item.state);
    workflowJobRegistry.set("steady-workflow", {
      id: "steady-workflow",
      name: "steady-flow",
      status: "running",
      // Both polls land inside the same coarse elapsed bucket, so every row
      // stays byte-identical and the memoized paint is skipped.
      startedAt: 20_000,
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      parentSessionOwner: sessionOwner(fixtureScope),
      snapshot: {
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 10,
        phases: [],
        runningCount: 1,
      },
    });
    fixtureScope.ui = ui as any;
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollFixture(mod, {} as any);
    vi.setSystemTime(25_000);
    await pollFixture(mod, {} as any);

    const activityCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityCalls).toHaveLength(1);
    const footerCalls = ui.setStatus.mock.calls.filter(
      ([key]) => key === "subagentura-running",
    );
    expect(footerCalls).toHaveLength(1);
    const workflowWidgetCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-workflow-activity",
    );
    expect(workflowWidgetCalls).toHaveLength(1);
    const workflowFooterCalls = ui.setStatus.mock.calls.filter(
      ([key]) => key === "subagentura-workflows",
    );
    expect(workflowFooterCalls).toHaveLength(1);
    expect(renderWidgetContent(activityCalls[0][1], 80)[0]).toBe(
      "▶ steady-agent: reading src/main.ts (10s ago)",
    );
    expect((workflowWidgetCalls[0][1] as string[])[0]).toContain("0s");
  });

  it("repaints the widget once a coarse elapsed bucket boundary is crossed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const ui = {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    const item = makeState();
    item.state.name = "ticking-agent";
    item.state.lastToolSummary = "reading src/main.ts";
    item.state.lastActivityAt = 10_000;
    fixtureScope.interactiveStates.set(item.id, item.state);
    fixtureScope.ui = ui as any;
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollFixture(mod, {} as any);
    // Still inside the 10s bucket — no repaint.
    vi.setSystemTime(29_000);
    await pollFixture(mod, {} as any);
    // Crosses into the 20s bucket — one repaint with the advanced clock.
    vi.setSystemTime(31_000);
    await pollFixture(mod, {} as any);

    const activityCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityCalls).toHaveLength(2);
    expect(renderWidgetContent(activityCalls[0][1], 80)[0]).toBe(
      "▶ ticking-agent: reading src/main.ts (10s ago)",
    );
    expect(renderWidgetContent(activityCalls[1][1], 80)[0]).toBe(
      "▶ ticking-agent: reading src/main.ts (20s ago)",
    );
  });

  it("coalesces overlapping polls for the same owner", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.parentSessionId = "session-same";
    item.state.cwd = join(item.artifactDir, "..");
    const art = artifactPath(item.state.cwd, item.id);
    appendCompletionEvent(art, {
      turnId: `turn-${item.id}`,
      outcome: "done",
      source: "agent_settled",
    });
    const owner = { id: 601, generation: 1 };
    const sendMessage = vi.fn();
    const scope = registerSessionScope({
      ...owner,
      pi: { sendMessage } as any,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } as any,
      sessionManager: {
        getSessionId: () => "session-same",
        getEntries: () => [],
      },
    });
    scope.interactiveStates.set(item.id, item.state);
    let releaseLiveness!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseLiveness = resolve;
    });
    const getPaneLivenessAsync = vi.fn(async () => {
      await blocked;
      return "alive";
    });
    multiplexer.__setTmuxMultiplexer({ getPaneLivenessAsync } as any);

    const first = mod.pollArtifactChanges({} as any, owner);
    await Promise.resolve();
    const second = mod.pollArtifactChanges({} as any, owner);

    // The second tick joins the in-flight poll instead of starting a second
    // pass that would race on the shared eventByteCursor / delivery queue.
    expect(getPaneLivenessAsync).toHaveBeenCalledTimes(1);
    releaseLiveness();
    await Promise.all([first, second]);

    expect(getPaneLivenessAsync).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(item.state.pendingDeliveries ?? []).toHaveLength(1);

    // Once the in-flight poll settles the key is released, so a later tick runs.
    await mod.pollArtifactChanges({} as any, owner);
    expect(getPaneLivenessAsync).toHaveBeenCalledTimes(2);
    // The completion cursor already advanced, so the second pass adds no new
    // delivery intent for the same turn.
    expect(item.state.pendingDeliveries ?? []).toHaveLength(1);
  });

  it("keeps an unknown pane active and continues artifact polling", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const item = makeState();
    item.state.cwd = join(item.artifactDir, "..");
    const art = artifactPath(item.state.cwd, item.id);
    appendTestTurnStarted(art, 1, `turn-${item.id}`);
    fixtureScope.interactiveStates.set(item.id, item.state);
    installDeliverySpies();
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "unknown",
    } as never);

    await pollFixture(mod, {} as never);

    expect(item.state.status).toBe("unknown");
    expect(fixtureScope.interactiveStates.get(item.id)).toBe(item.state);
    expect(item.state.eventByteCursor).toBeGreaterThan(0);
  });
  it("reports one mux probe runtime failure per outage episode", async () => {
    vi.resetModules();
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { state } = makeState();
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const owner = { id: 908, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as any,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as any,
      sessionManager: { getSessionId: () => "pi" },
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
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "unknown",
    } as never);
    const payloads: Array<{
      event?: string;
      properties?: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    installDeliverySpies();

    await mod.pollArtifactChanges({} as any, owner);
    await mod.pollArtifactChanges({} as any, owner);
    let runtimeFailures = payloads.filter(
      (payload) => payload.event === "pi_subagentura_runtime_failure",
    );
    expect(runtimeFailures).toHaveLength(1);
    expect(runtimeFailures[0]?.properties).toMatchObject({
      error_category: "mux",
      error_stage: "polling",
      failure_kind: "mux_probe",
    });
    expect(state.status).toBe("unknown");

    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as never);
    await mod.pollArtifactChanges({} as any, owner);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "unknown",
    } as never);
    await mod.pollArtifactChanges({} as any, owner);

    runtimeFailures = payloads.filter(
      (payload) => payload.event === "pi_subagentura_runtime_failure",
    );
    expect(runtimeFailures).toHaveLength(2);
    expect(
      payloads.some(
        (payload) => payload.event === "pi_subagentura_task_completed",
      ),
    ).toBe(false);
  });

  it.each([
    [
      "process-exited",
      {
        version: 2,
        eventId: "process-exited-event",
        turnId: "process-exited-turn",
        ts: 1,
        type: "process_exited",
        status: "error",
        exitCode: 1,
      },
    ],
  ] as const)(
    "does not repeat mux probe failures for retained %s states",
    async (_label, terminalEvent) => {
      vi.resetModules();
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const multiplexer = await import("../src/multiplexer");
      const debugLog = vi.spyOn(await import("../src/helpers"), "debugLog");
      const item = makeState();
      const art = artifactPath(join(item.artifactDir, ".."), item.id);
      appendEvent(art, terminalEvent as any);
      const telemetry = createTelemetrySession(true, "orchestrator_v2");
      const owner = { id: 909, generation: 1 };
      const scope = registerSessionScope({
        ...owner,
        lifecycle: "started",
        pi: { sendMessage: vi.fn() } as any,
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          setWidget: vi.fn(),
        } as any,
        sessionManager: { getSessionId: () => "pi" },
        telemetry,
      });
      item.state.telemetryEligible = true;
      item.state.telemetryCorrelationId = telemetry.correlationId;
      item.state.telemetryInvocationSource = "interactive";
      item.state.telemetryCompletionPolicy = "each";
      item.state.telemetryAsync = true;
      item.state.telemetryDepth = 1;
      item.state.telemetryDepthBucket = "1";
      item.state.telemetryModel = "default";
      scope.interactiveStates.set(item.id, item.state);
      let diagnostic: PaneLivenessDiagnostic = {
        liveness: "unknown",
        failureReason: "timeout",
      };
      const getPaneLivenessDiagnosticAsync = vi.fn(async () => diagnostic);
      multiplexer.__setTmuxMultiplexer({
        getPaneLivenessDiagnosticAsync,
      } as never);
      const payloads: Array<{
        event?: string;
        properties?: Record<string, unknown>;
      }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      });
      installDeliverySpies();

      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

      const runtimeFailures = () =>
        payloads.filter(
          (payload) => payload.event === "pi_subagentura_runtime_failure",
        );
      expect(runtimeFailures()).toHaveLength(1);
      expect(item.state.status).toBe("exited");
      expect(item.state.eventByteCursor).toBeGreaterThan(0);
      const muxProbeLogs = () =>
        debugLog.mock.calls.filter(
          ([, event]) => event === "interactive_mux_probe_unknown",
        );
      expect(muxProbeLogs()).toHaveLength(1);
      expect(muxProbeLogs()[0]).toEqual([
        "warn",
        "interactive_mux_probe_unknown",
        { mux: "tmux", failureReason: "timeout" },
      ]);
      expect(runtimeFailures()[0]?.properties).not.toHaveProperty(
        "failureReason",
      );

      diagnostic = { liveness: "alive" };
      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
      diagnostic = { liveness: "unknown", failureReason: "timeout" };
      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

      expect(runtimeFailures()).toHaveLength(2);
      expect(muxProbeLogs()).toHaveLength(2);
      expect(getPaneLivenessDiagnosticAsync).toHaveBeenCalledTimes(4);
    },
  );

  it("logs mux probe classifications once even when telemetry is disabled", async () => {
    vi.resetModules();
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const debugLog = vi.spyOn(await import("../src/helpers"), "debugLog");
    const item = makeState();
    const owner = { id: 910, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as any,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as any,
      sessionManager: { getSessionId: () => "pi" },
    });
    scope.interactiveStates.set(item.id, item.state);
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessDiagnosticAsync: async () => ({
        liveness: "unknown",
        failureReason: "command_error",
      }),
    } as never);

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

    expect(
      debugLog.mock.calls.filter(
        ([, event]) => event === "interactive_mux_probe_unknown",
      ),
    ).toEqual([
      [
        "warn",
        "interactive_mux_probe_unknown",
        { mux: "tmux", failureReason: "command_error" },
      ],
    ]);
  });

  it("truncates overflowing activity and workflow widget rows", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { workflowJobRegistry } = await import("../src/workflow");
    const ui = { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() };
    for (let index = 0; index < 12; index++) {
      const item = makeState();
      item.state.name = `agent-${index}`;
      fixtureScope.interactiveStates.set(item.id, item.state);
    }
    for (let index = 0; index < 7; index++) {
      workflowJobRegistry.set(`wf-${index}`, {
        id: `wf-${index}`,
        name: `flow-${index}`,
        status: "running",
        startedAt: Date.now(),
        promise: Promise.resolve({}) as any,
        abort: new AbortController(),
        parentSessionOwner: sessionOwner(fixtureScope),
        snapshot: {
          agentsSpawned: 1,
          errorCount: 0,
          tokensSpent: 0,
          phases: [],
          runningCount: 1,
        },
      } as any);
    }
    fixtureScope.ui = ui as any;
    multiplexer.__setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as any);

    await pollFixture(mod, {} as any);

    const rowsFor = (key: string, width = 80): string[] =>
      renderedWidgetRows(ui.setWidget, key, width);
    const activityRows = rowsFor("subagentura-activity");
    expect(activityRows).toHaveLength(11);
    expect(activityRows.at(-1)).toBe("… and 2 more");
    expect(
      rowsFor("subagentura-activity", responsiveFlowMinimumWidth(3)),
    ).toHaveLength(4);
    const workflowRows = rowsFor("subagentura-workflow-activity");
    expect(workflowRows).toHaveLength(6);
    expect(workflowRows.at(-1)).toBe("… and 2 more workflows");
  });

  it("abandons mutation when its owner is removed during liveness", async () => {
    const result = await pollUntilOwnerInvalidation((owner) => {
      removeSessionScope(owner.id);
    });

    expect(result.state.eventByteCursor ?? 0).toBe(0);
    expect(result.state.pendingDeliveries ?? []).toEqual([]);
    expect(result.state.status).toBe("running");
    expect(result.state.lastToolName).toBeUndefined();
    expect(result.state.lastToolSummary).toBeUndefined();
    expect(result.state.lastActivityAt).toBeUndefined();
    expect(
      loadInteractiveStates(result.state.cwd)?.states[result.state.id],
    ).toEqual(result.persistedBefore);
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.setStatus).not.toHaveBeenCalled();
    expect(result.setWidget).not.toHaveBeenCalled();
  });

  it("abandons mutation when its owner generation advances during liveness", async () => {
    const result = await pollUntilOwnerInvalidation((owner) => {
      advanceSessionScopeGeneration(owner.id);
    });

    expect(result.state.eventByteCursor ?? 0).toBe(0);
    expect(result.state.pendingDeliveries ?? []).toEqual([]);
    expect(result.state.status).toBe("running");
    expect(result.state.lastToolName).toBeUndefined();
    expect(result.state.lastToolSummary).toBeUndefined();
    expect(result.state.lastActivityAt).toBeUndefined();
    expect(
      loadInteractiveStates(result.state.cwd)?.states[result.state.id],
    ).toEqual(result.persistedBefore);
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.setStatus).not.toHaveBeenCalled();
    expect(result.setWidget).not.toHaveBeenCalled();
  });

  it("keeps running in-process jobs in the shared footer", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    fixtureScope.inProcessJobs.set("async-1", { status: "running" } as any);
    const setStatus = vi.fn();
    fixtureScope.ui = {
      setStatus,
      setWidget: vi.fn(),
    } as any;

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent alive · 1 working",
    );
  });

  it("keeps the event loop responsive while async liveness is pending", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    let resolveProbe!: (liveness: "alive") => void;
    let probeStarted = false;
    let settled = false;
    const probe = new Promise<"alive">((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => {
        throw new Error("sync liveness probe must not run");
      },
      getPaneLivenessAsync: () => {
        probeStarted = true;
        return probe;
      },
    } as any);
    fixtureScope.interactiveStates.set(state.id, state);
    const polling = pollFixture(mod, { sendMessage: vi.fn() } as any);
    void Promise.resolve(polling).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(probeStarted).toBe(true);
    expect(settled).toBe(false);
    let timerRan = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0);
    });
    expect(timerRan).toBe(true);
    expect(settled).toBe(false);
    resolveProbe("alive");
    await polling;
    expect(settled).toBe(true);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("drops a pending poll when shutdown clears the registry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    appendTestTurnStarted(
      artifactPath(join(artifactDir, ".."), state.id),
      1,
      `turn-${state.id}`,
    );
    let resolveProbe!: (liveness: "alive") => void;
    const probe = new Promise<"alive">((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => {
        throw new Error("sync liveness probe must not run");
      },
      getPaneLivenessAsync: () => probe,
    } as any);
    fixtureScope.interactiveStates.set(state.id, state);
    const sendMessage = vi.fn();
    const polling = pollFixture(mod, { sendMessage } as any);
    await Promise.resolve();
    fixtureScope.interactiveStates.clear();
    resolveProbe("alive");
    await polling;
    expect(state.eventByteCursor).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("does not overlap pending poll ticks", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    let probeCalls = 0;
    let resolveProbe!: (liveness: "alive") => void;
    const probe = new Promise<"alive">((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => {
        throw new Error("sync liveness probe must not run");
      },
      getPaneLivenessAsync: () => {
        probeCalls++;
        return probe;
      },
    } as any);
    fixtureScope.interactiveStates.set(state.id, state);
    const first = pollFixture(mod, { sendMessage: vi.fn() } as any);
    const second = pollFixture(mod, { sendMessage: vi.fn() } as any);
    await Promise.resolve();
    expect(probeCalls).toBe(1);
    resolveProbe("alive");
    await Promise.all([first, second]);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("paints workflow footer and widget for running workflows", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { workflowJobRegistry } = await import("../src/workflow");
    workflowJobRegistry.set("wf_test", {
      id: "wf_test",
      name: "demo-flow",
      status: "running",
      startedAt: Date.now() - 5_000,
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      parentSessionOwner: sessionOwner(fixtureScope),
      snapshot: {
        agentsSpawned: 3,
        errorCount: 0,
        tokensSpent: 120,
        usage: {
          input: 4,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          costUsd: 0.01,
          turns: 1,
          costSource: "mixed",
        },
        phases: ["Scan"],
        currentPhase: "Scan",
        lastMessage: "→ started scout",
        runningCount: 2,
      },
    });

    const setStatus = vi.fn();
    const setWidget = vi.fn();
    fixtureScope.ui = { setStatus, setWidget } as any;

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-workflows",
      "⚡ 1 workflow running · ↑4 ↓2 R0 W0 $? (mixed)",
    );
    expect(setWidget).toHaveBeenCalledWith(
      "subagentura-workflow-activity",
      [expect.stringContaining("demo-flow (wf_test): 3 agents · 2 running")],
      { placement: "belowEditor" },
    );
  });

  it("logs unexpected top-level poller errors to the debug log", async () => {
    const logDir = makeTmp();
    process.env.SUBAGENT_DEBUG_LOG_DIR = logDir;
    vi.resetModules();

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    fixtureScope.interactiveStates.set("bad-state", {
      id: "bad-state",
      status: "running",
      artifactDir: undefined,
    } as any);

    await expect(
      pollFixture(mod, {
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any),
    ).resolves.toBeUndefined();

    const logFile = join(
      logDir,
      `debug-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain('"event":"poller_error"');
    expect(content).not.toContain('"registryIds"');

    rmSync(logDir, { recursive: true, force: true });
  });

  it("records cancellation before killing a pane with unknown liveness", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    state.cwd = join(artifactDir, "..");
    state.parentSessionId = "pi";
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "cancel-turn", startedAt: Date.now() }),
    );
    let completionsAtKill = 0;
    let persistedIntentsAtKill = 0;
    appendInteractiveState(state.cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      parentSessionId: "pi",
      eventByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => "unknown",
      killPane: () => {
        completionsAtKill = readFileSync(
          join(artifactDir, "events.ndjson"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter(
            (event) =>
              event.type === "completion" &&
              event.outcome === "cancelled" &&
              event.turnId === "cancel-turn",
          ).length;
        const persisted = loadInteractiveStates(state.cwd)?.states[state.id];
        persistedIntentsAtKill = persisted?.pendingDeliveries?.length ?? 0;
      },
    } as any);
    state.sessionOwner = sessionOwner(fixtureScope);
    fixtureScope.interactiveStates.set(state.id, state);
    fixtureScope.parentStreaming = true;

    interactive.cancelInteractiveSubagent(
      state.id,
      "cancel_interactive_subagent",
      state,
    );
    expect(completionsAtKill).toBe(1);
    expect(persistedIntentsAtKill).toBe(0);

    fixtureScope.parentStreaming = false;
    const sendMessage = vi.fn();
    await pollFixture(mod, { sendMessage } as any);
    await pollFixture(mod, { sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("creates a distinct process cancellation after the active turn completed", async () => {
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "completed-turn", startedAt: Date.now() }),
    );
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendCompletionEvent(art, {
      turnId: "completed-turn",
      outcome: "done",
      source: "explicit",
    });
    multiplexer.__setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      killPane: vi.fn(),
    } as any);
    state.sessionOwner = sessionOwner(fixtureScope);
    fixtureScope.interactiveStates.set(state.id, state);

    interactive.cancelInteractiveSubagent(
      state.id,
      "cancel_interactive_subagent",
      state,
    );

    const completions = readFileSync(art.statusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "completion");
    expect(completions).toHaveLength(2);
    expect(completions[1]).toMatchObject({
      outcome: "cancelled",
      source: "parent",
      cancellationOrigin: "cancel_interactive_subagent",
    });
    expect(completions[1].turnId).toMatch(/^process-cancel-/);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  // ── Bug B regression tests (stale footer/widget for closed sub-agents) ──
  // When a sub-agent is "exited" (terminal, pane dead) the for-loop at line
  // ~518 of subagent.ts must still process artifact lifecycle events, but
  // terminal panes must NOT contribute to the active footer count or
  // the `widgetRows` list. `idle` sub-agents (between turns, REPL open) are
  // still live and DO contribute to the active count.
  describe("footer/widget (Bug B)", () => {
    it("AC-B1: counts running + idle as 'active'; excludes exited from both footer and widget", async () => {
      // One successful listing serves every probe: two panes are present and
      // the third is conclusively absent.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => Buffer.from("%90\n%91\n"),
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%90\n%91\n"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      // Running sub-agent: no events in artifact; pane alive.
      const running = makeState().state;
      running.id = "running-1";
      running.paneId = "%90";
      fixtureScope.interactiveStates.set(running.id, running);

      // Idle sub-agent: done event, pane alive. artifactDir must be set so the
      // poller reads from the same dir where we write the events.
      const idle = makeState().state;
      idle.id = "idle-1";
      idle.paneId = "%91";
      idle.artifactDir = join(idle.artifactDir, "..", idle.id);
      fixtureScope.interactiveStates.set(idle.id, idle);
      const idleArt = artifactPath(join(idle.artifactDir, ".."), idle.id);
      appendTestTurnStarted(idleArt, 1, "turn-idle-1");
      appendTestCompletion(idleArt, 2, "done", "turn-idle-1");

      // Exited sub-agent: done event, pane dead.
      const exited = makeState().state;
      exited.id = "exited-1";
      exited.paneId = "%92";
      exited.artifactDir = join(exited.artifactDir, "..", exited.id);
      fixtureScope.interactiveStates.set(exited.id, exited);
      const exitedArt = artifactPath(join(exited.artifactDir, ".."), exited.id);
      appendTestTurnStarted(exitedArt, 1, "turn-exited-1");
      appendTestCompletion(exitedArt, 2, "done", "turn-exited-1");

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      fixtureScope.ui = { setStatus, setWidget } as any;

      await pollFixture(mod, {
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents alive · 1 working",
      );
      expect(setWidget).toHaveBeenCalledWith(
        "subagentura-activity",
        expect.any(Function),
        { placement: "belowEditor" },
      );
      expect(
        renderedWidgetRows(setWidget, "subagentura-activity", 80),
      ).toHaveLength(2);

      expect(exited.status).toBe("exited");
      expect(idle.status).toBe("idle");
      expect(running.status).toBe("running");
    });

    it("AC-B1b: rehydrates a completed live pane as idle and ready", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => Buffer.from("%99\n"),
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99\n"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const multiplexer = await import("../src/multiplexer");
      multiplexer.__setTmuxMultiplexer({
        getPaneLiveness: () => "alive",
        getPaneLivenessAsync: async () => "alive",
      } as any);
      const cwd = makeTmp();
      const id = "rehydrated-idle";
      const artifactDir = join(cwd, id);
      mkdirSync(artifactDir, { recursive: true });
      const art = artifactPath(cwd, id);
      appendTestTurnStarted(art, 1, "turn-1");
      appendTestCompletion(art, 2, "done", "turn-1");
      appendInteractiveState(cwd, {
        id,
        paneId: "%idle-pane",
        windowName: "demo",
        mux: "tmux",
        artifactDir,
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "pi",
        eventByteCursor: eventLogEndOffset(art),
        pendingDeliveries: [],
        deliveryReceipts: [],
        lifecycle: {
          completionTurnId: "turn-1",
          completionOutcome: "done",
          completionSource: "explicit",
        },
      });
      mod.rehydrateInteractiveSubagents(cwd, "pi", [], fixtureScope);
      const state = fixtureScope.interactiveStates.get(id)!;
      expect(state.status).toBe("idle");
      const setStatus = vi.fn();
      const setWidget = vi.fn();
      fixtureScope.ui = { setStatus, setWidget } as any;

      await pollFixture(mod, {
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(state.status).toBe("idle");
      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 1 sub-agent alive",
      );
      const widgetRows = renderedWidgetRows(
        setWidget,
        "subagentura-activity",
        80,
      );
      expect(widgetRows).toContain(
        "○ rehydrated-idle: idle — ready for follow-up",
      );
      expect(widgetRows.join("\n")).not.toContain("starting");
      expect(widgetRows.join("\n")).not.toContain("stale");
      multiplexer.__setTmuxMultiplexer(undefined);
    });

    it("AC-B2: clears footer and widget when all sub-agents are exited", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => "",
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, ""),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      const exited1 = makeState().state;
      exited1.id = "exited-1";
      exited1.artifactDir = join(exited1.artifactDir, "..", exited1.id);
      fixtureScope.interactiveStates.set(exited1.id, exited1);
      const exited1Art = artifactPath(
        join(exited1.artifactDir, ".."),
        exited1.id,
      );
      appendTestTurnStarted(exited1Art, 1, "turn-exited-1");
      appendTestCompletion(exited1Art, 2, "done", "turn-exited-1");

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      fixtureScope.ui = { setStatus, setWidget } as any;

      await pollFixture(mod, {
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
    });

    it("AC-B3: combines interactive and in-process footer counts", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => Buffer.from("%99\n"),
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99\n"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      fixtureScope.inProcessJobs.set("async-1", { status: "running" } as any);

      const a = makeState().state;
      a.id = "a";
      fixtureScope.interactiveStates.set(a.id, a);
      const b = makeState().state;
      b.id = "b";
      fixtureScope.interactiveStates.set(b.id, b);

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      fixtureScope.ui = { setStatus, setWidget } as any;

      await pollFixture(mod, {
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 3 sub-agents alive · 3 working",
      );
      expect(
        renderedWidgetRows(setWidget, "subagentura-activity", 80),
      ).toHaveLength(2);
    });
  });
});

describe("pollArtifactChanges — terminal cleanup of state.json", () => {
  beforeEach(() => {
    startFixtureScope();
  });

  function makePersistedState(): {
    id: string;
    cwd: string;
    state: import("../src/interactive-tmux").InteractiveSubagentState;
  } {
    const cwd = makeTmp();
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("../src/interactive-tmux").InteractiveSubagentState = {
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
      eventByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
    });
    return { id, cwd, state };
  }

  it("does not remove another owner's persisted terminal state", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    state.parentSessionId = "session-b";
    state.status = "exited";
    const ownerA = { id: 601, generation: 1 };
    registerSessionScope({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    const scopeB = registerSessionScope({
      id: 602,
      generation: 1,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    scopeB.interactiveStates.set(id, state);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();

    await mod.pollArtifactChanges({} as any, ownerA);

    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
  });

  it("queues coordinated completion before terminal cleanup", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, ""),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendTestTurnStarted(art, 1, `turn-${id}`);
    appendTestCompletion(art, 2, "done", `turn-${id}`);

    installDeliverySpies();
    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({
        state: "queued",
        completionPolicy: "each",
        turnId: `turn-${id}`,
      }),
    ]);
  });

  it("keeps the state.json entry after delivering a done event when the pane is alive", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendTestTurnStarted(art, 1, `turn-${id}`);
    appendTestCompletion(art, 2, "done", `turn-${id}`);

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.status).toBe("idle");
  });

  it("keeps a live pane idle after a v2 error completion", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "error-completion",
      turnId: "turn-error",
      ts: 1,
      type: "completion",
      status: "error",
      outcome: "error",
      source: "agent_end",
      errorMessage: "provider failed",
    });

    installDeliverySpies();
    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    expect(state.status).toBe("idle");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
  });

  it.each([
    ["agent_settled", "error", "provider"],
    ["agent_settled", "aborted", "unknown"],
    ["agent_settled", undefined, "unknown"],
    ["agent_end", undefined, "unknown"],
    ["explicit", undefined, "unknown"],
    ["process_exit", undefined, "transport"],
  ] as const)(
    "classifies %s/%s errors as %s without serializing details",
    async (source, agentStopReason, expectedCategory) => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => Buffer.from("%99\n"),
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99\n"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { id, state } = makePersistedState();
      const telemetry = createTelemetrySession(true, "orchestrator_v2");
      const owner = { id: 904, generation: 1 };
      const scope = registerSessionScope({
        ...owner,
        lifecycle: "started",
        pi: { sendMessage: vi.fn() } as any,
        ui: {
          notify: vi.fn(),
          setStatus: vi.fn(),
          setWidget: vi.fn(),
        } as any,
        sessionManager: { getSessionId: () => "pi" },
        telemetry,
      });
      state.telemetryEligible = true;
      state.telemetryCorrelationId = telemetry.correlationId;
      state.telemetryActiveTurnId = "turn-error";
      state.telemetryTurnStartedAt = 1;
      state.telemetryInvocationSource = "interactive";
      state.telemetryCompletionPolicy = "each";
      state.telemetryAsync = true;
      state.telemetryDepth = 1;
      state.telemetryDepthBucket = "1";
      state.telemetryModel = "default";
      scope.interactiveStates.set(id, state);
      const art = artifactPath(join(state.artifactDir, ".."), id);
      const secret =
        "provider failed: Bearer secret https://private.example/token /Users/alice/project";
      appendEvent(art, {
        version: 2,
        eventId: "error-completion-sensitive",
        turnId: "turn-error",
        ts: 2,
        type: "completion",
        status: "error",
        outcome: "error",
        source,
        ...(agentStopReason === undefined ? {} : { agentStopReason }),
        message: secret,
        errorMessage: secret,
        summary: secret,
      });
      const payloads: Array<{
        event?: string;
        properties?: Record<string, unknown>;
      }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      });
      installDeliverySpies();

      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

      const completed = payloads.find(
        (payload) => payload.event === "pi_subagentura_task_completed",
      );
      expect(completed?.properties).toMatchObject({
        status: "error",
        error_category: expectedCategory,
      });
      if (source === "agent_settled" && agentStopReason !== undefined) {
        expect(completed?.properties).toMatchObject({
          agent_stop_reason: agentStopReason,
        });
      } else {
        expect(completed?.properties).not.toHaveProperty("agent_stop_reason");
      }
      expect(completed?.properties).not.toHaveProperty("exit_code_bucket");
      expect(JSON.stringify(payloads)).not.toContain(secret);
    },
  );

  it("reports the bounded process-exit code without borrowing completion metadata", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { id, state } = makePersistedState();
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const owner = { id: 906, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as any,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as any,
      sessionManager: { getSessionId: () => "pi" },
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
    scope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "turn-started-for-exit",
      turnId: "turn-exited",
      ts: 1,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "process-exited-with-code",
      turnId: "turn-exited",
      ts: 2,
      type: "process_exited",
      status: "error",
      exitCode: 17,
    });
    const payloads: Array<{
      event?: string;
      properties?: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    installDeliverySpies();

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

    const completed = payloads.find(
      (payload) => payload.event === "pi_subagentura_task_completed",
    );
    expect(completed?.properties).toMatchObject({
      status: "error",
      terminal_reason: "process_exit",
      error_category: "transport",
      error_stage: "completion",
      exit_code_bucket: "nonzero",
    });
    expect(completed?.properties).not.toHaveProperty("agent_stop_reason");
  });

  it("emits one privacy-safe runtime failure per malformed artifact episode", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { id, state } = makePersistedState();
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const owner = { id: 905, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as any,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as any,
      sessionManager: { getSessionId: () => "pi" },
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
    scope.interactiveStates.set(id, state);

    const art = artifactPath(join(state.artifactDir, ".."), id);
    const secret = "malformed secret bearer token";
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(art.statusFile, `${secret}\n`);
    const payloads: Array<{
      event?: string;
      properties?: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    installDeliverySpies();

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

    const runtimeFailures = () =>
      payloads.filter(
        (payload) => payload.event === "pi_subagentura_runtime_failure",
      );
    expect(runtimeFailures()).toHaveLength(1);
    expect(runtimeFailures()[0]?.properties).toMatchObject({
      error_category: "artifact",
      error_stage: "polling",
      failure_kind: "artifact_malformed",
    });
    expect(
      payloads.some(
        (payload) => payload.event === "pi_subagentura_task_completed",
      ),
    ).toBe(false);
    expect(JSON.stringify(payloads)).not.toContain(secret);

    appendTestTurnStarted(art, 2, `turn-${id}`);
    appendFileSync(art.statusFile, `${secret}-again\n`);
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

    expect(runtimeFailures()).toHaveLength(2);
    expect(JSON.stringify(payloads)).not.toContain(secret);
  });

  it("reports unreadable and oversized artifact episodes without terminal events", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state } = makePersistedState();
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const owner = { id: 907, generation: 1 };
    const scope = registerSessionScope({
      ...owner,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as any,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as any,
      sessionManager: { getSessionId: () => "pi" },
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

    const art = artifactPath(join(state.artifactDir, ".."), state.id);
    mkdirSync(art.dir, { recursive: true });
    mkdirSync(art.statusFile);
    const payloads: Array<{
      event?: string;
      properties?: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    installDeliverySpies();

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
    const runtimeFailures = payloads.filter(
      (payload) => payload.event === "pi_subagentura_runtime_failure",
    );
    expect(runtimeFailures).toHaveLength(1);
    expect(runtimeFailures[0]?.properties).toMatchObject({
      error_category: "artifact",
      error_stage: "polling",
      failure_kind: "artifact_unreadable",
    });
    expect(state.eventByteCursor ?? 0).toBe(0);

    rmSync(art.statusFile, { recursive: true, force: true });
    writeFileSync(
      art.statusFile,
      Buffer.concat([
        Buffer.alloc(MAX_EVENT_RECORD_BYTES + 1, 120),
        Buffer.from("\n"),
      ]),
    );
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

    const allRuntimeFailures = payloads.filter(
      (payload) => payload.event === "pi_subagentura_runtime_failure",
    );
    expect(allRuntimeFailures).toHaveLength(2);
    expect(allRuntimeFailures[1]?.properties).toMatchObject({
      error_category: "artifact",
      error_stage: "polling",
      failure_kind: "artifact_oversized",
    });
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
    expect(
      payloads.some(
        (payload) => payload.event === "pi_subagentura_task_completed",
      ),
    ).toBe(false);
  });

  it("removes state after process_exited even if pane liveness reports true", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "process-exit",
      turnId: "turn-error",
      ts: 1,
      type: "process_exited",
      status: "error",
      exitCode: 1,
    });

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    expect(state.status).toBe("exited");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
  });

  it("does NOT remove the state.json entry on tool_activity events (only terminals)", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "#99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      version: 2,
      eventId: "tool-activity-event",
      turnId: "turn-tool-activity",
      ts: 1,
      type: "tool_activity",
      phase: "end",
      status: "running",
      tool: "bash",
      summary: "ls",
    });

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
  });

  it("does NOT throw if state has no parentSessionId (no-op guard)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "id-" + Math.random().toString(36).slice(2, 8);
    const state: import("../src/interactive-tmux").InteractiveSubagentState = {
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
      artifactDir: join(makeTmp(), id),
    };
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendTestCompletion(art, 1, "done", `turn-${id}`);

    await expect(
      pollFixture(mod, { sendMessage: vi.fn() } as any),
    ).resolves.toBeUndefined();
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
    expect(state.pendingDeliveries).toHaveLength(1);
  });

  it("advances eventByteCursor before removing the state entry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { id, state } = makePersistedState();
    fixtureScope.interactiveStates.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendTestTurnStarted(art, 1, `turn-${id}`);
    appendTestCompletion(art, 2, "done", `turn-${id}`);

    await pollFixture(mod, { sendMessage: vi.fn() } as any);

    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });
});
