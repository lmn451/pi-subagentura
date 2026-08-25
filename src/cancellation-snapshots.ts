import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ParentCancellationLifecycleReason,
  ParentCancellationOrigin,
} from "./artifact";

export const CANCELLATION_SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_CANCEL_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const MAX_CANCEL_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const MIN_CANCEL_SNAPSHOT_MAX_BYTES = 4 * 1024;
const MAX_HASH_BYTES = 1024 * 1024;

type SnapshotKind = "in-process" | "interactive";
export type CancellationSnapshotSource =
  | "signal"
  | "cancel_subagent"
  | "cancel_all"
  | "workflow"
  | "supervisor"
  | "cancel_interactive_subagent"
  | "session_shutdown";
export type CancellationSnapshotStatus =
  "disabled" | "written" | "truncated" | "deduplicated" | "error";

export interface CancellationSnapshotReceipt {
  schemaVersion: typeof CANCELLATION_SNAPSHOT_SCHEMA_VERSION;
  kind: SnapshotKind;
  status: CancellationSnapshotStatus;
  enabled: boolean;
  source: CancellationSnapshotSource;
  key: string;
  path?: string;
  bytes?: number;
  maxBytes?: number;
  truncated?: boolean;
  error?: string;
  errors?: string[];
}

export interface InProcessSnapshotInput {
  kind: "in-process";
  jobId: string;
  session: Pick<
    AgentSession,
    "sessionId" | "model" | "thinkingLevel" | "state" | "sessionManager"
  >;
  cwd: string;
  parentSessionId?: string;
  model?: string;
  thinkingLevel?: string;
  activeTool?: { name: string; args: Record<string, unknown> };
  partialOutput?: string;
  startedAt?: number;
  source: CancellationSnapshotSource;
  /** Session/tool-call id or symbolic origin that initiated the cancel. */
  initiator?: string;
  /** Human-readable cancellation reason. */
  reason?: string;
}

export interface InteractiveSnapshotInput {
  kind: "interactive";
  id: string;
  parentSessionId?: string;
  cwd: string;
  sessionFile: string;
  artifactDir: string;
  startedAt?: number;
  source: CancellationSnapshotSource;
  cancellationOrigin?: ParentCancellationOrigin;
  cancellationLifecycleReason?: ParentCancellationLifecycleReason;
}

function normalizeParentCancellationOrigin(
  value: unknown,
): ParentCancellationOrigin | undefined {
  switch (value) {
    case "signal":
    case "cancel_subagent":
    case "cancel_all":
    case "workflow":
    case "supervisor":
    case "cancel_interactive_subagent":
    case "session_start":
    case "session_shutdown":
    case "supervisor_descendant":
      return value;
    default:
      return undefined;
  }
}

function normalizeParentCancellationLifecycleReason(
  value: unknown,
): ParentCancellationLifecycleReason | undefined {
  switch (value) {
    case "startup":
    case "reload":
    case "resume":
    case "quit":
    case "new":
    case "fork":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

interface FileMetadata {
  path: string;
  exists: boolean;
  bytes?: number;
  sha256?: string;
  hashBytes?: number;
  hashTruncated?: boolean;
  error?: string;
}

function baseReceipt(
  kind: SnapshotKind,
  source: CancellationSnapshotSource,
  key: string,
): CancellationSnapshotReceipt {
  return {
    schemaVersion: CANCELLATION_SNAPSHOT_SCHEMA_VERSION,
    kind,
    status: "error",
    enabled: true,
    source,
    key,
  };
}

export function cancellationSnapshotsEnabled(): boolean {
  return process.env.SUBAGENT_CANCEL_SNAPSHOT === "full";
}

export function cancellationSnapshotMaxBytes(): number {
  const raw = process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES;
  if (!raw) return DEFAULT_CANCEL_SNAPSHOT_MAX_BYTES;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_CANCEL_SNAPSHOT_MAX_BYTES ||
    parsed > MAX_CANCEL_SNAPSHOT_MAX_BYTES
  ) {
    return DEFAULT_CANCEL_SNAPSHOT_MAX_BYTES;
  }
  return parsed;
}

function snapshotRoot(cwd: string): string {
  if (process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR) {
    const configured = resolve(process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR);
    if (configured === "/") {
      throw new Error("snapshot directory may not be filesystem root");
    }
    return configured;
  }
  const sessionRoot =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    join(homedir(), ".pi", "agent", "sessions");
  const cwdHash = createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 24);
  return join(sessionRoot, "subagentura", "cancel-snapshots", cwdHash);
}

function keyFor(
  kind: SnapshotKind,
  id: string,
  sessionId: string | undefined,
): string {
  return createHash("sha256")
    .update(`${kind}\0${id}\0${sessionId ?? "session"}`)
    .digest("hex")
    .slice(0, 32);
}

function disabledReceipt(
  kind: SnapshotKind,
  source: CancellationSnapshotSource,
  key: string,
): CancellationSnapshotReceipt {
  return {
    ...baseReceipt(kind, source, key),
    status: "disabled",
    enabled: false,
  };
}

function existingReceipt(
  receipt: CancellationSnapshotReceipt,
  path: string,
): CancellationSnapshotReceipt | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return {
      ...receipt,
      status: "deduplicated",
      path,
      bytes: stat.size,
    };
  } catch {
    return undefined;
  }
}

function atomicWrite(
  path: string,
  content: string,
): { bytes: number } | { error: string } {
  const bytes = Buffer.byteLength(content, "utf8");
  const dir = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    return { bytes };
  } catch (err) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* cleanup is best effort; cancellation must not be blocked */
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function jsonClone(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "bigint") return `${candidate}n`;
    if (typeof candidate === "function") return undefined;
    if (!candidate || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) throw new Error("circular value");
    seen.add(candidate);
    return candidate;
  });
  return encoded === undefined ? undefined : JSON.parse(encoded);
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function modelId(
  session: InProcessSnapshotInput["session"],
): string | undefined {
  if (!session.model) return undefined;
  return `${session.model.provider}/${session.model.id}`;
}

function buildInProcessPayload(
  input: InProcessSnapshotInput,
  maxBytes: number,
): { content: string; truncated: boolean; errors: string[] } {
  const errors: string[] = [];
  const branchEntries: unknown[] = [];
  let omittedEntries = 0;
  let branch: unknown[] = [];
  try {
    branch = input.session.sessionManager.getBranch();
  } catch (err) {
    errors.push(
      `branch_entries_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let streamingMessage: unknown;
  try {
    streamingMessage = jsonClone(input.session.state.streamingMessage);
  } catch (err) {
    errors.push(
      `streaming_message_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let activeTool: unknown = input.activeTool;
  try {
    activeTool = jsonClone(input.activeTool);
  } catch (err) {
    errors.push(
      `active_tool_unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    activeTool = input.activeTool ? { name: input.activeTool.name } : undefined;
  }

  const sessionId = input.session.sessionId;
  const base = {
    schemaVersion: CANCELLATION_SNAPSHOT_SCHEMA_VERSION,
    kind: "in-process",
    capturedAt: new Date().toISOString(),
    truncated: false,
    errors,
    cancellation: {
      source: input.source,
      initiator: input.initiator,
      reason: input.reason,
      jobId: input.jobId,
      parentSessionId: input.parentSessionId,
      startedAt: input.startedAt,
      capturedAt: Date.now(),
    },
    session: {
      jobId: input.jobId,
      sessionId,
      cwd: input.cwd,
      model: input.model ?? modelId(input.session),
      thinkingLevel: input.thinkingLevel ?? input.session.thinkingLevel,
    },
    context: {
      branchEntries,
      branchEntriesOmitted: 0,
      streamingMessage,
      partialOutput: utf8Prefix(
        input.partialOutput ?? "",
        Math.floor(maxBytes / 4),
      ),
      partialOutputTruncated:
        (input.partialOutput?.length ?? 0) > Math.floor(maxBytes / 4),
      activeTool,
    },
  };

  const encode = (value: typeof base): string => JSON.stringify(value);
  let truncated = base.context.partialOutputTruncated;
  let content = encode(base);

  if (
    Buffer.byteLength(content, "utf8") > maxBytes &&
    streamingMessage !== undefined
  ) {
    base.context.streamingMessage = undefined;
    base.errors.push("streaming_message_omitted_for_size");
    truncated = true;
    content = encode(base);
  }
  if (
    Buffer.byteLength(content, "utf8") > maxBytes &&
    activeTool !== undefined
  ) {
    base.context.activeTool = input.activeTool
      ? { name: input.activeTool.name, argsOmitted: true }
      : undefined;
    base.errors.push("active_tool_args_omitted_for_size");
    truncated = true;
    content = encode(base);
  }
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    base.context.partialOutput = "";
    base.context.partialOutputTruncated = true;
    base.errors.push("partial_output_omitted_for_size");
    truncated = true;
    content = encode(base);
  }

  for (let i = branch.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = jsonClone(branch[i]);
    } catch (err) {
      omittedEntries++;
      errors.push(
        `branch_entry_${i}_unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const candidate = [entry, ...base.context.branchEntries];
    const candidatePayload = {
      ...base,
      context: { ...base.context, branchEntries: candidate },
    };
    if (Buffer.byteLength(encode(candidatePayload), "utf8") <= maxBytes) {
      base.context.branchEntries.unshift(entry);
      content = encode(base);
    } else {
      omittedEntries++;
      truncated = true;
    }
  }

  base.context.branchEntriesOmitted = omittedEntries;
  if (omittedEntries > 0) {
    base.errors.push("branch_entries_omitted_for_size");
  }
  base.truncated = truncated || omittedEntries > 0;
  content = encode(base);
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    base.context.branchEntries = [];
    base.context.branchEntriesOmitted = branch.length;
    base.context.streamingMessage = undefined;
    base.context.activeTool = undefined;
    base.context.partialOutput = "";
    base.errors.push("context_reduced_to_metadata_for_size");
    base.truncated = true;
    content = encode(base);
  }

  return { content, truncated: base.truncated, errors: base.errors };
}

function safeSnapshotReceipt(
  receipt: CancellationSnapshotReceipt,
  content: string,
): CancellationSnapshotReceipt {
  const maxBytes = cancellationSnapshotMaxBytes();
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    return {
      ...receipt,
      status: "error",
      maxBytes,
      error: `snapshot exceeded ${maxBytes} byte ceiling`,
    };
  }
  const written = atomicWrite(receipt.path!, content);
  if ("error" in written) {
    return { ...receipt, status: "error", maxBytes, error: written.error };
  }
  return {
    ...receipt,
    status: receipt.truncated ? "truncated" : "written",
    bytes: written.bytes,
    maxBytes,
    truncated: receipt.truncated,
  };
}

export function snapshotInProcessSession(
  input: InProcessSnapshotInput,
): CancellationSnapshotReceipt {
  let sessionId: string | undefined;
  try {
    sessionId =
      input.session.sessionId ??
      (typeof (input.session.sessionManager as any).getSessionId === "function"
        ? (input.session.sessionManager as any).getSessionId()
        : undefined);
  } catch {
    sessionId = undefined;
  }
  const key = keyFor("in-process", input.jobId, sessionId);
  if (!cancellationSnapshotsEnabled()) {
    return disabledReceipt("in-process", input.source, key);
  }
  const receipt = baseReceipt("in-process", input.source, key);
  try {
    const path = join(
      snapshotRoot(input.cwd),
      "in-process",
      `in-process-${key}.json`,
    );
    receipt.path = path;
    const existing = existingReceipt(receipt, path);
    if (existing) return existing;
    const maxBytes = cancellationSnapshotMaxBytes();
    const built = buildInProcessPayload(input, maxBytes);
    receipt.truncated = built.truncated;
    receipt.errors =
      built.errors.length > 0 ? built.errors.slice(0, 16) : undefined;
    return safeSnapshotReceipt(receipt, built.content);
  } catch (err) {
    return {
      ...receipt,
      status: "error",
      maxBytes: cancellationSnapshotMaxBytes(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fileMetadata(path: string): FileMetadata {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile())
      return { path, exists: false, error: "not a regular file" };
    const hash = createHash("sha256");
    const limit = Math.min(stat.size, MAX_HASH_BYTES);
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, limit)));
    let offset = 0;
    while (offset < limit) {
      const wanted = Math.min(buffer.byteLength, limit - offset);
      const count = readSync(fd, buffer, 0, wanted, offset);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return {
      path,
      exists: true,
      bytes: stat.size,
      sha256: hash.digest("hex"),
      hashBytes: offset,
      hashTruncated: stat.size > offset,
    };
  } catch (err) {
    return {
      path,
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* metadata collection is best effort */
      }
    }
  }
}

export function snapshotInteractiveContext(
  input: InteractiveSnapshotInput,
): CancellationSnapshotReceipt {
  const key = keyFor("interactive", input.id, input.parentSessionId);
  const cancellationOrigin = normalizeParentCancellationOrigin(
    input.cancellationOrigin,
  );
  const cancellationLifecycleReason =
    cancellationOrigin === "session_start" ||
    cancellationOrigin === "session_shutdown"
      ? normalizeParentCancellationLifecycleReason(
          input.cancellationLifecycleReason,
        )
      : undefined;
  if (!cancellationSnapshotsEnabled()) {
    return disabledReceipt("interactive", input.source, key);
  }
  const receipt = baseReceipt("interactive", input.source, key);
  let root: string;
  try {
    root = process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR
      ? snapshotRoot(input.cwd)
      : join(input.artifactDir, "context-snapshots");
  } catch (err) {
    return {
      ...receipt,
      status: "error",
      maxBytes: cancellationSnapshotMaxBytes(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const path = join(root, "interactive", `interactive-${key}.json`);
  receipt.path = path;
  const existing = existingReceipt(receipt, path);
  if (existing) return existing;
  try {
    const payload = {
      schemaVersion: CANCELLATION_SNAPSHOT_SCHEMA_VERSION,
      kind: "interactive",
      capturedAt: new Date().toISOString(),
      cancellation: {
        source: input.source,
        cancellationOrigin,
        cancellationLifecycleReason,
        id: input.id,
        parentSessionId: input.parentSessionId,
        startedAt: input.startedAt,
      },
      sessionFile: input.sessionFile,
      artifactDir: input.artifactDir,
      files: {
        sessionFile: fileMetadata(input.sessionFile),
        events: fileMetadata(join(input.artifactDir, "events.ndjson")),
        output: fileMetadata(join(input.artifactDir, "output.md")),
        activeTurn: fileMetadata(join(input.artifactDir, "active-turn.json")),
      },
    };
    const content = JSON.stringify(payload);
    receipt.truncated = false;
    return safeSnapshotReceipt(receipt, content);
  } catch (err) {
    return {
      ...receipt,
      status: "error",
      maxBytes: cancellationSnapshotMaxBytes(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
