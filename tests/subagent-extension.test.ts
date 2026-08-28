import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEAGE_BOOTSTRAP_ENV,
  createDescendantSpawnTreeContext,
  createRootSpawnTreeContext,
  resetRuntimeSpawnTreeContextForTests,
  writeLineageBootstrap,
} from "../src/spawn-tree-context";
import {
  clearCompletionTurnWake,
  ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
  sendCompletionTurn,
} from "../src/completion-turn";

const BASE_INTERACTIVE_TOOL_NAMES = [
  "cancel_interactive_subagent",
  "get_interactive_subagent_status",
  "recover_interactive_subagent",
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

const ORCHESTRATOR_TOOL_NAMES = [
  "list_orchestrator_agents",
  "update_orchestrator_agent_description",
].sort();

const WORKFLOW_TOOL_NAMES = [
  "cancel_workflow",
  "delete_workflow",
  "get_workflow_result",
  "get_workflow_status",
  "list_workflows",
  "save_workflow",
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
        ...ORCHESTRATOR_TOOL_NAMES,
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

  it("adds default-preservation guidance to every tool", () => {
    const api = mockApi();

    registerExtension(api as any);

    for (const [tool] of api.registerTool.mock.calls) {
      expect(tool.description).toContain(
        "Treat documented defaults as reasonable defaults. Override them only when the user explicitly asks.",
      );
    }
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

  it("registers the separate --orchestratorv2 flag", () => {
    const api = mockApi();

    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith("orchestratorv2", {
      description: "Append the bundled Orchestratorv2 thin-router prompt",
      type: "boolean",
      default: false,
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
    expect(result.systemPrompt).not.toContain(
      "# Orchestratorv2 Thin Router System Prompt",
    );
    expect(result.systemPrompt).toContain("`workflow`");
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
  });

  it("appends only the v2 prompt when --orchestratorv2 is enabled", async () => {
    const api = mockApi({
      getFlag: vi.fn((name: string) => name === "orchestratorv2"),
    });

    registerExtension(api as any);

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect(result.systemPrompt).toContain(
      "# Orchestratorv2 Thin Router System Prompt",
    );
    expect(result.systemPrompt).not.toContain("# Orchestrator System Prompt");
    expect(result.systemPrompt).toContain("send_interactive_subagent_message");
    expect(result.systemPrompt).toContain("recover_interactive_subagent");
    expect(result.systemPrompt).toContain("includeContext");
    expect(result.systemPrompt).toContain("not a security boundary");
    expect(result.systemPrompt).toContain(
      "An exact or continuation match is not routable",
    );
    expect(result.systemPrompt).toContain(
      "A narrow, exact, continuation, or delegation request with no matching child",
    );
    expect(result.systemPrompt).toContain("must not silently spawn or fan out");
    expect(result.systemPrompt).toContain(
      "may autonomously create nested children",
    );
    expect(result.systemPrompt).toContain(
      "owned by their immediate parent session",
    );
    expect(result.systemPrompt).toContain(
      "successful spawn or confirmed update writes the bounded project-local routing",
    );
    expect(result.systemPrompt).toContain(
      'reason: "routing_metadata_untrusted"',
    );
    expect(result.systemPrompt).toContain(
      "Human prompts and steering take priority",
    );
    expect(result.systemPrompt).toContain(
      "never auto-delegate, replace, or respawn it",
    );
    expect(result.systemPrompt.startsWith("base prompt\n\n")).toBe(true);
  });

  it("does not consume descendant bootstrap authority in parent mode", () => {
    const root = mkdtempSync(join(tmpdir(), "parent-bootstrap-gate-"));
    const artifactDir = join(root, "child-agent");
    const child = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;
    process.env.ARTIFACT_DIR = artifactDir;

    try {
      registerExtension(mockApi() as any);

      expect(existsSync(bootstrapPath)).toBe(true);
      expect(process.env[LINEAGE_BOOTSTRAP_ENV]).toBeUndefined();
    } finally {
      delete process.env[LINEAGE_BOOTSTRAP_ENV];
      delete process.env.ARTIFACT_DIR;
      resetRuntimeSpawnTreeContextForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not acknowledge a completion wake during preflight", async () => {
    const api = mockApi({
      appendEntry: vi.fn(),
      getFlag: vi.fn((name: string) => name === "orchestratorv2"),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    });
    registerExtension(api as any);
    sendCompletionTurn(
      api as any,
      {
        customType: "subagent-notify",
        content: "completed",
        display: true,
      },
      {
        deliverAs: "followUp",
        triggerTurn: true,
        parentStreaming: false,
      },
    );

    const beforeAgentStart = api.on.mock.calls.find(
      ([event]: any[]) => event === "before_agent_start",
    )?.[1];
    await beforeAgentStart({ systemPrompt: "base prompt" }, {});

    expect((api as any).appendEntry).toHaveBeenCalledOnce();
    expect((api as any).appendEntry).toHaveBeenCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "requested" }),
    );
    clearCompletionTurnWake(api as any);
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
        "recover_interactive_subagent",
        "send_interactive_subagent_message",
        "subagent_interactive",
      ].sort(),
    );
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("subagent_with_context");
    expect(names).not.toContain("list_orchestrator_agents");
    expect(names).not.toContain("update_orchestrator_agent_description");

    expect(api.registerFlag).not.toHaveBeenCalled();
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
