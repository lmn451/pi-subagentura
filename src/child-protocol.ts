import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debugLog } from "./helpers";
import {
  MAX_ACTIVE_TOOL_ID_LENGTH,
  MAX_ACTIVE_TOOL_RECORDS,
  MAX_ACTIVE_TURN_BYTES,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  MAX_TOOL_NAME_LENGTH,
  MAX_TURN_ID_LENGTH,
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  newEventId,
  readEvents,
  writeOutput,
  type SubagentEventV2,
} from "./artifact";

interface ActiveTool {
  name: string;
  callId?: string;
  startedAt: number;
}

interface ActiveTurn {
  turnId: string;
  startedAt: number;
  started: boolean;
  previousUserEntryId?: string;
  activeTools?: ActiveTool[];
  lastTool?: string;
}

let latestAgentMessages: unknown[] = [];

function getArtifact() {
  const dir = process.env.ARTIFACT_DIR;
  if (!dir) throw new Error("PI_SUBAGENTURA_CHILD requires ARTIFACT_DIR");
  return artifactPath(dirname(dir), basename(dir));
}

function activeTurnPath(art = getArtifact()): string {
  return join(art.dir, "active-turn.json");
}

const SAFE_METADATA_PATTERN = /^[A-Za-z0-9._:-]+$/;

function boundedMetadataIdentifier(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_METADATA_PATTERN.test(value)
    ? value
    : undefined;
}

const CHILD_DIAGNOSTICS_ENV = "PI_SUBAGENTURA_CHILD_DIAGNOSTICS";
const CHILD_DIAGNOSTICS_FILE = "child-diagnostics.ndjson";
const MAX_CHILD_DIAGNOSTIC_FILE_BYTES = 64 * 1024;
const MAX_CHILD_DIAGNOSTIC_CONTENT_PARTS = 128;
const CHILD_DIAGNOSTIC_STOP_REASONS = [
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
] as const;
type ChildDiagnosticStopReason =
  | (typeof CHILD_DIAGNOSTIC_STOP_REASONS)[number]
  | "unknown";
type ChildDiagnosticPartType =
  | "text"
  | "toolCall"
  | "thinking"
  | "image"
  | "other";
type ChildDiagnosticSnapshotState =
  | "written"
  | "empty"
  | "missing"
  | "unavailable"
  | "too_large";

function childDiagnosticStopReason(value: unknown): ChildDiagnosticStopReason {
  return CHILD_DIAGNOSTIC_STOP_REASONS.includes(
    value as (typeof CHILD_DIAGNOSTIC_STOP_REASONS)[number],
  )
    ? (value as ChildDiagnosticStopReason)
    : "unknown";
}

function summarizeFinalAssistant(assistant: any) {
  const content = assistant?.content;
  const parts = Array.isArray(content) ? content : [];
  const contentPartTypes = new Set<ChildDiagnosticPartType>();
  if (typeof content === "string") contentPartTypes.add("text");
  let finalMessageTextBytes =
    typeof content === "string" ? Buffer.byteLength(content, "utf8") : 0;
  let toolCallCount = 0;
  const inspectedParts = Math.min(
    parts.length,
    MAX_CHILD_DIAGNOSTIC_CONTENT_PARTS,
  );
  for (let index = 0; index < inspectedParts; index++) {
    const part = parts[index];
    const type =
      part && typeof part === "object" && !Array.isArray(part)
        ? (part as Record<string, unknown>).type
        : undefined;
    const safeType: ChildDiagnosticPartType =
      type === "text" ||
      type === "toolCall" ||
      type === "thinking" ||
      type === "image"
        ? type
        : "other";
    contentPartTypes.add(safeType);
    if (safeType === "toolCall") toolCallCount++;
    if (
      safeType === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
    ) {
      finalMessageTextBytes += Buffer.byteLength(
        (part as Record<string, string>).text,
        "utf8",
      );
    }
  }
  const stopReason = childDiagnosticStopReason(assistant?.stopReason);
  const textBytesCapped =
    finalMessageTextBytes > MAX_OUTPUT_SNAPSHOT_BYTES ||
    parts.length > MAX_CHILD_DIAGNOSTIC_CONTENT_PARTS;
  return {
    finalAssistantMessageFound: Boolean(assistant),
    finalMessageTextBytes: Math.min(
      finalMessageTextBytes,
      MAX_OUTPUT_SNAPSHOT_BYTES,
    ),
    finalMessageTextBytesCapped: textBytesCapped,
    stopReason,
    contentPartTypes: [...contentPartTypes],
    contentPartTypesTruncated:
      parts.length > MAX_CHILD_DIAGNOSTIC_CONTENT_PARTS,
    toolCallCount,
    toolCallCountTruncated: parts.length > MAX_CHILD_DIAGNOSTIC_CONTENT_PARTS,
    aborted: stopReason === "aborted",
    error:
      stopReason === "error" ||
      (typeof assistant?.errorMessage === "string" &&
        assistant.errorMessage.length > 0),
  };
}

function appendChildDiagnostic(
  art: ReturnType<typeof getArtifact>,
  record: Record<string, unknown>,
): void {
  if (process.env[CHILD_DIAGNOSTICS_ENV] !== "1") return;
  const content = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (content.byteLength > 2048) return;
  let fd: number | undefined;
  try {
    mkdirSync(art.dir, { recursive: true, mode: 0o700 });
    fd = openSync(
      join(art.dir, CHILD_DIAGNOSTICS_FILE),
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.size + content.byteLength > MAX_CHILD_DIAGNOSTIC_FILE_BYTES
    ) {
      return;
    }
    fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < content.byteLength) {
      const bytesWritten = writeSync(
        fd,
        content,
        offset,
        content.byteLength - offset,
      );
      if (bytesWritten <= 0)
        throw new Error("diagnostic write made no progress");
      offset += bytesWritten;
    }
  } catch {
    debugLog("warn", "child_output_diagnostic_write_failed");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        debugLog("warn", "child_output_diagnostic_close_failed");
      }
    }
  }
}

function normalizeActiveTool(value: unknown): ActiveTool | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const name = boundedMetadataIdentifier(candidate.name, MAX_TOOL_NAME_LENGTH);
  const startedAt = candidate.startedAt;
  if (
    !name ||
    typeof startedAt !== "number" ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  ) {
    return null;
  }
  const callId = boundedMetadataIdentifier(
    candidate.callId,
    MAX_ACTIVE_TOOL_ID_LENGTH,
  );
  return {
    name,
    ...(callId ? { callId } : {}),
    startedAt,
  };
}

function normalizeActiveTools(value: unknown): ActiveTool[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_ACTIVE_TOOL_RECORDS)
    .map(normalizeActiveTool)
    .filter((tool): tool is ActiveTool => tool !== null);
}

function normalizeActiveTurn(value: unknown): ActiveTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const turnId = boundedMetadataIdentifier(
    candidate.turnId,
    MAX_TURN_ID_LENGTH,
  );
  if (!turnId) return null;
  const startedAt = candidate.startedAt;
  return {
    turnId,
    startedAt:
      typeof startedAt === "number" &&
      Number.isSafeInteger(startedAt) &&
      startedAt >= 0
        ? startedAt
        : Date.now(),
    started: candidate.started === true,
    ...(boundedMetadataIdentifier(
      candidate.previousUserEntryId,
      MAX_TURN_ID_LENGTH,
    )
      ? {
          previousUserEntryId: boundedMetadataIdentifier(
            candidate.previousUserEntryId,
            MAX_TURN_ID_LENGTH,
          ),
        }
      : {}),
    activeTools: normalizeActiveTools(candidate.activeTools),
    ...(boundedMetadataIdentifier(candidate.lastTool, MAX_TOOL_NAME_LENGTH)
      ? {
          lastTool: boundedMetadataIdentifier(
            candidate.lastTool,
            MAX_TOOL_NAME_LENGTH,
          ),
        }
      : {}),
  };
}

function writeActiveTurn(turn: ActiveTurn, art = getArtifact()): void {
  const normalized = normalizeActiveTurn(turn);
  if (!normalized) return;
  const content = JSON.stringify(normalized);
  if (Buffer.byteLength(content, "utf8") > MAX_ACTIVE_TURN_BYTES) return;
  const file = activeTurnPath(art);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".tmp";
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readActiveTurn(art = getArtifact()): ActiveTurn | null {
  let fd: number | undefined;
  try {
    fd = openSync(
      activeTurnPath(art),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > MAX_ACTIVE_TURN_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        metadata.size - offset,
        offset,
      );
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    return normalizeActiveTurn(JSON.parse(buffer.toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* bounded diagnostic metadata is no longer usable */
      }
    }
  }
}

function latestUserEntryId(ctx: any): string | undefined {
  const entries =
    ctx.sessionManager?.getEntries?.() ??
    ctx.sessionManager?.getBranch?.() ??
    [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      return String(entry.id);
    }
  }
  return undefined;
}

function lastActiveToolIndex(
  tools: readonly ActiveTool[],
  name: string | undefined,
  callId: string | undefined,
): number {
  if (callId) {
    for (let index = tools.length - 1; index >= 0; index--) {
      if (tools[index]?.callId === callId) return index;
    }
  }
  if (name) {
    for (let index = tools.length - 1; index >= 0; index--) {
      if (tools[index]?.name === name) return index;
    }
  }
  return -1;
}

function updateActiveToolMetadata(
  art: ReturnType<typeof getArtifact>,
  active: ActiveTurn,
  phase: "start" | "end",
  event: { toolName?: string; toolCallId?: string },
  timestamp: number,
): void {
  const name = boundedMetadataIdentifier(event.toolName, MAX_TOOL_NAME_LENGTH);
  const callId = boundedMetadataIdentifier(
    event.toolCallId,
    MAX_ACTIVE_TOOL_ID_LENGTH,
  );
  const tools = [...(active.activeTools ?? [])];
  const existingIndex = lastActiveToolIndex(tools, name, callId);
  if (phase === "start") {
    if (!name) return;
    if (existingIndex >= 0) tools.splice(existingIndex, 1);
    tools.push({ name, ...(callId ? { callId } : {}), startedAt: timestamp });
    if (tools.length > MAX_ACTIVE_TOOL_RECORDS) {
      tools.splice(0, tools.length - MAX_ACTIVE_TOOL_RECORDS);
    }
  } else if (existingIndex >= 0) {
    tools.splice(existingIndex, 1);
  }
  active.activeTools = tools;
  if (phase === "start" && name) active.lastTool = name;
  writeActiveTurn(active, art);
}

function appendActivity(
  art: ReturnType<typeof getArtifact>,
  phase: "start" | "end",
  event: { toolName?: string; toolCallId?: string; isError?: boolean },
): void {
  const active = readActiveTurn(art);
  if (!active) return;
  const timestamp = Date.now();
  if (phase === "start") {
    updateActiveToolMetadata(art, active, phase, event, timestamp);
  }
  const activity: SubagentEventV2 = {
    version: 2,
    eventId: newEventId(),
    turnId: active.turnId,
    ts: timestamp,
    type: "tool_activity",
    status: "running",
    phase,
    tool: event.toolName,
    summary:
      phase === "end" && event.isError
        ? `${event.toolName ?? "tool"} failed`
        : event.toolName,
  };
  appendEvent(art, activity);
  if (phase === "end") {
    updateActiveToolMetadata(art, active, phase, event, timestamp);
  }
}

export function registerChildProtocol(pi: ExtensionAPI): void {
  const art = getArtifact();
  let startupAgentStarted = false;
  pi.on("session_start", (event, ctx) => {
    const model = ctx.model;
    if (event.reason !== "startup" || !model) return;
    void ctx.modelRegistry
      .getApiKeyAndHeaders(model)
      .then((auth) => {
        if (startupAgentStarted) return;
        const registry = ctx.modelRegistry as typeof ctx.modelRegistry & {
          getRegisteredNativeProvider?: (provider: string) => unknown;
        };
        const isNativeProvider = Boolean(
          registry.getRegisteredNativeProvider?.(model.provider),
        );
        // Legacy fallbacks can expose undefined auth fields, so require
        // actual request config before trusting a stale auth-status snapshot.
        const requestAuth = auth as typeof auth & {
          baseUrl?: string;
        };
        const hasResolvedRequestConfig =
          auth.ok &&
          Boolean(
            auth.apiKey ||
            requestAuth.baseUrl ||
            Object.keys(auth.headers ?? {}).length ||
            Object.keys(auth.env ?? {}).length,
          );
        const missingLegacyAuth =
          !isNativeProvider &&
          typeof registry.hasConfiguredAuth === "function" &&
          !registry.hasConfiguredAuth(model) &&
          !hasResolvedRequestConfig;
        if (auth.ok && !missingLegacyAuth) return;
        if (!auth.ok) {
          const missingAuthError =
            missingLegacyAuth ||
            /\bno\s+(?:api key|credentials?)\s+(?:found|configured|set|provided|available|present)\b/i.test(
              auth.error,
            ) ||
            /\b(?:missing|required)\s+(?:api key|credentials?|authentication|auth)\b/i.test(
              auth.error,
            ) ||
            /\b(?:api key|credentials?)(?:\s+(?:is|are|was|were))?\s+(?:missing|not found|not configured|not provided|not set|unset|required)\b/i.test(
              auth.error,
            ) ||
            /\b(?:authentication|auth)(?:\s+(?:is|are|was|were))?\s+(?:missing|not configured|not provided|required)\b/i.test(
              auth.error,
            ) ||
            /\bno\s+(?:authentication|auth)\s+(?:configured|available|provided|set)\b/i.test(
              auth.error,
            );
          if (!missingAuthError) {
            debugLog("warn", "child_startup_auth_resolution_unavailable");
            return;
          }
        }
        const message = "Selected model has no configured authentication.";
        appendCompletionEvent(art, {
          turnId: "process",
          outcome: "error",
          source: "explicit",
          exitCode: 1,
          message,
          errorMessage: message,
        });
      })
      .catch(() => {
        debugLog("warn", "child_startup_auth_check_failed");
      });
  });
  const startPersistedTurn = (
    turnId: string,
    timestamp: number,
    previousUserEntryId?: string,
  ): ActiveTurn => {
    const turn: ActiveTurn = {
      turnId,
      startedAt: timestamp,
      started: true,
      previousUserEntryId,
    };
    latestAgentMessages = [];
    writeOutput(art, "");
    writeActiveTurn(turn, art);
    appendEvent(art, {
      version: 2,
      eventId: newEventId(),
      turnId: turn.turnId,
      ts: turn.startedAt,
      type: "turn_started",
      status: "running",
    });
    return turn;
  };
  const bindPersistedTurn = (
    ctx: any,
    timestamp: number,
  ): ActiveTurn | null => {
    const active = readActiveTurn(art);
    if (!active) return null;
    const persistedId = latestUserEntryId(ctx);
    if (active.started) {
      if (!persistedId || persistedId === active.turnId) return active;
      // Pi handles Enter during streaming as a steering message inside the
      // existing agent run, so it emits no before_agent_start. The persisted
      // user entry is the authoritative boundary for that new child turn.
      return startPersistedTurn(persistedId, timestamp, active.turnId);
    }
    if (!persistedId || persistedId === active.previousUserEntryId) {
      return active;
    }
    return startPersistedTurn(
      persistedId,
      timestamp,
      active.previousUserEntryId,
    );
  };
  pi.on("before_agent_start", (_event, ctx) => {
    startupAgentStarted = true;
    const turn: ActiveTurn = {
      turnId: `turn-${newEventId()}`,
      startedAt: Date.now(),
      started: false,
      previousUserEntryId: latestUserEntryId(ctx),
    };
    latestAgentMessages = [];
    writeOutput(art, "");
    writeActiveTurn(turn, art);
  });

  pi.on("turn_start", (event, ctx) => {
    bindPersistedTurn(ctx, event.timestamp);
    const deferredBind = setTimeout(
      () => bindPersistedTurn(ctx, event.timestamp),
      0,
    );
    deferredBind.unref();
  });
  // The first turn_start can precede persistence of the user message.
  // before_provider_request is the earliest guaranteed pre-model fallback.
  pi.on("before_provider_request", (_event, ctx) => {
    bindPersistedTurn(ctx, Date.now());
  });

  pi.on("tool_execution_start", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now());
    appendActivity(art, "start", event);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now());
    appendActivity(art, "end", event);
  });
  pi.on("agent_end", (event, ctx) => {
    bindPersistedTurn(ctx, Date.now());
    latestAgentMessages = [...event.messages];
  });
  pi.on("agent_settled", (event, ctx) => {
    const active = bindPersistedTurn(ctx, Date.now());
    if (!active) return;
    const assistant = [...latestAgentMessages]
      .reverse()
      .find((message: any) => message?.role === "assistant") as any;
    const stopReason = assistant?.stopReason;
    const errorMessage =
      typeof assistant?.errorMessage === "string"
        ? assistant.errorMessage
        : undefined;
    const failed =
      Boolean(errorMessage) ||
      assistant?.stopReason === "error" ||
      assistant?.stopReason === "aborted";
    const completion = appendCompletionEvent(art, {
      turnId: active.turnId,
      outcome: failed ? "error" : "done",
      source: "agent_settled",
      exitCode: failed ? 1 : 0,
      errorMessage,
      message: errorMessage,
      agentStopReason:
        stopReason === "error" || stopReason === "aborted"
          ? stopReason
          : undefined,
    });
    if (process.env[CHILD_DIAGNOSTICS_ENV] === "1") {
      const existingCompletion =
        completion ??
        readEvents(art).find(
          (candidate) =>
            candidate.type === "completion" &&
            candidate.turnId === active.turnId,
        );
      const snapshot =
        existingCompletion?.type === "completion"
          ? existingCompletion
          : undefined;
      const observedOutputBytes =
        snapshot?.output?.bytes ??
        (snapshot?.outputError?.code === "output_too_large"
          ? snapshot.outputError.bytes
          : 0);
      const outputBytesCapped = observedOutputBytes > MAX_OUTPUT_SNAPSHOT_BYTES;
      const outputBytes = Math.min(
        observedOutputBytes,
        MAX_OUTPUT_SNAPSHOT_BYTES,
      );
      const outputSnapshotState: ChildDiagnosticSnapshotState = snapshot?.output
        ? outputBytes > 0
          ? "written"
          : "empty"
        : snapshot?.outputError?.code === "output_too_large"
          ? "too_large"
          : snapshot?.outputError
            ? "unavailable"
            : "missing";
      appendChildDiagnostic(art, {
        version: 1,
        type: "turn_settled",
        turnId: active.turnId,
        ...summarizeFinalAssistant(assistant),
        aborted: event.aborted || stopReason === "aborted",
        error: failed,
        outputWriteSucceeded: outputSnapshotState === "written",
        outputBytes,
        outputBytesCapped,
        outputSnapshotState,
      });
    }
    const settled = readActiveTurn(art);
    if (settled?.turnId === active.turnId) {
      settled.activeTools = [];
      writeActiveTurn(settled, art);
    }
  });
}
