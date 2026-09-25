/**
 * Tests for the `send_interactive_subagent_message` tool.
 *
 * Verifies that the parent-facing tool:
 *   - dispatches follow-ups through the persisted mux backend
 *   - refuses invalid / unknown / non-running sub-agents
 *   - surfaces delivery failures without changing lifecycle or ownership state
 *
 * The tmux/Zellij path stays hermetic through a stubbed send-keys helper. Herdr
 * uses a separately stubbed semantic prompt API, so no live mux is required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

const {
  mockSendCommandToPane,
  mockSendEnterToPane,
  mockAgentPrompt,
  mockGet,
  mockStates,
} = vi.hoisted(() => ({
  mockSendCommandToPane: vi.fn(),
  mockSendEnterToPane: vi.fn(),
  mockAgentPrompt: vi.fn(),
  mockGet: vi.fn(),
  mockStates: new Map<string, any>(),
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

vi.mock("../src/multiplexer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/multiplexer")>();
  return {
    ...actual,
    getMux: vi.fn((options?: { preference?: string }) => {
      if (options?.preference === "herdr") {
        return {
          sendAgentPrompt: mockAgentPrompt,
          sendKeys: (paneId: string, text: string) =>
            mockSendCommandToPane(mockStates.get(paneId), text),
          sendEnter: (paneId: string) => mockSendEnterToPane(paneId),
        };
      }
      return {
        sendKeys: (paneId: string, text: string) =>
          mockSendCommandToPane(mockStates.get(paneId), text),
        sendEnter: (paneId: string) => mockSendEnterToPane(paneId),
      };
    }),
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
    mux: "tmux",
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
  mockStates.set(value.paneId, value);
  return value;
}

describe("send_interactive_subagent_message", () => {
  let api: ReturnType<typeof setupExtension>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStates.clear();
    api = setupExtension();
  });

  afterEach(() => {
    vi.clearAllMocks();
    clearSessionScopes();
    vi.unstubAllGlobals();
  });

  it("is registered with the expected name", () => {
    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    expect(toolDef).toBeDefined();
  });

  it("keeps the legacy id-based success result unchanged", async () => {
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
    expect(result.content[0].text).not.toContain("Test");
    expect(result.content[0].text).toContain("pane %99");
    expect(result.content[0].text).toContain("Message sent:\nnow do step 2");
  });

  it("identifies an Orchestratorv2 recipient by display name while retaining its id", async () => {
    registerState(api.sessionScope, { name: "Release verification" });
    mockSendCommandToPane.mockReturnValue(undefined);
    api.getFlag.mockImplementation((name: string) => name === "orchestratorv2");

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-v2", {
      id: "abc12345def67890",
      message: "check the tarball",
    });

    expect(result.content[0].text).toContain(
      "Sent follow-up to Release verification (17 chars) in pane %99.",
    );
    expect(result.content[0].text).not.toContain("abc12345def67890");
    expect(result.details).toMatchObject({
      id: "abc12345def67890",
      status: "sent",
    });
    expect(mockSendCommandToPane).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "abc12345def67890",
        name: "Release verification",
      }),
      expect.stringMatching(
        /^check the tarball \[MANDATORY COMPLETION PROTOCOL/,
      ),
    );
  });

  it("does not accept an Orchestratorv2 display name as a routing key", async () => {
    registerState(api.sessionScope, { name: "deadbeefcafebabe" });
    api.getFlag.mockImplementation((name: string) => name === "orchestratorv2");

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-v2-name", {
      id: "deadbeefcafebabe",
      message: "route by name",
    });

    expect(result.details).toMatchObject({
      id: "deadbeefcafebabe",
      status: "not_found",
    });
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
  });

  it("uses a safe bounded Orchestratorv2 fallback and display label", async () => {
    const state = registerState(api.sessionScope, {
      name: undefined as unknown as string,
    });
    mockSendCommandToPane.mockReturnValue(undefined);
    api.getFlag.mockImplementation((name: string) => name === "orchestratorv2");
    const toolDef = getToolDef(api, "send_interactive_subagent_message");

    const fallbackResult = await toolDef.execute("call-v2-fallback", {
      id: state.id,
      message: "continue",
    });
    expect(fallbackResult.content[0].text).toContain(
      "Sent follow-up to interactive sub-agent (8 chars) in pane %99.",
    );

    state.name = `line one\n${"x".repeat(500)}`;
    const boundedResult = await toolDef.execute("call-v2-bounded", {
      id: state.id,
      message: "continue safely",
    });
    const firstLine = (boundedResult.content[0].text as string).split("\n")[0];
    expect(firstLine).toContain(`line one ${"x".repeat(151)} (15 chars)`);
    expect(firstLine).not.toContain("x".repeat(152));
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

  it("uses Herdr agent.prompt and transitions only after its positive acceptance", async () => {
    const state = registerState(api.sessionScope, {
      mux: "herdr",
      status: "idle",
    });
    mockAgentPrompt.mockResolvedValue({ status: "sent" });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-herdr-success", {
      id: state.id,
      message: "continue through Herdr",
    });

    expect(mockAgentPrompt).toHaveBeenCalledOnce();
    expect(mockAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: state.paneId }),
      expect.stringMatching(
        /^continue through Herdr \[MANDATORY COMPLETION PROTOCOL/,
      ),
    );
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("sent");
    expect(state.completionPolicy).toBe("each");
  });

  it("promotes a consumed workflow-owned Herdr child when its accepted prompt starts a turn", async () => {
    const state = registerState(api.sessionScope, {
      mux: "herdr",
      status: "idle",
      completionOwner: "workflow",
      workflowId: "wf-herdr",
      workflowResultConsumed: true,
      completionPolicy: "group",
      completionGroupId: "finished-herdr-group",
    });
    mockAgentPrompt.mockImplementation(async () => {
      state.status = "running";
      return { status: "sent" };
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-herdr-workflow", {
      id: state.id,
      message: "continue independently",
    });

    expect(result.isError).toBeFalsy();
    expect(state.status).toBe("running");
    expect(state.completionOwner).toBe("standalone");
    expect(state.workflowId).toBeUndefined();
    expect(state.completionPolicy).toBe("each");
    expect(state.completionGroupId).toBeUndefined();
  });

  it.each(["tmux", "zellij"] as const)(
    "keeps %s follow-ups on the generic text+Enter path",
    async (mux) => {
      const state = registerState(api.sessionScope, { mux, status: "idle" });
      mockSendCommandToPane.mockReturnValue(undefined);

      const toolDef = getToolDef(api, "send_interactive_subagent_message");
      const result = await toolDef.execute(`call-${mux}`, {
        id: state.id,
        message: `continue in ${mux}`,
      });

      expect(mockSendCommandToPane).toHaveBeenCalledOnce();
      expect(mockSendCommandToPane).toHaveBeenCalledWith(
        state,
        expect.stringMatching(
          new RegExp(`^continue in ${mux} \\[MANDATORY COMPLETION PROTOCOL`),
        ),
      );
      expect(mockSendEnterToPane).toHaveBeenCalledWith(state.paneId);
      expect(mockAgentPrompt).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect(result.details.status).toBe("sent");
    },
  );

  it.each([
    [
      "blocked approval UI",
      {
        status: "blocked",
        errorCode: "agent_blocked",
        message: "approval required",
      },
    ],
    [
      "unsupported API",
      { status: "unsupported", reason: "version", message: "upgrade Herdr" },
    ],
    [
      "malformed preflight response",
      {
        status: "malformed_response",
        delivery: "not_sent",
        message: "bad ping",
      },
    ],
    [
      "transport failure before prompt request",
      {
        status: "transport_error",
        delivery: "not_sent",
        message: "ping failed",
      },
    ],
    [
      "unrecognized active agent",
      {
        status: "rejected",
        errorCode: "agent_not_ready",
        message: "no active agent",
      },
    ],
  ] as const)(
    "uses the mux input fallback after Herdr confirms no prompt was submitted (%s)",
    async (_label, promptResult) => {
      const state = registerState(api.sessionScope, {
        mux: "herdr",
        status: "idle",
        completionOwner: "workflow",
        workflowId: "workflow-released-after-fallback",
        workflowResultConsumed: true,
        completionPolicy: "group",
        completionGroupId: "group-released-after-fallback",
      });
      mockAgentPrompt.mockResolvedValue(promptResult);

      const toolDef = getToolDef(api, "send_interactive_subagent_message");
      const result = await toolDef.execute("call-herdr-fallback", {
        id: state.id,
        message: "continue safely",
      });

      expect(mockAgentPrompt).toHaveBeenCalledOnce();
      expect(mockSendCommandToPane).toHaveBeenCalledOnce();
      expect(mockSendCommandToPane).toHaveBeenCalledWith(
        state,
        expect.stringMatching(
          /^continue safely \[MANDATORY COMPLETION PROTOCOL/,
        ),
      );
      expect(mockSendEnterToPane).toHaveBeenCalledWith(state.paneId);
      expect(result.isError).toBeFalsy();
      expect(result.details.status).toBe("sent");
      expect(state.status).toBe("idle");
      expect(state.completionOwner).toBe("standalone");
      expect(state.workflowId).toBeUndefined();
      expect(state.completionPolicy).toBe("each");
      expect(state.completionGroupId).toBeUndefined();
    },
  );

  it.each([
    [
      "malformed prompt response",
      {
        status: "malformed_response",
        delivery: "uncertain",
        message: "bad response",
      },
    ],
    [
      "transport failure after request",
      {
        status: "transport_error",
        delivery: "uncertain",
        message: "socket closed",
      },
    ],
    [
      "uncertain timeout",
      { status: "uncertain", reason: "timeout", message: "request timed out" },
    ],
  ] as const)(
    "does not raw-fallback or change lifecycle state after %s",
    async (_label, promptResult) => {
      const state = registerState(api.sessionScope, {
        mux: "herdr",
        status: "idle",
        completionOwner: "workflow",
        workflowId: "workflow-kept-on-uncertainty",
        workflowResultConsumed: true,
        completionPolicy: "group",
        completionGroupId: "group-kept-on-uncertainty",
        notifyOnComplete: "inject",
        triggerTurnOnComplete: true,
      });
      const before = {
        status: state.status,
        completionOwner: state.completionOwner,
        workflowId: state.workflowId,
        completionPolicy: state.completionPolicy,
        completionGroupId: state.completionGroupId,
        notifyOnComplete: state.notifyOnComplete,
        triggerTurnOnComplete: state.triggerTurnOnComplete,
      };
      const capturedKeys = new Set<string>();
      api.sessionScope.telemetry = {
        enabled: true,
        mode: "straight",
        correlationId: "send-message-test",
        capturedKeys,
        active: true,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ body: { cancel: vi.fn() } }),
      );
      mockAgentPrompt.mockResolvedValue(promptResult);

      const toolDef = getToolDef(api, "send_interactive_subagent_message");
      const result = await toolDef.execute("call-herdr-uncertain", {
        id: state.id,
        message: "continue safely",
      });

      expect(mockAgentPrompt).toHaveBeenCalledOnce();
      expect(mockSendCommandToPane).not.toHaveBeenCalled();
      expect(mockSendEnterToPane).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details.status).toBe("send_uncertain");
      expect(result.details.delivery).toBe("uncertain");
      expect(state).toMatchObject(before);
      expect([...capturedKeys]).toEqual([]);
    },
  );

  it("reports uncertainty if raw input fallback fails", async () => {
    const state = registerState(api.sessionScope, {
      mux: "herdr",
      status: "idle",
      completionOwner: "workflow",
      workflowId: "workflow-kept-on-fallback-error",
      workflowResultConsumed: true,
      completionPolicy: "group",
      completionGroupId: "group-kept-on-fallback-error",
    });
    mockAgentPrompt.mockResolvedValue({
      status: "blocked",
      errorCode: "agent_blocked",
      message: "approval required",
    });
    mockSendCommandToPane.mockImplementation(() => {
      throw new Error("raw input failed");
    });

    const toolDef = getToolDef(api, "send_interactive_subagent_message");
    const result = await toolDef.execute("call-herdr-fallback-error", {
      id: state.id,
      message: "continue safely",
    });

    expect(mockAgentPrompt).toHaveBeenCalledOnce();
    expect(mockSendCommandToPane).toHaveBeenCalledOnce();
    expect(mockSendEnterToPane).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("send_uncertain");
    expect(result.details.delivery).toBe("uncertain");
    expect(state.completionOwner).toBe("workflow");
    expect(state.completionPolicy).toBe("group");
    expect(state.completionGroupId).toBe("group-kept-on-fallback-error");
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
    expect(state.completionPolicy).toBe("each");
    expect(state.completionGroupId).toBeUndefined();
  });

  it("starts a new independent completion policy after a grouped follow-up", async () => {
    const state = registerState(api.sessionScope, {
      status: "idle",
      completionPolicy: "group",
      completionGroupId: "finished-group",
    });
    mockSendCommandToPane.mockReturnValue(undefined);
    const toolDef = getToolDef(api, "send_interactive_subagent_message");

    const result = await toolDef.execute("call-new-turn", {
      id: state.id,
      message: "start another turn",
    });

    expect(result.isError).toBeFalsy();
    expect(state.completionPolicy).toBe("each");
    expect(state.completionGroupId).toBeUndefined();
  });

  it("reports a persistence warning without misreporting a successful send", async () => {
    const state = registerState(api.sessionScope, {
      status: "idle",
      cwd: "/dev/null",
      parentSessionId: "parent",
      completionPolicy: "group",
      completionGroupId: "finished-group",
    });
    mockSendCommandToPane.mockReturnValue(undefined);
    const toolDef = getToolDef(api, "send_interactive_subagent_message");

    const result = await toolDef.execute("call-persist-warning", {
      id: state.id,
      message: "start another turn",
    });

    expect(mockSendCommandToPane).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("sent");
    expect(result.details.persistenceWarning).toMatch(/could not be persisted/);
    expect(result.content[0].text).toContain("Warning:");
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
