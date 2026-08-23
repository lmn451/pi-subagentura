import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeCompletionTurnWake,
  clearCompletionTurnWake,
  ORCHESTRATOR_V2_WAKE_DETAIL_KEY,
  ORCHESTRATOR_V2_WAKE_ENTRY_TYPE,
  recoverCompletionTurnWakes,
  sendCompletionTurn,
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

describe("Orchestratorv2 completion turns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent completions without retrying an outstanding preflight", () => {
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
      pi.sendMessage.mock.calls[0][0].details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
    expect(pi.sendMessage.mock.calls[1][0].details).toMatchObject({
      [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: firstWakeId,
    });
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();

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
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

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

    expect(consoleError).toHaveBeenCalledOnce();
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
    vi.spyOn(console, "error").mockImplementation(() => {});

    sendCompletionTurn(pi as never, completion("one"), {
      deliverAs: "followUp",
      triggerTurn: true,
      parentStreaming: false,
    });
    const wakeId =
      pi.sendMessage.mock.calls[0][0].details[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
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

    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(pi.sendMessage.mock.calls[1][0].details).toMatchObject({
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

  it("recovers a durable delivered wake but ignores an acknowledged one", () => {
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
    expect(pendingPi.sendUserMessage).toHaveBeenCalledOnce();
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
    expect(acknowledgedPi.sendUserMessage).not.toHaveBeenCalled();
  });
});
