import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  compareByStartedAt,
  INTERACTIVE_SUPERVISOR_SHORTCUT,
  type AsyncSupervisorItem,
  type InteractiveSupervisorItem,
  showInteractiveSupervisor,
} from "./interactive-supervisor-ui";
import {
  cancelInteractiveSubagent,
  cancelInteractiveDescendantByState,
  captureInteractiveSubagent,
  focusInteractiveSubagent,
  interactiveSubagentHasAttachedClient,
  interactiveSubagentRegistry,
  initializeInteractiveStateMachine,
  interactiveStatusForState,
  isInteractiveStateActive,
  showInteractiveSubagentNativeViewer,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  cancelLineageSubtreeBestEffort,
  flattenLineageTree,
  projectLineageStore,
  pruneTerminalLineageNodes,
  resolveLineageStorePaths,
  type CancelSubtreeResult,
  type LineageManifest,
  type ProjectedLineageNode,
  type ProjectionIssue,
} from "./interactive-lineage";
import { getMux, type MuxName, type PaneLiveness } from "./multiplexer";
import {
  abortJobTree,
  inProcessJobBelongsToOwner,
  jobRegistry,
  scheduleJobCleanup,
  type JobState,
} from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { updateRunningSubagentFooter } from "./artifact-poller";
import {
  normalizeCancelledWorkflowState,
  workflowJobsForOwner,
} from "./workflow-jobs";
import type {
  ActiveSessionContextToken,
  SessionContextRef,
} from "./session-context";

const SUPERVISOR_CAPTURE_MAX_BYTES = 16 * 1024;
const SUPERVISOR_CAPTURE_MAX_LINES = 200;

interface SupervisorProjection {
  items: InteractiveSupervisorItem[];
  nodes: Map<string, ProjectedLineageNode>;
  /** Raw manifests, including nodes the caps dropped — subtree cancel needs them. */
  manifests: LineageManifest[];
  issues: ProjectionIssue[];
  truncated: boolean;
}

export function directSupervisorItems(
  sessionId?: string,
): InteractiveSupervisorItem[] {
  return [...interactiveSubagentRegistry.values()]
    .filter(
      (state) => sessionId === undefined || state.parentSessionId === sessionId,
    )
    .sort(compareByStartedAt)
    .map((state) => ({
      kind: "interactive",
      state,
      depth: 0,
      actionable: isInteractiveStateActive(state),
      origin: {
        source: "registry",
        ownerSessionId: state.parentSessionId,
      },
    }));
}

export function buildAsyncSupervisorItems(
  interactiveItems: InteractiveSupervisorItem[],
  owner: ActiveSessionContextToken | undefined,
): AsyncSupervisorItem[] {
  const processJobs = [...jobRegistry.values()]
    .filter((job) => inProcessJobBelongsToOwner(job, owner))
    .sort(compareByStartedAt);
  const visibleJobs = new Map(processJobs.map((job) => [job.id, job]));
  const processItems: AsyncSupervisorItem[] = processJobs.map((job) => ({
    kind: "in-process",
    job,
    depth: inProcessSupervisorDepth(job, visibleJobs),
    actionable: job.status === "running",
  }));
  const workflowItems: AsyncSupervisorItem[] = workflowJobsForOwner(owner)
    .sort(compareByStartedAt)
    .map((job) => ({
      kind: "workflow",
      job,
      depth: 0,
      actionable: job.status === "running",
    }));
  const normalizedInteractive: AsyncSupervisorItem[] = interactiveItems.map(
    (item) => ({ ...item, kind: "interactive" }),
  );
  return [...processItems, ...workflowItems, ...normalizedInteractive];
}

function inProcessSupervisorDepth(
  job: JobState,
  visibleJobs: Map<string, JobState>,
  visiting = new Set<string>(),
): number {
  const parent = job.parentJobId ? visibleJobs.get(job.parentJobId) : undefined;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(job.id);
  if (!job.parentJobId || visiting.has(job.id)) return 0;
  if (!parent) return 0;
  return 1 + inProcessSupervisorDepth(parent, visibleJobs, nextVisiting);
}

function muxNameForManifest(manifest: LineageManifest): MuxName | undefined {
  if (manifest.pane.backend === "tmux") return "tmux";
  if (manifest.pane.backend === "zellij") return "zellij";
  return undefined;
}

function stateForNode(
  node: ProjectedLineageNode,
  paneLivenessById?: Map<string, PaneLiveness>,
): InteractiveSubagentState | undefined {
  const manifest = node.manifest;
  const mux = muxNameForManifest(manifest);
  if (!mux) return undefined;
  const existing = interactiveSubagentRegistry.get(manifest.agentId);
  if (existing) return existing;
  const paneLiveness = paneLivenessById?.get(manifest.agentId);
  // tmux's buildAttachCommands resolves the pane's window via execMuxOrThrow,
  // which THROWS for a dead pane. It runs for every projected node, so one
  // finished tmux agent used to make the whole projection reject and the overlay
  // silently degrade to registry-only. Fall back to a session-less string.
  let attach = { attachCommand: "unavailable", focusCommand: "unavailable" };
  try {
    attach = getMux({ preference: mux }).buildAttachCommands({
      paneId: manifest.pane.paneId,
      windowName: manifest.pane.windowName,
      session: manifest.pane.muxSession,
    });
  } catch {
    const target = manifest.pane.windowName ?? manifest.pane.paneId;
    const detail =
      paneLiveness?.kind === "dead"
        ? `pane ${target} is gone`
        : `pane ${target} could not be resolved`;
    attach = {
      attachCommand: `unavailable (${detail})`,
      focusCommand: `unavailable (${detail})`,
    };
  }
  // Liveness comes from the pane probe, not from `node.state`. Deriving it from
  // the same field the actionable gate then tests made that gate a tautology
  // for lineage-only nodes, and mislabelled a live pane hidden for a cycle.
  const state: InteractiveSubagentState = {
    id: manifest.agentId,
    name: manifest.name,
    task: manifest.taskPreview,
    paneId: manifest.pane.paneId,
    windowName: manifest.pane.windowName,
    mux,
    muxSession: manifest.pane.muxSession,
    sessionFile: manifest.childSessionFile ?? "unknown",
    cwd: manifest.cwd,
    parentSessionId: manifest.ownerSessionId,
    startedAt: parseStartedAt(manifest.startedAt),
    status: "unknown",
    attachCommand: attach.attachCommand,
    selectPaneCommand: attach.focusCommand,
    launchScriptFile: "unknown",
    artifactDir: manifest.artifactDir ?? "unknown",
  };
  const initialPane: PaneLiveness =
    paneLiveness ??
    (node.state === "actionable" ? { kind: "alive" } : { kind: "unknown" });
  initializeInteractiveStateMachine(state, initialPane);
  return state;
}

/**
 * `validateLineageManifest` rejects an unparseable startedAt, but a manifest can
 * still reach here from other sources. NaN would render as "NaNs" and make the
 * startedAt comparators non-transitive.
 */
function parseStartedAt(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadSupervisorProjection(
  sessionId: string | undefined,
): Promise<SupervisorProjection | undefined> {
  const rootId = process.env.PI_SUBAGENTURA_ROOT_ID ?? sessionId;
  if (!rootId) return undefined;
  const sessionRoot =
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT ??
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  const paths = await resolveLineageStorePaths(sessionRoot, rootId);
  // Reused across the projection AND the prune sweep so no manifest is probed
  // twice per refresh.
  const paneLivenessById = new Map<string, PaneLiveness>();
  const isNodeStale = async (manifest: LineageManifest): Promise<boolean> => {
    const cached = paneLivenessById.get(manifest.agentId);
    if (cached !== undefined) return cached.kind === "dead";
    if (
      manifest.pane.backend !== "tmux" &&
      manifest.pane.backend !== "zellij"
    ) {
      paneLivenessById.set(manifest.agentId, {
        kind: "unknown",
        reason: `unsupported pane backend ${manifest.pane.backend}`,
      });
      return false;
    }
    let paneLiveness: PaneLiveness;
    try {
      paneLiveness = await getMux({
        preference: manifest.pane.backend,
      }).observePane(manifest.pane.paneId, manifest.pane.muxSession);
    } catch (error) {
      paneLiveness = { kind: "unavailable", reason: errorMessage(error) };
    }
    paneLivenessById.set(manifest.agentId, paneLiveness);
    return paneLiveness.kind === "dead";
  };
  const projection = await projectLineageStore(
    paths.nodesDir,
    basename(paths.treeDir),
    isNodeStale,
  );
  // Nothing else unlinks a node manifest, so without this sweep the store grows
  // by one file per spawn forever and the spawn gate eventually refuses every
  // new agent. Probes are already cached above, so the sweep costs no extra
  // subprocesses. Best effort: a failed prune is retried on the next refresh.
  await pruneTerminalLineageNodes(paths.nodesDir, isNodeStale).catch(
    () => undefined,
  );
  const flattened = flattenLineageTree(projection.roots);
  const seen = new Set(flattened.map((node) => node.manifest.agentId));
  for (const node of projection.nonActionable) {
    if (!seen.has(node.manifest.agentId)) {
      flattened.push(node);
      seen.add(node.manifest.agentId);
    }
  }
  const items = flattened.flatMap((node): InteractiveSupervisorItem[] => {
    const state = stateForNode(node, paneLivenessById);
    if (!state) return [];
    return [
      {
        state,
        depth: node.depth,
        actionable:
          node.state === "actionable" && isInteractiveStateActive(state),
        origin: {
          source: "lineage",
          rootId: node.manifest.rootId,
          ownerSessionId: node.manifest.ownerSessionId,
          parentAgentId: node.manifest.parentAgentId,
        },
      },
    ];
  });
  for (const state of interactiveSubagentRegistry.values()) {
    if (sessionId !== undefined && state.parentSessionId !== sessionId)
      continue;
    if (!seen.has(state.id)) {
      items.push({
        state,
        depth: 0,
        actionable: isInteractiveStateActive(state),
        origin: {
          source: "registry",
          ownerSessionId: state.parentSessionId,
        },
      });
      seen.add(state.id);
    }
  }
  return {
    items,
    nodes: new Map(flattened.map((node) => [node.manifest.agentId, node])),
    manifests: projection.manifests,
    issues: projection.issues,
    truncated: projection.truncated,
  };
}

/**
 * Warning lines for the overlay footer.
 *
 * `projection.issues` and `truncated` were computed carefully and then thrown
 * away, which is the mechanism by which a dropped node, an orphan, a cycle, or
 * an unreadable manifest produced zero user-visible signal.
 */
export function supervisorStatusLines(
  projection: SupervisorProjection | undefined,
  refreshError: string | undefined,
): string[] {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const issue of projection?.issues ?? []) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  const hidden = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (hidden > 0) {
    const detail = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${count} ${kind === "truncated" ? "cap" : kind}`)
      .join(", ");
    lines.push(
      `⚠ ${hidden} lineage node${hidden === 1 ? "" : "s"} hidden (${detail})`,
    );
  }
  if (projection?.truncated) {
    lines.push(
      "⚠ lineage view is truncated — subtree cancellation may reach nodes not listed here",
    );
  }
  if (refreshError) {
    lines.push(`⚠ lineage refresh failing: ${refreshError}`);
  }
  return lines;
}

export function registerInteractiveSupervisor(
  pi: ExtensionAPI,
  sessionContext?: SessionContextRef,
): void {
  const owner = (): ActiveSessionContextToken | undefined =>
    sessionContext
      ? { id: sessionContext.id, generation: sessionContext.generation }
      : undefined;
  const open = async (ctx: {
    ui: Parameters<typeof showInteractiveSupervisor>[0];
    sessionManager?: { getSessionId?: () => string };
  }) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const activeOwner = owner();
    let refreshError: string | undefined;
    let projection = await loadSupervisorProjection(sessionId).catch(
      (error: unknown) => {
        refreshError = errorMessage(error);
        return undefined;
      },
    );
    await showInteractiveSupervisor(ctx.ui, {
      items: () =>
        buildAsyncSupervisorItems(
          projection?.items ?? directSupervisorItems(sessionId),
          activeOwner,
        ),
      status: () => supervisorStatusLines(projection, refreshError),
      refresh: async () => {
        // A swallowed failure used to freeze the snapshot indefinitely with no
        // indication; the error now reaches the overlay footer.
        try {
          projection = await loadSupervisorProjection(sessionId);
          refreshError = undefined;
        } catch (error) {
          refreshError = errorMessage(error);
        }
      },
      focus: focusInteractiveSubagent,
      hasAttachedClient: interactiveSubagentHasAttachedClient,
      view: async (state) => {
        const capture = await captureInteractiveSubagent(state, {
          maxBytes: SUPERVISOR_CAPTURE_MAX_BYTES,
          maxLines: SUPERVISOR_CAPTURE_MAX_LINES,
        });
        const suffix = capture.truncated ? "\n… output truncated" : "";
        ctx.ui.notify(
          capture.output.length > 0
            ? `${state.name} terminal output:\n${capture.output}${suffix}`
            : `${state.name} has no captured terminal output yet.`,
          "info",
        );
      },
      nativeView: async (state) => {
        const capture = await captureInteractiveSubagent(state, {
          maxBytes: SUPERVISOR_CAPTURE_MAX_BYTES,
          maxLines: SUPERVISOR_CAPTURE_MAX_LINES,
        });
        const opened = await showInteractiveSubagentNativeViewer(
          state,
          capture.output ||
            `${state.name} has no captured terminal output yet.`,
        );
        if (!opened) {
          ctx.ui.notify(
            "Native presentation is unavailable here; continuing with the portable Pi overlay.",
            "info",
          );
        }
      },
      cancelInProcess: (job) => {
        if (!cancelInProcessFromSupervisor(job, sessionId)) return false;
        updateRunningSubagentFooter(ctx.ui);
        return true;
      },
      cancelWorkflow: (job) => {
        if (job.status !== "running") return false;
        job.abort.abort();
        job.status = "cancelled";
        normalizeCancelledWorkflowState(job);
        return true;
      },
      cancel: (id) => {
        const direct = cancelInteractiveSubagent(id);
        if (direct) {
          updateRunningSubagentFooter(ctx.ui);
          return direct;
        }
        const item = projection?.items.find(
          (candidate) => candidate.state.id === id,
        );
        if (!item?.actionable) return undefined;
        cancelInteractiveDescendantByState(item.state);
        updateRunningSubagentFooter(ctx.ui);
        return item.state;
      },
      cancelSubtree: async (state) => {
        // Snapshot the tree BEFORE the confirm blocks for human time. The 1 Hz
        // refresh reassigns `projection` while the dialog is open, so reading it
        // afterwards acted on a newer tree than the one the user confirmed.
        const snapshotRoot = projection?.nodes.get(state.id);
        const snapshotManifests = projection?.manifests ?? [];
        const snapshotTruncated = projection?.truncated === true;
        const descendantCount = snapshotRoot
          ? subtreeManifestIds(snapshotRoot, snapshotManifests).size - 1
          : 0;
        const truncationWarning = snapshotTruncated
          ? " The lineage view is truncated, so the tree may be larger than shown."
          : "";
        const confirmed = await ctx.ui.confirm(
          "Cancel interactive subagent subtree?",
          `Cancel ${state.name} and its ${descendantCount} descendant${descendantCount === 1 ? "" : "s"}? This closes their mux panes but retains artifacts.${truncationWarning}`,
        );
        if (!confirmed) return;
        if (!snapshotRoot) {
          cancelInteractiveSubagent(state.id);
          updateRunningSubagentFooter(ctx.ui);
          return;
        }
        const result = await cancelLineageSubtreeBestEffort(snapshotRoot, {
          // The raw manifest set, so descendants past maxDepth or the node cap
          // are cancelled instead of left running under a dead parent.
          allManifests: snapshotManifests,
          projectionTruncated: snapshotTruncated,
          isStale: async (node) =>
            node.state !== "actionable" ||
            muxNameForManifest(node.manifest) === undefined,
          isTerminal: async (node) => {
            const direct = interactiveSubagentRegistry.get(
              node.manifest.agentId,
            );
            if (!direct) return false;
            const status = interactiveStatusForState(direct);
            return status === "cancelled" || status === "exited";
          },
          cancel: async (node) => {
            const nodeState = stateForNode(node);
            if (!nodeState) return;
            if (!cancelInteractiveSubagent(nodeState.id)) {
              cancelInteractiveDescendantByState(nodeState);
            }
          },
        });
        updateRunningSubagentFooter(ctx.ui);
        ctx.ui.notify(
          formatSubtreeCancellation(result),
          result.failed.length > 0 ||
            result.projectionTruncated ||
            result.recovered.length > 0
            ? "warning"
            : "info",
        );
      },
    });
  };

  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut(INTERACTIVE_SUPERVISOR_SHORTCUT, {
      description: "Open the async subagent supervisor",
      handler: open,
    });
  }
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("subagents", {
      description: "Open the async subagent supervisor",
      handler: async (_args, ctx) => open(ctx),
    });
  }
}

/** Agent ids in a subtree, derived from raw parent links (cycle-safe). */
function subtreeManifestIds(
  root: ProjectedLineageNode,
  manifests: LineageManifest[],
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const manifest of manifests) {
    if (!manifest.parentAgentId) continue;
    const siblings = childrenByParent.get(manifest.parentAgentId) ?? [];
    siblings.push(manifest.agentId);
    childrenByParent.set(manifest.parentAgentId, siblings);
  }
  const ids = new Set<string>();
  const stack = [root.manifest.agentId];
  while (stack.length > 0) {
    const agentId = stack.pop()!;
    if (ids.has(agentId)) continue;
    ids.add(agentId);
    stack.push(...(childrenByParent.get(agentId) ?? []));
  }
  return ids;
}

/**
 * Report skip reasons separately. "N stale" used to absorb cycles, orphans and
 * cap truncation, telling the user the wrong thing about what was not cancelled.
 */
export function formatSubtreeCancellation(result: CancelSubtreeResult): string {
  const parts = [
    `${result.cancelled.length} cancelled`,
    `${result.alreadyTerminal.length} already terminal`,
  ];
  const buckets: [string, string[]][] = [
    ["stale", result.stale],
    ["orphaned", result.orphan],
    ["cyclic", result.cycle],
    ["beyond the cap", result.truncated],
    ["malformed", result.malformed],
  ];
  for (const [label, ids] of buckets) {
    if (ids.length > 0) parts.push(`${ids.length} ${label}`);
  }
  parts.push(`${result.failed.length} failed`);
  const suffixes: string[] = [];
  if (result.recovered.length > 0) {
    suffixes.push(
      `${result.recovered.length} descendant${result.recovered.length === 1 ? "" : "s"} were missing from the displayed tree and were reached via the raw lineage manifests`,
    );
  }
  if (result.projectionTruncated) {
    suffixes.push(
      "the lineage view was truncated, so treat this result as incomplete",
    );
  }
  const suffix = suffixes.length > 0 ? ` ⚠ ${suffixes.join("; ")}.` : "";
  return `Subtree cancellation: ${parts.join(", ")}.${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelInProcessFromSupervisor(
  job: JobState,
  sessionId: string | undefined,
): boolean {
  const info = {
    source: "supervisor" as const,
    initiator: sessionId,
    reason: `async supervisor cancelled job ${job.id}`,
  };
  if (job.status !== "running") return false;
  job.cancellation = { ...info, at: Date.now() };
  job.cancellationSnapshot = snapshotInProcessSession({
    kind: "in-process",
    jobId: job.id,
    session: job.session,
    cwd: job.cwd ?? process.cwd(),
    parentSessionId: sessionId,
    model: job.modelLabel,
    activeTool: job.liveStatus.activeTool,
    partialOutput: job.liveStatus.output,
    startedAt: job.startedAt,
    source: "supervisor",
    initiator: info.initiator,
    reason: info.reason,
  });
  abortJobTree(job.id, info);
  job.status = "cancelled";
  scheduleJobCleanup(job.id, true);
  return true;
}
