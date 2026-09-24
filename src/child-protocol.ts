import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_ACTIVE_TOOL_ID_INPUT_BYTES,
  MAX_ACTIVE_TOOL_ID_LENGTH,
  MAX_ACTIVE_TOOL_RECORDS,
  MAX_ACTIVE_TURN_BYTES,
  MAX_TOOL_NAME_LENGTH,
  MAX_TURN_ID_LENGTH,
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  newEventId,
  writeOutput,
  type SubagentEventV2,
} from "./artifact";

interface ActiveTool {
  name: string;
  callId?: string;
  callIdHash?: string;
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

interface ActiveToolCorrelation {
  hasCallId: boolean;
  callId?: string;
  callIdHash?: string;
}

function activeToolCorrelation(value: unknown): ActiveToolCorrelation {
  if (typeof value !== "string") return { hasCallId: false };
  if (value.length === 0) return { hasCallId: true };
  const callId = boundedMetadataIdentifier(value, MAX_ACTIVE_TOOL_ID_LENGTH);
  if (callId) return { hasCallId: true, callId };
  if (Buffer.byteLength(value, "utf8") > MAX_ACTIVE_TOOL_ID_INPUT_BYTES) {
    return { hasCallId: true };
  }
  return {
    hasCallId: true,
    callIdHash: createHash("sha256").update(value).digest("hex"),
  };
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
  const callIdHash =
    typeof candidate.callIdHash === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.callIdHash)
      ? candidate.callIdHash
      : undefined;
  return {
    name,
    ...(callId ? { callId } : {}),
    ...(callIdHash ? { callIdHash } : {}),
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
  correlation: ActiveToolCorrelation,
): number {
  if (correlation.hasCallId) {
    if (correlation.callId) {
      for (let index = tools.length - 1; index >= 0; index--) {
        if (tools[index]?.callId === correlation.callId) return index;
      }
    }
    if (correlation.callIdHash) {
      for (let index = tools.length - 1; index >= 0; index--) {
        if (tools[index]?.callIdHash === correlation.callIdHash) return index;
      }
    }
    return -1;
  }
  if (!name) return -1;
  let match = -1;
  for (let index = tools.length - 1; index >= 0; index--) {
    if (tools[index]?.name !== name) continue;
    if (match >= 0) return -1;
    match = index;
  }
  return match;
}

function updateActiveToolMetadata(
  art: ReturnType<typeof getArtifact>,
  active: ActiveTurn,
  phase: "start" | "end",
  event: { toolName?: string; toolCallId?: string },
  timestamp: number,
): void {
  const name = boundedMetadataIdentifier(event.toolName, MAX_TOOL_NAME_LENGTH);
  const correlation = activeToolCorrelation(event.toolCallId);
  const tools = [...(active.activeTools ?? [])];
  const existingIndex =
    phase === "start" && !correlation.hasCallId
      ? -1
      : lastActiveToolIndex(tools, name, correlation);
  if (phase === "start") {
    if (!name) return;
    if (existingIndex >= 0) tools.splice(existingIndex, 1);
    tools.push({
      name,
      ...(correlation.callId ? { callId: correlation.callId } : {}),
      ...(correlation.callIdHash ? { callIdHash: correlation.callIdHash } : {}),
      startedAt: timestamp,
    });
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
  // In createAgentSession 0.80.6, the first turn_start can precede persistence
  // of the user message. This is the earliest guaranteed pre-model fallback.
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
  pi.on("agent_settled", (_event, ctx) => {
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
    appendCompletionEvent(art, {
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
    const settled = readActiveTurn(art);
    if (settled?.turnId === active.turnId) {
      settled.activeTools = [];
      writeActiveTurn(settled, art);
    }
  });
}
