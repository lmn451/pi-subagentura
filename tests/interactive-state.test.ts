import { describe, expect, it } from "vitest";
import type { PersistedLifecycleFold, SubagentEvent } from "../src/artifact";
import {
  initialInteractiveMachineState,
  projectInteractiveStatus,
  transitionInteractiveMachine,
  type InteractiveMachineEvent,
  type InteractiveMachineState,
  type InteractiveMachineTransition,
  type PaneLiveness,
} from "../src/interactive-state";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  foldInteractiveLifecycle,
} from "../src/interactive-tmux";

const legacyStarted = {
  ts: 1,
  type: "started",
  status: "running",
} as const satisfies SubagentEvent;
const legacyActivity = {
  ts: 2,
  type: "tool_activity",
  status: "running",
  tool: "read",
} as const satisfies SubagentEvent;
const legacyDone = {
  ts: 3,
  type: "done",
  status: "done",
  exitCode: 0,
} as const satisfies SubagentEvent;
const legacyError = {
  ts: 3,
  type: "error",
  status: "error",
  exitCode: 1,
  message: "failed",
} as const satisfies SubagentEvent;
const legacyCancelled = {
  ts: 3,
  type: "cancelled",
  status: "cancelled",
} as const satisfies SubagentEvent;

function turnStarted(turnId: string, ts = 1): SubagentEvent {
  return {
    version: 2,
    eventId: `start-${turnId}`,
    turnId,
    ts,
    type: "turn_started",
    status: "running",
  };
}

function toolActivity(turnId: string, ts = 2): SubagentEvent {
  return {
    version: 2,
    eventId: `tool-${turnId}`,
    turnId,
    ts,
    type: "tool_activity",
    status: "running",
    phase: "start",
    tool: "read",
  };
}

function completion(
  turnId: string,
  outcome: "done" | "error" | "cancelled",
  ts = 3,
  source:
    | "agent_settled"
    | "agent_end"
    | "explicit"
    | "process_exit"
    | "parent" = "agent_settled",
): SubagentEvent {
  return {
    version: 2,
    eventId: `completion-${turnId}-${outcome}`,
    turnId,
    ts,
    type: "completion",
    status: outcome,
    outcome,
    source,
  };
}

function processExited(
  status: "done" | "error" | "cancelled",
  exitCode: number,
  ts = 4,
): SubagentEvent {
  return {
    version: 2,
    eventId: `process-${status}`,
    turnId: "turn-process",
    ts,
    type: "process_exited",
    status,
    exitCode,
  };
}

function artifact(event: SubagentEvent): InteractiveMachineEvent {
  return { type: "artifact", event };
}

function requireApplied(
  transition: InteractiveMachineTransition,
): InteractiveMachineState {
  if (transition.kind !== "applied") {
    throw new Error(`expected applied transition, received ${transition.kind}`);
  }
  return transition.state;
}

function applyEvent(
  state: InteractiveMachineState,
  event: InteractiveMachineEvent,
): InteractiveMachineState {
  return requireApplied(transitionInteractiveMachine(state, event));
}

function replay(
  events: readonly InteractiveMachineEvent[],
  pane: PaneLiveness = { kind: "unknown" },
): {
  readonly state: InteractiveMachineState;
  readonly transitions: readonly InteractiveMachineTransition[];
} {
  let state = initialInteractiveMachineState({ pane });
  const transitions: InteractiveMachineTransition[] = [];
  for (const event of events) {
    const transition = transitionInteractiveMachine(state, event);
    transitions.push(transition);
    state = transition.state;
  }
  return { state, transitions };
}

describe("interactive state kernel", () => {
  it("starts from an unknown running process without inventing artifact facts", () => {
    expect(initialInteractiveMachineState()).toEqual({
      phase: "running",
      lifecycle: {},
      pane: { kind: "unknown" },
      observationRevision: 0,
    });
  });

  it.each([
    ["legacy started", legacyStarted, "running"],
    ["legacy tool activity", legacyActivity, "running"],
    ["legacy done", legacyDone, "completed"],
    ["legacy error", legacyError, "completed"],
    ["legacy cancelled", legacyCancelled, "cancelled"],
    ["v2 turn started", turnStarted("turn-1"), "running"],
    ["v2 tool activity", toolActivity("turn-1"), "running"],
    ["v2 done", completion("turn-1", "done"), "completed"],
    ["v2 error", completion("turn-1", "error"), "completed"],
    ["v2 cancelled", completion("turn-1", "cancelled"), "cancelled"],
    ["process done", processExited("done", 0), "process_exited"],
    ["process error", processExited("error", 1), "process_exited"],
    ["process cancelled", processExited("cancelled", 130), "cancelled"],
  ] as const)(
    "applies every legal artifact transition: %s",
    (_name, event, phase) => {
      const initial = initialInteractiveMachineState({
        pane: { kind: "alive" },
      });
      const result = transitionInteractiveMachine(initial, artifact(event));

      expect(result.kind).toBe("applied");
      if (result.kind !== "applied") return;
      expect(result.previous).toBe(initial);
      expect(result.state.phase).toBe(phase);
      expect(result.state.lifecycle.startedAt).toBe(event.ts);
    },
  );

  it("preserves legacy done and error terminal semantics for every pane observation", () => {
    const cases = [
      [legacyDone, { kind: "alive" }, "idle"],
      [legacyDone, { kind: "dead" }, "exited"],
      [legacyDone, { kind: "unavailable", reason: "tmux down" }, "unknown"],
      [legacyDone, { kind: "unknown", reason: "bad output" }, "unknown"],
      [legacyError, { kind: "alive" }, "exited"],
      [legacyError, { kind: "dead" }, "exited"],
      [legacyError, { kind: "unavailable", reason: "tmux down" }, "exited"],
      [legacyError, { kind: "unknown", reason: "bad output" }, "exited"],
    ] as const satisfies readonly (readonly [
      SubagentEvent,
      PaneLiveness,
      "idle" | "exited" | "unknown",
    ])[];

    for (const [event, pane, expected] of cases) {
      const state = applyEvent(
        initialInteractiveMachineState({ pane }),
        artifact(event),
      );
      expect(projectInteractiveStatus(state)).toBe(expected);
    }
  });

  it("projects v2 done and error completion from authoritative artifact and pane facts", () => {
    const cases = [
      ["done", { kind: "alive" }, "idle"],
      ["done", { kind: "dead" }, "exited"],
      ["done", { kind: "unavailable", reason: "mux offline" }, "unknown"],
      ["done", { kind: "unknown", reason: "malformed response" }, "unknown"],
      ["error", { kind: "alive" }, "idle"],
      ["error", { kind: "dead" }, "exited"],
      ["error", { kind: "unavailable", reason: "mux offline" }, "unknown"],
      ["error", { kind: "unknown", reason: "malformed response" }, "unknown"],
    ] as const satisfies readonly (readonly [
      "done" | "error",
      PaneLiveness,
      "idle" | "exited" | "unknown",
    ])[];

    for (const [outcome, pane, expected] of cases) {
      const state = applyEvent(
        initialInteractiveMachineState({ pane }),
        artifact(completion("turn-v2", outcome)),
      );
      expect(state).toMatchObject({
        phase: "completed",
        protocol: "v2",
        outcome,
      });
      expect(projectInteractiveStatus(state)).toBe(expected);
    }
  });

  it("makes parent cancellation terminal independently of pane liveness", () => {
    const panes = [
      { kind: "alive" },
      { kind: "dead" },
      { kind: "unavailable", reason: "backend absent" },
      { kind: "unknown", reason: "probe failed" },
    ] as const satisfies readonly PaneLiveness[];

    for (const pane of panes) {
      const initial = initialInteractiveMachineState({ pane });
      const cancelled = applyEvent(initial, { type: "parent_cancelled" });
      expect(cancelled).toMatchObject({
        phase: "cancelled",
        source: "parent",
        pane,
      });
      expect(projectInteractiveStatus(cancelled)).toBe("cancelled");
      expect(
        transitionInteractiveMachine(cancelled, { type: "parent_cancelled" }),
      ).toEqual({
        kind: "unchanged",
        state: cancelled,
      });
    }
  });

  it("distinguishes process exit outcomes without consulting pane liveness", () => {
    const done = applyEvent(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
      artifact(processExited("done", 0)),
    );
    const error = applyEvent(
      initialInteractiveMachineState({ pane: { kind: "unavailable" } }),
      artifact(processExited("error", 9)),
    );
    const cancelled = applyEvent(
      initialInteractiveMachineState({ pane: { kind: "unknown" } }),
      artifact(processExited("cancelled", 130)),
    );

    expect(done).toMatchObject({
      phase: "process_exited",
      status: "done",
      exitCode: 0,
    });
    expect(error).toMatchObject({
      phase: "process_exited",
      status: "error",
      exitCode: 9,
    });
    expect(cancelled).toMatchObject({ phase: "cancelled", source: "process" });
    expect(projectInteractiveStatus(done)).toBe("exited");
    expect(projectInteractiveStatus(error)).toBe("exited");
    expect(projectInteractiveStatus(cancelled)).toBe("cancelled");
  });

  it("starts a follow-up only from a completed reusable process", () => {
    const completed = applyEvent(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
      artifact(completion("turn-1", "done")),
    );
    const followup = transitionInteractiveMachine(completed, {
      type: "followup_started",
      turnId: "turn-2",
    });

    expect(followup.kind).toBe("applied");
    if (followup.kind !== "applied") return;
    expect(followup.state).toMatchObject({
      phase: "running",
      pane: { kind: "alive" },
    });
    expect(followup.state.lifecycle).toMatchObject({ currentTurnId: "turn-2" });
    expect(followup.state.lifecycle.completionOutcome).toBeUndefined();
  });

  it.each([
    ["already-running", initialInteractiveMachineState()],
    [
      "parent-cancelled",
      applyEvent(initialInteractiveMachineState(), {
        type: "parent_cancelled",
      }),
    ],
    [
      "legacy-error",
      applyEvent(
        initialInteractiveMachineState({ pane: { kind: "alive" } }),
        artifact(legacyError),
      ),
    ],
    [
      "completed-dead",
      applyEvent(
        initialInteractiveMachineState({ pane: { kind: "dead" } }),
        artifact(completion("dead-turn", "done")),
      ),
    ],
    [
      "completed-unavailable",
      applyEvent(
        initialInteractiveMachineState({
          pane: { kind: "unavailable", reason: "mux unavailable" },
        }),
        artifact(completion("unavailable-turn", "done")),
      ),
    ],
    [
      "process-exited",
      applyEvent(
        initialInteractiveMachineState(),
        artifact(processExited("done", 0)),
      ),
    ],
  ] as const)(
    "rejects illegal follow-up transition from %s",
    (_name, state) => {
      const result = transitionInteractiveMachine(state, {
        type: "followup_started",
        turnId: "illegal-turn",
      });

      expect(result).toMatchObject({ kind: "invalid", state });
      if (result.kind === "invalid") expect(result.reason).not.toHaveLength(0);
    },
  );

  it("returns an explicit invalid result for an unknown runtime event", () => {
    const state = initialInteractiveMachineState();
    const unknownEvent = {
      type: "future_protocol_event",
      payload: "opaque",
    } as unknown as InteractiveMachineEvent;

    expect(transitionInteractiveMachine(state, unknownEvent)).toMatchObject({
      kind: "invalid",
      state,
      reason: expect.stringContaining("unknown interactive transition"),
    });
  });

  it("rejects stale pane observations and leaves authoritative state untouched", () => {
    const initial = initialInteractiveMachineState({
      pane: { kind: "unknown" },
    });
    const observing = applyEvent(initial, { type: "pane_observation_started" });
    expect(observing.observationRevision).toBe(1);

    const stale = transitionInteractiveMachine(observing, {
      type: "pane_observed",
      revision: 0,
      liveness: { kind: "dead" },
    });
    expect(stale).toEqual({
      kind: "stale",
      state: observing,
      expectedRevision: 1,
      receivedRevision: 0,
    });

    const observed = applyEvent(observing, {
      type: "pane_observed",
      revision: 1,
      liveness: { kind: "alive" },
    });
    const nextObservation = applyEvent(observed, {
      type: "pane_observation_started",
    });
    const superseded = transitionInteractiveMachine(nextObservation, {
      type: "pane_observed",
      revision: 1,
      liveness: { kind: "dead" },
    });
    expect(superseded).toMatchObject({
      kind: "stale",
      state: nextObservation,
      expectedRevision: 2,
      receivedRevision: 1,
    });
  });

  it("keeps a confirmed-dead pane identity terminal", () => {
    const completed = applyEvent(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
      artifact(completion("terminal-turn", "done")),
    );
    const firstObservation = applyEvent(completed, {
      type: "pane_observation_started",
    });
    const dead = applyEvent(firstObservation, {
      type: "pane_observed",
      revision: 1,
      liveness: { kind: "dead" },
    });
    const secondObservation = applyEvent(dead, {
      type: "pane_observation_started",
    });

    const result = transitionInteractiveMachine(secondObservation, {
      type: "pane_observed",
      revision: 2,
      liveness: { kind: "alive" },
    });

    expect(result).toMatchObject({ kind: "invalid", state: secondObservation });
    expect(projectInteractiveStatus(result.state)).toBe("exited");
    expect(result.state.pane).toEqual({ kind: "dead" });
  });

  it("reports an observation with the same liveness kind as unchanged", () => {
    const observing = applyEvent(
      initialInteractiveMachineState({
        pane: { kind: "unavailable", reason: "first failure" },
      }),
      { type: "pane_observation_started" },
    );
    expect(
      transitionInteractiveMachine(observing, {
        type: "pane_observed",
        revision: 1,
        liveness: { kind: "unavailable", reason: "second failure" },
      }),
    ).toEqual({ kind: "unchanged", state: observing });
  });

  it("replays the same mixed event stream deterministically", () => {
    const events = [
      { type: "pane_observation_started" },
      { type: "pane_observed", revision: 1, liveness: { kind: "alive" } },
      artifact(turnStarted("turn-1", 10)),
      artifact(toolActivity("turn-1", 11)),
      artifact(completion("turn-1", "error", 12)),
      { type: "followup_started", turnId: "turn-2" },
      { type: "pane_observation_started" },
      { type: "pane_observed", revision: 1, liveness: { kind: "dead" } },
      artifact(completion("turn-2", "done", 13)),
    ] as const satisfies readonly InteractiveMachineEvent[];

    const first = replay(events);
    const second = replay(events);

    expect(first).toEqual(second);
    expect(first.state).toMatchObject({
      phase: "completed",
      protocol: "v2",
      outcome: "done",
      pane: { kind: "alive" },
      observationRevision: 2,
    });
    expect(first.transitions.map((transition) => transition.kind)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "stale",
      "applied",
    ]);
  });

  it("matches the established lifecycle projection for alive and dead panes", () => {
    const sequences = [
      [],
      [legacyStarted],
      [legacyStarted, legacyDone],
      [legacyStarted, legacyError],
      [legacyStarted, legacyCancelled],
      [turnStarted("turn-done"), completion("turn-done", "done")],
      [turnStarted("turn-error"), completion("turn-error", "error")],
      [turnStarted("turn-cancel"), completion("turn-cancel", "cancelled")],
      [processExited("done", 0)],
      [processExited("error", 7)],
      [processExited("cancelled", 130)],
    ] as const satisfies readonly (readonly SubagentEvent[])[];

    for (const events of sequences) {
      const lifecycle: PersistedLifecycleFold = {};
      for (const event of events) foldInteractiveLifecycle(lifecycle, event);
      for (const paneAlive of [true, false] as const) {
        const machine = replay(
          events.map(artifact),
          paneAlive ? { kind: "alive" } : { kind: "dead" },
        ).state;
        expect(projectInteractiveStatus(machine)).toBe(
          deriveInteractiveSubagentStatusFromLifecycle(lifecycle, paneAlive),
        );
      }
    }
  });
});
