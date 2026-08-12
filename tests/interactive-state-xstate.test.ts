import { describe, expect, it } from "vitest";
import type { Snapshot } from "xstate";

import type { SubagentEvent } from "../src/artifact";
import {
  advanceInteractiveStateActor,
  createInteractiveStateActor,
} from "../src/interactive-state-xstate";
import {
  initialInteractiveMachineState,
  projectInteractiveStatus,
} from "../src/interactive-state";

const legacyDone = {
  ts: 3,
  type: "done",
  status: "done",
  exitCode: 0,
} as const satisfies SubagentEvent;

describe("interactive XState coordinator", () => {
  it("commits typed reducer transitions through the actor", () => {
    const actor = createInteractiveStateActor(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
    );

    const transition = advanceInteractiveStateActor(actor, {
      type: "artifact",
      event: legacyDone,
    });

    expect(transition.kind).toBe("applied");
    expect(actor.getSnapshot()).toMatchObject({
      status: "active",
      context: {
        state: { phase: "completed", protocol: "legacy", outcome: "done" },
        lastTransition: { kind: "applied" },
      },
    });
    expect(projectInteractiveStatus(actor.getSnapshot().context.state)).toBe(
      "idle",
    );
    actor.stop();
  });

  it("runs durable effects before commit and preserves state on failure", () => {
    const actor = createInteractiveStateActor(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
    );
    let phaseDuringEffect: string | undefined;

    advanceInteractiveStateActor(
      actor,
      { type: "artifact", event: legacyDone },
      (candidate) => {
        phaseDuringEffect = actor.getSnapshot().context.state.phase;
        expect(candidate.state.phase).toBe("completed");
      },
    );

    expect(phaseDuringEffect).toBe("running");
    const committed = actor.getSnapshot().context;
    expect(() =>
      advanceInteractiveStateActor(
        actor,
        { type: "followup_started", turnId: "turn-2" },
        () => {
          throw new Error("checkpoint failed");
        },
      ),
    ).toThrow("checkpoint failed");
    expect(actor.getSnapshot().context).toBe(committed);
    expect(actor.getSnapshot().context.state.phase).toBe("completed");
    actor.stop();
  });

  it("rejects a stale outer commit after a reentrant transition", () => {
    const actor = createInteractiveStateActor(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
    );

    expect(() =>
      advanceInteractiveStateActor(
        actor,
        { type: "artifact", event: legacyDone },
        () => {
          advanceInteractiveStateActor(actor, { type: "parent_cancelled" });
        },
      ),
    ).toThrow("interactive actor changed before transition commit");
    expect(actor.getSnapshot().context.state.phase).toBe("cancelled");
    expect(actor.getSnapshot().context.lastTransition?.kind).toBe("applied");
    actor.stop();
  });

  it("rejects a stopped actor before running a durable effect", () => {
    const actor = createInteractiveStateActor(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
    );
    let effectRan = false;
    actor.stop();

    expect(() =>
      advanceInteractiveStateActor(
        actor,
        { type: "artifact", event: legacyDone },
        () => {
          effectRan = true;
        },
      ),
    ).toThrow("interactive actor is not active");
    expect(effectRan).toBe(false);
  });

  it("round-trips a JSON persisted actor snapshot and continues", () => {
    const initial = initialInteractiveMachineState({ pane: { kind: "alive" } });
    const actor = createInteractiveStateActor(initial);
    advanceInteractiveStateActor(actor, {
      type: "artifact",
      event: legacyDone,
    });
    const parsed: unknown = JSON.parse(
      JSON.stringify(actor.getPersistedSnapshot()),
    );
    actor.stop();

    const restored = createInteractiveStateActor(
      initial,
      parsed as Snapshot<unknown>,
    );
    expect(restored.getSnapshot().context.state).toMatchObject({
      phase: "completed",
      pane: { kind: "alive" },
    });

    const followup = advanceInteractiveStateActor(restored, {
      type: "followup_started",
      turnId: "turn-2",
    });
    expect(followup.kind).toBe("applied");
    expect(restored.getSnapshot().context.state.phase).toBe("running");
    restored.stop();
  });

  it("records unchanged, stale, and invalid reducer outcomes", () => {
    const actor = createInteractiveStateActor(
      initialInteractiveMachineState({ pane: { kind: "alive" } }),
    );
    advanceInteractiveStateActor(actor, { type: "pane_observation_started" });

    const unchanged = advanceInteractiveStateActor(actor, {
      type: "pane_observed",
      revision: 1,
      liveness: { kind: "alive" },
    });
    expect(unchanged.kind).toBe("unchanged");
    expect(actor.getSnapshot().context.lastTransition?.kind).toBe("unchanged");

    const stale = advanceInteractiveStateActor(actor, {
      type: "pane_observed",
      revision: 0,
      liveness: { kind: "dead" },
    });
    expect(stale.kind).toBe("stale");
    expect(actor.getSnapshot().context.lastTransition?.kind).toBe("stale");

    const invalid = advanceInteractiveStateActor(actor, {
      type: "followup_started",
    });
    expect(invalid.kind).toBe("invalid");
    expect(actor.getSnapshot().context.lastTransition?.kind).toBe("invalid");
    actor.stop();
  });
});
