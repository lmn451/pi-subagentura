import type { OutputSnapshotError, SubagentEvent } from "./artifact";
import type { TelemetryResultReadOutcome } from "./telemetry";

export interface SelectedCompletion {
  turnId: string;
  outcome: "done" | "error" | "cancelled";
  terminalTs: number;
}

export interface ReadCompletionSelection {
  completion: SelectedCompletion | undefined;
  lifecycleEvent: SubagentEvent | null;
  processExitEvent: SubagentEvent | null;
  artifactClosed: boolean;
}

export type ArtifactReadRequest =
  | { kind: "metadata" }
  | { kind: "latest" }
  | { kind: "turn"; turnId: string };

export function artifactReadRequest(params: {
  includeOutput?: boolean;
  turnId?: string;
}): ArtifactReadRequest {
  if (params.turnId !== undefined)
    return { kind: "turn", turnId: params.turnId };
  return { kind: params.includeOutput === false ? "metadata" : "latest" };
}

export type ArtifactReadSource =
  | { kind: "not_requested" }
  | { kind: "snapshot"; turnId: string }
  | { kind: "staging" }
  | { kind: "unavailable" };

interface ArtifactReadPlanContext {
  readonly selection: ReadCompletionSelection;
  readonly terminalEvent: SubagentEvent | null;
}

export type MetadataReadPlan = ArtifactReadPlanContext & {
  readonly request: { kind: "metadata" };
  readonly source: { kind: "not_requested" };
};

export type TurnReadPlan = ArtifactReadPlanContext & {
  readonly request: { kind: "turn"; turnId: string };
  readonly source: { kind: "snapshot"; turnId: string };
};

export type LatestReadPlan = ArtifactReadPlanContext & {
  readonly request: { kind: "latest" };
  readonly source: Exclude<ArtifactReadSource, { kind: "not_requested" }>;
};

export type OutputReadPlan = TurnReadPlan | LatestReadPlan;

export type ArtifactReadPlan = MetadataReadPlan | OutputReadPlan;

export function isMetadataReadPlan(
  plan: ArtifactReadPlan,
): plan is MetadataReadPlan {
  return plan.request.kind === "metadata";
}

export type ArtifactReadValue =
  | { kind: "not_read" }
  | { kind: "missing" }
  | { kind: "content"; content: string }
  | { kind: "error"; error: OutputSnapshotError };

export type ArtifactReadOutput =
  | { kind: "not_requested" }
  | { kind: "pending" | "missing" | "unavailable" }
  | { kind: "read_error"; error: OutputSnapshotError }
  | { kind: "empty"; content: "" }
  | { kind: "available"; content: string };

export type ArtifactOutputState =
  | "not_requested"
  | "pending"
  | "missing"
  | "empty"
  | "available"
  | "unavailable";

interface ArtifactReadResultContext {
  readonly status: "running" | "done" | "error" | "cancelled" | "not_found";
  readonly turnId: string | undefined;
}

export type MetadataReadResult = ArtifactReadResultContext & {
  readonly plan: MetadataReadPlan;
  readonly output: { kind: "not_requested" };
};

export type OutputReadResult = ArtifactReadResultContext & {
  readonly plan: OutputReadPlan;
  readonly output: Exclude<ArtifactReadOutput, { kind: "not_requested" }>;
};

export type ArtifactReadResult = MetadataReadResult | OutputReadResult;

function assertNever(value: never): never {
  throw new Error(`Unexpected artifact read variant: ${String(value)}`);
}

function isSettled(event: SubagentEvent): boolean {
  switch (event.type) {
    case "completion":
    case "process_exited":
      return true;
    case "turn_started":
    case "tool_activity":
      return false;
    default:
      return assertNever(event);
  }
}

export function completionForRead(
  allEvents: readonly SubagentEvent[],
  selector: { turnId?: string },
): ReadCompletionSelection {
  if (selector.turnId !== undefined) {
    let selected: Extract<SubagentEvent, { type: "completion" }> | undefined;
    let artifactClosed = false;
    for (const event of allEvents) {
      if (event.type === "process_exited") artifactClosed = true;
      if (
        selected === undefined &&
        event.type === "completion" &&
        event.turnId === selector.turnId
      ) {
        selected = event;
      }
    }
    return {
      completion: selected ? selectedCompletion(selected) : undefined,
      lifecycleEvent: selected ?? null,
      processExitEvent: null,
      artifactClosed,
    };
  }

  let activeTurnId: string | undefined;
  let activeCompletion:
    | Extract<SubagentEvent, { type: "completion" }>
    | undefined;
  let activeLifecycle: SubagentEvent | null = null;
  let unscopedCompletion:
    | Extract<SubagentEvent, { type: "completion" }>
    | undefined;
  let unscopedLifecycle: SubagentEvent | null = null;
  let processExitEvent: SubagentEvent | null = null;
  let artifactClosed = false;
  for (const event of allEvents) {
    if (event.type === "turn_started") {
      activeTurnId = event.turnId;
      activeCompletion = undefined;
      activeLifecycle = event;
    } else if (event.type === "process_exited") {
      processExitEvent = event;
      artifactClosed = true;
    } else if (event.type === "completion") {
      if (activeTurnId === undefined) {
        unscopedCompletion = event;
        unscopedLifecycle = event;
      } else if (event.turnId === activeTurnId) {
        activeCompletion = event;
        activeLifecycle = event;
      }
    } else if (activeTurnId === undefined) {
      unscopedLifecycle = event;
    } else if (
      event.turnId === activeTurnId &&
      activeCompletion === undefined
    ) {
      activeLifecycle = event;
    }
  }
  const selected =
    activeTurnId === undefined ? unscopedCompletion : activeCompletion;
  return {
    completion: selected ? selectedCompletion(selected) : undefined,
    lifecycleEvent:
      activeTurnId === undefined ? unscopedLifecycle : activeLifecycle,
    processExitEvent,
    artifactClosed,
  };
}

function selectedCompletion(
  event: Extract<SubagentEvent, { type: "completion" }>,
): SelectedCompletion {
  return { turnId: event.turnId, outcome: event.outcome, terminalTs: event.ts };
}

function latestOutputSource(
  selection: ReadCompletionSelection,
): Exclude<ArtifactReadSource, { kind: "not_requested" }> {
  if (selection.completion) {
    return { kind: "snapshot", turnId: selection.completion.turnId };
  }
  const lifecycle = selection.lifecycleEvent;
  if (lifecycle && !selection.processExitEvent && !isSettled(lifecycle)) {
    return { kind: "staging" };
  }
  return { kind: "unavailable" };
}

function resolveReadStatus(
  plan: ArtifactReadPlan,
  output: ArtifactReadOutput,
  unmatchedClosedTurn: boolean,
): ArtifactReadResult["status"] {
  if (output.kind === "read_error") return "error";
  if (unmatchedClosedTurn) return "not_found";
  return (
    plan.selection.completion?.outcome ??
    plan.terminalEvent?.status ??
    "running"
  );
}

export function planArtifactRead(
  events: readonly SubagentEvent[],
  request: { kind: "metadata" },
): MetadataReadPlan;
export function planArtifactRead(
  events: readonly SubagentEvent[],
  request: { kind: "turn"; turnId: string },
): TurnReadPlan;
export function planArtifactRead(
  events: readonly SubagentEvent[],
  request: { kind: "latest" },
): LatestReadPlan;
export function planArtifactRead(
  events: readonly SubagentEvent[],
  request: ArtifactReadRequest,
): ArtifactReadPlan;
export function planArtifactRead(
  events: readonly SubagentEvent[],
  request: ArtifactReadRequest,
): ArtifactReadPlan {
  const selection = completionForRead(
    events,
    request.kind === "turn" ? { turnId: request.turnId } : {},
  );
  const lifecycle = selection.lifecycleEvent;
  const terminalEvent =
    selection.processExitEvent ??
    (lifecycle && isSettled(lifecycle) ? lifecycle : null);
  const context = { selection, terminalEvent };
  switch (request.kind) {
    case "metadata":
      return { ...context, request, source: { kind: "not_requested" } };
    case "turn":
      return {
        ...context,
        request,
        source: { kind: "snapshot", turnId: request.turnId },
      };
    case "latest":
      return { ...context, request, source: latestOutputSource(selection) };
    default:
      return assertNever(request);
  }
}

function resolveOutput(
  plan: OutputReadPlan,
  value: ArtifactReadValue,
): OutputReadResult["output"] {
  switch (value.kind) {
    case "error":
      return { kind: "read_error", error: value.error };
    case "content":
      return value.content.length === 0
        ? { kind: "empty", content: "" }
        : { kind: "available", content: value.content };
    case "not_read":
    case "missing":
      if (plan.selection.completion || plan.terminalEvent)
        return { kind: "missing" };
      return {
        kind: plan.selection.artifactClosed ? "unavailable" : "pending",
      };
    default:
      return assertNever(value);
  }
}

export function resolveArtifactRead(
  plan: MetadataReadPlan,
  value: { kind: "not_read" },
): MetadataReadResult;
export function resolveArtifactRead(
  plan: OutputReadPlan,
  value: ArtifactReadValue,
): OutputReadResult;
export function resolveArtifactRead(
  plan: ArtifactReadPlan,
  value: { kind: "not_read" },
): ArtifactReadResult;
export function resolveArtifactRead(
  plan: ArtifactReadPlan,
  value: ArtifactReadValue,
): ArtifactReadResult {
  const completion = plan.selection.completion;
  const unmatchedClosedTurn =
    plan.request.kind === "turn" &&
    plan.selection.artifactClosed &&
    completion === undefined;
  const turnId =
    plan.request.kind === "turn"
      ? plan.request.turnId
      : (completion?.turnId ?? plan.selection.lifecycleEvent?.turnId);
  if (isMetadataReadPlan(plan)) {
    const output = { kind: "not_requested" } as const;
    const status = resolveReadStatus(plan, output, false);
    return { plan, output, status, turnId };
  }
  const output = resolveOutput(plan, value);
  const status = resolveReadStatus(plan, output, unmatchedClosedTurn);
  return { plan, output, status, turnId };
}

export function artifactOutputState(
  output: ArtifactReadOutput,
): ArtifactOutputState {
  switch (output.kind) {
    case "read_error":
      return "unavailable";
    case "not_requested":
    case "pending":
    case "missing":
    case "empty":
    case "available":
    case "unavailable":
      return output.kind;
    default:
      return assertNever(output);
  }
}

export function artifactOutputContent(
  output: ArtifactReadOutput,
): string | null {
  switch (output.kind) {
    case "empty":
    case "available":
      return output.content;
    case "not_requested":
    case "pending":
    case "missing":
    case "unavailable":
    case "read_error":
      return null;
    default:
      return assertNever(output);
  }
}

export type ArtifactConsumption =
  | "not_applicable"
  | "consumed"
  | "already_consumed";

export function consumableArtifactCompletion(
  result: ArtifactReadResult,
): SelectedCompletion | undefined {
  return result.output.kind === "empty" || result.output.kind === "available"
    ? result.plan.selection.completion
    : undefined;
}

export function artifactReadOutcome(
  result: ArtifactReadResult,
  consumption: ArtifactConsumption,
): TelemetryResultReadOutcome {
  const { output, plan } = result;
  const completion = plan.selection.completion;
  const lastEvent =
    plan.selection.processExitEvent ?? plan.selection.lifecycleEvent;
  if (output.kind === "read_error") return "error";
  if (completion?.outcome === "error") return "error";
  if (completion?.outcome === "cancelled") return "cancelled";
  if (output.kind === "not_requested") {
    if (completion) return "unavailable";
    return !lastEvent || !isSettled(lastEvent) ? "running" : "unavailable";
  }
  if (artifactOutputContent(output) === null) {
    return lastEvent && !isSettled(lastEvent) ? "running" : "unavailable";
  }
  if (output.kind === "empty") return "empty";
  switch (consumption) {
    case "consumed":
    case "already_consumed":
      return consumption;
    case "not_applicable":
      return "running";
    default:
      return assertNever(consumption);
  }
}
