import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../src/interactive-tmux", () => ({
  isTmuxAvailable: () => false,
  cancelInteractiveSubagent: vi.fn(),
  cancelInteractiveSubagentByState: vi.fn(),
  registerInteractiveSubagentState: vi.fn(),
  removeInteractiveSubagentState: vi.fn(),
}));

import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { registerSessionHandlers } from "../src/session-handlers";
import {
  clearSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

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

function setupTools(pi: any, owner?: SessionScope) {
  const tools: Record<string, any> = {};
  pi.registerTool = (tool: any) => {
    tools[tool.name] = tool;
  };
  registerInProcessSubagentTools(pi, owner);
  return tools;
}

describe("async spawn shutdown handoff", () => {
  beforeEach(() => {
    mockStartSubagentJob.mockReset();
    clearSessionScopes();
  });

  afterEach(() => {
    clearSessionScopes();
  });

  it.each([
    ["subagent_isolated", { task: "late spawn", async: true }],
    ["subagent_with_context", { task: "late spawn", async: true }],
  ])(
    "discards a pending %s spawn after its parent shuts down",
    async (toolName, params) => {
      const gate = createStartGate();
      mockStartSubagentJob.mockReturnValue(gate.promise);
      const pi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      const parentScope = registerSessionHandlers(pi);
      const tools = setupTools(pi, parentScope);
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
      expect(parentScope.inProcessJobs.size).toBe(0);

      await shutdown({ reason: "quit" }, ctx);
      expect(parentScope.inProcessJobs.size).toBe(0);

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
      expect(parentScope.inProcessJobs.size).toBe(0);
      expect(start).not.toHaveBeenCalled();
      expect(disposeBeforeStart).toHaveBeenCalledOnce();
      expect(sessionAbort).toHaveBeenCalledOnce();
    },
  );

  it("starts a scope-owned isolated spawn when a peer is registered but unstarted", async () => {
    const gate = createStartGate();
    mockStartSubagentJob.mockReturnValue(gate.promise);
    const ctx = fakeCtx(false);
    const parentPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
    const parentScope = registerSessionHandlers(parentPi);
    parentScope.lifecycle = "started";
    parentScope.ui = ctx.ui;
    parentScope.sessionManager = ctx.sessionManager;
    const tools = setupTools(parentPi, parentScope);

    const otherPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
    const otherScope = registerSessionHandlers(otherPi);
    expect(otherScope.lifecycle).toBe("registered");

    expect(sessionOwner(otherScope)).not.toEqual(sessionOwner(parentScope));
    const spawn = tools.subagent_isolated.execute(
      "call",
      { task: "parent-owned spawn", async: true },
      undefined,
      undefined,
      ctx,
    );
    await Promise.resolve();
    expect(mockStartSubagentJob).toHaveBeenCalledOnce();
    expect(parentScope.lifecycle).toBe("started");

    const sessionAbort = vi.fn();
    const start = vi.fn(() => true);
    const disposeBeforeStart = vi.fn();
    gate.resolve({
      jobId: "parent-owned-job",
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
    expect(result.details.status).toBe("started");
    expect(parentScope.inProcessJobs.has("parent-owned-job")).toBe(true);
    expect(
      parentScope.inProcessJobs.get("parent-owned-job")?.deliveryOwner,
    ).toMatchObject({
      sessionScopeId: parentScope.id,
      sessionScopeGeneration: parentScope.generation,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(disposeBeforeStart).not.toHaveBeenCalled();
    expect(sessionAbort).not.toHaveBeenCalled();
  });

  it.each([
    ["subagent_isolated", { task: "nested spawn", async: true }],
    ["subagent_with_context", { task: "nested spawn", async: true }],
  ])(
    "starts a pending %s spawn when a peer scope becomes active",
    async (toolName, params) => {
      const gate = createStartGate();
      mockStartSubagentJob.mockReturnValue(gate.promise);
      const parentPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      const ctx = fakeCtx(toolName === "subagent_with_context");
      const parentScope = registerSessionHandlers(parentPi);
      parentScope.lifecycle = "started";
      parentScope.ui = ctx.ui;
      parentScope.sessionManager = ctx.sessionManager;
      const tools = setupTools(parentPi, parentScope);

      const spawn = tools[toolName].execute(
        "call",
        params,
        undefined,
        undefined,
        ctx,
      );
      await Promise.resolve();

      const childPi = { on: vi.fn(), sendMessage: vi.fn() } as any;
      const childScope = registerSessionHandlers(childPi);
      childScope.lifecycle = "started";
      childScope.ui = ctx.ui;
      childScope.sessionManager = ctx.sessionManager;

      const start = vi.fn(() => true);
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
      expect(parentScope.inProcessJobs.has(`${toolName}-nested-job`)).toBe(
        true,
      );
      expect(childScope.inProcessJobs.size).toBe(0);
      expect(disposeBeforeStart).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledOnce();
    },
  );
});
