import { createActor, fromTransition, type Actor, type Snapshot } from "xstate";

import {
  transitionInteractiveMachine,
  type InteractiveMachineEvent,
  type InteractiveMachineState,
  type InteractiveMachineTransition,
} from "./interactive-state";

export interface InteractiveStateActorContext {
  readonly state: InteractiveMachineState;
  readonly lastTransition: InteractiveMachineTransition | null;
}

export interface InteractiveStateActorInput {
  readonly state: InteractiveMachineState;
}

export type InteractiveStateActorEvent =
  | {
      readonly type: "transition_applied";
      readonly transition: Extract<
        InteractiveMachineTransition,
        { readonly kind: "applied" }
      >;
    }
  | {
      readonly type: "transition_unchanged";
      readonly transition: Extract<
        InteractiveMachineTransition,
        { readonly kind: "unchanged" }
      >;
    }
  | {
      readonly type: "transition_stale";
      readonly transition: Extract<
        InteractiveMachineTransition,
        { readonly kind: "stale" }
      >;
    }
  | {
      readonly type: "transition_invalid";
      readonly transition: Extract<
        InteractiveMachineTransition,
        { readonly kind: "invalid" }
      >;
    }
  | { readonly type: "xstate.stop" };

function assertNever(value: never): never {
  throw new Error(`Unexpected interactive actor variant: ${String(value)}`);
}

function actorEventForTransition(
  transition: InteractiveMachineTransition,
): InteractiveStateActorEvent {
  switch (transition.kind) {
    case "applied":
      return { type: "transition_applied", transition };
    case "unchanged":
      return { type: "transition_unchanged", transition };
    case "stale":
      return { type: "transition_stale", transition };
    case "invalid":
      return { type: "transition_invalid", transition };
    default:
      return assertNever(transition);
  }
}

export const interactiveStateActorLogic = fromTransition(
  (
    _context: InteractiveStateActorContext,
    event: InteractiveStateActorEvent,
  ): InteractiveStateActorContext => {
    switch (event.type) {
      case "transition_applied":
      case "transition_unchanged":
      case "transition_stale":
      case "transition_invalid":
        return {
          state: event.transition.state,
          lastTransition: event.transition,
        };
      case "xstate.stop":
        return _context;
      default:
        return assertNever(event);
    }
  },
  ({
    input,
  }: {
    readonly input: InteractiveStateActorInput;
  }): InteractiveStateActorContext => ({
    state: input.state,
    lastTransition: null,
  }),
);

export type InteractiveStateActor = Actor<typeof interactiveStateActorLogic>;

const inactiveInteractiveStateActors = new WeakSet<InteractiveStateActor>();

export function createInteractiveStateActor(
  state: InteractiveMachineState,
  persistedSnapshot?: Snapshot<unknown>,
): InteractiveStateActor {
  const actor = persistedSnapshot
    ? createActor(interactiveStateActorLogic, {
        input: { state },
        snapshot: persistedSnapshot,
      })
    : createActor(interactiveStateActorLogic, { input: { state } });
  actor.subscribe({
    complete: () => {
      inactiveInteractiveStateActors.add(actor);
    },
    error: () => {
      inactiveInteractiveStateActors.add(actor);
    },
  });
  actor.start();
  return actor;
}

export function advanceInteractiveStateActor(
  actor: InteractiveStateActor,
  event: InteractiveMachineEvent,
  beforeCommit?: (transition: InteractiveMachineTransition) => void,
): InteractiveMachineTransition {
  const before = actor.getSnapshot();
  if (inactiveInteractiveStateActors.has(actor) || before.status !== "active") {
    throw new Error("interactive actor is not active");
  }
  const previous = before.context.state;
  const transition = transitionInteractiveMachine(previous, event);
  beforeCommit?.(transition);
  const afterEffect = actor.getSnapshot();
  if (
    inactiveInteractiveStateActors.has(actor) ||
    afterEffect.status !== "active" ||
    afterEffect.context.state !== previous
  ) {
    throw new Error("interactive actor changed before transition commit");
  }
  actor.send(actorEventForTransition(transition));
  if (actor.getSnapshot().context.lastTransition !== transition) {
    throw new Error("interactive actor did not commit transition");
  }
  return transition;
}
