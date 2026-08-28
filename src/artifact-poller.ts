/**
 * Artifact polling, legacy session-log tailing, and durable completion enqueue.
 *
 * Extracted from src/subagent.ts to keep the extension entry point focused on tool
 * registration and lifecycle management. This module owns the poll interval's per-tick
 * work: walking the artifact directory of every running interactive sub-agent, tail-reading
 * the child's session JSONL, appending legacy tool_activity events, and enqueueing
 * protocol completions for trigger-aware delivery.
 *
 * See src/subagent.ts for the interval setup / teardown and the rehydrate logic.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  artifactPath,
  appendEvent,
  assertNever,
  isCompletionEvent,
  readEventBatch,
  removeInteractiveState,
  updateInteractiveStates,
  type CompletionEvent,
  type CompletionOutcome,
  type SubagentArtifact,
  type SubagentEvent,
  type InteractiveSubagentPersistedStateV2,
} from "./artifact";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  disposeWorkflowInteractiveSubagent,
  foldInteractiveLifecycle,
  getInteractivePaneLivenessAsync,
  hasPersistedDirectRecoveryIdentity,
  interactiveSubagentRegistry,
  isWorkflowChildDisposalDue,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { shouldNotify } from "./notifications";
import {
  deliveryIdFor,
  enqueueDelivery,
  flushDeliveries,
  MAX_DELIVERY_RECORDS,
} from "./delivery";
import { debugLog, jobRegistry, type JobState } from "./helpers";
import { coarseElapsedMs, formatActivityRow } from "./rendering";
import {
  addWorkflowUsage,
  formatWorkflowUsage,
  hasWorkflowUsage,
  presentWorkflowUsage,
  type WorkflowUsage,
  zeroWorkflowUsage,
} from "./workflow-core";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import ndjson from "ndjson";

import {
  getRunningWorkflowCount,
  workflowJobBelongsToOwner,
  workflowJobRegistry,
} from "./workflow-jobs";
import {
  ownerlessEntitiesVisible,
  type SessionOwnerToken,
  resolveLiveSessionScope,
} from "./session-scope";
// ── Footer / Widget Status Keys ────────────────────────────────────────

export const FOOTER_KEY = "subagentura-running";
const WIDGET_KEY = "subagentura-activity";
const WORKFLOW_FOOTER_KEY = "subagentura-workflows";
const WORKFLOW_WIDGET_KEY = "subagentura-workflow-activity";

/** Maximum widget rows before truncation with "… and N more". */
const MAX_WIDGET_ROWS = 10;
const MAX_WORKFLOW_WIDGET_ROWS = 5;
type StatusUi = Pick<ExtensionUIContext, "setStatus">;
interface WidgetSurfaceState {
  contributions: Map<string, string[]>;
  rendered: string[] | undefined;
  painted: boolean;
}
interface SubagentFooterContribution {
  kind: "subagent";
  count: number;
}
interface WorkflowFooterContribution {
  kind: "workflow";
  count: number;
  usage?: WorkflowUsage;
}
type FooterContribution =
  SubagentFooterContribution | WorkflowFooterContribution;
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
  if (owners.some((owner) => owner === undefined)) {
    return ownerlessEntitiesVisible()
      ? [...interactiveSubagentRegistry.values()]
      : [];
  }
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
  if (owners.some((owner) => owner === undefined)) {
    return ownerlessEntitiesVisible() ? [...jobRegistry.values()] : [];
  }
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
    for (const contribution of contributions) {
      if (contribution.kind === "subagent") total += contribution.count;
    }
    if (total === 0) return undefined;
    return `⚡ ${total} sub-agent${total > 1 ? "s" : ""} alive`;
  }
  if (key === WORKFLOW_FOOTER_KEY) {
    let total = 0;
    let usage = zeroWorkflowUsage();
    for (const contribution of contributions) {
      if (contribution.kind !== "workflow") continue;
      total += contribution.count;
      usage = addAggregateWorkflowUsage(usage, contribution.usage);
    }
    if (total === 0) return undefined;
    const presentedUsage = hasWorkflowUsage(usage)
      ? ` · ${formatWorkflowUsage(usage)}`
      : "";
    return `⚡ ${total} workflow${total > 1 ? "s" : ""} running${presentedUsage}`;
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

/**
 * Repaint the "N sub-agents alive" footer, scoped to `owner` when supplied.
 *
 * Liveness is decided here rather than at the call sites: callers pass the raw
 * active token, so a token whose lifecycle already ended reads as "this session
 * owns nothing" (count 0) instead of silently falling back to a cross-session
 * global count.
 */
export function updateRunningSubagentFooter(
  ui: StatusUi,
  owner?: SessionOwnerToken,
): void {
  const ownerContext = resolveLiveSessionScope(owner);
  const runningCount =
    owner !== undefined && !ownerContext ? 0 : getRunningSubagentCount([owner]);
  const contribution: SubagentFooterContribution | undefined =
    runningCount > 0 ? { kind: "subagent", count: runningCount } : undefined;
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
    ui.setWidget(key, rendered, { placement: "belowEditor" });
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

/** Derive delivery status from an already narrowed completion event. */
function deliveryStatusFromEvent(ev: CompletionEvent): CompletionOutcome {
  switch (ev.type) {
    case "done":
      return "done";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "completion":
      return ev.outcome;
    default:
      return assertNever(ev);
  }
}

function deliveryMessageFromEvent(ev: CompletionEvent): string | undefined {
  if (ev.type !== "completion") {
    return "message" in ev ? ev.message : undefined;
  }
  if (ev.errorMessage) return ev.errorMessage;
  if (ev.message) return ev.message;
  if (ev.outputError?.code === "output_too_large") {
    return `Output omitted: ${ev.outputError.bytes} bytes exceeds the ${ev.outputError.maxBytes}-byte snapshot limit.`;
  }
  return ev.outputError?.message;
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
  entry.sessionByteCursor =
    state.sessionObservedByteCursor ?? state.lastDeliveredSessionByte ?? 0;
  entry.sessionPartialLineStart = state.sessionPartialLineStart ?? null;
  entry.activeTurnId = state.activeTurnId;
  entry.pendingDeliveries = state.pendingDeliveries ?? [];
  entry.deliveryReceipts = state.deliveryReceipts ?? [];
  entry.lifecycle = state.lifecycle;
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
 * Poll the artifact directory of every running interactive sub-agent and fire a
 * pointer-only notification for any new events that match the spawner's cadence.
 *
 * Backwards-compatible with sub-agents that finished during parent downtime:
 * we walk the artifact log in physical byte order and advance eventByteCursor.
 */
export function pollArtifactChanges(
  pi: ExtensionAPI,
  owner?: SessionOwnerToken,
): Promise<void> {
  const key = pollOwnerKey(owner);
  const inFlight = pollsInFlight.get(key);
  if (inFlight) return inFlight;
  const poll = runPollArtifactChanges(pi, owner);
  pollsInFlight.set(key, poll);
  return poll.finally(() => {
    if (pollsInFlight.get(key) === poll) pollsInFlight.delete(key);
  });
}

async function runPollArtifactChanges(
  pi: ExtensionAPI,
  owner?: SessionOwnerToken,
): Promise<void> {
  // Top-level defensive try/catch: the poller runs from a setInterval, so any uncaught throw here
  // would crash the parent pi process. Better to swallow and let the next tick (with a refreshed
  // pi ctx) try again. A stale extension context after session replacement is the most likely cause.
  try {
    const g2 = typeof global !== "undefined" ? global : globalThis;
    const initialPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    const ownerContext = owner ? resolveLiveSessionScope(owner) : undefined;
    if ((owner && !ownerContext) || (!owner && !ownerlessEntitiesVisible()))
      return;
    const interactivePi =
      ownerContext?.pi ??
      (g2.__piSubagenturaPiRef as ExtensionAPI | undefined) ??
      pi;
    if (!interactivePi) return;

    const stateMap =
      ownerContext?.interactiveStates ?? interactiveSubagentRegistry;
    const states = [...stateMap.values()];
    const liveness = await Promise.all(
      states.map(async (state) => {
        try {
          return [state, await getInteractivePaneLivenessAsync(state)] as const;
        } catch (err) {
          debugLog("error", "poller_liveness_error", {
            stateId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return [state, "unknown"] as const;
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
    const currentPiRef = g2.__piSubagenturaPiRef as ExtensionAPI | undefined;
    if (
      !owner &&
      ((initialPiRef !== undefined && currentPiRef === undefined) ||
        (currentPiRef !== undefined && currentPiRef !== interactivePi))
    ) {
      return;
    }
    const ui =
      ownerContext?.ui ??
      (g2.__piSubagenturaUi as ExtensionUIContext | undefined);
    const persistedStates: InteractiveSubagentState[] = [];
    for (const [state, paneLiveness] of liveness) {
      if (stateMap.get(state.id) !== state) continue;
      // Cancelled is terminal. Unknown means pane liveness is unavailable, so keep polling
      // the artifact log: a later done/error event must still reach the parent.
      // 'exited' is intentionally not skipped: a follow-up user entry can revive it to "running".
      const art = artifactPath(
        dirname(state.artifactDir),
        basename(state.artifactDir),
      );
      // Tail-read the child's session log and synthesize tool_activity events.
      // TUI-widget only — the LLM never sees them.
      tailReadSessionLog(state, art);

      const cursor = state.eventByteCursor ?? 0;
      const batch = readEventBatch(art, cursor);
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
        }
        if (!queuesCompletion) continue;
        const v2 = ev.type === "completion" ? ev : undefined;
        const mode = state.completionPolicy
          ? "notify"
          : (state.notifyOnComplete ?? "inject");
        const triggerTurn =
          mode === "inject"
            ? state.triggerTurnOnComplete !== false
            : state.triggerTurnOnComplete === true;
        const turnId = v2?.turnId ?? `legacy-${record.startOffset}`;
        const eventId =
          v2?.eventId ??
          (ev as unknown as { eventId?: string }).eventId ??
          `legacy-${record.startOffset}`;
        const status = deliveryStatusFromEvent(ev);
        enqueueDelivery(
          state,
          {
            deliveryId: deliveryIdFor({
              parentSessionId: state.parentSessionId ?? "pi",
              subagentId: state.id,
              turnId,
              mode,
            }),
            subagentId: state.id,
            turnId,
            eventId,
            mode,
            triggerTurn,
            status,
            artifactDir: state.artifactDir,
            output: v2?.output,
            message: deliveryMessageFromEvent(ev),
            completionPolicy: state.completionPolicy,
            completionGroupId: state.completionGroupId,
            state: "queued",
          },
          { persist: false },
        );
      }
      if (!queueBlocked) {
        for (const issue of batch.issues) {
          if (state.completionOwner === "workflow") continue;
          const mode = state.completionPolicy
            ? "notify"
            : (state.notifyOnComplete ?? "inject");
          const triggerTurn =
            mode === "inject"
              ? state.triggerTurnOnComplete !== false
              : state.triggerTurnOnComplete === true;
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
                mode,
              }),
              subagentId: state.id,
              turnId: identity,
              eventId: identity,
              mode,
              triggerTurn,
              status: "error",
              artifactDir: state.artifactDir,
              message: `Artifact record at byte ${issue.startOffset} exceeded the ${issue.maxBytes}-byte limit and was skipped.`,
              completionPolicy: state.completionPolicy,
              completionGroupId: state.completionGroupId,
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
    // Reusable workflow children are deliberately runtime-only. Expiry removes
    // ownership before killing the pane, so liveness can never recreate authority.
    const now = Date.now();
    for (const state of states) {
      if (stateMap.get(state.id) !== state) continue;
      if (!isWorkflowChildDisposalDue(state, now)) continue;
      destroySessionParser(state);
      disposeWorkflowInteractiveSubagent(state);
    }
    // One clock for widgets and bounded reuse expiry keeps coarse UI state aligned.
    const widgetRows = projectActivityWidgetRows(ui, owner, now);
    flushDeliveries(interactivePi, ui, owner);
    for (const state of states) {
      if (stateMap.get(state.id) !== state) continue;
      const terminal =
        state.status === "cancelled" || state.status === "exited";
      if (terminal) destroySessionParser(state);
      if (
        terminal &&
        !hasPersistedDirectRecoveryIdentity(state) &&
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
      updateRunningSubagentFooter(ui, owner);
      updateWidgetRows(ui, WIDGET_KEY, widgetRows, owner);
      // Workflow TUI footer + widget: show running async workflows.
      try {
        const wfCount = getRunningWorkflowCount(owner);
        const workflowRows = formatWorkflowWidgetRows(owner, now);
        const workflowContribution: WorkflowFooterContribution | undefined =
          wfCount > 0
            ? {
                kind: "workflow",
                count: wfCount,
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

// ── Session-log parsing state ─────────────────────────────────────────

interface SessionParserState {
  parser: ReturnType<typeof ndjson.parse>;
  owner: InteractiveSubagentState;
  readCursor: number;
}

/**
 * `readCursor` advances through bytes buffered by split2. The persisted session
 * cursor keeps that observed file position for truncation detection, while
 * `sessionPartialLineStart` records the replay point needed to reconstruct a
 * partial line after reload without persisting child-controlled content.
 */
const sessionParsers = new Map<string, SessionParserState>();

/** Bound both per-tick allocation and split2's accumulated incomplete line. */
const MAX_SESSION_READ_BYTES = 1 * 1024 * 1024;
const MAX_SESSION_LINE_BYTES = 2 * 1024 * 1024;

function getOrCreateSessionParser(
  state: InteractiveSubagentState,
): SessionParserState {
  const existing = sessionParsers.get(state.id);
  if (existing?.owner === state) return existing;
  if (existing) destroySessionParser(state);

  const parser = ndjson.parse({
    strict: false,
    maxLength: MAX_SESSION_LINE_BYTES,
    skipOverflow: true,
  });
  const parserState: SessionParserState = {
    parser,
    owner: state,
    readCursor: state.lastDeliveredSessionByte ?? 0,
  };
  parser.on("data", (entry: unknown) => {
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    processSessionLogEntry(state, art, entry as any);
  });
  parser.on("error", () => {
    if (sessionParsers.get(state.id) !== parserState) return;
    rewindSessionParser(parserState);
    sessionParsers.delete(state.id);
    try {
      parser.destroy();
    } catch {
      /* parser is already broken; the durable cursor permits replay */
    }
  });
  sessionParsers.set(state.id, parserState);
  return parserState;
}

function rewindSessionParser(parserState: SessionParserState): void {
  const owner = parserState.owner;
  const replayCursor = owner.sessionPartialLineStart;
  if (replayCursor === undefined) return;
  owner.sessionObservedByteCursor = owner.lastDeliveredSessionByte;
  owner.lastDeliveredSessionByte = replayCursor;
}

/** Discard buffered child data without flushing an incomplete JSONL record. */
function destroySessionParser(state: InteractiveSubagentState): void {
  const parserState = sessionParsers.get(state.id);
  if (!parserState) return;
  rewindSessionParser(parserState);
  sessionParsers.delete(state.id);
  try {
    parserState.parser.destroy();
  } catch {
    /* parser may already be destroyed */
  }
}

/** Release parsers for one exact live owner, or every parser for legacy callers. */
export function clearSessionParsers(owner?: SessionOwnerToken): void {
  if (owner) {
    const scope = resolveLiveSessionScope(owner);
    if (!scope) return;
    for (const state of scope.interactiveStates.values()) {
      destroySessionParser(state);
    }
    return;
  }
  for (const parserState of [...sessionParsers.values()]) {
    destroySessionParser(parserState.owner);
  }
}

// ── Session-log tail-reading ──────────────────────────────────────────

/** Tail-read the child's session JSONL and append `tool_activity` events.
 *  Persists the observed cursor and incomplete-line replay boundary. */
function tailReadSessionLog(
  state: InteractiveSubagentState,
  _art: SubagentArtifact,
): void {
  const sessionFile = state.sessionFile;
  if (!sessionFile) return;

  let size: number;
  try {
    size = statSync(sessionFile).size;
  } catch {
    return;
  }

  let parserState = sessionParsers.get(state.id);
  if (parserState && parserState.owner !== state) {
    destroySessionParser(state);
    parserState = undefined;
  }
  let cursor = parserState?.readCursor ?? state.lastDeliveredSessionByte ?? 0;
  const observedCursor = state.sessionObservedByteCursor;
  state.sessionObservedByteCursor = undefined;
  if (
    size < cursor ||
    (observedCursor !== undefined && size < observedCursor)
  ) {
    state.lastDeliveredSessionByte = 0;
    state.sessionPartialLineStart = undefined;
    destroySessionParser(state);
    parserState = undefined;
    cursor = 0;
  }
  if (size <= cursor) return;

  const requested = size - cursor;
  const toRead = Math.min(requested, MAX_SESSION_READ_BYTES);
  if (toRead <= 0) return;

  let fd: number;
  try {
    fd = openSync(sessionFile, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(toRead);
    let bytesRead = 0;
    while (bytesRead < toRead) {
      const count = readSync(
        fd,
        buf,
        bytesRead,
        toRead - bytesRead,
        cursor + bytesRead,
      );
      if (count <= 0) break;
      bytesRead += count;
    }
    if (bytesRead === 0) return;

    parserState = getOrCreateSessionParser(state);
    parserState.parser.write(buf.subarray(0, bytesRead));
    parserState.readCursor = cursor + bytesRead;
    state.lastDeliveredSessionByte = parserState.readCursor;
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline === bytesRead - 1) {
      state.sessionPartialLineStart = undefined;
    } else if (lastNewline >= 0) {
      state.sessionPartialLineStart = cursor + lastNewline + 1;
    } else if (state.sessionPartialLineStart === undefined) {
      state.sessionPartialLineStart = cursor;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed or never opened — ignore */
    }
  }
}

/** Process a single parsed JSONL entry from the session log; append tool_activity events. */
function processSessionLogEntry(
  state: InteractiveSubagentState,
  art: SubagentArtifact,
  entry: Record<string, unknown>,
): void {
  const e = entry as { type?: string; message?: Record<string, unknown> };
  if (e.type !== "message") return;
  const msg = e.message;
  if (!msg) return;

  // New user-role message = a new turn. Clear legacy per-turn session metadata.
  if (msg.role === "user") {
    state.autoDoneForTurnAt = undefined;
    state.lastStopReason = undefined;
    state.lastStopReasonAt = undefined;
    state.lastStopText = undefined;
    if (state.lifecycle && !state.lifecycle.parentCancelled) {
      state.lifecycle.currentTurnId = undefined;
      state.lifecycle.completionTurnId = undefined;
      state.lifecycle.completionOutcome = undefined;
      state.lifecycle.completionSource = undefined;
      state.lifecycle.completionExitCode = undefined;
      state.lifecycle.legacyTerminal = undefined;
    }
    // A user-role entry starts a new turn regardless of how the previous turn ended.
    if (state.status === "exited" || state.status === "idle")
      state.status = "running";
    return;
  }

  // Assistant message: extract tool calls and retain legacy stop metadata.
  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const ts = (msg.timestamp as number) ?? Date.now();
    const stopReason = (msg as { stopReason?: string }).stopReason;
    if (
      stopReason === "stop" ||
      stopReason === "length" ||
      stopReason === "error" ||
      stopReason === "aborted"
    ) {
      state.lastStopReason = stopReason;
      state.lastStopReasonAt = ts;
      if (stopReason === "stop") {
        const text = extractAssistantText(msg.content);
        if (text) state.lastStopText = text;
      }
    }
    for (const rawBlock of msg.content) {
      const block = rawBlock as
        { type?: string; name?: string; arguments?: unknown } | undefined;
      if (!block || block.type !== "toolCall") continue;
      const summary = summarizeToolCall(block.name ?? "", block.arguments);
      if (!summary) continue;
      const ev: SubagentEvent = {
        ts,
        type: "tool_activity",
        status: "running",
        tool: block.name ?? "",
        summary,
      };
      appendEvent(art, ev);
      state.lastToolName = block.name ?? "";
      state.lastToolSummary = summary;
      state.lastActivityAt = ev.ts;
    }
  }
}

/** Concatenate text blocks from an assistant message's content array. Empty string if none. */
function extractAssistantText(content: unknown[]): string {
  let out = "";
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      if (out) out += "\n";
      out += b.text;
    }
  }
  return out;
}

// ── Misc helpers ──────────────────────────────────────────────────────

/** Short, human-readable summary of a tool call. Returns null for uninteresting tools. */
function summarizeToolCall(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "bash": {
      const cmd = typeof a.command === "string" ? a.command : null;
      if (!cmd) return null;
      return cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
    }
    case "write":
    case "edit":
    case "read": {
      const p = typeof a.path === "string" ? a.path : null;
      if (!p) return null;
      return p;
    }
    default:
      return null; // skip grep/find/ls etc. — too noisy for the widget
  }
}
