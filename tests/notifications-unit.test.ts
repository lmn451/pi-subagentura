import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  jobRegistry,
  type JobState,
  type SubagentResult,
} from "../src/helpers";
import {
  deliverArtifactNotification,
  deliverNotification,
  flushInProcessDeliveries,
  getInjectCount,
  sanitizeOutput,
  shouldNotify,
} from "../src/notifications";
import {
  clearSessionScopes,
  registerSessionScope,
  removeSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

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

function makeJobState(overrides?: Partial<JobState>): JobState {
  return {
    id: "test-job-1",
    status: "done",
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
    session: { abort: vi.fn() } as any,
    promise: Promise.resolve(SUCCESS_RESULT),
    startedAt: Date.now(),
    notifyOnComplete: "notify",
    ...overrides,
  };
}

function cleanGlobals() {
  clearSessionScopes();
  const globalState = globalThis as any;
  globalState.__piSubagenturaPiRef = undefined;
  globalState.__piSubagenturaUi = undefined;
  globalState.__piSubagenturaSessionManager = undefined;
  globalState.__piSubagenturaParentStreaming = false;
  globalState.__piSubagenturaPendingJobDeliveries = [];
  jobRegistry.clear();
}

describe("in-process completion delivery queue", () => {
  beforeEach(cleanGlobals);
  afterEach(cleanGlobals);

  it("does nothing when the extension context is unavailable", () => {
    const job = makeJobState();

    expect(deliverNotification(job, SUCCESS_RESULT)).toBeUndefined();
    expect(job.notificationDelivered).toBeFalsy();
  });

  it("delivers notify mode as a pointer-only custom message", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toMatch(
      /^from: Job test-job-1, /,
    );
    expect(sendMessage.mock.calls[0][0].content).not.toContain(
      SUCCESS_RESULT.output,
    );
    expect(sendMessage.mock.calls[0][0].details.mode).toBe("notify");
    expect(job.notificationDelivered).toBe(true);
  });

  it("keeps job IDs in distinct in-process completion labels", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    const first = makeJobState({ id: "job-a" });
    const second = makeJobState({ id: "job-b" });

    deliverNotification(first, SUCCESS_RESULT);
    deliverNotification(second, SUCCESS_RESULT);

    expect(sendMessage.mock.calls.map(([message]) => message.content)).toEqual([
      expect.stringMatching(/^from: Job job-a, /),
      expect.stringMatching(/^from: Job job-b, /),
    ]);
  });

  it("reports other running in-process jobs in completion messages", () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    jobRegistry.set(
      "still-running",
      makeJobState({ id: "still-running", status: "running" }),
    );

    deliverNotification(makeJobState(), SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "1 in-process sub-agent job is still running",
    );
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "Do not claim all review work is complete yet",
    );
    expect(sendMessage.mock.calls[0][0].details.remainingRunningJobs).toBe(1);
  });

  it("retains a failed dispatch and retries it with a fresh context", () => {
    const staleSend = vi.fn(() => {
      throw new Error("stale context");
    });
    const pi: { sendMessage: (...args: any[]) => any } = {
      sendMessage: staleSend,
    };
    (globalThis as any).__piSubagenturaPiRef = pi;
    const job = makeJobState();

    deliverNotification(job, SUCCESS_RESULT);
    expect(staleSend).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBeFalsy();

    const freshSend = vi.fn();
    pi.sendMessage = freshSend;
    (globalThis as any).__piSubagenturaPiRef = pi;
    flushInProcessDeliveries();

    expect(freshSend).toHaveBeenCalledOnce();
    expect(job.notificationDelivered).toBe(true);
  });

  it("delivers inject mode in one attributed custom message", () => {
    const sendMessage = vi.fn();
    const sendUserMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage,
      sendUserMessage,
    };
    const job = makeJobState({
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
    });

    deliverNotification(job, SUCCESS_RESULT);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain(
      SUCCESS_RESULT.output,
    );
    expect(sendMessage.mock.calls[0][0].details.mode).toBe("inject");
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBe(true);
  });

  it("dispatches triggering completion through native followUp while streaming", async () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "inject" });

    deliverNotification(job, SUCCESS_RESULT);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(job.notificationDelivered).toBe(true);
  });

  it("waits for idle when completion must not trigger a turn", async () => {
    const sendMessage = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = { sendMessage };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();

    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: false,
    });
    expect(job.notificationDelivered).toBe(true);
  });

  it("does not deliver a queued completion into a replacement parent session", async () => {
    const firstSessionSend = vi.fn();
    const secondSessionSend = vi.fn();
    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage: firstSessionSend,
    };
    (globalThis as any).__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-a",
    };
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const job = makeJobState({ notifyOnComplete: "notify" });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(firstSessionSend).not.toHaveBeenCalled();

    (globalThis as any).__piSubagenturaPiRef = {
      sendMessage: secondSessionSend,
    };
    (globalThis as any).__piSubagenturaSessionManager = {
      getSessionId: () => "parent-session-b",
    };
    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushInProcessDeliveries();

    expect(secondSessionSend).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();
  });

  it("does not deliver a queued completion into a replacement session scope", async () => {
    const firstSessionSend = vi.fn();
    const secondSessionSend = vi.fn();
    const firstPi = {
      sendMessage: firstSessionSend,
    } as unknown as ExtensionAPI;
    const firstScope = registerSessionScope({
      id: 1,
      generation: 1,
      lifecycle: "started",
      pi: firstPi,
      parentStreaming: true,
      sessionManager: { getSessionId: () => "parent-session-a" },
    });
    const firstOwner = sessionOwner(firstScope);
    const job = makeJobState({
      notifyOnComplete: "notify",
      deliveryOwner: {
        pi: firstPi,
        sessionId: "parent-session-a",
        sessionScopeId: firstOwner.id,
        sessionScopeGeneration: firstOwner.generation,
      },
    });

    deliverNotification(job, SUCCESS_RESULT);
    await Promise.resolve();
    expect(firstSessionSend).not.toHaveBeenCalled();

    removeSessionScope(firstScope.id);
    const secondScope = registerSessionScope({
      id: 2,
      generation: 1,
      lifecycle: "started",
      pi: { sendMessage: secondSessionSend } as unknown as ExtensionAPI,
      sessionManager: { getSessionId: () => "parent-session-a" },
    });
    flushInProcessDeliveries(sessionOwner(secondScope));

    expect(secondSessionSend).not.toHaveBeenCalled();
    expect(job.notificationDelivered).toBeFalsy();
  });
});
describe("peer in-process delivery isolation", () => {
  beforeEach(cleanGlobals);
  afterEach(cleanGlobals);

  function peerScope(id: number, parentStreaming: boolean, sendMessage: Mock) {
    return registerSessionScope({
      id,
      generation: 1,
      lifecycle: "started",
      pi: { sendMessage } as unknown as ExtensionAPI,
      parentStreaming,
      sessionManager: { getSessionId: () => `session-${id}` },
    });
  }

  function ownedJob(id: string, scope: SessionScope): JobState {
    const owner = sessionOwner(scope);
    return makeJobState({
      id,
      deliveryOwner: {
        pi: scope.pi,
        sessionId: `session-${scope.id}`,
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    });
  }

  it("does not let B streaming suppress A completion delivery", async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const scopeA = peerScope(101, false, sendA);
    const scopeB = peerScope(102, true, sendB);
    const jobA = ownedJob("job-a", scopeA);
    const jobB = ownedJob("job-b", scopeB);

    deliverNotification(jobB, SUCCESS_RESULT);
    deliverNotification(jobA, SUCCESS_RESULT);
    await Promise.resolve();

    expect(sendA).toHaveBeenCalledOnce();
    expect(sendB).not.toHaveBeenCalled();
    expect(jobA.notificationDelivered).toBe(true);
    expect(jobB.notificationDelivered).toBeFalsy();
    expect(scopeA.pendingInProcessDeliveries).toHaveLength(0);
    expect(scopeB.pendingInProcessDeliveries).toHaveLength(1);
  });

  it("flushes only A's queue and leaves B's queue intact", async () => {
    const sendA = vi.fn();
    const sendB = vi.fn();
    const scopeA = peerScope(111, true, sendA);
    const scopeB = peerScope(112, true, sendB);
    const ownerA = sessionOwner(scopeA);
    const jobA = ownedJob("queued-a", scopeA);
    const jobB = ownedJob("queued-b", scopeB);

    deliverNotification(jobA, SUCCESS_RESULT);
    deliverNotification(jobB, SUCCESS_RESULT);
    await Promise.resolve();
    expect(sendA).not.toHaveBeenCalled();
    expect(sendB).not.toHaveBeenCalled();

    scopeA.parentStreaming = false;
    flushInProcessDeliveries(ownerA);

    expect(sendA).toHaveBeenCalledOnce();
    expect(sendB).not.toHaveBeenCalled();
    expect(jobA.notificationDelivered).toBe(true);
    expect(jobB.notificationDelivered).toBeFalsy();
    expect(scopeA.pendingInProcessDeliveries).toHaveLength(0);
    expect(scopeB.pendingInProcessDeliveries).toHaveLength(1);
  });
});

describe("artifact notification compatibility", () => {
  const state = {
    id: "child-1",
    name: "Reviewer",
    artifactDir: "/tmp/artifacts/child-1",
    notifyOnComplete: "notify",
    triggerTurnOnComplete: true,
  } as any;

  it("retains the deprecated zero inject-count API", () => {
    expect(getInjectCount()).toBe(0);
  });

  it("sanitizes secrets and identifies terminal notification events", () => {
    expect(sanitizeOutput(`token sk-${"a".repeat(24)}`)).toBe(
      "token [REDACTED]",
    );
    expect(shouldNotify({ type: "started", ts: 1, status: "running" })).toBe(
      false,
    );
    expect(
      shouldNotify({
        version: 2,
        eventId: "event-1",
        turnId: "turn-1",
        ts: 2,
        type: "completion",
        status: "done",
        outcome: "done",
        source: "agent_settled",
      }),
    ).toBe(true);
  });

  it("quietens only aborted child settlement errors", () => {
    const base = {
      version: 2 as const,
      eventId: "event-aborted",
      turnId: "turn-aborted",
      ts: 2,
      type: "completion" as const,
      status: "error" as const,
      outcome: "error" as const,
      source: "agent_settled" as const,
    };

    expect(shouldNotify({ ...base, agentStopReason: "aborted" })).toBe(false);
    expect(shouldNotify({ ...base, agentStopReason: "error" })).toBe(true);
    expect(shouldNotify(base)).toBe(true);
    expect(
      shouldNotify({
        ...base,
        source: "parent",
        agentStopReason: "aborted",
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        ...base,
        source: "explicit",
        agentStopReason: "aborted",
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        ...base,
        type: "completion",
        source: "process_exit",
        agentStopReason: "aborted",
      }),
    ).toBe(true);
  });

  it("builds and sends pointer notifications for legacy terminal events", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage };

    expect(
      deliverArtifactNotification(pi as any, state, {
        type: "done",
        ts: 2,
        status: "done",
        exitCode: 0,
      }),
    ).toBe(true);
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "from: Reviewer, ✅ done (exit 0)",
    );
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });

    expect(
      deliverArtifactNotification(pi as any, state, {
        type: "error",
        ts: 3,
        status: "error",
        message: `failed with sk-${"b".repeat(24)}`,
      }),
    ).toBe(true);
    expect(sendMessage.mock.calls[1][0].content).toContain("[REDACTED]");
  });

  it("formats protocol-v2 and process lifecycle pointers", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage };
    const events = [
      {
        version: 2,
        eventId: "turn-started",
        turnId: "turn-1",
        ts: 4,
        type: "turn_started",
        status: "running",
      },
      {
        version: 2,
        eventId: "completion",
        turnId: "turn-1",
        ts: 5,
        type: "completion",
        status: "cancelled",
        outcome: "cancelled",
        source: "parent",
      },
      {
        version: 2,
        eventId: "process-exit",
        ts: 6,
        type: "process_exited",
        status: "error",
        exitCode: 1,
      },
      { type: "started", ts: 7, status: "running" },
      {
        type: "tool_activity",
        ts: 8,
        status: "running",
        tool: "read",
      },
      { type: "done", ts: 9, status: "done", exitCode: 1 },
      {
        version: 2,
        eventId: "completion-error",
        turnId: "turn-2",
        ts: 10,
        type: "completion",
        status: "error",
        outcome: "error",
        source: "agent_settled",
      },
      {
        version: 2,
        eventId: "process-success",
        ts: 11,
        type: "process_exited",
        status: "done",
        exitCode: 0,
      },
      { type: "error", ts: 12, status: "error" },
    ];

    for (const event of events) {
      expect(deliverArtifactNotification(pi as any, state, event as any)).toBe(
        true,
      );
    }

    expect(sendMessage.mock.calls.map((call) => call[0].content)).toEqual([
      "from: Reviewer, ▶ started\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, 🚫 cancelled\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ❌ process exited (1)\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ▶ started\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ▶ activity\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ❌ done (exit 1)\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ❌ error\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ✅ process exited (0)\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
      "from: Reviewer, ❌ error\n" +
        "unknown error\n" +
        "Output: /tmp/artifacts/child-1/output.md\n" +
        "Activity log: /tmp/artifacts/child-1/events.ndjson",
    ]);
  });

  it("returns false for stale contexts and unsupported events", () => {
    expect(
      deliverArtifactNotification(
        {
          sendMessage: () => {
            throw new Error("stale context");
          },
        } as any,
        state,
        { type: "cancelled", ts: 4, status: "cancelled" },
      ),
    ).toBe(false);
    expect(
      deliverArtifactNotification({ sendMessage: vi.fn() } as any, state, {
        type: "unsupported",
      } as any),
    ).toBe(false);
  });
});
