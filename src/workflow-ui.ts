import {
  formatWorkflowUsage,
  presentWorkflowUsage,
  type WorkflowProgress,
} from "./workflow-core";
import { assertNever } from "./artifact";
import { sanitizeTerminalText } from "./workflow-plan-ui";

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
      return `${head}\n  ◆ phase: ${sanitizeTerminalText(p.phase)}`;
    case "log":
      return `${head}\n  ${sanitizeTerminalText(p.message)}`;
    case "agent_start": {
      const label = p.label ? sanitizeTerminalText(p.label) : "";
      const model = p.model ? sanitizeTerminalText(p.model) : "";
      const tag = model ? ` @${model}` : "";
      return `${head}\n  → started${label ? ` ${label}` : ""}${tag}`;
    }
    case "agent_done": {
      const label = p.label ? sanitizeTerminalText(p.label) : "";
      const model = p.model ? sanitizeTerminalText(p.model) : "";
      const tag = model ? ` @${model}` : "";
      return `${head}\n  → done${label ? ` ${label}` : ""}${tag}`;
    }
    default:
      return assertNever(p);
  }
}
