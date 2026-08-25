/**
 * Tests for the `send_interactive_subagent_message` tool.
 *
 * Verifies that the parent-facing tool:
 *   - calls `sendCommandToPane` with the right pane id and message
 *   - refuses invalid / unknown / non-running sub-agents
 *   - returns a structured error if tmux itself rejects the send-keys call
 *
 * The tool uses `sendCommandToPane` (which shells out to `tmux send-keys`)
 * and the registration-captured SessionScope state map — both stay hermetic
 * here, so the test doesn't require a live tmux server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

const { mockSendCommandToPane, mockGet } = vi.hoisted(() => ({
  mockSendCommandToPane: vi.fn(),
  mockGet: vi.fn(),
}));

// Mock interactive-tmux so we get a stub registry + controllable send-keys helper.
vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    sendCommandToPane: mockSendCommandToPane,
    interactiveSubagentRegistry: {
      get: mockGet,
    } as unknown as Map<string, InteractiveSubagentState>,
  };
});

import registerExtension from "../src/subagent";

function setupExtension() {
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
  // The stub implements only the ExtensionAPI methods registration exercises.
  const extensionApi = api as unknown as Parameters<
    typeof registerExtension
  >[0];
  registerExtension(extensionApi);
  const sessionScope = getSessionScopes().find(
    (scope) => scope.pi === extensionApi,
  );
  if (!sessionScope)
    throw new Error("extension did not register a session scope");
  sessionScope.lifecycle = "started";
  sessionScope.sessionManager = {
    getSessionId: () => "send-message-parent-session",
  };
  return Object.assign(api, { sessionScope });
}

function getToolDef(
  api: { registerTool: ReturnType<typeof vi.fn> },
  name: string,
) {
  return api.registerTool.mock.calls.find(([tool]) => tool.name === name)?.[0];
}

function runningState(
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  return {
    id: "abc12345def67890",
    name: "Test",
    paneId: "%99",
    status: "running",
    ...overrides,
  } as InteractiveSubagentState;
}
function registerState(
  scope: SessionScope,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  const value = runningState({
    sessionOwner: sessionOwner(scope),
    ...overrides,
  });
  scope.interactiveStates.set(value.id, value);
  return value;
}

describe("send_interactive_subagent_message", () => {
  let api: ReturnType<typeof setupExtension>;

  beforeEach(() => {
    vi.clearAllMocks();
    api = setupExtension();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearSessionScopes();
  });

  it("is registered with the expected name", () => {
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    expect(toolDef).toBeDefined();
  });

  it("sends the message to the pane and returns success details", async () => {
    registerState(api.sessionScope);
    mockSendCommandToPane.mockReturnValue(undefined);

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-1", {
      id: "abc12345def67890",
      message: "now do step 2",
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSendCommandToPane).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "%99" }),
      expect.stringMatching(/^now do step 2 \[MANDATORY COMPLETION PROTOCOL/),
    );
    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      paneId: "%99",
      messageLength: "now do step 2".length,
      status: "sent",
    });
    expect(result.content[0].text).toContain(
      "Sent follow-up to interactive sub-agent abc12345def67890",
    );
    expect(result.content[0].text).toContain("pane %99");
    expect(result.content[0].text).toContain("Message sent:\nnow do step 2");
  });

  it("appends the mandatory done reminder to every follow-up turn", async () => {
    registerState(api.sessionScope, { status: "idle" });
    mockSendCommandToPane.mockReturnValue(undefined);

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    await toolDef.execute("call-reminder", {
      id: "abc12345def67890",
      message: "inspect the second case",
    });

    const forwarded = mockSendCommandToPane.mock.calls[0][1] as string;
    expect(forwarded).toMatch(/^inspect the second case/);
    expect(forwarded).toMatch(/mandatory.*every.*turn/i);
    expect(forwarded).toContain('"$ARTIFACT_DIR/cli.mjs" done 0');
    expect(forwarded).toMatch(/before.*final assistant response/i);
    expect(forwarded).toMatch(/if.*fails.*do not.*final.*retry/i);
    expect(forwarded).toMatch(/remain in the Pi REPL and wait for follow-up/i);
    expect(forwarded).toMatch(/do not intentionally exit or close the pane/i);
  });

  it("shows the sent message and trims an oversized preview", async () => {
    registerState(api.sessionScope);
    mockSendCommandToPane.mockReturnValue(undefined);
    const message = "a".repeat(600);
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-long", {
      id: "abc12345def67890",
      message,
    });

    const text = result.content[0].text as string;
    expect(text).toContain("Message sent:");
    expect(text).toContain("a".repeat(500));
    expect(text).toContain("… [truncated; 600 chars total]");
    expect(text).not.toContain(message);
    expect(result.details).toMatchObject({
      messagePreview: "a".repeat(500) + "… [truncated; 600 chars total]",
      messageTruncated: true,
    });
  });

  it("accepts 'idle' sub-agents (the follow-up case — child between turns, REPL open)", async () => {
    // 'idle' is the whole point of the follow-up flow: the child finished a turn, REPL is still
    // open, status='idle' (not 'exited'). The tool must accept sends in this state.
    registerState(api.sessionScope, { status: "idle" });
    mockSendCommandToPane.mockReturnValue(undefined);

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-1b", {
      id: "abc12345def67890",
      message: "follow-up after turn 1",
    });

    expect(mockSendCommandToPane).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: "%99" }),
      expect.stringMatching(
        /^follow-up after turn 1 \[MANDATORY COMPLETION PROTOCOL/,
      ),
    );
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("sent");
  });

  it("promotes an idle workflow-owned sub-agent after sending a follow-up", async () => {
    const state = registerState(api.sessionScope, {
      status: "idle",
      completionOwner: "workflow",
      workflowId: "wf-retained",
      workflowResultConsumed: true,
    });
    mockSendCommandToPane.mockImplementation(() => {
      expect(state.completionOwner).toBe("workflow");
      expect(state.workflowId).toBe("wf-retained");
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-promote", {
      id: "abc12345def67890",
      message: "continue independently",
    });

    expect(mockSendCommandToPane).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("sent");
    expect(state.completionOwner).toBe("standalone");
    expect(state.workflowId).toBeUndefined();
  });

  it("rejects an idle workflow-owned sub-agent before its result is consumed", async () => {
    const state = registerState(api.sessionScope, {
      status: "idle",
      completionOwner: "workflow",
      workflowId: "wf-unconsumed",
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-unconsumed", {
      id: "abc12345def67890",
      message: "continue before workflow consumption",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      status: "workflow_owned",
    });
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(state.completionOwner).toBe("workflow");
    expect(state.workflowId).toBe("wf-unconsumed");
  });

  it("rejects follow-ups while a workflow-owned sub-agent is running", async () => {
    const state = registerState(api.sessionScope, {
      completionOwner: "workflow",
      workflowId: "wf-active",
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-workflow-owned", {
      id: "abc12345def67890",
      message: "queue another task",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      status: "workflow_owned",
    });
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(state.completionOwner).toBe("workflow");
    expect(state.workflowId).toBe("wf-active");
  });

  it.each([
    "not-hex",
    "deadbeefcafebabe\n",
    "deadbeefcafebabe\r\n",
    "deadbeefcafebabe\u2028",
    "deadbeefcafebabe\u2029",
  ])("rejects malformed id %j with a precise error", async (id) => {
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-2", {
      id,
      message: "hi",
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ id, status: "invalid_id" });
    expect(result.content[0].text).toMatch(/Invalid sub-agent id/);
  });

  it.each(["", "   ", "\n\n", "\t  \n"])(
    "rejects empty / whitespace-only message: %j",
    async (message) => {
      // An empty Enter in the child REPL would submit a blank prompt and confuse the child;
      // reject it before any registry / tmux work happens.
      const toolDef = getToolDef(api, "send_interactive_subagent_message");
      const result = await toolDef.execute("call-empty", {
        id: "abc12345def67890",
        message,
      });

      expect(mockGet).not.toHaveBeenCalled();
      expect(mockSendCommandToPane).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("empty_message");
      expect(result.details.messageLength).toBe(0);
      expect(result.content[0].text).toMatch(/empty/i);
    },
  );

  it("rejects a message larger than 64 KiB", async () => {
    // Symmetric with MAX_PERSONA_BYTES in interactive-tmux.ts. 64 KiB UTF-8 is well above any
    // realistic follow-up prompt; larger values risk blowing the child REPL history.
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const message = "x".repeat(64 * 1024 + 1);
    const result = await toolDef.execute("call-huge", {
      id: "abc12345def67890",
      message,
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      status: "message_too_large",
      messageLength: 64 * 1024 + 1,
      maxBytes: 64 * 1024,
    });
    expect(result.content[0].text).toMatch(/too large/);
    expect(result.content[0].text).toMatch(/65536/);
  });

  it("accepts a message exactly at the 64 KiB boundary", async () => {
    // Boundary check: 64 KiB is allowed, 64 KiB + 1 is not.
    registerState(api.sessionScope);
    mockSendCommandToPane.mockReturnValue(undefined);

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const message = "x".repeat(64 * 1024);
    const result = await toolDef.execute("call-boundary", {
      id: "abc12345def67890",
      message,
    });

    const forwarded = mockSendCommandToPane.mock.calls[0][1] as string;
    expect(forwarded.startsWith(message)).toBe(true);
    expect(forwarded).toContain('"$ARTIFACT_DIR/cli.mjs" done 0');
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("sent");
    expect(result.details.messageLength).toBe(64 * 1024);
  });
  it("rejects ids found only in the aggregate compatibility registry", async () => {
    mockGet.mockReturnValue(runningState({ id: "deadbeefcafebabe" }));
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-3", {
      id: "deadbeefcafebabe",
      message: "hi",
    });

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("not_found");
  });

  it.each(["cancelled", "exited", "unknown"] as const)(
    "refuses to send when the sub-agent status is %s",
    async (status) => {
      registerState(api.sessionScope, { status });

      const toolDef = getToolDef(api, "send_interactive_subagent_message");
      const result = await toolDef.execute("call-4", {
        id: "abc12345def67890",
        message: "hi",
      });

      expect(mockSendCommandToPane).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe(status);
      expect(result.content[0].text).toContain(`is ${status}`);
    },
  );

  it("returns a structured error when tmux send-keys throws (pane gone between check and send)", async () => {
    registerState(api.sessionScope);
    mockSendCommandToPane.mockImplementation(() => {
      throw new Error("can't find pane: %99");
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-5", {
      id: "abc12345def67890",
      message: "hi",
    });

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      paneId: "%99",
      status: "send_failed",
    });
    expect(result.content[0].text).toContain("Failed to send message");
    expect(result.content[0].text).toContain("can't find pane: %99");
  });
});
