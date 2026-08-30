import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import {
  HIDE_AGENTS_LIST_FLAG,
  MAX_DEPTH_FLAG,
  readExtensionSettings,
} from "../src/settings";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";

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
    expect(api.registerFlag).toHaveBeenCalledWith(HIDE_AGENTS_LIST_FLAG, {
      description: expect.stringContaining("agent list"),
      type: "boolean",
      default: false,
    });
    expect(readExtensionSettings(api as any)).toEqual({
      maxDepth: 2,
      hideAgentsList: false,
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

  it("rejects invalid hide-agents-list values", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENTS_LIST_FLAG ? "true" : undefined,
    );
    expect(() => readExtensionSettings(api as any)).toThrow(
      /hide agents list/i,
    );
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

  it("hides list tools and the visual supervisor without hiding operations", () => {
    const api = mockApi((name) =>
      name === HIDE_AGENTS_LIST_FLAG ? true : undefined,
    );
    registerExtension(api as any);
    const tools = registeredTools(api);

    expect(tools).not.toContain("list_orchestrator_agents");
    expect(tools).not.toContain("list_subagent_artifacts");
    expect(tools).toContain("subagent_interactive");
    expect(tools).toContain("cancel_interactive_subagent");
    expect(tools).toContain("read_subagent_artifact");
    expect(api.registerCommand).not.toHaveBeenCalledWith(
      "subagents",
      expect.anything(),
    );
    expect(api.registerShortcut).not.toHaveBeenCalledWith(
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
