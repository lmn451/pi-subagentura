import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { artifactPath, readEvents } from "../src/artifact";
import { readActiveTurn, registerChildProtocol } from "../src/child-protocol";
import { withRuntimeParameterValidation } from "../src/runtime-validation";

const VALIDATION_FLAG = "PI_SUBAGENTURA_WITH_VALIDATION";
const savedValidationFlag = process.env[VALIDATION_FLAG];

function setValidationFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[VALIDATION_FLAG];
  else process.env[VALIDATION_FLAG] = value;
}

function registerHandlers() {
  const handlers = new Map<string, Function>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
  };
  registerChildProtocol(pi as any);
  return handlers;
}

function toolCallMessage(args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "child-validation-call",
        name: "subagent_interactive",
        arguments: args,
      },
    ],
    api: "child-validation-test",
    provider: "child-validation-test",
    model: "child-validation-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as any;
}

async function runToolThroughPi(
  tool: any,
  args: Record<string, unknown>,
  handlers: Map<string, Function>,
  ctx: unknown,
): Promise<any> {
  const final = toolCallMessage(args);
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...final, content: [] } });
    stream.push({ type: "done", reason: "toolUse", message: final });
    stream.end(final);
    return stream;
  };
  const messages = await runAgentLoop(
    [],
    { systemPrompt: "", messages: [], tools: [tool] },
    {
      model: {
        id: "child-validation-test",
        provider: "child-validation-test",
        api: "child-validation-test",
      } as any,
      convertToLlm: (values: any[]) => values,
      shouldStopAfterTurn: () => true,
    },
    async (event) => {
      await handlers.get(event.type)?.(event, ctx);
    },
    undefined,
    streamFn,
  );
  const result = messages.find((message: any) => message.role === "toolResult");
  if (!result) throw new Error("Pi did not emit a tool result");
  return result;
}

function startPersistedTurn(handlers: Map<string, Function>) {
  let entries: any[] = [];
  const ctx = {
    sessionManager: {
      getEntries: () => entries,
    },
  };
  handlers.get("before_agent_start")!({}, ctx);
  entries = [
    { id: "user-validation", type: "message", message: { role: "user" } },
  ];
  handlers.get("turn_start")!({ timestamp: 100 }, ctx);
  vi.runAllTimers();
  return ctx;
}

function createValidatedTool(execute: ReturnType<typeof vi.fn>) {
  return withRuntimeParameterValidation({
    name: "subagent_interactive",
    label: "Interactive Subagent",
    description: "Child protocol validation test",
    parameters: Type.Object({ task: Type.String() }),
    execute,
  } as any) as any;
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
    setValidationFlag(savedValidationFlag);
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
    });
  });

  it("does not persist activity for a real Pi validation rejection", async () => {
    setValidationFlag("on");
    const handlers = registerHandlers();
    const ctx = startPersistedTurn(handlers);
    const art = artifactPath(root, "child");
    const before = readEvents(art);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "pane started" }],
      details: {},
    }));
    const tool = createValidatedTool(execute);

    const result = await runToolThroughPi(
      tool,
      { task: 42, RAW_SECRET_KEY: "RAW_SECRET_VALUE" },
      handlers,
      ctx,
    );
    vi.runAllTimers();

    expect(result).toMatchObject({ isError: true, details: {} });
    expect(JSON.stringify(result)).not.toContain("RAW_SECRET");
    expect(execute).not.toHaveBeenCalled();
    expect(readEvents(art)).toEqual(before);
  });

  it.each([undefined, "false"])(
    "preserves immediate activity when validation is %s",
    async (value) => {
      setValidationFlag(value);
      const handlers = registerHandlers();
      const ctx = startPersistedTurn(handlers);
      const art = artifactPath(root, "child");
      const beforeCount = readEvents(art).length;
      const execute = vi.fn(async () => {
        expect(readEvents(art).slice(beforeCount)).toMatchObject([
          { type: "tool_activity", phase: "start" },
        ]);
        return {
          content: [{ type: "text" as const, text: "pane started" }],
          details: {},
        };
      });
      const tool = createValidatedTool(execute);

      const result = await runToolThroughPi(tool, { task: 42 }, handlers, ctx);

      expect(result.isError).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
      expect(readEvents(art).slice(beforeCount)).toMatchObject([
        { type: "tool_activity", phase: "start" },
        { type: "tool_activity", phase: "end" },
      ]);
    },
  );

  it("requires ARTIFACT_DIR when registering", () => {
    delete process.env.ARTIFACT_DIR;
    expect(() => registerHandlers()).toThrow(/requires ARTIFACT_DIR/);
  });
});
