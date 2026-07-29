import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { promises as fs, type promises as fsTypes } from "node:fs";
import { join } from "node:path";
import type { JobState } from "./helpers";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
  interactiveStatusForState,
  isInteractiveStateActive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { WorkflowJobState } from "./workflow-jobs";

export const INTERACTIVE_SUPERVISOR_SHORTCUT = "ctrl+alt+a";
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DETAIL_OUTPUT_MAX_BYTES = 4 * 1024;
const DETAIL_EVENTS_MAX_BYTES = 8 * 1024;
const DETAIL_PREVIEW_MAX_CHARS = 512;
const DETAIL_EVENT_COUNT = 3;
const DETAIL_WORKFLOW_AGENT_COUNT = 20;

export type InteractiveSupervisorAction = { kind: "close" };
type SupervisorDone = (action: InteractiveSupervisorAction) => void;
// A set, not a single handle: two concurrent overlays used to orphan the first
// `done`, so shutdown could only ever close the last one.
const activeDoneHandles = new Set<SupervisorDone>();

interface SupervisorItemBase {
  depth: number;
  actionable: boolean;
}

/** Bounded artifact preview for an expanded row, read off the render path. */
export interface SupervisorArtifactDetails {
  lifecycle: string;
  events: string;
  output: string;
}

export interface InteractiveSupervisorOrigin {
  source: "registry" | "lineage";
  rootId?: string;
  ownerSessionId?: string;
  parentAgentId?: string;
}

export interface InteractiveSupervisorItem extends SupervisorItemBase {
  kind?: "interactive";
  state: InteractiveSubagentState;
  origin?: InteractiveSupervisorOrigin;
}

export interface InProcessSupervisorItem extends SupervisorItemBase {
  kind: "in-process";
  job: JobState;
}

export interface WorkflowSupervisorItem extends SupervisorItemBase {
  kind: "workflow";
  job: WorkflowJobState;
}

export type AsyncSupervisorItem =
  InteractiveSupervisorItem | InProcessSupervisorItem | WorkflowSupervisorItem;

export interface InteractiveSupervisorOptions {
  done: SupervisorDone;
  requestRender?: () => void;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  cancel?: typeof cancelInteractiveSubagent;
  cancelInProcess?: (job: JobState) => boolean;
  cancelWorkflow?: (job: WorkflowJobState) => boolean;
  focus?: (state: InteractiveSubagentState) => void | Promise<void>;
  view?: (state: InteractiveSubagentState) => void | Promise<void>;
  nativeView?: (state: InteractiveSubagentState) => void | Promise<void>;
  cancelSubtree?: (state: InteractiveSubagentState) => void | Promise<void>;
  /**
   * Whether a mux client is attached to the target's session. `undefined` means
   * the backend cannot tell. Focus is server-side state, so a "successful" focus
   * with no client attached is a silent no-op the user must be warned about.
   */
  hasAttachedClient?: (
    state: InteractiveSubagentState,
  ) => Promise<boolean | undefined> | boolean | undefined;
  /** Warning/status lines rendered under the list (hidden nodes, refresh failures). */
  status?: () => string[];
  refreshIntervalMs?: number;
  now?: () => number;
  items?: () => AsyncSupervisorItem[];
  refresh?: () => void | Promise<void>;
}

export class InteractiveSupervisorComponent {
  private selectedIndex = 0;
  private selectedKey?: string;
  private expanded = new Set<string>();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private refreshing = false;
  /**
   * Artifact previews for expanded rows, filled by the async refresh. render()
   * must never touch the filesystem: its cache is invalidated on every refresh
   * tick, so a sync read there ran ~10 blocking syscalls per expanded row per
   * second on the TUI thread.
   */
  private artifactDetails = new Map<string, SupervisorArtifactDetails>();

  constructor(private readonly opts: InteractiveSupervisorOptions) {
    const refreshIntervalMs =
      opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (refreshIntervalMs > 0 && opts.requestRender) {
      this.timer = setInterval(() => void this.refresh(), refreshIntervalMs);
      this.timer.unref?.();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const items = this.items();
    const lines = [
      trunc("┌ Async Subagents", width),
      trunc("│ All: ↑↓/jk select · enter/→ details · ← collapse", width),
      trunc("│ All: x cancel item · r refresh · q/esc close", width),
      trunc("│ Interactive: v snapshot · n native viewer · f focus", width),
      trunc("│ Interactive: a show attach cmd · X cancel subtree", width),
      trunc("│ Focus: expand first to see native return keys", width),
      trunc("│ Sources: registry=live · lineage=persisted", width),
    ];

    if (items.length === 0) {
      lines.push(trunc("│ No async subagents.", width));
    } else {
      items.forEach((item, index) => {
        const selected = index === this.selectedIndex;
        const itemKey = supervisorItemKey(item);
        const expanded = this.expanded.has(itemKey);
        const marker = selected ? "▶" : "○";
        lines.push(
          trunc(
            `│ ${"  ".repeat(item.depth)}${marker} ${expanded ? "▾" : "▸"} ${formatAsyncSupervisorSummary(
              item,
              this.now(),
            )}`,
            width,
          ),
        );
        if (expanded) {
          lines.push(
            ...formatAsyncDetails(
              item,
              width,
              this.artifactDetails.get(itemKey),
            ),
          );
        }
      });
    }

    for (const line of this.opts.status?.() ?? []) {
      lines.push(trunc(`│ ${compactText(line)}`, width));
    }

    lines.push(trunc(`└${"─".repeat(Math.max(0, width - 2))}┘`, width));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, "q") ||
      matchesKey(data, Key.ctrlAlt("a"))
    ) {
      this.opts.done({ kind: "close" });
      return;
    }

    const items = this.items();
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectIndex(items, this.selectedIndex - 1);
      this.changed();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectIndex(items, this.selectedIndex + 1);
      this.changed();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.refresh();
      return;
    }

    const selectedItem = items[this.selectedIndex];
    if (!selectedItem) return;
    const itemKey = supervisorItemKey(selectedItem);
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      this.toggle(itemKey);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.expanded.delete(itemKey);
      this.changed();
      return;
    }
    if (matchesKey(data, "x")) {
      this.cancelItem(selectedItem);
      return;
    }
    if (matchesKey(data, "a")) {
      const state = this.interactiveStateForAction(selectedItem, "attach");
      if (state) {
        this.opts.notify?.(
          `Attach command for ${state.name}:\n${state.attachCommand}`,
          "info",
        );
      }
      return;
    }
    if (matchesKey(data, "v")) {
      const state = this.interactiveStateForAction(selectedItem, "view");
      if (state) void this.runAction("view", state, this.opts.view);
      return;
    }
    if (matchesKey(data, "n")) {
      const state = this.interactiveStateForAction(selectedItem, "native view");
      if (state)
        void this.runAction("open native view", state, this.opts.nativeView);
      return;
    }
    if (matchesKey(data, "f")) {
      const state = this.interactiveStateForAction(selectedItem, "focus");
      if (state) void this.focusItem(state);
      return;
    }
    if (matchesKey(data, Key.shift("x"))) {
      this.cancelInteractiveSubtree(selectedItem);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private items(): AsyncSupervisorItem[] {
    const items = (this.opts.items?.() ?? supervisorItems()).filter(
      supervisorItemIsActive,
    );
    const stableIndex = this.selectedKey
      ? items.findIndex((item) => supervisorItemKey(item) === this.selectedKey)
      : -1;
    this.selectedIndex =
      stableIndex >= 0
        ? stableIndex
        : clampIndex(this.selectedIndex, items.length);
    this.selectedKey = items[this.selectedIndex]
      ? supervisorItemKey(items[this.selectedIndex])
      : undefined;
    return items;
  }

  private selectIndex(items: AsyncSupervisorItem[], index: number): void {
    this.selectedIndex = clampIndex(index, items.length);
    this.selectedKey = items[this.selectedIndex]
      ? supervisorItemKey(items[this.selectedIndex])
      : undefined;
  }

  private toggle(id: string): void {
    const expanding = !this.expanded.has(id);
    if (expanding) this.expanded.add(id);
    else {
      this.expanded.delete(id);
      this.artifactDetails.delete(id);
    }
    // Repaint the row shape immediately; the artifact previews it needs are read
    // asynchronously and land on a later tick as "loading…" resolves.
    this.changed();
    if (expanding) void this.refresh();
  }

  private cancelItem(item: AsyncSupervisorItem): void {
    let cancelled = false;
    let label = "subagent";
    if (item.kind === "in-process") {
      cancelled = this.opts.cancelInProcess?.(item.job) ?? false;
      label = item.job.id;
    } else if (item.kind === "workflow") {
      cancelled = this.opts.cancelWorkflow?.(item.job) ?? false;
      label = item.job.name;
    } else {
      cancelled = Boolean(
        (this.opts.cancel ?? cancelInteractiveSubagent)(item.state.id),
      );
      label = item.state.name;
    }
    this.opts.notify?.(
      cancelled ? `Cancelled ${label}.` : `${label} is no longer running.`,
      cancelled ? "warning" : "error",
    );
    this.changed();
  }

  private cancelInteractiveSubtree(item: AsyncSupervisorItem): void {
    const state = interactiveState(item);
    if (!state) {
      this.opts.notify?.(
        "Subtree cancellation is only available for interactive agents.",
        "info",
      );
      return;
    }
    void this.runAction("cancel subtree", state, this.opts.cancelSubtree);
  }

  private interactiveStateForAction(
    item: AsyncSupervisorItem,
    action: string,
  ): InteractiveSubagentState | undefined {
    const state = interactiveState(item);
    if (!state) {
      this.opts.notify?.(
        `${action} is only available for interactive agents.`,
        "info",
      );
    }
    return state;
  }

  private changed(): void {
    if (this.disposed) return;
    this.invalidate();
    this.opts.requestRender?.();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      // Avoid `await undefined` — that yields a microtask and breaks the
      // no-refresh path, which previously called changed() synchronously.
      if (this.opts.refresh) await this.opts.refresh();
      if (this.expanded.size > 0) await this.loadArtifactDetails();
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }

  /** Read the artifact previews for expanded interactive rows, off the render path. */
  private async loadArtifactDetails(): Promise<void> {
    const wanted = new Map<string, InteractiveSubagentState>();
    for (const item of this.items()) {
      const key = supervisorItemKey(item);
      if (!this.expanded.has(key)) continue;
      const state = interactiveState(item);
      if (state) wanted.set(key, state);
    }
    for (const key of [...this.artifactDetails.keys()]) {
      if (!wanted.has(key)) this.artifactDetails.delete(key);
    }
    const loaded = await Promise.all(
      [...wanted].map(
        async ([key, state]) =>
          [key, await readArtifactDetails(state)] as const,
      ),
    );
    for (const [key, details] of loaded) {
      this.artifactDetails.set(key, details);
    }
  }

  /**
   * Focus the pane, then tell the user when the focus landed on a session no
   * client is attached to — otherwise `f` looks like a silent no-op.
   */
  private async focusItem(state: InteractiveSubagentState): Promise<void> {
    if (!this.opts.focus) {
      this.opts.notify?.("focus is not available in this session.", "info");
      return;
    }
    try {
      await this.opts.focus(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.notify?.(`Unable to focus: ${message}`, "error");
      return;
    } finally {
      this.changed();
    }
    let attached: boolean | undefined;
    try {
      attached = await this.opts.hasAttachedClient?.(state);
    } catch {
      attached = undefined;
    }
    if (attached === false) {
      this.opts.notify?.(
        `Focused ${compactText(state.name)}, but no client is attached to its mux session — attach with:\n${state.attachCommand}`,
        "warning",
      );
    }
  }

  private async runAction(
    label: string,
    state: InteractiveSubagentState,
    action?: (state: InteractiveSubagentState) => void | Promise<void>,
  ): Promise<void> {
    if (!action) {
      this.opts.notify?.(`${label} is not available in this session.`, "info");
      return;
    }
    try {
      await action(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.notify?.(`Unable to ${label}: ${message}`, "error");
    } finally {
      this.changed();
    }
  }
}

interface SupervisorTui {
  requestRender?: () => void;
  showOverlay?: TUI["showOverlay"];
  terminal?: Pick<TUI["terminal"], "rows">;
}

function ditherBackdropLine(width: number, row: number): string {
  const safeWidth = Math.max(0, width);
  const offset = row % 2 === 0 ? 0 : 2;
  return Array.from({ length: safeWidth }, (_, column) =>
    (column + offset) % 4 === 0 ? "░" : " ",
  ).join("");
}

class InteractiveSupervisorBackdrop implements Component {
  constructor(
    private readonly rows: () => number,
    private readonly paint: (text: string) => string,
  ) {}

  render(width: number): string[] {
    return Array.from({ length: this.rows() }, (_, row) =>
      this.paint(ditherBackdropLine(width, row)),
    );
  }

  invalidate(): void {}
}

function showSupervisorBackdrop(
  tui: SupervisorTui,
  theme: Theme | undefined,
): OverlayHandle | undefined {
  const backdrop = new InteractiveSupervisorBackdrop(
    () => Math.max(1, tui.terminal?.rows ?? 1),
    (text) => {
      const foreground =
        typeof theme?.fg === "function" ? theme.fg("dim", text) : text;
      return typeof theme?.bg === "function"
        ? theme.bg("customMessageBg", foreground)
        : foreground;
    },
  );
  if (typeof tui.showOverlay !== "function") return undefined;
  return tui.showOverlay(backdrop, {
    anchor: "center",
    width: "100%",
    maxHeight: "100%",
    nonCapturing: true,
  });
}

export async function showInteractiveSupervisor(
  ui: ExtensionUIContext,
  options: Omit<
    InteractiveSupervisorOptions,
    "done" | "requestRender" | "notify"
  > = {},
): Promise<InteractiveSupervisorAction> {
  const custom = (ui as ExtensionUIContext & { custom?: Function }).custom;
  let component: InteractiveSupervisorComponent | undefined;
  let backdrop: OverlayHandle | undefined;
  let registeredDone: SupervisorDone | undefined;
  if (typeof custom !== "function") {
    ui.notify(
      "The async subagent supervisor is only available in Pi TUI sessions. Use the status and cancellation tools in this mode.",
      "info",
    );
    return { kind: "close" };
  }

  try {
    return await custom.call(
      ui,
      (
        tui: SupervisorTui,
        theme: Theme | undefined,
        _kb: unknown,
        done: SupervisorDone,
      ) => {
        registeredDone = done;
        activeDoneHandles.add(done);
        backdrop = showSupervisorBackdrop(tui, theme);
        component = new InteractiveSupervisorComponent({
          ...options,
          done,
          requestRender: () => tui.requestRender?.(),
          notify: (message, level) => ui.notify(message, level),
        });
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 60,
          maxHeight: "85%",
        },
      },
    );
  } finally {
    if (registeredDone) activeDoneHandles.delete(registeredDone);
    component?.dispose();
    backdrop?.hide();
  }
}

/** Close every open supervisor overlay, not just the most recent one. */
export function closeActiveInteractiveSupervisor(): void {
  for (const done of [...activeDoneHandles]) {
    activeDoneHandles.delete(done);
    done({ kind: "close" });
  }
}

export function formatSupervisorSummary(
  state: InteractiveSubagentState,
  now: number,
): string {
  const status = interactiveStatusForState(state);
  const icon = statusIcon(status);
  const elapsed = formatElapsed(Math.max(0, now - state.startedAt));
  const activity = compactText(
    state.lastToolSummary ?? state.lastToolName ?? "no activity yet",
  );
  return `${icon} ${status} ${compactText(state.name)} (${state.id.slice(0, 8)}) · ${state.mux} · ${elapsed} · ${activity}`;
}

function supervisorStates(): InteractiveSubagentState[] {
  return [...interactiveSubagentRegistry.values()].sort(compareByStartedAt);
}

/** Order by start time, tolerating a non-finite startedAt so the sort stays total. */
export function compareByStartedAt(
  left: { startedAt: number; id: string },
  right: { startedAt: number; id: string },
): number {
  const delta = finiteOrZero(left.startedAt) - finiteOrZero(right.startedAt);
  return delta === 0 ? left.id.localeCompare(right.id) : delta;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function supervisorItems(): AsyncSupervisorItem[] {
  return supervisorStates().map((state) => ({
    kind: "interactive",
    state,
    depth: 0,
    actionable: isInteractiveStateActive(state),
  }));
}

function supervisorItemKey(item: AsyncSupervisorItem): string {
  if (item.kind === "in-process") return `in-process:${item.job.id}`;
  if (item.kind === "workflow") return `workflow:${item.job.id}`;
  return `interactive:${item.state.id}`;
}

function interactiveState(
  item: AsyncSupervisorItem,
): InteractiveSubagentState | undefined {
  if (item.kind === "in-process" || item.kind === "workflow") return undefined;
  return item.state;
}

// Non-actionable items are filtered out of `items()` entirely (see
// supervisorItemIsActive), so every rendered row is actionable. The former
// "unavailable (…)" suffix, its per-action guards, and unavailableActionMessage
// were all unreachable and have been removed rather than made reachable —
// hiding is the intended design and the README documents it.
function supervisorItemIsActive(item: AsyncSupervisorItem): boolean {
  if (!item.actionable) return false;
  if (item.kind === "in-process") return item.job.status === "running";
  if (item.kind === "workflow") return item.job.status === "running";
  return isInteractiveStateActive(item.state);
}

function formatAsyncSupervisorSummary(
  item: AsyncSupervisorItem,
  now: number,
): string {
  if (item.kind === "in-process") {
    const job = item.job;
    const elapsed = formatElapsed(Math.max(0, now - job.startedAt));
    const activity = job.liveStatus.activeTool
      ? `tool: ${job.liveStatus.activeTool.name}`
      : `turn ${job.liveStatus.turn}`;
    return `[in-process] ${statusIcon(job.status)} ${job.status} ${job.id} · ${elapsed} · ${activity}`;
  }
  if (item.kind === "workflow") {
    const job = item.job;
    const elapsed = formatElapsed(Math.max(0, now - job.startedAt));
    const phase = job.snapshot.currentPhase
      ? ` · phase: ${job.snapshot.currentPhase}`
      : "";
    return `[workflow] ${statusIcon(job.status)} ${job.status} ${job.name} (${job.id}) · ${elapsed} · ${job.snapshot.agentsSpawned} agents · ${job.snapshot.runningCount ?? 0} running${phase}`;
  }
  const source = item.origin?.source ?? "registry";
  return `[${source}] ${formatSupervisorSummary(item.state, now)}`;
}

function formatAsyncDetails(
  item: AsyncSupervisorItem,
  width: number,
  artifact: SupervisorArtifactDetails | undefined,
): string[] {
  if (item.kind === "in-process") {
    return formatInProcessDetails(item.job, width);
  }
  if (item.kind === "workflow") {
    return formatWorkflowDetails(item.job, width);
  }
  return formatInteractiveDetails(item, width, artifact);
}

function formatInProcessDetails(job: JobState, width: number): string[] {
  const activeTool = job.liveStatus.activeTool?.name ?? "none";
  const fields = [
    `Job: ${job.id}`,
    `Model: ${job.modelLabel ?? "default"}`,
    `cwd: ${job.cwd ?? "unknown"}`,
    `Turn: ${job.liveStatus.turn}`,
    `Active tool: ${activeTool}`,
    `Usage: ${job.liveStatus.usage.input} input · ${job.liveStatus.usage.output} output`,
    `Output preview: ${compactText(job.liveStatus.output) || "none yet"}`,
  ];
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function formatWorkflowDetails(job: WorkflowJobState, width: number): string[] {
  const snapshot = job.snapshot;
  const allRecords = snapshot.agentRecords ?? [];
  const records = allRecords.slice(-DETAIL_WORKFLOW_AGENT_COUNT);
  const omitted =
    (snapshot.agentRecordsOmitted ?? 0) +
    Math.max(0, allRecords.length - records.length);
  const fields = [
    `Workflow: ${job.name} (${job.id})`,
    `Phase: ${snapshot.currentPhase ?? "none"}`,
    `Agents: ${snapshot.agentsSpawned} total · ${snapshot.runningCount ?? 0} running`,
    `Errors: ${snapshot.errorCount}`,
    `Output tokens: ${snapshot.tokensSpent}`,
    `Last activity: ${snapshot.lastMessage ?? "none yet"}`,
  ];
  if (omitted > 0) fields.push(`… ${omitted} older agent records omitted`);
  for (const record of records) {
    const label = record.label ?? "agent";
    const model = record.model ? ` @${record.model}` : "";
    const phase = record.phase ? ` (${record.phase})` : "";
    fields.push(
      `Agent: ${statusIcon(record.status)} ${record.status} ${label} #${record.agentId}${model}${phase}`,
    );
  }
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function formatInteractiveDetails(
  item: InteractiveSupervisorItem,
  width: number,
  artifact: SupervisorArtifactDetails | undefined,
): string[] {
  const state = item.state;
  // Every interpolated value is compacted: a multi-line task prompt (the common
  // case) would otherwise emit a literal newline inside one row and break the
  // box drawing, since trunc bounds by length only.
  const fields = [
    `Origin: ${formatInteractiveOrigin(item)}`,
    `Task: ${compactText(state.task)}`,
    `Model: ${compactText(state.model ?? "default")}`,
    `Pane: ${compactText(`${state.mux}:${state.paneId}${state.muxSession ? ` session=${state.muxSession}` : ""}`)}`,
    `cwd: ${compactText(state.cwd)}`,
    `Artifact: ${compactText(state.artifactDir)}`,
    `Pi session: ${compactText(state.sessionFile)}`,
    `Lifecycle: ${artifact?.lifecycle ?? "loading…"}`,
    `Recent events: ${artifact?.events ?? "loading…"}`,
    `Output preview: ${artifact?.output ?? "loading…"}`,
  ];
  if (!(state.mux === "tmux" && process.env.TMUX)) {
    fields.push(`Attach: ${compactText(state.attachCommand)}`);
  }
  fields.push(`Focus: ${compactText(state.selectPaneCommand)}`);
  fields.push(`Return: ${focusReturnHint(state)}`);
  return fields.map((field) => trunc(`│     ${field}`, width));
}

function formatInteractiveOrigin(item: InteractiveSupervisorItem): string {
  const origin = item.origin;
  const source =
    origin?.source === "lineage" ? "persisted lineage" : "live registry";
  const owner =
    origin?.ownerSessionId ?? item.state.parentSessionId ?? "unknown";
  const details = [source, `owner=${compactText(owner)}`];
  if (origin?.rootId) details.push(`root=${compactText(origin.rootId)}`);
  if (origin?.parentAgentId)
    details.push(`parent=${compactText(origin.parentAgentId)}`);
  return details.join(" · ");
}

function focusReturnHint(state: InteractiveSubagentState): string {
  if (state.mux === "tmux") {
    return state.windowName
      ? "tmux prefix + l (last window)"
      : "tmux prefix + ; (last pane)";
  }
  return state.windowName
    ? "Ctrl+t, then Tab (last tab)"
    : "Ctrl+p, then p (previous pane)";
}

async function readArtifactDetails(
  state: InteractiveSubagentState,
): Promise<SupervisorArtifactDetails> {
  const lifecycle = state.lifecycle
    ? compactText(
        [
          state.lifecycle.currentTurnId &&
            `turn=${state.lifecycle.currentTurnId}`,
          state.lifecycle.completionOutcome &&
            `completion=${state.lifecycle.completionOutcome}`,
          state.lifecycle.processStatus &&
            `process=${state.lifecycle.processStatus}`,
          state.lifecycle.parentCancelled && "parent-cancelled",
        ]
          .filter(Boolean)
          .join(" · "),
      ) || "active"
    : "not folded yet";
  // Sentinel artifactDir means no real on-disk artifact root — do not
  // join/read relative to the parent's cwd (e.g. ./unknown/events.ndjson).
  if (state.artifactDir === "unknown") {
    return { lifecycle, events: "none yet", output: "none yet" };
  }
  const [eventsTail, outputTail] = await Promise.all([
    readBoundedFileTail(
      join(state.artifactDir, "events.ndjson"),
      DETAIL_EVENTS_MAX_BYTES,
    ),
    readBoundedFileTail(
      join(state.artifactDir, "output.md"),
      DETAIL_OUTPUT_MAX_BYTES,
    ),
  ]);
  const events = summarizeRecentEvents(eventsTail);
  const output = compactText(outputTail);
  return {
    lifecycle,
    events: events || "none yet",
    output: output || "none yet",
  };
}

async function readBoundedFileTail(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  let handle: fsTypes.FileHandle | undefined;
  try {
    // lstat, not stat: a symlink here is not a file we agreed to read.
    if (!(await fs.lstat(filePath)).isFile()) return "";
    handle = await fs.open(filePath, "r");
    // Size from the open handle, so the read offset cannot refer to a
    // different file than the one that was measured.
    const size = (await handle.stat()).size;
    const bytes = Math.min(size, maxBytes);
    if (bytes <= 0) return "";
    const buffer = Buffer.alloc(bytes);
    // Honour the short-read count: a file truncated between stat and read
    // would otherwise leave zero padding in the buffer and silently corrupt
    // the NDJSON parse.
    const { bytesRead } = await handle.read(buffer, 0, bytes, size - bytes);
    const filled = buffer.subarray(0, Math.max(0, bytesRead));
    // Drop leading UTF-8 continuation bytes so a mid-sequence cut does
    // not decode as U+FFFD.
    let start = 0;
    while (start < filled.length && (filled[start]! & 0xc0) === 0x80) {
      start++;
    }
    return filled.subarray(start).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function summarizeRecentEvents(content: string): string {
  const summaries: string[] = [];
  for (const line of content.trim().split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.type !== "string") continue;
      const detail =
        typeof event.outcome === "string"
          ? event.outcome
          : typeof event.name === "string"
            ? event.name
            : undefined;
      summaries.push(detail ? `${event.type}(${detail})` : event.type);
    } catch {
      /* A bounded tail may begin in the middle of an event record. */
    }
  }
  return summaries.slice(-DETAIL_EVENT_COUNT).join(" → ");
}

function compactText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_PREVIEW_MAX_CHARS);
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "→";
    case "idle":
      return "●";
    case "cancelled":
      return "⊘";
    case "done":
    case "exited":
      return "✓";
    case "error":
      return "✗";
    case "unknown":
    default:
      return "?";
  }
}

function formatElapsed(milliseconds: number): string {
  // A manifest with an unparseable startedAt reaches here as NaN, which used to
  // render as the literal "NaNs".
  if (!Number.isFinite(milliseconds)) return "?";
  const seconds = Math.floor(Math.max(0, milliseconds) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

function trunc(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}
