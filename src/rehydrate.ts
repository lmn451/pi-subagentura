/**
 * Rehydrate orphan interactive sub-agents from the on-disk state file.
 *
 * Reads <cwd>/.pi/subagentura-state.json, reconstructs each
 * InteractiveSubagentState, sets its status via the existing
 * deriveInteractiveSubagentStatus matrix (lastEvent + isPaneAlive), registers
 * it, and resets runtime cursors so the existing poller backlog-catch-up path
 * replays any events that landed during downtime.
 *
 * Idempotent — skips ids already in the registry. Designed to be called from
 * the session_start handler. The first poll tick after this returns sees
 * the rehydrated states and replays any backlog.
 */

import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  artifactPath,
  lastEvent,
  loadInteractiveStates,
  readEvents,
  type InteractiveSubagentPersistedStateV1,
} from "./artifact";
import {
  buildAttachCommandsForState,
  deriveInteractiveSubagentStatus,
  interactiveSubagentRegistry,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";

export function rehydrateInteractiveSubagents(
  cwd: string,
  currentSessionId?: string,
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
  ) as Array<InteractiveSubagentPersistedStateV1>) {
    if (currentSessionId && entry.parentSessionId !== currentSessionId) {
      continue;
    }
    if (interactiveSubagentRegistry.has(entry.id)) continue;

    // Recovery is best-effort and must never throw; on missing files we
    // fall back to placeholder values (entry.id for name, 0 for startedAt).
    const art = artifactPath(
      dirname(entry.artifactDir),
      basename(entry.artifactDir),
    );

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

    let startedAt: number;
    try {
      const events = readEvents(art);
      startedAt = events.length > 0 ? events[0].ts : 0;
    } catch {
      startedAt = 0;
    }

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
      parentSessionId: entry.parentSessionId ?? "pi",
      // All runtime cursors reset (replay-all semantics).
      lastDeliveredEventTs: 0,
      lastDeliveredSessionByte: 0,
      lastInjectedEventTs: undefined,
      lastSnapshotEventTs: undefined,
      injected: undefined,
      autoDoneForTurnAt: undefined,
      lastStopReason: undefined,
      lastStopReasonAt: undefined,
      lastStopText: undefined,
    };

    const last = lastEvent(art);
    const paneAlive = isPaneAlive(rehydrated);
    const next = deriveInteractiveSubagentStatus(last, paneAlive);
    rehydrated.status = next;
    // Deliberately do NOT suppress re-injection here. The inject-mode path
    // fires on every NEW `done` event (line 682, `lastInjectedEventTs !== last.ts`).
    // On rehydrate, cursors are reset to 0 and lastInjectedEventTs starts as undefined,
    // so the first poll will re-inject the latest terminal event for inject-mode orphans.
    // This means exactly one extra inject per sub-agent on parent reload, which is
    // acceptable — it's better than silently dropping a result that completed during
    // the reload downtime (the pre-fix behavior).
    if (next === "exited" || next === "cancelled") terminal++;
    else if (next === "running" || next === "idle") alive++;
    interactiveSubagentRegistry.set(entry.id, rehydrated);
  }

  return { total: Object.keys(payload.states).length, alive, terminal };
}
