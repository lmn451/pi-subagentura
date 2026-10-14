/**
 * Behavioral tests for thinkingLevel propagation across sub-agent spawn surfaces.
 *
 * Verifies that thinkingLevel is correctly passed through production code:
 * 1. In-process subagent tools (sync and async) pass to startSubagentJob
 * 2. Interactive subagent CLI command includes --thinking flag
 * 3. Workflow agent() calls pass thinkingLevel to the runner
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// ---------------------------------------------------------------------------
// Test: buildPiInteractiveCommand includes --thinking flag (REAL function)
// ---------------------------------------------------------------------------

describe("buildPiInteractiveCommand thinkingLevel", () => {
  let buildPiInteractiveCommand: typeof import("../src/interactive-tmux.js").buildPiInteractiveCommand;

  beforeEach(async () => {
    const mod = await import("../src/interactive-tmux.js");
    buildPiInteractiveCommand = mod.buildPiInteractiveCommand;
  });

  it("includes --thinking flag when thinkingLevel is provided", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "high",
    });
    expect(command).toContain("--thinking 'high'");
  });

  it("omits --thinking flag when thinkingLevel is undefined", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
    });
    expect(command).not.toContain("--thinking");
  });

  it("omits --thinking flag when thinkingLevel is empty string", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "" as any,
    });
    expect(command).not.toContain("--thinking");
  });

  it.each(VALID_THINKING_LEVELS)(
    "includes --thinking for level: %s",
    (level) => {
      const command = buildPiInteractiveCommand({
        sessionFile: "/tmp/test-session.jsonl",
        name: "test-agent",
        promptFile: "/tmp/prompt.md",
        cwd: "/tmp",
        thinkingLevel: level,
      });
      expect(command).toContain(`--thinking '${level}'`);
    },
  );

  it("includes --thinking before the prompt file argument", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "low",
    });
    const thinkingIdx = command.indexOf("--thinking");
    const promptIdx = command.indexOf("@/tmp/prompt.md");
    expect(thinkingIdx).toBeLessThan(promptIdx);
  });
});

// ---------------------------------------------------------------------------
// Test: In-process subagent tools pass thinkingLevel to startSubagentJob
// ---------------------------------------------------------------------------

// Hoisted mocks at module level
const { mockStartSubagentJob, mockConvertToLlm, mockSerializeConversation } =
  vi.hoisted(() => ({
    mockStartSubagentJob: vi.fn(),
    mockConvertToLlm: vi.fn(),
    mockSerializeConversation: vi.fn(),
  }));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return {
    ...actual,
    startSubagentJob: mockStartSubagentJob,
  };
});

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    interactiveSubagentRegistry: new Map(),
    isTmuxAvailable: () => false,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    convertToLlm: mockConvertToLlm,
    serializeConversation: mockSerializeConversation,
  };
});

import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";

describe("in-process subagent thinkingLevel propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartSubagentJob.mockImplementation(async (params) => ({
      jobId: "test-job",
      jobPromise: Promise.resolve({
        output: "done",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        isError: false,
      }),
      session: { abort: vi.fn() },
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
      thinkingLevel: params.thinkingLevel,
    }));
  });

  function mockCtx(overrides: Record<string, any> = {}) {
    return {
      cwd: "/tmp",
      ui: { setStatus: vi.fn() },
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
      model: undefined,
      modelRegistry: {
        getAvailable: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        find: vi.fn(),
      },
      ...overrides,
    };
  }

  function setupExtension() {
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
    };
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: api as any,
      sessionManager: { getSessionId: () => "test-session" },
    });
    registerInProcessSubagentTools(api as any, scope);
    return api;
  }

  afterEach(() => {
    clearSessionScopes();
  });

  function getToolDef(
    api: { registerTool: ReturnType<typeof vi.fn> },
    name: string,
  ) {
    return api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === name,
    )?.[0];
  }

  it("subagent_with_context sync passes thinkingLevel to startSubagentJob", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_with_context");
    expect(toolDef).toBeDefined();

    // Provide branch with messages for the sync path
    const branchMessages = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi there" } },
    ];

    mockConvertToLlm.mockReturnValue([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    mockSerializeConversation.mockReturnValue(
      "User: Hello\nAssistant: Hi there",
    );

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchMessages),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      {
        task: "test task",
        thinkingLevel: "high",
      },
      undefined,
      undefined,
      ctx,
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBe("high");
  });

  it("subagent_with_context sync omits thinkingLevel when undefined", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_with_context");
    expect(toolDef).toBeDefined();

    // Provide branch with messages for the sync path
    const branchMessages = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi there" } },
    ];

    mockConvertToLlm.mockReturnValue([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    mockSerializeConversation.mockReturnValue(
      "User: Hello\nAssistant: Hi there",
    );

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchMessages),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      { task: "test task" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  it("subagent_isolated sync passes thinkingLevel to startSubagentJob", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_isolated");
    expect(toolDef).toBeDefined();

    const ctx = mockCtx();
    await toolDef.execute(
      "call-1",
      { task: "test task", thinkingLevel: "xhigh" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBe("xhigh");
  });

  it("subagent_isolated sync omits thinkingLevel when undefined", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_isolated");
    expect(toolDef).toBeDefined();

    const ctx = mockCtx();
    await toolDef.execute(
      "call-1",
      { task: "test task" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBeUndefined();
  });

  it("subagent_with_context async:true passes thinkingLevel to startSubagentJob", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_with_context");
    expect(toolDef).toBeDefined();

    const branchMessages = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi there" } },
    ];
    mockConvertToLlm.mockReturnValue([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    mockSerializeConversation.mockReturnValue(
      "User: Hello\nAssistant: Hi there",
    );

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchMessages),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    const result = await toolDef.execute(
      "call-1",
      { task: "test task", async: true, thinkingLevel: "high" },
      undefined,
      undefined,
      ctx,
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBe("high");
    expect(result.details.thinkingLevel).toBe("high");
  });

  it("subagent_isolated async:true passes thinkingLevel to startSubagentJob", async () => {
    const api = setupExtension();
    const toolDef = getToolDef(api, "subagent_isolated");
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute(
      "call-1",
      { task: "test task", async: true, thinkingLevel: "xhigh" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockStartSubagentJob).toHaveBeenCalled();
    const callArgs = mockStartSubagentJob.mock.calls[0][0];
    expect(callArgs.thinkingLevel).toBe("xhigh");
    expect(result.details.thinkingLevel).toBe("xhigh");
  });
});

describe("interactive subagent thinkingLevel rendering", () => {
  it("renders the requested thinking level in the spawn result", () => {
    const api = { registerTool: vi.fn() };
    registerInteractiveSubagentTools(api as any);
    const toolDef = api.registerTool.mock.calls.find(
      ([tool]: any[]) => tool.name === "subagent_interactive",
    )?.[0];
    const theme = {
      fg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };

    toolDef.renderResult(
      {
        content: [{ type: "text", text: "started" }],
        details: { id: "agent-1", paneId: "%1", thinkingLevel: "high" },
      },
      {},
      theme,
    );

    expect(theme.fg).toHaveBeenCalledWith(
      "dim",
      expect.stringContaining("thinking: high"),
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Workflow agent() passes thinkingLevel to runner
// ---------------------------------------------------------------------------

describe("workflow agent thinkingLevel propagation", () => {
  it("agent() with thinkingLevel passes it to the runner", async () => {
    const { runWorkflow } = await import("../src/workflow");

    let capturedReq: any = null;
    const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
      async (req) => {
        capturedReq = req;
        return {
          isError: false,
          output: "result",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: "test/model",
        };
      };

    const meta = `export const meta = { name: "test", description: "test workflow" };`;
    const body = `return await agent("hello", { thinkingLevel: "high" });`;

    await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

    expect(capturedReq).not.toBeNull();
    expect(capturedReq.thinkingLevel).toBe("high");
  });

  it("agent() without thinkingLevel omits it from runner request", async () => {
    const { runWorkflow } = await import("../src/workflow");

    let capturedReq: any = null;
    const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
      async (req) => {
        capturedReq = req;
        return {
          isError: false,
          output: "result",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: "test/model",
        };
      };

    const meta = `export const meta = { name: "test", description: "test workflow" };`;
    const body = `return await agent("hello");`;

    await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

    expect(capturedReq).not.toBeNull();
    expect(capturedReq.thinkingLevel).toBeUndefined();
  });

  it("agent() with all thinkingLevel values passes correctly", async () => {
    const { runWorkflow } = await import("../src/workflow");

    for (const level of VALID_THINKING_LEVELS) {
      let capturedReq: any = null;
      const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
        async (req) => {
          capturedReq = req;
          return {
            isError: false,
            output: "result",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 1,
            },
            model: "test/model",
          };
        };

      const meta = `export const meta = { name: "test", description: "test workflow" };`;
      const body = `return await agent("hello", { thinkingLevel: "${level}" });`;

      await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

      expect(capturedReq.thinkingLevel).toBe(level);
    }
  });
});
