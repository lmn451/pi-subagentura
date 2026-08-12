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
import { removeInProcessJob } from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  removeInteractiveSubagentState,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { cleanupWorkflowJobsForOwner } from "./workflow-jobs";
import {
  getDurableWorkflowPlanController,
  flushDurableWorkflowDeliveries,
  startDurableWorkflowSession,
  stopDurableWorkflowSession,
} from "./workflow-durable-runtime";
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
import { WorkflowPlanReminderPolicy } from "./workflow-plan-context";

interface SessionShutdownRegistrar {
  on?: (
    event: "session_shutdown",
    handler: (
      event?: { reason?: string },
      ctx?: {
        cwd?: string;
        sessionManager?: { getSessionId?: () => string };
      },
    ) => void | Promise<void>,
  ) => void;
}

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
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
      void pollArtifactChanges(scope.pi, owner).catch((err) => {
        console.error("[subagentura] artifact poll failed", err);
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

function cleanupScopeGeneration(
  scope: SessionScope,
  owner: SessionOwnerToken,
  event: { reason?: string } | undefined,
  ctx?: {
    cwd?: string;
    sessionManager?: { getSessionId?: () => string };
  },
): void {
  const sessionId = sessionIdForScope(scope, ctx?.sessionManager);
  const reason = `session_shutdown (${event?.reason ?? "unknown"})`;
  snapshotOwnedJobs(scope, sessionId, ctx?.cwd, reason);
  cleanupWorkflowJobsForOwner(owner);
  clearInProcessDeliveries(owner);

  const preserveInteractivePanes =
    event?.reason === "reload" ||
    event?.reason === "resume" ||
    event?.reason === "quit";
  for (const state of [...scope.interactiveStates.values()]) {
    removeInteractiveSubagentState(state);
    if (
      (!preserveInteractivePanes || isInMemoryWorkflowPane(state)) &&
      (state.status === "running" ||
        state.status === "idle" ||
        state.status === "unknown")
    ) {
      try {
        cancelInteractiveSubagentByState(state);
      } catch {
        /* best effort */
      }
    }
    if (event?.reason === "new") {
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

export function registerSessionHandlers(pi: ExtensionAPI): SessionScope {
  const scope = createSessionScope(pi);
  const globalState = getGlobalState() as any;
  registerSessionScope(scope);
  setLegacyActiveSessionRefs(scope);
  const reminderPolicy = new WorkflowPlanReminderPolicy();
  let parentTurn = 0;
  let reminderSentThisTurn = false;

  pi.on("agent_start", () => {
    parentTurn += 1;
    reminderSentThisTurn = false;
    if (scope.lifecycle !== "started") return;
    scope.parentStreaming = true;
    setLegacyActiveSessionRefs(scope);
  });
  pi.on("agent_settled", async () => {
    if (scope.lifecycle !== "started") return;
    scope.parentStreaming = false;
    const owner = sessionOwner(scope);
    setLegacyActiveSessionRefs(scope);
    flushDeliveries(pi, scope.ui, owner);
    flushInProcessDeliveries(owner);
    void flushDurableWorkflowDeliveries(scope).catch((error) => {
      console.error("[subagentura] durable workflow delivery failed", error);
    });
    const controller = getDurableWorkflowPlanController(scope);
    if (controller !== undefined && !reminderSentThisTurn) {
      try {
        for (const view of await controller.listPlanViews()) {
          const reminder = reminderPolicy.nextReminder({
            projection: view,
            turnId: parentTurn,
            generation: scope.generation,
            awaitingUserInput: view.status === "awaiting_budget",
            activeWorkWillWakeParent: controller.isPlanExecutorActive(
              view.runId,
            ),
          });
          if (reminder === undefined) continue;
          reminderSentThisTurn = true;
          pi.sendMessage?.(
            {
              customType: "workflow-plan-reminder",
              content: reminder,
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: false },
          );
          break;
        }
      } catch (error) {
        console.error("[subagentura] workflow plan reminder failed", error);
      }
    }
  });

  pi.on("session_start", async (event, ctx) => {
    if (scope.lifecycle === "started") {
      const previousOwner = sessionOwner(scope);
      if (getDurableWorkflowPlanController(scope) !== undefined) {
        try {
          await stopDurableWorkflowSession(scope, event.reason);
        } catch (error) {
          console.error("[subagentura] durable workflow stop failed", error);
        }
      }
      closeActiveInteractiveSupervisor(previousOwner);
      clearSessionParsers(previousOwner);
      cleanupScopeGeneration(scope, previousOwner, event, ctx);
      scope.lifecycle = "shutdown";
    }

    advanceSessionScopeGeneration(scope.id);
    scope.lifecycle = "started";
    scope.ui = ctx.ui;
    scope.sessionManager = ctx.sessionManager;
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
    try {
      await startDurableWorkflowSession(scope, event.reason, ctx);
    } catch (error) {
      console.error("[subagentura] durable workflow start failed", error);
    }
  });

  // The minimum SDK typing omits session_shutdown although Pi emits it.
  const sessionLifecycleApi = pi as unknown as SessionShutdownRegistrar;
  sessionLifecycleApi.on?.(
    "session_shutdown",
    async (
      event?: { reason?: string },
      ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      if (scope.lifecycle !== "started") return;

      if (getDurableWorkflowPlanController(scope) !== undefined) {
        try {
          await stopDurableWorkflowSession(scope, event?.reason);
        } catch (error) {
          console.error("[subagentura] durable workflow stop failed", error);
        }
      }
      const owner = sessionOwner(scope);
      closeActiveInteractiveSupervisor(owner);
      clearSessionParsers(owner);
      cleanupScopeGeneration(scope, owner, event, ctx);
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
