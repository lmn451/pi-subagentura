import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelemetryPayload,
  captureTelemetry,
  createTelemetrySession,
  manifestDeliveryDedupeKey,
  MAX_TELEMETRY_DEDUPE_KEYS,
  resolveTelemetryMode,
  retireTelemetrySession,
  sanitizeTelemetryModel,
  TELEMETRY_ENDPOINT,
  telemetryDepth,
  telemetryDepthBucket,
  telemetryDurationMs,
  telemetryDurationBucket,
  type TelemetryEvent,
} from "../src/telemetry";
import {
  isTelemetryEnabled,
  TELEMETRY_ENV,
  TELEMETRY_FLAG,
  TELEMETRY_OPT_OUT_FLAG,
} from "../src/settings";

const originalEnvironment = {
  CI: process.env.CI,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  NODE_ENV: process.env.NODE_ENV,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_OFFLINE: process.env.PI_OFFLINE,
  TELEMETRY: process.env[TELEMETRY_ENV],
  VITEST: process.env.VITEST,
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries({
    CI: originalEnvironment.CI,
    DO_NOT_TRACK: originalEnvironment.DO_NOT_TRACK,
    NODE_ENV: originalEnvironment.NODE_ENV,
    PI_CODING_AGENT_DIR: originalEnvironment.PI_CODING_AGENT_DIR,
    PI_OFFLINE: originalEnvironment.PI_OFFLINE,
    [TELEMETRY_ENV]: originalEnvironment.TELEMETRY,
    VITEST: originalEnvironment.VITEST,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function clearTelemetryOptOuts(): void {
  delete process.env.CI;
  delete process.env.DO_NOT_TRACK;
  delete process.env.NODE_ENV;
  delete process.env.PI_OFFLINE;
  delete process.env[TELEMETRY_ENV];
  delete process.env.VITEST;
}

let telemetrySettingsRoot: string | undefined;
let telemetryStorageOptions: { agentDir: string; cwd: string };

describe("anonymous product telemetry", () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-telemetry-settings-"));
    telemetrySettingsRoot = root;
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    telemetryStorageOptions = { agentDir, cwd };
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    restoreEnvironment();
    vi.restoreAllMocks();
    if (telemetrySettingsRoot !== undefined) {
      rmSync(telemetrySettingsRoot, { recursive: true, force: true });
      telemetrySettingsRoot = undefined;
    }
  });

  it("reuses one random personless correlation id within a session", () => {
    const session = createTelemetrySession(true, "orchestrator_v2");
    const started = buildTelemetryPayload(session, {
      event: "session_started",
    });
    const agent = buildTelemetryPayload(session, {
      event: "task_started",
      execution: "in-process",
      mux: "none",
      unit: "job",
      invocation_source: "workflow",
      model: "openai/gpt-5.6-sol",
      async: true,
      depth: 2,
      depth_bucket: "2",
      completion_policy: "each",
    });

    expect(started.distinct_id).toBe(agent.distinct_id);
    expect(started.distinct_id).toBe(session.correlationId);
    expect(started.properties.telemetry_session_id).toBe(session.correlationId);
    expect(started.properties).toMatchObject({
      $process_person_profile: false,
      $geoip_disable: true,
      $ip: "0.0.0.0",
      $lib: "pi-subagentura",
      schema_version: 3,
      mode: "orchestrator_v2",
    });
    expect(agent.properties).toMatchObject({
      execution: "in-process",
      mux: "none",
      unit: "job",
      invocation_source: "workflow",
      model: "openai/gpt-5.6-sol",
      async: true,
      depth: 2,
      depth_bucket: "2",
      completion_policy: "each",
    });
  });

  it("creates unrelated ids for unrelated root sessions", () => {
    expect(createTelemetrySession(true).correlationId).not.toBe(
      createTelemetrySession(true).correlationId,
    );
  });

  it("allows only a valid bootstrap correlation id", () => {
    const expected = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      createTelemetrySession(true, "straight", expected).correlationId,
    ).toBe(expected);
    expect(
      createTelemetrySession(true, "straight", "raw-pi-session-id")
        .correlationId,
    ).not.toBe("raw-pi-session-id");
  });

  it("uses closed modes with V2 precedence", () => {
    expect(resolveTelemetryMode(false, false)).toBe("straight");
    expect(resolveTelemetryMode(true, false)).toBe("orchestrator");
    expect(resolveTelemetryMode(false, true)).toBe("orchestrator_v2");
    expect(resolveTelemetryMode(true, true)).toBe("orchestrator_v2");
    expect(createTelemetrySession(true, "manual").mode).toBe("straight");
  });

  it("sanitizes models and buckets numeric values", () => {
    expect(sanitizeTelemetryModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(sanitizeTelemetryModel("openai/gpt-5.6-sol")).toBe(
      "openai/gpt-5.6-sol",
    );
    expect(sanitizeTelemetryModel("private/customer-deployment")).toBe(
      "custom",
    );
    expect(sanitizeTelemetryModel(undefined)).toBe("default");
    expect(sanitizeTelemetryModel("default")).toBe("default");
    expect(sanitizeTelemetryModel("custom")).toBe("custom");
    expect(telemetryDepthBucket(4)).toBe("4-7");
    expect(telemetryDepthBucket(99)).toBe("8+");
    expect(telemetryDepthBucket(undefined)).toBe("unknown");
    expect(telemetryDepth(4)).toBe(4);
    expect(telemetryDepth(65)).toBeUndefined();
    expect(telemetryDurationBucket(4_999)).toBe("1-5s");
    expect(telemetryDurationBucket(700_000)).toBe("10m+");
    expect(telemetryDurationMs(12_345)).toBe(12_300);
    expect(telemetryDurationMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("reports an implausible span as unknown instead of a capped number", () => {
    const beyondBound = 31 * 24 * 60 * 60 * 1_000;

    expect(telemetryDurationMs(beyondBound)).toBeUndefined();
    expect(telemetryDurationBucket(beyondBound)).toBe("unknown");

    const completed = buildTelemetryPayload(createTelemetrySession(true), {
      event: "task_completed",
      execution: "interactive",
      mux: "tmux",
      unit: "turn",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: 1,
      depth_bucket: "1",
      completion_policy: "each",
      status: "success",
      terminal_reason: "timeout",
      // A start timestamp recovered from a previous run yields a span no
      // analysis should trust; a clamped value would look plausible.
      duration_ms: beyondBound,
      child_conversation_message_count: undefined,
    });

    expect(completed.properties).not.toHaveProperty("duration_ms");
    expect(completed.properties.duration_bucket).toBe("unknown");
  });

  it("shares one bounded manifest dedupe key across both delivery sites", () => {
    expect(manifestDeliveryDedupeKey(["a", "b"])).toBe("manifest:a:b");

    const many = Array.from(
      { length: 64 },
      (_, index) => `completion-${index}`,
    );
    const key = manifestDeliveryDedupeKey(many);

    expect(key.length).toBeLessThan(many.join(":").length);
    expect(key).toBe(manifestDeliveryDedupeKey([...many]));
    expect(key).not.toBe(manifestDeliveryDedupeKey(many.slice(0, 63)));
  });

  it("bounds the interactive_message_sent payload to closed dimensions", () => {
    const session = createTelemetrySession(true, "orchestrator");
    const payload = buildTelemetryPayload(session, {
      event: "interactive_message_sent",
      direction: "parent_to_child",
      count: 5_000,
    });

    expect(payload.event).toBe("pi_subagentura_interactive_message_sent");
    expect(Object.keys(payload.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "count",
        "direction",
        "mode",
        "schema_version",
        "telemetry_session_id",
      ].sort(),
    );
    expect(payload.properties).toMatchObject({
      direction: "parent_to_child",
      count: 128,
      mode: "orchestrator",
      telemetry_session_id: session.correlationId,
    });
  });

  it("bounds the completion_delivered payload to closed dimensions", () => {
    const session = createTelemetrySession(true);
    const payload = buildTelemetryPayload(session, {
      event: "completion_delivered",
      delivery: "manifest",
      count: 900,
    });

    expect(payload.event).toBe("pi_subagentura_completion_delivered");
    expect(Object.keys(payload.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "count",
        "delivery",
        "delivery_latency_bucket",
        "mode",
        "schema_version",
        "telemetry_session_id",
      ].sort(),
    );
    expect(payload.properties).toMatchObject({
      delivery: "manifest",
      count: 128,
      delivery_latency_bucket: "unknown",
    });
  });

  it.each([
    [Number.NaN, 0],
    [-7, 0],
    [1.9, 1],
    [128, 128],
    [129, 128],
  ])("clamps a bounded count of %s to %s", (count, expected) => {
    expect(
      buildTelemetryPayload(createTelemetrySession(true), {
        event: "completion_delivered",
        delivery: "notification",
        count: count as number,
      }).properties.count,
    ).toBe(expected);
  });

  it("carries exactly the documented top-level payload fields", () => {
    const payload = buildTelemetryPayload(createTelemetrySession(true), {
      event: "session_started",
    });

    expect(Object.keys(payload).sort()).toEqual([
      "api_key",
      "distinct_id",
      "event",
      "properties",
    ]);
    expect(typeof payload.api_key).toBe("string");
    expect(payload.api_key.length).toBeGreaterThan(0);
  });

  it("distinguishes one created agent from its delegated tasks", () => {
    const session = createTelemetrySession(true, "straight");
    const created = buildTelemetryPayload(session, {
      event: "agent_created",
      execution: "interactive",
      mux: "tmux",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: 3,
      depth_bucket: "3",
      completion_policy: "each",
    });
    const task = buildTelemetryPayload(session, {
      event: "task_started",
      execution: "interactive",
      mux: "tmux",
      unit: "turn",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: 3,
      depth_bucket: "3",
      completion_policy: "each",
    });

    expect(created.event).toBe("pi_subagentura_agent_created");
    expect(task.event).toBe("pi_subagentura_task_started");
    expect(created.properties).toMatchObject({
      execution: "interactive",
      mux: "tmux",
      depth: 3,
      depth_bucket: "3",
    });
    expect(task.properties.unit).toBe("turn");
  });

  it("contains only documented bounded lifecycle properties", () => {
    const session = createTelemetrySession(true);
    const completed = buildTelemetryPayload(session, {
      event: "task_completed",
      execution: "interactive",
      mux: "tmux",
      unit: "turn",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: 1,
      depth_bucket: "1",
      completion_policy: "each",
      status: "success",
      terminal_reason: "completed",
      duration_ms: 12_345,
      child_conversation_message_count: 50_000,
    });

    expect(Object.keys(completed.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "async",
        "child_conversation_message_count",
        "completion_policy",
        "depth",
        "depth_bucket",
        "duration_bucket",
        "duration_ms",
        "execution",
        "mux",
        "invocation_source",
        "model",
        "mode",
        "schema_version",
        "status",
        "telemetry_session_id",
        "terminal_reason",
        "unit",
      ].sort(),
    );
    expect(completed.properties.child_conversation_message_count).toBe(1_000);
    expect(completed.properties.duration_ms).toBe(12_300);
    expect(JSON.stringify(completed)).not.toMatch(
      /task_text|persona|prompt|output|error_text|cwd|path|artifact_id|agent_id|raw_session_id|token|cost/i,
    );
  });

  it("emits the complete agent_spawn_failed shape with bounded duration", () => {
    const session = createTelemetrySession(true, "orchestrator_v2");
    const payload = buildTelemetryPayload(session, {
      event: "agent_spawn_failed",
      execution: "interactive",
      mux: "unknown",
      invocation_source: "isolated",
      model: "default",
      async: false,
      depth: 4,
      depth_bucket: "4-7",
      completion_policy: "each",
      failure_stage: "pane_launch",
      spawn_duration_ms: 12_345,
    });

    expect(payload.event).toBe("pi_subagentura_agent_spawn_failed");
    expect(Object.keys(payload.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "async",
        "completion_policy",
        "depth",
        "depth_bucket",
        "failure_stage",
        "invocation_source",
        "mode",
        "model",
        "mux",
        "schema_version",
        "spawn_duration_bucket",
        "spawn_duration_ms",
        "telemetry_session_id",
        "execution",
      ].sort(),
    );
    expect(payload.properties).toMatchObject({
      execution: "interactive",
      mux: "unknown",
      failure_stage: "pane_launch",
      spawn_duration_ms: 12_300,
      spawn_duration_bucket: "5-30s",
      schema_version: 3,
    });
  });

  it("keeps unknown mux scoped to spawn-failure events", () => {
    type SpawnFailureMux = Extract<
      TelemetryEvent,
      { event: "agent_spawn_failed" }
    >["mux"];
    type AgentCreatedMux = Extract<
      TelemetryEvent,
      { event: "agent_created" }
    >["mux"];
    type TaskStartedMux = Extract<
      TelemetryEvent,
      { event: "task_started" }
    >["mux"];
    type TaskCompletedMux = Extract<
      TelemetryEvent,
      { event: "task_completed" }
    >["mux"];

    const spawnFailureMux: SpawnFailureMux = "unknown";
    // @ts-expect-error Unknown mux is reserved for spawn failures.
    const agentCreatedMux: AgentCreatedMux = "unknown";
    // @ts-expect-error Unknown mux is reserved for spawn failures.
    const taskStartedMux: TaskStartedMux = "unknown";
    // @ts-expect-error Unknown mux is reserved for spawn failures.
    const taskCompletedMux: TaskCompletedMux = "unknown";

    expect(spawnFailureMux).toBe("unknown");
    void [agentCreatedMux, taskStartedMux, taskCompletedMux];
  });

  it.each([
    "depth_limit",
    "capacity",
    "context",
    "model_resolution",
    "session_creation",
    "mux_resolution",
    "pane_launch",
    "state_persistence",
    "registration",
    "parent_shutdown",
    "unknown",
  ] as const)("accepts spawn failure stage %s", (failure_stage) => {
    const payload = buildTelemetryPayload(createTelemetrySession(true), {
      event: "agent_spawn_failed",
      execution: "interactive",
      mux: "unknown",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: undefined,
      depth_bucket: "unknown",
      completion_policy: "each",
      failure_stage,
    });

    expect(payload.properties.failure_stage).toBe(failure_stage);
    expect(payload.properties.spawn_duration_bucket).toBe("unknown");
    expect(payload.properties).not.toHaveProperty("spawn_duration_ms");
  });

  it("emits a paired unknown bucket when an optional spawn duration is invalid", () => {
    const payload = buildTelemetryPayload(createTelemetrySession(true), {
      event: "agent_created",
      execution: "in-process",
      mux: "none",
      invocation_source: "with_context",
      model: "default",
      async: true,
      depth: 1,
      depth_bucket: "1",
      completion_policy: "inline",
      spawn_duration_ms: Number.NaN,
    });

    expect(payload.properties).toMatchObject({
      spawn_duration_bucket: "unknown",
    });
    expect(payload.properties).not.toHaveProperty("spawn_duration_ms");
  });

  it.each([
    "completed",
    "agent_error",
    "process_exit",
    "timeout",
    "explicit_cancel",
    "parent_cancelled",
    "session_shutdown",
    "fresh_session",
    "unknown",
  ] as const)("accepts terminal reason %s", (terminal_reason) => {
    const payload = buildTelemetryPayload(createTelemetrySession(true), {
      event: "task_completed",
      execution: "in-process",
      mux: "none",
      unit: "job",
      invocation_source: "isolated",
      model: "default",
      async: true,
      depth: undefined,
      depth_bucket: "unknown",
      completion_policy: "each",
      status: "success",
      terminal_reason,
      duration_ms: undefined,
      child_conversation_message_count: undefined,
    });

    expect(payload.properties.terminal_reason).toBe(terminal_reason);
    expect(payload.properties.duration_bucket).toBe("unknown");
  });

  it("keeps workflow lifecycle payloads closed and bounds workflow counts", () => {
    const session = createTelemetrySession(true, "orchestrator");
    const started = buildTelemetryPayload(session, {
      event: "workflow_started",
      invocation: "saved_command",
      async: true,
      completion_policy: "group",
    });
    const completed = buildTelemetryPayload(session, {
      event: "workflow_completed",
      invocation: "saved_command",
      async: true,
      completion_policy: "group",
      status: "partial",
      terminal_reason: "agent_error",
      agents_spawned: 50_000,
      error_count: 1_001.9,
      duration_ms: 12_345,
    });

    expect(Object.keys(started.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "async",
        "completion_policy",
        "invocation",
        "mode",
        "schema_version",
        "telemetry_session_id",
      ].sort(),
    );
    expect(Object.keys(completed.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$ip",
        "$lib",
        "$lib_version",
        "$process_person_profile",
        "agents_spawned",
        "async",
        "completion_policy",
        "duration_bucket",
        "duration_ms",
        "error_count",
        "invocation",
        "mode",
        "schema_version",
        "status",
        "telemetry_session_id",
        "terminal_reason",
      ].sort(),
    );
    expect(completed.properties).toMatchObject({
      invocation: "saved_command",
      status: "partial",
      terminal_reason: "agent_error",
      agents_spawned: 1_000,
      error_count: 1_000,
      duration_ms: 12_300,
      duration_bucket: "5-30s",
    });
  });

  it.each(["success", "partial", "error", "cancelled"] as const)(
    "accepts workflow status %s",
    (status) => {
      const payload = buildTelemetryPayload(createTelemetrySession(true), {
        event: "workflow_completed",
        invocation: "tool",
        async: false,
        completion_policy: "inline",
        status,
        terminal_reason: "completed",
        agents_spawned: 0,
        error_count: 0,
      });

      expect(payload.properties.status).toBe(status);
      expect(payload.properties.duration_bucket).toBe("unknown");
      expect(payload.properties).not.toHaveProperty("duration_ms");
    },
  );

  it.each(["startup", "reload", "resume"] as const)(
    "keeps recovery reason %s and bounds recovery counts",
    (reason) => {
      const payload = buildTelemetryPayload(createTelemetrySession(true), {
        event: "session_recovered",
        reason,
        total_count: 5_000,
        alive_count: 3.9,
        terminal_count: Number.NaN,
        unknown_count: Number.POSITIVE_INFINITY,
      });

      expect(Object.keys(payload.properties).sort()).toEqual(
        [
          "$geoip_disable",
          "$ip",
          "$lib",
          "$lib_version",
          "$process_person_profile",
          "alive_count",
          "mode",
          "reason",
          "schema_version",
          "telemetry_session_id",
          "terminal_count",
          "total_count",
          "unknown_count",
        ].sort(),
      );
      expect(payload.properties).toMatchObject({
        reason,
        total_count: 1_000,
        alive_count: 3,
        terminal_count: 0,
        unknown_count: 0,
      });
    },
  );

  it("rounds delivery latency and omits an invalid numeric value", () => {
    const valid = buildTelemetryPayload(createTelemetrySession(true), {
      event: "completion_delivered",
      delivery: "notification",
      count: 1,
      delivery_latency_ms: 12_345,
    });
    const invalid = buildTelemetryPayload(createTelemetrySession(true), {
      event: "completion_delivered",
      delivery: "notification",
      count: 1,
      delivery_latency_ms: Number.POSITIVE_INFINITY,
    });

    expect(valid.properties).toMatchObject({
      delivery_latency_ms: 12_300,
      delivery_latency_bucket: "5-30s",
    });
    expect(invalid.properties.delivery_latency_bucket).toBe("unknown");
    expect(invalid.properties).not.toHaveProperty("delivery_latency_ms");
  });

  it.each([
    "consumed",
    "already_consumed",
    "empty",
    "running",
    "error",
    "cancelled",
    "wait_timeout",
    "wait_cancelled",
    "unavailable",
  ] as const)("accepts result-read outcome %s", (outcome) => {
    const payload = buildTelemetryPayload(createTelemetrySession(true), {
      event: "result_read",
      source: "workflow",
      outcome,
      read_latency_ms: 1_234,
    });

    expect(payload.event).toBe("pi_subagentura_result_read");
    expect(payload.properties).toMatchObject({
      source: "workflow",
      outcome,
      read_latency_ms: 1_200,
      read_latency_bucket: "1-5s",
    });
  });

  it("keeps every v3 event within the privacy allowlist", () => {
    const session = createTelemetrySession(true, "orchestrator_v2");
    const dimensions = {
      execution: "in-process" as const,
      mux: "none" as const,
      invocation_source: "workflow" as const,
      model: "default" as const,
      async: true,
      depth: 1,
      depth_bucket: "1" as const,
      completion_policy: "each" as const,
    };
    const payloads = [
      buildTelemetryPayload(session, { event: "session_started" }),
      buildTelemetryPayload(session, {
        event: "agent_created",
        ...dimensions,
        spawn_duration_ms: 100,
      }),
      buildTelemetryPayload(session, {
        event: "agent_spawn_failed",
        ...dimensions,
        mux: "unknown",
        failure_stage: "unknown",
      }),
      buildTelemetryPayload(session, {
        event: "task_started",
        ...dimensions,
        unit: "job",
      }),
      buildTelemetryPayload(session, {
        event: "interactive_message_sent",
        direction: "parent_to_child",
        count: 1,
      }),
      buildTelemetryPayload(session, {
        event: "task_completed",
        ...dimensions,
        unit: "turn",
        status: "cancelled",
        terminal_reason: "explicit_cancel",
        duration_ms: 100,
        child_conversation_message_count: 1,
      }),
      buildTelemetryPayload(session, {
        event: "workflow_started",
        invocation: "tool",
        async: false,
        completion_policy: "inline",
      }),
      buildTelemetryPayload(session, {
        event: "workflow_completed",
        invocation: "tool",
        async: false,
        completion_policy: "inline",
        status: "cancelled",
        terminal_reason: "session_shutdown",
        agents_spawned: 1,
        error_count: 1,
      }),
      buildTelemetryPayload(session, {
        event: "session_recovered",
        reason: "resume",
        total_count: 1,
        alive_count: 1,
        terminal_count: 0,
        unknown_count: 0,
      }),
      buildTelemetryPayload(session, {
        event: "completion_delivered",
        delivery: "manifest",
        count: 1,
        delivery_latency_ms: 100,
      }),
      buildTelemetryPayload(session, {
        event: "result_read",
        source: "in-process",
        outcome: "consumed",
        read_latency_ms: 100,
      }),
    ];
    const allowed = new Set([
      "$geoip_disable",
      "$ip",
      "$lib",
      "$lib_version",
      "$process_person_profile",
      "agents_spawned",
      "alive_count",
      "async",
      "child_conversation_message_count",
      "completion_policy",
      "count",
      "delivery",
      "delivery_latency_bucket",
      "delivery_latency_ms",
      "depth",
      "direction",
      "depth_bucket",
      "duration_bucket",
      "duration_ms",
      "error_count",
      "execution",
      "failure_stage",
      "invocation",
      "invocation_source",
      "mode",
      "model",
      "mux",
      "outcome",
      "read_latency_bucket",
      "read_latency_ms",
      "reason",
      "schema_version",
      "source",
      "spawn_duration_bucket",
      "spawn_duration_ms",
      "status",
      "telemetry_session_id",
      "terminal_count",
      "terminal_reason",
      "total_count",
      "unknown_count",
      "unit",
    ]);

    for (const payload of payloads) {
      expect(
        Object.keys(payload.properties).every((key) => allowed.has(key)),
      ).toBe(true);
      expect(JSON.stringify(payload)).not.toMatch(
        /task_text|persona|prompt|output|error_text|cwd|path|artifact_id|agent_id|raw_session_id|token|cost/i,
      );
      expect(payload.properties.schema_version).toBe(3);
    }
  });

  it("posts best-effort events once per internal dedupe key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const session = createTelemetrySession(true);
    const event = {
      event: "result_read",
      source: "workflow",
      outcome: "consumed",
    } as const;

    captureTelemetry(session, event, { dedupeKey: "internal", fetchImpl });
    captureTelemetry(session, event, { dedupeKey: "internal", fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(TELEMETRY_ENDPOINT);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      event: "pi_subagentura_result_read",
      distinct_id: session.correlationId,
      properties: {
        source: "workflow",
        outcome: "consumed",
        read_latency_bucket: "unknown",
      },
    });
  });

  it("evicts the oldest dedupe key without dropping new lifecycle events", () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const session = createTelemetrySession(true);
    for (let index = 0; index < MAX_TELEMETRY_DEDUPE_KEYS; index++) {
      session.capturedKeys.add(`existing:${index}`);
    }

    captureTelemetry(
      session,
      {
        event: "result_read",
        source: "interactive",
        outcome: "already_consumed",
      },
      { dedupeKey: "overflow", fetchImpl },
    );
    captureTelemetry(
      session,
      {
        event: "result_read",
        source: "interactive",
        outcome: "already_consumed",
      },
      { dedupeKey: "overflow", fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(session.capturedKeys.has("existing:0")).toBe(false);
    expect(session.capturedKeys.has("overflow")).toBe(true);
    expect(session.capturedKeys).toHaveLength(MAX_TELEMETRY_DEDUPE_KEYS);
  });

  it("allows only an explicitly terminal capture after session retirement", () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const session = createTelemetrySession(true);
    retireTelemetrySession(session);

    captureTelemetry(session, { event: "session_started" }, { fetchImpl });
    captureTelemetry(
      session,
      {
        event: "task_completed",
        execution: "in-process",
        mux: "none",
        unit: "job",
        invocation_source: "isolated",
        model: "default",
        async: true,
        depth: 1,
        depth_bucket: "1",
        completion_policy: "each",
        status: "cancelled",
        terminal_reason: "parent_cancelled",
        duration_ms: 1_000,
        child_conversation_message_count: 0,
      },
      { allowInactive: true, fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      event: "pi_subagentura_task_completed",
      properties: { status: "cancelled" },
    });
  });

  it.each([
    [
      "a fetch that throws synchronously",
      () => {
        throw new TypeError("fetch is not available");
      },
    ],
    ["a fetch that rejects", () => Promise.reject(new Error("offline"))],
    ["a patched fetch that returns a non-thenable", () => undefined],
    ["a patched fetch that returns null", () => null],
  ])("keeps the caller unaffected by %s", async (_label, impl) => {
    const session = createTelemetrySession(true);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      expect(() =>
        captureTelemetry(
          session,
          { event: "session_started" },
          { fetchImpl: impl as unknown as typeof fetch },
        ),
      ).not.toThrow();
      // A rejection attached outside the guard would surface a turn later.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("unrefs its abort timer so a pending capture cannot delay shutdown", () => {
    // A capture in flight must never be the reason the process stays alive.
    const unrefs: string[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const handle = realSetTimeout(...args);
      const unref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefs.push("unref");
        return unref();
      };
      return handle;
    }) as typeof setTimeout);
    try {
      captureTelemetry(
        createTelemetrySession(true),
        { event: "session_started" },
        {
          fetchImpl: vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
        },
      );
    } finally {
      spy.mockRestore();
    }

    expect(unrefs).toEqual(["unref"]);
  });

  it("clears its abort timer as soon as the capture settles", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    try {
      captureTelemetry(
        createTelemetrySession(true),
        { event: "session_started" },
        { fetchImpl },
      );

      await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    } finally {
      clear.mockRestore();
    }
  });

  it("keeps its abort deadline armed until an unused response body settles", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let resolveBodyCleanup!: () => void;
    const bodyCleanup = new Promise<void>((resolve) => {
      resolveBodyCleanup = resolve;
    });
    const bodyCancel = vi.fn(() => bodyCleanup);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => bodyCancel(),
      }),
    );
    let resolveHeaders!: (value: Response) => void;
    const headers = new Promise<Response>((resolve) => {
      resolveHeaders = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(() => headers);

    try {
      captureTelemetry(
        createTelemetrySession(true),
        { event: "session_started" },
        { fetchImpl },
      );

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);

      // Fetch has resolved its headers, but cancelling the unused body remains
      // pending. The timeout must stay armed through that cleanup.
      resolveHeaders(response);
      await Promise.resolve();
      expect(bodyCancel).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      resolveBodyCleanup();
      await vi.waitFor(() => expect(clearTimeoutSpy).toHaveBeenCalledOnce());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resolveBodyCleanup();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it.each([
    // The product switch points at telemetry, so every common spelling of
    // "false" turns it off.
    [TELEMETRY_ENV, "0"],
    [TELEMETRY_ENV, "0 "],
    [TELEMETRY_ENV, "false"],
    [TELEMETRY_ENV, "FALSE"],
    [TELEMETRY_ENV, "off"],
    [TELEMETRY_ENV, "no"],
    // The opt-out switches point the other way and fail closed: only `0` and
    // `false` cancel the request, so `off`/`no` still opt out.
    ["DO_NOT_TRACK", "1"],
    ["DO_NOT_TRACK", "off"],
    ["DO_NOT_TRACK", "no"],
    ["DO_NOT_TRACK", "NO"],
    ["PI_OFFLINE", "true"],
    ["PI_OFFLINE", "off"],
    ["PI_OFFLINE", "no"],
    // Environment probes.
    ["CI", "1"],
    ["VITEST", "1"],
    ["NODE_ENV", "test"],
  ])("honors the %s=%s opt-out", (name, value) => {
    clearTelemetryOptOuts();
    process.env[name] = value;
    const pi = { getFlag: vi.fn(() => true) };
    expect(isTelemetryEnabled(pi as any)).toBe(false);
  });

  it.each([
    // A probe that says "not this environment" is permissive: `off` and `no`
    // read as false because guessing wrong only costs an event.
    ["CI", "false"],
    ["CI", "0"],
    ["CI", "OFF"],
    ["CI", "no"],
    ["VITEST", "false"],
    ["VITEST", "off"],
    // Cancelling an opt-out request must be unambiguous.
    ["DO_NOT_TRACK", "0"],
    ["DO_NOT_TRACK", "false"],
    ["DO_NOT_TRACK", "FALSE"],
    ["DO_NOT_TRACK", ""],
    ["PI_OFFLINE", "0"],
    ["PI_OFFLINE", "false"],
    ["PI_OFFLINE", "  "],
    ["PI_OFFLINE", ""],
    ["NODE_ENV", "production"],
    [TELEMETRY_ENV, "1"],
  ])("leaves telemetry enabled for %s=%s", (name, value) => {
    clearTelemetryOptOuts();
    process.env[name] = value;
    expect(isTelemetryEnabled({ getFlag: vi.fn(() => undefined) } as any)).toBe(
      true,
    );
  });

  it("disables telemetry when the global persisted setting is false", () => {
    clearTelemetryOptOuts();
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );

    expect(
      isTelemetryEnabled(
        {
          getFlag: vi.fn((name) =>
            name === TELEMETRY_FLAG ? true : undefined,
          ),
        } as unknown as Parameters<typeof isTelemetryEnabled>[0],
        telemetryStorageOptions,
      ),
    ).toBe(false);
  });

  it("lets a project-local false override a global true", () => {
    clearTelemetryOptOuts();
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "true" } }),
    );
    writeFileSync(
      join(telemetryStorageOptions.cwd, ".pi", "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );

    const pi = {
      getFlag: vi.fn(() => undefined),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];
    expect(isTelemetryEnabled(pi, telemetryStorageOptions)).toBe(false);
  });

  it("lets a project-local true override a global false", () => {
    clearTelemetryOptOuts();
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );
    writeFileSync(
      join(telemetryStorageOptions.cwd, ".pi", "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "true" } }),
    );

    const pi = {
      getFlag: vi.fn(() => undefined),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];
    expect(isTelemetryEnabled(pi, telemetryStorageOptions)).toBe(true);
  });

  it("falls back to the global value when the project-local setting is missing", () => {
    clearTelemetryOptOuts();
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );

    const pi = {
      getFlag: vi.fn(() => undefined),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];
    expect(isTelemetryEnabled(pi, telemetryStorageOptions)).toBe(false);
  });

  it("reads only the global value without an authoritative cwd", () => {
    clearTelemetryOptOuts();
    const ambientCwd = join(telemetrySettingsRoot!, "ambient");
    mkdirSync(join(ambientCwd, ".pi"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(ambientCwd);
    writeFileSync(
      join(ambientCwd, ".pi", "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "true" } }),
    );
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );

    const pi = {
      getFlag: vi.fn(() => undefined),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];
    expect(
      isTelemetryEnabled(pi, {
        agentDir: telemetryStorageOptions.agentDir,
      }),
    ).toBe(false);
  });

  const malformedTelemetryDocuments = [
    [
      "an invalid value",
      JSON.stringify({ "pi-subagentura": { telemetry: "sometimes" } }),
    ],
    ["a malformed settings document", "null"],
    ["syntactically invalid JSON", '{"pi-subagentura":'],
    ["an array document", "[]"],
    ["a numeric document", "0"],
    ["a string document", '"bad"'],
    ["a null extension object", '{"pi-subagentura":null}'],
  ] as const;

  it.each(
    (["local", "global"] as const).flatMap((scope) =>
      malformedTelemetryDocuments.map(
        ([label, settingsDocument]) =>
          [scope, label, settingsDocument] as const,
      ),
    ),
  )(
    "reports malformed telemetry in the %s settings file (%s)",
    (scope, _label, settingsDocument) => {
      clearTelemetryOptOuts();
      const path =
        scope === "local"
          ? join(telemetryStorageOptions.cwd, ".pi", "settings-extensions.json")
          : join(telemetryStorageOptions.agentDir, "settings-extensions.json");
      writeFileSync(path, settingsDocument);
      const onInvalid = vi.fn();
      const pi = {
        getFlag: vi.fn(() => undefined),
      } as unknown as Parameters<typeof isTelemetryEnabled>[0];
      const storageOptions =
        scope === "local"
          ? telemetryStorageOptions
          : { agentDir: telemetryStorageOptions.agentDir };

      expect(isTelemetryEnabled(pi, storageOptions, onInvalid)).toBe(true);
      expect(onInvalid).toHaveBeenCalledWith(
        expect.stringContaining("telemetry"),
      );
    },
  );

  it("ignores an invalid local candidate and falls back to the global value", () => {
    clearTelemetryOptOuts();
    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "false" } }),
    );
    writeFileSync(
      join(telemetryStorageOptions.cwd, ".pi", "settings-extensions.json"),
      JSON.stringify({
        "pi-subagentura": { telemetry: "secret-telemetry-value" },
      }),
    );
    const onInvalid = vi.fn();
    const pi = {
      getFlag: vi.fn(() => undefined),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];

    expect(isTelemetryEnabled(pi, telemetryStorageOptions, onInvalid)).toBe(
      false,
    );
    expect(onInvalid).toHaveBeenCalledWith(
      expect.stringContaining("telemetry"),
    );
    expect(JSON.stringify(onInvalid.mock.calls)).not.toContain(
      "secret-telemetry-value",
    );
  });

  it.each(["local", "global"] as const)(
    "reports an unreadable %s settings file without aborting",
    (scope) => {
      clearTelemetryOptOuts();
      const path =
        scope === "local"
          ? join(telemetryStorageOptions.cwd, ".pi", "settings-extensions.json")
          : join(telemetryStorageOptions.agentDir, "settings-extensions.json");
      writeFileSync(path, JSON.stringify({ "pi-subagentura": {} }));
      chmodSync(path, 0o000);
      try {
        const onInvalid = vi.fn();
        const pi = {
          getFlag: vi.fn(() => undefined),
        } as unknown as Parameters<typeof isTelemetryEnabled>[0];
        const storageOptions =
          scope === "local"
            ? telemetryStorageOptions
            : { agentDir: telemetryStorageOptions.agentDir };

        expect(isTelemetryEnabled(pi, storageOptions, onInvalid)).toBe(true);
        expect(onInvalid).toHaveBeenCalledWith(
          expect.stringContaining("could not be read"),
        );
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("keeps telemetry enabled when the persisted setting is missing or true", () => {
    clearTelemetryOptOuts();
    const pi = { getFlag: vi.fn(() => undefined) };
    expect(isTelemetryEnabled(pi as any, telemetryStorageOptions)).toBe(true);

    writeFileSync(
      join(telemetryStorageOptions.agentDir, "settings-extensions.json"),
      JSON.stringify({ "pi-subagentura": { telemetry: "true" } }),
    );
    expect(isTelemetryEnabled(pi as any, telemetryStorageOptions)).toBe(true);
  });

  it("supports the default-on flag and explicit CLI opt-out", () => {
    clearTelemetryOptOuts();
    expect(isTelemetryEnabled({ getFlag: vi.fn(() => undefined) } as any)).toBe(
      true,
    );
    expect(
      isTelemetryEnabled({
        getFlag: vi.fn((name) => (name === TELEMETRY_FLAG ? false : undefined)),
      } as any),
    ).toBe(false);
    const optedOutPi = {
      getFlag: vi.fn((name) =>
        name === TELEMETRY_FLAG || name === TELEMETRY_OPT_OUT_FLAG
          ? true
          : undefined,
      ),
    } as unknown as Parameters<typeof isTelemetryEnabled>[0];
    expect(isTelemetryEnabled(optedOutPi)).toBe(false);
  });
});
