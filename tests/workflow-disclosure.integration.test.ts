import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantMessage,
  Context,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const repoRoot = new URL("..", import.meta.url).pathname;
const harnesses: PiSessionHarness[] = [];

const ZERO_USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type WorkflowRunStatus = "error" | "waiting_for_input" | "done";
type WorkflowRunListing = {
  runs: {
    workflowId: string;
    name: string;
    status: WorkflowRunStatus;
    error?: string;
  }[];
};

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

async function createHarness(
  options: {
    sessionManager?: SessionManager;
    modelContextWindow?: number;
    compactionSettings?: {
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    };
    assistantUsage?: Usage;
  } = {},
): Promise<PiSessionHarness> {
  const harness = await createPiSessionHarness(repoRoot, {
    bindExtensionLifecycle: true,
    ...options,
  });
  harnesses.push(harness);
  return harness;
}

function userMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "subagentura-faux",
    provider: "subagentura-faux",
    model: "faux-model",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function workflowListCall(callId: string): AssistantMessage {
  return {
    ...assistantMessage(""),
    content: [
      {
        type: "toolCall",
        id: callId,
        name: "list_workflow_runs",
        arguments: {},
      },
    ],
    stopReason: "toolUse",
  };
}
type WorkflowFailureDetails = {
  status: "error";
  workflowId: string;
  error: string;
};

function workflowResultCall(
  callId: string,
  workflowId: string,
): AssistantMessage {
  return {
    ...assistantMessage(""),
    content: [
      {
        type: "toolCall",
        id: callId,
        name: "get_workflow_result",
        arguments: { workflowId },
      },
    ],
    stopReason: "toolUse",
  };
}

function workflowResultFailure(
  label: string,
  diagnostic: string,
): ToolResultMessage<WorkflowFailureDetails> {
  return {
    role: "toolResult",
    toolCallId: `${label}-result-call`,
    toolName: "get_workflow_result",
    content: [
      {
        type: "text",
        text: `Workflow ${label}-failed-run error: ${diagnostic}`,
      },
    ],
    details: {
      status: "error",
      workflowId: `${label}-failed-run`,
      error: diagnostic,
    },
    isError: true,
    timestamp: Date.now(),
  };
}

function workflowListResult(
  label: string,
  diagnostic: string,
): ToolResultMessage<WorkflowRunListing> {
  return {
    role: "toolResult",
    toolCallId: `${label}-call`,
    toolName: "list_workflow_runs",
    content: [
      {
        type: "text",
        text: [
          `${label}-failed-run ${label}-failed-name: error`,
          `${label}-waiting-run ${label}-waiting-name: waiting_for_input`,
          `${label}-done-run ${label}-done-name: done`,
        ].join("\n"),
      },
    ],
    details: {
      runs: [
        {
          workflowId: `${label}-failed-run`,
          name: `${label}-failed-name`,
          status: "error",
          error: diagnostic,
        },
        {
          workflowId: `${label}-waiting-run`,
          name: `${label}-waiting-name`,
          status: "waiting_for_input",
        },
        {
          workflowId: `${label}-done-run`,
          name: `${label}-done-name`,
          status: "done",
        },
      ],
    },
    isError: false,
    timestamp: Date.now(),
  };
}

function appendWorkflowList(
  sessionManager: SessionManager,
  label: string,
  diagnostic: string,
): void {
  const result = workflowListResult(label, diagnostic);
  sessionManager.appendMessage(userMessage(`List workflow runs for ${label}.`));
  sessionManager.appendMessage(workflowListCall(result.toolCallId));
  sessionManager.appendMessage(result);
  const failure = workflowResultFailure(label, diagnostic);
  sessionManager.appendMessage(
    workflowResultCall(failure.toolCallId, `${label}-failed-run`),
  );
  sessionManager.appendMessage(failure);
}

type PersistedWorkflowMessageSnapshot = {
  entryId: string;
  message: unknown;
};

function snapshotWorkflowMessages(
  sessionManager: SessionManager,
  label: string,
): PersistedWorkflowMessageSnapshot[] {
  const snapshots: PersistedWorkflowMessageSnapshot[] = [];
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult")
      continue;
    const message = entry.message;
    if (
      (message.toolName === "list_workflow_runs" &&
        message.toolCallId === `${label}-call`) ||
      (message.toolName === "get_workflow_result" &&
        message.toolCallId === `${label}-result-call`)
    ) {
      snapshots.push({
        entryId: entry.id,
        message: structuredClone(message),
      });
    }
  }
  expect(snapshots).toHaveLength(2);
  return snapshots;
}

function expectWorkflowMessagesUnchanged(
  sessionManager: SessionManager,
  snapshots: readonly PersistedWorkflowMessageSnapshot[],
): void {
  for (const snapshot of snapshots) {
    const current = sessionManager.getEntry(snapshot.entryId);
    expect(current?.type).toBe("message");
    if (!current || current.type !== "message")
      throw new Error(
        `Original session message ${snapshot.entryId} is missing.`,
      );
    expect(current.message).toEqual(snapshot.message);
  }
}

function findWorkflowList(
  context: Context,
  label: string,
): ToolResultMessage<WorkflowRunListing> | undefined {
  const result = context.messages.find(
    (message): message is ToolResultMessage<WorkflowRunListing> =>
      message.role === "toolResult" &&
      message.toolName === "list_workflow_runs" &&
      message.toolCallId === `${label}-call`,
  );
  return result;
}

function expectSafeWorkflowRows(
  content: string,
  details: string,
  label: string,
  diagnostic: string,
): void {
  expect(content).not.toContain(diagnostic);
  expect(details).not.toContain(diagnostic);
  for (const value of [
    `${label}-failed-run`,
    `${label}-failed-name`,
    `${label}-waiting-run`,
    `${label}-waiting-name`,
    `${label}-done-run`,
    `${label}-done-name`,
  ]) {
    expect(content).toContain(value);
    expect(details).toContain(value);
  }
  for (const status of ["error", "waiting_for_input", "done"]) {
    expect(content).toContain(status);
    expect(details).toContain(status);
  }
}

describe("workflow diagnostic SDK request boundaries", () => {
  it("keeps mixed safe rows in a real model turn while retaining the raw session ledger", async () => {
    const sessionManager = SessionManager.inMemory();
    const diagnostic = "PRIVATE_WORKFLOW_NORMAL_TURN_canary";
    appendWorkflowList(sessionManager, "normal", diagnostic);
    const originalMessages = snapshotWorkflowMessages(sessionManager, "normal");
    const harness = await createHarness({ sessionManager });

    const turn = harness.session.prompt("Continue with normal-waiting-run.");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const context = harness.contexts[0]!;
    const result = findWorkflowList(context, "normal");

    harness.completeNext("Continue safely.");
    await turn;

    expect(result).toBeDefined();
    expectSafeWorkflowRows(
      JSON.stringify(result?.content ?? []),
      JSON.stringify(result?.details ?? {}),
      "normal",
      diagnostic,
    );
    expect(JSON.stringify(context.messages)).not.toContain(diagnostic);
    expectWorkflowMessagesUnchanged(sessionManager, originalMessages);
    expect(JSON.stringify(sessionManager.getEntries())).toContain(diagnostic);
  });

  it("filters an actual manual compaction request without rewriting stored messages", async () => {
    const sessionManager = SessionManager.inMemory();
    const diagnostic = "PRIVATE_WORKFLOW_MANUAL_COMPACTION_canary";
    appendWorkflowList(sessionManager, "manual", diagnostic);
    sessionManager.appendMessage(
      userMessage(
        `Recent retained context: ${"recent-context ".repeat(8_000)}`,
      ),
    );
    const originalMessages = snapshotWorkflowMessages(sessionManager, "manual");
    const harness = await createHarness({ sessionManager });

    const compaction = harness.session.compact();
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const request = harness.contexts[0]!;
    harness.completeNext("Manual compaction summary.");
    await compaction;

    expectSafeWorkflowRows(
      JSON.stringify(request.messages),
      JSON.stringify(request.messages),
      "manual",
      diagnostic,
    );
    expectWorkflowMessagesUnchanged(sessionManager, originalMessages);
    expect(JSON.stringify(sessionManager.getEntries())).toContain(diagnostic);
  });

  it("filters both actual SDK split-turn compaction requests", async () => {
    const sessionManager = SessionManager.inMemory();
    const historyDiagnostic = "PRIVATE_WORKFLOW_SPLIT_HISTORY_canary";
    const prefixDiagnostic = "PRIVATE_WORKFLOW_SPLIT_PREFIX_canary";
    appendWorkflowList(sessionManager, "split-history", historyDiagnostic);
    sessionManager.appendMessage(
      assistantMessage("The earlier listing is complete."),
    );
    const prefixResult = workflowListResult("split-prefix", prefixDiagnostic);
    sessionManager.appendMessage(userMessage("Start a large current turn."));
    sessionManager.appendMessage(workflowListCall(prefixResult.toolCallId));
    sessionManager.appendMessage(prefixResult);
    const prefixFailure = workflowResultFailure(
      "split-prefix",
      prefixDiagnostic,
    );
    sessionManager.appendMessage(
      workflowResultCall(prefixFailure.toolCallId, "split-prefix-failed-run"),
    );
    sessionManager.appendMessage(prefixFailure);
    sessionManager.appendMessage(assistantMessage("x".repeat(100_000)));
    const originalMessages = [
      ...snapshotWorkflowMessages(sessionManager, "split-history"),
      ...snapshotWorkflowMessages(sessionManager, "split-prefix"),
    ];
    const harness = await createHarness({ sessionManager });

    const compaction = harness.session.compact();
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const historyRequest = harness.contexts[0]!;
    harness.completeNext("History summary.");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    const prefixRequest = harness.contexts[1]!;
    harness.completeNext("Turn prefix summary.");
    await compaction;

    const historyPayload = JSON.stringify(historyRequest.messages);
    const prefixPayload = JSON.stringify(prefixRequest.messages);
    expect(historyPayload).not.toContain(historyDiagnostic);
    expect(historyPayload).not.toContain(prefixDiagnostic);
    expect(prefixPayload).not.toContain(historyDiagnostic);
    expect(prefixPayload).not.toContain(prefixDiagnostic);
    expect(historyPayload).toContain("split-history-waiting-run");
    expect(prefixPayload).toContain("split-prefix-waiting-run");
    expectWorkflowMessagesUnchanged(sessionManager, originalMessages);
    expect(JSON.stringify(sessionManager.getEntries())).toContain(
      historyDiagnostic,
    );
    expect(JSON.stringify(sessionManager.getEntries())).toContain(
      prefixDiagnostic,
    );
  });

  it("filters automatic threshold compaction provider requests", async () => {
    const sessionManager = SessionManager.inMemory();
    const diagnostic = "PRIVATE_WORKFLOW_AUTOMATIC_COMPACTION_canary";
    appendWorkflowList(sessionManager, "automatic", diagnostic);
    const originalMessages = snapshotWorkflowMessages(
      sessionManager,
      "automatic",
    );
    const thresholdUsage: Usage = {
      input: 48_999,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 49_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const harness = await createHarness({
      sessionManager,
      modelContextWindow: 50_000,
      compactionSettings: {
        enabled: true,
        reserveTokens: 5_000,
        keepRecentTokens: 1,
      },
      assistantUsage: thresholdUsage,
    });
    const compactionReasons: string[] = [];
    harness.session.subscribe((event) => {
      if (event.type === "compaction_start")
        compactionReasons.push(event.reason);
    });

    const turn = harness.session.prompt("Continue with automatic-waiting-run.");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const normalRequest = harness.contexts[0]!;
    harness.completeNext("The normal turn is complete.");
    await vi.waitFor(() => expect(compactionReasons).toContain("threshold"));
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    const historyRequest = harness.contexts[1]!;
    harness.completeNext("Automatic history summary.");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(3));
    const prefixRequest = harness.contexts[2]!;
    harness.completeNext("Automatic turn prefix summary.");
    await turn;

    expect(compactionReasons).toContain("threshold");
    expect(JSON.stringify(normalRequest.messages)).not.toContain(diagnostic);
    expect(JSON.stringify(historyRequest.messages)).not.toContain(diagnostic);
    expect(JSON.stringify(prefixRequest.messages)).not.toContain(diagnostic);
    expect(JSON.stringify(historyRequest.messages)).toContain(
      "automatic-waiting-run",
    );
    expect(
      sessionManager.getEntries().some((entry) => entry.type === "compaction"),
    ).toBe(true);
    expectWorkflowMessagesUnchanged(sessionManager, originalMessages);
    expect(JSON.stringify(sessionManager.getEntries())).toContain(diagnostic);
  });
});
