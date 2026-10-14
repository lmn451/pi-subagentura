/**
 * Artifact polling and durable completion enqueue.
 *
 * Extracted from src/subagent.ts to keep the extension entry point focused on tool
 * registration and lifecycle management. This module owns the poll interval's per-tick
 * work: walking the artifact directory of every running interactive sub-agent and
 * enqueueing protocol completions for trigger-aware delivery.
 *
 * See src/subagent.ts for the interval setup / teardown and the rehydrate logic.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  artifactPath,
  assertNever,
  isCompletionEvent,
  readEventBatch,
  removeInteractiveState,
  updateInteractiveStates,
  type CompletionEvent,
  type CompletionOutcome,
  type EventReadIssue,
  type SubagentEvent,
  type InteractiveSubagentPersistedStateV2,
} from "./artifact";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  foldInteractiveLifecycle,
  getInteractivePaneLivenessDiagnosticAsync,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { PaneLivenessFailureReason } from "./multiplexer-contracts";
import { isOrchestratorMode, isOrchestratorV2Enabled } from "./completion-turn";
import { shouldNotify } from "./notifications";
import {
  deliveryIdFor,
  enqueueDelivery,
  flushDeliveries,
  MAX_DELIVERY_RECORDS,
} from "./delivery";
import { completionDisplayLabel } from "./completion-presentation";
import { debugLog, type JobState } from "./helpers";
import {
  coarseElapsedMs,
  formatActivityRow,
  ResponsiveFlowComponent,
} from "./rendering";
import {
  addWorkflowUsage,
  formatWorkflowUsage,
  hasWorkflowUsage,
  presentWorkflowUsage,
  type WorkflowUsage,
  zeroWorkflowUsage,
} from "./workflow-core";

import { basename, dirname } from "node:path";
import {
  getRunningWorkflowCount,
  workflowJobBelongsToOwner,
  workflowJobRegistry,
} from "./workflow-jobs";
import {
  type SessionOwnerToken,
  resolveLiveSessionScope,
} from "./session-scope";
import { isAgentListHidden } from "./settings";
import {
  captureTelemetry,
  type TelemetryErrorCategory,
  type TelemetryErrorStage,
  type TelemetryRuntimeFailureKind,
  type TelemetrySession,
  type TelemetryTerminalReason,
} from "./telemetry";
// ── Footer / Widget Status Keys ────────────────────────────────────────

export const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";
const WORKFLOW_FOOTER_KEY = "subagentura-workflows";
const WORKFLOW_WIDGET_KEY = "subagentura-workflow-activity";

/** Maximum widget rows before truncation with "… and N more". */
const MAX_WIDGET_ROWS = 10;
const MAX_WORKFLOW_WIDGET_ROWS = 5;
const MAX_WORKFLOW_FOOTER_TAGS = 4;
type StatusUi = Pick<ExtensionUIContext, "setStatus">;
interface WidgetSurfaceState {
  contributions: Map<string, string[]>;
  rendered: string[] | undefined;
  painted: boolean;
}
interface SubagentFooterContribution {
  kind: "subagent";
  count: number;
  workingCount: number;
  footerLabel?: string;
}
interface WorkflowFooterContribution {
  kind: "workflow";
  count: number;
  footerLabel?: string;
  usage?: WorkflowUsage;
}
type FooterContribution =
  | SubagentFooterContribution
  | WorkflowFooterContribution;
interface FooterSurfaceState {
  contributions: Map<string, FooterContribution>;
  rendered: string | undefined;
  painted: boolean;
}
const widgetRowsByUi = new WeakMap<
  ExtensionUIContext,
  Map<string, WidgetSurfaceState>
>();
const footerStatusesByUi = new WeakMap<
  StatusUi,
  Map<string, FooterSurfaceState>
>();

function interactiveStatesForOwners(
  owners: (SessionOwnerToken | undefined)[],
): InteractiveSubagentState[] {
  if (owners.some((owner) => owner === undefined)) return [];
  const states: InteractiveSubagentState[] = [];
  for (const owner of owners) {
    const scope = resolveLiveSessionScope(owner);
    if (scope) states.push(...scope.interactiveStates.values());
  }
  return states;
}

function inProcessJobsForOwners(
  owners: (SessionOwnerToken | undefined)[],
): JobState[] {
  if (owners.some((owner) => owner === undefined)) return [];
  const jobs: JobState[] = [];
  for (const owner of owners) {
    const scope = resolveLiveSessionScope(owner);
    if (scope) jobs.push(...scope.inProcessJobs.values());
  }
  return jobs;
}

function getRunningSubagentCount(
  owners: (SessionOwnerToken | undefined)[],
): number {
  const inProcessCount = inProcessJobsForOwners(owners).filter(
    (job) => job.status === "running",
  ).length;
  const interactiveCount = interactiveStatesForOwners(owners).filter(
    (state) =>
      state.status === "running" ||
      state.status === "idle" ||
      state.status === "unknown",
  ).length;
  return inProcessCount + interactiveCount;
}

/**
 * Count active execution rows, not containers. Workflow-owned children already
 * live in exactly one child registry, so counting workflow jobs/snapshots here
 * would count the same work twice.
 */
function getWorkingSubagentCount(
  owners: (SessionOwnerToken | undefined)[],
): number {
  const inProcessCount = inProcessJobsForOwners(owners).filter(
    (job) => job.status === "running",
  ).length;
  const interactiveCount = interactiveStatesForOwners(owners).filter(
    (state) => state.status === "running",
  ).length;
  return inProcessCount + interactiveCount;
}

function addAggregateWorkflowUsage(
  total: WorkflowUsage,
  usage: WorkflowUsage | undefined,
): WorkflowUsage {
  if (!usage) return total;
  return addWorkflowUsage(total, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.costUsd,
    costSource: usage.costSource,
    turns: usage.turns,
  });
}

function mergeFooterContributions(
  key: string,
  contributions: Iterable<FooterContribution>,
): string | undefined {
  if (key === FOOTER_KEY) {
    let total = 0;
    let totalWorking = 0;
    let footerLabel: string | undefined;
    for (const contribution of contributions) {
      if (contribution.kind !== "subagent") continue;
      total += contribution.count;
      totalWorking += contribution.workingCount;
      footerLabel ??= contribution.footerLabel;
    }
    if (total === 0) return footerLabel;
    const working = totalWorking > 0 ? ` · ${totalWorking} working` : "";
    const label = footerLabel ? ` · ${footerLabel}` : "";
    return `⚡ ${total} sub-agent${total > 1 ? "s" : ""} alive${working}${label}`;
  }
  if (key === WORKFLOW_FOOTER_KEY) {
    let total = 0;
    let footerLabel: string | undefined;
    let usage = zeroWorkflowUsage();
    for (const contribution of contributions) {
      if (contribution.kind !== "workflow") continue;
      total += contribution.count;
      footerLabel ??= contribution.footerLabel;
      usage = addAggregateWorkflowUsage(usage, contribution.usage);
    }
    if (total === 0) return undefined;
    const presentedUsage = hasWorkflowUsage(usage)
      ? ` · ${formatWorkflowUsage(usage)}`
      : "";
    const label = footerLabel ? ` · ${footerLabel}` : "";
    return `⚡ ${total} workflow${total > 1 ? "s" : ""} running${presentedUsage}${label}`;
  }
  return undefined;
}

function updateFooterStatus(
  ui: StatusUi,
  key: string,
  contribution: FooterContribution | undefined,
  owner?: SessionOwnerToken,
): void {
  let surfaces = footerStatusesByUi.get(ui);
  if (!surfaces) {
    surfaces = new Map();
    footerStatusesByUi.set(ui, surfaces);
  }
  let surface = surfaces.get(key);
  if (!surface) {
    surface = { contributions: new Map(), rendered: undefined, painted: false };
    surfaces.set(key, surface);
  }
  const contributionKey = pollOwnerKey(owner);
  if (owner === undefined) surface.contributions.clear();
  else if (resolveLiveSessionScope(owner)) {
    surface.contributions.delete(pollOwnerKey(undefined));
    const ownerPrefix = `${owner.id}:`;
    for (const key of surface.contributions.keys()) {
      if (key.startsWith(ownerPrefix) && key !== contributionKey) {
        surface.contributions.delete(key);
      }
    }
  }
  if (contribution === undefined) surface.contributions.delete(contributionKey);
  else surface.contributions.set(contributionKey, contribution);
  const rendered = mergeFooterContributions(
    key,
    surface.contributions.values(),
  );
  if (surface.painted && surface.rendered === rendered) return;
  try {
    ui.setStatus(key, rendered);
    surface.rendered = rendered;
    surface.painted = true;
  } catch {
    /* ui stale */
  }
}

function orchestratorLabelForOwner(
  owner: SessionOwnerToken | undefined,
): string | undefined {
  const scope = resolveLiveSessionScope(owner);
  const context = scope?.spawnTreeContext;
  if (context?.role === "descendant") {
    if (context.orchestratorMode !== true) return undefined;
    const ownerId = context.parentAgentId ?? context.rootId;
    return `subagent of orchestrator ${ownerId}`;
  }
  if (!scope || !isOrchestratorMode(scope.pi)) return undefined;
  return isOrchestratorV2Enabled(scope.pi) ? "orchestratorv2" : "orchestrator";
}
function workflowTagForId(workflowId: string): string {
  const name = workflowJobRegistry.get(workflowId)?.name;
  return `workflow ${completionDisplayLabel(name, workflowId)}`;
}
function workflowTagsForOwner(owner: SessionOwnerToken | undefined): string[] {
  const workflowIds = new Set<string>();
  for (const job of inProcessJobsForOwners([owner])) {
    if (job.status === "running" && job.workflowId) {
      workflowIds.add(job.workflowId);
    }
  }
  for (const state of interactiveStatesForOwners([owner])) {
    if (
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown") &&
      state.workflowId
    ) {
      workflowIds.add(state.workflowId);
    }
  }
  const tags = [...workflowIds].sort().map(workflowTagForId);
  if (tags.length <= MAX_WORKFLOW_FOOTER_TAGS) return tags;
  const omitted = tags.length - MAX_WORKFLOW_FOOTER_TAGS;
  return [
    ...tags.slice(0, MAX_WORKFLOW_FOOTER_TAGS),
    `… and ${omitted} more workflows`,
  ];
}
function footerLabelsForOwner(
  owner: SessionOwnerToken | undefined,
): string | undefined {
  const labels = workflowTagsForOwner(owner);
  const orchestratorLabel = orchestratorLabelForOwner(owner);
  if (orchestratorLabel) labels.unshift(orchestratorLabel);
  return labels.length > 0 ? labels.join(" · ") : undefined;
}
/**
 * Repaint the "N sub-agents alive · N working" footer, scoped to `owner`.
 *
 * `alive` keeps the established liveness contract: running in-process jobs
 * plus running, idle, or unknown interactive panes. `working` is the strict
 * subset currently executing: running in-process jobs and running interactive
 * turns only. Idle/unknown/terminal rows and workflow containers are excluded.
 * A stale owner reads as zero instead of falling back to cross-session state.
 */
export function updateRunningSubagentFooter(
  ui: StatusUi,
  owner?: SessionOwnerToken,
): void {
  const ownerContext = resolveLiveSessionScope(owner);
  const staleOwner = owner !== undefined && !ownerContext;
  const runningCount = staleOwner ? 0 : getRunningSubagentCount([owner]);
  const workingCount = staleOwner ? 0 : getWorkingSubagentCount([owner]);
  const footerLabel = footerLabelsForOwner(owner);
  const contribution: SubagentFooterContribution | undefined =
    runningCount > 0 || footerLabel !== undefined
      ? {
          kind: "subagent",
          count: runningCount,
          workingCount,
          footerLabel,
        }
      : undefined;
  updateFooterStatus(ui, FOOTER_KEY, contribution, owner);
}

function widgetRowsEqual(
  previousRows: string[] | undefined,
  nextRows: string[] | undefined,
): boolean {
  if (previousRows === undefined || nextRows === undefined) {
    return previousRows === nextRows;
  }
  return (
    previousRows.length === nextRows.length &&
    previousRows.every((row, index) => row === nextRows[index])
  );
}

function updateWidgetRows(
  ui: ExtensionUIContext,
  key: string,
  rows: string[],
  owner?: SessionOwnerToken,
): void {
  let surfaces = widgetRowsByUi.get(ui);
  if (!surfaces) {
    surfaces = new Map();
    widgetRowsByUi.set(ui, surfaces);
  }
  let surface = surfaces.get(key);
  if (!surface) {
    surface = { contributions: new Map(), rendered: undefined, painted: false };
    surfaces.set(key, surface);
  }
  const contributionKey = pollOwnerKey(owner);
  if (owner === undefined) surface.contributions.clear();
  else if (resolveLiveSessionScope(owner)) {
    surface.contributions.delete(pollOwnerKey(undefined));
    const ownerPrefix = `${owner.id}:`;
    for (const key of surface.contributions.keys()) {
      if (key.startsWith(ownerPrefix) && key !== contributionKey) {
        surface.contributions.delete(key);
      }
    }
  }
  if (rows.length === 0) surface.contributions.delete(contributionKey);
  else surface.contributions.set(contributionKey, [...rows]);
  const renderedRows = [...surface.contributions.values()].flat();
  const rendered = renderedRows.length > 0 ? renderedRows : undefined;
  if (surface.painted && widgetRowsEqual(surface.rendered, rendered)) return;
  try {
    if (key === WIDGET_KEY && rendered) {
      ui.setWidget(key, () => new ResponsiveFlowComponent(rendered), {
        placement: "belowEditor",
      });
    } else {
      ui.setWidget(key, rendered, { placement: "belowEditor" });
    }
    surface.rendered = rendered ? [...rendered] : undefined;
    surface.painted = true;
  } catch {
    /* ui stale */
  }
}
/** Withdraw one ended generation from every shared UI surface. */
export function clearSessionScopeUiContributions(
  ui: ExtensionUIContext,
  owner: SessionOwnerToken,
): void {
  updateFooterStatus(ui, FOOTER_KEY, undefined, owner);
  updateFooterStatus(ui, WORKFLOW_FOOTER_KEY, undefined, owner);
  updateWidgetRows(ui, WIDGET_KEY, [], owner);
  updateWidgetRows(ui, WORKFLOW_WIDGET_KEY, [], owner);
}

/** Project current live rows from the exact owner scope after liveness processing. */
function projectActivityWidgetRows(
  ui: ExtensionUIContext | undefined,
  owner: SessionOwnerToken | undefined,
  now: number,
): string[] {
  if (!ui) return [];
  const owners = [owner];
  const states = interactiveStatesForOwners(owners).filter(
    (state) =>
      state.status === "running" ||
      state.status === "idle" ||
      state.status === "unknown",
  );
  return states.map((state) => formatActivityRow(state, now));
}

/** Derive delivery status from an authoritative protocol-v2 completion event. */
function deliveryStatusFromEvent(ev: CompletionEvent): CompletionOutcome {
  return ev.outcome;
}

function deliveryMessageFromEvent(ev: CompletionEvent): string | undefined {
  if (ev.errorMessage) return ev.errorMessage;
  if (ev.message) return ev.message;
  if (ev.outputError?.code === "output_too_large") {
    return `Output omitted: ${ev.outputError.bytes} bytes exceeds the ${ev.outputError.maxBytes}-byte snapshot limit.`;
  }
  return ev.outputError?.message;
}

function terminalReasonFromEvent(ev: SubagentEvent): TelemetryTerminalReason {
  switch (ev.type) {
    case "process_exited":
      return "process_exit";
    case "completion":
      if (ev.outcome === "done") return "completed";
      if (ev.outcome === "error") {
        return ev.source === "process_exit" ? "process_exit" : "agent_error";
      }
      if (ev.source === "explicit") return "explicit_cancel";
      if (ev.source === "process_exit") return "process_exit";
      if (ev.source === "parent") {
        if (ev.cancellationOrigin === "cancel_all") return "explicit_cancel";
        if (
          ev.cancellationLifecycleReason === "new" ||
          ev.cancellationLifecycleReason === "fork"
        ) {
          return "fresh_session";
        }
        if (
          ev.cancellationOrigin === "cancel_interactive_subagent" ||
          ev.cancellationOrigin === "cancel_subagent"
        ) {
          return "explicit_cancel";
        }
        if (
          ev.cancellationLifecycleReason === "startup" ||
          ev.cancellationLifecycleReason === "reload" ||
          ev.cancellationLifecycleReason === "resume" ||
          ev.cancellationLifecycleReason === "quit" ||
          ev.cancellationOrigin === "session_start" ||
          ev.cancellationOrigin === "session_shutdown"
        ) {
          return "session_shutdown";
        }
        return "parent_cancelled";
      }
      return "unknown";
    case "tool_activity":
    case "turn_started":
      return "unknown";
    default:
      return assertNever(ev);
  }
}

function errorCategoryFromEvent(
  event: SubagentEvent,
  status: CompletionOutcome,
  terminalReason: TelemetryTerminalReason,
): TelemetryErrorCategory | undefined {
  if (status !== "error") return undefined;
  if (terminalReason === "timeout") return "timeout";
  if (event.type === "process_exited" || terminalReason === "process_exit") {
    return "transport";
  }
  if (
    event.type === "completion" &&
    event.source === "agent_settled" &&
    event.agentStopReason === "error"
  ) {
    return "provider";
  }
  return "unknown";
}
function taskErrorStageFromEvent(
  event: SubagentEvent,
  status: CompletionOutcome,
  terminalReason: TelemetryTerminalReason,
): TelemetryErrorStage | undefined {
  if (status !== "error") return undefined;
  if (
    event.type === "completion" &&
    event.source === "agent_settled" &&
    event.agentStopReason === "error"
  ) {
    return "provider";
  }
  if (event.type === "process_exited" || terminalReason === "process_exit") {
    return "completion";
  }
  return "turn";
}

function taskAgentStopReason(
  event: SubagentEvent,
  status: CompletionOutcome,
): "error" | "aborted" | undefined {
  if (
    status === "error" &&
    event.type === "completion" &&
    event.source === "agent_settled"
  ) {
    return event.agentStopReason;
  }
  return undefined;
}

function taskExitCodeBucket(
  event: SubagentEvent,
): "zero" | "nonzero" | "unknown" | undefined {
  if (event.type !== "process_exited") return undefined;
  return Number.isSafeInteger(event.exitCode)
    ? event.exitCode === 0
      ? "zero"
      : "nonzero"
    : "unknown";
}

type ArtifactRuntimeFailureKind = Extract<
  TelemetryRuntimeFailureKind,
  | "artifact_unreadable"
  | "artifact_malformed"
  | "artifact_oversized"
  | "mux_probe"
>;

interface RuntimeFailureEpisodeState {
  active: Set<ArtifactRuntimeFailureKind>;
  sequence: Map<ArtifactRuntimeFailureKind, number>;
}

const runtimeFailureEpisodes = new Map<string, RuntimeFailureEpisodeState>();
const debuggedMuxProbeStates = new WeakSet<InteractiveSubagentState>();

function runtimeFailureKindForIssue(
  issue: EventReadIssue,
): ArtifactRuntimeFailureKind | undefined {
  switch (issue.kind) {
    case "artifact_unreadable":
      return "artifact_unreadable";
    case "artifact_malformed":
      return "artifact_malformed";
    case "record_too_large":
      return "artifact_oversized";
    default:
      return undefined;
  }
}

function runtimeFailureEpisodeState(
  artifactDir: string,
): RuntimeFailureEpisodeState {
  const existing = runtimeFailureEpisodes.get(artifactDir);
  if (existing) return existing;
  const created: RuntimeFailureEpisodeState = {
    active: new Set(),
    sequence: new Map(),
  };
  runtimeFailureEpisodes.set(artifactDir, created);
  return created;
}

function reportRuntimeFailure(
  state: InteractiveSubagentState,
  telemetry: TelemetrySession | undefined,
  kind: ArtifactRuntimeFailureKind,
  category: TelemetryErrorCategory,
  stage: TelemetryErrorStage,
  failureReason?: PaneLivenessFailureReason,
): void {
  if (kind === "mux_probe" && !debuggedMuxProbeStates.has(state)) {
    debuggedMuxProbeStates.add(state);
    debugLog("warn", "interactive_mux_probe_unknown", {
      mux: state.mux,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
  }
  if (
    !telemetry ||
    !state.telemetryEligible ||
    state.telemetryCorrelationId !== telemetry.correlationId
  ) {
    return;
  }
  const episode = runtimeFailureEpisodeState(state.artifactDir);
  if (episode.active.has(kind)) return;
  episode.active.add(kind);
  const sequence = (episode.sequence.get(kind) ?? 0) + 1;
  episode.sequence.set(kind, sequence);
  captureTelemetry(
    telemetry,
    {
      event: "runtime_failure",
      error_category: category,
      error_stage: stage,
      failure_kind: kind,
    },
    {
      dedupeKey: `runtime-failure:interactive:${state.id}:${kind}:${sequence}`,
    },
  );
}

function clearRuntimeFailureEpisode(
  state: InteractiveSubagentState,
  kind: ArtifactRuntimeFailureKind,
): void {
  const episode = runtimeFailureEpisodes.get(state.artifactDir);
  episode?.active.delete(kind);
  if (kind === "mux_probe") debuggedMuxProbeStates.delete(state);
}

function reportArtifactReadIssues(
  state: InteractiveSubagentState,
  telemetry: TelemetrySession | undefined,
  issues: readonly EventReadIssue[],
): void {
  const observedKinds = new Set<ArtifactRuntimeFailureKind>();
  for (const issue of issues) {
    const kind = runtimeFailureKindForIssue(issue);
    if (kind === undefined) continue;
    observedKinds.add(kind);
    reportRuntimeFailure(state, telemetry, kind, "artifact", "polling");
  }
  for (const kind of [
    "artifact_unreadable",
    "artifact_malformed",
    "artifact_oversized",
  ] as const) {
    if (!observedKinds.has(kind)) {
      clearRuntimeFailureEpisode(state, kind);
    }
  }
}

const pollsInFlight = new Map<string, Promise<void>>();
// ── Poller ─────────────────────────────────────────────────────────────

function pollOwnerKey(owner: SessionOwnerToken | undefined): string {
  return owner ? `${owner.id}:${owner.generation}` : "unscoped";
}

function persistPolledState(
  state: InteractiveSubagentState,
  entry: InteractiveSubagentPersistedStateV2,
): void {
  entry.eventByteCursor = state.eventByteCursor ?? 0;
  entry.activeTurnId = state.activeTurnId;
  entry.pendingDeliveries = state.pendingDeliveries ?? [];
  entry.deliveryReceipts = state.deliveryReceipts ?? [];
  entry.lifecycle = state.lifecycle;
  if (
    entry.telemetry &&
    entry.telemetry.correlationId === state.telemetryCorrelationId
  ) {
    if (state.telemetryActiveTurnId) {
      entry.telemetry.activeTurnId = state.telemetryActiveTurnId;
      entry.telemetry.turnStartedAt = state.telemetryTurnStartedAt;
    } else {
      delete entry.telemetry.activeTurnId;
      delete entry.telemetry.turnStartedAt;
    }
    if (state.telemetryMessageTurnId) {
      entry.telemetry.messageTurnId = state.telemetryMessageTurnId;
    } else {
      delete entry.telemetry.messageTurnId;
    }
    const messageCounts = [...(state.telemetryTurnMessageCounts ?? [])].slice(
      -32,
    );
    if (messageCounts.length > 0) {
      entry.telemetry.messageCounts = Object.fromEntries(messageCounts);
    } else {
      delete entry.telemetry.messageCounts;
    }
  }
}

function persistPolledStates(
  states: readonly InteractiveSubagentState[],
): void {
  const statesByCwd = new Map<string, InteractiveSubagentState[]>();
  for (const state of states) {
    const grouped = statesByCwd.get(state.cwd) ?? [];
    grouped.push(state);
    statesByCwd.set(state.cwd, grouped);
  }
  for (const [cwd, grouped] of statesByCwd) {
    updateInteractiveStates(
      cwd,
      grouped.map((state) => ({
        id: state.id,
        update: (entry) => persistPolledState(state, entry),
      })),
    );
  }
}

/**
 * Pi keeps Enter-during-streaming steering inside one agent run, but the child
 * protocol gives each persisted user entry a fresh turn id. Keep that run as
 * one telemetry task until the next persisted user entry advances it.
 */
function rebindTelemetryTurn(
  state: InteractiveSubagentState,
  nextTurnId: string,
): void {
  const previousTurnId = state.telemetryActiveTurnId;
  if (previousTurnId !== undefined && previousTurnId !== nextTurnId) {
    const counts = state.telemetryTurnMessageCounts;
    const previousCount = counts?.get(previousTurnId);
    if (counts && previousCount !== undefined) {
      const nextCount = counts.get(nextTurnId) ?? 0;
      counts.set(nextTurnId, Math.min(previousCount + nextCount, 1_000));
      counts.delete(previousTurnId);
    }
    if (state.telemetryMessageTurnId === previousTurnId) {
      state.telemetryMessageTurnId = nextTurnId;
    }
  }
  state.telemetryActiveTurnId = nextTurnId;
}

/**
 * Poll a live session scope's interactive artifact streams. Process protocol-v2
 * events in physical byte order and persist deterministic completion intents
 * for coordinated delivery, including completions written while Pi was offline.
 */
export function pollArtifactChanges(
  _pi: ExtensionAPI,
  owner?: SessionOwnerToken,
): Promise<void> {
  const key = pollOwnerKey(owner);
  const inFlight = pollsInFlight.get(key);
  if (inFlight) return inFlight;
  const poll = runPollArtifactChanges(owner);
  pollsInFlight.set(key, poll);
  return poll.finally(() => {
    if (pollsInFlight.get(key) === poll) pollsInFlight.delete(key);
  });
}

async function runPollArtifactChanges(
  owner?: SessionOwnerToken,
): Promise<void> {
  // Top-level defensive try/catch: the poller runs from a setInterval, so any uncaught throw here
  // would crash the parent pi process. Better to swallow and let the next tick (with a refreshed
  // pi ctx) try again. A stale extension context after session replacement is the most likely cause.
  try {
    const ownerContext = owner ? resolveLiveSessionScope(owner) : undefined;
    if (!ownerContext) return;
    const interactivePi = ownerContext.pi;
    const stateMap = ownerContext.interactiveStates;
    const states = [...stateMap.values()];
    const liveness = await Promise.all(
      states.map(async (state) => {
        try {
          return [
            state,
            await getInteractivePaneLivenessDiagnosticAsync(state),
          ] as const;
        } catch (err) {
          debugLog("error", "poller_liveness_error", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [state, { liveness: "unknown" as const }] as const;
        }
      }),
    );
    if (owner) {
      const liveOwnerContext = resolveLiveSessionScope(owner);
      if (
        !liveOwnerContext ||
        liveOwnerContext.interactiveStates !== stateMap
      ) {
        return;
      }
    }
    const ui = ownerContext.ui;
    const persistedStates: InteractiveSubagentState[] = [];
    for (const [state, livenessDiagnostic] of liveness) {
      if (stateMap.get(state.id) !== state) continue;
      const paneLiveness = livenessDiagnostic.liveness;
      if (paneLiveness === "unknown") {
        reportRuntimeFailure(
          state,
          ownerContext?.telemetry,
          "mux_probe",
          "mux",
          "polling",
          livenessDiagnostic.failureReason,
        );
      } else {
        clearRuntimeFailureEpisode(state, "mux_probe");
      }
      // Cancelled is terminal. Unknown means pane liveness is unavailable, so keep polling
      // the artifact log: a later done/error event must still reach the parent.
      // 'exited' is intentionally not skipped: a follow-up user entry can revive it to "running".
      const art = artifactPath(
        dirname(state.artifactDir),
        basename(state.artifactDir),
      );

      const cursor = state.eventByteCursor ?? 0;
      const batch = readEventBatch(art, cursor);
      reportArtifactReadIssues(state, ownerContext?.telemetry, batch.issues);
      const records = batch.records;
      const lifecycle = (state.lifecycle ??= {});
      let nextCursor = cursor;
      let queueBlocked = false;
      for (const record of records) {
        const ev = record.event;
        const queuesCompletion =
          state.completionOwner !== "workflow" &&
          shouldNotify(ev) &&
          isCompletionEvent(ev);
        if (
          queuesCompletion &&
          (state.pendingDeliveries?.length ?? 0) >= MAX_DELIVERY_RECORDS
        ) {
          flushDeliveries(interactivePi, ui, owner);
          if ((state.pendingDeliveries?.length ?? 0) >= MAX_DELIVERY_RECORDS) {
            queueBlocked = true;
            break;
          }
        }
        nextCursor = record.endOffset;
        foldInteractiveLifecycle(lifecycle, ev);
        if ("version" in ev && ev.version === 2 && ev.type === "turn_started") {
          state.activeTurnId = ev.turnId;
          const telemetryEligible =
            state.telemetryEligible === true &&
            state.telemetryCorrelationId ===
              ownerContext?.telemetry?.correlationId;
          if (telemetryEligible) {
            if (state.telemetryActiveTurnId !== undefined) {
              rebindTelemetryTurn(state, ev.turnId);
            } else {
              state.telemetryActiveTurnId = ev.turnId;
              state.telemetryTurnStartedAt = ev.ts;
              state.telemetryMessageTurnId = ev.turnId;
              captureTelemetry(
                ownerContext?.telemetry,
                {
                  event: "task_started",
                  execution: "interactive",
                  mux: state.mux,
                  unit: "turn",
                  invocation_source:
                    state.telemetryInvocationSource ?? "interactive",
                  model: state.telemetryModel,
                  async: state.telemetryAsync ?? true,
                  depth: state.telemetryDepth,
                  depth_bucket: state.telemetryDepthBucket ?? "unknown",
                  completion_policy: state.telemetryCompletionPolicy ?? "each",
                },
                {
                  dedupeKey: `task-started:interactive:${state.id}:${ev.eventId}`,
                },
              );
            }
          }
        }
        const terminalTelemetryEvent =
          ev.type === "completion" || ev.type === "process_exited";
        const terminalTurnId =
          ev.type === "completion" ? ev.turnId : state.telemetryActiveTurnId;
        if (
          terminalTelemetryEvent &&
          terminalTurnId !== undefined &&
          (ev.type !== "completion" ||
            state.telemetryActiveTurnId === ev.turnId) &&
          state.telemetryCorrelationId ===
            ownerContext?.telemetry?.correlationId
        ) {
          const status =
            ev.type === "process_exited"
              ? ev.status
              : deliveryStatusFromEvent(ev);
          const messageTurnId = state.telemetryMessageTurnId;
          const directMessageCount =
            state.telemetryTurnMessageCounts?.get(terminalTurnId);
          const fallbackMessageCount =
            directMessageCount === undefined &&
            messageTurnId !== undefined &&
            messageTurnId !== terminalTurnId
              ? state.telemetryTurnMessageCounts?.get(messageTurnId)
              : undefined;
          const messageCount = directMessageCount ?? fallbackMessageCount;
          const terminalReason = terminalReasonFromEvent(ev);
          const errorCategory = errorCategoryFromEvent(
            ev,
            status,
            terminalReason,
          );
          const errorStage = taskErrorStageFromEvent(
            ev,
            status,
            terminalReason,
          );
          const agentStopReason = taskAgentStopReason(ev, status);
          const exitCodeBucket = taskExitCodeBucket(ev);
          captureTelemetry(
            ownerContext?.telemetry,
            {
              event: "task_completed",
              execution: "interactive",
              mux: state.mux,
              unit: "turn",
              invocation_source:
                state.telemetryInvocationSource ?? "interactive",
              model: state.telemetryModel,
              async: state.telemetryAsync ?? true,
              depth: state.telemetryDepth,
              depth_bucket: state.telemetryDepthBucket ?? "unknown",
              completion_policy: state.telemetryCompletionPolicy ?? "each",
              status: status === "done" ? "success" : status,
              terminal_reason: terminalReason,
              ...(errorCategory === undefined
                ? {}
                : { error_category: errorCategory }),
              ...(errorStage === undefined ? {} : { error_stage: errorStage }),
              ...(agentStopReason === undefined
                ? {}
                : { agent_stop_reason: agentStopReason }),
              ...(exitCodeBucket === undefined
                ? {}
                : { exit_code_bucket: exitCodeBucket }),
              duration_ms:
                state.telemetryTurnStartedAt === undefined
                  ? undefined
                  : ev.ts - state.telemetryTurnStartedAt,
              child_conversation_message_count: messageCount,
            },
            {
              dedupeKey: `task-completed:interactive:${state.id}:${terminalTurnId}:${ev.type}:${record.startOffset}`,
            },
          );
          state.telemetryActiveTurnId = undefined;
          state.telemetryTurnStartedAt = undefined;
          if (directMessageCount !== undefined) {
            state.telemetryTurnMessageCounts?.delete(terminalTurnId);
          } else if (
            messageTurnId !== undefined &&
            messageTurnId !== terminalTurnId &&
            fallbackMessageCount !== undefined
          ) {
            state.telemetryTurnMessageCounts?.delete(messageTurnId);
          }
          if (
            messageTurnId === terminalTurnId ||
            (directMessageCount === undefined &&
              fallbackMessageCount !== undefined)
          ) {
            state.telemetryMessageTurnId = undefined;
          }
        }
        if (!queuesCompletion) continue;
        const completion = ev.type === "completion" ? ev : undefined;
        const turnId = ev.turnId;
        const eventId = ev.eventId;
        const status = deliveryStatusFromEvent(ev);
        enqueueDelivery(
          state,
          {
            deliveryId: deliveryIdFor({
              parentSessionId: state.parentSessionId ?? "pi",
              subagentId: state.id,
              turnId,
            }),
            subagentId: state.id,
            turnId,
            eventId,
            status,
            artifactDir: state.artifactDir,
            completedAt: ev.ts,
            output: completion?.output,
            message: deliveryMessageFromEvent(ev),
            completionPolicy: state.completionPolicy ?? "each",
            ...(state.completionPolicy === "group" && state.completionGroupId
              ? { completionGroupId: state.completionGroupId }
              : {}),
            state: "queued",
          },
          { persist: false },
        );
      }
      if (!queueBlocked) {
        for (const issue of batch.issues) {
          if (
            issue.kind !== "record_too_large" ||
            issue.endOffset > batch.endOffset
          ) {
            continue;
          }
          if (state.completionOwner === "workflow") continue;
          const identity = `record-overflow-${issue.startOffset}`;
          if ((state.pendingDeliveries?.length ?? 0) >= MAX_DELIVERY_RECORDS) {
            flushDeliveries(interactivePi, ui, owner);
            if (
              (state.pendingDeliveries?.length ?? 0) >= MAX_DELIVERY_RECORDS
            ) {
              queueBlocked = true;
              break;
            }
          }
          enqueueDelivery(
            state,
            {
              deliveryId: deliveryIdFor({
                parentSessionId: state.parentSessionId ?? "pi",
                subagentId: state.id,
                turnId: identity,
              }),
              subagentId: state.id,
              turnId: identity,
              eventId: identity,
              status: "error",
              artifactDir: state.artifactDir,
              message: `Artifact record at byte ${issue.startOffset} exceeded the ${issue.maxBytes}-byte limit and was skipped.`,
              completionPolicy: state.completionPolicy ?? "each",
              ...(state.completionPolicy === "group" && state.completionGroupId
                ? { completionGroupId: state.completionGroupId }
                : {}),
              state: "queued",
            },
            { persist: false },
          );
        }
      }
      if (!queueBlocked) nextCursor = batch.endOffset;
      state.eventByteCursor = nextCursor;
      const next = deriveInteractiveSubagentStatusFromLifecycle(
        lifecycle,
        paneLiveness,
      );
      if (next !== state.status) state.status = next;
      if (next === "exited") {
        if (lifecycle.processExitCode !== undefined) {
          state.exitCode = lifecycle.processExitCode;
        } else if (lifecycle.completionExitCode !== undefined) {
          state.exitCode = lifecycle.completionExitCode;
        }
      }
      if (state.parentSessionId) persistedStates.push(state);
    }
    // Queue state and its advanced byte cursor reach disk atomically. A crash
    // before this write replays the old cursor; deterministic delivery ids dedupe it.
    persistPolledStates(persistedStates);
    // One clock for both widgets so their coarse elapsed buckets stay aligned.
    const now = Date.now();
    const widgetRows = projectActivityWidgetRows(ui, owner, now);
    flushDeliveries(interactivePi, ui, owner);
    for (const state of states) {
      if (stateMap.get(state.id) !== state) continue;
      const terminal =
        state.status === "cancelled" || state.status === "exited";
      if (
        terminal &&
        state.parentSessionId &&
        (state.pendingDeliveries?.length ?? 0) === 0
      ) {
        try {
          removeInteractiveState(state.cwd, state.id);
        } catch {
          /* retry cleanup on the next poll */
        }
      }
    }

    // Cap widget rows to prevent TUI overflow.
    if (widgetRows.length > MAX_WIDGET_ROWS) {
      const extra = widgetRows.length - MAX_WIDGET_ROWS;
      widgetRows.length = MAX_WIDGET_ROWS;
      widgetRows.push(`… and ${extra} more`);
    }

    // Paint footer + widget. Both are TUI surfaces that never reach the LLM.
    if (ui) {
      const ownerContext = resolveLiveSessionScope(owner);
      const hideAgentList =
        widgetRows.length > 0 &&
        ownerContext !== undefined &&
        // Pass the session cwd, if any, and let the setting own its scope:
        // hide-agent-list is read globally, so a missing cwd never degrades
        // into a lookup against Node's process cwd.
        isAgentListHidden(ownerContext.pi, { cwd: ownerContext.cwd });
      updateRunningSubagentFooter(ui, owner);
      updateWidgetRows(ui, WIDGET_KEY, hideAgentList ? [] : widgetRows, owner);
      // Workflow TUI footer + widget: show running async workflows.
      try {
        const wfCount = getRunningWorkflowCount(owner);
        const workflowRows = formatWorkflowWidgetRows(owner, now);
        const workflowContribution: WorkflowFooterContribution | undefined =
          wfCount > 0
            ? {
                kind: "workflow",
                count: wfCount,
                footerLabel: orchestratorLabelForOwner(owner),
                usage: aggregateWorkflowFooterUsage(owner),
              }
            : undefined;
        updateFooterStatus(
          ui,
          WORKFLOW_FOOTER_KEY,
          workflowContribution,
          owner,
        );
        updateWidgetRows(ui, WORKFLOW_WIDGET_KEY, workflowRows, owner);
      } catch {
        /* ui stale */
      }
    }
  } catch (err) {
    debugLog("error", "poller_error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    /* defensive: never let one bad poll tick crash the parent process */
  }
}

function formatWorkflowWidgetRows(
  owner: SessionOwnerToken | undefined,
  now: number,
): string[] {
  const rows: string[] = [];
  for (const st of workflowJobRegistry.values()) {
    if (!workflowJobBelongsToOwner(st, owner)) continue;
    if (st.status !== "running") continue;
    const s = st.snapshot;
    const usage = presentWorkflowUsage(s.usage);
    const liveUsage = presentWorkflowUsage(s.liveUsage);
    const parts = [
      `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
      `${s.runningCount ?? 0} running`,
      ...(usage
        ? [formatWorkflowUsage(usage, { outputBudget: s.budgetTotal })]
        : []),
      ...(liveUsage ? [`live ${formatWorkflowUsage(liveUsage)}`] : []),
      formatWorkflowElapsed(now - st.startedAt),
    ];
    if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
    const last = s.lastMessage ? ` — ${s.lastMessage}` : "";
    rows.push(`◇ ${st.name} (${st.id}): ${parts.join(" · ")}${last}`);
  }
  if (rows.length > MAX_WORKFLOW_WIDGET_ROWS) {
    const extra = rows.length - MAX_WORKFLOW_WIDGET_ROWS;
    rows.length = MAX_WORKFLOW_WIDGET_ROWS;
    rows.push(`… and ${extra} more workflow${extra === 1 ? "" : "s"}`);
  }
  return rows;
}

function aggregateWorkflowFooterUsage(
  owner: SessionOwnerToken | undefined,
): WorkflowUsage | undefined {
  let aggregate = zeroWorkflowUsage();
  for (const job of workflowJobRegistry.values()) {
    if (!workflowJobBelongsToOwner(job, owner)) continue;
    if (job.status !== "running") continue;
    aggregate = addAggregateWorkflowUsage(aggregate, job.snapshot.usage);
  }
  return hasWorkflowUsage(aggregate) ? aggregate : undefined;
}

/** Coarse elapsed clock; see ACTIVITY_ELAPSED_BUCKET_MS for why it is bucketed. */
function formatWorkflowElapsed(milliseconds: number): string {
  const bucketed = coarseElapsedMs(milliseconds);
  const seconds = Math.floor(bucketed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
