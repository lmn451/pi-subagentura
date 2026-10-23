import { describe, expect, it } from "vitest";
import { shouldNotify, sanitizeOutput } from "../src/notifications";

describe("protocol-v2 completion notifications", () => {
  const completion = {
    version: 2 as const,
    eventId: "event-1",
    turnId: "turn-1",
    ts: 2,
    type: "completion" as const,
    status: "done" as const,
    outcome: "done" as const,
    source: "agent_settled" as const,
  };

  it("notifies for protocol-v2 completions, not activity events", () => {
    expect(shouldNotify(completion)).toBe(true);
    expect(
      shouldNotify({
        version: 2,
        eventId: "activity-1",
        turnId: "turn-1",
        ts: 1,
        type: "turn_started",
        status: "running",
      }),
    ).toBe(false);
  });

  it("quietens only aborted child settlement errors", () => {
    const aborted = {
      ...completion,
      status: "error" as const,
      outcome: "error" as const,
      agentStopReason: "aborted" as const,
    };
    expect(shouldNotify(aborted)).toBe(false);
    expect(shouldNotify({ ...aborted, agentStopReason: "error" })).toBe(true);
    expect(shouldNotify({ ...aborted, agentStopReason: undefined })).toBe(true);
    expect(
      shouldNotify({
        ...aborted,
        source: "parent",
      }),
    ).toBe(true);
    expect(
      shouldNotify({
        ...aborted,
        source: "explicit",
      }),
    ).toBe(true);
  });

  it("redacts credential-like strings", () => {
    expect(sanitizeOutput(`token sk-${"a".repeat(24)}`)).toBe(
      "token [REDACTED]",
    );
  });
});
