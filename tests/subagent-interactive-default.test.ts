/**
 * Focused tool-lifecycle coverage for interactive notification defaults and
 * prompt running-footer refreshes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  mockCancelInteractiveSubagent,
  mockLaunchInteractiveSubagent,
  mockPruneDeadInteractiveSubagents,
  mockUpsertOrchestratorRoutingEntry,
} = vi.hoisted(() => ({
  mockCancelInteractiveSubagent: vi.fn(),
  mockLaunchInteractiveSubagent: vi.fn(),
  mockPruneDeadInteractiveSubagents: vi.fn(),
  mockUpsertOrchestratorRoutingEntry: vi.fn(),
}));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
    cancelInteractiveSubagent: mockCancelInteractiveSubagent,
    pruneDeadInteractiveSubagents: mockPruneDeadInteractiveSubagents,
  };
});

vi.mock("../src/orchestrator-routing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/orchestrator-routing")>();
  return {
    ...actual,
    upsertOrchestratorRoutingEntry: mockUpsertOrchestratorRoutingEntry,
  };
});

import registerExtension from "../src/subagent";
import {
  formatInteractiveState,
  interactiveSubagentRegistry,
} from "../src/interactive-tmux";
import {
  clearSessionScopes,
  getStartedSessionScopes,
  registerSessionScope,
} from "../src/session-scope";
import { InteractiveParams } from "../src/schemas";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";

const savedTmux = process.env.TMUX;

/** Minimal ctx for the tool's execute signature. */
function mockCtx() {
  return {
    cwd: "/tmp",
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("test-session-id"),
    },
  };
}

/** Find the subagent_interactive tool def from the registered API. */
function getInteractiveToolDef(api: {
  registerTool: ReturnType<typeof vi.fn>;
}) {
  return api.registerTool.mock.calls.find(
    ([t]: any[]) => t.name === "subagent_interactive",
  )?.[0];
}

function getCancelToolDef(api: { registerTool: ReturnType<typeof vi.fn> }) {
  return api.registerTool.mock.calls.find(
    ([tool]: any[]) => tool.name === "cancel_interactive_subagent",
  )?.[0];
}

function getStatusToolDef(api: { registerTool: ReturnType<typeof vi.fn> }) {
  return api.registerTool.mock.calls.find(
    ([tool]: any[]) => tool.name === "get_interactive_subagent_status",
  )?.[0];
}

function mockInteractiveState(status = "running") {
  return {
    id: "abc12345",
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: "/tmp/sess.jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    status,
    mux: "tmux",
    attachCommand: "tmux attach -t s",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir: "/tmp/artifacts/abc12345",
  };
}

describe("subagent_interactive tool lifecycle", () => {
  let api: ReturnType<typeof setupExtension>;

  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api;
  }

  /** Bind ui + sessionManager onto the registered session context. */
  async function startSession(ctx: ReturnType<typeof mockCtx>): Promise<void> {
    const handler = (api.on as any).mock.calls.find(
      ([event]: [string]) => event === "session_start",
    )?.[1] as Function;
    await handler({ reason: "new" }, ctx);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    clearSessionScopes();
    const g = globalThis as any;
    g.__piSubagenturaInteractivePollerHandle = undefined;
    api = setupExtension() as any;
    await startSession(mockCtx());
    mockLaunchInteractiveSubagent.mockReset();
    mockCancelInteractiveSubagent.mockReset();
    mockPruneDeadInteractiveSubagents.mockReset();
    mockUpsertOrchestratorRoutingEntry.mockReset();
    mockCancelInteractiveSubagent.mockReturnValue(
      mockInteractiveState("cancelled"),
    );
    mockLaunchInteractiveSubagent.mockReturnValue(mockInteractiveState());
  });

  afterEach(() => {
    interactiveSubagentRegistry.clear();
    clearSessionScopes();
    const g = globalThis as any;
    if (g.__piSubagenturaInteractivePollerHandle) {
      clearInterval(g.__piSubagenturaInteractivePollerHandle);
      g.__piSubagenturaInteractivePollerHandle = undefined;
    }
    vi.clearAllMocks();
    if (savedTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = savedTmux;
  });

  it("shows focus instead of nested attach guidance inside tmux", async () => {
    const toolDef = getInteractiveToolDef(api);
    process.env.TMUX = "/tmp/tmux.sock,1,0";

    const insideResult = await toolDef.execute(
      "call-inside-tmux",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(insideResult.content[0].text).not.toContain("Attach: tmux attach");
    expect(insideResult.content[0].text).toContain("Focus: tmux select-pane");
    const insideStatus = formatInteractiveState(mockInteractiveState() as any);
    expect(insideStatus).not.toContain("Attach: tmux attach");
    expect(insideStatus).toContain("Focus: tmux select-pane");

    delete process.env.TMUX;
    const outsideResult = await toolDef.execute(
      "call-outside-tmux",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(outsideResult.content[0].text).toContain("Attach: tmux attach");
    expect(formatInteractiveState(mockInteractiveState() as any)).toContain(
      "Attach: tmux attach",
    );

    process.env.TMUX = "/tmp/tmux.sock,1,0";
    const zellijState = {
      ...mockInteractiveState(),
      mux: "zellij",
      attachCommand: "zellij attach child-session",
      selectPaneCommand: "zellij action focus-pane --pane-id 42",
    };
    mockLaunchInteractiveSubagent.mockReturnValueOnce(zellijState);
    const zellijResult = await toolDef.execute(
      "call-zellij",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(zellijResult.content[0].text).toContain(
      "Attach: zellij attach child-session",
    );
    expect(formatInteractiveState(zellijState as any)).toContain(
      "Attach: zellij attach child-session",
    );
  });

  it("defaults to notify + automatic triggering when both params are omitted", async () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute(
      "call-1",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    const callArgs = mockLaunchInteractiveSubagent.mock.calls[0][0];
    expect(callArgs.notifyOnComplete).toBe("notify");
    expect(callArgs.triggerTurnOnComplete).toBe(true);
    expect(callArgs.contextText).toBeNull();
    expect(mockUpsertOrchestratorRoutingEntry).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("passes explicit context directly without reading the parent branch", async () => {
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();

    await toolDef.execute(
      "call-explicit-context",
      {
        task: "research X",
        includeContext: false,
        context: "EXPLICIT-CONTEXT-MARKER",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(mockLaunchInteractiveSubagent.mock.calls[0][0].contextText).toBe(
      "EXPLICIT-CONTEXT-MARKER",
    );
  });

  it("uses only the serialized parent branch when includeContext is true", async () => {
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();
    ctx.sessionManager.getBranch.mockReturnValue([
      {
        type: "message",
        message: { role: "user", content: "PARENT-BRANCH-MARKER" },
      },
    ]);

    await toolDef.execute(
      "call-parent-context",
      {
        task: "research X",
        includeContext: true,
        context: "EXPLICIT-CONTEXT-MUST-NOT-BE-CONCATENATED",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.sessionManager.getBranch).toHaveBeenCalledOnce();
    const contextText = mockLaunchInteractiveSubagent.mock.calls[0][0]
      .contextText as string;
    expect(contextText).toContain("PARENT-BRANCH-MARKER");
    expect(contextText).not.toContain(
      "EXPLICIT-CONTEXT-MUST-NOT-BE-CONCATENATED",
    );
  });

  it("persists initial routing metadata only after a successful spawn", async () => {
    const toolDef = getInteractiveToolDef(api);
    const state = {
      ...mockInteractiveState(),
      id: "0123456789abcdef",
      artifactDir: "/tmp/artifacts/0123456789abcdef",
    };
    const entry = {
      childId: state.id,
      description: "Own the API migration",
      aliases: ["api", "migration"],
      provenance: "orchestratorv2" as const,
    };
    mockLaunchInteractiveSubagent.mockReturnValueOnce(state);
    mockUpsertOrchestratorRoutingEntry.mockReturnValueOnce({
      records: [entry],
    });

    const result = await toolDef.execute(
      "call-routing-metadata",
      {
        task: "research X",
        routingDescription: entry.description,
        routingAliases: entry.aliases,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledOnce();
    expect(mockUpsertOrchestratorRoutingEntry).toHaveBeenCalledWith(
      "/tmp",
      entry,
    );
    expect(
      mockLaunchInteractiveSubagent.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockUpsertOrchestratorRoutingEntry.mock.invocationCallOrder[0],
    );
    expect(result.details).toMatchObject({
      status: "started",
      routingMetadata: { status: "persisted", entry },
    });

    mockLaunchInteractiveSubagent.mockReset();
    mockUpsertOrchestratorRoutingEntry.mockClear();
    mockLaunchInteractiveSubagent.mockImplementationOnce(() => {
      throw new Error("mux unavailable");
    });
    const failed = await toolDef.execute(
      "call-routing-spawn-failure",
      {
        task: "research X",
        routingDescription: entry.description,
        routingAliases: entry.aliases,
      },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(failed.details.status).toBe("error");
    expect(mockUpsertOrchestratorRoutingEntry).not.toHaveBeenCalled();
  });

  it("rejects routing metadata that cannot persist before spawning", async () => {
    const toolDef = getInteractiveToolDef(api);

    const aliasesOnly = await toolDef.execute(
      "call-routing-aliases-only",
      { task: "research X", routingAliases: ["api"] },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(aliasesOnly.isError).toBe(true);
    expect(aliasesOnly.details).toMatchObject({
      status: "invalid_routing_metadata",
    });

    const oversizedDescription = "😀".repeat(2048);
    const oversized = await toolDef.execute(
      "call-routing-oversized",
      { task: "research X", routingDescription: oversizedDescription },
      undefined,
      undefined,
      mockCtx(),
    );
    expect(oversized.isError).toBe(true);
    expect(oversized.details).toMatchObject({
      status: "invalid_routing_metadata",
      error: expect.stringContaining("description exceeds 4096 bytes"),
    });
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(mockUpsertOrchestratorRoutingEntry).not.toHaveBeenCalled();
  });

  it("reports routing persistence failure without pretending the child failed", async () => {
    const toolDef = getInteractiveToolDef(api);
    const state = {
      ...mockInteractiveState(),
      id: "0123456789abcdef",
      artifactDir: "/tmp/artifacts/0123456789abcdef",
    };
    mockLaunchInteractiveSubagent.mockReturnValueOnce(state);
    mockUpsertOrchestratorRoutingEntry.mockImplementationOnce(() => {
      throw new Error("routing record count exceeds 128");
    });

    const result = await toolDef.execute(
      "call-routing-warning",
      {
        task: "research X",
        routingDescription: "Own the API migration",
        routingAliases: ["api"],
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      id: state.id,
      status: "started",
      routingMetadata: {
        status: "warning",
        error: "routing record count exceeds 128",
      },
    });
    expect(result.content[0].text).toContain(
      `Interactive sub-agent ${state.id} started`,
    );
    expect(result.content[0].text).toContain(
      "Warning: initial routing metadata was not persisted: routing record count exceeds 128",
    );
    expect(result.content[0].text).not.toContain(
      "Failed to start interactive sub-agent",
    );
  });

  it("defaults explicit notify mode to automatic triggering", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-2",
      { task: "research X", notifyOnComplete: "notify" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("notify");
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(true);
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("explains explicit inject mode with automatic turn triggering disabled", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-3",
      {
        task: "research X",
        notifyOnComplete: "inject",
        triggerTurnOnComplete: false,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("inject");
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(false);
    expect(result.content[0].text).toContain(
      "Completion output will be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "No new parent turn will start automatically",
    );
  });

  it("forwards triggerTurnOnComplete when explicitly passed", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-trigger-turn",
      {
        task: "research X",
        notifyOnComplete: "notify",
        triggerTurnOnComplete: true,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(true);
    expect(result.content[0].text).toContain(
      "Completion output will not be injected into the parent LLM",
    );
    expect(result.content[0].text).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("updates the running footer immediately after launch", async () => {
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();
    await startSession(ctx);
    const state = {
      ...mockInteractiveState(),
      parentSessionId: "test-session-id",
    };
    mockLaunchInteractiveSubagent.mockImplementationOnce(() => {
      interactiveSubagentRegistry.set(state.id, state as any);
      getStartedSessionScopes()[0]?.interactiveStates.set(
        state.id,
        state as any,
      );
      return state;
    });

    await toolDef.execute(
      "call-footer-launch",
      { task: "research X" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });

  it("counts only this session's agents once the session context is bound", async () => {
    // The reachable production path: the tool passes the raw active token and
    // updateRunningSubagentFooter owns the scoping decision.
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();
    await startSession(ctx);
    const mine = {
      ...mockInteractiveState(),
      parentSessionId: "test-session-id",
    };
    const foreign = {
      ...mockInteractiveState(),
      id: "def67890",
      parentSessionId: "another-session-id",
    };
    interactiveSubagentRegistry.set(foreign.id, foreign as any);
    mockLaunchInteractiveSubagent.mockImplementationOnce(() => {
      interactiveSubagentRegistry.set(mine.id, mine as any);
      getStartedSessionScopes()[0]?.interactiveStates.set(mine.id, mine as any);
      return mine;
    });

    await toolDef.execute(
      "call-footer-scoped",
      { task: "research X" },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      "⚡ 1 sub-agent active",
    );
  });

  it("reports no agents when the active session context is already stale", async () => {
    // A stale token must read as "this session owns nothing", never fall back to
    // a cross-session global count.
    const toolDef = getInteractiveToolDef(api);
    const ctx = mockCtx();
    await startSession(ctx);
    const foreign = {
      ...mockInteractiveState(),
      id: "def67890",
      parentSessionId: "another-session-id",
    };
    interactiveSubagentRegistry.set(foreign.id, foreign as any);
    const [scope] = getStartedSessionScopes();
    if (scope) scope.lifecycle = "shutdown";

    const result = await toolDef.execute(
      "call-footer-stale",
      { task: "research X" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("session_unavailable");
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
  });

  it("refreshes the footer when status pruning detects an exit", async () => {
    const toolDef = getStatusToolDef(api);
    const ctx = mockCtx();
    const state = mockInteractiveState();
    interactiveSubagentRegistry.set(state.id, state as any);
    getStartedSessionScopes()[0]?.interactiveStates.set(state.id, state as any);
    mockPruneDeadInteractiveSubagents.mockImplementationOnce(() => {
      state.status = "exited";
    });

    await toolDef.execute(
      "call-footer-exit",
      { jobId: state.id },
      undefined,
      undefined,
      ctx,
    );

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      undefined,
    );
  });
  it("preserves explicit false triggering for notify mode", async () => {
    const toolDef = getInteractiveToolDef(api);

    const result = await toolDef.execute(
      "call-notify-no-trigger",
      {
        task: "research X",
        notifyOnComplete: "notify",
        triggerTurnOnComplete: false,
      },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].triggerTurnOnComplete,
    ).toBe(false);
    expect(result.content[0].text).toContain(
      "No new parent turn will start automatically",
    );
  });

  it("notifies the user without scheduling another LLM completion when cancelled", async () => {
    const toolDef = getCancelToolDef(api);
    const ctx = mockCtx();
    const state = mockInteractiveState();
    interactiveSubagentRegistry.set(state.id, state as any);
    getStartedSessionScopes()[0]?.interactiveStates.set(state.id, state as any);
    mockCancelInteractiveSubagent.mockImplementationOnce(() => {
      state.status = "cancelled";
      return state;
    });

    const result = await toolDef.execute(
      "call-cancel",
      { jobId: "abc12345" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockCancelInteractiveSubagent).toHaveBeenCalledWith(
      "abc12345",
      "cancel_interactive_subagent",
      expect.objectContaining({ id: "abc12345" }),
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("no separate cancellation completion"),
      "warning",
    );
    expect(result.content[0].text).toContain(
      "No separate cancellation completion will be injected",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "subagentura-running",
      undefined,
    );
  });

  it("registers the intersected InteractiveParams schema and documents defaults", () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();
    const params = toolDef.parameters;
    expect(params).toBe(InteractiveParams);
    const [commonFields, contextModes] = (params as any).allOf;
    const properties = commonFields.properties;
    expect(properties).toBeDefined();
    expect(properties.notifyOnComplete).toBeDefined();
    expect(properties.triggerTurnOnComplete).toBeDefined();
    expect(properties.routingDescription).toBeDefined();
    expect(properties.routingAliases).toBeDefined();
    expect(contextModes.anyOf).toHaveLength(3);
    // Description must document 'notify' as the default and 'inject' as a valid
    // alternative.
    const desc = properties.notifyOnComplete.description ?? "";
    expect(desc).toMatch(/notify.*default|default.*notify/i);
    expect(desc).toContain('"inject"');
  });

  it("isolates peer status, cancel, send, list, and read tools", async () => {
    clearSessionScopes();
    interactiveSubagentRegistry.clear();
    const toolsA = new Map<string, { execute: Function }>();
    const toolsB = new Map<string, { execute: Function }>();
    const piA = {
      registerTool: (tool: { name: string; execute: Function }) =>
        toolsA.set(tool.name, tool),
    };
    const piB = {
      registerTool: (tool: { name: string; execute: Function }) =>
        toolsB.set(tool.name, tool),
    };
    const scopeA = registerSessionScope({
      id: 901,
      generation: 1,
      lifecycle: "started",
      pi: piA as unknown as Parameters<
        typeof registerInteractiveSubagentTools
      >[0],
      sessionManager: { getSessionId: () => "peer-a" },
    });
    const scopeB = registerSessionScope({
      id: 902,
      generation: 1,
      lifecycle: "started",
      pi: piB as unknown as Parameters<
        typeof registerInteractiveSubagentTools
      >[0],
      sessionManager: { getSessionId: () => "peer-b" },
    });
    registerInteractiveSubagentTools(scopeA.pi, scopeA);
    registerInteractiveSubagentTools(scopeB.pi, scopeB);
    const owned = {
      ...mockInteractiveState(),
      id: "aaaaaaaaaaaaaaaa",
      parentSessionId: "peer-a",
    };
    const foreign = {
      ...mockInteractiveState(),
      id: "bbbbbbbbbbbbbbbb",
      parentSessionId: "peer-b",
    };
    scopeA.interactiveStates.set(owned.id, owned as never);
    scopeB.interactiveStates.set(foreign.id, foreign as never);
    interactiveSubagentRegistry.set(owned.id, owned as never);
    interactiveSubagentRegistry.set(foreign.id, foreign as never);

    const ctx = mockCtx();
    interactiveSubagentRegistry.delete(owned.id);
    mockCancelInteractiveSubagent.mockClear();
    const ownedCancel = await toolsA
      .get("cancel_interactive_subagent")
      ?.execute("cancel-owned", { jobId: owned.id }, undefined, undefined, ctx);
    expect(ownedCancel.isError).not.toBe(true);
    expect(mockCancelInteractiveSubagent).toHaveBeenCalledOnce();
    interactiveSubagentRegistry.set(owned.id, owned as never);

    const status = await toolsA
      .get("get_interactive_subagent_status")
      ?.execute("status", {}, undefined, undefined, ctx);
    expect(
      status.details.subagents.map((state: { id: string }) => state.id),
    ).toEqual([owned.id]);
    const foreignStatus = await toolsA
      .get("get_interactive_subagent_status")
      ?.execute(
        "status-foreign",
        { jobId: foreign.id },
        undefined,
        undefined,
        ctx,
      );
    expect(foreignStatus.details.status).toBe("not_found");

    mockCancelInteractiveSubagent.mockClear();
    const cancel = await toolsA
      .get("cancel_interactive_subagent")
      ?.execute("cancel", { jobId: foreign.id }, undefined, undefined, ctx);
    expect(cancel.details.status).toBe("not_found");
    expect(mockCancelInteractiveSubagent).not.toHaveBeenCalled();

    const send = await toolsA
      .get("send_interactive_subagent_message")
      ?.execute("send", { id: foreign.id, message: "hello" });
    expect(send.details.status).toBe("not_found");

    const list = await toolsA
      .get("list_subagent_artifacts")
      ?.execute("list", {}, undefined, undefined, ctx);
    expect(
      list.details.subagents.map((state: { id: string }) => state.id),
    ).toEqual([owned.id]);

    const read = await toolsA
      .get("read_subagent_artifact")
      ?.execute("read", { id: foreign.id }, undefined, undefined, {
        ...ctx,
        cwd: "/tmp",
      });
    expect(read.details.status).toBe("not_found");
  });

  it("cleanup deletes only artifacts marked for the current parent session", async () => {
    const root = mkdtempSync(join(tmpdir(), "interactive-cleanup-scope-"));
    try {
      const ownedDir = join(root, "cccccccccccccccc");
      const foreignDir = join(root, "dddddddddddddddd");
      for (const [dir, owner] of [
        [ownedDir, "test-session-id"],
        [foreignDir, "another-session-id"],
      ] as const) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "events.ndjson"), "");
        writeFileSync(join(dir, ".parent-session-id"), owner);
        utimesSync(dir, new Date(0), new Date(0));
      }
      const cleanup = api.registerTool.mock.calls.find(
        ([tool]: any[]) => tool.name === "cleanup_subagent_artifacts",
      )?.[0];
      const result = await cleanup.execute(
        "cleanup",
        { ttlMs: 60_000, rootDir: root, dryRun: false },
        undefined,
        undefined,
        mockCtx(),
      );
      expect(result.details.removed).toBe(1);
      expect(existsSync(ownedDir)).toBe(false);
      expect(existsSync(foreignDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
