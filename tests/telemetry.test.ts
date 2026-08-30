import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelemetryPayload,
  captureTelemetry,
  createTelemetrySession,
  MAX_TELEMETRY_DEDUPE_KEYS,
  resolveTelemetryMode,
  retireTelemetrySession,
  sanitizeTelemetryModel,
  TELEMETRY_ENDPOINT,
  telemetryDepth,
  telemetryDepthBucket,
  telemetryDurationMs,
  telemetryDurationBucket,
} from "../src/telemetry";
import {
  isTelemetryEnabled,
  TELEMETRY_ENV,
  TELEMETRY_FLAG,
} from "../src/settings";

const originalEnvironment = {
  CI: process.env.CI,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  NODE_ENV: process.env.NODE_ENV,
  PI_OFFLINE: process.env.PI_OFFLINE,
  TELEMETRY: process.env[TELEMETRY_ENV],
  VITEST: process.env.VITEST,
};

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries({
    CI: originalEnvironment.CI,
    DO_NOT_TRACK: originalEnvironment.DO_NOT_TRACK,
    NODE_ENV: originalEnvironment.NODE_ENV,
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

describe("anonymous product telemetry", () => {
  afterEach(() => {
    restoreEnvironment();
    vi.restoreAllMocks();
  });

  it("reuses one random personless correlation id within a session", () => {
    const session = createTelemetrySession(true, "orchestrator_v2");
    const started = buildTelemetryPayload(session, {
      event: "session_started",
    });
    const agent = buildTelemetryPayload(session, {
      event: "task_started",
      execution: "in-process",
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
      schema_version: 2,
      mode: "orchestrator_v2",
    });
    expect(agent.properties).toMatchObject({
      execution: "in-process",
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

  it("distinguishes one created agent from its delegated tasks", () => {
    const session = createTelemetrySession(true, "straight");
    const created = buildTelemetryPayload(session, {
      event: "agent_created",
      execution: "interactive",
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
      unit: "turn",
      invocation_source: "interactive",
      model: "default",
      async: true,
      depth: 1,
      depth_bucket: "1",
      completion_policy: "each",
      status: "success",
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
        "invocation_source",
        "model",
        "mode",
        "schema_version",
        "status",
        "telemetry_session_id",
        "unit",
      ].sort(),
    );
    expect(completed.properties.child_conversation_message_count).toBe(1_000);
    expect(completed.properties.duration_ms).toBe(12_300);
    expect(JSON.stringify(completed)).not.toMatch(
      /task_text|persona|prompt|output|error_text|cwd|path|artifact_id|agent_id|raw_session_id|token|cost/i,
    );
  });

  it("posts best-effort events once per internal dedupe key", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const session = createTelemetrySession(true);
    const event = { event: "result_consumed", source: "workflow" } as const;

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
      event: "pi_subagentura_result_consumed",
      distinct_id: session.correlationId,
      properties: { source: "workflow" },
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
      { event: "result_consumed", source: "interactive" },
      { dedupeKey: "overflow", fetchImpl },
    );
    captureTelemetry(
      session,
      { event: "result_consumed", source: "interactive" },
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
        unit: "job",
        invocation_source: "isolated",
        model: "default",
        async: true,
        depth: 1,
        depth_bucket: "1",
        completion_policy: "each",
        status: "cancelled",
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
    [TELEMETRY_ENV, "0"],
    ["DO_NOT_TRACK", "1"],
    ["PI_OFFLINE", "true"],
    ["CI", "1"],
    ["VITEST", "1"],
    ["NODE_ENV", "test"],
  ])("honors the %s opt-out", (name, value) => {
    clearTelemetryOptOuts();
    process.env[name] = value;
    const pi = { getFlag: vi.fn(() => true) };
    expect(isTelemetryEnabled(pi as any)).toBe(false);
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
  });
});
