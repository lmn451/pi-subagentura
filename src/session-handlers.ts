/** Session lifecycle handlers and interactive poller setup.

 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deleteInteractiveStatesFile,
  hasPersistedTelemetryField,
  loadInteractiveStates,
  removeInteractiveState,
  updateInteractiveStates,
  updatePersistedTelemetrySession,
} from "./artifact";
import {
  updateRunningSubagentFooter,
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
  clearCompletionCoordinator,
  markCompletionHumanInput,
  markCompletionTurnStarting,
  prepareCompletionManifest,
  registerCompletionCoordinator,
  retireSessionScopedCompletions,
  sealCompletionGroups,
  settleCompletionParentTurn,
} from "./completion-coordinator";
import {
  createRootSpawnTreeContext,
  releaseRuntimeSpawnTreeContext,
  retireLineageBootstraps,
  type ParsedSpawnTreeContext,
} from "./spawn-tree-context";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  deleteOrchestratorRoutingFile,
  loadOrchestratorRoutingMetadata,
} from "./orchestrator-routing";
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
  resolveLiveSessionScope,
  sessionOwner,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";
import { closeActiveInteractiveSupervisor } from "./interactive-supervisor-ui";
import {
  clearCompletionTurnWake,
  isOrchestratorMode,
  isOrchestratorV2Enabled,
  markCompletionTurnWakeStarted,
  recoverCompletionTurnWakes,
  settleCompletionTurnWake,
} from "./completion-turn";
import {
  emitExtensionSettingsRegistration,
  isTelemetryEnabled,
  readExtensionSettings,
} from "./settings";
import {
  captureTelemetry,
  createTelemetrySession,
  manifestDeliveryDedupeKey,
  retireTelemetrySession,
  resolveTelemetryMode,
} from "./telemetry";

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

function logSessionError(event: string, error: unknown): void {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  debugLog("error", event, { error: message });
}

function recordPreparedManifest(
  scope: SessionScope,
  message: { details?: { completionIds?: string[] } },
): void {
  const completionIds = message.details?.completionIds ?? [];
  if (completionIds.length === 0) return;
  // The completion coordinator emits the same event for the same manifest.
  // Both sites must resolve the live scope the same way, or the shared dedupe
  // key lands in two different key sets and one delivery is counted twice.
  captureTelemetry(
    resolveLiveSessionScope(sessionOwner(scope))?.telemetry,
    {
      event: "completion_delivered",
      delivery: "manifest",
      count: completionIds.length,
    },
    { dedupeKey: manifestDeliveryDedupeKey(completionIds) },
  );
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

function captureInteractiveLifecycleCancellation(
  scope: SessionScope,
  state: InteractiveSubagentState,
): void {
  const telemetry = scope.telemetry;
  const turnId = state.telemetryActiveTurnId;
  if (
    !turnId ||
    !telemetry ||
    state.telemetryCorrelationId !== telemetry.correlationId
  ) {
    return;
  }
  const turnStartedAt = state.telemetryTurnStartedAt;
  const messageTurnId = state.telemetryMessageTurnId;
  const messageCount =
    state.telemetryTurnMessageCounts?.get(turnId) ??
    (messageTurnId === undefined
      ? undefined
      : state.telemetryTurnMessageCounts?.get(messageTurnId));
  state.telemetryActiveTurnId = undefined;
  state.telemetryTurnStartedAt = undefined;
  state.telemetryTurnMessageCounts?.delete(turnId);
  if (messageTurnId !== undefined && messageTurnId !== turnId) {
    state.telemetryTurnMessageCounts?.delete(messageTurnId);
  }
  state.telemetryMessageTurnId = undefined;
  try {
    updateInteractiveStates(state.cwd, [
      {
        id: state.id,
        update: (entry) => {
          if (
            entry.telemetry?.correlationId !== telemetry.correlationId ||
            entry.telemetry.activeTurnId !== turnId
          ) {
            return;
          }
          delete entry.telemetry.activeTurnId;
          delete entry.telemetry.turnStartedAt;
          delete entry.telemetry.messageTurnId;
          if (entry.telemetry.messageCounts) {
            delete entry.telemetry.messageCounts[turnId];
            if (messageTurnId !== undefined && messageTurnId !== turnId) {
              delete entry.telemetry.messageCounts[messageTurnId];
            }
            if (Object.keys(entry.telemetry.messageCounts).length === 0) {
              delete entry.telemetry.messageCounts;
            }
          }
        },
      },
    ]);
  } catch {
    /* best effort; lifecycle cleanup must continue if state persistence fails */
  }
  captureTelemetry(
    telemetry,
    {
      event: "task_completed",
      execution: "interactive",
      mux: state.mux,
      unit: "turn",
      invocation_source: state.telemetryInvocationSource ?? "interactive",
      model: state.telemetryModel,
      async: state.telemetryAsync ?? true,
      depth: state.telemetryDepth,
      depth_bucket: state.telemetryDepthBucket ?? "unknown",
      completion_policy: state.telemetryCompletionPolicy ?? "legacy",
      status: "cancelled",
      // `turnStartedAt` is an event-log `ts`, which the child writes from the
      // same epoch clock, so this subtraction stays in one clock domain. A
      // recovered timestamp from an old run can still be arbitrarily stale;
      // `telemetryDurationMs` drops the result instead of reporting it.
      duration_ms:
        turnStartedAt === undefined ? undefined : Date.now() - turnStartedAt,
      child_conversation_message_count: messageCount,
    },
    {
      allowInactive: true,
      dedupeKey: `task-completed:interactive:${state.id}:${turnId}`,
    },
  );
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
    const destroysPane =
      destroysStandalonePanes || isInMemoryWorkflowPane(state);
    const cancelsActivePane =
      destroysPane &&
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown");
    if (destroysPane) {
      captureInteractiveLifecycleCancellation(scope, state);
    }
    removeInteractiveSubagentState(state);
    if (destroysStandalonePanes) retireLineageBootstraps(state.artifactDir);
    if (cancelsActivePane) {
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
  /**
   * Injection seam for the opt-in decision. Production always resolves it from
   * settings; tests override it because `isTelemetryEnabled` is unconditionally
   * false under vitest, which would otherwise leave every enabled-telemetry
   * branch below unreachable.
   */
  resolveTelemetryEnabled: (pi: ExtensionAPI) => boolean = isTelemetryEnabled,
): SessionScope {
  const scope = createSessionScope(
    pi,
    initialSpawnTreeContext,
    allowRootLineage ? "root" : "child",
  );
  const globalState = getGlobalState() as any;
  registerSessionScope(scope);
  setLegacyActiveSessionRefs(scope);
  registerCompletionCoordinator(pi, scope);

  pi.on("input", (event) => {
    if (scope.lifecycle === "started" && event.source !== "extension") {
      markCompletionHumanInput(sessionOwner(scope));
    }
    return { action: "continue" as const };
  });
  pi.on("before_agent_start", (event) => {
    if (scope.lifecycle !== "started") return;
    const owner = sessionOwner(scope);
    markCompletionTurnWakeStarted(pi, event.prompt);
    markCompletionTurnStarting(owner);
    const message = prepareCompletionManifest(owner);
    if (message) recordPreparedManifest(scope, message);
    return message ? { message } : undefined;
  });
  pi.on("agent_start", () => {
    if (scope.lifecycle !== "started") return;
    scope.parentStreaming = true;
    setLegacyActiveSessionRefs(scope);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (scope.lifecycle !== "started") return;
    settleCompletionTurnWake(pi);
    scope.parentStreaming = false;
    const owner = sessionOwner(scope);
    setLegacyActiveSessionRefs(scope);
    flushDeliveries(pi, scope.ui, owner);
    flushInProcessDeliveries(owner);
    settleCompletionParentTurn(owner, ctx?.hasPendingMessages?.() ?? false);
  });

  pi.on("session_start", (event, ctx) => {
    if (allowRootLineage) emitExtensionSettingsRegistration(pi);
    // A replacement session must never inherit an old wake request or its
    // watchdog while branch recovery reconstructs durable state.
    clearCompletionTurnWake(pi);
    const continuityReason =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    const previousTelemetry = scope.telemetry;
    if (scope.lifecycle === "started") {
      const previousOwner = sessionOwner(scope);
      retireTelemetrySession(scope.telemetry);
      closeActiveInteractiveSupervisor(previousOwner);
      clearSessionParsers(previousOwner);
      cleanupScopeGeneration(scope, previousOwner, event, "session_start", ctx);
      retireSessionScopedCompletions(
        previousOwner,
        event.reason === "new" || event.reason === "fork",
      );
      clearCompletionCoordinator(previousOwner);
      scope.lifecycle = "shutdown";
    }

    advanceSessionScopeGeneration(scope.id);
    scope.lifecycle = "started";
    scope.ui = ctx.ui;
    scope.cwd = ctx.cwd;
    scope.sessionManager = ctx.sessionManager;
    clearFreshChildLineage(scope, event.reason);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const orchestratorMode = isOrchestratorMode(pi);
    const orchestratorV2Mode = isOrchestratorV2Enabled(pi);
    const isChild =
      !allowRootLineage || process.env.PI_SUBAGENTURA_CHILD === "1";
    const persisted =
      allowRootLineage && continuityReason
        ? loadInteractiveStates(ctx.cwd)
        : undefined;
    const persistedTelemetry =
      persisted && sessionId && persisted.parent === sessionId
        ? persisted.telemetry
        : undefined;
    const activeSpawnTelemetry =
      scope.spawnTreeContext?.role === "descendant"
        ? {
            correlationId: scope.spawnTreeContext.telemetrySessionId,
            mode: scope.spawnTreeContext.telemetryMode,
          }
        : undefined;
    const recoveredTelemetry = continuityReason
      ? previousTelemetry?.correlationId
        ? {
            correlationId: previousTelemetry.correlationId,
            mode: previousTelemetry.mode,
          }
        : (persistedTelemetry ??
          (activeSpawnTelemetry?.correlationId && activeSpawnTelemetry.mode
            ? {
                correlationId: activeSpawnTelemetry.correlationId,
                mode: activeSpawnTelemetry.mode,
              }
            : undefined))
      : undefined;
    const mode =
      recoveredTelemetry?.mode ??
      (isChild
        ? (activeSpawnTelemetry?.mode ?? "straight")
        : resolveTelemetryMode(orchestratorMode, orchestratorV2Mode));
    scope.telemetry = createTelemetrySession(
      resolveTelemetryEnabled(pi),
      mode,
      recoveredTelemetry?.correlationId,
    );
    if (!isChild && recoveredTelemetry === undefined) {
      captureTelemetry(scope.telemetry, { event: "session_started" });
    }
    // With telemetry off there is nothing to persist, so touching `.pi/`, the
    // state lock, and the state file would make the opt-out observable. The one
    // exception is a correlation an earlier opted-in run left behind: that has
    // to be cleared.
    if (
      allowRootLineage &&
      sessionId &&
      (scope.telemetry.enabled || hasPersistedTelemetryField(ctx.cwd))
    ) {
      try {
        updatePersistedTelemetrySession(
          ctx.cwd,
          sessionId,
          scope.telemetry.enabled
            ? {
                correlationId: scope.telemetry.correlationId,
                mode: scope.telemetry.mode,
              }
            : undefined,
        );
      } catch (error) {
        logSessionError("telemetry_session_persist_failed", error);
      }
    }
    if (
      allowRootLineage &&
      sessionId &&
      scope.spawnTreeContext?.role !== "descendant"
    ) {
      const maxDepth = readExtensionSettings(pi, { cwd: ctx.cwd }, (message) =>
        ctx.ui?.notify?.(message, "warning"),
      ).maxDepth;
      scope.spawnTreeContext = createRootSpawnTreeContext(
        sessionId,
        undefined,
        orchestratorMode,
        orchestratorV2Mode,
        maxDepth,
        scope.telemetry.enabled ? scope.telemetry.correlationId : undefined,
        scope.telemetry.mode,
      );
    }
    scope.isParentIdle =
      typeof ctx.isIdle === "function" ? ctx.isIdle.bind(ctx) : undefined;
    scope.parentStreaming = false;
    registerSessionScope(scope);
    setLegacyActiveSessionRefs(scope);
    const hasFooterIdentity =
      orchestratorMode || scope.spawnTreeContext?.orchestratorMode === true;
    if (scope.ui && hasFooterIdentity) {
      updateRunningSubagentFooter(scope.ui, sessionOwner(scope));
    }

    const shouldRehydrate =
      event.reason === "startup" ||
      event.reason === "reload" ||
      event.reason === "resume";
    if (shouldRehydrate) {
      if (process.env.PI_SUBAGENTURA_CHILD !== "1") {
        try {
          // Tools reload on demand; startup only validates persistence so the
          // routing overlay never becomes a second runtime registry or cache.
          loadOrchestratorRoutingMetadata(ctx.cwd);
        } catch (error) {
          logSessionError("orchestrator_routing_recovery_failed", error);
        }
      }
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
      sealCompletionGroups(sessionOwner(scope));
      try {
        recoverCompletionTurnWakes(pi, ctx.sessionManager?.getBranch?.() ?? []);
      } catch (error) {
        logSessionError("orchestratorv2_wake_recovery_failed", error);
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
      retireTelemetrySession(scope.telemetry);
      closeActiveInteractiveSupervisor(owner);
      clearSessionParsers(owner);
      cleanupScopeGeneration(scope, owner, event, "session_shutdown", ctx);
      clearFreshChildLineage(scope, event?.reason);
      retireSessionScopedCompletions(
        owner,
        event?.reason === "new" || event?.reason === "fork",
      );
      clearCompletionCoordinator(owner);
      scope.parentStreaming = false;
      scope.isParentIdle = undefined;
      clearCompletionTurnWake(pi);
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
          deleteOrchestratorRoutingFile(ctx.cwd);
        } catch {
          /* best effort */
        }
      }
    },
  );

  return scope;
}
