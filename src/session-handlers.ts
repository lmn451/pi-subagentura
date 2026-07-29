/** Session lifecycle handlers and interactive poller setup.

 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deleteInteractiveStatesFile } from "./artifact";
import { clearSessionParsers, pollArtifactChanges } from "./artifact-poller";
import { flushDeliveries } from "./delivery";
import { flushInProcessDeliveries } from "./notifications";
import { inProcessJobBelongsToOwner, jobRegistry } from "./helpers";
import { snapshotInProcessSession } from "./cancellation-snapshots";
import { rehydrateInteractiveSubagents } from "./rehydrate";
import {
  cancelInteractiveSubagentByState,
  interactiveStatusForState,
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { cleanupWorkflowJobsForOwner } from "./workflow-jobs";
import {
  advanceSessionContextGeneration,
  createSessionContextRef,
  getSessionContextStack,
  registerSessionContext,
  removeSessionContext,
  setActiveSessionRefs,
  type ActiveSessionContextToken,
  type SessionContextRef,
} from "./session-context";
import { closeActiveInteractiveSupervisor } from "./interactive-supervisor-ui";

function shouldTerminateInteractiveState(
  state: InteractiveSubagentState,
): boolean {
  const status = interactiveStatusForState(state);
  return status !== "cancelled" && status !== "exited";
}

function getGlobalState() {
  return typeof global !== "undefined" ? global : globalThis;
}

function ensureInteractivePoller(globalState: any): void {
  if (globalState.__piSubagenturaInteractivePollerHandle) return;
  const handle = setInterval(() => {
    for (const context of [...getSessionContextStack()]) {
      if (context.lifecycle !== "started") continue;
      void pollArtifactChanges(context.pi, {
        id: context.id,
        generation: context.generation,
      }).catch((err) => {
        console.error("[subagentura] artifact poll failed", err);
      });
    }
  }, 5000);
  handle.unref?.();
  globalState.__piSubagenturaInteractivePollerHandle = handle;
}

// Older releases could start a poller during extension preload, before project
// package overrides selected the live runtime. Replace that orphan on session_start.
function discardPreSessionPollerState(
  globalState: any,
  sessionContext: SessionContextRef,
): void {
  const contexts = [...getSessionContextStack()];
  const ownIndex = contexts.findIndex(
    (context) => context.id === sessionContext.id,
  );
  const staleDescendants =
    ownIndex < 0
      ? []
      : contexts
          .slice(ownIndex + 1)
          .filter((context) => context.lifecycle === "started");
  const staleIds = new Set(staleDescendants.map((context) => context.id));
  const hasStartedContext = contexts.some(
    (context) => context.lifecycle === "started" && !staleIds.has(context.id),
  );
  const staleOwners: Array<{
    token: ActiveSessionContextToken;
    sessionId: string | undefined;
  }> = [];
  for (const context of staleDescendants) {
    let sessionId: string | undefined;
    try {
      sessionId = context.sessionManager?.getSessionId?.();
    } catch {
      sessionId = undefined;
    }
    staleOwners.push({
      token: { id: context.id, generation: context.generation },
      sessionId,
    });
  }

  const ownedJobs = staleOwners.flatMap((owner) =>
    [...jobRegistry.entries()]
      .filter(([, job]) => inProcessJobBelongsToOwner(job, owner.token))
      .map(([jobId, job]) => ({
        jobId,
        job,
        owner,
        cancellation: {
          source: "session_shutdown" as const,
          initiator: owner.sessionId,
          reason: "session_start removed a stale descendant context",
        },
      })),
  );
  for (const { job, owner, cancellation } of ownedJobs) {
    if (job.status !== "running") continue;
    job.cancellation = { ...cancellation, at: Date.now() };
    job.cancellationSnapshot = snapshotInProcessSession({
      kind: "in-process",
      jobId: job.id,
      session: job.session,
      cwd: job.cwd ?? process.cwd(),
      parentSessionId: owner.sessionId,
      model: job.modelLabel,
      activeTool: job.liveStatus?.activeTool,
      partialOutput: job.liveStatus?.output,
      startedAt: job.startedAt,
      source: "session_shutdown",
      initiator: cancellation.initiator,
      reason: cancellation.reason,
    });
  }
  for (const owner of staleOwners) {
    cleanupWorkflowJobsForOwner(owner.token);
  }

  const staleSessionIds = new Set(
    staleOwners
      .map((owner) => owner.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  );
  for (const state of [...interactiveSubagentRegistry.values()]) {
    if (
      state.parentSessionId === undefined ||
      !staleSessionIds.has(state.parentSessionId)
    ) {
      continue;
    }
    interactiveSubagentRegistry.delete(state.id);
    if (shouldTerminateInteractiveState(state)) {
      try {
        cancelInteractiveSubagentByState(state);
      } catch {
        /* best effort */
      }
    }
  }
  for (const { jobId, job, cancellation } of ownedJobs) {
    if (job.status === "running") {
      try {
        if (job.abort) job.abort.abort(cancellation);
        else void job.session.abort().catch(() => {});
      } catch {
        /* session may already be disposed */
      }
    }
    jobRegistry.delete(jobId);
  }

  for (const context of staleDescendants) {
    context.lifecycle = "shutdown";
    advanceSessionContextGeneration(context.id);
    removeSessionContext(context.id);
  }
  const handle = globalState.__piSubagenturaInteractivePollerHandle;
  if (hasStartedContext || !handle) return;
  try {
    clearInterval(handle);
  } catch {
    /* A stale legacy handle must not block the live session's poller. */
  }
  globalState.__piSubagenturaInteractivePollerHandle = undefined;
}

export function registerSessionHandlers(pi: ExtensionAPI): SessionContextRef {
  const sessionContext = createSessionContextRef(pi);
  const g2 = getGlobalState() as any;
  registerSessionContext(sessionContext);
  setActiveSessionRefs(sessionContext);

  g2.__piSubagenturaPiRef = pi;
  g2.__piSubagenturaParentStreaming = false;

  pi.on("agent_start", () => {
    g2.__piSubagenturaParentStreaming = true;
  });
  pi.on("agent_settled", () => {
    g2.__piSubagenturaParentStreaming = false;
    flushDeliveries(pi, sessionContext.ui, {
      id: sessionContext.id,
      generation: sessionContext.generation,
    });
    flushInProcessDeliveries();
  });

  // Capture ctx.ui for the artifact poller (it runs from a setInterval and has no ctx).
  // The handler is registered on every default-export invocation; the last one wins,
  // which is the same pi the poller uses via __piSubagenturaPiRef.
  pi.on("session_start", (event, ctx) => {
    const previousOwner: ActiveSessionContextToken = {
      id: sessionContext.id,
      generation: sessionContext.generation,
    };
    discardPreSessionPollerState(g2, sessionContext);
    cleanupWorkflowJobsForOwner(previousOwner);
    sessionContext.generation++;
    sessionContext.lifecycle = "started";
    sessionContext.ui = ctx.ui;
    sessionContext.sessionManager = ctx.sessionManager;
    registerSessionContext(sessionContext);
    setActiveSessionRefs(sessionContext);
    g2.__piSubagenturaUi = ctx.ui;
    g2.__piSubagenturaSessionManager = ctx.sessionManager;
    g2.__piSubagenturaPiRef = pi;
    g2.__piSubagenturaParentStreaming = false;

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
          ctx.sessionManager?.getEntries?.() ?? [],
        );
      } catch {
        /* best effort — rehydrate is a recovery path; failures fall back to empty registry */
      }
    }
    ensureInteractivePoller(g2);
  });

  pi.on("session_shutdown", () => {
    closeActiveInteractiveSupervisor();
    // Don't null the ui ref here — the poller may still fire one last tick on shutdown,
    // and stale ctx errors are already caught at the call sites.
  });

  // ── Session shutdown: abort all jobs, kill tmux panes, stop the poller ─
  (pi as any).on?.(
    "session_shutdown",
    (
      event: { reason?: string },
      ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      const g2 = getGlobalState() as any;
      const contextStack = getSessionContextStack();
      const contextIndex = contextStack.findIndex(
        (entry) => entry.id === sessionContext.id,
      );
      if (contextIndex < 0) return;

      // Only started ancestors registered before this context may keep the
      // shared poller and registries alive. Descendants are structurally owned
      // by this context; a missed nested shutdown must not outlive its parent.
      const startedAncestors = contextStack
        .slice(0, contextIndex)
        .filter((context) => context.lifecycle === "started");
      const descendants = contextStack.slice(contextIndex + 1);

      const shutdownOwners: Array<{
        token: ActiveSessionContextToken;
        sessionId: string | undefined;
      }> = [];
      for (const context of [sessionContext, ...descendants]) {
        let sessionId: string | undefined;
        try {
          const manager =
            context.sessionManager ??
            (context.id === sessionContext.id
              ? ctx?.sessionManager
              : undefined);
          sessionId = manager?.getSessionId?.();
        } catch {
          sessionId = undefined;
        }
        shutdownOwners.push({
          token: { id: context.id, generation: context.generation },
          sessionId,
        });
      }
      const shutdownSessionId = shutdownOwners[0]!.sessionId;
      sessionContext.lifecycle = "shutdown";
      advanceSessionContextGeneration(sessionContext.id);
      removeSessionContext(sessionContext.id);
      for (const descendant of descendants) {
        descendant.lifecycle = "shutdown";
        advanceSessionContextGeneration(descendant.id);
        removeSessionContext(descendant.id);
      }
      setActiveSessionRefs(startedAncestors[startedAncestors.length - 1]);
      g2.__piSubagenturaParentStreaming = false;

      // A live ancestor may defer global teardown while this nested context
      // cleans its own state. Descendants never participate in this decision:
      // if their shutdown hook was omitted, their lifecycle is stale.
      if (startedAncestors.length > 0) {
        const preserveInteractivePanes =
          event?.reason === "reload" ||
          event?.reason === "resume" ||
          event?.reason === "quit";
        // An absent session id must match nothing. `parentSessionId` is
        // legitimately undefined for states spawned without a parent session,
        // and `undefined === undefined` would kill unrelated panes.
        const ownedSessionIds = new Set(
          shutdownOwners
            .map((owner) => owner.sessionId)
            .filter(
              (sessionId): sessionId is string => sessionId !== undefined,
            ),
        );
        const ownedStates = [...interactiveSubagentRegistry.values()].filter(
          (state) =>
            state.parentSessionId !== undefined &&
            ownedSessionIds.has(state.parentSessionId),
        );
        const ownedJobs = shutdownOwners.flatMap((owner) =>
          [...jobRegistry.entries()]
            .filter(([, job]) => inProcessJobBelongsToOwner(job, owner.token))
            .map(([jobId, job]) => ({
              jobId,
              job,
              owner,
              cancellation: {
                source: "session_shutdown" as const,
                initiator: owner.sessionId,
                reason: `session_shutdown (${event?.reason ?? "unknown"})`,
              },
            })),
        );

        // Snapshot every invalidated owner's in-process job before any of
        // those sessions is aborted.
        for (const { job, owner, cancellation } of ownedJobs) {
          if (job.status !== "running") continue;
          job.cancellation = { ...cancellation, at: Date.now() };
          job.cancellationSnapshot = snapshotInProcessSession({
            kind: "in-process",
            jobId: job.id,
            session: job.session,
            cwd: job.cwd ?? ctx?.cwd ?? process.cwd(),
            parentSessionId: owner.sessionId,
            model: job.modelLabel,
            activeTool: job.liveStatus?.activeTool,
            partialOutput: job.liveStatus?.output,
            startedAt: job.startedAt,
            source: "session_shutdown",
            initiator: cancellation.initiator,
            reason: cancellation.reason,
          });
        }

        for (const owner of shutdownOwners) {
          cleanupWorkflowJobsForOwner(owner.token);
        }

        for (const state of ownedStates) {
          interactiveSubagentRegistry.delete(state.id);
          if (
            !preserveInteractivePanes &&
            shouldTerminateInteractiveState(state)
          ) {
            try {
              cancelInteractiveSubagentByState(state);
            } catch {
              /* best effort */
            }
          }
        }

        for (const { jobId, job, cancellation } of ownedJobs) {
          if (job.status === "running") {
            try {
              if (job.abort) job.abort.abort(cancellation);
              else void job.session.abort().catch(() => {});
            } catch {
              /* session may already be disposed */
            }
          }
          jobRegistry.delete(jobId);
        }
        return;
      }

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

      // Snapshot live state objects before clearing. Non-preserving shutdowns
      // kill their panes; reload/resume/quit leave them for rehydration.
      const runningStates: InteractiveSubagentState[] = [];
      for (const state of interactiveSubagentRegistry.values()) {
        if (shouldTerminateInteractiveState(state)) runningStates.push(state);
      }

      // Drop in-memory state FIRST. An in-flight poll tick (dequeued from
      // setInterval before clearInterval ran) finds an empty registry and its
      // for-loop iterates over zero entries — no work, no notification delivery.
      try {
        clearSessionParsers();
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

      const shutdownCancellation = {
        source: "session_shutdown" as const,
        initiator: shutdownSessionId,
        reason: `session_shutdown (${event?.reason ?? "unknown"})`,
      };
      // Snapshot all in-process jobs before any abort can wait for idle.
      for (const job of jobRegistry.values()) {
        if (job.status !== "running") continue;
        job.cancellation = { ...shutdownCancellation, at: Date.now() };
        job.cancellationSnapshot = snapshotInProcessSession({
          kind: "in-process",
          jobId: job.id,
          session: job.session,
          cwd: job.cwd ?? ctx?.cwd ?? process.cwd(),
          model: job.modelLabel,
          activeTool: job.liveStatus?.activeTool,
          partialOutput: job.liveStatus?.output,
          source: "session_shutdown",
          initiator: shutdownCancellation.initiator,
          reason: shutdownCancellation.reason,
        });
      }
      for (const owner of shutdownOwners) {
        cleanupWorkflowJobsForOwner(owner.token);
      }
      // Abort all running subagent sessions before clearing. Prefer the
      // controller so descendants are torn down too.
      for (const job of jobRegistry.values()) {
        if (job.status === "running") {
          try {
            if (job.abort) job.abort.abort(shutdownCancellation);
            else job.session.abort().catch(() => {});
          } catch {
            /* session may already be disposed */
          }
        }
      }

      jobRegistry.clear();
      g2.__piSubagenturaPiRef = undefined;
      g2.__piSubagenturaSessionManager = undefined;
      g2.__piSubagenturaParentStreaming = false;
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

  return sessionContext;
}
