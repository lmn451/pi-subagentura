import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, readEvents } from "../src/artifact";
import { readActiveTurn, registerChildProtocol } from "../src/child-protocol";

function registerHandlers() {
  const handlers = new Map<string, Function>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
  };
  registerChildProtocol(pi as any);
  return handlers;
}

describe("child protocol lifecycle", () => {
  let root: string;
  let artifactDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "pi-subagentura-child-protocol-"));
    artifactDir = join(root, "child");
    process.env.ARTIFACT_DIR = artifactDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ARTIFACT_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("binds persisted turns and records activity plus settled completion", () => {
    const handlers = registerHandlers();
    let entries: any[] = [];
    const ctx = {
      sessionManager: {
        getEntries: () => entries,
      },
    };

    handlers.get("before_agent_start")!({}, ctx);
    expect(readActiveTurn()?.started).toBe(false);

    entries = [{ id: "user-1", type: "message", message: { role: "user" } }];
    handlers.get("turn_start")!({ timestamp: 100 }, ctx);
    vi.runAllTimers();
    expect(readActiveTurn()).toMatchObject({ turnId: "user-1", started: true });

    entries.push({ id: "user-2", type: "message", message: { role: "user" } });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "tool-1" },
      ctx,
    );
    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "tool-1", isError: true },
      ctx,
    );
    handlers.get("agent_end")!(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readActiveTurn()).toMatchObject({
      turnId: "user-2",
      previousUserEntryId: "user-1",
      started: true,
    });
    const events = readEvents(artifactPath(root, "child"));
    expect(
      events.filter((event) => event.type === "turn_started"),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          event.type === "tool_activity" &&
          "turnId" in event &&
          event.turnId === "user-2",
      ),
    ).toMatchObject([
      { phase: "start", tool: "bash" },
      { phase: "end", summary: "bash failed" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completion",
      turnId: "user-2",
      outcome: "done",
      source: "agent_settled",
    });
    expect(events.at(-1)).not.toHaveProperty("agentStopReason");
  });

  it("retains the newest active tool across concurrent starts", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "tool-1" },
      ctx,
    );
    handlers.get("tool_execution_start")!(
      { toolName: "npm_test", toolCallId: "tool-2" },
      ctx,
    );

    expect(readActiveTurn()).toMatchObject({
      activeTools: [
        { name: "bash", callId: "tool-1" },
        { name: "npm_test", callId: "tool-2" },
      ],
      lastTool: "npm_test",
    });

    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "tool-1" },
      ctx,
    );
    expect(readActiveTurn()).toMatchObject({
      activeTools: [{ name: "npm_test", callId: "tool-2" }],
      lastTool: "npm_test",
    });

    handlers.get("tool_execution_end")!(
      { toolName: "npm_test", toolCallId: "tool-2" },
      ctx,
    );
    expect(readActiveTurn()).toMatchObject({
      activeTools: [],
      lastTool: "npm_test",
    });
  });

  it("records an error completion and supports getBranch fallback", () => {
    const handlers = registerHandlers();
    let branch: any[] = [];
    const ctx = {
      sessionManager: {
        getBranch: () => branch,
      },
    };

    handlers.get("before_agent_start")!({}, ctx);
    branch = [{ id: "user-error", type: "message", message: { role: "user" } }];
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider failed",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readEvents(artifactPath(root, "child")).at(-1)).toMatchObject({
      type: "completion",
      turnId: "user-error",
      outcome: "error",
      exitCode: 1,
      errorMessage: "provider failed",
      agentStopReason: "error",
    });
  });

  it("records an aborted assistant settlement as a quietable error", () => {
    const handlers = registerHandlers();
    const entries: any[] = [];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    entries.push({
      id: "user-aborted",
      type: "message",
      message: { role: "user" },
    });
    handlers.get("turn_start")!({ timestamp: 100 }, ctx);
    vi.runAllTimers();
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "aborted",
            errorMessage: "Operation aborted",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readEvents(artifactPath(root, "child")).at(-1)).toMatchObject({
      type: "completion",
      turnId: "user-aborted",
      outcome: "error",
      source: "agent_settled",
      agentStopReason: "aborted",
      errorMessage: "Operation aborted",
    });
  });

  it("requires ARTIFACT_DIR when registering", () => {
    delete process.env.ARTIFACT_DIR;
    expect(() => registerHandlers()).toThrow(/requires ARTIFACT_DIR/);
  });
});

describe("active tool correlation regressions", () => {
  let root: string;
  let artifactDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(
      join(tmpdir(), "pi-subagentura-child-tools-regression-"),
    );
    artifactDir = join(root, "child");
    process.env.ARTIFACT_DIR = artifactDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ARTIFACT_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  it("keeps concurrent same-name opaque tool IDs distinct", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-opaque-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "call/1" },
      ctx,
    );
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "call/2" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toHaveLength(2);

    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "call/1" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toHaveLength(1);
    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "call/2" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toEqual([]);
  });

  it("never removes a different known-ID tool by name fallback", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-known-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "call-1" },
      ctx,
    );
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "call-2" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toHaveLength(2);

    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "unknown-call" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toHaveLength(2);

    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "call-2" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toMatchObject([
      { name: "bash", callId: "call-1" },
    ]);
  });

  it("bounds active tool records while retaining the newest starts", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-overflow-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    for (let index = 0; index < 17; index++) {
      handlers.get("tool_execution_start")!(
        { toolName: `tool_${index}`, toolCallId: `call-${index}` },
        ctx,
      );
    }

    const activeTools = readActiveTurn()?.activeTools ?? [];
    expect(activeTools).toHaveLength(16);
    expect(activeTools[0]?.name).toBe("tool_1");
    expect(activeTools.at(-1)?.name).toBe("tool_16");
  });
  it("retains concurrent same-name starts without IDs", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-missing-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!({ toolName: "bash" }, ctx);
    handlers.get("tool_execution_start")!({ toolName: "bash" }, ctx);
    expect(readActiveTurn()?.activeTools).toHaveLength(2);

    handlers.get("tool_execution_end")!({ toolName: "bash" }, ctx);
    expect(readActiveTurn()?.activeTools).toHaveLength(2);
  });

  it("does not deduplicate a missing-ID start against a known same-name call", () => {
    const handlers = registerHandlers();
    const entries = [
      { id: "turn-mixed-tools", type: "message", message: { role: "user" } },
    ];
    const ctx = { sessionManager: { getEntries: () => entries } };

    handlers.get("before_agent_start")!({}, ctx);
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "call-known" },
      ctx,
    );
    handlers.get("tool_execution_start")!({ toolName: "bash" }, ctx);
    expect(readActiveTurn()?.activeTools).toHaveLength(2);

    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "call-known" },
      ctx,
    );
    expect(readActiveTurn()?.activeTools).toHaveLength(1);
    handlers.get("tool_execution_end")!({ toolName: "bash" }, ctx);
    expect(readActiveTurn()?.activeTools).toEqual([]);
  });
});
