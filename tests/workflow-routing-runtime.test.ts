import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerWorkflowRouting,
  type WorkflowRoutingHost,
} from "../src/workflow-routing-runtime";

const started = {
  status: "started" as const,
  workflowId: "durable-route-1",
  name: "route-plan",
  revision: 2,
  runEpoch: 3,
  ownerGeneration: 4,
  leaseEpoch: 5,
};

function setup(mode: string, host?: WorkflowRoutingHost, rejectInput = false) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const messages: Array<{ message: any; options: any }> = [];
  const pi = {
    getFlag: vi.fn((name: string) =>
      name === "workflow-eager" ? mode : undefined,
    ),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      if (rejectInput && event === "input") {
        throw new Error("input interception unsupported");
      }
      handlers.set(event, handler);
    }),
    registerCommand: vi.fn((name: string, command: any) => {
      commands.set(name, command);
    }),
    sendMessage: vi.fn((message: any, options: any) => {
      messages.push({ message, options });
    }),
  };
  const metrics = registerWorkflowRouting(pi as any, host);
  return { handlers, commands, messages, metrics };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    isIdle: () => true,
    signal: undefined,
    ui: { notify: vi.fn() },
    ...overrides,
  } as any;
}

afterEach(() => {
  delete process.env.PI_SUBAGENTURA_CHILD;
});

describe("workflow eager routing runtime", () => {
  it("keeps the default-off host lane on the direct path", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const { handlers, messages } = setup("off", host);
    const getBranch = vi.fn(() => {
      throw new Error("off mode inspected session state");
    });

    await expect(
      handlers.get("input")!(
        { text: "Refactor the repository in multiple phases" },
        context({ sessionManager: { getBranch } }),
      ),
    ).resolves.toEqual({ action: "continue" });
    expect(getBranch).not.toHaveBeenCalled();
    expect(host.hasActiveWorkflow).not.toHaveBeenCalled();
    expect(host.planAndStart).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it("starts an eligible host route before handling the input turn", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const { handlers, messages, metrics } = setup("preferred", host);
    const ctx = context();

    await expect(
      handlers.get("input")!(
        { text: "Audit the repository in multiple phases" },
        ctx,
      ),
    ).resolves.toEqual({ action: "handled" });
    expect(host.planAndStart).toHaveBeenCalledWith(
      "Audit the repository in multiple phases",
      ctx,
      undefined,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          customType: "workflow-routing",
          details: expect.objectContaining({
            lane: "host_enforced",
            workflowId: "durable-route-1",
          }),
        }),
        options: { triggerTurn: false },
      }),
    ]);
    expect(metrics.snapshot().hostStarted).toBe(1);
  });

  it("suppresses active workflows and streaming continuations", async () => {
    const activeHost = {
      hasActiveWorkflow: vi.fn(async () => true),
      planAndStart: vi.fn(async () => started),
    };
    const active = setup("always", activeHost);
    await expect(
      active.handlers.get("input")!(
        { text: "Implement the feature" },
        context(),
      ),
    ).resolves.toEqual({ action: "continue" });

    const idleHost = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const streaming = setup("always", idleHost);
    await expect(
      streaming.handlers.get("input")!(
        { text: "Implement the feature", streamingBehavior: "followUp" },
        context(),
      ),
    ).resolves.toEqual({ action: "continue" });
    expect(activeHost.planAndStart).not.toHaveBeenCalled();
    expect(idleHost.planAndStart).not.toHaveBeenCalled();
  });

  it("suppresses the response to a parent clarification question", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const { handlers } = setup("always", host);
    const ctx = context({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Which database should I use?" }],
            },
          },
        ],
      },
    });

    await expect(
      handlers.get("input")!(
        { text: "Use PostgreSQL and keep the existing schema" },
        ctx,
      ),
    ).resolves.toEqual({ action: "continue" });
    expect(host.planAndStart).not.toHaveBeenCalled();
  });

  it("handles host failures with the exact cause and declarative command", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => {
        throw new Error("plan.phases[0].mode must be sequential");
      }),
    };
    const { handlers, messages } = setup("always", host);

    await expect(
      handlers.get("input")!({ text: "Implement the feature" }, context()),
    ).resolves.toEqual({ action: "handled" });
    expect(messages[0]?.message.content).toContain(
      "plan.phases[0].mode must be sequential",
    );
    expect(messages[0]?.message.content).toContain(
      "/workflow-plan create <task>",
    );
    expect(messages[0]?.message.content).not.toContain("/workflow <task>");
  });

  it("runs /workflow-plan create through the same host path", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const { commands, messages } = setup("off", host);
    const ctx = context();

    await commands.get("workflow-plan").handler("create migrate storage", ctx);
    expect(host.planAndStart).toHaveBeenCalledWith(
      "migrate storage",
      ctx,
      undefined,
    );
    expect(messages[0]?.message.details.lane).toBe("host_command");
  });

  it("reports an unobserved model-policy route as routing_unconfirmed", async () => {
    const { handlers, messages, metrics } = setup("preferred");
    const result = await handlers.get("before_agent_start")!(
      {
        prompt: "Audit the repository in multiple phases",
        systemPrompt: "base",
      },
      context(),
    );
    expect(result.systemPrompt).toContain(
      "at most one corrected workflow call",
    );
    expect(result.systemPrompt).toContain(
      "do not describe this route as host-enforced",
    );

    handlers.get("agent_settled")!({}, context());
    expect(messages[0]?.message.details).toMatchObject({
      lane: "model_policy",
      status: "routing_unconfirmed",
    });
    expect(metrics.snapshot().routingUnconfirmed).toBe(1);
  });

  it("falls back honestly when input interception is unavailable", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => false),
      planAndStart: vi.fn(async () => started),
    };
    const { handlers, messages } = setup("always", host, true);

    const result = await handlers.get("before_agent_start")!(
      { prompt: "Implement the feature", systemPrompt: "base" },
      context(),
    );
    expect(result.systemPrompt).toContain(
      "do not describe this route as host-enforced",
    );
    handlers.get("agent_settled")!({}, context());
    expect(messages[0]?.message.details).toMatchObject({
      lane: "model_policy",
      status: "routing_unconfirmed",
      capabilityReason: "input interception unsupported",
    });
    expect(host.planAndStart).not.toHaveBeenCalled();
  });

  it("suppresses active workflow continuations in the policy fallback", async () => {
    const host = {
      hasActiveWorkflow: vi.fn(async () => true),
      planAndStart: vi.fn(async () => started),
    };
    const { handlers, messages } = setup("always", host, true);

    await expect(
      handlers.get("before_agent_start")!(
        { prompt: "Implement the feature", systemPrompt: "base" },
        context(),
      ),
    ).resolves.toBeUndefined();
    handlers.get("agent_settled")!({}, context());
    expect(messages).toEqual([]);
    expect(host.planAndStart).not.toHaveBeenCalled();
  });

  it("observes at most two compliant policy workflow calls", async () => {
    const { handlers, messages, metrics } = setup("always");
    await handlers.get("before_agent_start")!(
      { prompt: "Implement the feature", systemPrompt: "base" },
      context(),
    );
    const first = {
      toolCallId: "first",
      toolName: "workflow",
      input: { durable: true, plan: { schemaVersion: 1 } },
    };
    expect(handlers.get("tool_call")!(first, context())).toBeUndefined();
    expect(
      handlers.get("tool_call")!(
        { ...first, toolCallId: "parallel" },
        context(),
      ),
    ).toEqual({
      block: true,
      reason:
        "A workflow plan call is already running or succeeded; a correction is not allowed.",
    });
    handlers.get("tool_execution_end")!(
      { toolCallId: "first", toolName: "workflow", isError: true },
      context(),
    );
    const second = { ...first, toolCallId: "second" };
    expect(handlers.get("tool_call")!(second, context())).toBeUndefined();
    expect(
      handlers.get("tool_call")!({ ...first, toolCallId: "third" }, context()),
    ).toEqual({
      block: true,
      reason: "Automatic workflow plan correction limit reached (two calls).",
    });
    handlers.get("agent_settled")!({}, context());
    expect(messages).toEqual([]);
    expect(metrics.snapshot().policyObserved).toBe(1);
  });

  it("blocks direct tools and legacy workflow fallback in the policy lane", async () => {
    const { handlers, metrics } = setup("always");
    await handlers.get("before_agent_start")!(
      { prompt: "Implement the feature", systemPrompt: "base" },
      context(),
    );

    expect(
      handlers.get("tool_call")!(
        { toolCallId: "read", toolName: "read", input: { path: "src" } },
        context(),
      ),
    ).toMatchObject({ block: true });
    expect(
      handlers.get("tool_call")!(
        {
          toolCallId: "legacy",
          toolName: "workflow",
          input: { script: "legacy" },
        },
        context(),
      ),
    ).toEqual({
      block: true,
      reason:
        "Automatic routing requires the workflow tool with plan and durable:true; legacy workflow execution is disabled.",
    });
    expect(
      handlers.get("tool_call")!(
        {
          toolCallId: "corrected",
          toolName: "workflow",
          input: { durable: true, plan: { schemaVersion: 1 } },
        },
        context(),
      ),
    ).toBeUndefined();
    expect(metrics.snapshot().policyObserved).toBe(1);
  });
});
