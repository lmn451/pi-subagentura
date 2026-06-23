/**
 * Sub-agent artifact storage.
 *
 * Each interactive sub-agent owns a directory under the parent's artifacts root.
 * The directory holds three kinds of files:
 *
 *   events.ndjson    — append-only log of lifecycle and tool_activity events
 *   output.md        — latest output the sub-agent produced; atomically rewritten each turn
 *   output-N.md      — per-turn snapshots: written by the parent poller on each new `done` event,
 *                      where N is the count of `done` events in events.ndjson at the time of the snapshot.
 *                      These preserve full turn history so a parent can re-read earlier turns even after
 *                      output.md is overwritten. The poller writes them right after it sees a new done event,
 *                      so by protocol (write output.md before calling done) the snapshot reflects that turn.
 *
 * Files survive parent-agent restarts, so a sub-agent can complete while the
 * parent is down and the parent can catch up by reading the artifact later.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import ndjson from "ndjson";
import { debugLog } from "./helpers";
import type { MuxName } from "./multiplexer";

// ── Types ───────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "done" | "error" | "cancelled";

export type SubagentEvent =
  | { ts: number; type: "started"; status: "running"; message?: string }
  | {
      ts: number;
      type: "tool_activity";
      status: "running";
      tool?: string;
      summary?: string;
      message?: string;
    }
  | {
      ts: number;
      type: "done";
      status: "done";
      exitCode?: number;
      message?: string;
      summary?: string;
    }
  | {
      ts: number;
      type: "error";
      status: "error";
      message?: string;
      exitCode?: number;
    }
  | { ts: number; type: "cancelled"; status: "cancelled"; message?: string };

export interface SubagentArtifact {
  id: string;
  dir: string;
  statusFile: string;
  outputFile: string;
}

// ── Paths ───────────────────────────────────────────────────────────

export function artifactPath(rootDir: string, id: string): SubagentArtifact {
  const dir = join(rootDir, id);
  return {
    id,
    dir,
    statusFile: join(dir, "events.ndjson"),
    outputFile: join(dir, "output.md"),
  };
}

/** Create the artifact directory with owner-only perms. Idempotent. */
export function ensureArtifactDir(art: SubagentArtifact): void {
  mkdirSync(art.dir, { recursive: true, mode: 0o700 });
}

// ── Writes ──────────────────────────────────────────────────────────

/** Append one event to the NDJSON log. Creates the dir if needed. */
export function appendEvent(art: SubagentArtifact, event: SubagentEvent): void {
  ensureArtifactDir(art);
  appendFileSync(art.statusFile, JSON.stringify(event) + "\n", { mode: 0o600 });
}

/**
 * Atomically replace output.md with `content`. The actual write goes to a
 * sibling .tmp file first; renameSync is atomic within a filesystem, so a
 * concurrent reader sees either the old content or the new — never partial.
 */
export function writeOutput(art: SubagentArtifact, content: string): void {
  ensureArtifactDir(art);
  const tmp = art.outputFile + ".tmp";
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, art.outputFile);
}

/**
 * Path of the per-turn snapshot file: `${artifactDir}/output-N.md`.
 * Exported so the poller (and tests) can name the file consistently.
 */
export function outputPathForTurn(art: SubagentArtifact, turn: number): string {
  return join(art.dir, `output-${turn}.md`);
}

/**
 * Snapshot the latest output.md into output-N.md, where N is the caller's choice (typically the
 * count of `done` events in events.ndjson at the moment of the snapshot). No-op if output.md is missing.
 * The snapshot uses an atomic rename from a sibling .tmp file, matching writeOutput's durability.
 *
 * Callers should pass N = events.filter(type === "done").length so that a re-poll of the same event
 * would compute the same N — but a guard inside would be brittle. Trust the caller.
 */
export function snapshotOutput(art: SubagentArtifact, turn: number): void {
  if (!existsSync(art.outputFile)) return;
  const target = outputPathForTurn(art, turn);
  const tmp = target + ".tmp";
  const content = readFileSync(art.outputFile, "utf8");
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Read a specific turn's snapshot (output-N.md). Returns null if the snapshot doesn't exist.
 */
export function readOutputForTurn(
  art: SubagentArtifact,
  turn: number,
): string | null {
  const target = outputPathForTurn(art, turn);
  if (!existsSync(target)) return null;
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/**
 * List the turn numbers for which a snapshot exists. Sorted ascending. Used by read_subagent_artifact
 * to summarize the available history.
 */
export function listOutputTurns(art: SubagentArtifact): number[] {
  if (!existsSync(art.dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(art.dir);
  } catch {
    return [];
  }
  const turns: number[] = [];
  for (const name of entries) {
    const m = /^output-(\d+)\.md$/.exec(name);
    if (m) turns.push(Number(m[1]));
  }
  turns.sort((a, b) => a - b);
  return turns;
}

// ── Reads ───────────────────────────────────────────────────────────

/**
 * Read all events for a sub-agent. If `since` is provided, only events with
 * ts >= since are returned. Malformed lines are silently skipped (the
 * sub-agent CLI is the only writer, but a partial write could in theory
 * leave a truncated line).
 *
 * Uses the `ndjson` library with `strict: false` so a single bad line does not abort the whole
 * file — ndjson drops the bad row and continues with the rest. Any trailing partial line (file
 * did not end with a newline) is buffered by the parser and dropped on `end()`; it is treated as a
 * in-progress write that the next reader will pick up once completed.
 */
export function readEvents(
  art: SubagentArtifact,
  since?: number,
): SubagentEvent[] {
  if (!existsSync(art.statusFile)) return [];
  let content: string;
  try {
    content = readFileSync(art.statusFile, "utf8");
  } catch {
    return [];
  }
  const parser = ndjson.parse({ strict: false });
  const events: SubagentEvent[] = [];
  parser.on("data", (obj: unknown) => {
    const ev = obj as SubagentEvent;
    if (since === undefined || ev.ts >= since) events.push(ev);
  });
  // Non-strict mode never emits 'error' for bad JSON; attach a no-op so an unhandled error event
  // can never crash the parent process.
  parser.on("error", () => {});
  parser.end(Buffer.from(content, "utf8"));
  return events;
}

/** Returns output.md content, or null if it doesn't exist yet. */
export function readOutput(art: SubagentArtifact): string | null {
  if (!existsSync(art.outputFile)) return null;
  try {
    return readFileSync(art.outputFile, "utf8");
  } catch {
    return null;
  }
}

/** List all sub-agent artifacts under `rootDir`. Ignores loose files. */
export function listArtifacts(rootDir: string): SubagentArtifact[] {
  if (!existsSync(rootDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const out: SubagentArtifact[] = [];
  for (const name of entries) {
    const full = join(rootDir, name);
    try {
      if (statSync(full).isDirectory()) {
        out.push(artifactPath(rootDir, name));
      }
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/** Most recent event, or null if no events yet. */
export function lastEvent(art: SubagentArtifact): SubagentEvent | null {
  const events = readEvents(art);
  return events.length > 0 ? events[events.length - 1] : null;
}

// ── Persisted interactive state (project-local, per parent session) ───────────

/**

 * Per-entry shape. The minimum to drive sendCommandToPane (src/interactive-tmux.ts:533),

 * isPaneAlive (:525), cancelInteractiveSubagent (:557), and the poller's tailReadSessionLog

 * (:714). Fields like task/model/startedAt are intentionally not persisted — they're

 * recoverable from the launch script + prompt file on demand, or not needed for live ops.

 */

export interface InteractiveSubagentPersistedStateV1 {
  id: string;

  paneId: string;

  windowName?: string;

  mux: MuxName;

  muxSession?: string;

  artifactDir: string;

  sessionFile: string;

  notifyOnComplete?: "notify" | "inject";

  /** Parent pi session id; only rehydrated when the current session matches. */
  parentSessionId?: string;
}

export interface InteractiveSubagentStateFile {
  schemaVersion: 1;

  /** Parent pi session id; redundant with the filename but kept for verification/debugging. */

  parent: string;

  states: { [id: string]: InteractiveSubagentPersistedStateV1 };
}

/** File path for the project-local state file under .pi/. */

export function stateFilePath(cwd: string): string {
  return join(cwd, ".pi", "subagentura-state.json");
}
/**
 * Read the state file. Returns null on missing file, malformed
 * JSON, or schemaVersion mismatch. Never throws — defensive readers for untrusted input
 * (the file could be hand-edited or partial from a crash mid-rename).
 */

export function loadInteractiveStates(
  cwd: string,
): InteractiveSubagentStateFile | null {
  const file = stateFilePath(cwd);

  let content: string;

  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    debugLog("warn", "state-file-unknown-schema", {
      schemaVersion: obj.schemaVersion as number,
    });
    return null;
  }

  if (!obj.states || typeof obj.states !== "object") {
    return {
      schemaVersion: 1,
      parent: String(obj.parent ?? "pi"),
      states: {},
    };
  }

  return {
    schemaVersion: 1,

    parent: String(obj.parent ?? "pi"),

    states: obj.states as { [id: string]: InteractiveSubagentPersistedStateV1 },
  };
}
/**
 * Atomically write the state file. Creates .pi/ if needed.
 * Mode 0o700 on .pi/, mode 0o600 on the file. Atomic via *.tmp + rename.
 */
export function saveInteractiveStates(
  cwd: string,
  payload: InteractiveSubagentStateFile,
): void {
  if (payload.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion: ${payload.schemaVersion}`);
  }

  const file = stateFilePath(cwd);

  mkdirSync(join(cwd, ".pi"), { recursive: true, mode: 0o700 });

  const tmp = file + ".tmp";

  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });

  renameSync(tmp, file);
}
// SAFETY: load-modify-write is not atomic across concurrent callers.
// Safe today only because a pi session is single-event-loop and never
// calls this re-entrantly. Do NOT call from parallel async paths without
// adding a write lock.
/**
 * Convenience: load (or create fresh) + add/overwrite entry by id + save.
 * Called from hot paths (spawn) where a write failure must not break the parent.
 */
export function appendInteractiveState(
  cwd: string,
  entry: InteractiveSubagentPersistedStateV1,
): void {
  const current = loadInteractiveStates(cwd) ?? {
    schemaVersion: 1,

    parent: "pi",

    states: {},
  };

  current.states[entry.id] = entry;

  saveInteractiveStates(cwd, current);
}

// SAFETY: load-modify-write is not atomic across concurrent callers.
// Safe today only because a pi session is single-event-loop and never
// calls this re-entrantly. Do NOT call from parallel async paths without
// adding a write lock.
/**
 * Convenience: load + drop entry by id + save. No-op if absent or file missing.
 */
export function removeInteractiveState(cwd: string, id: string): void {
  const current = loadInteractiveStates(cwd);

  if (!current) return;

  if (!(id in current.states)) return;

  delete current.states[id];

  saveInteractiveStates(cwd, current);
}
/**
 * Delete the state file outright. Used on session_shutdown(reason="new") to
 * give the next session a clean slate. No-op if the file doesn't exist.
 */
export function deleteInteractiveStatesFile(cwd: string): void {
  try {
    unlinkSync(stateFilePath(cwd));
  } catch {
    /* best effort — file may not exist */
  }
}
