import { afterEach, describe, expect, it, vi } from "vitest";

const { mockDebugLog } = vi.hoisted(() => ({ mockDebugLog: vi.fn() }));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, debugLog: mockDebugLog };
});
import {
  acknowledgeCompletionTurnWake,
  clearCompletionTurnWake,
  markCompletionTurnWakeStarted,
  ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS,
  ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS,
  ORCHESTRATOR_V2_WAKE_DETAIL_KEY,
  ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
  ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS,
  ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS,
  recoverCompletionTurnWakes,
  sendCompletionTurn,
  settleCompletionTurnWake,
} from "../src/completion-turn";

function mockPi() {
  return {
    appendEntry: vi.fn(),
    getFlag: vi.fn((name: string) => name === "orchestratorv2"),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
}

function completion(content: string) {
  return {
    customType: "subagent-notify",
    content,
    display: true,
    details: { deliveryIds: [`delivery-${content}`] },
  };
}

function wakeMessages(pi: ReturnType<typeof mockPi>) {
  return pi.sendMessage.mock.calls
    .filter(([, options]) => options?.triggerTurn === true)
    .map(([message]) => message);
}

function findWakeMessage(pi: ReturnType<typeof mockPi>) {
  const message = wakeMessages(pi)[0];
  if (!message) throw new Error("native custom wake not sent");
  return message;
}

describe("Orchestratorv2 completion turns", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockDebugLog.mockClear();
  });

  it("coalesces concurrent completions and bounds a missing wake start", () => {
    vi.useFakeTimers();
    const pi = mockPi();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(pi.appendEntry).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "requested" }),
    );
    const firstWakeId =
      findWakeMessage(pi).details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
    expect(pi.sendMessage).toHaveBeenCalledTimes(3);
    expect(pi.sendMessage.mock.calls[0][1]).toEqual({
      deliverAs: "followUp",
      triggerTurn: false,
    });
    expect(pi.sendMessage.mock.calls[1][1]).toEqual({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(pi.sendMessage.mock.calls[2][1]).toEqual({
      deliverAs: "followUp",
      triggerTurn: false,
    });
    expect(findWakeMessage(pi).details).toMatchObject({
      [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: firstWakeId,
    });
    expect(pi.sendUserMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS - 1);
    expect(wakeMessages(pi)).toHaveLength(1);
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS);
    expect(wakeMessages(pi)).toHaveLength(2);
    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS *
        (ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS - 1),
    );
    expect(wakeMessages(pi)).toHaveLength(ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS);

    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({
        state: "acknowledged",
        wakeIds: [firstWakeId],
      }),
    );
  });

  it("retains the wake until its durable acknowledgement succeeds", () => {
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });

    acknowledgeCompletionTurnWake(pi as never);
    acknowledgeCompletionTurnWake(pi as never);

    expect(mockDebugLog).toHaveBeenCalledOnce();
    expect(mockDebugLog).toHaveBeenCalledWith(
      "error",
      "orchestratorv2_wake_ack_failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
    expect(pi.appendEntry).toHaveBeenCalledTimes(3);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenCalledTimes(3);
  });

  it("allows a later completion to re-wake after repeated acknowledgement failures", () => {
    const pi = mockPi();
    mockDebugLog.mockClear();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeId = findWakeMessage(pi).details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
    for (let attempt = 0; attempt < 2; attempt++) {
      pi.appendEntry.mockImplementationOnce(() => {
        throw new Error("transient append failure");
      });
      acknowledgeCompletionTurnWake(pi as never);
    }

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(wakeMessages(pi)).toHaveLength(2);
    expect(wakeMessages(pi)[1].details).toMatchObject({
      [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: wakeId,
    });
    expect(
      pi.appendEntry.mock.calls.filter(
        ([customType, entry]) =>
          customType === ORCHESTRATOR_V2_WAKE_ENTRY_TYPE &&
          entry.state === "requested",
      ),
    ).toHaveLength(1);
    acknowledgeCompletionTurnWake(pi as never);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged", wakeIds: [wakeId] }),
    );
  });

  it("marks only the native custom message carrying the active wake id", () => {
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeMessage = findWakeMessage(pi);
    const wakeId = wakeMessage.details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(
      markCompletionTurnWakeStarted(pi as never, {
        ...wakeMessage,
        customType: "unrelated",
        content: `unrelated custom message mentions wake id ${wakeId}`,
      }),
    ).toBe(false);
    expect(
      markCompletionTurnWakeStarted(pi as never, {
        ...wakeMessage,
        content: `unrelated custom message mentions wake id ${wakeId}`,
        details: { [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: "different-wake-id" },
      }),
    ).toBe(false);
    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(pi.appendEntry).toHaveBeenCalledOnce();

    expect(markCompletionTurnWakeStarted(pi as never, wakeMessage)).toBe(true);
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
  });

  it("retries a transient acknowledgement failure without replaying the wake", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeMessage = findWakeMessage(pi);
    expect(markCompletionTurnWakeStarted(pi as never, wakeMessage)).toBe(true);
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);

    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh wake for a completion arriving during ack retry", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const firstWakeMessage = findWakeMessage(pi);
    expect(markCompletionTurnWakeStarted(pi as never, firstWakeMessage)).toBe(
      true,
    );
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });
    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(wakeMessages(pi)).toHaveLength(2);

    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    const secondWakeMessage = wakeMessages(pi)[1];
    expect(markCompletionTurnWakeStarted(pi as never, secondWakeMessage)).toBe(
      true,
    );
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(pi.appendEntry).toHaveBeenLastCalledWith(
      ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
      expect.objectContaining({ state: "acknowledged" }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds acknowledgement retries and lets a later completion wake again", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeMessage = findWakeMessage(pi);
    expect(markCompletionTurnWakeStarted(pi as never, wakeMessage)).toBe(true);
    pi.appendEntry.mockImplementation(() => {
      throw new Error("persistent append failure");
    });

    expect(settleCompletionTurnWake(pi as never)).toBe(false);
    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS *
        (ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS + 2),
    );
    expect(wakeMessages(pi)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(wakeMessages(pi)).toHaveLength(2);
    clearCompletionTurnWake(pi as never);
  });

  it("cancels a pending acknowledgement retry on clear", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeMessage = findWakeMessage(pi);
    markCompletionTurnWakeStarted(pi as never, wakeMessage);
    pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("transient append failure");
    });
    settleCompletionTurnWake(pi as never);
    expect(vi.getTimerCount()).toBe(1);

    clearCompletionTurnWake(pi as never);
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("retries native custom wake sends up to a cap, then retries a later completion", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    pi.sendMessage
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("transient send failure");
      });

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(wakeMessages(pi)).toHaveLength(1);

    for (
      let attempt = 1;
      attempt < ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS;
      attempt++
    ) {
      vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS);
      expect(wakeMessages(pi)).toHaveLength(attempt + 1);
    }
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS * 2);
    expect(wakeMessages(pi)).toHaveLength(ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS);

    sendCompletionTurn(pi as never, completion("two"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(wakeMessages(pi)).toHaveLength(
      ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS + 1,
    );

    clearCompletionTurnWake(pi as never);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies the coordinator once when bounded wake attempts are exhausted", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    const exhausted = vi.fn();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
      onWakeExhausted: exhausted,
    });

    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS *
        ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS,
    );

    expect(exhausted).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS * 2);
    expect(exhausted).toHaveBeenCalledOnce();
    clearCompletionTurnWake(pi as never);
  });

  it("allows the final native wake attempt to start before exhaustion releases the fence", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    const exhausted = vi.fn();

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
      onWakeExhausted: exhausted,
    });

    vi.advanceTimersByTime(
      ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS *
        (ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS - 1),
    );

    expect(wakeMessages(pi)).toHaveLength(ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS);
    expect(exhausted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    const finalWakeMessage =
      wakeMessages(pi)[ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS - 1];
    expect(markCompletionTurnWakeStarted(pi as never, finalWakeMessage)).toBe(
      true,
    );
    expect(exhausted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    clearCompletionTurnWake(pi as never);
  });

  it("clears the wake watchdog when the exact run starts and settles", () => {
    vi.useFakeTimers();
    const pi = mockPi();
    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    expect(vi.getTimerCount()).toBe(1);

    const wakeMessage = findWakeMessage(pi);
    expect(markCompletionTurnWakeStarted(pi as never, wakeMessage)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(settleCompletionTurnWake(pi as never)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses native custom-message delivery when Orchestratorv2 is disabled", () => {
    const pi = mockPi();
    pi.getFlag.mockReturnValue(false);

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "one" }),
      { deliverAs: "followUp", triggerTurn: true },
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("recovers a durable delivered wake idempotently but ignores an acknowledged one", () => {
    const wakeId = "12345678-1234-1234-9234-123456789abc";
    const entries = [
      {
        type: "custom",
        customType: ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
        data: { schemaVersion: 1, state: "requested", wakeId },
      },
      {
        type: "custom_message",
        details: { [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: wakeId },
      },
    ];
    const pendingPi = mockPi();

    expect(recoverCompletionTurnWakes(pendingPi as never, entries)).toBe(true);
    expect(recoverCompletionTurnWakes(pendingPi as never, entries)).toBe(true);
    expect(pendingPi.sendMessage).toHaveBeenCalledOnce();
    clearCompletionTurnWake(pendingPi as never);

    const acknowledgedPi = mockPi();
    expect(
      recoverCompletionTurnWakes(acknowledgedPi as never, [
        ...entries,
        {
          type: "custom",
          customType: ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
          data: {
            schemaVersion: 1,
            state: "acknowledged",
            wakeIds: [wakeId],
          },
        },
      ]),
    ).toBe(false);
    expect(acknowledgedPi.sendMessage).not.toHaveBeenCalled();
  });
});
