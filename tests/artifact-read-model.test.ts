import { describe, expect, it } from "vitest";
import type { SubagentEvent } from "../src/artifact";
import {
  artifactOutputContent,
  artifactOutputState,
  artifactReadOutcome,
  artifactReadRequest,
  completionForRead,
  consumableArtifactCompletion,
  isMetadataReadPlan,
  planArtifactRead,
  resolveArtifactRead,
  type ArtifactConsumption,
  type ArtifactReadRequest,
  type ArtifactReadValue,
} from "../src/artifact-read-model";

function started(
  turnId = "a",
  ts = 100,
): Extract<SubagentEvent, { type: "turn_started" }> {
  return {
    version: 2,
    eventId: `start-${turnId}`,
    turnId,
    ts,
    type: "turn_started",
    status: "running",
  };
}
function completed(
  turnId = "a",
  outcome: "done" | "error" | "cancelled" = "done",
  ts = 50,
): SubagentEvent {
  return {
    version: 2,
    eventId: `done-${turnId}-${ts}`,
    turnId,
    ts,
    type: "completion",
    status: outcome,
    outcome,
    source: "agent_settled",
  };
}
const exit: SubagentEvent = {
  version: 2,
  eventId: "exit",
  turnId: "a",
  ts: 1,
  type: "process_exited",
  status: "error",
  exitCode: 1,
};
const error: ArtifactReadValue = {
  kind: "error",
  error: {
    code: "output_too_large",
    bytes: 100,
    maxBytes: 10,
  },
};
const missing: ArtifactReadValue = { kind: "missing" };
const content: ArtifactReadValue = { kind: "content", content: "answer" };
const empty: ArtifactReadValue = { kind: "content", content: "" };
const latest: ArtifactReadRequest = { kind: "latest" };
const metadata: ArtifactReadRequest = { kind: "metadata" };
const turn: ArtifactReadRequest = { kind: "turn", turnId: "absent" };

function read(
  events: readonly SubagentEvent[],
  request = latest,
  value = missing,
) {
  const plan = planArtifactRead(events, request);
  return isMetadataReadPlan(plan)
    ? resolveArtifactRead(plan, { kind: "not_read" })
    : resolveArtifactRead(plan, value);
}

describe("artifact read request", () => {
  it.each([
    [{}, latest],
    [{ includeOutput: true }, latest],
    [{ includeOutput: false }, metadata],
    [
      { includeOutput: false, turnId: "" },
      { kind: "turn", turnId: "" },
    ],
    [{ turnId: "a" }, { kind: "turn", turnId: "a" }],
  ])("selects %j as %j", (params, expected) => {
    expect(artifactReadRequest(params)).toEqual(expected);
  });
});

describe("physical completion selection", () => {
  it("uses physical event order, resets at new turns and ignores old completions", () => {
    const b = started("b", 2);
    const events = [started(), completed(), b, completed("a", "error", 999)];
    expect(completionForRead(events, {})).toEqual({
      completion: undefined,
      lifecycleEvent: b,
      processExitEvent: null,
      artifactClosed: false,
    });
    expect(planArtifactRead(events, latest).source).toEqual({
      kind: "staging",
    });
  });

  it("explicit turns select first matching completion while latest selects last", () => {
    const first = completed("a", "done", 500);
    const last = completed("a", "error", 1);
    const events = [started(), first, last, exit];
    expect(completionForRead(events, { turnId: "a" })).toEqual({
      completion: { turnId: "a", outcome: "done", terminalTs: 500 },
      lifecycleEvent: first,
      processExitEvent: null,
      artifactClosed: true,
    });
    expect(completionForRead(events, {}).completion).toEqual({
      turnId: "a",
      outcome: "error",
      terminalTs: 1,
    });
  });

  it("preserves unscoped completion despite later activity and settled active lifecycle", () => {
    const activity: SubagentEvent = {
      ...started(),
      type: "tool_activity",
      phase: "end",
    };
    expect(completionForRead([completed(), activity], {}).lifecycleEvent).toBe(
      activity,
    );
    const terminal = completed();
    expect(
      completionForRead([started(), terminal, activity], {}).lifecycleEvent,
    ).toBe(terminal);
  });

  it.each([
    [[], latest, "unavailable"],
    [[started()], latest, "staging"],
    [[started(), exit], latest, "unavailable"],
    [[completed()], latest, "snapshot"],
    [[completed(), exit], latest, "snapshot"],
    [[completed()], metadata, "not_requested"],
    [[], turn, "snapshot"],
  ] as const)("plans sources for %j / %j", (events, request, source) => {
    expect(planArtifactRead(events, request).source.kind).toBe(source);
  });

  it("uses process exit before settled lifecycle, but explicit turns suppress exit", () => {
    const terminal = completed();
    expect(planArtifactRead([terminal, exit], latest).terminalEvent).toBe(exit);
    expect(
      planArtifactRead([terminal, exit], { kind: "turn", turnId: "a" })
        .terminalEvent,
    ).toBe(terminal);
    expect(planArtifactRead([started()], latest).terminalEvent).toBeNull();
  });
});

describe("artifact read resolution", () => {
  it.each([
    [[], latest, missing, "running", "pending", undefined],
    [[started()], latest, missing, "running", "pending", "a"],
    [[completed()], latest, missing, "done", "missing", "a"],
    [[exit], latest, missing, "error", "missing", undefined],
    [[completed(), exit], latest, missing, "done", "missing", "a"],
    [
      [completed("a", "cancelled")],
      latest,
      content,
      "cancelled",
      "available",
      "a",
    ],
    [[completed("a", "error")], latest, empty, "error", "empty", "a"],
    [[], latest, empty, "running", "empty", undefined],
    [[], latest, content, "running", "available", undefined],
    [[exit], turn, missing, "not_found", "unavailable", "absent"],
    [[exit], turn, content, "not_found", "available", "absent"],
    [[exit], turn, error, "error", "read_error", "absent"],
    [[], turn, missing, "running", "pending", "absent"],
    [[completed()], metadata, error, "done", "not_requested", "a"],
    [[started()], metadata, content, "running", "not_requested", "a"],
    [[completed("a", "cancelled")], latest, error, "error", "read_error", "a"],
  ] as const)(
    "resolves %j / %j / %j",
    (events, request, value, status, output, turnId) => {
      const result = read(events, request, value);
      expect(result.status).toBe(status);
      expect(result.output.kind).toBe(output);
      expect(result.turnId).toBe(turnId);
      expect(artifactOutputState(result.output)).toBe(
        output === "read_error" ? "unavailable" : output,
      );
      expect(artifactOutputContent(result.output)).toBe(
        output === "empty" ? "" : output === "available" ? "answer" : null,
      );
    },
  );

  it.each([content, error])(
    "ignores unexpected metadata payloads at the runtime boundary (%j)",
    (value) => {
      const plan = planArtifactRead([completed()], { kind: "metadata" });
      // @ts-expect-error Exercise untyped callers without weakening the fixture helpers.
      const result = resolveArtifactRead(plan, value);
      expect(result.output).toEqual({ kind: "not_requested" });
      expect(result.status).toBe("done");
    },
  );

  it("retains output diagnostics and treats not_read like missing", () => {
    expect(read([], latest, error).output).toEqual({
      kind: "read_error",
      error: error.error,
    });
    expect(read([], latest, { kind: "not_read" }).output).toEqual({
      kind: "pending",
    });
  });
});

describe("telemetry and consumption", () => {
  it.each([
    [[], metadata, missing, "not_applicable", "running"],
    [[], latest, missing, "not_applicable", "unavailable"],
    [[started()], metadata, error, "not_applicable", "running"],
    [[started()], latest, missing, "not_applicable", "running"],
    [[started(), exit], latest, missing, "not_applicable", "unavailable"],
    [[exit], metadata, missing, "not_applicable", "unavailable"],
    [[completed()], metadata, content, "consumed", "unavailable"],
    [[completed("a", "error")], metadata, missing, "not_applicable", "error"],
    [
      [completed("a", "cancelled")],
      metadata,
      missing,
      "not_applicable",
      "cancelled",
    ],
    [[completed("a", "cancelled")], latest, error, "not_applicable", "error"],
    [[completed("a", "error")], latest, empty, "consumed", "error"],
    [[completed("a", "cancelled")], latest, content, "consumed", "cancelled"],
    [[completed()], latest, empty, "already_consumed", "empty"],
    [[completed()], latest, content, "consumed", "consumed"],
    [[completed()], latest, content, "already_consumed", "already_consumed"],
    [[completed()], latest, content, "not_applicable", "running"],
    [[started()], latest, content, "not_applicable", "running"],
    [[exit], turn, missing, "not_applicable", "unavailable"],
  ] as const)(
    "classifies %j / %j / %j / %s",
    (events, request, value, consumption, expected) => {
      expect(
        artifactReadOutcome(
          read(events, request, value),
          consumption as ArtifactConsumption,
        ),
      ).toBe(expected);
    },
  );

  it.each(["done", "error", "cancelled"] as const)(
    "permits receipts for %s completion only with content",
    (outcome) => {
      for (const value of [empty, content]) {
        const result = read([completed("a", outcome)], latest, value);
        expect(consumableArtifactCompletion(result)).toEqual(
          result.plan.selection.completion,
        );
      }
      for (const value of [missing, error, { kind: "not_read" } as const]) {
        expect(
          consumableArtifactCompletion(
            read([completed("a", outcome)], latest, value),
          ),
        ).toBeUndefined();
      }
      expect(
        consumableArtifactCompletion(
          read([completed("a", outcome)], metadata, content),
        ),
      ).toBeUndefined();
      expect(
        consumableArtifactCompletion(read([started()], latest, content)),
      ).toBeUndefined();
    },
  );
});
