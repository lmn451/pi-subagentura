import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, readEvents } from "../src/artifact";
import { writeCliScript } from "../src/subagent-artifact-cli";
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

  it.each([
    {
      label: "missing credentials",
      auth: { ok: false, error: "No API key found" },
    },
    { label: "empty compatibility result", auth: { ok: true, headers: {} } },
    { label: "configured credentials", auth: { ok: true, apiKey: "test-key" } },
  ])(
    "does not probe $label or fabricate a startup completion",
    async ({ auth }) => {
      const handlers = registerHandlers();
      const getApiKeyAndHeaders = vi.fn().mockResolvedValue(auth);
      const hasConfiguredAuth = vi.fn().mockReturnValue(false);
      let entries: any[] = [];
      const ctx = {
        model: { provider: "subagentura-faux", id: "faux-model" },
        modelRegistry: { getApiKeyAndHeaders, hasConfiguredAuth },
        sessionManager: { getEntries: () => entries },
      };
      for (const reason of ["startup", "reload"] as const) {
        await handlers.get("session_start")?.({ reason }, ctx);
        await Promise.resolve();
        expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
        expect(hasConfiguredAuth).not.toHaveBeenCalled();
        expect(readActiveTurn()).toBeNull();
        expect(readEvents(artifactPath(root, "child"))).toEqual([]);
      }
      handlers.get("before_agent_start")!({}, ctx);
      entries = [
        { id: "actual-user-turn", type: "message", message: { role: "user" } },
      ];
      handlers.get("turn_start")!({ timestamp: 100 }, ctx);
      vi.runAllTimers();
      handlers.get("agent_end")!(
        { messages: [{ role: "assistant", stopReason: "stop" }] },
        ctx,
      );
      handlers.get("agent_settled")!({}, ctx);
      const completions = readEvents(artifactPath(root, "child")).filter(
        (event) => event.type === "completion",
      );
      expect(completions).toMatchObject([
        {
          turnId: "actual-user-turn",
          outcome: "done",
          source: "agent_settled",
        },
      ]);
      expect(completions).toHaveLength(1);
      expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
    },
  );

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

  it("blocks a late settled completion after parent cancellation", () => {
    const handlers = registerHandlers();
    const entries: unknown[] = [];
    const ctx = { sessionManager: { getEntries: () => entries } };
    const lifecycleTurnId = "lifecycle-turn";
    const cancelledTurnId = "cancelled-turn";

    handlers.get("before_agent_start")!({}, ctx);
    entries.push({
      id: lifecycleTurnId,
      type: "message",
      message: { role: "user" },
    });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [{ role: "assistant", stopReason: "stop" }],
      },
      ctx,
    );
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: cancelledTurnId, started: true }),
    );

    const cliPath = join(artifactDir, "cli.mjs");
    writeCliScript(cliPath);
    const cancellation = spawnSync(process.execPath, [cliPath, "cancelled"], {
      env: { ...process.env, ARTIFACT_DIR: artifactDir },
      encoding: "utf8",
    });
    expect(cancellation.status, cancellation.stderr).toBe(0);

    handlers.get("agent_settled")!({}, ctx);

    const events = readEvents(artifactPath(root, "child"));
    expect(
      events.filter(
        (event) =>
          event.type === "completion" && event.turnId === lifecycleTurnId,
      ),
    ).toEqual([]);
    const cancellationEvents = events.filter(
      (event) =>
        event.type === "completion" && event.turnId === cancelledTurnId,
    );
    expect(cancellationEvents).toHaveLength(1);
    expect(cancellationEvents[0]).toMatchObject({
      outcome: "cancelled",
      source: "parent",
    });
  });

  it("requires ARTIFACT_DIR when registering", () => {
    delete process.env.ARTIFACT_DIR;
    expect(() => registerHandlers()).toThrow(/requires ARTIFACT_DIR/);
  });
});
