import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildSessionOptions,
  mockCreateCompatibleSessionRuntime,
  mockCreateAgentSession,
} = vi.hoisted(() => ({
  mockBuildSessionOptions: vi.fn(),
  mockCreateCompatibleSessionRuntime: vi.fn(),
  mockCreateAgentSession: vi.fn(),
}));

vi.mock("../src/pi-sdk-compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pi-sdk-compat")>();
  return {
    ...actual,
    buildSessionOptions: mockBuildSessionOptions,
    createCompatibleSessionRuntime: mockCreateCompatibleSessionRuntime,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    SessionManager: { inMemory: vi.fn(() => ({})) },
  };
});

import { jobRegistry, startSubagentJob } from "../src/helpers";

function createSession(thinkingLevel: string) {
  return {
    thinkingLevel,
    model: undefined,
    subscribe: vi.fn(() => () => undefined),
    prompt: vi.fn(async () => undefined),
    agent: { state: { messages: [], errorMessage: null } },
    dispose: vi.fn(),
  };
}

function params(
  thinkingLevel?:
    "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
) {
  return {
    task: "test task",
    persona: undefined,
    modelOverride: undefined,
    cwd: "/tmp",
    contextText: null,
    signal: undefined,
    onUpdate: undefined,
    defaultModel: undefined,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

describe("startSubagentJob effective thinking level", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
    mockCreateCompatibleSessionRuntime.mockResolvedValue({
      kind: "modern",
      modelRuntime: {},
    });
    mockBuildSessionOptions.mockReturnValue({});
  });

  it("threads explicit requested options to the SDK and exposes effective level", async () => {
    const session = createSession("low");
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params("high"));
    started.start();
    const result = await started.jobPromise;

    expect(mockBuildSessionOptions.mock.calls[0][1]).toMatchObject({
      thinkingLevel: "high",
    });
    expect(started.thinkingLevel).toBe("low");
    expect(started.liveStatus.thinkingLevel).toBe("low");
    expect(result.thinkingLevel).toBe("low");
  });

  it("keeps thinking-level details omitted when the request omits it", async () => {
    const session = createSession("medium");
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params());
    started.start();
    const result = await started.jobPromise;

    expect(mockBuildSessionOptions.mock.calls[0][1]).not.toHaveProperty(
      "thinkingLevel",
    );
    expect(started.thinkingLevel).toBeUndefined();
    expect(started.liveStatus.thinkingLevel).toBeUndefined();
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("allows only structured output for schema-only children", async () => {
    const session = createSession("medium");
    mockCreateAgentSession.mockResolvedValue({ session });

    const prepared = await startSubagentJob({
      ...params(),
      workflowStructuredOutputSchema: { type: "object" },
      structuredOutputOnly: true,
    });
    expect(mockBuildSessionOptions.mock.calls[0][1]).toMatchObject({
      tools: ["structured_output"],
      customTools: [expect.objectContaining({ name: "structured_output" })],
    });

    prepared.disposeBeforeStart();
    await prepared.jobPromise;
  });

  it("disposes a prepared session without starting its prompt", async () => {
    const session = createSession("medium");
    mockCreateAgentSession.mockResolvedValue({ session });

    const prepared = await startSubagentJob(params());
    expect(session.prompt).not.toHaveBeenCalled();

    prepared.disposeBeforeStart();
    const result = await prepared.jobPromise;

    expect(result.cancelled).toBe(true);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("keeps live usage cumulative across turns without counting the current message twice", async () => {
    type TestSessionEvent =
      | { type: "turn_start" }
      | { type: "turn_end"; message: unknown }
      | {
          type: "message_update";
          message: unknown;
          assistantMessageEvent: { type: "text_delta"; delta: string };
        };
    let subscriber: (event: TestSessionEvent) => void = () => undefined;
    const messages: unknown[] = [];
    const first = {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 0.1 },
      },
    };
    const second = {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      usage: {
        input: 20,
        output: 6,
        cacheRead: 3,
        cacheWrite: 2,
        cost: { total: 0.2 },
      },
    };
    const session = {
      thinkingLevel: "medium",
      model: undefined,
      subscribe: vi.fn((listener: (event: TestSessionEvent) => void) => {
        subscriber = listener;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        subscriber({ type: "turn_start" });
        messages.push(first);
        subscriber({
          type: "message_update",
          message: first,
          assistantMessageEvent: { type: "text_delta", delta: "first" },
        });
        subscriber({ type: "turn_end", message: first });

        subscriber({ type: "turn_start" });
        messages.push(second);
        subscriber({
          type: "message_update",
          message: second,
          assistantMessageEvent: { type: "text_delta", delta: "second" },
        });
        subscriber({ type: "turn_end", message: second });
      }),
      agent: { state: { messages, errorMessage: null } },
      dispose: vi.fn(),
    };
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params());
    started.start();
    const result = await started.jobPromise;

    expect(started.liveStatus.usage).toMatchObject({
      input: 30,
      output: 10,
      cacheRead: 5,
      cacheWrite: 3,
      costSource: "estimated",
      turns: 2,
    });
    expect(started.liveStatus.usage.cost).toBeCloseTo(0.3);
    expect(result.usage).toEqual(started.liveStatus.usage);
  });

  it("retains retryable turn usage after Pi prunes the failed assistant message", async () => {
    type TestSessionEvent =
      | { type: "turn_start" }
      | { type: "turn_end"; message: unknown }
      | {
          type: "message_update";
          message: unknown;
          assistantMessageEvent: { type: "text_delta"; delta: string };
        };
    let subscriber: (event: TestSessionEvent) => void = () => undefined;
    const messages: unknown[] = [];
    const failedRetry = {
      role: "assistant",
      content: [{ type: "text", text: "retry me" }],
      stopReason: "error",
      usage: {
        input: 11,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        cost: { total: 1.25 },
        costSource: "provider",
      },
    };
    const success = {
      role: "assistant",
      content: [{ type: "text", text: "success" }],
      usage: {
        input: 19,
        output: 7,
        cacheRead: 3,
        cacheWrite: 1,
        cost: { total: 2.75 },
        costSource: "estimated",
      },
    };
    const session = {
      thinkingLevel: "medium",
      model: undefined,
      subscribe: vi.fn((listener: (event: TestSessionEvent) => void) => {
        subscriber = listener;
        return () => undefined;
      }),
      prompt: vi.fn(async () => {
        subscriber({ type: "turn_start" });
        messages.push(failedRetry);
        subscriber({ type: "turn_end", message: failedRetry });
        messages.splice(0, 1);

        subscriber({ type: "turn_start" });
        messages.push(success);
        subscriber({
          type: "message_update",
          message: success,
          assistantMessageEvent: { type: "text_delta", delta: "success" },
        });
        subscriber({ type: "turn_end", message: success });
      }),
      agent: { state: { messages, errorMessage: null } },
      dispose: vi.fn(),
    };
    mockCreateAgentSession.mockResolvedValue({ session });

    const started = await startSubagentJob(params());
    started.start();
    const result = await started.jobPromise;

    expect(result.usage).toEqual({
      input: 30,
      output: 12,
      cacheRead: 5,
      cacheWrite: 2,
      cost: 4,
      costSource: "mixed",
      turns: 2,
    });
  });

  it.each(["cancellation", "prompt exception"] as const)(
    "preserves current partial-turn usage during %s",
    async (outcome) => {
      type TestSessionEvent =
        | { type: "turn_start" }
        | { type: "turn_end"; message: unknown }
        | {
            type: "message_update";
            message: unknown;
            assistantMessageEvent: { type: "text_delta"; delta: string };
          };
      let subscriber: (event: TestSessionEvent) => void = () => undefined;
      const messages: unknown[] = [];
      const completed = {
        role: "assistant",
        content: [{ type: "text", text: "completed" }],
        usage: {
          input: 4,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.5 },
          costSource: "provider",
        },
      };
      const partial = {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        usage: {
          input: 3,
          output: 1,
          cacheRead: 0,
          cacheWrite: 2,
          cost: { total: 0.25 },
          costSource: "estimated",
        },
      };
      const controller = new AbortController();
      const session = {
        thinkingLevel: "medium",
        model: undefined,
        subscribe: vi.fn((listener: (event: TestSessionEvent) => void) => {
          subscriber = listener;
          return () => undefined;
        }),
        prompt: vi.fn(async () => {
          subscriber({ type: "turn_start" });
          messages.push(completed);
          subscriber({
            type: "message_update",
            message: completed,
            assistantMessageEvent: { type: "text_delta", delta: "completed" },
          });
          subscriber({ type: "turn_end", message: completed });

          subscriber({ type: "turn_start" });
          subscriber({
            type: "message_update",
            message: partial,
            assistantMessageEvent: { type: "text_delta", delta: "partial" },
          });
          if (outcome === "cancellation") {
            controller.abort("stop");
            return;
          }
          throw new Error("prompt failed");
        }),
        abort: vi.fn(async () => undefined),
        agent: { state: { messages, errorMessage: null } },
        dispose: vi.fn(),
      };
      mockCreateAgentSession.mockResolvedValue({ session });

      const started = await startSubagentJob({
        ...params(),
        signal: outcome === "cancellation" ? controller.signal : undefined,
      });
      started.start();
      const result = await started.jobPromise;

      expect(result.usage).toEqual({
        input: 7,
        output: 3,
        cacheRead: 1,
        cacheWrite: 2,
        cost: 0.75,
        costSource: "mixed",
        turns: 2,
      });
      expect(result.cancelled).toBe(
        outcome === "cancellation" ? true : undefined,
      );
      expect(result.isError).toBe(outcome === "prompt exception");
    },
  );
});
