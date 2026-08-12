/**
 * Sub-agent artifact storage.
 *
 * Each interactive sub-agent owns a directory under the parent's artifacts root.
 * The directory holds three kinds of files:
 *
 *   events.ndjson    — append-only log of lifecycle and tool_activity events
 *   output.md        — mutable staging file for the active child turn; reset at turn start
 *   outputs/<id>.md  — immutable protocol-v2 snapshots, atomically captured
 *                      before their completion event is appended
 *   output-N.md      — legacy numeric snapshots retained for compatibility
 *
 * Files survive parent-agent restarts, so a sub-agent can complete while the
 * parent is down and the parent can catch up by reading the artifact later.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import isPathInside from "is-path-inside";
import { debugLog } from "./helpers";
import type { MuxName } from "./multiplexer";
import {
  isWorkflowProcessAttemptIdentity,
  type WorkflowProcessAttemptIdentity,
} from "./workflow-process-attempt";

/** Current schema version for the interactive state file. */
export const CURRENT_STATE_SCHEMA_VERSION = 3;

// ── Types ───────────────────────────────────────────────────────────

export type SubagentStatus = "running" | "done" | "error" | "cancelled";

export interface OutputSnapshot {
  path: string;
  bytes: number;
  sha256: string;
}

export type OutputSnapshotError =
  | {
      code: "output_too_large";
      bytes: number;
      maxBytes: number;
    }
  | {
      code: "output_unavailable";
      message: string;
    };

export interface OutputHistoryEntry {
  turnId: string;
  eventId: string;
  output?: OutputSnapshot;
  outputError?: OutputSnapshotError;
}

export type CompletionOutcome = "done" | "error" | "cancelled";
export type CompletionSource =
  "agent_settled" | "agent_end" | "explicit" | "process_exit" | "parent";

export type SubagentEventV2 =
  | {
      version: 2;
      eventId: string;
      turnId: string;
      ts: number;
      type: "turn_started";
      status: "running";
      message?: string;
    }
  | {
      version: 2;
      eventId: string;
      turnId: string;
      ts: number;
      type: "tool_activity";
      status: "running";
      phase: "start" | "end";
      tool?: string;
      summary?: string;
      message?: string;
    }
  | {
      version: 2;
      eventId: string;
      turnId: string;
      ts: number;
      type: "completion";
      status: "done" | "error" | "cancelled";
      outcome: CompletionOutcome;
      source: CompletionSource;
      output?: OutputSnapshot;
      outputError?: OutputSnapshotError;
      exitCode?: number;
      message?: string;
      errorMessage?: string;
      summary?: string;
    }
  | {
      version: 2;
      eventId: string;
      turnId: string;
      ts: number;
      type: "process_exited";
      status: "done" | "error" | "cancelled";
      exitCode: number;
      message?: string;
    };

export type CompletionEventV2 = Extract<
  SubagentEventV2,
  { type: "completion" }
>;
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
  | { ts: number; type: "cancelled"; status: "cancelled"; message?: string }
  | SubagentEventV2;

export type LegacyCompletionEvent = Extract<
  SubagentEvent,
  { type: "done" | "error" | "cancelled" }
>;
export type TurnTerminalEvent = LegacyCompletionEvent | CompletionEventV2;
export type CompletionEvent = TurnTerminalEvent;

// ── Exhaustive event classification helpers ────────────────────────

/** Exhaustiveness checker for discriminated unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

/**
 * Workflow-waiting semantics: authoritative turn completions are legacy
 * done/error/cancelled events or a v2 completion. A process_exited event is
 * excluded so the pane-death grace period can observe a final completion flush.
 */
export function isTurnTerminal(
  event: SubagentEvent,
): event is TurnTerminalEvent {
  switch (event.type) {
    case "done":
    case "error":
    case "cancelled":
    case "completion":
      return true;
    case "started":
    case "tool_activity":
    case "turn_started":
    case "process_exited":
      return false;
    default:
      return assertNever(event);
  }
}

/**
 * Output-reporting semantics: these events establish that output is no longer
 * pending for the current observed turn or process.
 */
export function isArtifactOutputSettled(event: SubagentEvent): boolean {
  switch (event.type) {
    case "done":
    case "error":
    case "cancelled":
    case "completion":
    case "process_exited":
      return true;
    case "started":
    case "tool_activity":
    case "turn_started":
      return false;
    default:
      return assertNever(event);
  }
}

/**
 * Notification semantics: only completion/error/cancelled events should trigger
 * a wakeup notification to the parent. process_exited and activity events do not.
 */
export function isCompletionEvent(
  event: SubagentEvent,
): event is CompletionEvent {
  switch (event.type) {
    case "completion":
    case "done":
    case "error":
    case "cancelled":
      return true;
    case "started":
    case "tool_activity":
    case "turn_started":
    case "process_exited":
      return false;
    default:
      return assertNever(event);
  }
}

export interface EventRecord {
  event: SubagentEvent;
  startOffset: number;
  endOffset: number;
  raw: string;
  legacy: boolean;
}

export interface EventReadIssue {
  kind: "record_too_large";
  startOffset: number;
  endOffset: number;
  maxBytes: number;
}

export const MAX_EVENT_BATCH_BYTES = 256 * 1024;
export const MAX_EVENT_RECORD_BYTES = 4 * MAX_EVENT_BATCH_BYTES;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_TURN_ID_LENGTH = 256;
export const MAX_EVENT_TEXT_LENGTH = 2_000;
export const MAX_TOOL_NAME_LENGTH = 128;
export const MAX_OUTPUT_SNAPSHOT_BYTES = 1024 * 1024;

export function boundedOptionalEventText(
  value: unknown,
  maxLength = MAX_EVENT_TEXT_LENGTH,
): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

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

export function newEventId(): string {
  return randomUUID();
}

const COMPLETION_LOCK_TIMEOUT_MS = 2_000;
const COMPLETION_LOCK_STALE_MS = 30_000;
const completionLockWaiter = new Int32Array(new SharedArrayBuffer(4));

function completionLockPath(art: SubagentArtifact, turnId: string): string {
  const key = createHash("sha256").update(turnId).digest("hex").slice(0, 24);
  return join(art.dir, `.completion-${key}.lock`);
}

function withCompletionLock<T>(
  art: SubagentArtifact,
  turnId: string,
  operation: () => T,
): T {
  ensureArtifactDir(art);
  const lockPath = completionLockPath(art, turnId);
  const deadline = Date.now() + COMPLETION_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (
          Date.now() - statSync(lockPath).mtimeMs >
          COMPLETION_LOCK_STALE_MS
        ) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring completion lock for ${turnId}`);
      }
      Atomics.wait(completionLockWaiter, 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
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
  let fd: number | undefined;
  let content: Buffer;
  try {
    fd = openSync(art.outputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OUTPUT_SNAPSHOT_BYTES) return;
    content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(
        fd,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    content = content.subarray(0, offset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      debugLog("warn", "legacy_snapshot_output_unavailable", {
        artifactId: art.id,
        turn,
      });
    }
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* legacy snapshot content is already bounded in memory */
      }
    }
  }
  const target = outputPathForTurn(art, turn);
  const tmp = target + ".tmp";
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, target);
}

export function snapshotOutputForEvent(
  art: SubagentArtifact,
  eventId: string,
): { output?: OutputSnapshot; outputError?: OutputSnapshotError } {
  let fd: number | undefined;
  let content: Buffer;
  try {
    fd = openSync(art.outputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        outputError: {
          code: "output_unavailable",
          message: "output.md is not a regular file",
        },
      };
    }
    if (stat.size > MAX_OUTPUT_SNAPSHOT_BYTES) {
      return {
        outputError: {
          code: "output_too_large",
          bytes: stat.size,
          maxBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
        },
      };
    }
    content = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = readSync(
        fd,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    content = content.subarray(0, offset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      content = Buffer.alloc(0);
    } else {
      return {
        outputError: {
          code: "output_unavailable",
          message: "output.md could not be read safely",
        },
      };
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* snapshot content is already bounded in memory */
      }
    }
  }
  const outputsDir = join(art.dir, "outputs");
  mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
  const target = join(outputsDir, `${eventId}.md`);
  if (!existsSync(target)) {
    const tmp = target + ".tmp";
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, target);
  }
  return {
    output: {
      path: target,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  };
}

export function appendCompletionEvent(
  art: SubagentArtifact,
  params: {
    turnId: string;
    outcome: CompletionOutcome;
    source: CompletionSource;
    exitCode?: number;
    message?: string;
    errorMessage?: string;
    eventId?: string;
    ts?: number;
  },
): CompletionEventV2 | null {
  return withCompletionLock(art, params.turnId, () => {
    const existing = readEvents(art).find(
      (event) =>
        "version" in event &&
        event.version === 2 &&
        event.type === "completion" &&
        event.turnId === params.turnId,
    );
    if (existing) return null;
    const eventId = params.eventId ?? newEventId();
    const snapshot = snapshotOutputForEvent(art, eventId);
    const message = boundedOptionalEventText(params.message);
    const errorMessage = boundedOptionalEventText(params.errorMessage);
    const event: CompletionEventV2 = {
      version: 2,
      eventId,
      turnId: params.turnId,
      ts: params.ts ?? Date.now(),
      type: "completion",
      status: params.outcome,
      outcome: params.outcome,
      source: params.source,
      ...snapshot,
      ...(params.exitCode === undefined ? {} : { exitCode: params.exitCode }),
      ...(message ? { message } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
    appendEvent(art, event);
    return event;
  });
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

/** Protocol-v2 completion-to-snapshot mappings in physical event-log order. */
export function listOutputHistory(art: SubagentArtifact): OutputHistoryEntry[] {
  return readEvents(art).flatMap((event) => {
    if (
      !("version" in event) ||
      event.version !== 2 ||
      event.type !== "completion"
    ) {
      return [];
    }
    return [
      {
        turnId: event.turnId,
        eventId: event.eventId,
        ...(event.output ? { output: event.output } : {}),
        ...(event.outputError ? { outputError: event.outputError } : {}),
      },
    ];
  });
}

/** Read a protocol-v2 immutable snapshot through its Pi-derived turn id. */
export function readOutputForTurnId(
  art: SubagentArtifact,
  turnId: string,
): string | null {
  const history = listOutputHistory(art).find(
    (entry) => entry.turnId === turnId,
  );
  if (!history?.output) return null;
  const target = join(art.dir, "outputs", `${history.eventId}.md`);
  if (
    history.output.path !== target ||
    history.output.bytes > MAX_OUTPUT_SNAPSHOT_BYTES ||
    !existsSync(target)
  ) {
    return null;
  }
  let fd: number | undefined;
  try {
    const realArtifactDir = realpathSync(art.dir);
    const realTarget = realpathSync(target);
    if (!isPathInside(realTarget, realArtifactDir)) return null;
    fd = openSync(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== history.output.bytes) return null;
    const content = readFileSync(fd);
    if (
      content.byteLength !== history.output.bytes ||
      createHash("sha256").update(content).digest("hex") !==
        history.output.sha256.toLowerCase()
    ) {
      return null;
    }
    return content.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── Reads ───────────────────────────────────────────────────────────

function normalizeEvent(
  value: unknown,
  startOffset: number,
  raw: string,
): { event: SubagentEvent; legacy: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts) || obj.ts < 0) {
    return null;
  }
  const message = boundedOptionalEventText(obj.message);
  const summary = boundedOptionalEventText(obj.summary);
  const tool = boundedOptionalEventText(obj.tool, MAX_TOOL_NAME_LENGTH);
  const exitCode =
    typeof obj.exitCode === "number" && Number.isSafeInteger(obj.exitCode)
      ? obj.exitCode
      : undefined;
  if (obj.version !== 2) {
    const base = { ts: obj.ts, message };
    if (obj.type === "started")
      return {
        event: { ...base, type: "started", status: "running" },
        legacy: true,
      };
    if (obj.type === "tool_activity")
      return {
        event: {
          ...base,
          type: "tool_activity",
          status: "running",
          tool,
          summary,
        },
        legacy: true,
      };
    if (obj.type === "done")
      return {
        event: { ...base, type: "done", status: "done", exitCode, summary },
        legacy: true,
      };
    if (obj.type === "error")
      return {
        event: { ...base, type: "error", status: "error", exitCode },
        legacy: true,
      };
    if (obj.type === "cancelled")
      return {
        event: { ...base, type: "cancelled", status: "cancelled" },
        legacy: true,
      };
    return null;
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  const normalizeId = (
    candidate: unknown,
    prefix: "event" | "turn",
    maxLength: number,
  ): string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= maxLength &&
    /^[A-Za-z0-9._:-]+$/.test(candidate)
      ? candidate
      : `invalid-${prefix}-${startOffset}-${hash}`;
  const eventId = normalizeId(obj.eventId, "event", MAX_EVENT_ID_LENGTH);
  const turnId = normalizeId(obj.turnId, "turn", MAX_TURN_ID_LENGTH);
  const base = { version: 2 as const, eventId, turnId, ts: obj.ts };
  if (obj.type === "turn_started")
    return {
      event: { ...base, type: "turn_started", status: "running", message },
      legacy: false,
    };
  if (
    obj.type === "tool_activity" &&
    (obj.phase === "start" || obj.phase === "end")
  )
    return {
      event: {
        ...base,
        type: "tool_activity",
        status: "running",
        phase: obj.phase,
        tool,
        summary,
        message,
      },
      legacy: false,
    };
  if (
    obj.type === "completion" &&
    (obj.outcome === "done" ||
      obj.outcome === "error" ||
      obj.outcome === "cancelled") &&
    (obj.source === "agent_settled" ||
      obj.source === "agent_end" ||
      obj.source === "explicit" ||
      obj.source === "process_exit" ||
      obj.source === "parent")
  ) {
    const rawOutput = obj.output as Record<string, unknown> | undefined;
    const output =
      rawOutput &&
      typeof rawOutput === "object" &&
      typeof rawOutput.path === "string" &&
      rawOutput.path.length <= 4096 &&
      typeof rawOutput.bytes === "number" &&
      Number.isSafeInteger(rawOutput.bytes) &&
      rawOutput.bytes >= 0 &&
      typeof rawOutput.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(rawOutput.sha256)
        ? {
            path: rawOutput.path,
            bytes: rawOutput.bytes,
            sha256: rawOutput.sha256,
          }
        : undefined;
    const rawOutputError = obj.outputError as
      Record<string, unknown> | undefined;
    const outputError: OutputSnapshotError | undefined =
      rawOutputError?.code === "output_too_large" &&
      typeof rawOutputError.bytes === "number" &&
      Number.isSafeInteger(rawOutputError.bytes) &&
      rawOutputError.bytes >= 0 &&
      typeof rawOutputError.maxBytes === "number" &&
      Number.isSafeInteger(rawOutputError.maxBytes) &&
      rawOutputError.maxBytes === MAX_OUTPUT_SNAPSHOT_BYTES &&
      rawOutputError.bytes > rawOutputError.maxBytes
        ? {
            code: "output_too_large",
            bytes: rawOutputError.bytes,
            maxBytes: rawOutputError.maxBytes,
          }
        : rawOutputError?.code === "output_unavailable" &&
            typeof rawOutputError.message === "string"
          ? {
              code: "output_unavailable",
              message: rawOutputError.message.slice(0, MAX_EVENT_TEXT_LENGTH),
            }
          : undefined;
    return {
      event: {
        ...base,
        type: "completion",
        status: obj.outcome,
        outcome: obj.outcome,
        source: obj.source,
        output,
        outputError,
        exitCode,
        message,
        errorMessage: boundedOptionalEventText(obj.errorMessage),
        summary,
      },
      legacy: false,
    };
  }
  if (
    obj.type === "process_exited" &&
    (obj.status === "done" ||
      obj.status === "error" ||
      obj.status === "cancelled") &&
    exitCode !== undefined
  )
    return {
      event: {
        ...base,
        type: "process_exited",
        status: obj.status,
        exitCode,
        message,
      },
      legacy: false,
    };
  return null;
}

/**
 * Read all events for a sub-agent. If `since` is provided, only events with
 * ts >= since are returned. Malformed lines are silently skipped (the
 * sub-agent CLI is the only writer, but a partial write could in theory
 * leave a truncated line).
 *
 * Reads through the same bounded validator as the incremental poller.
 */
export function readEvents(
  art: SubagentArtifact,
  since?: number,
): SubagentEvent[] {
  const events: SubagentEvent[] = [];
  let cursor = 0;
  for (;;) {
    const batch = readEventBatch(art, cursor);
    for (const { event } of batch.records) {
      if (since === undefined || event.ts >= since) events.push(event);
    }
    if (batch.endOffset <= cursor) break;
    cursor = batch.endOffset;
    if (cursor >= eventLogEndOffset(art)) break;
  }
  return events;
}

export function readEventRecords(
  art: SubagentArtifact,
  fromOffset = 0,
): EventRecord[] {
  return readEventBatch(art, fromOffset).records;
}

export function readEventBatch(
  art: SubagentArtifact,
  fromOffset = 0,
): { records: EventRecord[]; issues: EventReadIssue[]; endOffset: number } {
  let fd: number | undefined;
  let size = 0;
  try {
    fd = openSync(art.statusFile, "r");
    size = statSync(art.statusFile).size;
  } catch {
    return { records: [], issues: [], endOffset: fromOffset };
  }
  const offset = Math.max(0, Math.min(fromOffset, size));
  let content = Buffer.alloc(Math.min(MAX_EVENT_BATCH_BYTES, size - offset));
  let oversizedEndOffset: number | undefined;
  try {
    if (content.byteLength > 0) {
      readSync(fd, content, 0, content.length, offset);
      while (
        content.indexOf(0x0a) < 0 &&
        offset + content.byteLength < size &&
        content.byteLength < MAX_EVENT_RECORD_BYTES
      ) {
        const remaining = Math.min(
          MAX_EVENT_BATCH_BYTES,
          size - offset - content.byteLength,
          MAX_EVENT_RECORD_BYTES - content.byteLength,
        );
        const next = Buffer.alloc(remaining);
        readSync(fd, next, 0, next.length, offset + content.byteLength);
        content = Buffer.concat([content, next]);
      }
      if (
        content.indexOf(0x0a) < 0 &&
        content.byteLength >= MAX_EVENT_RECORD_BYTES &&
        offset + content.byteLength < size
      ) {
        let scanOffset = offset + content.byteLength;
        const scan = Buffer.alloc(MAX_EVENT_BATCH_BYTES);
        while (scanOffset < size) {
          const bytesRead = readSync(
            fd,
            scan,
            0,
            Math.min(scan.length, size - scanOffset),
            scanOffset,
          );
          if (bytesRead === 0) break;
          const newline = scan.subarray(0, bytesRead).indexOf(0x0a);
          if (newline >= 0) {
            const lineBytes = scanOffset + newline - offset;
            if (lineBytes > MAX_EVENT_RECORD_BYTES) {
              oversizedEndOffset = scanOffset + newline + 1;
            } else {
              content = Buffer.concat([content, Buffer.from("\n")]);
            }
            break;
          }
          scanOffset += bytesRead;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  const records: EventRecord[] = [];
  const issues: EventReadIssue[] = [];
  if (oversizedEndOffset !== undefined) {
    issues.push({
      kind: "record_too_large",
      startOffset: offset,
      endOffset: oversizedEndOffset,
      maxBytes: MAX_EVENT_RECORD_BYTES,
    });
    return { records, issues, endOffset: oversizedEndOffset };
  }
  let start = 0;
  let endOffset = offset;
  while (start < content.byteLength) {
    const newline = content.indexOf(0x0a, start);
    if (newline < 0) break;
    const lineEnd = newline + 1;
    const raw = content.subarray(start, newline).toString("utf8");
    try {
      const normalized = normalizeEvent(JSON.parse(raw), offset + start, raw);
      if (normalized) {
        if (normalized.legacy) {
          Object.defineProperties(normalized.event, {
            eventId: {
              value: `legacy-${createHash("sha256")
                .update(`${offset + start}:`)
                .update(raw)
                .digest("hex")
                .slice(0, 24)}`,
              enumerable: false,
            },
            turnId: {
              value: `legacy-${offset + start}`,
              enumerable: false,
            },
          });
        }
        records.push({
          event: normalized.event,
          startOffset: offset + start,
          endOffset: offset + lineEnd,
          raw,
          legacy: normalized.legacy,
        });
      }
    } catch {
      /* malformed complete lines are skipped; physical cursor still advances */
    }
    start = lineEnd;
    endOffset = offset + start;
  }
  if (
    endOffset === offset &&
    content.byteLength > 0 &&
    offset + content.byteLength < size
  ) {
    endOffset = offset + content.byteLength;
  }
  return { records, issues, endOffset };
}

export function eventLogEndOffset(art: SubagentArtifact): number {
  try {
    return statSync(art.statusFile).size;
  } catch {
    return 0;
  }
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

// ── Cleanup / TTL ───────────────────────────────────────────────────

export interface CleanupResult {
  removed: number;
  /** Number of directories that matched the TTL but were skipped (active or recent). */
  skipped: number;
  /** Non-fatal error messages encountered during cleanup. */
  errors: string[];
  dryRun: boolean;
}

/** Runtime-created ownership marker used to isolate historical artifact access. */
export const INTERACTIVE_ARTIFACT_OWNER_FILE = ".parent-session-id";

export interface CleanupOptions {
  /**
   * Set of sub-agent IDs that are currently tracked/active in the registry.
   * Directories matching these IDs are always preserved regardless of age.
   */
  activeIds?: Set<string>;
  /** When supplied, only artifacts carrying this exact parent-session marker are eligible. */
  ownerSessionId?: string;
  /** If true, report what would be deleted without actually deleting. */
  dryRun?: boolean;
  /** Override "now" for testing (unix-ms timestamp). Defaults to Date.now(). */
  now?: number;
}

/**
 * Delete artifact directories under `rootDir`. Supports both a flat
 * `<root>/<id>` layout and the production nested layout
 * `<root>/<cwdLabel>/artifacts/<id>`. Skips directories whose id is in
 * `activeIds`. Returns a summary with counts and any errors.
 *
 * ## Path safety
 *
 * - If `rootDir` does not exist, returns a zero-summary (not an error).
 * - The root itself is validated: it must not be `/`, empty, or a path that resolves
 *   to `/`.
 * - Every child directory is resolved via `realpathSync` and checked with
 *   `is-path-inside` before any deletion, preventing symlink-escape attacks.
 * - Entries that fail the containment check are reported as errors but the loop
 *   continues (best-effort).
 *
 * ## TTL semantics
 *
 * An artifact dir is considered "recent" (skipped) if ANY of these holds:
 *   1. Its id is in `activeIds`.
 *   2. The directory's mtime (`statSync(dir).mtimeMs`) is >= `now - ttlMs`.
 *   3. The artifact's events.ndjson has at least one event whose `ts` is >= `now - ttlMs`.
 */
function hasDirectArtifactFiles(dir: string): boolean {
  return (
    existsSync(join(dir, "events.ndjson")) || existsSync(join(dir, "output.md"))
  );
}

function discoverArtifactRoots(realRoot: string): string[] {
  const roots = new Set<string>();
  const nestedRoot = join(realRoot, "artifacts");
  try {
    const nestedStat = statSync(nestedRoot);
    if (nestedStat.isDirectory() && !hasDirectArtifactFiles(nestedRoot)) {
      roots.add(realpathSync(nestedRoot));
    }
  } catch {
    /* no direct artifacts child */
  }

  let entries: string[];
  try {
    entries = readdirSync(realRoot);
  } catch {
    roots.add(realRoot);
    return [...roots];
  }

  for (const name of entries) {
    if (name === "artifacts") continue;
    const candidate = join(realRoot, name);
    try {
      const st = statSync(candidate);
      if (!st.isDirectory()) continue;
      const childArtifactsRoot = join(candidate, "artifacts");
      if (!statSync(childArtifactsRoot).isDirectory()) continue;
      roots.add(realpathSync(childArtifactsRoot));
    } catch {
      /* ignore unreadable / missing entries */
    }
  }

  roots.add(realRoot);
  return [...roots];
}

function cleanupArtifactRoot(
  artifactRoot: string,
  realRoot: string,
  cutoff: number,
  activeIds: Set<string> | undefined,
  result: CleanupResult,
  options?: CleanupOptions,
): void {
  let entries: string[];
  try {
    entries = readdirSync(artifactRoot);
  } catch (err) {
    result.errors.push(`cannot read artifactRoot ${artifactRoot}: ${err}`);
    return;
  }

  for (const name of entries) {
    const candidate = join(artifactRoot, name);
    try {
      const st = statSync(candidate);
      if (!st.isDirectory()) continue;

      // Path-traversal check: resolve realpath and verify it is inside rootDir.
      let realCandidate: string;
      try {
        realCandidate = realpathSync(candidate);
      } catch {
        result.errors.push(`cannot resolve ${name} — skipping`);
        continue;
      }
      if (!isPathInside(realCandidate, realRoot)) {
        result.errors.push(
          `path traversal blocked: ${name} resolves outside rootDir`,
        );
        continue;
      }

      // Only directories that actually look like artifact dirs are eligible.
      if (!hasDirectArtifactFiles(candidate)) continue;
      if (options?.ownerSessionId !== undefined) {
        let artifactOwner: string | undefined;
        try {
          artifactOwner = readFileSync(
            join(candidate, INTERACTIVE_ARTIFACT_OWNER_FILE),
            "utf8",
          );
        } catch {
          /* Legacy artifacts without ownership evidence fail closed. */
        }
        if (artifactOwner !== options.ownerSessionId) {
          result.skipped++;
          continue;
        }
      }
      // Active-ids check.
      if (activeIds?.has(name)) {
        result.skipped++;
        continue;
      }

      // TTL check: dir mtime.
      if (st.mtimeMs >= cutoff) {
        result.skipped++;
        continue;
      }

      // TTL check: latest event ts in events.ndjson.
      const art = artifactPath(artifactRoot, name);
      const last = lastEvent(art);
      if (last && last.ts >= cutoff) {
        result.skipped++;
        continue;
      }

      // Past all checks — delete (or dry-run report).
      if (!options?.dryRun) {
        rmSync(candidate, { recursive: true, force: true });
      }
      result.removed++;
    } catch (err) {
      result.errors.push(`error processing ${name}: ${err}`);
    }
  }
}

export function cleanupOldArtifacts(
  rootDir: string,
  ttlMs: number,
  options?: CleanupOptions,
): CleanupResult {
  const result: CleanupResult = {
    removed: 0,
    skipped: 0,
    errors: [],
    dryRun: !!options?.dryRun,
  };
  const now = options?.now ?? Date.now();
  const cutoff = now - ttlMs;
  const activeIds = options?.activeIds;

  // Validate rootDir: must exist, must not be empty, must not resolve to /.
  if (!rootDir || rootDir.length === 0) {
    result.errors.push("rootDir is empty");
    return result;
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(rootDir);
    if (realRoot === "/") {
      result.errors.push("rootDir resolves to filesystem root (/)");
      return result;
    }
    // If the path doesn't exist, return a zero-summary (no error — it's empty, nothing to clean).
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return result;
    result.errors.push(`cannot resolve rootDir: ${err}`);
    return result;
  }

  const artifactRoots = discoverArtifactRoots(realRoot);
  for (const artifactRoot of artifactRoots) {
    cleanupArtifactRoot(
      artifactRoot,
      realRoot,
      cutoff,
      activeIds,
      result,
      options,
    );
  }

  return result;
}

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
  triggerTurnOnComplete?: boolean;

  /** Parent pi session id; only rehydrated when the current session matches. */
  parentSessionId?: string;
}

export interface PersistedDeliveryIntent {
  deliveryId: string;
  subagentId: string;
  turnId: string;
  eventId: string;
  mode: "notify" | "inject";
  triggerTurn: boolean;
  status: CompletionOutcome;
  artifactDir: string;
  output?: OutputSnapshot;
  message?: string;
  state: "queued" | "dispatchAttempted";
}

export const MAX_DELIVERY_RECEIPTS = 256;
const MAX_PERSISTED_DELIVERY_INTENTS = 32;

export interface PersistedLifecycleFold {
  startedAt?: number;
  currentTurnId?: string;
  completionTurnId?: string;
  completionOutcome?: CompletionOutcome;
  completionSource?: CompletionSource;
  completionExitCode?: number;
  processStatus?: "done" | "error" | "cancelled";
  processExitCode?: number;
  parentCancelled?: boolean;
  legacyTerminal?: "done" | "error" | "cancelled";
}

export interface InteractiveSubagentPersistedStateV2 extends InteractiveSubagentPersistedStateV1 {
  eventByteCursor: number;
  sessionByteCursor: number;
  /** Null means the cursor ends at a line boundary; absent means legacy state. */
  sessionPartialLineStart?: number | null;
  activeTurnId?: string;
  pendingDeliveries: PersistedDeliveryIntent[];
  deliveryReceipts: string[];
  legacyCutoverOffset?: number;
  lifecycle?: PersistedLifecycleFold;
}

export type InteractiveSubagentPersistedOwnership =
  | {
      completionOwner: "standalone";
      workflowId?: never;
      workflowProcessIdentity?: never;
    }
  | {
      completionOwner: "workflow";
      workflowId: string;
      workflowProcessIdentity?: WorkflowProcessAttemptIdentity;
    };

export type InteractiveSubagentPersistedStateV3 =
  InteractiveSubagentPersistedStateV2 & InteractiveSubagentPersistedOwnership;

/** Entry shape written by the current interactive-state schema. */
export type InteractiveSubagentPersistedState =
  InteractiveSubagentPersistedStateV3;

function normalizePersistedOwnership(
  raw: Record<string, unknown>,
  allowLegacyStandalone: boolean,
): InteractiveSubagentPersistedOwnership | null {
  if (raw.completionOwner === "workflow") {
    if (
      typeof raw.workflowId !== "string" ||
      raw.workflowId.length === 0 ||
      (raw.workflowProcessIdentity !== undefined &&
        !isWorkflowProcessAttemptIdentity(raw.workflowProcessIdentity))
    ) {
      return null;
    }
    return {
      completionOwner: "workflow",
      workflowId: raw.workflowId,
      ...(raw.workflowProcessIdentity === undefined
        ? {}
        : { workflowProcessIdentity: raw.workflowProcessIdentity }),
    };
  }
  if (raw.completionOwner === "standalone") {
    return raw.workflowId === undefined &&
      raw.workflowProcessIdentity === undefined
      ? { completionOwner: "standalone" }
      : null;
  }
  if (
    !allowLegacyStandalone ||
    raw.completionOwner !== undefined ||
    raw.workflowId !== undefined ||
    raw.workflowProcessIdentity !== undefined
  ) {
    return null;
  }
  return { completionOwner: "standalone" };
}

export interface InteractiveSubagentStateFile {
  schemaVersion: 3;

  /** Parent pi session id; redundant with the filename but kept for verification/debugging. */

  parent: string;

  states: { [id: string]: InteractiveSubagentPersistedState };
}

type InteractiveSubagentStateFileInput =
  | InteractiveSubagentStateFile
  | {
      schemaVersion: 1;
      parent: string;
      states: { [id: string]: InteractiveSubagentPersistedStateV1 };
    }
  | {
      schemaVersion: 2;
      parent: string;
      states: { [id: string]: InteractiveSubagentPersistedStateV2 };
    };

/** File path for the project-local state file under .pi/. */

export function stateFilePath(cwd: string): string {
  return join(cwd, ".pi", "subagentura-state.json");
}

/**
 * Read the state file. Returns null on missing file, malformed
 * JSON, or unsupported schemaVersion. Never throws — defensive readers for untrusted input
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
  try {
    return migrateStatePayload(obj);
  } catch {
    return null;
  }
}

/**
 * Migrate a parsed (and validated-to-be-an-object) state file payload
 * from any known older schema version to the current version.
 *
 * Returns the migrated payload on success, or null if the version is
 * unknown / unsupported (i.e. a future version this code does not
 * know how to migrate from).
 */
function migrateStatePayload(
  obj: Record<string, unknown>,
): InteractiveSubagentStateFile | null {
  const version = obj.schemaVersion;
  const rawStates = obj.states;
  const parent =
    typeof obj.parent === "string" && obj.parent.length > 0 ? obj.parent : "pi";

  // Helper: produce a valid states object from an untrusted value.
  const asStates = (
    v: unknown,
    legacy: boolean,
    allowLegacyOwnership: boolean,
  ): { [id: string]: InteractiveSubagentPersistedState } => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const migrated: { [id: string]: InteractiveSubagentPersistedState } = {};
    for (const [id, value] of Object.entries(v)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      if (
        typeof raw.id !== "string" ||
        raw.id !== id ||
        id.length === 0 ||
        id.length > 128 ||
        id.includes("/") ||
        id.includes("\\") ||
        typeof raw.artifactDir !== "string" ||
        !isAbsolute(raw.artifactDir) ||
        basename(raw.artifactDir) !== id ||
        typeof raw.paneId !== "string" ||
        typeof raw.sessionFile !== "string" ||
        (raw.mux !== "tmux" && raw.mux !== "zellij")
      ) {
        continue;
      }
      const entry = raw as unknown as InteractiveSubagentPersistedStateV1 &
        Partial<InteractiveSubagentPersistedStateV2>;
      const ownership = normalizePersistedOwnership(raw, allowLegacyOwnership);
      if (!ownership) continue;
      const art = artifactPath(
        dirname(entry.artifactDir),
        basename(entry.artifactDir),
      );
      const cutoverOffset = legacy ? eventLogEndOffset(art) : 0;
      const cursor = (candidate: unknown, fallback: number): number =>
        typeof candidate === "number" &&
        Number.isSafeInteger(candidate) &&
        candidate >= 0
          ? candidate
          : fallback;
      const pendingDeliveries = Array.isArray(entry.pendingDeliveries)
        ? entry.pendingDeliveries
            .flatMap((intent): PersistedDeliveryIntent[] => {
              if (!intent || typeof intent !== "object") return [];
              const rawIntent = intent as unknown as Record<string, unknown>;
              if (
                typeof rawIntent.deliveryId !== "string" ||
                typeof rawIntent.subagentId !== "string" ||
                rawIntent.subagentId !== id ||
                typeof rawIntent.turnId !== "string" ||
                typeof rawIntent.eventId !== "string" ||
                (rawIntent.mode !== "notify" && rawIntent.mode !== "inject") ||
                typeof rawIntent.triggerTurn !== "boolean" ||
                (rawIntent.status !== "done" &&
                  rawIntent.status !== "error" &&
                  rawIntent.status !== "cancelled") ||
                rawIntent.artifactDir !== entry.artifactDir ||
                (rawIntent.state !== "queued" &&
                  rawIntent.state !== "dispatchAttempted")
              ) {
                return [];
              }
              const output =
                rawIntent.output &&
                typeof rawIntent.output === "object" &&
                typeof (rawIntent.output as Record<string, unknown>).path ===
                  "string" &&
                typeof (rawIntent.output as Record<string, unknown>).bytes ===
                  "number" &&
                Number.isSafeInteger(
                  (rawIntent.output as Record<string, unknown>).bytes,
                ) &&
                ((rawIntent.output as Record<string, unknown>)
                  .bytes as number) >= 0 &&
                typeof (rawIntent.output as Record<string, unknown>).sha256 ===
                  "string" &&
                /^[a-f0-9]{64}$/i.test(
                  (rawIntent.output as Record<string, unknown>)
                    .sha256 as string,
                )
                  ? (rawIntent.output as unknown as OutputSnapshot)
                  : undefined;
              return [
                {
                  deliveryId: rawIntent.deliveryId,
                  subagentId: rawIntent.subagentId,
                  turnId: rawIntent.turnId,
                  eventId: rawIntent.eventId,
                  mode: rawIntent.mode,
                  triggerTurn: rawIntent.triggerTurn,
                  status: rawIntent.status,
                  artifactDir: rawIntent.artifactDir,
                  ...(output ? { output } : {}),
                  ...(typeof rawIntent.message === "string"
                    ? { message: rawIntent.message.slice(0, 500) }
                    : {}),
                  state: rawIntent.state,
                },
              ];
            })
            .slice(-MAX_PERSISTED_DELIVERY_INTENTS)
        : [];
      const deliveryReceipts = Array.isArray(entry.deliveryReceipts)
        ? [
            ...new Set(
              entry.deliveryReceipts.filter(
                (receipt): receipt is string => typeof receipt === "string",
              ),
            ),
          ].slice(-MAX_DELIVERY_RECEIPTS)
        : [];
      const rawLifecycle =
        entry.lifecycle &&
        typeof entry.lifecycle === "object" &&
        !Array.isArray(entry.lifecycle)
          ? (entry.lifecycle as PersistedLifecycleFold)
          : undefined;
      const lifecycle: PersistedLifecycleFold | undefined = rawLifecycle
        ? {
            ...(typeof rawLifecycle.startedAt === "number" &&
            Number.isFinite(rawLifecycle.startedAt) &&
            rawLifecycle.startedAt >= 0
              ? { startedAt: rawLifecycle.startedAt }
              : {}),
            ...(typeof rawLifecycle.currentTurnId === "string" &&
            rawLifecycle.currentTurnId.length <= MAX_TURN_ID_LENGTH
              ? { currentTurnId: rawLifecycle.currentTurnId }
              : {}),
            ...(typeof rawLifecycle.completionTurnId === "string" &&
            rawLifecycle.completionTurnId.length <= MAX_TURN_ID_LENGTH
              ? { completionTurnId: rawLifecycle.completionTurnId }
              : {}),
            ...(rawLifecycle.completionOutcome === "done" ||
            rawLifecycle.completionOutcome === "error" ||
            rawLifecycle.completionOutcome === "cancelled"
              ? { completionOutcome: rawLifecycle.completionOutcome }
              : {}),
            ...(rawLifecycle.completionSource === "agent_settled" ||
            rawLifecycle.completionSource === "agent_end" ||
            rawLifecycle.completionSource === "explicit" ||
            rawLifecycle.completionSource === "process_exit" ||
            rawLifecycle.completionSource === "parent"
              ? { completionSource: rawLifecycle.completionSource }
              : {}),
            ...(typeof rawLifecycle.completionExitCode === "number" &&
            Number.isSafeInteger(rawLifecycle.completionExitCode)
              ? { completionExitCode: rawLifecycle.completionExitCode }
              : {}),
            ...(rawLifecycle.processStatus === "done" ||
            rawLifecycle.processStatus === "error" ||
            rawLifecycle.processStatus === "cancelled"
              ? { processStatus: rawLifecycle.processStatus }
              : {}),
            ...(typeof rawLifecycle.processExitCode === "number" &&
            Number.isSafeInteger(rawLifecycle.processExitCode)
              ? { processExitCode: rawLifecycle.processExitCode }
              : {}),
            ...(rawLifecycle.parentCancelled === true
              ? { parentCancelled: true }
              : {}),
            ...(rawLifecycle.legacyTerminal === "done" ||
            rawLifecycle.legacyTerminal === "error" ||
            rawLifecycle.legacyTerminal === "cancelled"
              ? { legacyTerminal: rawLifecycle.legacyTerminal }
              : {}),
          }
        : undefined;
      migrated[id] = {
        id,
        paneId: entry.paneId,
        ...(typeof entry.windowName === "string"
          ? { windowName: entry.windowName }
          : {}),
        mux: entry.mux,
        ...(typeof entry.muxSession === "string"
          ? { muxSession: entry.muxSession }
          : {}),
        artifactDir: entry.artifactDir,
        sessionFile: entry.sessionFile,
        ...(entry.notifyOnComplete === "notify" ||
        entry.notifyOnComplete === "inject"
          ? { notifyOnComplete: entry.notifyOnComplete }
          : {}),
        ...(typeof entry.triggerTurnOnComplete === "boolean"
          ? { triggerTurnOnComplete: entry.triggerTurnOnComplete }
          : {}),
        ...(typeof entry.parentSessionId === "string"
          ? { parentSessionId: entry.parentSessionId }
          : {}),
        ...ownership,
        eventByteCursor: cursor(entry.eventByteCursor, cutoverOffset),
        sessionByteCursor: cursor(entry.sessionByteCursor, 0),
        ...(entry.sessionPartialLineStart === null
          ? { sessionPartialLineStart: null }
          : typeof entry.sessionPartialLineStart === "number"
            ? {
                sessionPartialLineStart: cursor(
                  entry.sessionPartialLineStart,
                  0,
                ),
              }
            : {}),
        ...(typeof entry.activeTurnId === "string"
          ? { activeTurnId: entry.activeTurnId }
          : {}),
        pendingDeliveries,
        deliveryReceipts,
        legacyCutoverOffset: cursor(entry.legacyCutoverOffset, cutoverOffset),
        ...(lifecycle ? { lifecycle } : {}),
      };
    }
    return migrated;
  };
  const withLegacyCatchup = (states: {
    [id: string]: InteractiveSubagentPersistedState;
  }): { [id: string]: InteractiveSubagentPersistedState } => {
    for (const entry of Object.values(states)) {
      const cutover = entry.legacyCutoverOffset ?? 0;
      if (cutover <= 0 || entry.pendingDeliveries.length > 0) continue;
      const turnId = `legacy-cutover-${cutover}`;
      const mode = "notify";
      entry.pendingDeliveries.push({
        deliveryId: createHash("sha256")
          .update(
            `${entry.parentSessionId ?? "pi"}\0${entry.id}\0${turnId}\0${mode}`,
          )
          .digest("hex")
          .slice(0, 32),
        subagentId: entry.id,
        turnId,
        eventId: turnId,
        mode,
        triggerTurn: false,
        status: "done",
        artifactDir: entry.artifactDir,
        message: `Legacy artifact backlog cut over at byte ${cutover}; inspect the artifact pointers for content.`,
        state: "queued",
      });
    }
    return states;
  };

  // No schema version → assume oldest known (v1 format).
  if (version === undefined || version === null) {
    debugLog("warn", "state-file-missing-schema", {});
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent,
      states: withLegacyCatchup(asStates(rawStates, true, true)),
    };
  }

  // Known version → return validated shape.
  if (version === 1) {
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent,
      states: withLegacyCatchup(asStates(rawStates, true, true)),
    };
  }

  if (version === 2) {
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent,
      states: asStates(rawStates, false, true),
    };
  }

  if (version === CURRENT_STATE_SCHEMA_VERSION) {
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent,
      states: asStates(rawStates, false, false),
    };
  }

  // Negative or zero — treat as an old version, migrate to current.
  if (typeof version === "number" && version < 1) {
    debugLog("warn", "state-file-old-schema", { schemaVersion: version });
    return {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent,
      states: withLegacyCatchup(asStates(rawStates, true, true)),
    };
  }

  // Future / unknown — cannot migrate safely.
  debugLog("error", "state-file-unsupported-schema", {
    schemaVersion: version as number,
  });
  return null;
}
/**
 * Atomically write the state file. Creates .pi/ if needed.
 * Mode 0o700 on .pi/, mode 0o600 on the file. Atomic via *.tmp + rename.
 */
export function saveInteractiveStates(
  cwd: string,
  payload: InteractiveSubagentStateFileInput,
): void {
  const current =
    payload.schemaVersion === CURRENT_STATE_SCHEMA_VERSION
      ? payload
      : migrateStatePayload(payload as unknown as Record<string, unknown>);
  if (!current || current.schemaVersion !== CURRENT_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion: ${payload.schemaVersion}`);
  }
  withInteractiveStateLock(cwd, () => {
    const existing = loadInteractiveStates(cwd);
    writeInteractiveStatesUnlocked(cwd, {
      ...current,
      states: { ...(existing?.states ?? {}), ...current.states },
    });
  });
}

const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_STALE_MS = 30_000;
const stateLockWaiter = new Int32Array(new SharedArrayBuffer(4));
type StateLockOwner = { pid: number; token: string };

function readStateLockOwner(lock: string): StateLockOwner | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(lock, "utf8"),
    ) as Partial<StateLockOwner>;
    const pid = parsed.pid;
    const token = parsed.token;
    if (
      typeof pid === "number" &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      typeof token === "string" &&
      token.length > 0
    ) {
      return { pid, token };
    }
  } catch {
    /* A partial or legacy lock is recoverable after its lease ages out. */
  }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseStateLock(
  lock: string,
  fd: number,
  ownerMetadata: string,
  acquiredDevice: number,
  acquiredInode: number,
): void {
  closeSync(fd);
  try {
    const currentFd = openSync(lock, constants.O_RDONLY);
    const current = fstatSync(currentFd);
    closeSync(currentFd);
    if (current.dev !== acquiredDevice || current.ino !== acquiredInode) return;
    if (readFileSync(lock, "utf8") !== ownerMetadata) return;
    unlinkSync(lock);
  } catch {
    /* A recovery path may have already removed or replaced this lock. */
  }
}

function releaseStateRecoveryLock(
  lock: string,
  fd: number,
  ownerMetadata: string,
): void {
  closeSync(fd);
  try {
    if (readFileSync(lock, "utf8") === ownerMetadata) unlinkSync(lock);
  } catch {
    /* A recovery path may have already removed or replaced this claim. */
  }
}

export function withInteractiveStateLock<T>(cwd: string, action: () => T): T {
  const piDir = join(cwd, ".pi");
  const lock = join(piDir, "subagentura-state.lock");
  const recoveryLock = `${lock}.recovery`;
  mkdirSync(piDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;
  const ownerMetadata = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
  });
  const recoveryMetadata = JSON.stringify({
    pid: process.pid,
    token: randomUUID(),
  });
  let fd: number | undefined;
  let recoveryFd: number | undefined;
  let acquiredDevice = 0;
  let acquiredInode = 0;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, ownerMetadata);
      const acquired = fstatSync(fd);
      acquiredDevice = acquired.dev;
      acquiredInode = acquired.ino;
      if (recoveryFd !== undefined) {
        releaseStateRecoveryLock(recoveryLock, recoveryFd, recoveryMetadata);
        recoveryFd = undefined;
      }
    } catch (error: any) {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
        try {
          unlinkSync(lock);
        } catch {
          /* Another process may have recovered an incomplete lock. */
        }
      }
      if (error?.code !== "EEXIST") {
        if (recoveryFd !== undefined) {
          releaseStateRecoveryLock(recoveryLock, recoveryFd, recoveryMetadata);
        }
        throw error;
      }
      if (recoveryFd === undefined) {
        try {
          recoveryFd = openSync(recoveryLock, "wx", 0o600);
          writeFileSync(recoveryFd, recoveryMetadata);
        } catch (recoveryError: any) {
          if (recoveryFd !== undefined) {
            closeSync(recoveryFd);
            recoveryFd = undefined;
            try {
              unlinkSync(recoveryLock);
            } catch {
              /* Another contender may own the recovery claim. */
            }
          }
          if (recoveryError?.code !== "EEXIST") throw recoveryError;
          // Existing recovery claims are never reclaimed automatically.
        }
      }
      if (recoveryFd !== undefined) {
        try {
          if (!existsSync(lock)) continue;
          const owner = readStateLockOwner(lock);
          const lockAge = Date.now() - statSync(lock).mtimeMs;
          const stale = !owner && lockAge > STATE_LOCK_STALE_MS;
          if (owner && isProcessAlive(owner.pid)) {
            releaseStateRecoveryLock(
              recoveryLock,
              recoveryFd,
              recoveryMetadata,
            );
            recoveryFd = undefined;
          } else if (stale || (owner && !isProcessAlive(owner.pid))) {
            unlinkSync(lock);
            continue;
          } else {
            releaseStateRecoveryLock(
              recoveryLock,
              recoveryFd,
              recoveryMetadata,
            );
            recoveryFd = undefined;
          }
        } catch {
          if (recoveryFd !== undefined) {
            releaseStateRecoveryLock(
              recoveryLock,
              recoveryFd,
              recoveryMetadata,
            );
            recoveryFd = undefined;
          }
        }
      }
      if (Date.now() >= deadline) {
        if (recoveryFd !== undefined) {
          releaseStateRecoveryLock(recoveryLock, recoveryFd, recoveryMetadata);
        }
        throw new Error(`timed out acquiring interactive state lock: ${lock}`);
      }
      Atomics.wait(stateLockWaiter, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    releaseStateLock(lock, fd, ownerMetadata, acquiredDevice, acquiredInode);
  }
}

function writeInteractiveStatesUnlocked(
  cwd: string,
  payload: InteractiveSubagentStateFile,
): void {
  const file = stateFilePath(cwd);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Convenience: load (or create fresh) + add/overwrite entry by id + save.
 * Called from hot paths (spawn) where a write failure must not break the parent.
 */
export function appendInteractiveState(
  cwd: string,
  entry:
    | InteractiveSubagentPersistedStateV1
    | InteractiveSubagentPersistedStateV2
    | InteractiveSubagentPersistedState,
): void {
  withInteractiveStateLock(cwd, () => {
    const current = loadInteractiveStates(cwd) ?? {
      schemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      parent: "pi",
      states: {},
    };
    const art = artifactPath(
      dirname(entry.artifactDir),
      basename(entry.artifactDir),
    );
    const ownership = normalizePersistedOwnership(
      entry as unknown as Record<string, unknown>,
      true,
    );
    if (!ownership) {
      throw new Error("invalid interactive subagent completion ownership");
    }
    const persistedEntry: InteractiveSubagentPersistedStateV2 = {
      id: entry.id,
      paneId: entry.paneId,
      windowName: entry.windowName,
      mux: entry.mux,
      muxSession: entry.muxSession,
      artifactDir: entry.artifactDir,
      sessionFile: entry.sessionFile,
      notifyOnComplete: entry.notifyOnComplete,
      triggerTurnOnComplete: entry.triggerTurnOnComplete,
      parentSessionId: entry.parentSessionId,
      eventByteCursor: "eventByteCursor" in entry ? entry.eventByteCursor : 0,
      sessionByteCursor:
        "sessionByteCursor" in entry ? entry.sessionByteCursor : 0,
      ...("sessionPartialLineStart" in entry
        ? { sessionPartialLineStart: entry.sessionPartialLineStart }
        : {}),
      ...("activeTurnId" in entry ? { activeTurnId: entry.activeTurnId } : {}),
      pendingDeliveries:
        "pendingDeliveries" in entry ? entry.pendingDeliveries : [],
      deliveryReceipts:
        "deliveryReceipts" in entry ? entry.deliveryReceipts : [],
      legacyCutoverOffset:
        "legacyCutoverOffset" in entry
          ? entry.legacyCutoverOffset
          : eventLogEndOffset(art),
      ...("lifecycle" in entry ? { lifecycle: entry.lifecycle } : {}),
    };
    current.states[entry.id] =
      ownership.completionOwner === "workflow"
        ? { ...persistedEntry, ...ownership }
        : { ...persistedEntry, completionOwner: "standalone" };
    writeInteractiveStatesUnlocked(cwd, current);
  });
}

export function updateInteractiveState(
  cwd: string,
  id: string,
  update: (entry: InteractiveSubagentPersistedState) => void,
): void {
  withInteractiveStateLock(cwd, () => {
    const current = loadInteractiveStates(cwd);
    const entry = current?.states[id];
    if (!current || !entry) return;
    update(entry);
    writeInteractiveStatesUnlocked(cwd, current);
  });
}
/**
 * Convenience: load + drop entry by id + save. No-op if absent or file missing.
 */
export function removeInteractiveState(cwd: string, id: string): void {
  withInteractiveStateLock(cwd, () => {
    const current = loadInteractiveStates(cwd);
    if (!current || !(id in current.states)) return;
    delete current.states[id];
    writeInteractiveStatesUnlocked(cwd, current);
  });
}
/**
 * Delete the state file outright. Used on session_shutdown(reason="new") to
 * give the next session a clean slate. No-op if the file doesn't exist.
 */
export function deleteInteractiveStatesFile(cwd: string): void {
  withInteractiveStateLock(cwd, () => {
    try {
      unlinkSync(stateFilePath(cwd));
    } catch {
      /* best effort — file may not exist */
    }
  });
}
