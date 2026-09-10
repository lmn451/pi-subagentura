/**
 * Registers the ctrl+alt+x shortcut and /cancel-all-flows command.
 *
 * Both invoke the shared cancelAllFlows helper.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cancelAllFlows } from "./cancel-all-flows";
import type { SessionScope } from "./session-scope";
import {
  registerCommandWithTelemetry,
  registerShortcutWithTelemetry,
} from "./telemetry-operations";

function snapshotSummary(
  result: Awaited<ReturnType<typeof cancelAllFlows>>,
): string {
  const receipts = result.snapshots ?? [];
  if (receipts.length === 0) return "";
  return receipts
    .map((receipt) => {
      const suffix = receipt.path ?? receipt.error ?? "no receipt path";
      return `Snapshot ${receipt.status}: ${suffix}`;
    })
    .join("\n");
}

export function registerCancelAllFlows(
  pi: ExtensionAPI,
  sessionScope?: SessionScope,
): void {
  const owner = () =>
    sessionScope
      ? { id: sessionScope.id, generation: sessionScope.generation }
      : undefined;
  // ── ctrl+alt+x shortcut ────────────────────────────────────────────
  if (typeof pi.registerShortcut === "function") {
    registerShortcutWithTelemetry(pi, "ctrl+alt+x", {
      description:
        "Cancel all active sub-agent flows (jobs, workflows, running interactive agents)",
      handler: async (ctx) => {
        // Stop foreground token use before waiting on child cancellations
        if (typeof ctx.abort === "function") {
          ctx.abort();
        }
        const result = await cancelAllFlows(owner());
        const parts: string[] = [];
        if (result.jobsAborted > 0) parts.push(`${result.jobsAborted} job(s)`);
        if (result.workflowsAborted > 0)
          parts.push(`${result.workflowsAborted} workflow(s)`);
        if (result.interactiveKilled > 0)
          parts.push(`${result.interactiveKilled} interactive agent(s)`);
        if (result.interactivePreserved > 0)
          parts.push(`${result.interactivePreserved} idle agent(s) preserved`);

        if (parts.length === 0) {
          ctx.ui.notify("No active flows to cancel.", "info");
        } else {
          const message = [
            `Cancelled: ${parts.join(", ")}`,
            snapshotSummary(result),
          ]
            .filter(Boolean)
            .join("\n");
          ctx.ui.notify(message, "warning");
        }
      },
    });
  }

  // ── /cancel-all-flows command fallback ──────────────────────────────
  if (typeof pi.registerCommand === "function") {
    registerCommandWithTelemetry(pi, "cancel-all-flows", {
      description:
        "Cancel all active sub-agent flows (jobs, workflows, running interactive agents)",
      handler: async (_args, ctx) => {
        // Stop foreground token use before waiting on child cancellations
        if (typeof ctx.abort === "function") {
          ctx.abort();
        }
        const result = await cancelAllFlows(owner());
        const parts: string[] = [];
        if (result.jobsAborted > 0) parts.push(`${result.jobsAborted} job(s)`);
        if (result.workflowsAborted > 0)
          parts.push(`${result.workflowsAborted} workflow(s)`);
        if (result.interactiveKilled > 0)
          parts.push(`${result.interactiveKilled} interactive agent(s)`);
        if (result.interactivePreserved > 0)
          parts.push(`${result.interactivePreserved} idle agent(s) preserved`);

        if (parts.length === 0) {
          ctx.ui.notify("No active flows to cancel.", "info");
        } else {
          const message = [
            `Cancelled: ${parts.join(", ")}`,
            snapshotSummary(result),
          ]
            .filter(Boolean)
            .join("\n");
          ctx.ui.notify(message, "warning");
        }
      },
    });
  }
}
