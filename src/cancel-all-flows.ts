/**
 * Shared helper to cancel ALL active flows.
 *
 * Used by:
 * - ctrl+alt+x shortcut
 * - /cancel-all-flows command
 *
 * Preserves idle interactive panes (they consume no tokens).
 * Cancels running and unknown interactive panes; unknown liveness still
 * represents potentially active work.
 */
import { inProcessJobsForOwner, scheduleJobCleanup } from "./helpers";
import {
  cancelInteractiveSubagent,
  interactiveSubagentRegistry,
} from "./interactive-tmux";
import {
  normalizeCancelledWorkflowState,
  workflowJobsForOwner,
} from "./workflow-jobs";
import {
  interactiveStateBelongsToOwner,
  resolveLiveSessionScope,
  type SessionOwnerToken,
} from "./session-scope";
import {
  snapshotInProcessSession,
  snapshotInteractiveContext,
  type CancellationSnapshotReceipt,
} from "./cancellation-snapshots";

export interface CancelAllResult {
  jobsAborted: number;
  workflowsAborted: number;
  interactiveKilled: number;
  interactivePreserved: number;
  snapshots?: CancellationSnapshotReceipt[];
}

export async function cancelAllFlows(
  owner?: SessionOwnerToken,
): Promise<CancelAllResult> {
  const result: CancelAllResult = {
    jobsAborted: 0,
    workflowsAborted: 0,
    interactiveKilled: 0,
    interactivePreserved: 0,
    snapshots: [],
  };
  const snapshots = result.snapshots;
  const snapshotKeys = new Set<string>();
  const addSnapshot = (receipt: CancellationSnapshotReceipt): void => {
    if (!receipt.enabled || receipt.status === "disabled") return;
    if (snapshotKeys.has(receipt.key)) return;
    snapshotKeys.add(receipt.key);
    snapshots!.push(receipt);
  };

  // Snapshot every known child before the first potentially slow abort.
  const interactiveRegistry = owner
    ? resolveLiveSessionScope(owner)?.interactiveStates
    : interactiveSubagentRegistry;
  const interactiveStates = [...(interactiveRegistry?.values() ?? [])].filter(
    (state) => interactiveStateBelongsToOwner(state, owner),
  );
  for (const state of interactiveStates) {
    if (state.status !== "running" && state.status !== "unknown") continue;
    state.cancellationSnapshot = snapshotInteractiveContext({
      kind: "interactive",
      id: state.id,
      parentSessionId: state.parentSessionId,
      cwd: state.cwd,
      sessionFile: state.sessionFile,
      artifactDir: state.artifactDir,
      startedAt: state.startedAt,
      source: "cancel_all",
      cancellationOrigin: "cancel_all",
    });
    addSnapshot(state.cancellationSnapshot);
  }
  const jobs = [...inProcessJobsForOwner(owner).values()].filter(
    (job) => job.status === "running",
  );
  const jobCancellation = {
    source: "cancel_all" as const,
    initiator: "cancel_all_flows",
    reason: "cancel-all-flows aborted every running flow",
  };
  for (const job of jobs) {
    job.cancellation = { ...jobCancellation, at: Date.now() };
    job.cancellationSnapshot = snapshotInProcessSession({
      kind: "in-process",
      jobId: job.id,
      session: job.session,
      cwd: job.cwd ?? process.cwd(),
      model: job.modelLabel,
      activeTool: job.liveStatus?.activeTool,
      partialOutput: job.liveStatus?.output,
      source: "cancel_all",
      initiator: jobCancellation.initiator,
      reason: jobCancellation.reason,
    });
    addSnapshot(job.cancellationSnapshot);
  }
  for (const job of jobs) {
    try {
      // Prefer the controller so the abort handler cascades to descendants;
      // fall back to a direct session abort for jobs spawned without one.
      if (job.abort) job.abort.abort(jobCancellation);
      else await job.session.abort();
    } catch {
      /* session may already be disposed */
    }
    job.status = "cancelled";
    scheduleJobCleanup(job.id, true, undefined, owner);
    result.jobsAborted++;
  }

  // 2. Abort all running workflows
  for (const workflow of workflowJobsForOwner(owner)) {
    if (workflow.status === "running") {
      workflow.suppressCompletionNotification = true;
      workflow.abort.abort();
      workflow.status = "cancelled";
      result.workflowsAborted++;
    }
    if (workflow.status === "cancelled") {
      normalizeCancelledWorkflowState(workflow);
      for (const receipt of workflow.cancellationSnapshots ?? []) {
        addSnapshot(receipt);
      }
    }
  }

  // 3. Kill active interactive agents; preserve confirmed-idle ones
  for (const state of interactiveStates) {
    if (state.status === "running" || state.status === "unknown") {
      try {
        const cancelled = cancelInteractiveSubagent(
          state.id,
          "cancel_all",
          state,
        );
        if (cancelled) {
          result.interactiveKilled++;
          if (cancelled.cancellationSnapshot) {
            addSnapshot(cancelled.cancellationSnapshot);
          }
        }
      } catch {
        /* best effort */
      }
    } else if (state.status === "idle") {
      // Idle panes consume no tokens — preserve them
      result.interactivePreserved++;
    }
  }

  return result;
}
