import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";

const BASE_INTERACTIVE_TOOL_NAMES = [
  "cancel_interactive_subagent",
  "get_interactive_subagent_status",
  "read_subagent_artifact",
  "send_interactive_subagent_message",
  "subagent_interactive",
  "list_subagent_artifacts",
  "cleanup_subagent_artifacts",
].sort();

const INTERACTIVE_TOOL_NAMES = [
  ...BASE_INTERACTIVE_TOOL_NAMES,
  "list_available_models",
].sort();

const IN_PROCESS_TOOL_NAMES = [
  "cancel_subagent",
  "get_subagent_result",
  "get_subagent_status",
  "prune_subagent_jobs",
  "subagent_isolated",
  "subagent_with_context",
].sort();

const WORKFLOW_TOOL_NAMES = [
  "cancel_workflow",
  "delete_workflow",
  "get_durable_workflow_result",
  "get_durable_workflow_status",
  "get_workflow_result",
  "get_workflow_status",
  "list_workflows",
  "save_workflow",
  "start_durable_workflow",
  "workflow",
].sort();

function getRegisteredToolNames(api: {
  registerTool: ReturnType<typeof vi.fn>;
}) {
  return api.registerTool.mock.calls.map(([tool]: any[]) => tool.name).sort();
}

function mockApi(overrides: Record<string, any> = {}) {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    ...overrides,
  };
}

describe("extension registration", () => {
  let previousChild: string | undefined;
  beforeEach(() => {
    previousChild = process.env.PI_SUBAGENTURA_CHILD;
    delete process.env.PI_SUBAGENTURA_CHILD;
  });
  afterEach(() => {
    clearSessionScopes();
    if (previousChild === undefined) {
      delete process.env.PI_SUBAGENTURA_CHILD;
    } else {
      process.env.PI_SUBAGENTURA_CHILD = previousChild;
    }
  });

  it("registers the expected tools without throwing", () => {
    const api = mockApi();
    expect(() => registerExtension(api as any)).not.toThrow();
    expect(api.registerMessageRenderer).toHaveBeenCalledOnce();
    expect(api.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notify",
      expect.any(Function),
    );

    expect(getRegisteredToolNames(api)).toEqual(
      [
        ...INTERACTIVE_TOOL_NAMES,
        ...IN_PROCESS_TOOL_NAMES,
        ...WORKFLOW_TOOL_NAMES,
      ].sort(),
    );
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.any(Object),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.any(Object),
    );
  });

  it("registers the --orchestrator flag", () => {
    const api = mockApi();

    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith("orchestrator", {
      description: "Append the bundled orchestration system prompt",
      type: "boolean",
      default: false,
    });
  });

  it("registers the --workflow-eager routing flag", () => {
    const api = mockApi();

    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith("workflow-eager", {
      description: "Route eligible complex requests to durable workflows",
      type: "string",
      default: "off",
    });
  });

  it("appends the bundled prompt when --orchestrator is enabled", async () => {
    const api = mockApi({
      getFlag: vi.fn((name: string) => name === "orchestrator"),
    });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain("# Orchestrator System Prompt");
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
  });

  it("injects the durable routing policy when eager mode is enabled", async () => {
    const api = mockApi({
      getFlag: vi.fn((name: string) =>
        name === "workflow-eager" ? "preferred" : false,
      ),
    });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain(
      "Automatic durable workflow routing is enabled in preferred mode",
    );
    expect(result.systemPrompt).toContain("routing is unconfirmed");
  });

  it("injects continuity only from the live session scope belonging to this Pi", async () => {
    const api = mockApi();
    registerSessionScope({
      id: 701,
      generation: 1,
      lifecycle: "started",
      pi: api as any,
      durableWorkflowContinuity: {
        runId: "scoped-run",
        revision: 3,
        status: "running",
        phase: "build",
        phaseMode: "sequential",
        tasks: [{ id: "task", status: "running" }],
        pendingCount: 0,
        blockedCount: 0,
        approvalPendingCount: 0,
        awaitingBudget: false,
      },
    });
    registerSessionScope({
      id: 702,
      generation: 1,
      lifecycle: "started",
      pi: {} as any,
      durableWorkflowContinuity: {
        runId: "peer-run",
        revision: 1,
        status: "running",
        tasks: [],
        pendingCount: 0,
        blockedCount: 0,
        approvalPendingCount: 0,
        awaitingBudget: false,
      },
    });

    registerExtension(api as any);
    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});
    expect(result.systemPrompt).toContain("run=scoped-run revision=3");
    expect(result.systemPrompt).not.toContain("peer-run");
  });

  it("registers a minimal interactive runtime in child mode", () => {
    const previous = process.env.PI_SUBAGENTURA_CHILD;
    const previousArtifactDir = process.env.ARTIFACT_DIR;
    process.env.PI_SUBAGENTURA_CHILD = "1";
    process.env.ARTIFACT_DIR = "/tmp/pi-subagentura-extension-test";
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
    };

    try {
      registerExtension(api as any);
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
      else process.env.PI_SUBAGENTURA_CHILD = previous;
      if (previousArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
      else process.env.ARTIFACT_DIR = previousArtifactDir;
    }

    const names = api.registerTool.mock.calls
      .map(([tool]: any[]) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "cancel_interactive_subagent",
        "cleanup_subagent_artifacts",
        "get_interactive_subagent_status",
        "list_available_models",
        "list_subagent_artifacts",
        "read_subagent_artifact",
        "send_interactive_subagent_message",
        "subagent_interactive",
      ].sort(),
    );
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("subagent_with_context");
    expect(api.registerMessageRenderer).toHaveBeenCalledWith(
      "subagent-notify",
      expect.any(Function),
    );
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.any(Object),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.any(Object),
    );
    expect(api.on.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        "before_agent_start",
        "turn_start",
        "before_provider_request",
        "tool_execution_start",
        "tool_execution_end",
        "agent_end",
        "agent_settled",
        "session_start",
        "session_shutdown",
      ]),
    );
  });
});
