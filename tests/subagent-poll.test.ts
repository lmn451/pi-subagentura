/**
 * The artifact-driven poller fires pointer notifications for new events on
 * interactive sub-agents. Tests reset the global pi ref + registry, then write
 * events directly to the artifact dir to drive the poller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  appendCompletionEvent,
  appendInteractiveState,
  artifactPath,
  eventLogEndOffset,
  loadInteractiveStates,
  MAX_EVENT_RECORD_BYTES,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  readEventRecords,
  writeOutput,
} from "../src/artifact";
import type { PaneLiveness } from "../src/interactive-state";
import type { Multiplexer } from "../src/multiplexer";
import type * as SubagentModule from "../src/subagent";
import { importFresh } from "./test-utils";
import {
  advanceSessionContextGeneration,
  getSessionContextStack,
  registerSessionContext,
  removeSessionContext,
} from "../src/session-context";
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-poll-"));
}

function missingTmuxPaneError(paneId = "%99"): Error & {
  readonly code: number;
  readonly stderr: string;
} {
  return Object.assign(new Error(`can't find pane: ${paneId}`), {
    code: 1,
    stderr: `can't find pane: ${paneId}`,
  });
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
  (globalThis as any).__piSubagenturaUi = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
  return sendMessage;
}

describe("pollArtifactChanges", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaRegistry?.clear?.();
    g.__piSubagenturaWorkflowJobs?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaParentStreaming = false;
    getSessionContextStack().length = 0;
  });

  afterEach(() => {
    (globalThis as any).__piSubagenturaParentStreaming = false;
    (globalThis as any).__piSubagenturaRegistry?.clear?.();
    delete process.env.SUBAGENT_DEBUG_LOG_DIR;
    vi.doUnmock("node:child_process");
    vi.useRealTimers();
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
    });
    const persistedBefore = loadInteractiveStates(item.state.cwd)?.states[
      item.id
    ];
    mod.interactiveSubagentRegistry.set(item.id, item.state);
    const owner = { id: 701, generation: 1 };
    const sendMessage = vi.fn();
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    registerSessionContext({
      ...owner,
      pi: { sendMessage } as any,
      ui: { notify: vi.fn(), setStatus, setWidget } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    let releaseLiveness!: () => void;
    let livenessStarted = false;
    const blockedLiveness = new Promise<void>((resolve) => {
      releaseLiveness = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => {
        livenessStarted = true;
        await blockedLiveness;
        return { kind: "alive" };
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
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
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
      mod.interactiveSubagentRegistry.set(item.id, item.state);
    }
    const ownerB = { id: 402, generation: 1 };
    const sendMessage = installDeliverySpies();
    const wrongSendMessage = vi.fn();
    registerSessionContext({
      id: 401,
      generation: 1,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    registerSessionContext({
      ...ownerB,
      pi: { sendMessage } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage: wrongSendMessage,
    };
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => true,
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);
    await mod.pollArtifactChanges(
      { sendMessage: wrongSendMessage } as any,
      ownerB,
    );

    expect(a.state.eventByteCursor ?? 0).toBe(0);
    expect(a.state.pendingDeliveries ?? []).toEqual([]);
    expect(b.state.eventByteCursor).toBeGreaterThan(0);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain(b.id);
    expect(sendMessage.mock.calls[0][0].content).not.toContain(a.id);
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
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      mod.interactiveSubagentRegistry.set(item.id, item.state);
    }
    const ownerA = { id: 501, generation: 1 };
    const ownerB = { id: 502, generation: 1 };
    registerSessionContext({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    registerSessionContext({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    let releaseA!: () => void;
    const blockedA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      observePane: (paneId: string): Promise<PaneLiveness> =>
        paneId === "%a"
          ? blockedA.then(() => ({ kind: "alive" as const }))
          : Promise.resolve({ kind: "alive" as const }),
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

  it("retains shared activity rows when a sibling owner has none", async () => {
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
    mod.interactiveSubagentRegistry.set(a.id, a.state);
    const ownerA = { id: 503, generation: 1 };
    const ownerB = { id: 504, generation: 1 };
    registerSessionContext({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    registerSessionContext({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: sharedUi as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any, ownerA);
    await mod.pollArtifactChanges({} as any, ownerB);

    const widgetCalls = sharedUi.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    const finalRows = widgetCalls.at(-1)?.[1] as string[] | undefined;
    expect(finalRows).toEqual(
      expect.arrayContaining([expect.stringContaining("agent-a")]),
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
    mod.interactiveSubagentRegistry.set(a.id, a.state);
    mod.interactiveSubagentRegistry.set(b.id, b.state);
    const ownerA = { id: 505, generation: 1 };
    const ownerB = { id: 506, generation: 1 };
    registerSessionContext({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiA as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    registerSessionContext({
      ...ownerB,
      pi: { sendMessage: vi.fn() } as any,
      ui: uiB as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any, ownerA);
    await mod.pollArtifactChanges({} as any, ownerB);

    const rowsFor = (ui: typeof uiA): string[] => {
      const calls = ui.setWidget.mock.calls.filter(
        ([key]) => key === "subagentura-activity",
      );
      return calls.at(-1)?.[1] as string[];
    };
    expect(rowsFor(uiA).join("\n")).toContain("agent-a");
    expect(rowsFor(uiA).join("\n")).not.toContain("agent-b");
    expect(rowsFor(uiB).join("\n")).toContain("agent-b");
    expect(rowsFor(uiB).join("\n")).not.toContain("agent-a");
  });

  it("preserves unscoped activity projection when contexts exist", async () => {
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
    mod.interactiveSubagentRegistry.set(unowned.id, unowned.state);
    registerSessionContext({
      id: 507,
      generation: 1,
      pi: { sendMessage: vi.fn() } as any,
      ui: ui as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    (globalThis as any).__piSubagenturaUi = ui;
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any);

    const activityCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    const finalRows = activityCalls.at(-1)?.[1] as string[] | undefined;
    expect(finalRows).toEqual(
      expect.arrayContaining([expect.stringContaining("unowned-agent")]),
    );
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
    mod.interactiveSubagentRegistry.set(item.id, item.state);
    workflowJobRegistry.set("steady-workflow", {
      id: "steady-workflow",
      name: "steady-flow",
      status: "running",
      // Both polls land inside the same coarse elapsed bucket, so every row
      // stays byte-identical and the memoized paint is skipped.
      startedAt: 20_000,
      promise: Promise.resolve({}) as any,
      abort: new AbortController(),
      snapshot: {
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 10,
        phases: [],
        runningCount: 1,
      },
    });
    (globalThis as any).__piSubagenturaUi = ui;
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any);
    vi.setSystemTime(25_000);
    await mod.pollArtifactChanges({} as any);

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
    expect((activityCalls[0][1] as string[])[0]).toBe(
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
    mod.interactiveSubagentRegistry.set(item.id, item.state);
    (globalThis as any).__piSubagenturaUi = ui;
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any);
    // Still inside the 10s bucket — no repaint.
    vi.setSystemTime(29_000);
    await mod.pollArtifactChanges({} as any);
    // Crosses into the 20s bucket — one repaint with the advanced clock.
    vi.setSystemTime(31_000);
    await mod.pollArtifactChanges({} as any);

    const activityCalls = ui.setWidget.mock.calls.filter(
      ([key]) => key === "subagentura-activity",
    );
    expect(activityCalls).toHaveLength(2);
    expect((activityCalls[0][1] as string[])[0]).toBe(
      "▶ ticking-agent: reading src/main.ts (10s ago)",
    );
    expect((activityCalls[1][1] as string[])[0]).toBe(
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
    mod.interactiveSubagentRegistry.set(item.id, item.state);
    const owner = { id: 601, generation: 1 };
    const sendMessage = vi.fn();
    registerSessionContext({
      ...owner,
      pi: { sendMessage } as any,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } as any,
      sessionManager: {
        getSessionId: () => "session-same",
        getEntries: () => [],
      },
    });
    let releaseLiveness!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseLiveness = resolve;
    });
    const observePane = vi.fn(async (): Promise<PaneLiveness> => {
      await blocked;
      return { kind: "alive" };
    });
    multiplexer.__setTmuxMultiplexer({ observePane } as any);

    const first = mod.pollArtifactChanges({} as any, owner);
    await Promise.resolve();
    const second = mod.pollArtifactChanges({} as any, owner);

    // The second tick joins the in-flight poll instead of starting a second
    // pass that would race on the shared eventByteCursor / delivery queue.
    expect(observePane).toHaveBeenCalledTimes(1);
    releaseLiveness();
    await Promise.all([first, second]);

    expect(observePane).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(item.state.pendingDeliveries ?? []).toHaveLength(1);

    // Once the in-flight poll settles the key is released, so a later tick runs.
    await mod.pollArtifactChanges({} as any, owner);
    expect(observePane).toHaveBeenCalledTimes(2);
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
    appendEvent(art, { ts: 1, type: "done", status: "done" });
    mod.interactiveSubagentRegistry.set(item.id, item.state);
    installDeliverySpies();
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "unknown" }),
    } as never);

    await mod.pollArtifactChanges({} as never);

    expect(item.state.status).toBe("unknown");
    expect(mod.interactiveSubagentRegistry.get(item.id)).toBe(item.state);
    expect(item.state.eventByteCursor).toBeGreaterThan(0);
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
      mod.interactiveSubagentRegistry.set(item.id, item.state);
    }
    for (let index = 0; index < 7; index++) {
      workflowJobRegistry.set(`wf-${index}`, {
        id: `wf-${index}`,
        name: `flow-${index}`,
        status: "running",
        startedAt: Date.now(),
        promise: Promise.resolve({}) as any,
        abort: new AbortController(),
        snapshot: {
          agentsSpawned: 1,
          errorCount: 0,
          tokensSpent: 0,
          phases: [],
          runningCount: 1,
        },
      } as any);
    }
    (globalThis as any).__piSubagenturaUi = ui;
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
    } as any);

    await mod.pollArtifactChanges({} as any);

    const rowsFor = (key: string): string[] =>
      ui.setWidget.mock.calls.filter(([name]) => name === key).at(-1)?.[1] ??
      [];
    const activityRows = rowsFor("subagentura-activity");
    expect(activityRows).toHaveLength(11);
    expect(activityRows.at(-1)).toBe("… and 2 more");
    const workflowRows = rowsFor("subagentura-workflow-activity");
    expect(workflowRows).toHaveLength(6);
    expect(workflowRows.at(-1)).toBe("… and 2 more workflows");
  });

  it("abandons mutation when its owner is removed during liveness", async () => {
    const result = await pollUntilOwnerInvalidation((owner) => {
      removeSessionContext(owner.id);
    });

    expect(result.state.eventByteCursor ?? 0).toBe(0);
    expect(result.state.pendingDeliveries ?? []).toEqual([]);
    expect(result.state.status).toBe("running");
    expect(
      loadInteractiveStates(result.state.cwd)?.states[result.state.id],
    ).toEqual(result.persistedBefore);
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.setStatus).not.toHaveBeenCalled();
    expect(result.setWidget).not.toHaveBeenCalled();
  });

  it("abandons mutation when its owner generation advances during liveness", async () => {
    const result = await pollUntilOwnerInvalidation((owner) => {
      advanceSessionContextGeneration(owner.id);
    });

    expect(result.state.eventByteCursor ?? 0).toBe(0);
    expect(result.state.pendingDeliveries ?? []).toEqual([]);
    expect(result.state.status).toBe("running");
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
    mod.jobRegistry.set("async-1", { status: "running" } as any);
    const setStatus = vi.fn();
    (globalThis as any).__piSubagenturaUi = {
      setStatus,
      setWidget: vi.fn(),
    };

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });

  it("keeps the event loop responsive while async liveness is pending", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    mkdirSync(artifactDir, { recursive: true });
    let resolveProbe!: (liveness: PaneLiveness) => void;
    let probeStarted = false;
    let settled = false;
    const probe = new Promise<PaneLiveness>((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => {
        throw new Error("sync liveness probe must not run");
      },
      observePane: (): Promise<PaneLiveness> => {
        probeStarted = true;
        return probe;
      },
    } as any);
    mod.interactiveSubagentRegistry.set(state.id, state);
    const polling = mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);
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
    resolveProbe({ kind: "alive" });
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
    appendEvent(artifactPath(join(artifactDir, ".."), state.id), {
      ts: 1,
      type: "done",
      status: "done",
      exitCode: 0,
    });
    let resolveProbe!: (liveness: PaneLiveness) => void;
    const probe = new Promise<PaneLiveness>((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => {
        throw new Error("sync liveness probe must not run");
      },
      observePane: (): Promise<PaneLiveness> => probe,
    } as any);
    mod.interactiveSubagentRegistry.set(state.id, state);
    const sendMessage = vi.fn();
    const polling = mod.pollArtifactChanges({ sendMessage } as any);
    await Promise.resolve();
    mod.interactiveSubagentRegistry.clear();
    resolveProbe({ kind: "alive" });
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
    let resolveProbe!: (liveness: PaneLiveness) => void;
    const probe = new Promise<PaneLiveness>((resolve) => {
      resolveProbe = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => {
        throw new Error("sync liveness probe must not run");
      },
      observePane: (): Promise<PaneLiveness> => {
        probeCalls++;
        return probe;
      },
    } as any);
    mod.interactiveSubagentRegistry.set(state.id, state);
    const first = mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);
    const second = mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);
    await Promise.resolve();
    expect(probeCalls).toBe(1);
    resolveProbe({ kind: "alive" });
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
      snapshot: {
        agentsSpawned: 3,
        errorCount: 0,
        tokensSpent: 120,
        phases: ["Scan"],
        currentPhase: "Scan",
        lastMessage: "→ started scout",
        runningCount: 2,
      },
    });

    const setStatus = vi.fn();
    const setWidget = vi.fn();
    (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(setStatus).toHaveBeenCalledWith(
      "subagentura-workflows",
      "⚡ 1 workflow running",
    );
    expect(setWidget).toHaveBeenCalledWith(
      "subagentura-workflow-activity",
      [expect.stringContaining("demo-flow (wf_test): 3 agents · 2 running")],
      { placement: "belowEditor" },
    );

    delete (globalThis as any).__piSubagenturaUi;
  });

  it("logs unexpected top-level poller errors to the debug log", async () => {
    const logDir = makeTmp();
    process.env.SUBAGENT_DEBUG_LOG_DIR = logDir;
    vi.resetModules();

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    mod.interactiveSubagentRegistry.set("bad-state", {
      id: "bad-state",
      status: "running",
      artifactDir: undefined,
    } as any);

    await expect(
      mod.pollArtifactChanges({
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
    expect(content).toContain("bad-state");

    rmSync(logDir, { recursive: true, force: true });
  });

  it("acknowledges cancellation before killing a pane with unknown liveness", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { state, artifactDir } = makeState();
    state.notifyOnComplete = "inject";
    state.triggerTurnOnComplete = true;
    state.cwd = join(artifactDir, "..");
    state.parentSessionId = "pi";
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "cancel-turn", startedAt: Date.now() }),
    );
    let completionsAtKill = 0;
    let persistedIntentsAtKill = 0;
    let persistedReceiptsAtKill = 0;
    appendInteractiveState(state.cwd, {
      id: state.id,
      paneId: state.paneId,
      mux: state.mux,
      artifactDir: state.artifactDir,
      sessionFile: state.sessionFile,
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      parentSessionId: "pi",
    });
    multiplexer.__setTmuxMultiplexer({
      isPaneAlive: () => true,
      observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
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
        persistedIntentsAtKill = persisted?.pendingDeliveries.length ?? 0;
        persistedReceiptsAtKill = persisted?.deliveryReceipts.length ?? 0;
      },
    } as any);
    interactive.interactiveSubagentRegistry.set(state.id, state);
    (globalThis as any).__piSubagenturaParentStreaming = true;

    interactive.cancelInteractiveSubagent(state.id);
    expect(completionsAtKill).toBe(1);
    expect(persistedIntentsAtKill).toBe(0);
    expect(persistedReceiptsAtKill).toBe(1);

    (globalThis as any).__piSubagenturaParentStreaming = false;
    const sendMessage = vi.fn();
    await mod.pollArtifactChanges({ sendMessage } as any);
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toHaveLength(1);
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
      isPaneAlive: () => true,
      killPane: vi.fn(),
    } as any);
    interactive.interactiveSubagentRegistry.set(state.id, state);

    interactive.cancelInteractiveSubagent(state.id);

    const completions = readFileSync(art.statusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "completion");
    expect(completions).toHaveLength(2);
    expect(completions[1]).toMatchObject({
      outcome: "cancelled",
      source: "parent",
    });
    expect(completions[1].turnId).toMatch(/^process-cancel-/);
    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toHaveLength(1);
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("fires a pointer notification on done. Started is silent.", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    mod.jobRegistry.set("still-running", { status: "running" } as any);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);

    // Only done fires. started is silent (widget shows it).
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = sendMessage.mock.calls[0][0];
    expect(call.customType).toBe("subagent-notify");
    expect(call.content).toContain("done");
    // Pointer format: paths, not a tool-call hint.
    expect(call.content).toContain("Output:");
    expect(call.content).toContain("Activity log:");
    expect(call.content).not.toContain("read_subagent_artifact");
    expect(call.content).toContain(
      "1 in-process sub-agent job is still running",
    );
    expect(call.details.remainingRunningJobs).toBe(1);
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("does NOT fire on tool_activity/started", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);

    // Both are silent (started → TUI widget row; tool_activity → TUI widget only).
    expect(sendMessage).not.toHaveBeenCalled();
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("delivers unacknowledged error and cancellation events normally", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain("error");
    expect(sendMessage.mock.calls[0][0].content).toContain("cancelled");
  });

  it("is at-most-once per event (cursor advances)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);
    // Only done fires (started is silent).
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Second poll: no new events, no new notifications.
    sendMessage.mockClear();
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("delivers only events after eventByteCursor (backlog catch-up)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    // Simulate a sub-agent that finished while the parent was down — events
    // were already on disk before this poller started.
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    appendEvent(art, { ts: 3, type: "cancelled", status: "cancelled" });
    mod.interactiveSubagentRegistry.set(state.id, state);

    state.eventByteCursor = readEventRecords(art)[0].endOffset;

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);

    // Should deliver done + cancelled, not started.
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(sendMessage.mock.calls[0][0].content).toContain("cancelled");
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  it("marks the sub-agent as idle when a done event is seen and the pane is still alive (follow-up support)", async () => {
    // The child is between turns, REPL is open, ready for the next prompt.
    // Return a successful pane listing containing the tracked pane.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    await mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("idle");
    // exitCode is NOT set on idle — child is still around.
    expect(state.exitCode).toBeUndefined();
  });

  it("marks the sub-agent as exited when a done event is seen but the pane is gone", async () => {
    // A successful listing without the pane is confirmed dead.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw missingTmuxPaneError();
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(missingTmuxPaneError(), ""),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    await mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("exited");
    expect(state.exitCode).toBe(0);
  });

  it("marks the sub-agent as cancelled when a cancelled event is seen", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    await mod.pollArtifactChanges({} as any);
    expect(state.status).toBe("cancelled");
  });

  it("delivers durable completion backlog even when state is already cancelled", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.status = "cancelled";
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("retries an unknown pane and notifies when done arrives later", async () => {
    vi.resetModules();
    let paneProbeCount = 0;
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") {
          paneProbeCount++;
          if (paneProbeCount === 1) {
            throw new Error("pane not ready yet");
          }
          return Buffer.from("%99");
        }
        return Buffer.from("%99\n");
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => {
        paneProbeCount++;
        callback(
          paneProbeCount === 1 ? new Error("pane not ready yet") : null,
          "%99",
        );
      },
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);
    expect(state.status).toBe("unknown");

    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    await mod.pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
  });

  it("keeps processing 'idle' sub-agents — the follow-up case", async () => {
    // After the child finishes a turn, status becomes 'idle'. The poll loop must keep running for
    // it so a second `done` event (from a follow-up turn) re-fires the pointer notification.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.status = "idle"; // simulate "already between turns"
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    state.eventByteCursor = eventLogEndOffset(art);
    appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 }); // follow-up turn

    const sendMessage = installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage } as any);

    // The new done event (ts=3) is delivered as a pointer notification.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].content).toContain("done");
    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });

  // Inject-mode tests: when a sub-agent is spawned with notifyOnComplete:
  // "inject" and finishes with a completion, the broker sends one attributed
  // custom message. Legacy events remain pointer-only.
  describe("inject mode for interactive sub-agents", () => {
    beforeEach(() => {
      (globalThis as any).__piSubagenturaInjectCount = 0;
    });

    it("sends one pointer-only custom message for a legacy inject completion", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the sub-agent's final answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain(
        "the sub-agent's final answer",
      );
      expect(sendMessage.mock.calls[0][0].content).toContain("Output:");
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(state.pendingDeliveries?.[0]?.state).toBe("dispatchAttempted");
    });

    it("persists oversized completion delivery metadata before advancing the event cursor", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const multiplexer = await import("../src/multiplexer");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      state.triggerTurnOnComplete = false;
      state.cwd = join(artifactDir, "..");
      state.parentSessionId = "pi";
      appendInteractiveState(state.cwd, {
        id: state.id,
        paneId: state.paneId,
        mux: state.mux,
        artifactDir: state.artifactDir,
        sessionFile: state.sessionFile,
        notifyOnComplete: "inject",
        triggerTurnOnComplete: false,
        parentSessionId: "pi",
      });
      mod.interactiveSubagentRegistry.set(state.id, state);
      multiplexer.__setTmuxMultiplexer({
        isPaneAlive: () => true,
        observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
      } as any);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      const raw =
        JSON.stringify({
          version: 2,
          eventId: "adversarial-oversized-event",
          turnId: "adversarial-oversized-turn",
          ts: 1,
          type: "completion",
          outcome: "error",
          source: "explicit",
          errorMessage: "x".repeat(MAX_EVENT_RECORD_BYTES + 1),
        }) + "\n";
      mkdirSync(art.dir, { recursive: true });
      writeFileSync(art.statusFile, raw);
      const sendMessage = installDeliverySpies();

      await mod.pollArtifactChanges({ sendMessage } as any);

      const persisted = loadInteractiveStates(state.cwd)?.states[state.id];
      expect(persisted?.eventByteCursor).toBe(eventLogEndOffset(art));
      expect(persisted?.pendingDeliveries).toContainEqual(
        expect.objectContaining({
          eventId: "record-overflow-0",
          turnId: "record-overflow-0",
          status: "error",
          message: `Artifact record at byte 0 exceeded the ${MAX_EVENT_RECORD_BYTES}-byte limit and was skipped.`,
        }),
      );
      multiplexer.__setTmuxMultiplexer(undefined);
    });

    it("uses attributed sendMessage when state.notifyOnComplete is unset (default: inject)", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      // Legacy completions are pointer-only even when the delivery mode is inject.
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(state.lastInjectedEventTs).toBeUndefined();
    });

    it("does NOT call sendUserMessage when state.notifyOnComplete === 'notify' (explicit)", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "notify";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "should not be injected");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("adds triggerTurn to notify-mode pointer notifications when requested", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "notify";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("triggers the single inject envelope when triggerTurnOnComplete is set", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "final answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toEqual({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("does trigger the pointer notification for inject-mode errors when requested", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      state.triggerTurnOnComplete = true;
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, {
        ts: 2,
        type: "error",
        status: "error",
        message: "boom",
      });

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("is at-most-once: a second poll does not redispatch the delivery intent", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "the answer");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Second poll: no new events (cursor advanced), inject is gated by state.injected.
      sendMessage.mockClear();
      sendUserMessage.mockClear();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("dispatches pointer-only envelopes for legacy follow-up completions", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      // Turn 1: child finishes, writes output v1, calls done.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain("answer v1");
      expect(sendMessage.mock.calls[0][0].content).toContain("Output:");
      expect(sendUserMessage).not.toHaveBeenCalled();

      // Turn 2: parent sent a follow-up, child processed it, wrote output v2, called done again.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");

      sendMessage.mockClear();
      sendUserMessage.mockClear();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0].content).not.toContain("answer v2");
      expect(sendUserMessage).not.toHaveBeenCalled();
    });

    it("does not call sendUserMessage when output.md is missing", async () => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      // Intentionally NOT writing output.md

      const sendMessage = installDeliverySpies();
      const sendUserMessage = vi.fn();
      await mod.pollArtifactChanges({ sendMessage, sendUserMessage } as any);

      expect(sendUserMessage).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0][0].content).toContain(
        "(no immutable output available)",
      );
    });

    it("does not snapshot mutable output.md for legacy completions", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      state.notifyOnComplete = "inject";
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      // Turn 2.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      const v1Path = join(art.dir, "output-1.md");
      const v2Path = join(art.dir, "output-2.md");
      expect(existsSync(v1Path)).toBe(false);
      expect(existsSync(v2Path)).toBe(false);
    });

    it("does not snapshot legacy output when notifyOnComplete is unset", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined.
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);
    });

    it("never creates legacy snapshots while mutable output changes", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const { state, artifactDir } = makeState();
      // notifyOnComplete left undefined (default inject).
      mod.interactiveSubagentRegistry.set(state.id, state);
      const art = artifactPath(join(artifactDir, ".."), state.id);

      // Turn 1 completes with mutable legacy output.
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v1");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);

      // Follow-up turn: the child overwrites output.md but its done event has NOT landed yet
      // (last event is still the turn-1 done@ts2). A poll lands in this window.
      writeOutput(art, "answer v2 in progress");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);

      // A second legacy completion remains pointer-only.
      appendEvent(art, { ts: 3, type: "done", status: "done", exitCode: 0 });
      writeOutput(art, "answer v2 final");
      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);
      expect(existsSync(join(art.dir, "output-1.md"))).toBe(false);
      expect(existsSync(join(art.dir, "output-2.md"))).toBe(false);
    });
  });

  // ── Bug B regression tests (stale footer/widget for closed sub-agents) ──
  // When a sub-agent is "exited" (terminal, pane dead) the for-loop at line
  // ~518 of subagent.ts must still tail-read the session log (for user-role
  // revival, but it must NOT contribute to the active footer count or
  // the `widgetRows` list. `idle` sub-agents (between turns, REPL open) are
  // still live and DO contribute to the active count.
  describe("footer/widget (Bug B)", () => {
    it("AC-B1: counts running + idle as 'active'; excludes exited from both footer and widget", async () => {
      // One successful listing serves every probe: two panes are present and
      // the third is conclusively absent.
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") {
            const paneId = args[3];
            if (paneId === "%92") {
              throw missingTmuxPaneError("%92");
            }
            return Buffer.from(paneId ?? "");
          }
          return "";
        },
        execFile: (
          _file: string,
          args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) =>
          callback(
            args[3] === "%92" ? missingTmuxPaneError("%92") : null,
            args[3],
          ),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

      // Running sub-agent: no events in artifact; pane alive.
      const running = makeState().state;
      running.id = "running-1";
      running.paneId = "%90";
      mod.interactiveSubagentRegistry.set(running.id, running);

      // Idle sub-agent: done event, pane alive. artifactDir must be set so the
      // poller reads from the same dir where we write the events.
      const idle = makeState().state;
      idle.id = "idle-1";
      idle.paneId = "%91";
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
      exited.paneId = "%92";
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

      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 2 sub-agents active",
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

    it("AC-B1b: rehydrates a completed live pane as idle and ready", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const multiplexer = await import("../src/multiplexer");
      multiplexer.__setTmuxMultiplexer({
        isAvailable: () => true,
        isPaneAlive: () => true,
        observePane: async (): Promise<PaneLiveness> => ({ kind: "alive" }),
      } as any);
      const cwd = makeTmp();
      const id = "rehydrated-idle";
      const artifactDir = join(cwd, id);
      mkdirSync(artifactDir, { recursive: true });
      const art = artifactPath(cwd, id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, {
        ts: 2,
        type: "done",
        status: "done",
        exitCode: 0,
      });
      appendInteractiveState(cwd, {
        id,
        paneId: "%idle-pane",
        windowName: "demo",
        mux: "tmux",
        artifactDir,
        sessionFile: "/tmp/sess.jsonl",
        parentSessionId: "pi",
        eventByteCursor: eventLogEndOffset(art),
        lifecycle: {
          completionTurnId: "turn-1",
          completionOutcome: "done",
          completionSource: "explicit",
        },
      });
      mod.rehydrateInteractiveSubagents(cwd, "pi");
      const state = mod.interactiveSubagentRegistry.get(id)!;
      expect(state.status).toBe("idle");
      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(state.status).toBe("idle");
      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 1 sub-agent active",
      );
      const widgetRows = setWidget.mock.calls[0][1] as string[];
      expect(widgetRows).toContain(
        "○ rehydrated-idle: idle — ready for follow-up",
      );
      expect(widgetRows.join("\n")).not.toContain("starting");
      expect(widgetRows.join("\n")).not.toContain("stale");
      multiplexer.__setTmuxMultiplexer(undefined);
      delete (globalThis as any).__piSubagenturaUi;
    });

    it("AC-B2: clears footer and widget when all sub-agents are exited", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "-lc") return Buffer.from("");
          throw missingTmuxPaneError();
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(missingTmuxPaneError(), ""),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");

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

      await mod.pollArtifactChanges({
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

    it("AC-B3: combines interactive and in-process footer counts", async () => {
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: (_file: string, args: string[]) => {
          if (args[0] === "display-message") return Buffer.from("%99");
          return "";
        },
        execFile: (
          _file: string,
          _args: string[],
          _options: object,
          callback: (error: Error | null, stdout?: string) => void,
        ) => callback(null, "%99"),
      }));
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      mod.jobRegistry.set("async-1", { status: "running" } as any);

      const a = makeState().state;
      a.id = "a";
      mod.interactiveSubagentRegistry.set(a.id, a);
      const b = makeState().state;
      b.id = "b";
      mod.interactiveSubagentRegistry.set(b.id, b);

      const setStatus = vi.fn();
      const setWidget = vi.fn();
      (globalThis as any).__piSubagenturaUi = { setStatus, setWidget };

      await mod.pollArtifactChanges({
        sendMessage: vi.fn(),
        sendUserMessage: vi.fn(),
      } as any);

      expect(setStatus).toHaveBeenCalledWith(
        "subagentura-running",
        "⚡ 3 sub-agents active",
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
    g.__piSubagenturaSessionManager = undefined;
    getSessionContextStack().length = 0;
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
    });
    return { id, cwd, state };
  }

  it("does not remove another owner's persisted terminal state", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    state.parentSessionId = "session-b";
    state.status = "exited";
    mod.interactiveSubagentRegistry.set(id, state);
    const ownerA = { id: 601, generation: 1 };
    registerSessionContext({
      ...ownerA,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    registerSessionContext({
      id: 602,
      generation: 1,
      pi: { sendMessage: vi.fn() } as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();

    await mod.pollArtifactChanges({} as any, ownerA);

    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
  });

  it("keeps terminal state until the custom-message receipt is visible", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw missingTmuxPaneError();
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(missingTmuxPaneError(), ""),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({ state: "dispatchAttempted" }),
    ]);
  });

  it("reconciles same-session inject receipt before terminal cleanup", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw missingTmuxPaneError();
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(missingTmuxPaneError(), ""),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    state.notifyOnComplete = "inject";
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });
    const entries: unknown[] = [];
    (globalThis as any).__piSubagenturaSessionManager = {
      getEntries: () => entries,
    };
    await mod.pollArtifactChanges({
      sendMessage: vi.fn((message) => {
        entries.push({ type: "custom_message", details: message.details });
      }),
    } as any);

    expect(state.pendingDeliveries).toEqual([]);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
  });

  it("keeps the state.json entry after delivering a done event when the pane is alive", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.status).toBe("idle");
  });

  it("keeps a live pane idle after a v2 error completion", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
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
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.status).toBe("idle");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
  });

  it("removes state after process_exited even if pane liveness reports true", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("%99");
        return "";
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
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

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.status).toBe("exited");
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
  });

  it("keeps error state until the custom-message receipt is visible", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({ state: "dispatchAttempted", status: "error" }),
    ]);
  });

  it("keeps cancelled state until the custom-message receipt is visible", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "cancelled", status: "cancelled" });

    installDeliverySpies();
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(loaded?.states[id].pendingDeliveries).toEqual([
      expect.objectContaining({
        state: "dispatchAttempted",
        status: "cancelled",
      }),
    ]);
  });

  it("persists confirmed pane death before a later reload", async () => {
    const mod = await importFresh<typeof SubagentModule>("../src/subagent");
    // importFresh resets the module graph; use its matching mux singleton.
    const multiplexer = await import("../src/multiplexer");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: "dead" }),
    } as unknown as Multiplexer);

    await mod.pollArtifactChanges({
      sendMessage: vi.fn(),
    } as unknown as Parameters<typeof mod.pollArtifactChanges>[0]);

    expect(state.status).toBe("unknown");
    expect(loadInteractiveStates(cwd)?.states[id].paneDeathConfirmed).toBe(
      true,
    );
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("retains parent-cancelled state when an in-flight poll observed a live pane", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const interactive = await import("../src/interactive-tmux");
    const multiplexer = await import("../src/multiplexer");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    let resolveObservation!: () => void;
    let observationStarted = false;
    const observation = new Promise<void>((resolve) => {
      resolveObservation = resolve;
    });
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => {
        observationStarted = true;
        await observation;
        return { kind: "alive" };
      },
      isPaneAlive: () => true,
      killPane: vi.fn(),
    } as unknown as import("../src/multiplexer").Multiplexer);
    const pi = {
      sendMessage: vi.fn(),
    } as unknown as Parameters<typeof mod.pollArtifactChanges>[0];

    const polling = mod.pollArtifactChanges(pi);
    await Promise.resolve();
    expect(observationStarted).toBe(true);
    interactive.cancelInteractiveSubagent(id);
    resolveObservation();
    await polling;

    expect(state.status).toBe("cancelled");
    expect(mod.interactiveSubagentRegistry.get(id)).toBe(state);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("does not retire cancelled state when pane observation is unavailable", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const multiplexer = await import("../src/multiplexer");
    const { cwd, id, state } = makePersistedState();
    state.status = "cancelled";
    mod.interactiveSubagentRegistry.set(id, state);
    let observation: "unavailable" | "dead" = "unavailable";
    multiplexer.__setTmuxMultiplexer({
      observePane: async (): Promise<PaneLiveness> => ({ kind: observation }),
    } as unknown as import("../src/multiplexer").Multiplexer);
    const pi = {
      sendMessage: vi.fn(),
    } as unknown as Parameters<typeof mod.pollArtifactChanges>[0];

    await mod.pollArtifactChanges(pi);

    expect(mod.interactiveSubagentRegistry.get(id)).toBe(state);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeDefined();

    observation = "dead";
    await mod.pollArtifactChanges(pi);
    expect(loadInteractiveStates(cwd)?.states[id]).toBeUndefined();
    multiplexer.__setTmuxMultiplexer(undefined);
  });

  it("keeps the state.json entry and cursor when notification delivery fails", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { cwd, id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, {
      ts: 1,
      type: "error",
      status: "error",
      message: "boom",
    });

    (globalThis as any).__piSubagenturaUi = {
      notify: vi.fn(() => {
        throw new Error("stale pi");
      }),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    };
    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[id]).toBeDefined();
    expect(state.eventByteCursor).toBeGreaterThan(0);
    expect(state.pendingDeliveries).toHaveLength(1);
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
      ) => callback(null, "%99"),
    }));
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
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

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

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
      artifactDir: "/tmp/art-" + id,
    };
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath("/tmp", id);
    appendEvent(art, { ts: 1, type: "done", status: "done", exitCode: 0 });

    await expect(
      mod.pollArtifactChanges({ sendMessage: vi.fn() } as any),
    ).resolves.toBeUndefined();
  });

  it("advances eventByteCursor before removing the state entry", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { id, state } = makePersistedState();
    mod.interactiveSubagentRegistry.set(id, state);
    const art = artifactPath(join(state.artifactDir, ".."), id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any);

    expect(state.eventByteCursor).toBe(eventLogEndOffset(art));
  });
});
