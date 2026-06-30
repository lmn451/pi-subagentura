/**
 * Sub-Engine Extension - Spawn in-process sub-agents via the SDK
 *
 * Tools:
 *   - subagent_with_context: Inherits full conversation history + task + persona
 *   - subagent_isolated: Fresh context window, task + optional persona only
 *   - get_subagent_status: Poll async subagent job for live preview
 *   - get_subagent_result: Block until async job completes, return final output
 *   - cancel_subagent: Abort a running async job
 *   - prune_subagent_jobs: Remove all completed and failed jobs from the registry
 *   - interactive sub-agent tools: registered from ./tools/interactive
 *   - list_available_models: List all known models with auth status for model validation
 *
 * Both spawn tools support optional `async` param for background execution.
 * When async: true, the job starts and the main agent continues immediately -
 * it does NOT block waiting for the sub-agent. Use get_subagent_status to poll
 * for progress and get_subagent_result when ready to collect output.
 *
 * Runs in the same process — no subprocess overhead.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  formatUsage,
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneCompletedJobs,
  pruneOldestJob,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
  type SubagentLiveStatus,
  type SubagentResult,
  type Usage,
} from "./helpers";
import { registerWorkflowTool } from "./workflow";
import {
  registerInProcessMaintenanceTools,
  registerInProcessSubagentTools,
} from "./tools/in-process";
import { registerInteractiveSubagentTools } from "./tools/interactive";
import { deleteInteractiveStatesFile } from "./artifact";
import { pollArtifactChanges } from "./artifact-poller";
import { rehydrateInteractiveSubagents } from "./rehydrate";
export { rehydrateInteractiveSubagents };
import {
  cancelInteractiveSubagentByState,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
export type SubagentDetails =
  | { status: "started"; jobId: string; contextMessages: number }
  | { status: "running"; subagentStatus: SubagentLiveStatus; model?: string }
  | {
      status: "done" | "error";
      usage: Usage;
      model?: string;
      usageSummary?: string;
      contextMessages?: number;
    }
  | { status: "cancelled" | "not_found" }
  | { status: "invalid_id"; id: string };

export default function (pi: ExtensionAPI) {
  // Persist pi ref for async notification delivery (survives module reload)
  const g2 = typeof global !== "undefined" ? global : globalThis;
  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaInjectCount = 0;

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    g2.__piSubagenturaUi = ctx.ui;
    // Rehydrate on startup (resumed session after quit), reload, and resume.
    // The session ID filter ensures only subagents created in this specific session
    // are rehydrated. On 'new' and 'fork' we skip — those are explicit fresh starts.
    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      try {
        rehydrateInteractiveSubagents(
          ctx.cwd,
          ctx.sessionManager?.getSessionId?.(),
        );
      } catch {
        /* best effort — rehydrate is a recovery path; failures fall back to empty registry */
      }
    }
  });

  pi.on("session_shutdown", () => {
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // Register notification renderer before any tools
  // One global interval for the whole session. Each tick walks the artifact dir of
  // every running interactive sub-agent and fires pointer notifications for new events.
  // The poller survives parent restarts (artifacts on disk + per-state lastDeliveredEventTs).
  if (!g2.__piSubagenturaInteractivePollerHandle) {
    const handle = setInterval(() => pollArtifactChanges(pi), 5000);
    // Don't pin the event loop on a long-lived parent. unref() lets the process exit
    // cleanly when nothing else is keeping it alive (no other ref'd handles).
    handle.unref?.();
    g2.__piSubagenturaInteractivePollerHandle = handle;
  }
  // ── Tool: workflow — deterministic JS orchestration of isolated sub-agents ──
  registerWorkflowTool(pi);
  registerInProcessSubagentTools(pi);

  registerInteractiveSubagentTools(pi);

  registerInProcessMaintenanceTools(pi);

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = typeof global !== "undefined" ? global : globalThis;

      // Stop the global poller so it doesn't fire after we're gone. Without
      // clearInterval the handle would keep the event loop alive across restarts.
      if (g2.__piSubagenturaInteractivePollerHandle) {
        try {
          clearInterval(g2.__piSubagenturaInteractivePollerHandle);
        } catch {
          /* defensive */
        }
        g2.__piSubagenturaInteractivePollerHandle = undefined;
      }
      // Snapshot running state objects BEFORE clearing. On /new and quit we
      // kill their panes after the registry is empty. On reload/resume we
      // intentionally preserve panes so the next session_start can rehydrate
      // them from the state file.
      const runningStates: InteractiveSubagentState[] = [];
      for (const state of interactiveSubagentRegistry.values()) {
        if (state.status === "running") runningStates.push(state);
      }

      // Drop in-memory state FIRST. An in-flight poll tick (dequeued from
      // setInterval before clearInterval ran) finds an empty registry and its
      // for-loop iterates over zero entries — no work, no notification delivery.
      try {
        interactiveSubagentRegistry.clear();
      } catch {
        /* best effort */
      }

      const preserveInteractivePanes =
        event?.reason === "reload" ||
        event?.reason === "resume" ||
        event?.reason === "quit";
      if (!preserveInteractivePanes) {
        // Kill the panes using the already-snapshotted states.
        // cancelInteractiveSubagentByState is used (not the id-based variant)
        // because the registry was already cleared above.
        for (const state of runningStates) {
          try {
            cancelInteractiveSubagentByState(state);
          } catch {
            /* best effort */
          }
        }
      }
      // Abort all running subagent sessions before clearing
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }
      jobRegistry.clear();
      g2.__piSubagenturaPiRef = undefined;
      g2.__piSubagenturaInjectCount = 0;
      // Clean-slate the state file on /new. On quit/reload/resume we KEEP the file so the
      // next session_start can rehydrate the sub-agents (their panes survive).
      if (event?.reason === "new" && ctx?.cwd) {
        try {
          deleteInteractiveStatesFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );
}

// ── Re-exports ───────────────────────────────────────────────────────
// Re-export helpers so external consumers (e.g. tests importing from subagent.ts)
// don't need to know about the internal helpers.ts split.
export {
  formatUsage,
  SubagentResult,
  SubagentLiveStatus,
  ACTIVE_TOOL_DEBOUNCE_MS,
  // ── Async exports ──
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  startSubagentJob,
  type JobState,
  type JobStatus,
  type NotifyOnComplete,
} from "./helpers";
export { interactiveSubagentRegistry } from "./interactive-tmux";
export { getInjectCount, MAX_INJECT } from "./notifications";
export { pollArtifactChanges } from "./artifact-poller";
export { findArtifactById } from "./tools/interactive";
