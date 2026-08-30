/**
 * Rehydrate orphan interactive sub-agents from the on-disk state file.
 *
 * Reads <cwd>/.pi/subagentura-state.json, reconstructs each
 * InteractiveSubagentState, sets its status via the existing
 * persisted lifecycle fold plus pane liveness, restores
 * persisted cursors and delivery receipts, and registers it.
 *
 * Idempotent — skips ids already in the registry. Designed to be called from
 * the session_start handler. The first poll tick after this returns sees
 * the rehydrated states and replays any backlog.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  loadInteractiveStates,
  updateInteractiveState,
  type InteractiveSubagentPersistedStateV2,
} from "./artifact";
import { reconcileDeliveryReceipts } from "./delivery";
import {
  registerCompletionExpectations,
  registerCompletionMember,
  type CompletionExpectation,
} from "./completion-coordinator";
import { debugLog } from "./helpers";
import {
  buildAttachCommandsForState,
  deriveInteractiveSubagentStatusFromLifecycle,
  interactiveSubagentRegistry,
  registerInteractiveSubagentState,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import {
  sessionOwner,
  type SessionOwnerToken,
  type SessionScope,
} from "./session-scope";

export const FAILED_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

interface RecoverableCompletionState {
  completionPolicy?: "each" | "group";
  completionGroupId?: string;
  pendingDeliveries?: Array<{
    completionPolicy?: "each" | "group";
    completionGroupId?: string;
  }>;
}

function recoveredGroupIds(state: RecoverableCompletionState): string[] {
  const groupIds = new Set<string>();
  if (state.completionPolicy === "group" && state.completionGroupId) {
    groupIds.add(state.completionGroupId);
  }
  for (const intent of state.pendingDeliveries ?? []) {
    if (intent.completionPolicy === "group" && intent.completionGroupId) {
      groupIds.add(intent.completionGroupId);
    }
  }
  return [...groupIds];
}

function downgradeRecoveredGroupPolicies(
  state: RecoverableCompletionState,
  groupIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  if (
    state.completionPolicy === "group" &&
    state.completionGroupId &&
    groupIds.has(state.completionGroupId)
  ) {
    state.completionPolicy = "each";
    delete state.completionGroupId;
    changed = true;
  }
  for (const intent of state.pendingDeliveries ?? []) {
    if (
      intent.completionPolicy !== "group" ||
      !intent.completionGroupId ||
      !groupIds.has(intent.completionGroupId)
    ) {
      continue;
    }
    intent.completionPolicy = "each";
    delete intent.completionGroupId;
    changed = true;
  }
  return changed;
}

function persistRecoveredGroupSanitization(
  cwd: string,
  entry: InteractiveSubagentPersistedStateV2,
  failedGroupIds: ReadonlySet<string>,
): void {
  try {
    updateInteractiveState(cwd, entry.id, (persisted) => {
      if (
        persisted.artifactDir !== entry.artifactDir ||
        persisted.parentSessionId !== entry.parentSessionId
      ) {
        return;
      }
      downgradeRecoveredGroupPolicies(persisted, failedGroupIds);
    });
  } catch (error) {
    debugLog("warn", "rehydrate_group_sanitization_failed", {
      stateId: entry.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function registerRecoveredGroups(
  state: InteractiveSubagentState,
  owner: SessionOwnerToken | undefined,
  attemptedMemberships: Set<string>,
  failedGroupIds: Set<string>,
): Set<string> {
  const affectedGroupIds = new Set<string>();
  for (const groupId of recoveredGroupIds(state)) {
    if (failedGroupIds.has(groupId)) {
      affectedGroupIds.add(groupId);
      continue;
    }
    const membershipKey = JSON.stringify(["interactive", state.id, groupId]);
    if (attemptedMemberships.has(membershipKey)) continue;
    attemptedMemberships.add(membershipKey);
    try {
      registerCompletionMember(
        "interactive",
        state.id,
        "group",
        groupId,
        owner,
      );
    } catch (error) {
      failedGroupIds.add(groupId);
      affectedGroupIds.add(groupId);
      debugLog("warn", "rehydrate_group_registration_failed", {
        stateId: state.id,
        groupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return affectedGroupIds;
}

export function rehydrateInteractiveSubagents(
  cwd: string,
  currentSessionId?: string,
  sessionEntries: unknown[] = [],
  scope?: SessionScope,
): {
  total: number;
  alive: number;
  terminal: number;
} {
  const payload = loadInteractiveStates(cwd);
  if (!payload) return { total: 0, alive: 0, terminal: 0 };

  let alive = 0;
  let terminal = 0;
  const owner: SessionOwnerToken | undefined = scope
    ? sessionOwner(scope)
    : undefined;
  const attemptedMemberships = new Set<string>();
  const failedGroupIds = new Set<string>();

  // A rejected group is full or closed for this recovery pass; downgrade only
  // its remaining persisted members and keep recovering unrelated states.
  const now = Date.now();
  const recoveredStates: Array<{
    entry: InteractiveSubagentPersistedStateV2;
    state: InteractiveSubagentState;
  }> = [];
  const expectations: CompletionExpectation[] = [];
  for (const entry of Object.values(
    payload.states,
  ) as Array<InteractiveSubagentPersistedStateV2>) {
    const tombstoneAt = entry.completionTombstoneAt;
    const tombstoneExpired =
      tombstoneAt === undefined ||
      (typeof tombstoneAt === "number" &&
        Number.isFinite(tombstoneAt) &&
        tombstoneAt <= now &&
        now - tombstoneAt >= FAILED_TOMBSTONE_TTL_MS);
    if (entry.completionTombstone === "failed" && !tombstoneExpired) {
      continue;
    }
    if (currentSessionId && entry.parentSessionId !== currentSessionId) {
      continue;
    }
    if (currentSessionId) {
      try {
        const artifactOwner = readFileSync(
          join(entry.artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
          "utf8",
        );
        if (artifactOwner !== currentSessionId) continue;
      } catch (error) {
        // Missing markers are valid legacy state; other read failures fail closed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
    }
    if (
      (scope?.interactiveStates ?? interactiveSubagentRegistry).has(entry.id)
    ) {
      continue;
    }

    // Recovery is best-effort and must never throw; on missing files we
    // fall back to placeholder values (entry.id for name, 0 for startedAt).
    let recoveredName: string;
    try {
      const files = readdirSync(entry.artifactDir);
      const promptFile = files.find((f) => f.endsWith("-prompt.md"));
      recoveredName = promptFile
        ? promptFile.slice(0, -"-prompt.md".length)
        : entry.id;
    } catch {
      recoveredName = entry.id;
    }

    const startedAt = entry.lifecycle?.startedAt ?? 0;
    const partialLineStart = entry.sessionPartialLineStart;
    const sessionResumeCursor =
      partialLineStart === undefined
        ? 0
        : partialLineStart === null
          ? entry.sessionByteCursor
          : partialLineStart;

    const attach = (() => {
      try {
        return buildAttachCommandsForState(entry);
      } catch {
        return { attachCommand: "", focusCommand: "" };
      }
    })();

    const telemetryEligible =
      entry.telemetry !== undefined &&
      payload.telemetry?.correlationId === entry.telemetry.correlationId &&
      scope?.telemetry?.correlationId === entry.telemetry.correlationId;
    const telemetryActiveTurnId =
      telemetryEligible && entry.telemetry?.turnStartedAt !== undefined
        ? entry.telemetry.activeTurnId
        : undefined;
    const rehydrated: InteractiveSubagentState = {
      id: entry.id,
      name: recoveredName,
      task: "",
      paneId: entry.paneId,
      windowName: entry.windowName,
      mux: entry.mux,
      muxSession: entry.muxSession,
      sessionFile: entry.sessionFile,
      cwd,
      startedAt,
      status: "running",
      attachCommand: attach.attachCommand,
      selectPaneCommand: attach.focusCommand,
      launchScriptFile: "",
      artifactDir: entry.artifactDir,
      notifyOnComplete: entry.notifyOnComplete,
      triggerTurnOnComplete: entry.triggerTurnOnComplete,
      completionPolicy: entry.completionPolicy,
      completionGroupId: entry.completionGroupId,
      parentSessionId: entry.parentSessionId ?? "pi",
      eventByteCursor: entry.eventByteCursor,
      lastDeliveredSessionByte: sessionResumeCursor,
      sessionPartialLineStart:
        typeof partialLineStart === "number" ? partialLineStart : undefined,
      sessionObservedByteCursor: entry.sessionByteCursor,
      activeTurnId: entry.activeTurnId,
      pendingDeliveries: [...entry.pendingDeliveries],
      deliveryReceipts: [...entry.deliveryReceipts],
      lifecycle: entry.lifecycle ? { ...entry.lifecycle } : {},
      telemetryCorrelationId: entry.telemetry?.correlationId,
      telemetryEligible,
      telemetryActiveTurnId,
      telemetryTurnStartedAt: telemetryActiveTurnId
        ? entry.telemetry?.turnStartedAt
        : undefined,
      telemetryTurnMessageCounts: telemetryEligible
        ? new Map(Object.entries(entry.telemetry?.messageCounts ?? {}))
        : undefined,
      telemetryMessageTurnId: telemetryActiveTurnId,
      telemetryInvocationSource: entry.telemetry?.invocationSource,
      telemetryCompletionPolicy: entry.telemetry?.completionPolicy,
      telemetryAsync: entry.telemetry?.async,
      telemetryDepth: entry.telemetry?.depth,
      telemetryDepthBucket: entry.telemetry?.depthBucket,
      telemetryModel: entry.telemetry?.model,
      // Legacy timestamp fields remain for API compatibility only.
      lastDeliveredEventTs: undefined,
      lastInjectedEventTs: undefined,
      lastSnapshotEventTs: undefined,
      injected: undefined,
      autoDoneForTurnAt: undefined,
      lastStopReason: undefined,
      lastStopReasonAt: undefined,
      lastStopText: undefined,
    };

    const paneAlive = isPaneAlive(rehydrated);
    const next = deriveInteractiveSubagentStatusFromLifecycle(
      rehydrated.lifecycle ?? {},
      paneAlive,
    );
    rehydrated.status = next;
    recoveredStates.push({ entry, state: rehydrated });
    if (next === "exited" || next === "cancelled") terminal++;
    else if (next === "running" || next === "idle") alive++;
    for (const intent of rehydrated.pendingDeliveries ?? []) {
      if (
        !intent.completionPolicy ||
        intent.deliveryId.length === 0 ||
        intent.deliveryId.length > 128 ||
        intent.turnId.length === 0 ||
        intent.turnId.length > 256
      ) {
        continue;
      }
      expectations.push({
        completionId: intent.deliveryId,
        source: "interactive",
        sourceId: rehydrated.id,
        turnId: intent.turnId,
      });
    }
  }

  // Register every pending coordinated intent before any group registration
  // or receipt reconciliation can create the coordinator's first ledger scan.
  if (owner && expectations.length > 0) {
    try {
      registerCompletionExpectations(expectations, owner);
    } catch (error) {
      debugLog("warn", "rehydrate_completion_expectation_registration_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const { entry, state: rehydrated } of recoveredStates) {
    reconcileDeliveryReceipts(rehydrated, sessionEntries, owner);
    const affectedGroupIds = registerRecoveredGroups(
      rehydrated,
      owner,
      attemptedMemberships,
      failedGroupIds,
    );
    if (
      affectedGroupIds.size > 0 &&
      downgradeRecoveredGroupPolicies(rehydrated, affectedGroupIds)
    ) {
      persistRecoveredGroupSanitization(cwd, entry, affectedGroupIds);
    }
    registerInteractiveSubagentState(rehydrated, scope);
  }

  return { total: Object.keys(payload.states).length, alive, terminal };
}
