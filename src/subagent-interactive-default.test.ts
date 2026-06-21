/**
 * Tests for the subagent_interactive tool's `notifyOnComplete` defaulting.
 *
 * The tool's `execute` defaults `notifyOnComplete` to "inject" (not "notify")
 * so the parent LLM is woken up by default when an interactive sub-agent
 * finishes. These tests assert the default by mocking the tmux-backed
 * `launchInteractiveSubagent` helper and capturing the call args.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockLaunchInteractiveSubagent } = vi.hoisted(() => ({
  mockLaunchInteractiveSubagent: vi.fn(),
}));

vi.mock("./interactive-tmux", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
  };
});

import registerExtension from "./subagent";

/** Minimal ctx for the tool's execute signature. */
function mockCtx() {
  return {
    cwd: "/tmp",
    ui: { setStatus: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("test-session-id"),
    },
  };
}

/** Find the subagent_interactive tool def from the registered API. */
function getInteractiveToolDef(api: {
  registerTool: ReturnType<typeof vi.fn>;
}) {
  return api.registerTool.mock.calls.find(
    ([t]: any[]) => t.name === "subagent_interactive",
  )?.[0];
}

describe("subagent_interactive notifyOnComplete default", () => {
  let api: ReturnType<typeof setupExtension>;

  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api = setupExtension() as any;
    mockLaunchInteractiveSubagent.mockReset();
    // Return a minimal valid InteractiveSubagentState.
    mockLaunchInteractiveSubagent.mockReturnValue({
      id: "abc12345",
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: Date.now(),
      status: "running",
      mux: "tmux",
      attachCommand: "tmux attach -t s",
      selectPaneCommand: "tmux select-pane -t '%99'",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: "/tmp/artifacts/abc12345",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to 'inject' when notifyOnComplete is omitted (parent LLM is woken up by default)", async () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();

    await toolDef.execute(
      "call-1",
      { task: "research X" },
      undefined,
      undefined,
      mockCtx(),
    );

    // The helper was called exactly once.
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    // And the default was 'inject' — not 'notify'.
    const callArgs = mockLaunchInteractiveSubagent.mock.calls[0][0];
    expect(callArgs.notifyOnComplete).toBe("inject");
  });

  it("forwards 'notify' when explicitly passed (opt out of LLM wake-up)", async () => {
    const toolDef = getInteractiveToolDef(api);

    await toolDef.execute(
      "call-2",
      { task: "research X", notifyOnComplete: "notify" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("notify");
  });

  it("forwards 'inject' when explicitly passed (matches the default behavior, but explicit)", async () => {
    const toolDef = getInteractiveToolDef(api);

    await toolDef.execute(
      "call-3",
      { task: "research X", notifyOnComplete: "inject" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].notifyOnComplete,
    ).toBe("inject");
  });

  it("exposes notifyOnComplete in the schema with the new default documented", () => {
    const toolDef = getInteractiveToolDef(api);
    expect(toolDef).toBeDefined();
    const params = toolDef.parameters;
    // TypeBox runtime shape: properties.notifyOnComplete exists
    const properties = (params as any).properties;
    expect(properties).toBeDefined();
    expect(properties.notifyOnComplete).toBeDefined();
    // Description must document 'inject' as the default and 'notify' as a valid
    // alternative. We don't assert literal phrasing — just that 'inject' is the
    // documented default — so wording tweaks don't break the test.
    const desc = properties.notifyOnComplete.description ?? "";
    // 'inject' is documented as the default.
    expect(desc).toMatch(/inject.*default|default.*inject/i);
    // 'notify' is documented as a valid choice (just not the default).
    expect(desc).toContain('"notify"');
  });
});
