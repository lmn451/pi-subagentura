/** Session lifecycle handlers and interactive poller setup.

 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deleteInteractiveStatesFile,
  removeInteractiveState,
} from "./artifact";
import {
  clearSessionParsers,
  clearSessionScopeUiContributions,
  pollArtifactChanges,
} from "./artifact-poller";
import { flushDeliveries } from "./delivery";
import {
  clearInProcessDeliveries,
  flushInProcessDeliveries,
} from "./notifications";
import { debugLog, removeInProcessJob } from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import {
  createRootSpawnTreeContext,
  releaseRuntimeSpawnTreeContext,
  retireLineageBootstraps,
  type ParsedSpawnTreeContext,
} from "./spawn-tree-context";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  removeInteractiveSubagentState,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { cleanupWorkflowJobsForOwner } from "./workflow-jobs";
import {
  advanceSessionScopeGeneration,
  createSessionScope,
  getStartedSessionScopes,
  registerSessionScope,
  removeSessionScope,
  sessionOwner,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { closeActiveInteractiveSupervisor } from "./interactive-supervisor-ui";

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

function logSessionError(event: string, error: unknown): void {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  debugLog("error", event, { error: message });
}

function isInMemoryWorkflowPane(state: InteractiveSubagentState): boolean {
  return (
    state.completionOwner === "workflow" ||
    state.workflowResultConsumed === true
  );
}

function ensureInteractivePoller(globalState: any): void {
  if (globalState.__piSubagenturaInteractivePollerHandle) return;
  const handle = setInterval(() => {
    for (const scope of getStartedSessionScopes()) {
      const owner = sessionOwner(scope);
      void pollArtifactChanges(scope.pi, owner).catch((error) => {
        logSessionError("artifact_poll_failed", error);
      });
    }
  }, 5000);
  handle.unref?.();
  globalState.__piSubagenturaInteractivePollerHandle = handle;
}

function sessionIdForScope(
  scope: SessionScope,
  fallbackManager?: { getSessionId?: () => string },
): string | undefined {
  try {
    return (scope.sessionManager ?? fallbackManager)?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function snapshotOwnedJobs(
  scope: SessionScope,
  sessionId: string | undefined,
  cwd: string | undefined,
  reason: string,
): void {
  for (const job of scope.inProcessJobs.values()) {
    if (job.status !== "running") continue;
    const cancellation = {
      source: "session_shutdown" as const,
      initiator: sessionId,
      reason,
    };
    job.cancellation = { ...cancellation, at: Date.now() };
    job.cancellationSnapshot = snapshotInProcessSession({
      kind: "in-process",
      jobId: job.id,
      session: job.session,
      cwd: job.cwd ?? cwd ?? process.cwd(),
      parentSessionId: sessionId,
      model: job.modelLabel,
      activeTool: job.liveStatus?.activeTool,
      partialOutput: job.liveStatus?.output,
      startedAt: job.startedAt,
      source: "session_shutdown",
      initiator: cancellation.initiator,
      reason: cancellation.reason,
    });
  }
}

function cancellationLifecycleReason(reason: string | undefined) {
  switch (reason) {
    case "startup":
    case "reload":
    case "resume":
    case "quit":
    case "new":
    case "fork":
      return reason;
    default:
      return "unknown" as const;
  }
}

function clearFreshChildLineage(
  scope: SessionScope,
  reason: string | undefined,
): void {
  if (reason !== "new" && reason !== "fork") return;
  if (scope.spawnTreeContext?.role !== "descendant") return;
  retireLineageBootstraps(scope.spawnTreeContext.artifactDir!);
  releaseRuntimeSpawnTreeContext(scope.spawnTreeContext);
  scope.spawnTreeContext = undefined;
}

function cleanupScopeGeneration(
  scope: SessionScope,
  owner: SessionOwnerToken,
  event: { reason?: string } | undefined,
  lifecycleOrigin: "session_start" | "session_shutdown",
  ctx?: {
    cwd?: string;
    sessionManager?: { getSessionId?: () => string };
  },
): void {
  const sessionId = sessionIdForScope(scope, ctx?.sessionManager);
  const reason = `${lifecycleOrigin} (${event?.reason ?? "unknown"})`;
  snapshotOwnedJobs(scope, sessionId, ctx?.cwd, reason);
  cleanupWorkflowJobsForOwner(owner);
  clearInProcessDeliveries(owner);

  const destroysStandalonePanes =
    event?.reason === "new" || event?.reason === "fork";
  for (const state of [...scope.interactiveStates.values()]) {
    removeInteractiveSubagentState(state);
    if (destroysStandalonePanes) retireLineageBootstraps(state.artifactDir);
    if (
      (destroysStandalonePanes || isInMemoryWorkflowPane(state)) &&
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown")
    ) {
      try {
        cancelInteractiveSubagentByState(state, {
          origin: lifecycleOrigin,
          lifecycleReason: cancellationLifecycleReason(event?.reason),
        });
      } catch {
        /* best effort */
      }
    }
    if (event?.reason === "new" || event?.reason === "fork") {
      try {
        removeInteractiveState(state.cwd, state.id);
      } catch {
        /* preserve peer entries even when one stale row cannot be removed */
      }
    }
  }

  for (const [jobId, job] of [...scope.inProcessJobs]) {
    if (job.status === "running") {
      const cancellation = {
        source: "session_shutdown" as const,
        initiator: sessionId,
        reason,
      };
      try {
        if (job.abort) job.abort.abort(cancellation);
        else void job.session.abort().catch(() => {});
      } catch {
        /* session may already be disposed */
      }
    }
    removeInProcessJob(jobId, owner);
  }
  if (scope.ui) clearSessionScopeUiContributions(scope.ui, owner);
}

export function registerSessionHandlers(
  pi: ExtensionAPI,
  initialSpawnTreeContext?: ParsedSpawnTreeContext,
  allowRootLineage = true,
): SessionScope {
  const scope = createSessionScope(
    pi,
    initialSpawnTreeContext,
    allowRootLineage ? "root" : "child",
  );
  const globalState = getGlobalState() as any;
  registerSessionScope(scope);
  setLegacyActiveSessionRefs(scope);

  pi.on("agent_start", () => {
    if (scope.lifecycle !== "started") return;
    scope.parentStreaming = true;
    setLegacyActiveSessionRefs(scope);
  });
  pi.on("agent_settled", () => {
    if (scope.lifecycle !== "started") return;
    scope.parentStreaming = false;
    const owner = sessionOwner(scope);
    setLegacyActiveSessionRefs(scope);
    flushDeliveries(pi, scope.ui, owner);
    flushInProcessDeliveries(owner);
  });

  pi.on("session_start", (event, ctx) => {
    if (scope.lifecycle === "started") {
      const previousOwner = sessionOwner(scope);
      closeActiveInteractiveSupervisor(previousOwner);
      clearSessionParsers(previousOwner);
      cleanupScopeGeneration(scope, previousOwner, event, "session_start", ctx);
      scope.lifecycle = "shutdown";
    }

    advanceSessionScopeGeneration(scope.id);
    scope.lifecycle = "started";
    scope.ui = ctx.ui;
    scope.sessionManager = ctx.sessionManager;
    clearFreshChildLineage(scope, event.reason);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (
      allowRootLineage &&
      sessionId &&
      scope.spawnTreeContext?.role !== "descendant"
    ) {
      scope.spawnTreeContext = createRootSpawnTreeContext(sessionId);
    }
    scope.parentStreaming = false;
    registerSessionScope(scope);
    setLegacyActiveSessionRefs(scope);

    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      try {
        rehydrateInteractiveSubagents(
          ctx.cwd,
          ctx.sessionManager?.getSessionId?.(),
          ctx.sessionManager?.getEntries?.() ?? [],
          scope,
        );
      } catch {
        /* best effort — rehydrate is a recovery path */
      }
    }
    ensureInteractivePoller(globalState);
  });

  (pi as any).on?.(
    "session_shutdown",
    (
      event?: { reason?: string },
      ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      if (scope.lifecycle !== "started") return;

      const owner = sessionOwner(scope);
      closeActiveInteractiveSupervisor(owner);
      clearSessionParsers(owner);
      cleanupScopeGeneration(scope, owner, event, "session_shutdown", ctx);
      clearFreshChildLineage(scope, event?.reason);
      scope.parentStreaming = false;
      scope.lifecycle = "shutdown";
      advanceSessionScopeGeneration(scope.id);
      removeSessionScope(scope.id);

      const remainingScopes = getStartedSessionScopes();
      setLegacyActiveSessionRefs(remainingScopes.at(-1));
      if (remainingScopes.length > 0) return;

      const handle = globalState.__piSubagenturaInteractivePollerHandle;
      if (handle) {
        try {
          clearInterval(handle);
        } catch {
          /* defensive */
        }
        globalState.__piSubagenturaInteractivePollerHandle = undefined;
      }

      if (event?.reason === "new" && ctx?.cwd) {
        try {
          deleteInteractiveStatesFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );

  return scope;
}
