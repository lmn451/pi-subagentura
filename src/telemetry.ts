import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getModel, getProviders } from "@earendil-works/pi-ai/compat";

export const TELEMETRY_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
export const TELEMETRY_SCHEMA_VERSION = 2;
const TELEMETRY_PROJECT_TOKEN =
  "phc_B4H7xPiFbwPJmKbdeQtk7FeP3PnQF5AMpQJXCgGYeqFR";
const TELEMETRY_TIMEOUT_MS = 1_500;
export const MAX_TELEMETRY_DEDUPE_KEYS = 2_048;
const MAX_TELEMETRY_DEPTH = 64;
const MAX_TELEMETRY_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

export type TelemetryMode = "straight" | "orchestrator" | "orchestrator_v2";
export type TelemetryExecution = "in-process" | "interactive";
export type TelemetryMux = "none" | "tmux" | "zellij" | "herdr";
export type TelemetryInvocationSource =
  "with_context" | "isolated" | "interactive" | "workflow";
export type TelemetryCompletionPolicy = "inline" | "each" | "group" | "legacy";
export type TelemetryAgentStatus = "success" | "error" | "cancelled";
export type TelemetryResultSource = "in-process" | "interactive" | "workflow";
export type TelemetryDelivery = "manifest" | "notification";
export type TelemetryDepthBucket = "1" | "2" | "3" | "4-7" | "8+" | "unknown";
export type TelemetryDurationBucket =
  "<1s" | "1-5s" | "5-30s" | "30s-2m" | "2-10m" | "10m+" | "unknown";

interface TelemetryAgentDimensions {
  execution: TelemetryExecution;
  mux: TelemetryMux;
  invocation_source: TelemetryInvocationSource;
  model: string | undefined;
  async: boolean;
  depth: number | undefined;
  depth_bucket: TelemetryDepthBucket;
  completion_policy: TelemetryCompletionPolicy;
}

export type TelemetryEvent =
  | { event: "session_started" }
  | ({ event: "agent_created" } & TelemetryAgentDimensions)
  | ({ event: "task_started"; unit: "job" | "turn" } & TelemetryAgentDimensions)
  | {
      event: "interactive_message_sent";
      direction: "parent_to_child";
      count: number;
    }
  | ({
      event: "task_completed";
      unit: "job" | "turn";
      status: TelemetryAgentStatus;
      duration_ms: number | undefined;
      child_conversation_message_count: number | undefined;
    } & TelemetryAgentDimensions)
  | {
      event: "completion_delivered";
      delivery: TelemetryDelivery;
      count: number;
    }
  | { event: "result_consumed"; source: TelemetryResultSource };

export interface TelemetrySession {
  readonly enabled: boolean;
  readonly mode: TelemetryMode;
  readonly correlationId: string;
  readonly capturedKeys: Set<string>;
  active: boolean;
}

export interface AgentTelemetryContext {
  session: TelemetrySession;
  invocationSource: TelemetryInvocationSource;
  async: boolean;
  depth: number | undefined;
  completionPolicy: TelemetryCompletionPolicy;
}

interface CaptureOptions {
  allowInactive?: boolean;
  dedupeKey?: string;
  fetchImpl?: typeof fetch;
}

export interface TelemetryPayload {
  api_key: string;
  event: `pi_subagentura_${TelemetryEvent["event"]}`;
  distinct_id: string;
  properties: Record<string, boolean | number | string>;
}

const packageVersion = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string"
      ? packageJson.version
      : "unknown";
  } catch {
    // Missing version metadata must never prevent the extension from loading.
    return "unknown";
  }
}

function validCorrelationId(value: string | undefined): string | undefined {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value.toLowerCase()
    : undefined;
}

export function createTelemetrySession(
  enabled: boolean,
  mode: TelemetryMode | "manual" = "straight",
  inheritedCorrelationId?: string,
): TelemetrySession {
  return {
    enabled,
    mode: mode === "manual" ? "straight" : mode,
    correlationId: validCorrelationId(inheritedCorrelationId) ?? randomUUID(),
    capturedKeys: new Set(),
    active: true,
  };
}

export function resolveTelemetryMode(
  orchestratorMode: boolean,
  orchestratorV2Mode: boolean,
): TelemetryMode {
  if (orchestratorV2Mode) return "orchestrator_v2";
  return orchestratorMode ? "orchestrator" : "straight";
}

export function retireTelemetrySession(
  session: TelemetrySession | undefined,
): void {
  if (session) session.active = false;
}

function builtInModel(provider: string, modelId: string): boolean {
  try {
    return getModel(provider as never, modelId) !== undefined;
  } catch {
    return false;
  }
}

/** Never forward arbitrary model-generated strings into telemetry. */
export function sanitizeTelemetryModel(model: string | undefined): string {
  if (model === undefined || model === "") return "default";
  if (model === "default" || model === "custom") return model;
  const separator = model.indexOf("/");
  if (separator > 0) {
    const provider = model.slice(0, separator);
    const modelId = model.slice(separator + 1);
    return builtInModel(provider, modelId) ? model : "custom";
  }
  for (const provider of getProviders()) {
    if (builtInModel(provider, model)) return model;
  }
  return "custom";
}

export function telemetryDepthBucket(
  depth: number | undefined,
): TelemetryDepthBucket {
  if (!Number.isSafeInteger(depth) || depth === undefined || depth < 1) {
    return "unknown";
  }
  if (depth <= 3) return String(depth) as "1" | "2" | "3";
  return depth <= 7 ? "4-7" : "8+";
}

export function telemetryDepth(depth: number | undefined): number | undefined {
  return Number.isSafeInteger(depth) &&
    depth !== undefined &&
    depth >= 1 &&
    depth <= MAX_TELEMETRY_DEPTH
    ? depth
    : undefined;
}

export function telemetryDurationBucket(
  durationMs: number | undefined,
): TelemetryDurationBucket {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return "unknown";
  }
  if (durationMs < 1_000) return "<1s";
  if (durationMs < 5_000) return "1-5s";
  if (durationMs < 30_000) return "5-30s";
  if (durationMs < 120_000) return "30s-2m";
  if (durationMs < 600_000) return "2-10m";
  return "10m+";
}

/** Round away meaningless precision and cap pathological or corrupt timers. */
export function telemetryDurationMs(
  durationMs: number | undefined,
): number | undefined {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return undefined;
  }
  return Math.min(
    Math.round(durationMs / 100) * 100,
    MAX_TELEMETRY_DURATION_MS,
  );
}

function depthProperty(depth: number | undefined): { depth?: number } {
  const boundedDepth = telemetryDepth(depth);
  return boundedDepth === undefined ? {} : { depth: boundedDepth };
}

function durationProperty(durationMs: number | undefined): {
  duration_ms?: number;
} {
  const boundedDuration = telemetryDurationMs(durationMs);
  return boundedDuration === undefined ? {} : { duration_ms: boundedDuration };
}

function boundedCount(value: number | undefined, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value!), 0), max);
}

export function buildTelemetryPayload(
  session: TelemetrySession,
  event: TelemetryEvent,
): TelemetryPayload {
  const common = {
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: "0.0.0.0",
    $lib: "pi-subagentura",
    $lib_version: packageVersion,
    schema_version: TELEMETRY_SCHEMA_VERSION,
    telemetry_session_id: session.correlationId,
    mode: session.mode,
  };
  let properties: TelemetryPayload["properties"];
  switch (event.event) {
    case "session_started":
      properties = common;
      break;
    case "agent_created":
      properties = {
        ...common,
        execution: event.execution,
        mux: event.mux,
        invocation_source: event.invocation_source,
        model: sanitizeTelemetryModel(event.model),
        async: event.async,
        ...depthProperty(event.depth),
        depth_bucket: event.depth_bucket,
        completion_policy: event.completion_policy,
      };
      break;
    case "task_started":
      properties = {
        ...common,
        execution: event.execution,
        mux: event.mux,
        unit: event.unit,
        invocation_source: event.invocation_source,
        model: sanitizeTelemetryModel(event.model),
        async: event.async,
        ...depthProperty(event.depth),
        depth_bucket: event.depth_bucket,
        completion_policy: event.completion_policy,
      };
      break;
    case "interactive_message_sent":
      properties = {
        ...common,
        direction: event.direction,
        count: boundedCount(event.count, 128),
      };
      break;
    case "task_completed":
      properties = {
        ...common,
        execution: event.execution,
        mux: event.mux,
        unit: event.unit,
        invocation_source: event.invocation_source,
        model: sanitizeTelemetryModel(event.model),
        async: event.async,
        ...depthProperty(event.depth),
        depth_bucket: event.depth_bucket,
        completion_policy: event.completion_policy,
        status: event.status,
        duration_bucket: telemetryDurationBucket(event.duration_ms),
        ...durationProperty(event.duration_ms),
        ...(event.child_conversation_message_count === undefined
          ? {}
          : {
              child_conversation_message_count: boundedCount(
                event.child_conversation_message_count,
                1_000,
              ),
            }),
      };
      break;
    case "completion_delivered":
      properties = {
        ...common,
        delivery: event.delivery,
        count: boundedCount(event.count, 128),
      };
      break;
    case "result_consumed":
      properties = { ...common, source: event.source };
  }
  return {
    api_key: TELEMETRY_PROJECT_TOKEN,
    event: `pi_subagentura_${event.event}`,
    distinct_id: session.correlationId,
    properties,
  };
}

export function captureTelemetry(
  session: TelemetrySession | undefined,
  event: TelemetryEvent,
  options: CaptureOptions = {},
): void {
  if (!session?.enabled || (!session.active && !options.allowInactive)) return;
  if (options.dedupeKey) {
    if (session.capturedKeys.has(options.dedupeKey)) return;
    // Retain recent retry protection without making a long session stop
    // reporting authoritative lifecycle events after the memory bound.
    if (session.capturedKeys.size >= MAX_TELEMETRY_DEDUPE_KEYS) {
      const oldest = session.capturedKeys.values().next().value;
      if (oldest !== undefined) session.capturedKeys.delete(oldest);
    }
    session.capturedKeys.add(options.dedupeKey);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let request: Promise<Response>;
  try {
    request = fetchImpl(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildTelemetryPayload(session, event)),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // Best-effort analytics must never affect extension behavior.
    return;
  }
  void request.catch(() => {
    // Offline, blocked, and timed-out requests are intentionally not retried.
  });
}
