import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  getWorkflowCompletionPresentation,
  normalizeCancelledWorkflowState,
  workflowJobsForOwner,
  type WorkflowJobState,
} from "./workflow-jobs";
import {
  formatWorkflowUsage,
  formatWorkflowUsageFields,
  formatWorkflowUsageLegend,
  presentWorkflowUsage,
} from "./workflow-core";
import {
  formatWorkflowPlanRows,
  formatWorkflowPlanSummary,
  sanitizeTerminalText,
} from "./workflow-plan-ui";
import type { SessionOwnerToken } from "./session-scope";
import type { WorkflowApprovalSnapshot } from "./workflow-approvals";
import type { DurableWorkflowProjection } from "./workflow-projection-repository";
import type {
  DurableWorkflowOwner,
  DurableWorkflowRunId,
} from "./workflow-run-types";

const MAX_WORKFLOW_TREE_AGENT_ROWS = 20;

export interface WorkflowTrustedResumeSnapshot {
  readonly runId: DurableWorkflowRunId;
  readonly executionKind: DurableWorkflowProjection["executionKind"];
  readonly expectedOwner: DurableWorkflowOwner;
  readonly expectedRunEpoch: number;
}

export type WorkflowTreeAction =
  | { kind: "cancel"; workflowId: string }
  | {
      kind: "approval";
      decision: "approved" | "denied";
      request: WorkflowApprovalSnapshot;
    }
  | { kind: "resume"; resume: WorkflowTrustedResumeSnapshot }
  | { kind: "close" };

type WorkflowTreeDone = (action: WorkflowTreeAction) => void;

interface WorkflowTreeOptions {
  done: WorkflowTreeDone;
  owner?: SessionOwnerToken;
  approvals?: readonly WorkflowApprovalSnapshot[];
  resumes?: readonly WorkflowTrustedResumeSnapshot[];
  requestRender?: () => void;
  notify?: (message: string) => void;
}

interface WorkflowTreeSelection {
  readonly id: string;
  readonly job?: WorkflowJobState;
  readonly approval?: WorkflowApprovalSnapshot;
  readonly resume?: WorkflowTrustedResumeSnapshot;
}

interface WorkflowRow {
  job?: WorkflowJobState;
  depth: number;
  text: string;
  selectable: boolean;
}

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

    const rows = this.rows(width);
    const lines: string[] = [];
    lines.push(trunc("┌ Workflow Tree", width));
    lines.push(
      trunc(
        "│ ↑↓ select • enter/→ expand • ← collapse • a approve • d deny • r resume • c cancel • q/esc close",
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
    const selections = selectableWorkflows(
      this.opts.owner,
      this.opts.approvals ?? [],
      this.opts.resumes ?? [],
    );
    if (data === "q" || data === "\x1b") {
      this.opts.done({ kind: "close" });
      return;
    }
    if (selections.length === 0) return;

    if (data === "\x1b[A" || data === "k") {
      this.selectedWorkflowIndex = Math.max(0, this.selectedWorkflowIndex - 1);
      this.changed();
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      this.selectedWorkflowIndex = Math.min(
        selections.length - 1,
        this.selectedWorkflowIndex + 1,
      );
      this.changed();
      return;
    }

    const selected = selections[this.selectedWorkflowIndex];
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
    if (data === "a" || data === "d") {
      if (selected.approval === undefined) {
        this.opts.notify?.(`Workflow ${selected.id} has no pending approval.`);
        return;
      }
      this.opts.done({
        kind: "approval",
        decision: data === "a" ? "approved" : "denied",
        request: selected.approval,
      });
      return;
    }
    if (data === "r") {
      if (selected.resume === undefined) {
        this.opts.notify?.(
          `Workflow ${selected.id} is not awaiting trusted resume.`,
        );
        return;
      }
      this.opts.done({ kind: "resume", resume: selected.resume });
      return;
    }
    if (data === "c") {
      if (selected.job === undefined) {
        this.opts.notify?.(`Workflow ${selected.id} has no live executor.`);
        return;
      }
      this.cancel(selected.job);
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private rows(width: number): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const selection of selectableWorkflows(
      this.opts.owner,
      this.opts.approvals ?? [],
      this.opts.resumes ?? [],
    )) {
      const isExpanded = this.expanded.has(selection.id);
      rows.push({
        ...(selection.job === undefined ? {} : { job: selection.job }),
        depth: 0,
        selectable: true,
        text: `${isExpanded ? "▾" : "▸"} ${
          selection.job !== undefined
            ? formatWorkflowSummary(selection.job, width)
            : selection.resume !== undefined
              ? `Durable ${selection.resume.executionKind} ${selection.id} [interrupted at epoch ${selection.resume.expectedRunEpoch}]`
              : `Durable workflow ${selection.id} [awaiting approval]`
        }`,
      });
      if (!isExpanded) continue;
      if (selection.job !== undefined) {
        rows.push(...formatWorkflowDetails(selection.job, width));
      }
      if (selection.approval !== undefined) {
        rows.push({
          ...(selection.job === undefined ? {} : { job: selection.job }),
          depth: 1,
          selectable: false,
          text:
            `approval ${selection.approval.requestId} · ` +
            `${selection.approval.description} · denial=${selection.approval.denialPolicy}`,
        });
      }
      if (selection.resume !== undefined) {
        rows.push({
          ...(selection.job === undefined ? {} : { job: selection.job }),
          depth: 1,
          selectable: false,
          text: `trusted resume · ${selection.resume.executionKind} · epoch ${selection.resume.expectedRunEpoch}`,
        });
      }
    }
    return rows;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.changed();
  }

  private cancel(job: WorkflowJobState): void {
    if (job.status !== "running") {
      this.opts.notify?.(
        `Workflow ${job.id} is ${job.status}; nothing to cancel.`,
      );
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

export async function showWorkflowTree(
  ui: ExtensionUIContext,
  owner?: SessionOwnerToken,
  approvals: readonly WorkflowApprovalSnapshot[] = [],
  resumes: readonly WorkflowTrustedResumeSnapshot[] = [],
): Promise<WorkflowTreeAction> {
  const custom = (ui as any).custom;
  if (typeof custom !== "function") {
    ui.notify("Workflow tree UI is not available in this Pi session.");
    return { kind: "close" };
  }
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
        approvals,
        resumes,
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

function selectableWorkflows(
  owner: SessionOwnerToken | undefined,
  approvals: readonly WorkflowApprovalSnapshot[],
  resumes: readonly WorkflowTrustedResumeSnapshot[],
): WorkflowTreeSelection[] {
  const approvalByRunId = new Map<string, WorkflowApprovalSnapshot>(
    approvals.map((approval) => [approval.runId, approval]),
  );
  const resumeByRunId = new Map<string, WorkflowTrustedResumeSnapshot>(
    resumes.map((resume) => [resume.runId, resume]),
  );
  const selections = workflowJobsForOwner(owner).map(
    (job): WorkflowTreeSelection => {
      const approval = approvalByRunId.get(job.id);
      const resume = resumeByRunId.get(job.id);
      return {
        id: job.id,
        job,
        ...(approval === undefined ? {} : { approval }),
        ...(resume === undefined ? {} : { resume }),
      };
    },
  );
  const selectedIds = new Set(selections.map((selection) => selection.id));
  for (const approval of approvals) {
    if (selectedIds.has(approval.runId)) continue;
    selections.push({
      id: approval.runId,
      approval,
      ...(resumeByRunId.get(approval.runId) === undefined
        ? {}
        : { resume: resumeByRunId.get(approval.runId)! }),
    });
    selectedIds.add(approval.runId);
  }
  for (const resume of resumes) {
    if (selectedIds.has(resume.runId)) continue;
    selections.push({ id: resume.runId, resume });
    selectedIds.add(resume.runId);
  }
  return selections;
}

function formatWorkflowSummary(job: WorkflowJobState, width: number): string {
  if (job.kind === "plan" && job.planProjection) {
    const summary = formatWorkflowPlanSummary(job.planProjection, {
      width: Math.max(1, width - 6),
    });
    return `${job.name} (${job.id}) · ${summary}`;
  }
  const s = job.snapshot;
  const errorCount = job.result?.errorCount ?? s.errorCount;
  const presentation = getWorkflowCompletionPresentation(
    job.status,
    errorCount,
  );
  const statusPrefix = presentation.icon ? `${presentation.icon} ` : "";
  const parts = [
    `${statusPrefix}${job.name} (${job.id})`,
    `[${job.durableStatus ?? presentation.label}]`,
    `${s.agentsSpawned} agent${s.agentsSpawned === 1 ? "" : "s"}`,
    `${s.runningCount ?? 0} running`,
  ];
  if (errorCount > 0) parts.push(`${errorCount} errors`);
  const usage = presentWorkflowUsage(s.usage);
  if (usage) {
    parts.push(formatWorkflowUsage(usage, { outputBudget: s.budgetTotal }));
  }
  if (s.currentPhase) parts.push(`phase: ${s.currentPhase}`);
  return parts.join(" · ");
}

function formatWorkflowDetails(
  job: WorkflowJobState,
  width: number,
): WorkflowRow[] {
  if (job.kind === "plan" && job.planProjection) {
    const rows = formatWorkflowPlanRows(job.planProjection, {
      width: Math.max(1, width - 7),
    }).map((row) => ({
      job,
      depth: row.depth + 1,
      selectable: false,
      text: row.text,
    }));
    if (rows.length === 0) {
      rows.push({
        job,
        depth: 1,
        selectable: false,
        text: "No plan phases yet.",
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
    return rows;
  }
  const rows: WorkflowRow[] = [];
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
  const sanitized = sanitizeTerminalText(text);
  if (width <= 0) return "";
  if (sanitized.length <= width) return sanitized;
  if (width <= 1) return sanitized.slice(0, width);
  return `${sanitized.slice(0, width - 1)}…`;
}
