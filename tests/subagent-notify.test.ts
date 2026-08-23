import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import { importFresh } from "./test-utils";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JobState, SubagentResult } from "../src/helpers";
import {
  deliverNotification,
  flushInProcessDeliveries,
  MAX_IN_PROCESS_DELIVERY_BYTES,
  MAX_IN_PROCESS_DELIVERY_RECORDS,
} from "../src/notifications";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  setLegacyActiveSessionRefs,
  type SessionScope,
} from "../src/session-scope";

// ── Hoisted mock: startSubagentJob must be mocked before any imports ──────
const { mockStartSubagentJob } = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
}));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, startSubagentJob: mockStartSubagentJob };
});

// ── Imports (resolved after hoisted mock) ─────────────────────────────────
import registerExtension from "../src/subagent";
import { jobRegistry, registerInProcessJob } from "../src/helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────

const SUCCESS_RESULT: SubagentResult = {
  output: "All tests pass",
  usage: {
    input: 10,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
    turns: 1,
  },
  model: "test/test-model",
  isError: false,
};

const ERROR_RESULT: SubagentResult = {
  output: "Something broke",
  usage: {
    input: 5,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.0005,
    turns: 1,
  },
  model: undefined,
  isError: true,
  errorMessage: "API rate limit exceeded",
};

const EMPTY_OUTPUT_RESULT: SubagentResult = {
  output: "",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: false,
};

const ZERO_USAGE_RESULT: SubagentResult = {
  output: "Done",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: false,
};

/** Error result whose errorMessage contains an API key — triggers sanitizeOutput. */
const SECRET_ERROR_RESULT: SubagentResult = {
  output: "Some output",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
  model: undefined,
  isError: true,
  errorMessage: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
};

// ── Test helpers ──────────────────────────────────────────────────────────

/** Create a controllable promise + resolve/reject pair for one subagent job. */
function createJobControl() {
  let resolve!: (value: SubagentResult) => void;
  let reject!: (reason: unknown) => void;
  const jobPromise = new Promise<SubagentResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, jobPromise };
}

/** Build a minimal ExtensionContext mock suitable for subagent_isolated. */
function mockCtx() {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    ui: { setStatus: vi.fn() },
  };
}

/** Build a ctx where ui.setStatus throws (stale context simulation). */
function mockStaleCtx() {
  return {
    cwd: "/tmp",
    model: { provider: "test", id: "test-model" },
    ui: {
      setStatus: vi.fn().mockImplementation(() => {
        throw new Error("stale context");
      }),
    },
  };
}

/** Build a mock ctx with sessionManager for subagent_with_context tests. */
function mockCtxWithHistory() {
  return {
    cwd: "/tmp",
    sessionManager: {
      getBranch: vi
        .fn()
        .mockReturnValue([
          { type: "message", message: { role: "user", content: "test input" } },
        ]),
    },
    model: { provider: "test", id: "test-model" },
    ui: { setStatus: vi.fn() },
  };
}

/** Return a resolved value for the startSubagentJob mock. */
function mockJobResult(
  jobId: string,
  jobPromise: Promise<SubagentResult>,
  modelLabel = "test/test-model",
) {
  return Promise.resolve({
    jobId,
    jobPromise,
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
    modelLabel,
  });
}

/** Shared state that must be cleaned between tests. */
function cleanGlobals() {
  clearSessionScopes();
  setLegacyActiveSessionRefs(undefined);
  jobRegistry.clear();
}

/**
 * sendMessage receives `[message]` (an array wrapping a single message) as its
 * first argument — the source code passes `[{ customType, content, display, details }]`.
 * These helpers consistently unwrap it.
 */
function sentMessageAt(api: any, callIndex: number) {
  const batch = api.sendMessage.mock.calls[callIndex][0];
  return Array.isArray(batch) ? batch[0] : batch;
}

function sentMessageOptsAt(api: any, callIndex: number) {
  return api.sendMessage.mock.calls[callIndex][1];
}

function registerOwnedNotificationJob(
  state: JobState,
  scope: SessionScope,
): void {
  state.deliveryOwner = {
    ...state.deliveryOwner,
    pi: scope.pi,
    sessionScopeId: scope.id,
    sessionScopeGeneration: scope.generation,
  };
  if (!registerInProcessJob(state, sessionOwner(scope))) {
    throw new Error(`Failed to register owned notification job ${state.id}`);
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("notifyOnComplete", () => {
  let api: ReturnType<typeof setupExtension>["api"];
  let scope: SessionScope;
  let isolatedToolDef: any;
  let contextToolDef: any;
  let statusToolDef: any;

  /** Build the minimal ExtensionAPI mock and register the extension. */
  function setupExtension() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn(),
      notify: vi.fn(),
    };

    registerExtension(_api as any);
    const sessionContext = getSessionScopes().at(-1);
    if (!sessionContext) throw new Error("Expected a registered session scope");
    sessionContext.lifecycle = "started";
    sessionContext.ui = { notify: _api.notify } as unknown as NonNullable<
      SessionScope["ui"]
    >;

    const isolatedDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "subagent_isolated",
    )?.[0];

    const contextDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "subagent_with_context",
    )?.[0];

    const statusDef = _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "get_subagent_status",
    )?.[0];

    return {
      api: _api,
      scope: sessionContext,
      isolatedToolDef: isolatedDef,
      contextToolDef: contextDef,
      statusToolDef: statusDef,
    };
  }

  beforeEach(() => {
    mockStartSubagentJob.mockReset(); // clear stale mockImplementationOnce handlers
    vi.clearAllMocks();
    cleanGlobals();

    const setup = setupExtension();
    api = setup.api;
    scope = setup.scope;
    isolatedToolDef = setup.isolatedToolDef;
    contextToolDef = setup.contextToolDef;
    statusToolDef = setup.statusToolDef;

    // Guard: ensure tools were captured
    expect(isolatedToolDef).toBeDefined();
    expect(contextToolDef).toBeDefined();
    expect(statusToolDef).toBeDefined();
  });

  it("does not instruct Orchestratorv2 to call an in-process result tool", async () => {
    api.getFlag.mockImplementation((name: string) => name === "orchestratorv2");
    const control = createJobControl();
    mockStartSubagentJob.mockImplementationOnce(() =>
      mockJobResult("compatibility-job", control.jobPromise),
    );

    await isolatedToolDef.execute(
      "call-v2-compatibility",
      { async: true, task: "legacy", notifyOnComplete: "notify" },
      undefined,
      undefined,
      mockCtx(),
    );
    control.resolve(SUCCESS_RESULT);
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());

    const content = sentMessageAt(api, 0).content;
    expect(content).toContain("compatibility job");
    expect(content).toContain("without calling in-process tools");
    expect(content).not.toContain("use get_subagent_result");
  });

  afterEach(() => {
    cleanGlobals();
  });

  // ── Notification delivery (both tools) ──────────────────────────────
  // Key delivery assertions run for both subagent_isolated and subagent_with_context
  describe("both tools deliver notifications", () => {
    const toolCases = [
      ["subagent_isolated", () => isolatedToolDef, () => mockCtx()] as const,
      [
        "subagent_with_context",
        () => contextToolDef,
        () => mockCtxWithHistory(),
      ] as const,
    ];

    for (const [label, getToolDef, getCtx] of toolCases) {
      describe(label, () => {
        it("persists a pointer-only custom message in notify mode", async () => {
          const toolDef = getToolDef();
          const jobId = `both-notify-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          const spawnResult = await toolDef.execute(
            "call-1",
            { async: true, task: "test", notifyOnComplete: "notify" },
            undefined,
            undefined,
            getCtx(),
          );

          expect(spawnResult.content[0].text).toContain(
            "Completion output will not be injected into the parent LLM",
          );
          expect(spawnResult.content[0].text).toContain(
            "No new parent turn will start automatically",
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const content = sentMessageAt(api, 0).content;
          expect(content).toContain(jobId);
          expect(content).toContain("✅");
          expect(content).toContain("get_subagent_result");
          expect(content).not.toContain(SUCCESS_RESULT.output);
          expect(sentMessageOptsAt(api, 0)).toMatchObject({
            deliverAs: "followUp",
            triggerTurn: false,
          });
          expect(api.notify).toHaveBeenCalledWith(
            expect.stringContaining(
              "Completion output was not injected into the parent LLM",
            ),
            "info",
          );
          expect(api.notify.mock.calls[0][0]).toContain(
            "No new parent turn will start automatically",
          );
          expect(api.sendUserMessage).not.toHaveBeenCalled();
        });

        it("shows active async jobs in the footer and clears them on completion", async () => {
          const toolDef = getToolDef();
          const ctx = getCtx();
          const jobId = `footer-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-footer",
            { async: true, task: "test" },
            undefined,
            undefined,
            ctx,
          );

          expect(ctx.ui.setStatus).toHaveBeenCalledWith(
            "subagentura-running",
            "⚡ 1 sub-agent active",
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(ctx.ui.setStatus).toHaveBeenCalledWith(
              "subagentura-running",
              undefined,
            );
          });
        });

        it("defaults async completion delivery to inject", async () => {
          const toolDef = getToolDef();
          const jobId = `both-default-inject-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          const spawnResult = await toolDef.execute(
            "call-default-inject",
            { async: true, task: "test" },
            undefined,
            undefined,
            getCtx(),
          );
          expect(spawnResult.content[0].text).toContain(
            "Completion output will be injected into the parent LLM",
          );
          expect(spawnResult.content[0].text).toContain(
            "A new parent turn will start automatically after the injection",
          );
          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });
          expect(sentMessageAt(api, 0).content).toContain(
            SUCCESS_RESULT.output,
          );
          expect(sentMessageAt(api, 0).details.mode).toBe("inject");
          expect(sentMessageOptsAt(api, 0)).toMatchObject({
            deliverAs: "followUp",
            triggerTurn: true,
          });
        });

        it("adds triggerTurn when triggerTurnOnComplete is true in notify mode", async () => {
          const toolDef = getToolDef();
          const jobId = `both-trigger-turn-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-trigger-turn",
            {
              async: true,
              task: "test",
              notifyOnComplete: "notify",
              triggerTurnOnComplete: true,
            },
            undefined,
            undefined,
            getCtx(),
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          expect(sentMessageOptsAt(api, 0)).toMatchObject({
            deliverAs: "followUp",
            triggerTurn: true,
          });
          expect(sentMessageAt(api, 0).content).not.toContain(
            SUCCESS_RESULT.output,
          );
          expect(sentMessageAt(api, 0).content).toContain(
            "get_subagent_result",
          );
          expect(api.sendUserMessage).not.toHaveBeenCalled();
          expect(api.notify).toHaveBeenCalledWith(
            expect.stringContaining(
              "Completion output was not injected into the parent LLM",
            ),
            "info",
          );
          expect(api.notify.mock.calls[0][0]).toContain(
            "A new parent turn will start automatically after the pointer delivery",
          );
        });

        it("injects full result in one attributed custom message", async () => {
          const toolDef = getToolDef();
          const jobId = `both-inject-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-2",
            { async: true, task: "test", notifyOnComplete: "inject" },
            undefined,
            undefined,
            getCtx(),
          );

          control.resolve(SUCCESS_RESULT);

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const msg = sentMessageAt(api, 0);
          const msgOpts = sentMessageOptsAt(api, 0);
          expect(msg).toMatchObject({
            customType: "subagent-notify",
            display: true,
            details: { jobId, mode: "inject" },
          });
          expect(msg.content).toContain(SUCCESS_RESULT.output);
          expect(msgOpts).toMatchObject({
            deliverAs: "followUp",
            triggerTurn: true,
          });
          expect(api.sendUserMessage).not.toHaveBeenCalled();
          expect(api.notify).toHaveBeenCalledWith(
            expect.stringContaining(
              "Completion output was injected into the parent LLM",
            ),
            "info",
          );
          expect(api.notify.mock.calls[0][0]).toContain(
            "A new parent turn will start automatically after the injection",
          );
        });

        it("delivers notification when job promise rejects", async () => {
          const toolDef = getToolDef();
          const jobId = `both-reject-${label}`;
          const control = createJobControl();
          mockStartSubagentJob.mockImplementationOnce(() =>
            mockJobResult(jobId, control.jobPromise),
          );

          await toolDef.execute(
            "call-3",
            { async: true, task: "test", notifyOnComplete: "notify" },
            undefined,
            undefined,
            getCtx(),
          );

          control.reject(new Error("Connection timeout"));

          await vi.waitFor(() => {
            expect(api.sendMessage).toHaveBeenCalledTimes(1);
          });

          const content = sentMessageAt(api, 0).content;
          expect(content).toContain("❌");
          expect(content).toContain("Connection timeout");
        });
      });
    }
  });

  // ── Notify mode ───────────────────────────────────────────────────
  describe("notify mode", () => {
    it("persists a pointer summary without triggering a parent turn", async () => {
      const jobId = "notify-test-1";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      // Fire execute — triggers async subagent spawn, returns immediately
      await isolatedToolDef.execute(
        "call-1",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Complete the subagent job
      control.resolve(SUCCESS_RESULT);

      // Wait for the .then() handler and deliverNotification to run
      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      expect(content).toContain(jobId);
      expect(content).toContain("✅");
      expect(content).not.toContain(SUCCESS_RESULT.output);
      expect(sentMessageOptsAt(api, 0).triggerTurn).toBe(false);
      expect(api.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Completion output was not injected into the parent LLM",
        ),
        "info",
      );
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    });

    it("includes usage info in the summary when usage is non-zero", async () => {
      const jobId = "notify-usage";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-2",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content: string = sentMessageAt(api, 0).content;
      // formatUsage for SUCCESS_RESULT produces: "1 turn ↑10 ↓50 $0.0010 test/test-model"
      expect(content).toContain("1 turn");
      expect(content).toContain("↑10");
      expect(content).toContain("↓50");
      expect(content).toContain("$0.0010");
    });
  });

  // ── Inject mode ───────────────────────────────────────────────────
  describe("inject mode", () => {
    it("injects the full result in one custom completion envelope", async () => {
      const jobId = "inject-test-1";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-3",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const msg = sentMessageAt(api, 0);
      const msgOpts = sentMessageOptsAt(api, 0);
      expect(msg).toMatchObject({
        customType: "subagent-notify",
        display: true,
        details: { jobId, mode: "inject" },
      });
      expect(msg.content).toContain(SUCCESS_RESULT.output);
      expect(msgOpts).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(api.sendUserMessage).not.toHaveBeenCalled();
      expect(api.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Completion output was injected into the parent LLM",
        ),
        "info",
      );
      expect(api.notify.mock.calls[0][0]).toContain(
        "A new parent turn will start automatically after the injection",
      );
    });

    it("queues triggering inject completion through Pi while streaming", async () => {
      scope.parentStreaming = true;
      const jobId = "inject-cap";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-4",
        {
          async: true,
          task: "test",
          notifyOnComplete: "inject",
          triggerTurnOnComplete: true,
        },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);
      await vi.waitFor(() => {
        expect(jobRegistry.get(jobId)?.status).toBe("done");
        expect(api.sendMessage).toHaveBeenCalledOnce();
      });
      expect(api.sendMessage.mock.calls[0][1]).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(api.sendUserMessage).not.toHaveBeenCalled();

      scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      expect(api.sendMessage).toHaveBeenCalledOnce();
    });

    it("allows sequential inject completions without a lifetime cap", async () => {
      const completions = 6;
      for (let i = 0; i < completions; i++) {
        const jobId = `inject-sequential-${i}`;
        const control = createJobControl();
        mockStartSubagentJob.mockImplementationOnce(() =>
          mockJobResult(jobId, control.jobPromise),
        );

        await isolatedToolDef.execute(
          `call-sequential-${i}`,
          { async: true, task: "test", notifyOnComplete: "inject" },
          undefined,
          undefined,
          mockCtx(),
        );

        control.resolve({ ...SUCCESS_RESULT, output: `done ${i}` });

        await vi.waitFor(() => {
          expect(api.sendMessage).toHaveBeenCalledTimes(i + 1);
        });
      }
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    });

    it("degrades in-process overflow to a bounded identity ledger", () => {
      scope.parentStreaming = true;
      const states: any[] = [];
      for (let index = 0; index < 40; index++) {
        const state: any = {
          id: `overflow-${index}`,
          status: "completed",
          liveStatus: {},
          session: { abort: vi.fn() },
          startedAt: 0,
          promise: Promise.resolve(SUCCESS_RESULT),
          notifyOnComplete: "notify",
        };
        states.push(state);
        registerOwnedNotificationJob(state, scope);
        deliverNotification(state, {
          ...SUCCESS_RESULT,
          output: `${index}:${"x".repeat(20_000)}`,
        });
      }

      const queue = scope.pendingInProcessDeliveries;
      expect(queue.length).toBeLessThanOrEqual(MAX_IN_PROCESS_DELIVERY_RECORDS);
      const completionBytes = queue
        .filter((pending) => pending.kind === "completion")
        .reduce(
          (total, pending) =>
            total + Buffer.byteLength(pending.result.output, "utf8") + 512,
          0,
        );
      expect(completionBytes).toBeLessThanOrEqual(
        MAX_IN_PROCESS_DELIVERY_BYTES,
      );
      const overflow = queue.find((pending) => pending.kind === "overflow");
      expect(overflow).toBeDefined();
      if (!overflow || overflow.kind !== "overflow") {
        throw new Error("expected an overflow identity ledger");
      }
      const overflowRows = readFileSync(overflow.overflowPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const identities = [
        ...overflowRows.map((row) => row.deliveryId),
        ...queue
          .filter((pending) => pending.kind === "completion")
          .map((pending) => pending.deliveryId),
      ];
      expect(new Set(identities).size).toBe(40);

      scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      expect(states.every((state) => state.notificationDelivered)).toBe(true);
      expect(queue).toEqual([]);
    });

    it("delivers to the parent while a nested child context is active", async () => {
      const jobId = "nested-context-parent-owner";
      const control = createJobControl();
      const parentSessionManager = {
        getSessionId: () => "parent-session",
        getEntries: () => [],
      };
      const parentSessionStart = api.on.mock.calls.find(
        ([eventName]: any[]) => eventName === "session_start",
      )?.[1];
      parentSessionStart(
        { reason: "new" },
        {
          cwd: "/tmp",
          ui: { notify: api.notify },
          sessionManager: parentSessionManager,
        },
      );
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "nested-context-spawn",
        {
          async: true,
          task: "test",
          notifyOnComplete: "inject",
          triggerTurnOnComplete: true,
        },
        undefined,
        undefined,
        { ...mockCtx(), sessionManager: parentSessionManager },
      );

      const child = setupExtension();
      const childSessionStart = child.api.on.mock.calls.find(
        ([eventName]: any[]) => eventName === "session_start",
      )?.[1];
      childSessionStart(
        { reason: "new" },
        {
          cwd: "/tmp",
          ui: { notify: child.api.notify },
          sessionManager: {
            getSessionId: () => "child-session",
            getEntries: () => [],
          },
        },
      );
      expect(child.scope.pi).toBe(child.api);
      expect(getSessionScopes()).toEqual(
        expect.arrayContaining([scope, child.scope]),
      );

      control.resolve(SUCCESS_RESULT);
      await vi.waitFor(() => {
        expect(jobRegistry.get(jobId)?.status).toBe("done");
      });
      const status = await statusToolDef.execute(
        "nested-context-status",
        { jobId },
        undefined,
        undefined,
        mockCtx(),
      );

      expect(status.details.status).toBe("done");
      expect(api.sendMessage).toHaveBeenCalledOnce();
      expect(sentMessageAt(api, 0)).toMatchObject({
        customType: "subagent-notify",
        details: { jobId },
      });
      expect(sentMessageOptsAt(api, 0)).toMatchObject({
        deliverAs: "followUp",
        triggerTurn: true,
      });
      expect(api.notify).toHaveBeenCalledOnce();
      expect(child.api.sendMessage).not.toHaveBeenCalled();
    });

    it("fails closed when an async spawn owner's generation rolls over", async () => {
      const jobId = "spawn-owner-generation";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );
      await isolatedToolDef.execute(
        "spawn-owner-call",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      scope.generation++;
      control.resolve(SUCCESS_RESULT);
      await vi.waitFor(() => {
        expect(jobRegistry.get(jobId)?.status).toBe("done");
      });
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("drops a queued completion when the same scope rolls generation", () => {
      const state: any = {
        id: "generation-rollover",
        status: "completed",
        liveStatus: {},
        session: { abort: vi.fn() },
        startedAt: 0,
        promise: Promise.resolve(SUCCESS_RESULT),
        notifyOnComplete: "inject",
      };
      registerOwnedNotificationJob(state, scope);
      scope.parentStreaming = true;
      deliverNotification(state, SUCCESS_RESULT);
      expect(scope.pendingInProcessDeliveries).toHaveLength(1);

      scope.generation++;
      scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("does not deliver one scope's completion through a peer Pi", () => {
      const peer = setupExtension();
      const state: any = {
        id: "peer-isolation",
        status: "completed",
        liveStatus: {},
        session: { abort: vi.fn() },
        startedAt: 0,
        promise: Promise.resolve(SUCCESS_RESULT),
        notifyOnComplete: "inject",
      };
      registerOwnedNotificationJob(state, scope);
      scope.parentStreaming = true;
      deliverNotification(state, SUCCESS_RESULT);

      flushInProcessDeliveries(sessionOwner(peer.scope));
      expect(peer.api.sendMessage).not.toHaveBeenCalled();
      expect(peer.scope.pendingInProcessDeliveries).toEqual([]);
      expect(scope.pendingInProcessDeliveries).toHaveLength(1);

      scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      expect(api.sendMessage).toHaveBeenCalledOnce();
      expect(peer.api.sendMessage).not.toHaveBeenCalled();
      expect(scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("fails closed for a tokenless completion when one scope is live", () => {
      const state: any = {
        id: "sole-scope-tokenless-delivery",
        status: "completed",
        liveStatus: {},
        session: { abort: vi.fn() },
        startedAt: 0,
        promise: Promise.resolve(SUCCESS_RESULT),
        notifyOnComplete: "inject",
      };

      deliverNotification(state, SUCCESS_RESULT);

      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("fails closed for a tokenless completion when peer scopes are live", () => {
      const peer = setupExtension();
      const state: any = {
        id: "ambiguous-tokenless-delivery",
        status: "completed",
        liveStatus: {},
        session: { abort: vi.fn() },
        startedAt: 0,
        promise: Promise.resolve(SUCCESS_RESULT),
        notifyOnComplete: "inject",
      };

      deliverNotification(state, SUCCESS_RESULT);

      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(peer.api.sendMessage).not.toHaveBeenCalled();
      expect(scope.pendingInProcessDeliveries).toEqual([]);
      expect(peer.scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("does not merge overflow ledgers across scope generations", () => {
      scope.parentStreaming = true;
      for (let index = 0; index < 40; index++) {
        if (index === 20) scope.generation++;
        const state: any = {
          id: `generation-overflow-${index}`,
          status: "completed",
          liveStatus: {},
          session: { abort: vi.fn() },
          startedAt: 0,
          promise: Promise.resolve(SUCCESS_RESULT),
          notifyOnComplete: "notify",
        };
        registerOwnedNotificationJob(state, scope);
        deliverNotification(state, {
          ...SUCCESS_RESULT,
          output: `${index}:${"x".repeat(20_000)}`,
        });
      }
      const queue = scope.pendingInProcessDeliveries;
      const overflows = queue.filter((pending) => pending.kind === "overflow");
      expect(overflows).toHaveLength(2);
      for (const overflow of overflows) {
        const rows = readFileSync(overflow.overflowPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const generations = rows.map((row) =>
          Number(row.jobId.split("-").pop()) < 20 ? 0 : 1,
        );
        expect(new Set(generations)).toHaveLength(1);
        rmSync(overflow.overflowPath, { force: true });
      }
      scope.parentStreaming = false;
      queue.length = 0;
    });

    it("keeps each peer scope's overflow queue bounded and isolated", () => {
      const peer = setupExtension();
      scope.parentStreaming = true;
      peer.scope.parentStreaming = true;
      for (const [label, ownerScope] of [
        ["first", scope],
        ["peer", peer.scope],
      ] as const) {
        for (let index = 0; index < 40; index++) {
          const state: any = {
            id: `${label}-owner-overflow-${index}`,
            status: "completed",
            liveStatus: {},
            session: { abort: vi.fn() },
            startedAt: 0,
            promise: Promise.resolve(SUCCESS_RESULT),
            notifyOnComplete: "notify",
          };
          registerOwnedNotificationJob(state, ownerScope);
          deliverNotification(state, {
            ...SUCCESS_RESULT,
            output: `${index}:${"x".repeat(20_000)}`,
          });
        }
      }

      for (const ownerScope of [scope, peer.scope]) {
        const queue = ownerScope.pendingInProcessDeliveries;
        expect(queue.length).toBeLessThanOrEqual(
          MAX_IN_PROCESS_DELIVERY_RECORDS,
        );
        expect(queue.some((pending) => pending.kind === "overflow")).toBe(true);
        expect(
          queue.every(
            (pending) =>
              pending.ownerSessionScopeId === ownerScope.id &&
              pending.ownerSessionScopeGeneration === ownerScope.generation,
          ),
        ).toBe(true);
      }

      scope.parentStreaming = false;
      peer.scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      flushInProcessDeliveries(sessionOwner(peer.scope));
      expect(scope.pendingInProcessDeliveries).toEqual([]);
      expect(peer.scope.pendingInProcessDeliveries).toEqual([]);
    });

    it("keeps collapsed inject and trigger semantics in one overflow envelope", () => {
      scope.parentStreaming = true;
      for (let index = 0; index < 40; index++) {
        const state: any = {
          id: `semantic-overflow-${index}`,
          status: "completed",
          liveStatus: {},
          session: { abort: vi.fn() },
          startedAt: 0,
          promise: Promise.resolve(SUCCESS_RESULT),
          notifyOnComplete: index === 0 ? "inject" : "notify",
          triggerTurnOnComplete: index === 1,
        };
        registerOwnedNotificationJob(state, scope);
        deliverNotification(state, {
          ...SUCCESS_RESULT,
          output: `${index}:${"x".repeat(20_000)}`,
        });
      }

      const queue = scope.pendingInProcessDeliveries;
      const overflow = queue.find((pending) => pending.kind === "overflow");
      expect(overflow).toMatchObject({
        mode: "inject",
        triggerTurn: true,
      });
      if (!overflow || overflow.kind !== "overflow") {
        throw new Error("expected an overflow identity ledger");
      }
      const rows = readFileSync(overflow.overflowPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows[0]).toMatchObject({
        mode: "inject",
        triggerTurn: false,
        status: "done",
      });
      expect(rows[1]).toMatchObject({
        mode: "notify",
        triggerTurn: true,
        status: "done",
      });

      scope.parentStreaming = false;
      flushInProcessDeliveries(sessionOwner(scope));
      expect(api.sendMessage).toHaveBeenCalledOnce();
      expect(sentMessageAt(api, 0).content).toContain(overflow.overflowPath);
      expect(sentMessageAt(api, 0).details.mode).toBe("inject");
      expect(sentMessageOptsAt(api, 0)).toMatchObject({ triggerTurn: true });
    });

    it("uses fallback text when output is empty in inject mode", async () => {
      const jobId = "inject-empty";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-5",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(EMPTY_OUTPUT_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      expect(sentMessageAt(api, 0).content).toContain(
        "(sub-agent produced no output)",
      );
    });
  });

  describe("async status", () => {
    it("shows the resolved async job model instead of the parent model", async () => {
      const jobId = "status-override-model";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise, "override/provider-model"),
      );

      await isolatedToolDef.execute(
        "call-status-model",
        { async: true, task: "test", model: "override/provider-model" },
        undefined,
        undefined,
        mockCtx(),
      );

      const result = await statusToolDef.execute(
        "call-get-status",
        { jobId },
        undefined,
        undefined,
        mockCtx(),
      );

      expect((result.details as Record<string, unknown>).model).toBe(
        "override/provider-model",
      );

      control.resolve(SUCCESS_RESULT);
    });
  });

  // ── Suppression gates ─────────────────────────────────────────────
  describe("suppression gates", () => {
    it("does NOT deliver notification when job is cancelled before completion", async () => {
      const jobId = "cancel-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-6",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Mark the job as cancelled BEFORE resolving the promise.
      // The .then() handler checks jobState.status === "cancelled" and returns early.
      const jobState = jobRegistry.get(jobId)!;
      expect(jobState).toBeDefined();
      jobState.status = "cancelled";

      // Resolve — the check at the top of the success handler should bail out
      control.resolve(SUCCESS_RESULT);

      // Let microtasks settle, then assert nothing was sent
      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.sendUserMessage).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });

    it("keeps the UI notification when a retrieved result suppresses parent delivery", async () => {
      const jobId = "retrieve-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-7",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Simulate get_subagent_result having been called: set resultRetrieved
      const jobState = jobRegistry.get(jobId)!;
      expect(jobState).toBeDefined();
      jobState.resultRetrieved = true;

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(jobState.status).toBe("done");
        expect(api.notify).toHaveBeenCalledWith(
          expect.stringContaining(`Job ${jobId}`),
          "info",
        );
      });
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    });

    it("keeps the inject UI notification when result delivery is suppressed", async () => {
      const jobId = "retrieve-inject-suppress";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-8",
        { async: true, task: "test", notifyOnComplete: "inject" },
        undefined,
        undefined,
        mockCtx(),
      );

      const jobState = jobRegistry.get(jobId)!;
      jobState.resultRetrieved = true;

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(jobState.status).toBe("done");
        expect(api.notify).toHaveBeenCalledWith(
          expect.stringContaining(`Job ${jobId}`),
          "info",
        );
      });
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(api.sendUserMessage).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ────────────────────────────────────────────────
  describe("error handling", () => {
    it("includes error message in notification when sub-agent returns isError", async () => {
      const jobId = "error-result";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-9",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      expect(content).toContain("❌");
      expect(content).toContain(ERROR_RESULT.errorMessage);
    });

    it("delivers notification via promise rejection handler when the job promise rejects", async () => {
      const jobId = "promise-reject";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-10",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Reject the promise instead of resolving
      control.reject(new Error("Connection timeout"));

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      expect(content).toContain("❌");
      expect(content).toContain("Connection timeout");
    });

    it("does NOT deliver via rejection handler if notification already delivered", async () => {
      const jobId = "double-deliver-guard";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-11",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Set notificationDelivered BEFORE settling
      const jobState = jobRegistry.get(jobId)!;
      jobState.notificationDelivered = true;

      control.reject(new Error("Timeout"));

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.notify).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });
  });

  // ── Default delivery ──────────────────────────────────────────────
  describe("default delivery", () => {
    it("injects and triggers when notifyOnComplete is omitted", async () => {
      const jobId = "no-notify";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-12",
        { async: true, task: "test" },
        undefined,
        undefined,
        mockCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });
      expect(sentMessageAt(api, 0).content).toContain(SUCCESS_RESULT.output);
      expect(sentMessageOptsAt(api, 0).triggerTurn).toBe(true);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("fires notification with fallback message when output is empty in notify mode", async () => {
      const jobId = "empty-output-notify";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-13",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Empty output — NOT ZERO_USAGE_RESULT which has output "Done"
      control.resolve(EMPTY_OUTPUT_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      expect(content).toContain("✅");
      expect(content).toContain(jobId);
      expect(content).toContain("done");
    });

    it("sanitizes sensitive tokens in notification content via errorMessage", async () => {
      const jobId = "sanitize";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-14",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Use isError: true result where errorMessage contains an API key
      // This ensures sanitizeOutput actually runs (it runs on errorMessage for isError results)
      control.resolve(SECRET_ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      // The raw secret must NOT appear in the output
      expect(content).not.toContain(
        "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
      );
      // sanitizeOutput replaces it with [REDACTED]
      expect(content).toContain("[REDACTED]");
      expect(content).toContain(jobId);
    });

    it("handles multiple concurrent async subagents with independent notifications", async () => {
      const jobId1 = "multi-1";
      const jobId2 = "multi-2";
      const control1 = createJobControl();
      const control2 = createJobControl();

      // Use single mockImplementation with counter instead of mockImplementationOnce
      // to avoid fallback to real implementation if a third call were made
      const callResults = [
        () => mockJobResult(jobId1, control1.jobPromise),
        () => mockJobResult(jobId2, control2.jobPromise),
      ];
      mockStartSubagentJob.mockImplementation(() => callResults.shift()!());

      // Spawn two concurrent subagents
      await Promise.all([
        isolatedToolDef.execute(
          "call-15",
          { async: true, task: "test-1", notifyOnComplete: "notify" },
          undefined,
          undefined,
          mockCtx(),
        ),
        isolatedToolDef.execute(
          "call-16",
          { async: true, task: "test-2", notifyOnComplete: "notify" },
          undefined,
          undefined,
          mockCtx(),
        ),
      ]);

      // Resolve both
      control1.resolve(SUCCESS_RESULT);
      control2.resolve(ERROR_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(2);
      });

      expect(sentMessageAt(api, 0).content).toContain(jobId1);
      expect(sentMessageAt(api, 0).content).toContain("✅");
      expect(sentMessageAt(api, 1).content).toContain(jobId2);
      expect(sentMessageAt(api, 1).content).toContain("❌");
    });

    it("does not deliver after the owning scope shuts down", async () => {
      const jobId = "stale-pi-ref";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-stale-pi",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      scope.lifecycle = "shutdown";

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(
        () => {
          expect(api.sendMessage).toHaveBeenCalledTimes(0);
          expect(api.notify).toHaveBeenCalledTimes(0);
        },
        { timeout: 50 },
      );
    });

    it("delivers notification even when ctx is stale (ui.setStatus throws)", async () => {
      const jobId = "stale-ctx";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      // Use a ctx where ui.setStatus throws synchronously
      // The .then() handler wraps ctx.ui.setStatus in try/catch, so the
      // execution continues and deliverNotification (which uses pi, not ctx) still fires.
      await isolatedToolDef.execute(
        "call-stale-ctx",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockStaleCtx(),
      );

      control.resolve(SUCCESS_RESULT);

      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      const content = sentMessageAt(api, 0).content;
      expect(content).toContain("✅");
      expect(content).toContain(jobId);
    });

    it("delivers notification before resultRetrieved can suppress it when get_subagent_result is called after settlement", async () => {
      const jobId = "race-delivers";
      const control = createJobControl();
      mockStartSubagentJob.mockImplementationOnce(() =>
        mockJobResult(jobId, control.jobPromise),
      );

      await isolatedToolDef.execute(
        "call-race",
        { async: true, task: "test", notifyOnComplete: "notify" },
        undefined,
        undefined,
        mockCtx(),
      );

      // Resolve the promise — .then() callback is queued as a microtask
      control.resolve(SUCCESS_RESULT);

      // Wait for the .then() microtask to fire and deliver the notification
      await vi.waitFor(() => {
        expect(api.sendMessage).toHaveBeenCalledTimes(1);
      });

      // By now, the notification was already delivered because .then()
      // fires before get_subagent_result can set resultRetrieved.
      // Simulate get_subagent_result being called now (after settlement).
      const jobState = jobRegistry.get(jobId)!;
      jobState.resultRetrieved = true;

      // No double delivery — notificationDelivered guard prevents it
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    });
  });
});

describe("read_subagent_artifact (invalid id)", () => {
  /** Build the minimal ExtensionAPI mock and capture the tool def. */
  function setupReadArtifactTool() {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    registerExtension(_api as any);
    return _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "read_subagent_artifact",
    )?.[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanGlobals();
  });

  afterEach(() => {
    cleanGlobals();
  });

  it.each([
    "not-a-hex-id",
    "deadbeefcafebabe\n",
    "deadbeefcafebabe\r\n",
    "deadbeefcafebabe\u2028",
    "deadbeefcafebabe\u2029",
  ])("returns invalid_id with a precise message for %j", async (id) => {
    const toolDef = setupReadArtifactTool();
    expect(toolDef).toBeDefined();

    const result = await toolDef.execute(
      "call-malformed",
      { id },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ id, status: "invalid_id" });
    const text = result.content[0].text;
    expect(text).toContain("Invalid sub-agent id");
    expect(text).toContain(JSON.stringify(id).slice(1, -1));
  });
});

describe("read_subagent_artifact (output reporting)", () => {
  function tmp() {
    return mkdtempSync(join(tmpdir(), "pi-subagentura-read-out-"));
  }

  function makeArtifactWithDone(
    id: string,
    parentDir: string,
    appendLegacyDone = true,
  ) {
    const dir = join(parentDir, id);
    const state: import("../src/interactive-tmux").InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: "/tmp/sess.jsonl",
      cwd: "/tmp",
      startedAt: 1,
      status: "exited",
      mux: "tmux",
      attachCommand: "tmux attach",
      selectPaneCommand: "tmux select-pane",
      launchScriptFile: "/tmp/launch.sh",
      artifactDir: dir,
    };
    const art = artifactPath(parentDir, id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    if (appendLegacyDone) {
      appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
    }
    return { state, art, dir };
  }

  function makeReadTool(
    mod: any,
    state?: import("../src/interactive-tmux").InteractiveSubagentState,
  ) {
    const _api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    (mod as any).default(_api as any);
    const ownerScope = getSessionScopes().at(-1);
    if (!ownerScope) throw new Error("Expected artifact tool session scope");
    ownerScope.lifecycle = "started";
    if (state) ownerScope.interactiveStates.set(state.id, state);
    return _api.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "read_subagent_artifact",
    )?.[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanGlobals();
  });

  afterEach(() => {
    cleanGlobals();
  });

  it("reports '(sub-agent exited without writing output.md — last event: done @ <ts>)' when output.md is missing and the agent finished", async () => {
    const id = "ab12cd3400000001";
    const parent = tmp();
    try {
      const { state } = makeArtifactWithDone(id, parent);
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);
      expect(readTool).toBeDefined();

      const result = await readTool.execute(
        "call-1",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;
      expect(text).toContain(
        "Output: (sub-agent exited without writing output.md",
      );
      expect(text).toContain("last event: done @ 2");
      expect(text).not.toContain("not written yet");
      expect(result.details.output).toBeNull();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports a protocol-v2 completion as exited when output.md is missing", async () => {
    const id = "ab12cd3800000002";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent, false);
      appendCompletionEvent(art, {
        turnId: "turn-without-output",
        eventId: "completion-without-output",
        outcome: "done",
        source: "agent_settled",
        ts: 2,
      });
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);

      const result = await readTool.execute(
        "call-v2-no-output",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;

      expect(text).toContain(
        "Output: (sub-agent exited without writing output.md",
      );
      expect(text).toContain("last event: completion @ 2");
      expect(text).not.toContain("not written yet");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports a protocol-v2 process exit as exited when output.md is missing", async () => {
    const id = "ab12cd3900000003";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent, false);
      appendEvent(art, {
        version: 2,
        eventId: "process-exit-without-output",
        turnId: "turn-process-exit",
        ts: 2,
        type: "process_exited",
        status: "done",
        exitCode: 0,
      });
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);

      const result = await readTool.execute(
        "call-v2-process-exit-no-output",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;

      expect(text).toContain(
        "Output: (sub-agent exited without writing output.md",
      );
      expect(text).toContain("last event: process_exited @ 2");
      expect(text).not.toContain("not written yet");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '(<N> events, last: <type> @ <ts> — output.md not written yet)' when output.md is missing and the agent is still running", async () => {
    const id = "ab12cd3500000004";
    const parent = tmp();
    try {
      const dir = join(parent, id);
      const state: import("../src/interactive-tmux").InteractiveSubagentState =
        {
          id,
          name: "Test",
          task: "t",
          paneId: "%99",
          sessionFile: "/tmp/sess.jsonl",
          cwd: "/tmp",
          startedAt: 1,
          status: "running",
          mux: "tmux",
          attachCommand: "tmux attach",
          selectPaneCommand: "tmux select-pane",
          launchScriptFile: "/tmp/launch.sh",
          artifactDir: dir,
        };
      const art = artifactPath(parent, id);
      appendEvent(art, { ts: 1, type: "started", status: "running" });
      appendEvent(art, {
        ts: 2,
        type: "tool_activity",
        status: "running",
        tool: "bash",
        summary: "ls",
      });

      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);
      const result = await readTool.execute(
        "call-2",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;
      expect(text).toContain("Output: (2 events");
      expect(text).toContain("last: tool_activity @ 2");
      expect(text).toContain("output.md not written yet");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '(empty — 0 chars)' when output.md exists but is empty", async () => {
    const id = "ab12cd3600000005";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      writeOutput(art, "");

      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);
      const result = await readTool.execute(
        "call-3",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;
      expect(text).toContain("Output: (empty — 0 chars)");
      expect(result.details.output).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports '<N> chars' when output.md has content", async () => {
    const id = "ab12cd3700000006";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      writeOutput(art, "Hello, world!");

      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);
      const result = await readTool.execute(
        "call-4",
        { id },
        undefined,
        undefined,
        {} as any,
      );
      const text = result.content[0].text;
      expect(text).toContain("Output: 13 chars");
      expect(text).toContain(
        "<untrusted-subagent-output>\nHello, world!\n</untrusted-subagent-output>",
      );
      expect(result.details.output).toBe("Hello, world!");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("bounds artifact output included in provider-facing content", async () => {
    const id = "ab12cd3700000007";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      const oversized = "x".repeat(80 * 1024);
      writeOutput(art, oversized);
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);

      const result = await readTool.execute(
        "call-bounded-output",
        { id },
        undefined,
        undefined,
        {} as any,
      );

      expect(result.content[0].text).toContain(
        "[Output truncated from 81920 bytes.]",
      );
      expect(Buffer.byteLength(result.content[0].text, "utf8")).toBeLessThan(
        66 * 1024,
      );
      expect(result.details.output).toBe(oversized);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reads protocol-v2 history by Pi turnId and lists the turn mapping", async () => {
    const id = "ab12cd3800000007";
    const parent = tmp();
    try {
      const { state, art } = makeArtifactWithDone(id, parent);
      writeOutput(art, "first immutable output");
      appendCompletionEvent(art, {
        turnId: "pi-user-entry-first",
        eventId: "completion-first",
        outcome: "done",
        source: "agent_settled",
      });
      writeOutput(art, "second immutable output");
      appendCompletionEvent(art, {
        turnId: "pi-user-entry-second",
        eventId: "completion-second",
        outcome: "done",
        source: "agent_settled",
      });

      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);
      const result = await readTool.execute(
        "call-v2-history",
        { id, turnId: "pi-user-entry-first" },
        undefined,
        undefined,
        {} as any,
      );

      expect(result.details.output).toBe("first immutable output");
      expect(result.details.outputHistory).toEqual([
        expect.objectContaining({
          turnId: "pi-user-entry-first",
          eventId: "completion-first",
        }),
        expect.objectContaining({
          turnId: "pi-user-entry-second",
          eventId: "completion-second",
        }),
      ]);
      expect(result.content[0].text).toContain(
        "Reading turnId: pi-user-entry-first",
      );
      expect(result.content[0].text).toContain(
        "<untrusted-subagent-output>\nfirst immutable output\n</untrusted-subagent-output>",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous legacy turn and protocol-v2 turnId selectors", async () => {
    const id = "ab12cd3900000008";
    const parent = tmp();
    try {
      const { state } = makeArtifactWithDone(id, parent);
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const readTool = makeReadTool(mod, state);

      const result = await readTool.execute(
        "call-ambiguous-history",
        { id, turn: 1, turnId: "pi-user-entry-first" },
        undefined,
        undefined,
        {} as any,
      );

      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        id,
        status: "invalid_selector",
      });
      expect(result.content[0].text).toContain(
        "Pass either turn or turnId, not both",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
