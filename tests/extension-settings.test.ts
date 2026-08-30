import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import {
  HIDE_AGENT_LIST_FLAG,
  MAX_DEPTH_FLAG,
  readExtensionSettings,
} from "../src/settings";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";
import { getSessionScopes } from "../src/session-scope";

function mockApi(getFlag: (name: string) => unknown = () => undefined) {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn(getFlag),
    on: vi.fn(),
  };
}

function registeredTools(api: ReturnType<typeof mockApi>): string[] {
  return api.registerTool.mock.calls.map(([tool]: any[]) => tool.name);
}

describe("generic extension settings", () => {
  it("registers validated settings with V2-safe defaults", () => {
    const api = mockApi();
    registerExtension(api as any);

    expect(api.registerFlag).toHaveBeenCalledWith(MAX_DEPTH_FLAG, {
      description: expect.stringContaining("Orchestratorv2"),
      type: "string",
      default: "2",
    });
    expect(api.registerFlag).toHaveBeenCalledWith(HIDE_AGENT_LIST_FLAG, {
      description: expect.stringContaining("activity widget"),
      type: "boolean",
      default: false,
    });
    expect(readExtensionSettings(api as any)).toEqual({
      maxDepth: 2,
      hideAgentList: false,
    });
  });

  it.each(["", "-1", "1.5", "nope", "65", true])(
    "rejects invalid max depth %p",
    (value) => {
      const api = mockApi((name) =>
        name === MAX_DEPTH_FLAG ? value : undefined,
      );
      expect(() => readExtensionSettings(api as any)).toThrow(/max depth/i);
    },
  );

  it("rejects invalid hide-agent-list values", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENT_LIST_FLAG ? "true" : undefined,
    );
    expect(() => readExtensionSettings(api as any)).toThrow(/hide agent list/i);
  });

  it("uses the configured depth only for V2 roots", () => {
    const api = mockApi((name) => (name === MAX_DEPTH_FLAG ? "4" : undefined));
    const settings = readExtensionSettings(api as any);

    expect(
      createRootSpawnTreeContext("v2", "/tmp", false, true, settings.maxDepth)
        .maxDepth,
    ).toBe(4);
    expect(
      createRootSpawnTreeContext(
        "legacy",
        "/tmp",
        true,
        false,
        settings.maxDepth,
      ).maxDepth,
    ).toBe(8);
  });

  it("honors a CLI max-depth override applied before session_start", () => {
    const flags = new Map<string, unknown>();
    const handlers = new Map<string, Function[]>();
    const api = {
      ...mockApi(),
      registerFlag: vi.fn((name: string, options: { default?: unknown }) => {
        flags.set(name, options.default);
      }),
      getFlag: vi.fn((name: string) => flags.get(name)),
      on: vi.fn((name: string, handler: Function) => {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      }),
    };

    const extensionApi = api as unknown as Parameters<
      typeof registerExtension
    >[0];
    registerExtension(extensionApi);
    expect(flags.get(MAX_DEPTH_FLAG)).toBe("2");

    flags.set(MAX_DEPTH_FLAG, "4");
    flags.set("orchestratorv2", true);
    const ctx = {
      cwd: process.cwd(),
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "late-depth-session",
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    handlers.get("session_start")![0]({ reason: "startup" }, ctx);

    const scope = getSessionScopes().find(
      (candidate) => candidate.pi === extensionApi,
    );
    expect(scope?.spawnTreeContext).toMatchObject({
      role: "root",
      maxDepth: 4,
    });

    handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
  });

  it("keeps list/status tools and the visual supervisor available when the widget is hidden", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENT_LIST_FLAG ? true : undefined,
    );
    registerExtension(api as any);
    const tools = registeredTools(api);

    expect(tools).toContain("list_orchestrator_agents");
    expect(tools).toContain("list_subagent_artifacts");
    expect(tools).toContain("get_interactive_subagent_status");
    expect(tools).toContain("subagent_interactive");
    expect(tools).toContain("cancel_interactive_subagent");
    expect(tools).toContain("read_subagent_artifact");
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.anything(),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.anything(),
    );
  });

  it("preserves list tools and visual supervisor visibility by default", () => {
    const api = mockApi();
    registerExtension(api as any);
    const tools = registeredTools(api);

    expect(tools).toContain("list_orchestrator_agents");
    expect(tools).toContain("list_subagent_artifacts");
    expect(api.registerCommand).toHaveBeenCalledWith(
      "subagents",
      expect.anything(),
    );
    expect(api.registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+a",
      expect.anything(),
    );
  });
});
