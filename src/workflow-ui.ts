import {
  formatWorkflowUsage,
  presentWorkflowUsage,
  type WorkflowProgress,
} from "./workflow-core";
import { assertNever } from "./artifact";
import type { WorkflowPlanState } from "./workflow-plan-state";
import type { WorkflowProjection } from "./workflow-projection-repository";

// ── Workflow progress renderer ───────────────────────────────────────
export function renderProgress(p: WorkflowProgress): string {
  const parts = [`● workflow — ${p.agentsSpawned} agent(s)`];
  if (p.runningCount > 0) parts.push(`⚡ ${p.runningCount} running`);
  if (p.errorCount > 0) parts.push(`⚠ ${p.errorCount} error(s)`);
  const usage = presentWorkflowUsage(p.usage);
  if (usage) {
    parts.push(formatWorkflowUsage(usage, { outputBudget: p.budgetTotal }));
  }
  const liveUsage = presentWorkflowUsage(p.liveUsage);
  if (liveUsage) {
    parts.push(`live ${formatWorkflowUsage(liveUsage)}`);
  }
  const head = parts.join(", ");
  switch (p.kind) {
    case "phase":
      return `${head}\n  ◆ phase: ${p.phase}`;
    case "log":
      return `${head}\n  ${p.message}`;
    case "agent_start": {
      const tag = p.model ? ` @${p.model}` : "";
      return `${head}\n  → started${p.label ? ` ${p.label}` : ""}${tag}`;
    }
    case "agent_done": {
      const tag = p.model ? ` @${p.model}` : "";
      return `${head}\n  → done${p.label ? ` ${p.label}` : ""}${tag}`;
    }
    default:
      return assertNever(p);
  }
}

/** Render declarative preview state without requiring a legacy script job. */
export function renderWorkflowPlanProgress(state: WorkflowPlanState): string {
  const tasks = Object.values(state.tasks);
  const running = tasks.filter((task) => task === "running").length;
  const failed = tasks.filter((task) => task === "failed").length;
  const done = tasks.filter((task) => task === "succeeded").length;
  return [
    `● workflow plan — ${state.plan.name} [${state.status}]`,
    `${done}/${tasks.length} complete`,
    ...(running > 0 ? [`${running} running`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(state.currentPhase ? [`phase: ${state.currentPhase}`] : []),
  ].join(" · ");
}

/** Render durable projection state for status/tree/controller surfaces. */
export function renderDurableWorkflowProjection(
  projection: WorkflowProjection,
): string {
  const tasks = Object.values(projection.tasks);
  const running = tasks.filter((task) => task.status === "running").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const usage = projection.usage.input + projection.usage.output;
  return [
    `● durable workflow — ${projection.runId} [${projection.status}]`,
    `${tasks.length} task(s)`,
    ...(running > 0 ? [`${running} running`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(usage > 0 ? [`${usage} observed token(s)`] : []),
    ...(projection.currentPhase ? [`phase: ${projection.currentPhase}`] : []),
  ].join(" · ");
}
