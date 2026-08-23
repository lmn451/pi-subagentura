import { readFileSync } from "node:fs";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runtimeParameterValidationEnabled,
  withRuntimeParameterValidation,
} from "../src/runtime-validation";

const VALIDATION_FLAG = "PI_SUBAGENTURA_WITH_VALIDATION";
const savedValidationFlag = process.env[VALIDATION_FLAG];

function setValidationFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[VALIDATION_FLAG];
  else process.env[VALIDATION_FLAG] = value;
}

function createTool() {
  const execute = vi.fn(async (_id: string, params: unknown) => ({
    content: [{ type: "text" as const, text: "executed" }],
    details: { params },
  }));
  const tool = withRuntimeParameterValidation({
    name: "test_runtime_tool",
    label: "Test runtime tool",
    description: "Test runtime validation",
    parameters: Type.Object({
      task: Type.String(),
      mode: Type.Optional(
        Type.Union([Type.Literal("notify"), Type.Literal("inject")]),
      ),
    }),
    execute,
  } as any) as any;
  return { execute, tool };
}

function toolCallMessage(args: Record<string, unknown>): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "runtime-validation-call",
        name: "test_runtime_tool",
        arguments: args,
      },
    ],
    api: "runtime-validation-test",
    provider: "runtime-validation-test",
    model: "runtime-validation-test",
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
  };
}

async function runThroughPi(
  tool: any,
  args: Record<string, unknown>,
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
        id: "runtime-validation-test",
        provider: "runtime-validation-test",
        api: "runtime-validation-test",
      } as any,
      convertToLlm: (values: any[]) => values,
      shouldStopAfterTurn: () => true,
    },
    () => {},
    undefined,
    streamFn,
  );
  const result = messages.find((message: any) => message.role === "toolResult");
  if (!result) throw new Error("Pi did not emit a tool result");
  return result;
}

afterEach(() => {
  setValidationFlag(savedValidationFlag);
  vi.restoreAllMocks();
});

describe("runtime parameter validation flag", () => {
  it("uses only the Pi-loader-supported TypeBox compile subpath", () => {
    const source = readFileSync(
      new URL("../src/runtime-validation.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "typebox/compile"');
    expect(source).not.toContain("typebox/schema");
    expect(source).not.toContain("createRequire");
  });

  it.each(["1", "true", "TRUE", " true ", "yes", "YeS", "on", "ON"])(
    "enables validation for %s",
    async (value) => {
      setValidationFlag(value);
      const { execute, tool } = createTool();
      const result = await tool.execute("call", { task: 42 });
      expect(runtimeParameterValidationEnabled()).toBe(true);
      expect(result.details).toEqual({
        status: "error",
        code: "invalid_params",
        tool: "test_runtime_tool",
        errors: [{ path: "/task", message: "Expected string" }],
      });
      expect(result.content[0].text).toContain("/task: Expected string");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "0", "false", "no", "off", "enabled"])(
    "bypasses extension validation for %s",
    async (value) => {
      setValidationFlag(value);
      const { execute, tool } = createTool();
      const result = await tool.execute("call", { task: 42 });
      expect(runtimeParameterValidationEnabled()).toBe(false);
      expect(result.details).toEqual({ params: { task: 42 } });
      expect(execute).toHaveBeenCalledOnce();
    },
  );
});

describe("Pi validation boundary", () => {
  it("rejects raw invalid args before Pi can coerce them", async () => {
    setValidationFlag("on");
    const secretValue = "RAW_PROMPT_PERSONA_TOKEN_123";
    const secretKey = "RAW_SECRET_KEY_456";
    const { execute, tool } = createTool();
    const result = await runThroughPi(tool, {
      task: 42,
      [secretKey]: secretValue,
    });
    const text = JSON.stringify(result);
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({});
    expect(text).toContain("Expected string");
    expect(text).toContain("Unexpected parameter");
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain(secretKey);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, "false"])(
    "preserves Pi coercion when the opt-in flag is %s",
    async (value) => {
      setValidationFlag(value);
      const { execute, tool } = createTool();
      const result = await runThroughPi(tool, { task: 42 });
      expect(result.isError).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][1]).toEqual({ task: "42" });
    },
  );
});

describe("runtime parameter validation errors", () => {
  it.each([
    [{}, "/task"],
    [{ task: 42 }, "/task"],
    [{ task: "ok", mode: "invalid" }, "/mode"],
  ])("rejects malformed params", async (params, path) => {
    setValidationFlag("true");
    const { execute, tool } = createTool();
    const result = await tool.execute("call", params);
    expect(result.details.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects undeclared top-level params without exposing their names", async () => {
    setValidationFlag("on");
    const secretKey = "RAW_SECRET_KEY_456";
    const { execute, tool } = createTool();
    const result = await tool.execute("call", {
      task: "review",
      [secretKey]: "secret",
    });
    expect(result.details.errors).toContainEqual({
      path: "/",
      message: "Unexpected parameter",
    });
    expect(JSON.stringify(result)).not.toContain(secretKey);
    expect(execute).not.toHaveBeenCalled();
  });

  it("respects explicit additionalProperties opt-in", async () => {
    setValidationFlag("on");
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "executed" }],
      details: {},
    }));
    const tool = withRuntimeParameterValidation({
      name: "open_object",
      parameters: Type.Object(
        { task: Type.String() },
        { additionalProperties: true },
      ),
      execute,
    } as any) as any;
    await tool.execute("call", { task: "ok", metadata: "allowed" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("bounds invalid diagnostic materialization", async () => {
    setValidationFlag("on");
    const execute = vi.fn();
    const tool = withRuntimeParameterValidation({
      name: "large_input",
      parameters: Type.Object({ values: Type.Array(Type.String()) }),
      execute,
    } as any) as any;
    const result = await tool.execute("call", {
      values: Array.from({ length: 4097 }, () => 42),
    });
    expect(result.details.errors).toEqual([
      {
        path: "/",
        message: "Parameter structure exceeds validation reporting limits",
      },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not reject schema-valid large Type.Unknown payloads", async () => {
    setValidationFlag("on");
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "executed" }],
      details: {},
    }));
    const tool = withRuntimeParameterValidation({
      name: "large_unknown_input",
      parameters: Type.Object({ payload: Type.Unknown() }),
      execute,
    } as any) as any;
    const result = await tool.execute("call", {
      payload: { values: Array.from({ length: 4097 }, () => "ok") },
    });
    expect(result.content[0].text).toBe("executed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("normalizes omitted object params before execution", async () => {
    setValidationFlag("on");
    const execute = vi.fn(async (_id: string, params: unknown) => ({
      content: [{ type: "text" as const, text: "executed" }],
      details: { params },
    }));
    const tool = withRuntimeParameterValidation({
      name: "no_args",
      parameters: Type.Object({}),
      execute,
    } as any) as any;
    const result = await tool.execute("call", undefined);
    expect(result.details.params).toEqual({});
    expect(tool.prepareArguments(undefined)).toEqual({});
  });

  it("composes an existing prepareArguments shim", () => {
    setValidationFlag("on");
    const originalPrepare = vi.fn((args: any) => ({ task: args.legacyTask }));
    const tool = withRuntimeParameterValidation({
      name: "prepared_tool",
      parameters: Type.Object({ task: Type.String() }),
      prepareArguments: originalPrepare,
      execute: vi.fn(),
    } as any) as any;
    expect(tool.prepareArguments({ legacyTask: "prepared" })).toEqual({
      task: "prepared",
    });
    expect(originalPrepare).toHaveBeenCalledOnce();
  });

  it("does not hijack unrelated renderer details with the same code", () => {
    const renderResult = vi.fn(() => "domain-renderer");
    const tool = withRuntimeParameterValidation({
      name: "domain_renderer",
      parameters: Type.Object({}),
      execute: vi.fn(),
      renderResult,
    } as any) as any;
    const rendered = tool.renderResult(
      {
        content: [{ type: "text", text: "domain result" }],
        details: { code: "invalid_params" },
      },
      { expanded: false },
      { fg: (_color: string, text: string) => text },
      {},
    );
    expect(rendered).toBe("domain-renderer");
    expect(renderResult).toHaveBeenCalledOnce();
  });
});
