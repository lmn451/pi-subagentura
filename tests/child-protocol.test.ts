import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { READ_ONLY_WORKFLOW_FLAG } from "../src/agent-capabilities";
import {
  MAX_OUTPUT_SNAPSHOT_BYTES,
  artifactPath,
  readEvents,
  readOutput,
} from "../src/artifact";
import { readActiveTurn, registerChildProtocol } from "../src/child-protocol";

type ChildProtocolHandlers = Map<string, Function> & {
  registeredFlags: Array<{ name: string; options: Record<string, unknown> }>;
  setReadOnly(value: boolean): void;
};

function registerHandlers(readOnly = false): ChildProtocolHandlers {
  const handlers = new Map<string, Function>() as ChildProtocolHandlers;
  const registeredFlags: ChildProtocolHandlers["registeredFlags"] = [];
  let currentReadOnly = readOnly;
  const pi = {
    registerFlag: vi.fn((name: string, options: Record<string, unknown>) => {
      registeredFlags.push({ name, options });
    }),
    getFlag: vi.fn(() => currentReadOnly),
    on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
  };
  handlers.registeredFlags = registeredFlags;
  handlers.setReadOnly = (value) => {
    currentReadOnly = value;
  };
  registerChildProtocol(pi as unknown as ExtensionAPI);
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

  it("keeps startup auth failure separate from a later successful turn", async () => {
    const handlers = registerHandlers();
    let configuredAuth = false;
    let entries: any[] = [];
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: {
        getApiKeyAndHeaders: async () =>
          configuredAuth
            ? { ok: true, apiKey: "test-key" }
            : { ok: false, error: "No API key found" },
      },
      sessionManager: { getEntries: () => entries },
    };

    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    expect(readActiveTurn()).toBeNull();
    expect(readEvents(artifactPath(root, "child"))).toMatchObject([
      expect.objectContaining({
        type: "completion",
        turnId: "process",
        outcome: "error",
        source: "explicit",
      }),
    ]);

    configuredAuth = true;
    await handlers.get("session_start")!({ reason: "reload" }, ctx);
    handlers.get("before_agent_start")!({}, ctx);
    entries = [
      { id: "after-login", type: "message", message: { role: "user" } },
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
      expect.objectContaining({ turnId: "process", outcome: "error" }),
      expect.objectContaining({
        turnId: "after-login",
        outcome: "done",
        source: "agent_settled",
      }),
    ]);
    expect(completions).toHaveLength(2);
  });

  it("reports missing legacy auth when Pi returns an empty compatibility result", async () => {
    const handlers = registerHandlers();
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, headers: {} }),
        getRegisteredNativeProvider: () => undefined,
        hasConfiguredAuth: () => false,
      },
      sessionManager: { getEntries: () => [] },
    };

    await handlers.get("session_start")!({ reason: "startup" }, ctx);

    const completions = readEvents(artifactPath(root, "child")).filter(
      (event) => event.type === "completion",
    );
    expect(completions).toMatchObject([
      expect.objectContaining({
        type: "completion",
        turnId: "process",
        outcome: "error",
        source: "explicit",
        exitCode: 1,
        message: "Selected model has no configured authentication.",
        errorMessage: "Selected model has no configured authentication.",
      }),
    ]);
    expect(completions).toHaveLength(1);
  });

  it("reports missing legacy auth when Pi 0.80.6 returns undefined auth fields", async () => {
    const handlers = registerHandlers();
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: undefined,
          headers: undefined,
          env: undefined,
        }),
        getRegisteredNativeProvider: () => undefined,
        hasConfiguredAuth: () => false,
      },
      sessionManager: { getEntries: () => [] },
    };

    await handlers.get("session_start")!({ reason: "startup" }, ctx);

    const completions = readEvents(artifactPath(root, "child")).filter(
      (event) => event.type === "completion",
    );
    expect(completions).toMatchObject([
      expect.objectContaining({
        type: "completion",
        turnId: "process",
        outcome: "error",
        source: "explicit",
        exitCode: 1,
        message: "Selected model has no configured authentication.",
        errorMessage: "Selected model has no configured authentication.",
      }),
    ]);
    expect(completions).toHaveLength(1);
  });

  it("accepts successful auth resolved through endpoint and env fields", async () => {
    const handlers = registerHandlers();
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          baseUrl: "https://native-provider.invalid/v1",
          env: { REGION: "local-test" },
        }),
        getRegisteredNativeProvider: () => undefined,
        hasConfiguredAuth: () => false,
      },
      sessionManager: { getEntries: () => [] },
    };

    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    await Promise.resolve();

    expect(
      readEvents(artifactPath(root, "child")).filter(
        (event) => event.type === "completion",
      ),
    ).toEqual([]);
  });

  it("accepts keyless auth headers when the configured-auth snapshot is stale", async () => {
    const handlers = registerHandlers();
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: undefined,
          headers: { "x-test-auth": "local-test" },
        }),
        getRegisteredNativeProvider: () => undefined,
        hasConfiguredAuth: () => false,
      },
      sessionManager: { getEntries: () => [] },
    };

    await handlers.get("session_start")!({ reason: "startup" }, ctx);

    expect(
      readEvents(artifactPath(root, "child")).filter(
        (event) => event.type === "completion",
      ),
    ).toEqual([]);
  });

  it("does not append a late startup auth failure after an agent run starts", async () => {
    const handlers = registerHandlers();
    let resolveAuth!: (result: { ok: boolean; error?: string }) => void;
    const pendingAuth = new Promise<{ ok: boolean; error?: string }>(
      (resolve) => {
        resolveAuth = resolve;
      },
    );
    const ctx = {
      model: { provider: "subagentura-faux", id: "faux-model" },
      modelRegistry: { getApiKeyAndHeaders: () => pendingAuth },
      sessionManager: { getEntries: () => [] },
    };

    handlers.get("session_start")!({ reason: "startup" }, ctx);
    handlers.get("before_agent_start")!({}, ctx);
    resolveAuth({ ok: false, error: "No API key found" });
    await pendingAuth;

    expect(
      readEvents(artifactPath(root, "child")).filter(
        (event) => event.type === "completion",
      ),
    ).toEqual([]);
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

  it("captures bounded final text before settled completion and keeps turn snapshots isolated", () => {
    const handlers = registerHandlers(false);
    handlers.setReadOnly(true);
    const entries: Array<{
      id: string;
      type: "message";
      message: { role: "user" };
    }> = [];
    const ctx = { sessionManager: { getEntries: () => entries } };
    const art = artifactPath(root, "child");
    const firstResult = 'Findings: inspected files.\n{"count":2}';

    expect(handlers.registeredFlags).toContainEqual({
      name: READ_ONLY_WORKFLOW_FLAG,
      options: expect.objectContaining({ type: "boolean", default: false }),
    });
    handlers.get("before_agent_start")!({}, ctx);
    entries.push({
      id: "readonly-turn-1",
      type: "message",
      message: { role: "user" },
    });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Findings: inspected files.\n" },
              { type: "image", data: "ignored" },
              {
                type: "toolCall",
                name: "read",
                arguments: { path: "excluded payload" },
              },
              { type: "text", text: '{"count":2}' },
            ],
            stopReason: "stop",
          },
        ],
      },
      ctx,
    );

    expect(readOutput(art)).toBe("");
    expect(
      readEvents(art).filter((event) => event.type === "completion"),
    ).toHaveLength(0);
    handlers.get("agent_settled")!({}, ctx);

    const firstCompletion = readEvents(art).find(
      (event) => event.type === "completion",
    );
    expect(firstCompletion).toMatchObject({
      type: "completion",
      turnId: "readonly-turn-1",
      outcome: "done",
      source: "agent_settled",
    });
    if (
      !firstCompletion ||
      firstCompletion.type !== "completion" ||
      !firstCompletion.output
    ) {
      throw new Error(
        "read-only completion did not capture its output snapshot",
      );
    }
    expect(readFileSync(firstCompletion.output.path, "utf8")).toBe(firstResult);
    expect(firstCompletion.output.bytes).toBe(Buffer.byteLength(firstResult));

    handlers.get("agent_settled")!({}, ctx);
    expect(
      readEvents(art).filter((event) => event.type === "completion"),
    ).toHaveLength(1);
    expect(readFileSync(firstCompletion.output.path, "utf8")).toBe(firstResult);

    entries.push({
      id: "readonly-turn-2",
      type: "message",
      message: { role: "user" },
    });
    handlers.get("before_provider_request")!({}, ctx);
    expect(readOutput(art)).toBe("");
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            content: "Second-turn result.",
            stopReason: "stop",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    const completions = readEvents(art).filter(
      (event) => event.type === "completion",
    );
    expect(completions).toMatchObject([
      { turnId: "readonly-turn-1", outcome: "done" },
      { turnId: "readonly-turn-2", outcome: "done" },
    ]);
    const secondCompletion = completions[1];
    if (
      !secondCompletion ||
      secondCompletion.type !== "completion" ||
      !secondCompletion.output
    ) {
      throw new Error(
        "follow-up completion did not capture its output snapshot",
      );
    }
    expect(readFileSync(firstCompletion.output.path, "utf8")).toBe(firstResult);
    expect(readFileSync(secondCompletion.output.path, "utf8")).toBe(
      "Second-turn result.",
    );
    expect(readActiveTurn(art)).toMatchObject({
      turnId: "readonly-turn-2",
      previousUserEntryId: "readonly-turn-1",
    });
  });

  it("fails settled read-only turns when no assistant text is capturable", () => {
    const handlers = registerHandlers(true);
    const entries: Array<{
      id: string;
      type: "message";
      message: { role: "user" };
    }> = [];
    const ctx = { sessionManager: { getEntries: () => entries } };
    const art = artifactPath(root, "child");

    handlers.get("before_agent_start")!({}, ctx);
    entries.push({
      id: "readonly-empty",
      type: "message",
      message: { role: "user" },
    });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "read" }],
            stopReason: "stop",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    const completion = readEvents(art).at(-1);
    expect(completion).toMatchObject({
      type: "completion",
      turnId: "readonly-empty",
      outcome: "error",
      exitCode: 1,
      errorMessage: "The assistant response contained no text to capture.",
    });
    expect(readOutput(art)).toBe("");
  });

  it("rejects over-limit readonly results instead of silently truncating them", () => {
    const handlers = registerHandlers(true);
    const entries: Array<{
      id: string;
      type: "message";
      message: { role: "user" };
    }> = [];
    const ctx = { sessionManager: { getEntries: () => entries } };
    const art = artifactPath(root, "child");

    handlers.get("before_agent_start")!({}, ctx);
    entries.push({
      id: "readonly-oversized",
      type: "message",
      message: { role: "user" },
    });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            content: "x".repeat(MAX_OUTPUT_SNAPSHOT_BYTES + 1),
            stopReason: "stop",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readEvents(art).at(-1)).toMatchObject({
      type: "completion",
      turnId: "readonly-oversized",
      outcome: "error",
      exitCode: 1,
      errorMessage: `The assistant response exceeded the ${MAX_OUTPUT_SNAPSHOT_BYTES}-byte capture limit.`,
    });
    expect(readOutput(art)).toBe("");
  });

  it("requires ARTIFACT_DIR when registering", () => {
    delete process.env.ARTIFACT_DIR;
    expect(() => registerHandlers()).toThrow(/requires ARTIFACT_DIR/);
  });
});
