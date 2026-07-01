import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";

describe("extension registration", () => {
  it("registers the expected tools without throwing", () => {
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn(),
    };

    expect(() => registerExtension(api as any)).not.toThrow();

    const names = api.registerTool.mock.calls
      .map(([tool]: any[]) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "cancel_interactive_subagent",
        "cancel_subagent",
        "cancel_workflow",
        "cleanup_subagent_artifacts",
        "get_interactive_subagent_status",
        "get_subagent_result",
        "get_subagent_status",
        "get_workflow_result",
        "get_workflow_status",
        "list_available_models",
        "list_subagent_artifacts",
        "list_workflows",
        "prune_subagent_jobs",
        "read_subagent_artifact",
        "save_workflow",
        "send_interactive_subagent_message",
        "subagent_interactive",
        "subagent_isolated",
        "subagent_with_context",
        "workflow",
      ].sort(),
    );
  });
});
