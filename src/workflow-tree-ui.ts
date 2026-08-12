import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  getWorkflowCompletionPresentation,
  workflowJobsForOwner,
  type WorkflowJobState,
  type WorkflowJobStatus,
} from "./workflow-jobs";
import {
  formatWorkflowUsage,
  formatWorkflowUsageFields,
  formatWorkflowUsageLegend,
  presentWorkflowUsage,
} from "./workflow-core";
import { formatWorkflowPlanRows } from "./workflow-plan-ui";
import type { WorkflowPlanState } from "./workflow-plan-state";
import type { SessionOwnerToken } from "./session-scope";
import type { WorkflowProjection } from "./workflow-projection-repository";
import type { WorkflowRunStatus } from "./workflow-run-types";

const MAX_WORKFLOW_TREE_AGENT_ROWS = 20;

type WorkflowSnapshotWithPlanState = WorkflowJobState["snapshot"] & {
  planState?: WorkflowPlanState;
};

export type WorkflowTreeAction =
  { kind: "cancel"; workflowId: string } | { kind: "close" };

type WorkflowTreeDone = (action: WorkflowTreeAction) => void;

interface WorkflowTreeOptions {
  done: WorkflowTreeDone;
  owner?: SessionOwnerToken;
  durableProjections?: readonly WorkflowProjection[];
  requestRender?: () => void;
  notify?: (message: string) => void;
  durableRuns?: readonly WorkflowProjection[];
  cancelDurable?: (
    workflowId: string,
  ) => Promise<WorkflowProjection | undefined>;
}

interface DurableWorkflowTreeJob {
  durable: true;
  id: string;
  name: string;
  status: WorkflowJobStatus;
  durableStatus: WorkflowRunStatus;
  startedAt: number;
  abort: AbortController;
  snapshot: WorkflowJobState["snapshot"];
  projection: WorkflowProjection;
  error?: string;
}
type WorkflowTreeJob = WorkflowJobState | DurableWorkflowTreeJob;

interface WorkflowRow {
  job: WorkflowTreeJob;
  depth: number;
  text: string;
  selectable: boolean;
}

type WorkflowTreeSelection =
  | { kind: "live"; id: string; job: WorkflowJobState }
  | { kind: "durable"; id: string; projection: WorkflowProjection };

export class WorkflowTreeComponent {
  private selectedWorkflowIndex = 0;
  private expanded = new Set<string>();
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly opts: WorkflowTreeOptions) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const rows = this.rows();
    const lines: string[] = [];
    lines.push(trunc("┌ Workflow Tree", width));
    lines.push(
      trunc(
        "│ ↑↓ select • enter/→ expand • ← collapse • c cancel • q/esc close",
        width,
      ),
    );
    lines.push(trunc(`│ ${formatWorkflowUsageLegend()}`, width));

    if (rows.length === 0) {
      lines.push(trunc("│ No workflow jobs.", width));
    } else {
      let workflowOrdinal = -1;
      for (const row of rows) {
        if (row.selectable) workflowOrdinal++;
        const selected =
          row.selectable && workflowOrdinal === this.selectedWorkflowIndex;
        const marker = selected ? "▶" : row.selectable ? "○" : " ";
        const indent = "  ".repeat(row.depth);
        lines.push(trunc(`│ ${marker} ${indent}${row.text}`, width));
      }
    }

    lines.push(trunc(`└${"─".repeat(Math.max(0, width - 2))}┘`, width));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    const jobs = selectableJobs(this.opts.owner, this.opts.durableRuns);
    if (data === "q" || data === "\x1b") {
      this.opts.done({ kind: "close" });
      return;
    }
    if (jobs.length === 0) return;

    if (data === "\x1b[A" || data === "k") {
      this.selectedWorkflowIndex = Math.max(0, this.selectedWorkflowIndex - 1);
      this.changed();
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.selectedWorkflowIndex = Math.min(
        jobs.length - 1,
        this.selectedWorkflowIndex + 1,
      );
      this.changed();
      return;
    }

    const selected = jobs[this.selectedWorkflowIndex];
    if (!selected) return;

    if (data === "\r" || data === "\n" || data === "\x1b[C") {
      this.toggle(selected.id);
      return;
    }
    if (data === "\x1b[D") {
      this.expanded.delete(selected.id);
      this.changed();
      return;
    }
    if (data === "c") {
      this.cancel(selected);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private rows(): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const job of selectableJobs(this.opts.owner, this.opts.durableRuns)) {
      const isExpanded = this.expanded.has(job.id);
      rows.push({
        job,
        depth: 0,
        selectable: true,
        text: `${isExpanded ? "▾" : "▸"} ${formatWorkflowSummary(job)}`,
      });
      if (isExpanded) rows.push(...formatWorkflowDetails(job));
    }
    return rows;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private cancel(job: WorkflowTreeJob): void {
    if (job.status !== "running") {
      this.opts.notify?.(
        `Workflow ${job.id} is ${
          isDurableTreeJob(job) ? job.durableStatus : job.status
        }; nothing to cancel.`,
      );
      return;
    }
    if (isDurableTreeJob(job)) {
      if (!this.opts.cancelDurable) {
        this.opts.notify?.(
          `Durable workflow ${job.id} cannot be cancelled here.`,
        );
        return;
      }
      void this.opts
        .cancelDurable(job.id)
        .then((projection) => {
          if (projection) {
            job.projection = projection;
            job.durableStatus = projection.status;
            job.status = durableJobStatus(projection.status);
          }
          this.opts.notify?.(`Durable workflow ${job.id} cancelled.`);
          this.changed();
          this.opts.done({ kind: "cancel", workflowId: job.id });
        })
        .catch((error: unknown) => {
          this.opts.notify?.(
            `Unable to cancel durable workflow ${job.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          this.changed();
        });
      return;
    }
    job.abort.abort();
    job.status = "cancelled";
    normalizeCancelledWorkflowState(job);
    this.opts.notify?.(`Cancelled workflow ${job.id}.`);
    this.changed();
    this.opts.done({ kind: "cancel", workflowId: job.id });
  }

  private changed(): void {
    this.invalidate();
    this.opts.requestRender?.();
  }
}

export interface WorkflowTreeDataOptions {
  listDurable?: () => Promise<readonly WorkflowProjection[]>;
  cancelDurable?: (
    workflowId: string,
  ) => Promise<WorkflowProjection | undefined>;
}

export async function showWorkflowTree(
  ui: ExtensionUIContext,
  owner?: SessionOwnerToken,
  data?: WorkflowTreeDataOptions,
): Promise<WorkflowTreeAction> {
  const custom = (ui as any).custom;
  if (typeof custom !== "function") {
    ui.notify("Workflow tree UI is not available in this Pi session.");
    return { kind: "close" };
  }
  const durableRuns = (await data?.listDurable?.()) ?? [];
  return custom.call(
    ui,
    (
      tui: { requestRender?: () => void },
      _theme: unknown,
      _kb: unknown,
      done: WorkflowTreeDone,
    ) =>
      new WorkflowTreeComponent({
        done,
        owner,
        durableRuns,
        cancelDurable: data?.cancelDurable,
        requestRender: () => tui.requestRender?.(),
        notify: (message) => ui.notify(message),
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 60,
        maxHeight: "80%",
      },
    },
  );
}

function selectableJobs(
  owner?: SessionOwnerToken,
  durableRuns: readonly WorkflowProjection[] = [],
): WorkflowTreeJob[] {
  const durableById = new Map(
    durableRuns.map((projection) => [projection.runId, projection]),
  );
  const live = workflowJobsForOwner(owner).filter(
    (job) => !durableById.has(job.id),
  );
  // Durable rows replace stale live rows with the same ID, so terminal state
  // remains authoritative after registry loss or a delayed Promise settlement.
  return [...live, ...durableRuns.map(createDurableTreeJob)];
}

function isDurableTreeJob(job: WorkflowTreeJob): job is DurableWorkflowTreeJob {
  return "durable" in job && job.durable === true;
}

function durableJobStatus(status: WorkflowRunStatus): WorkflowJobStatus {
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function createDurableTreeJob(
  projection: WorkflowProjection,
): DurableWorkflowTreeJob {
  const tasks = Object.values(projection.tasks);
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const errorCount = tasks.filter((task) => task.status === "failed").length;
  return {
    durable: true,
    id: projection.runId,
    name: projection.runId,
    status: durableJobStatus(projection.status),
    durableStatus: projection.status,
    startedAt: 0,
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: tasks.filter(
        (task) =>
          task.status === "running" ||
          task.status === "succeeded" ||
          task.status === "failed",
      ).length,
      errorCount,
      tokensSpent: projection.usage.output,
      phases: projection.currentPhase ? [projection.currentPhase] : [],
      currentPhase: projection.currentPhase,
      runningCount,
      usage: undefined,
      agentRecords: [],
      agentRecordsOmitted: 0,
    },
    projection,
    error:
      projection.terminal?.error?.message ??
      (errorCount > 0 ? "one or more durable tasks failed" : undefined),
  };
}

function formatWorkflowSummary(job: WorkflowTreeJob): string {
  const s = job.snapshot;
  const errorCount = isDurableTreeJob(job)
    ? job.projection.terminal?.error
      ? 1
      : Object.values(job.projection.tasks).filter(
          (task) => task.status === "failed",
        ).length
    : (job.result?.errorCount ?? s.errorCount);
  const presentation = getWorkflowCompletionPresentation(
    job.status,
    errorCount,
  );
  const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
  const statusLabel = isDurableTreeJob(job)
    ? job.durableStatus
    : presentation.label;
  const parts = [
    `${statusPrefix}${job.name} (${job.id})`,
    `[${statusLabel}]`,
    `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
    `${s.runningCount ?? 0} running`,
  ];
  if (errorCount > 0) parts.push(`${errorCount} errors`);
  const usage = presentWorkflowUsage(s.usage);
  if (usage) {
    parts.push(formatWorkflowUsage(usage, { outputBudget: s.budgetTotal }));
  }
  const currentPhase = planState?.currentPhase ?? s.currentPhase;
  if (currentPhase) parts.push(`phase: ${currentPhase}`);
  return parts.join(" · ");
}

function formatWorkflowDetails(job: WorkflowTreeJob): WorkflowRow[] {
  const rows: WorkflowRow[] = [];
  if (isDurableTreeJob(job)) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: `Durable status: ${job.projection.status} (revision ${job.projection.revision})`,
    });
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: `Phase: ${job.projection.currentPhase ?? "none"}`,
    });
    for (const task of Object.values(job.projection.tasks)) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `Task ${task.id}: ${task.status}${
          task.attempt > 0 ? ` (attempt ${task.attempt})` : ""
        }`,
      });
    }
    if (job.projection.terminal) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `Terminal: ${JSON.stringify(job.projection.terminal)}`,
      });
    }
    return rows;
  }
  const usage = presentWorkflowUsage(job.snapshot.usage);
  if (usage) {
    for (const field of formatWorkflowUsageFields(usage, {
      outputBudget: job.snapshot.budgetTotal,
    })) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: field,
      });
    }
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: formatWorkflowUsageLegend(),
    });
  }

  const planState = (job.snapshot as WorkflowSnapshotWithPlanState).planState;
  if (planState) {
    for (const row of formatWorkflowPlanRows(planState)) {
      rows.push({
        job,
        depth: row.depth,
        selectable: false,
        text: row.text,
      });
    }
  } else {
    for (const phase of job.snapshot.phases) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `◆ phase: ${phase}`,
      });
    }
    const records = job.snapshot.agentRecords ?? [];
    const agentRows = records.slice(-MAX_WORKFLOW_TREE_AGENT_ROWS);
    const omittedForUi =
      (job.snapshot.agentRecordsOmitted ?? 0) +
      Math.max(0, records.length - agentRows.length);
    if (omittedForUi > 0) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `… ${omittedForUi} older agent records omitted`,
      });
    }
    for (const record of agentRows) {
      const marker =
        record.status === "running"
          ? "→"
          : record.status === "error"
            ? "✗"
            : record.status === "cancelled"
              ? "⊘"
              : "✓";
      const label = `${record.label ?? "agent"} #${record.agentId}`;
      const model = record.model ? ` @${record.model}` : "";
      const phase = record.phase ? ` (${record.phase})` : "";
      const recordUsage = presentWorkflowUsage(record.usage);
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: `${marker} ${record.status} ${label}${model}${phase}${
          recordUsage
            ? ` — ${formatWorkflowUsage(recordUsage, { ascii: true })}`
            : ""
        }`,
      });
    }
  }
  if (job.snapshot.lastMessage) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: job.snapshot.lastMessage,
    });
  }
  if (job.error) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: `error: ${job.error}`,
    });
  }
  if (rows.length === 0) {
    rows.push({
      job,
      depth: 1,
      selectable: false,
      text: "No phase or agent events yet.",
    });
  }
  return rows;
}

function trunc(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}
