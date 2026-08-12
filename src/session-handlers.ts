/** Session lifecycle handlers and interactive poller setup.

 * Extracted from src/subagent.ts so the extension entrypoint can stay focused
 * on registration and public exports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { basename } from "node:path";
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
  advanceSessionScopeGeneration,
  createSessionScope,
  getStartedSessionScopes,
  registerSessionScope,
  removeSessionScope,
  sessionOwner,
  setDurableWorkflowOwner,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
  type SessionScope,
  releaseDurableWorkflowAuthority,
} from "./session-scope";
import { closeActiveInteractiveSupervisor } from "./interactive-supervisor-ui";
import {
  durableWorkflowControllerForSession,
  durableWorkflowStoreForSession,
  workflowOwnerFromSessionContext,
} from "./workflow-owner";

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
const DURABLE_WORKFLOW_ROOT_ENV = "PI_SUBAGENTURA_WORKFLOW_RUNS_DIR";
const MAX_DURABLE_WORKFLOW_ROOT_LENGTH = 1_024;

function durableWorkflowRootDir(): string {
  const configured = process.env[DURABLE_WORKFLOW_ROOT_ENV];
  if (configured !== undefined) {
    if (
      configured.length === 0 ||
      configured.length > MAX_DURABLE_WORKFLOW_ROOT_LENGTH ||
      configured.includes("\0") ||
      !isAbsolute(configured)
    ) {
      throw new Error(
        `${DURABLE_WORKFLOW_ROOT_ENV} must be a bounded absolute path`,
      );
    }
    return resolve(configured);
  }
  return join(homedir(), ".pi-subagentura", "workflow-runs", "v1");
}

interface DurableWorkflowSessionContext {
  rootDir: string;
  owner?: WorkflowOwnerIdentity;
}

function durableWorkflowSessionContext(
  scope: SessionScope,
  cwd: string,
  sessionId: string | undefined,
): DurableWorkflowSessionContext {
  const rootDir = durableWorkflowRootDir();
  if (process.env.PI_SUBAGENTURA_CHILD === "1" || !sessionId) {
    return { rootDir };
  }
  if (sessionId.length > 4_096 || sessionId.includes("\0")) {
    throw new Error(
      "Pi session ID is too large for durable workflow ownership",
    );
  }
  const canonicalCwd = realpathSync.native(cwd);
  const projectKey = createHash("sha256").update(canonicalCwd).digest("hex");
  const piSessionId = createHash("sha256").update(sessionId).digest("hex");
  const ownerGeneration = randomBytes(6).readUIntBE(0, 6);
  return {
    rootDir,
    owner: createWorkflowOwnerIdentity({
      projectKey,
      cwd: canonicalCwd,
      piSessionId,
      ownerId: `session-${piSessionId}`,
      ownerGeneration,
      leaseToken: randomBytes(32).toString("hex"),
    }),
  };
}

async function recoverDurableWorkflowProjections(
  scope: SessionScope,
): Promise<void> {
  const controller = durableWorkflowControllerForSession(scope);
  const store = durableWorkflowStoreForSession(scope);
  const owner = scope.durableWorkflowOwner;
  if (!controller || !store || !owner) return;
  await store.getLeaseEpoch();
  await new DurableWorkflowProjectionRepository(store, owner).list();
}

async function revokeAndReleaseDurableWorkflowAuthoritySafely(
  scope: SessionScope,
  store: NonNullable<SessionScope["durableWorkflowStore"]> | undefined,
): Promise<void> {
  if (!store) return;
  try {
    await store.revoke();
  } catch (error) {
    console.error("[subagentura] durable workflow store revoke failed", error);
  }
  try {
    await store.release();
  } catch (error) {
    console.error("[subagentura] durable workflow lease release failed", error);
  }
  if (scope.durableWorkflowStore === store) {
    scope.durableWorkflowStore = undefined;
    scope.durableWorkflowController = undefined;
  }
}

async function reconcileDurableWorkflowDeliveries(
  scope: SessionScope,
  cwd: string,
): Promise<void> {
  const controller = durableWorkflowControllerForSession(cwd, scope);
  const store = durableWorkflowStoreForSession(cwd, scope);
  if (!controller || !store) return;
  const entries = scope.sessionManager?.getEntries?.() ?? [];
  for (const runId of await store.listRunIds()) {
    try {
      await controller.reconcileDelivery(runId, entries);
    } catch (error) {
      console.error(
        `[subagentura] durable workflow delivery reconciliation failed for ${runId}`,
        error,
      );
    }
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
): Promise<void> {
  const sessionId = sessionIdForScope(scope, ctx?.sessionManager);
  const reason = `session_shutdown (${event?.reason ?? "unknown"})`;
  snapshotOwnedJobs(scope, sessionId, ctx?.cwd, reason);
  const durableJobsDrained = cleanupWorkflowJobsForOwner(owner);
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
  return durableJobsDrained;
}

async function releaseDurableWorkflowAuthorityWithRetry(
  scope: SessionScope,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await releaseDurableWorkflowAuthority(scope);
      return;
    } catch (error) {
      if (attempt === 2) {
        console.error(
          "[subagentura] durable workflow authority release failed during shutdown",
          error,
        );
      }
    }
  }
}

export function registerSessionHandlers(pi: ExtensionAPI): SessionScope {
  const scope = createSessionScope(pi);
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

  pi.on("session_start", async (event, ctx) => {
    let durableContext: DurableWorkflowSessionContext | undefined;
    let previousDurableStore: SessionScope["durableWorkflowStore"];
    let previousDurableJobsDrained: Promise<void> | undefined;
    try {
      durableContext = durableWorkflowSessionContext(
        scope,
        ctx.cwd,
        ctx.sessionManager?.getSessionId?.(),
      );
    } catch (error) {
      console.error(
        "[subagentura] durable workflow ownership is unavailable",
        error,
      );
    }

    if (scope.lifecycle === "started") {
      const previousOwner = sessionOwner(scope);
      previousDurableStore = scope.durableWorkflowStore;
      closeActiveInteractiveSupervisor(previousOwner);
      clearSessionParsers(previousOwner);
      previousDurableJobsDrained = cleanupScopeGeneration(
        scope,
        previousOwner,
        event,
        ctx,
      );
      scope.lifecycle = "shutdown";
    }
    advanceSessionScopeGeneration(scope.id);
    if (previousDurableJobsDrained && previousDurableStore) {
      await previousDurableJobsDrained;
      await revokeAndReleaseDurableWorkflowAuthoritySafely(
        scope,
        previousDurableStore,
      );
    }

    scope.lifecycle = "started";
    scope.ui = ctx.ui;
    scope.sessionManager = ctx.sessionManager;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (sessionId) {
      const ownerId = `session-${createHash("sha256").update(sessionId).digest("hex")}`;
      const preservedOwnerGeneration =
        scope.durableWorkflowOwner?.piSessionId === sessionId &&
        scope.durableWorkflowOwner.cwd === ctx.cwd
          ? scope.durableWorkflowOwner.ownerGeneration
          : 0;
      const leaseToken = createHash("sha256")
        .update(`${ctx.cwd}\0${sessionId}`)
        .digest("hex");
      setDurableWorkflowOwner(
        scope,
        workflowOwnerFromSessionContext({
          projectKey: basename(ctx.cwd) || "project",
          cwd: ctx.cwd,
          sessionId,
          ownerId,
          generation: preservedOwnerGeneration,
          leaseToken,
        }),
      );
    } else {
      setDurableWorkflowOwner(scope, undefined);
    }
    scope.parentStreaming = false;
    if (durableContext) {
      setDurableWorkflowRootDir(scope, durableContext.rootDir);
      setDurableWorkflowOwner(scope, durableContext.owner);
    } else {
      setDurableWorkflowOwner(scope, undefined);
    }
    registerSessionScope(scope);
    if (scope.durableWorkflowOwner) {
      durableWorkflowControllerForSession(scope);
    }
    setLegacyActiveSessionRefs(scope);

    ensureInteractivePoller(globalState);

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
      try {
        await recoverDurableWorkflowProjections(scope);
      } catch (error) {
        console.error(
          "[subagentura] durable workflow namespace recovery failed",
          error,
        );
      }
    }
    void reconcileDurableWorkflowDeliveries(scope, ctx.cwd);
    ensureInteractivePoller(globalState);
  });

  (pi as any).on?.(
    "session_shutdown",
    async (
      event?: { reason?: string },
      ctx?: { cwd?: string; sessionManager?: { getSessionId?: () => string } },
    ) => {
      if (scope.lifecycle !== "started") return;

      const owner = sessionOwner(scope);
      const durableStore = scope.durableWorkflowStore;
      closeActiveInteractiveSupervisor(owner);
      clearSessionParsers(owner);
      cleanupScopeGeneration(scope, owner, event, ctx);
      const releasePromise = releaseDurableWorkflowAuthorityWithRetry(scope);
      scope.parentStreaming = false;
      scope.lifecycle = "shutdown";
      advanceSessionScopeGeneration(scope.id);
      removeSessionScope(scope.id);

      const remainingScopes = getStartedSessionScopes();
      setLegacyActiveSessionRefs(remainingScopes.at(-1));
      if (remainingScopes.length === 0) {
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
      }
      await releasePromise;
    },
  );

  return scope;
}
