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
  type InteractiveSubagentPersistedState,
} from "./artifact";
import { reconcileDeliveryReceipts } from "./delivery";
import {
  buildAttachCommandsForState,
  deriveInteractiveSubagentStatusFromLifecycle,
  interactiveSubagentRegistry,
  registerInteractiveSubagentState,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import { sessionOwner, type SessionScope } from "./session-scope";

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

  for (const entry of Object.values(
    payload.states,
  ) as Array<InteractiveSubagentPersistedState>) {
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
      parentSessionId: entry.parentSessionId ?? "pi",
      completionOwner: entry.completionOwner,
      ...(entry.completionOwner === "workflow"
        ? {
            workflowId: entry.workflowId,
            workflowProcessIdentity: entry.workflowProcessIdentity,
          }
        : {}),
      eventByteCursor: entry.eventByteCursor,
      lastDeliveredSessionByte: sessionResumeCursor,
      sessionPartialLineStart:
        typeof partialLineStart === "number" ? partialLineStart : undefined,
      sessionObservedByteCursor: entry.sessionByteCursor,
      activeTurnId: entry.activeTurnId,
      pendingDeliveries: [...entry.pendingDeliveries],
      deliveryReceipts: [...entry.deliveryReceipts],
      lifecycle: entry.lifecycle ? { ...entry.lifecycle } : {},
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
    reconcileDeliveryReceipts(
      rehydrated,
      sessionEntries,
      scope ? sessionOwner(scope) : undefined,
    );
    if (next === "exited" || next === "cancelled") terminal++;
    else if (next === "running" || next === "idle") alive++;
    registerInteractiveSubagentState(rehydrated, scope);
  }

  return { total: Object.keys(payload.states).length, alive, terminal };
}
