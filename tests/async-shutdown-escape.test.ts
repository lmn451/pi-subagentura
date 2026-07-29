import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InteractiveSubagentState,
  InteractiveSubagentStatus,
} from "../src/interactive-tmux";

const { mockStartSubagentJob, createStartGate } = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
  createStartGate: () => {
    let resolve!: (value: any) => void;
    const promise = new Promise<any>((r) => (resolve = r));
    return { promise, resolve };
  },
}));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, startSubagentJob: mockStartSubagentJob };
});

vi.mock("../src/interactive-tmux", () => {
  const interactiveStatusForState = (
    state: InteractiveSubagentState,
  ): InteractiveSubagentStatus => state.status;
  const isInteractiveStateActive = (
    state: InteractiveSubagentState,
  ): boolean => {
    const status = interactiveStatusForState(state);
    return status === "running" || status === "idle";
  };

  return {
    interactiveSubagentRegistry: new Map<string, InteractiveSubagentState>(),
    interactiveStatusForState,
    isInteractiveStateActive,
    isTmuxAvailable: (): boolean => false,
    cancelInteractiveSubagent: vi.fn(),
    cancelInteractiveSubagentByState: vi.fn(),
  };
});

import { jobRegistry } from "../src/helpers";
import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { registerSessionHandlers } from "../src/session-handlers";

function fakeCtx(withContext: boolean) {
  return {
    cwd: "/tmp",
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
      getAll: () => [],
      find: () => undefined,
    },
    sessionManager: {
      getBranch: () =>
        withContext
          ? [{ type: "message", message: { role: "user", content: "Hi" } }]
          : [],
      getSessionId: () => "parent-session",
      getEntries: () => [],
    },
  } as any;
}

function setupTools() {
  const tools: Record<string, any> = {};
  registerInProcessSubagentTools({
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
  } as any);
  return tools;
}

describe("async spawn shutdown handoff", () => {
  beforeEach(() => {
    jobRegistry.clear();
    mockStartSubagentJob.mockReset();
    const g = globalThis as any;
    g.__piSubagenturaSessionContextStack = [];
    g.__piSubagenturaSessionContextIdCounter = 0;
    g.__piSubagenturaInteractivePollerHandle = undefined;
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
  });

  afterEach(() => {
    jobRegistry.clear();
    const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
    if (handle) clearInterval(handle);
  });

  it.each([
    ["subagent_isolated", { task: "late spawn", async: true }],
    ["subagent_with_context", { task: "late spawn", async: true }],
  ])(
    "discards a pending %s spawn after its parent shuts down",
    async (toolName, params) => {
      const gate = createStartGate();
      mockStartSubagentJob.mockReturnValue(gate.promise);
      const tools = setupTools();
      const pi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      registerSessionHandlers(pi);
      const ctx = fakeCtx(toolName === "subagent_with_context");
      const sessionStart = pi.on.mock.calls.find(
        ([name]: [string]) => name === "session_start",
      )![1] as Function;
      sessionStart({ reason: "new" }, ctx);
      const shutdown = pi.on.mock.calls
        .filter(([name]: [string]) => name === "session_shutdown")
        .at(-1)![1] as Function;

      const spawn = tools[toolName].execute(
        "call",
        params,
        undefined,
        undefined,
        ctx,
      );
      await Promise.resolve();
      expect(mockStartSubagentJob).toHaveBeenCalledOnce();
      expect(jobRegistry.size).toBe(0);

      await shutdown({ reason: "quit" }, ctx);
      expect(jobRegistry.size).toBe(0);

      const sessionAbort = vi.fn();
      const start = vi.fn();
      const disposeBeforeStart = vi.fn();
      gate.resolve({
        jobId: `${toolName}-late-job`,
        jobPromise: new Promise(() => {}),
        session: { abort: sessionAbort },
        start,
        disposeBeforeStart,
        liveStatus: {
          turn: 0,
          output: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
          },
        },
        modelLabel: "test/model",
      });

      const result = await spawn;
      expect(result.details.status).toBe("cancelled");
      expect(result.isError).toBe(true);
      expect(jobRegistry.size).toBe(0);
      expect(start).not.toHaveBeenCalled();
      expect(disposeBeforeStart).toHaveBeenCalledOnce();
      expect(sessionAbort).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["subagent_isolated", { task: "nested spawn", async: true }],
    ["subagent_with_context", { task: "nested spawn", async: true }],
  ])(
    "starts a pending %s spawn when a nested context becomes active",
    async (toolName, params) => {
      const gate = createStartGate();
      mockStartSubagentJob.mockReturnValue(gate.promise);
      const tools = setupTools();
      const parentPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      const ctx = fakeCtx(toolName === "subagent_with_context");
      const parentContext = registerSessionHandlers(parentPi);
      parentContext.lifecycle = "started";
      parentContext.ui = ctx.ui;
      parentContext.sessionManager = ctx.sessionManager;

      const spawn = tools[toolName].execute(
        "call",
        params,
        undefined,
        undefined,
        ctx,
      );
      await Promise.resolve();

      const childPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      const childContext = registerSessionHandlers(childPi);
      childContext.lifecycle = "started";
      childContext.ui = ctx.ui;
      childContext.sessionManager = ctx.sessionManager;

      const start = vi.fn();
      const disposeBeforeStart = vi.fn();
      gate.resolve({
        jobId: `${toolName}-nested-job`,
        jobPromise: new Promise(() => {}),
        session: { abort: vi.fn() },
        start,
        disposeBeforeStart,
        liveStatus: {
          turn: 0,
          output: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 0,
          },
        },
        modelLabel: "test/model",
      });

      const result = await spawn;
      expect(result.details.status).toBe("started");
      expect(jobRegistry.has(`${toolName}-nested-job`)).toBe(true);
      expect(disposeBeforeStart).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledOnce();
    },
  );
});
