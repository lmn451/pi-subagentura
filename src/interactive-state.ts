import type { PersistedLifecycleFold, SubagentEvent } from "./artifact";

export type PaneLiveness =
  | { readonly kind: "alive" }
  | { readonly kind: "dead" }
  | { readonly kind: "unavailable"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly reason?: string };

type InteractiveMachineBase = {
  readonly lifecycle: Readonly<PersistedLifecycleFold>;
  readonly pane: PaneLiveness;
  readonly observationRevision: number;
};

export type InteractiveMachineState =
  | (InteractiveMachineBase & { readonly phase: "running" })
  | (InteractiveMachineBase & {
      readonly phase: "completed";
      readonly protocol: "legacy" | "v2";
      readonly outcome: "done" | "error";
    })
  | (InteractiveMachineBase & {
      readonly phase: "cancelled";
      readonly source: "parent" | "artifact" | "process";
    })
  | (InteractiveMachineBase & {
      readonly phase: "process_exited";
      readonly status: "done" | "error";
      readonly exitCode?: number;
    });

export type InteractiveMachineEvent =
  | { readonly type: "artifact"; readonly event: SubagentEvent }
  | { readonly type: "parent_cancelled" }
  | { readonly type: "followup_started"; readonly turnId?: string }
  | { readonly type: "pane_observation_started" }
  | {
      readonly type: "pane_observed";
      readonly revision: number;
      readonly liveness: PaneLiveness;
    };

export type InteractiveMachineTransition =
  | {
      readonly kind: "applied";
      readonly previous: InteractiveMachineState;
      readonly state: InteractiveMachineState;
    }
  | { readonly kind: "unchanged"; readonly state: InteractiveMachineState }
  | {
      readonly kind: "stale";
      readonly state: InteractiveMachineState;
      readonly expectedRevision: number;
      readonly receivedRevision: number;
    }
  | {
      readonly kind: "invalid";
      readonly state: InteractiveMachineState;
      readonly reason: string;
    };

export type InteractiveProjectedStatus =
  "running" | "idle" | "cancelled" | "exited" | "unknown";

export interface InitialInteractiveMachineStateOptions {
  readonly lifecycle?: Readonly<PersistedLifecycleFold>;
  readonly pane?: PaneLiveness;
  readonly observationRevision?: number;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected interactive state variant: ${String(value)}`);
}

function copyLifecycle(
  lifecycle: Readonly<PersistedLifecycleFold>,
): PersistedLifecycleFold {
  return { ...lifecycle };
}

function classifyMachineState(
  lifecycle: Readonly<PersistedLifecycleFold>,
  pane: PaneLiveness,
  observationRevision: number,
): InteractiveMachineState {
  const base = { lifecycle, pane, observationRevision } as const;
  if (lifecycle.parentCancelled) {
    return { ...base, phase: "cancelled", source: "parent" };
  }
  if (lifecycle.processStatus) {
    if (lifecycle.processStatus === "cancelled") {
      return { ...base, phase: "cancelled", source: "process" };
    }
    return {
      ...base,
      phase: "process_exited",
      status: lifecycle.processStatus,
      ...(lifecycle.processExitCode === undefined
        ? {}
        : { exitCode: lifecycle.processExitCode }),
    };
  }
  if (lifecycle.completionOutcome) {
    if (lifecycle.completionOutcome === "cancelled") {
      return {
        ...base,
        phase: "cancelled",
        source: lifecycle.completionSource === "parent" ? "parent" : "artifact",
      };
    }
    return {
      ...base,
      phase: "completed",
      protocol: "v2",
      outcome: lifecycle.completionOutcome,
    };
  }
  if (lifecycle.legacyTerminal) {
    if (lifecycle.legacyTerminal === "cancelled") {
      return { ...base, phase: "cancelled", source: "artifact" };
    }
    return {
      ...base,
      phase: "completed",
      protocol: "legacy",
      outcome: lifecycle.legacyTerminal,
    };
  }
  return { ...base, phase: "running" };
}

export function initialInteractiveMachineState(
  options: InitialInteractiveMachineStateOptions = {},
): InteractiveMachineState {
  const lifecycle = copyLifecycle(options.lifecycle ?? {});
  const pane = options.pane ?? { kind: "unknown" };
  const observationRevision = options.observationRevision ?? 0;
  return classifyMachineState(lifecycle, pane, observationRevision);
}

function foldArtifactEvent(
  previous: Readonly<PersistedLifecycleFold>,
  event: SubagentEvent,
): PersistedLifecycleFold {
  const lifecycle = copyLifecycle(previous);
  lifecycle.startedAt ??= event.ts;
  switch (event.type) {
    case "process_exited":
      lifecycle.processStatus = event.status;
      lifecycle.processExitCode = event.exitCode;
      return lifecycle;
    case "turn_started":
      lifecycle.currentTurnId = event.turnId;
      lifecycle.completionTurnId = undefined;
      lifecycle.completionOutcome = undefined;
      lifecycle.completionSource = undefined;
      lifecycle.completionExitCode = undefined;
      lifecycle.legacyTerminal = undefined;
      return lifecycle;
    case "completion":
      if (event.outcome === "cancelled" && event.source === "parent") {
        lifecycle.parentCancelled = true;
      }
      if (
        !lifecycle.currentTurnId ||
        event.turnId === lifecycle.currentTurnId
      ) {
        lifecycle.completionTurnId = event.turnId;
        lifecycle.completionOutcome = event.outcome;
        lifecycle.completionSource = event.source;
        lifecycle.completionExitCode = event.exitCode;
      }
      return lifecycle;
    case "started":
      lifecycle.legacyTerminal = undefined;
      return lifecycle;
    case "done":
    case "error":
    case "cancelled":
      lifecycle.legacyTerminal = event.status;
      lifecycle.completionExitCode =
        "exitCode" in event ? event.exitCode : undefined;
      return lifecycle;
    case "tool_activity":
      return lifecycle;
    default:
      return assertNever(event);
  }
}

function applied(
  previous: InteractiveMachineState,
  state: InteractiveMachineState,
): InteractiveMachineTransition {
  return { kind: "applied", previous, state };
}

function withLifecycle(
  state: InteractiveMachineState,
  lifecycle: Readonly<PersistedLifecycleFold>,
): InteractiveMachineState {
  return classifyMachineState(lifecycle, state.pane, state.observationRevision);
}

export function transitionInteractiveMachine(
  state: InteractiveMachineState,
  event: InteractiveMachineEvent,
): InteractiveMachineTransition {
  switch (event.type) {
    case "artifact": {
      const lifecycle = foldArtifactEvent(state.lifecycle, event.event);
      return applied(state, withLifecycle(state, lifecycle));
    }
    case "parent_cancelled": {
      if (state.lifecycle.parentCancelled) return { kind: "unchanged", state };
      const lifecycle = copyLifecycle(state.lifecycle);
      lifecycle.parentCancelled = true;
      return applied(state, withLifecycle(state, lifecycle));
    }
    case "followup_started": {
      const reusableCompletion =
        state.phase === "completed" &&
        state.pane.kind === "alive" &&
        !(state.protocol === "legacy" && state.outcome === "error");
      if (!reusableCompletion) {
        return {
          kind: "invalid",
          state,
          reason:
            "only a completed interactive process with a live pane can start a follow-up turn",
        };
      }
      const lifecycle = copyLifecycle(state.lifecycle);
      lifecycle.currentTurnId = event.turnId;
      lifecycle.completionTurnId = undefined;
      lifecycle.completionOutcome = undefined;
      lifecycle.completionSource = undefined;
      lifecycle.completionExitCode = undefined;
      lifecycle.legacyTerminal = undefined;
      return applied(state, withLifecycle(state, lifecycle));
    }
    case "pane_observation_started": {
      const next = classifyMachineState(
        state.lifecycle,
        state.pane,
        state.observationRevision + 1,
      );
      return applied(state, next);
    }
    case "pane_observed": {
      if (event.revision !== state.observationRevision) {
        return {
          kind: "stale",
          state,
          expectedRevision: state.observationRevision,
          receivedRevision: event.revision,
        };
      }
      if (state.pane.kind === "dead" && event.liveness.kind !== "dead") {
        return {
          kind: "invalid",
          state,
          reason: "a confirmed-dead pane identity cannot become live again",
        };
      }
      if (event.liveness.kind === state.pane.kind) {
        return { kind: "unchanged", state };
      }
      return applied(
        state,
        classifyMachineState(
          state.lifecycle,
          event.liveness,
          state.observationRevision,
        ),
      );
    }
    default: {
      const unexpected: never = event;
      return {
        kind: "invalid",
        state,
        reason: `unknown interactive transition: ${String(unexpected)}`,
      };
    }
  }
}

function projectPaneDependentStatus(
  pane: PaneLiveness,
  whenAlive: "running" | "idle",
): InteractiveProjectedStatus {
  switch (pane.kind) {
    case "alive":
      return whenAlive;
    case "dead":
    case "unavailable":
    case "unknown":
      return "unknown";
    default:
      return assertNever(pane);
  }
}

export function projectInteractiveStatus(
  state: InteractiveMachineState,
): InteractiveProjectedStatus {
  switch (state.phase) {
    case "cancelled":
      return "cancelled";
    case "process_exited":
      return "exited";
    case "completed":
      if (state.protocol === "legacy" && state.outcome === "error") {
        return "exited";
      }
      if (state.pane.kind === "dead") return "exited";
      return projectPaneDependentStatus(state.pane, "idle");
    case "running":
      return projectPaneDependentStatus(state.pane, "running");
    default:
      return assertNever(state);
  }
}
