import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  WorkspaceAdoptParams,
  WorkspaceAssignParams,
  WorkspaceDiscoverParams,
  WorkspaceObservePrParams,
  WorkspacePublicationParams,
  WorkspaceReconcileParams,
  WorkspaceRecoverParams,
  WorkspaceRecordPrParams,
  WorkspaceRegisterSlotParams,
  WorkspaceReleaseParams,
  WorkspaceReportParams,
} from "../schemas";
import { isOrchestratorV2WakeupMessage } from "../completion-turn";
import {
  cancelInteractiveSubagent,
  isPaneAlive,
  launchInteractiveSubagent,
  type InteractiveSubagentState,
} from "../interactive-tmux";
import {
  resolveToolSessionScope,
  sessionOwner,
  type SessionScope,
  type SessionToolToken,
} from "../session-scope";
import {
  reportWorkspaceProposal,
  type WorkspaceFact,
  type WorkspaceProposalKind,
} from "../workspace-reports";
import {
  WorkspaceManager,
  type WorkspaceChildRuntime,
  type WorkspaceManagerError,
} from "../workspace-manager";
import { registerToolWithDefaultGuidance } from "../tool-guidance";

const CONFIRMATION_PREFIX = "workspace-confirm:";
const MAX_CONFIRMATION_BYTES = 128;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 32;

interface PendingConfirmation {
  payload: string;
  generation: number;
  issuedAfterUserEntryId?: string;
  createdAt: number;
}

const pendingConfirmations = new WeakMap<
  SessionScope,
  Map<string, PendingConfirmation>
>();

function pendingFor(scope: SessionScope): Map<string, PendingConfirmation> {
  let pending = pendingConfirmations.get(scope);
  if (!pending) {
    pending = new Map();
    pendingConfirmations.set(scope, pending);
  }
  return pending;
}

function latestUserMessage(ctx: any): { id: string; text: string } | undefined {
  const entries = ctx?.sessionManager?.getBranch?.() ?? [];
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((part: any) =>
                typeof part === "string" ? part : (part?.text ?? ""),
              )
              .join("\n")
          : "";
    if (isOrchestratorV2WakeupMessage(text)) continue;
    return typeof entry.id === "string" ? { id: entry.id, text } : undefined;
  }
  return undefined;
}

function confirmation(
  scope: SessionScope,
  ctx: any,
  payload: string,
  confirmed: boolean,
  token: string | undefined,
): { ok: true; token: string } | { ok: false; result: any } {
  const pending = pendingFor(scope);
  const now = Date.now();
  for (const [key, value] of pending) {
    if (now - value.createdAt > CONFIRMATION_TTL_MS) pending.delete(key);
  }
  if (!confirmed) {
    while (pending.size >= MAX_PENDING_CONFIRMATIONS) {
      const oldest = pending.keys().next().value as string | undefined;
      if (!oldest) break;
      pending.delete(oldest);
    }
    const issued = `${CONFIRMATION_PREFIX}${randomUUID()}`;
    pending.set(issued, {
      payload,
      generation: scope.generation,
      issuedAfterUserEntryId: latestUserMessage(ctx)?.id,
      createdAt: now,
    });
    return {
      ok: false,
      result: toolResult(
        "confirmation_required",
        `Explicit user confirmation is required. Ask the user to send ${issued}, then retry the identical request with confirmed=true and confirmationToken.`,
        { confirmationToken: issued },
        true,
      ),
    };
  }
  const entry = token ? pending.get(token) : undefined;
  const user = latestUserMessage(ctx);
  if (
    !token ||
    !entry ||
    entry.payload !== payload ||
    entry.generation !== scope.generation ||
    !user ||
    user.id === entry.issuedAfterUserEntryId ||
    !user.text.includes(token)
  ) {
    return {
      ok: false,
      result: toolResult(
        "confirmation_invalid",
        "No matching later user confirmation exists for this exact workspace request.",
        {},
        true,
      ),
    };
  }
  return { ok: true, token };
}

function toolResult(
  status: string,
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
): any {
  return {
    content: [{ type: "text", text }],
    details: { status, ...details },
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown): any {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as WorkspaceManagerError).code)
      : "unknown";
  return toolResult(
    "error",
    `Workspace operation blocked: ${code}.`,
    { code },
    true,
  );
}

function jsonResult(status: string, value: unknown): any {
  return toolResult(status, JSON.stringify(value, null, 2), { value });
}

function runtimeForState(
  state: InteractiveSubagentState,
): WorkspaceChildRuntime {
  return {
    id: state.id,
    status: state.status,
    workingCwd: state.workingCwd,
    artifactDir: state.artifactDir,
    workspaceRepoId: state.workspaceRepoId,
    workspaceSlotId: state.workspaceSlotId,
    workspaceAssignmentId: state.workspaceAssignmentId,
    workspaceAssignmentEpoch: state.workspaceAssignmentEpoch,
    workspaceBranchRef: state.workspaceBranchRef,
  };
}

function managerFor(scope: SessionScope, ctx: any): WorkspaceManager {
  return new WorkspaceManager({
    scope,
    sessionCwd: ctx.cwd,
    parentSessionId: scope.sessionManager?.getSessionId?.(),
    getChild: (childId) => {
      const state = scope.interactiveStates.get(childId);
      return state ? runtimeForState(state) : undefined;
    },
    launchChild: (params) => {
      const state = launchInteractiveSubagent({
        name: params.name,
        task: params.task,
        persona: params.persona,
        model: params.model,
        cwd: params.cwd,
        parentCwd: params.parentCwd,
        parentSessionId: params.parentSessionId,
        sessionScope: params.sessionScope,
        preallocatedId: params.preallocatedId,
        workspaceAssignment: params.workspaceAssignment,
      });
      return runtimeForState(state);
    },
    closeChild: (child) => {
      const state = scope.interactiveStates.get(child.id);
      if (!state) return { closed: false, paneAlive: true };
      cancelInteractiveSubagent(state.id, "cancel_interactive_subagent", state);
      return { closed: true, paneAlive: isPaneAlive(state) };
    },
  });
}

function executeParentTool(
  pi: ExtensionAPI,
  scope: SessionScope,
  execute: (
    manager: WorkspaceManager,
    ctx: any,
    signal?: AbortSignal,
    params?: any,
  ) => Promise<any>,
): (
  toolCallId: string,
  params: any,
  signal: AbortSignal,
  onUpdate: any,
  ctx: any,
) => Promise<any> {
  return async (_toolCallId, params, signal, _onUpdate, ctx) => {
    if (scope.lifecycle !== "started")
      return toolResult(
        "session_unavailable",
        "Workspace tool is no longer attached to a live session.",
        {},
        true,
      );
    try {
      return await execute(managerFor(scope, ctx), ctx, signal, params);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerWorkspaceTools(
  pi: ExtensionAPI,
  registrationScope?: SessionScope,
  childMode = false,
): void {
  const scope = registrationScope;
  const token: SessionToolToken | undefined = scope
    ? { id: scope.id }
    : undefined;
  if (childMode) {
    registerToolWithDefaultGuidance(pi, {
      name: "workspace_report",
      label: "Workspace Report",
      description:
        "Write a bounded, epoch-bound advisory workspace proposal for the parent to review. Reports never change workspace authority.",
      parameters: WorkspaceReportParams,
      async execute(_toolCallId, params) {
        try {
          const artifactDir = process.env.ARTIFACT_DIR;
          if (!artifactDir)
            return toolResult(
              "invalid_input",
              "Workspace reports require a child artifact directory.",
              {},
              true,
            );
          const proposal = reportWorkspaceProposal(artifactDir, {
            proposalId: params.proposalId,
            turnId: params.turnId,
            kind: params.kind as WorkspaceProposalKind,
            facts: params.facts as Record<string, WorkspaceFact>,
            reportedAt: params.reportedAt,
          });
          return jsonResult("reported", proposal);
        } catch (error) {
          return errorResult(error);
        }
      },
    });
    return;
  }
  if (!scope) return;

  registerToolWithDefaultGuidance(pi, {
    name: "workspace_discover",
    label: "Workspace Discover",
    description:
      "Freshly discover the canonical repository, registered slots, worktree observations, and fail-closed occupancy without changing Git or claims.",
    parameters: WorkspaceDiscoverParams,
    execute: executeParentTool(pi, scope, async (manager, ctx) =>
      jsonResult("discovered", await manager.discover(ctx.cwd)),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_reconcile",
    label: "Workspace Reconcile",
    description:
      "Freshly reconcile registered workspace observations and advisory child proposals; never register, release, adopt, switch, clean, or launch.",
    parameters: WorkspaceReconcileParams,
    execute: executeParentTool(pi, scope, async (manager, ctx) => {
      const discovery = await manager.reconcile(ctx.cwd);
      let proposals: unknown[] = [];
      try {
        proposals = await manager.reconcileProposals(ctx.cwd);
      } catch {
        // Proposal files are advisory; a missing or malformed child report must not hide fresh Git state.
      }
      return jsonResult("reconciled", { discovery, proposals });
    }),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_register_slot",
    label: "Workspace Register Slot",
    description:
      "Explicitly register one freshly probed clean Git worktree as a durable reusable slot.",
    parameters: WorkspaceRegisterSlotParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult("registered", await manager.registerSlot(params, ctx.cwd)),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_release",
    label: "Workspace Release",
    description:
      "Release an exact managed assignment only after a fresh clean/non-ignored/non-conflicted/admin-safe probe; closeChild must be explicit for an idle child.",
    parameters: WorkspaceReleaseParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult("released", await manager.release(params, ctx.cwd)),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_assign",
    label: "Workspace Assign",
    description:
      "Reserve an exact slot and assignment, optionally perform one durable-intent-backed non-force branch switch/create, and optionally bind a fresh or exact idle child.",
    parameters: WorkspaceAssignParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult("assigned", await manager.assign(params, ctx.cwd)),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_adopt",
    label: "Workspace Adopt",
    description:
      "Explicitly adopt an assignment from another durable owner only after a later user confirmation and fresh exact evidence.",
    parameters: WorkspaceAdoptParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentScope = resolveToolSessionScope(token);
      if (!currentScope)
        return toolResult(
          "session_unavailable",
          "Workspace tool is no longer attached to a live session.",
          {},
          true,
        );
      const payload = JSON.stringify({
        repoId: params.repoId,
        slotId: params.slotId,
        assignmentId: params.assignmentId,
        expectedRevision: params.expectedRevision,
        expectedEpoch: params.expectedEpoch,
      });
      const check = confirmation(
        currentScope,
        ctx,
        payload,
        params.confirmed,
        params.confirmationToken,
      );
      if (!check.ok) return check.result;
      try {
        const result = await managerFor(currentScope, ctx).adopt(
          params,
          ctx.cwd,
        );
        pendingFor(currentScope).delete(check.token);
        return jsonResult("adopted", result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_recover",
    label: "Workspace Recover",
    description:
      "Classify a recorded Git transition from fresh evidence and persist the recovery decision; recovery never replays Git or performs repair.",
    parameters: WorkspaceRecoverParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentScope = resolveToolSessionScope(token);
      if (!currentScope)
        return toolResult(
          "session_unavailable",
          "Workspace tool is no longer attached to a live session.",
          {},
          true,
        );
      const payload = JSON.stringify({
        operationId: params.operationId,
        expectedRevision: params.expectedRevision,
        action: params.action,
      });
      const check = confirmation(
        currentScope,
        ctx,
        payload,
        params.confirmed,
        params.confirmationToken,
      );
      if (!check.ok) return check.result;
      try {
        const result = await managerFor(currentScope, ctx).recover(
          params.operationId,
          params.expectedRevision,
          params.action,
          ctx.cwd,
        );
        pendingFor(currentScope).delete(check.token);
        return jsonResult("recovered", result);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_observe_publication",
    label: "Workspace Observe Publication",
    description:
      "Record provider-neutral exact candidate-OID versus configured remote-ref evidence; publication observations never release a slot.",
    parameters: WorkspacePublicationParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult(
          "observed",
          await manager.observePublication(params, ctx.cwd),
        ),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_record_pr",
    label: "Workspace Record PR",
    description:
      "Record a bounded provider-neutral advisory pull-request association without live provider integration.",
    parameters: WorkspaceRecordPrParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult(
          "recorded",
          await manager.recordPrAssociation(params, ctx.cwd),
        ),
    ),
  });
  registerToolWithDefaultGuidance(pi, {
    name: "workspace_observe_pr",
    label: "Workspace Observe PR",
    description:
      "Record an exact provider-neutral PR observation with verification and freshness; PR state never releases or recycles a slot.",
    parameters: WorkspaceObservePrParams,
    execute: executeParentTool(
      pi,
      scope,
      async (manager, ctx, _signal, params) =>
        jsonResult("observed", await manager.observePr(params, ctx.cwd)),
    ),
  });
}

export {
  WorkspaceDiscoverParams,
  WorkspaceReconcileParams,
  WorkspaceRegisterSlotParams,
  WorkspaceReleaseParams,
  WorkspaceAssignParams,
  WorkspaceAdoptParams,
  WorkspaceRecoverParams,
  WorkspacePublicationParams,
  WorkspaceRecordPrParams,
  WorkspaceObservePrParams,
  WorkspaceReportParams,
};
