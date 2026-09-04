import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getModel, getProviders } from "@earendil-works/pi-ai/compat";

export const TELEMETRY_ENDPOINT = "https://us.i.posthog.com/i/v0/e/";
export const TELEMETRY_SCHEMA_VERSION = 3;
const TELEMETRY_PROJECT_TOKEN =
  "phc_B4H7xPiFbwPJmKbdeQtk7FeP3PnQF5AMpQJXCgGYeqFR";
const TELEMETRY_TIMEOUT_MS = 1_500;
export const MAX_TELEMETRY_DEDUPE_KEYS = 2_048;
const MAX_TELEMETRY_DEDUPE_KEY_LENGTH = 128;
const MAX_TELEMETRY_DEPTH = 64;
const MAX_TELEMETRY_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;

export type TelemetryMode = "straight" | "orchestrator" | "orchestrator_v2";
export type TelemetryExecution = "in-process" | "interactive";
export type TelemetryMux = "none" | "tmux" | "zellij" | "herdr";
export type TelemetrySpawnFailureMux = TelemetryMux | "unknown";
export type TelemetryInvocationSource =
  "with_context" | "isolated" | "interactive" | "workflow";
export type TelemetryCompletionPolicy = "inline" | "each" | "group" | "legacy";
export type TelemetryAgentStatus = "success" | "error" | "cancelled";
export type TelemetryResultSource = "in-process" | "interactive" | "workflow";
export type TelemetryDelivery = "manifest" | "notification";
export type TelemetryCompletionFailureStage =
  "notice_persistence" | "manifest_dispatch" | "retry_exhausted";
export type TelemetryWorkflowInvocation = "tool" | "saved_command";
export type TelemetryWorkflowStatus =
  "success" | "partial" | "error" | "cancelled";
export type TelemetryRecoveryReason = "startup" | "reload" | "resume";
export type TelemetryResultReadOutcome =
  | "consumed"
  | "already_consumed"
  | "empty"
  | "running"
  | "error"
  | "cancelled"
  | "wait_timeout"
  | "wait_cancelled"
  | "unavailable";
export type TelemetrySpawnFailureStage =
  | "depth_limit"
  | "capacity"
  | "context"
  | "model_resolution"
  | "session_creation"
  | "mux_resolution"
  | "pane_launch"
  | "state_persistence"
  | "registration"
  | "parent_shutdown"
  | "unknown";
export type TelemetryTerminalReason =
  | "completed"
  | "agent_error"
  | "process_exit"
  | "timeout"
  | "explicit_cancel"
  | "parent_cancelled"
  | "session_shutdown"
  | "fresh_session"
  | "unknown";
export type TelemetryDepthBucket = "1" | "2" | "3" | "4-7" | "8+" | "unknown";
export type TelemetryDurationBucket =
  "<1s" | "1-5s" | "5-30s" | "30s-2m" | "2-10m" | "10m+" | "unknown";

export const TELEMETRY_OPERATION_NAMES = {
  tool: [
    "subagent_with_context",
    "subagent_isolated",
    "subagent_interactive",
    "get_subagent_status",
    "get_subagent_result",
    "cancel_subagent",
    "prune_subagent_jobs",
    "list_available_models",
    "cleanup_subagent_artifacts",
    "get_current_pane_activity",
    "get_interactive_subagent_status",
    "cancel_interactive_subagent",
    "send_interactive_subagent_message",
    "read_subagent_artifact",
    "list_subagent_artifacts",
    "list_orchestrator_agents",
    "update_orchestrator_agent_description",
    "workflow",
    "get_workflow_status",
    "get_workflow_result",
    "cancel_workflow",
    "save_workflow",
    "list_workflows",
    "delete_workflow",
  ],
  command: [
    "workflow",
    "workflows",
    "list-workflows",
    "workflow-status",
    "workflow-tree",
    "delete-workflow",
    "subagents",
    "cancel-all-flows",
  ],
  shortcut: ["ctrl+alt+a", "ctrl+alt+x"],
} as const;
export type TelemetrySurface = keyof typeof TELEMETRY_OPERATION_NAMES;
export type TelemetryOperation =
  (typeof TELEMETRY_OPERATION_NAMES)[TelemetrySurface][number];
export type TelemetryOperationOutcome =
  "returned" | "reported_error" | "threw" | "aborted";
export type TelemetryOperationResultStatus =
  | "ok"
  | "started"
  | "running"
  | "completed"
  | "cancelled"
  | "wait_timeout"
  | "wait_cancelled"
  | "unavailable"
  | "invalid_input"
  | "confirmation_required"
  | "error"
  | "unknown";
export type TelemetrySessionFailureStage =
  | "telemetry_persistence"
  | "routing_recovery"
  | "state_recovery"
  | "wake_recovery";

export function telemetryOperationName(
  surface: TelemetrySurface,
  name: string,
): TelemetryOperation | undefined {
  return (TELEMETRY_OPERATION_NAMES[surface] as readonly string[]).includes(
    name,
  )
    ? (name as TelemetryOperation)
    : undefined;
}

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

type TelemetrySpawnFailureDimensions = Omit<TelemetryAgentDimensions, "mux"> & {
  mux: TelemetrySpawnFailureMux;
};

export type TelemetryEvent =
  | { event: "session_started" }
  | {
      event: "session_setup_failed";
      failure_stage: TelemetrySessionFailureStage;
    }
  | {
      event: "operation_started";
      surface: TelemetrySurface;
      operation: TelemetryOperation;
      session_role: "root" | "child";
    }
  | {
      event: "operation_completed";
      surface: TelemetrySurface;
      operation: TelemetryOperation;
      session_role: "root" | "child";
      outcome: TelemetryOperationOutcome;
      result_status: TelemetryOperationResultStatus;
      duration_ms?: number;
    }
  | ({
      event: "agent_created";
      spawn_duration_ms?: number;
    } & TelemetryAgentDimensions)
  | ({
      event: "agent_spawn_failed";
      failure_stage: TelemetrySpawnFailureStage;
      spawn_duration_ms?: number;
    } & TelemetrySpawnFailureDimensions)
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
      terminal_reason: TelemetryTerminalReason;
      duration_ms: number | undefined;
      child_conversation_message_count: number | undefined;
    } & TelemetryAgentDimensions)
  | {
      event: "workflow_started";
      invocation: TelemetryWorkflowInvocation;
      async: boolean;
      completion_policy: TelemetryCompletionPolicy;
    }
  | {
      event: "workflow_completed";
      invocation: TelemetryWorkflowInvocation;
      async: boolean;
      completion_policy: TelemetryCompletionPolicy;
      status: TelemetryWorkflowStatus;
      terminal_reason: TelemetryTerminalReason;
      agents_spawned: number;
      error_count: number;
      duration_ms?: number;
    }
  | {
      event: "session_recovered";
      reason: TelemetryRecoveryReason;
      total_count: number;
      alive_count: number;
      terminal_count: number;
      unknown_count: number;
    }
  | {
      event: "completion_delivered";
      delivery: TelemetryDelivery;
      count: number;
      delivery_latency_ms?: number;
    }
  | {
      event: "completion_delivery_failed";
      failure_stage: TelemetryCompletionFailureStage;
      retry_attempt: number;
    }
  | {
      event: "result_read";
      source: TelemetryResultSource;
      outcome: TelemetryResultReadOutcome;
      read_latency_ms?: number;
    };

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

/**
 * One dedupe key for a manifest delivery, shared by every emit site so two
 * callers cannot double-count the same manifest, and hashed past a bound so a
 * large manifest cannot grow the retained key set without limit.
 */
export function manifestDeliveryDedupeKey(
  completionIds: readonly string[],
): string {
  const joined = completionIds.join(":");
  if (joined.length <= MAX_TELEMETRY_DEDUPE_KEY_LENGTH) {
    return `manifest:${joined}`;
  }
  const digest = createHash("sha256").update(joined).digest("hex");
  return `manifest:${completionIds.length}:${digest}`;
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
  // Provider enumeration reaches registry code owned by the host agent. A throw
  // there must degrade the dimension, never fail the sub-agent launch that only
  // wanted to label a model.
  try {
    for (const provider of getProviders()) {
      if (builtInModel(provider, model)) return model;
    }
  } catch {
    return "custom";
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
    durationMs < 0 ||
    durationMs > MAX_TELEMETRY_DURATION_MS
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

/**
 * Round away meaningless precision and drop implausible timers. A recovered or
 * corrupt start timestamp produces a duration no analysis should trust, so it
 * is reported as unknown rather than clamped to a bogus-but-plausible number.
 */
export function telemetryDurationMs(
  durationMs: number | undefined,
): number | undefined {
  if (
    durationMs === undefined ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > MAX_TELEMETRY_DURATION_MS
  ) {
    return undefined;
  }
  return Math.round(durationMs / 100) * 100;
}

function depthProperty(depth: number | undefined): { depth?: number } {
  const boundedDepth = telemetryDepth(depth);
  return boundedDepth === undefined ? {} : { depth: boundedDepth };
}

type TelemetryDurationPropertyPrefix =
  "spawn_duration" | "duration" | "delivery_latency" | "read_latency";

function durationProperties(
  prefix: TelemetryDurationPropertyPrefix,
  durationMs: number | undefined,
): Record<string, number | string> {
  const boundedDuration = telemetryDurationMs(durationMs);
  return {
    [`${prefix}_bucket`]: telemetryDurationBucket(durationMs),
    ...(boundedDuration === undefined
      ? {}
      : { [`${prefix}_ms`]: boundedDuration }),
  };
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
    case "session_setup_failed":
      properties = { ...common, failure_stage: event.failure_stage };
      break;
    case "operation_started":
      properties = {
        ...common,
        surface: event.surface,
        operation: event.operation,
        session_role: event.session_role,
      };
      break;
    case "operation_completed":
      properties = {
        ...common,
        surface: event.surface,
        operation: event.operation,
        session_role: event.session_role,
        outcome: event.outcome,
        result_status: event.result_status,
        ...durationProperties("duration", event.duration_ms),
      };
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
        ...durationProperties("spawn_duration", event.spawn_duration_ms),
      };
      break;
    case "agent_spawn_failed":
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
        failure_stage: event.failure_stage,
        ...durationProperties("spawn_duration", event.spawn_duration_ms),
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
        terminal_reason: event.terminal_reason,
        ...durationProperties("duration", event.duration_ms),
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
    case "workflow_started":
      properties = {
        ...common,
        invocation: event.invocation,
        async: event.async,
        completion_policy: event.completion_policy,
      };
      break;
    case "workflow_completed":
      properties = {
        ...common,
        invocation: event.invocation,
        async: event.async,
        completion_policy: event.completion_policy,
        status: event.status,
        terminal_reason: event.terminal_reason,
        ...durationProperties("duration", event.duration_ms),
        agents_spawned: boundedCount(event.agents_spawned, 1_000),
        error_count: boundedCount(event.error_count, 1_000),
      };
      break;
    case "session_recovered":
      properties = {
        ...common,
        reason: event.reason,
        total_count: boundedCount(event.total_count, 1_000),
        alive_count: boundedCount(event.alive_count, 1_000),
        terminal_count: boundedCount(event.terminal_count, 1_000),
        unknown_count: boundedCount(event.unknown_count, 1_000),
      };
      break;
    case "completion_delivered":
      properties = {
        ...common,
        delivery: event.delivery,
        count: boundedCount(event.count, 128),
        ...durationProperties("delivery_latency", event.delivery_latency_ms),
      };
      break;
    case "completion_delivery_failed":
      properties = {
        ...common,
        delivery: "manifest",
        failure_stage: event.failure_stage,
        retry_attempt: boundedCount(event.retry_attempt, 32),
      };
      break;
    case "result_read":
      properties = {
        ...common,
        source: event.source,
        outcome: event.outcome,
        ...durationProperties("read_latency", event.read_latency_ms),
      };
      break;
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
  // An unref'd controller instead of AbortSignal.timeout: a pending capture must
  // never hold the event loop open for up to 1.5s while the process is exiting.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TELEMETRY_TIMEOUT_MS,
  ) as ReturnType<typeof setTimeout> & { unref?: () => void };
  timeout.unref?.();
  try {
    const request = fetchImpl(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildTelemetryPayload(session, event)),
      signal: controller.signal,
    });
    // Promise.resolve tolerates a patched fetch that returns a non-thenable, and
    // the attach stays inside the guard so no rejection escapes to the caller.
    // Offline, blocked, and timed-out requests are intentionally not retried.
    // Telemetry never consumes the payload, so release the unused response body
    // before considering the capture settled. Missing bodies are harmless.
    void Promise.resolve(request)
      .then((response) => response?.body?.cancel())
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
  } catch {
    // Best-effort analytics must never affect extension behavior.
    clearTimeout(timeout);
  }
}
