import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SubagentEvent } from "../../src/artifact";
import {
  completionForRead,
  consumableArtifactCompletion,
  planArtifactRead,
  resolveArtifactRead,
} from "../../src/artifact-read-model";
import { propertyParameters } from "./property-options";

const turnId = fc.constantFrom("alpha", "beta", "gamma");
const outcome = fc.constantFrom("done", "error", "cancelled");
const event = fc
  .record({
    kind: fc.constantFrom(
      "turn_started",
      "completion",
      "process_exited",
      "tool_activity",
    ),
    turnId,
    outcome,
    ts: fc.nat({ max: 1_000_000 }),
  })
  .map((input): SubagentEvent => {
    const base = {
      version: 2 as const,
      eventId: `${input.kind}-${input.turnId}-${input.ts}`,
      turnId: input.turnId,
      ts: input.ts,
    };
    switch (input.kind) {
      case "turn_started":
        return { ...base, type: "turn_started", status: "running" };
      case "completion":
        return {
          ...base,
          type: "completion",
          status: input.outcome,
          outcome: input.outcome,
          source: "agent_settled",
        };
      case "tool_activity":
        return {
          ...base,
          type: "tool_activity",
          status: "running",
          phase: "start",
        };
      case "process_exited":
        return {
          ...base,
          type: "process_exited",
          status: input.outcome,
          exitCode: 0,
        };
      default:
        throw new Error("Unexpected generated event kind");
    }
  });
const events = fc.array(event, { maxLength: 80 });

function identity(selection: ReturnType<typeof completionForRead>) {
  return {
    completion: selection.completion && {
      turnId: selection.completion.turnId,
      outcome: selection.completion.outcome,
    },
    lifecycleEventId: selection.lifecycleEvent?.eventId,
    processExitEventId: selection.processExitEvent?.eventId,
    artifactClosed: selection.artifactClosed,
  };
}

describe("artifact read sequence properties", () => {
  it("does not use timestamps for selection or source decisions", () => {
    fc.assert(
      fc.property(
        events,
        fc.array(fc.nat(), { minLength: 1, maxLength: 80 }),
        (log, timestamps) => {
          const retimed = log.map((entry, index) => ({
            ...entry,
            ts: timestamps[index % timestamps.length]!,
          }));
          expect(identity(completionForRead(retimed, {}))).toEqual(
            identity(completionForRead(log, {})),
          );
          expect(planArtifactRead(retimed, { kind: "latest" }).source).toEqual(
            planArtifactRead(log, { kind: "latest" }).source,
          );
        },
      ),
      propertyParameters(),
    );
  });

  it("selects the first physical completion for an explicit turn", () => {
    fc.assert(
      fc.property(events, turnId, (log, requestedTurn) => {
        const selected = completionForRead(log, { turnId: requestedTurn });
        const expected = log.find(
          (entry) =>
            entry.type === "completion" && entry.turnId === requestedTurn,
        );
        expect(selected.lifecycleEvent).toEqual(expected ?? null);
        expect(selected.artifactClosed).toBe(
          log.some((entry) => entry.type === "process_exited"),
        );
        expect(
          planArtifactRead(log, { kind: "turn", turnId: requestedTurn }).source,
        ).toEqual({ kind: "snapshot", turnId: requestedTurn });
      }),
      propertyParameters(),
    );
  });

  it("selects the last matching completion after the last physical turn start", () => {
    fc.assert(
      fc.property(events, (log) => {
        const lastStart = log.findLastIndex(
          (entry) => entry.type === "turn_started",
        );
        const active = log[lastStart]?.turnId;
        const expected = log
          .slice(lastStart + 1)
          .findLast(
            (entry) =>
              entry.type === "completion" &&
              (active === undefined || entry.turnId === active),
          );
        const selected = completionForRead(log, {});
        expect(selected.completion?.turnId).toBe(expected?.turnId);
        expect(selected.completion).toEqual(
          expected?.type === "completion"
            ? {
                turnId: expected.turnId,
                outcome: expected.outcome,
                terminalTs: expected.ts,
              }
            : undefined,
        );
      }),
      propertyParameters(),
    );
  });

  it("never chooses staging for a selected completion or an exited process", () => {
    fc.assert(
      fc.property(events, (log) => {
        const plan = planArtifactRead(log, { kind: "latest" });
        if (plan.selection.completion) {
          expect(plan.source).toEqual({
            kind: "snapshot",
            turnId: plan.selection.completion.turnId,
          });
        }
        if (plan.selection.completion || plan.selection.processExitEvent) {
          expect(plan.source.kind).not.toBe("staging");
        }
        expect(planArtifactRead(log, { kind: "metadata" }).source.kind).toBe(
          "not_requested",
        );
      }),
      propertyParameters(),
    );
  });

  it("requires both selected completion and readable content for receipt eligibility", () => {
    fc.assert(
      fc.property(
        events,
        turnId,
        fc.string(),
        (log, requestedTurn, content) => {
          const plan = planArtifactRead(log, {
            kind: "turn",
            turnId: requestedTurn,
          });
          const read = resolveArtifactRead(plan, { kind: "content", content });
          expect(consumableArtifactCompletion(read)).toEqual(
            plan.selection.completion,
          );
          const missing = resolveArtifactRead(plan, { kind: "missing" });
          expect(consumableArtifactCompletion(missing)).toBeUndefined();
          const metadata = resolveArtifactRead(
            planArtifactRead(log, { kind: "metadata" }),
            { kind: "not_read" },
          );
          expect(consumableArtifactCompletion(metadata)).toBeUndefined();
        },
      ),
      propertyParameters(),
    );
  });
});
