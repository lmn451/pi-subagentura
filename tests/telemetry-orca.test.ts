import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTelemetryPayload,
  captureTelemetry,
  createTelemetrySession,
  sanitizeTelemetryRequestedMux,
  sanitizeTelemetryRuntimeFailureMux,
  sanitizeTelemetrySpawnFailureMux,
  telemetryOperationName,
  type TelemetryEvent,
  type TelemetryMux,
} from "../src/telemetry";

const childMuxes: readonly TelemetryMux[] = ["none", "tmux", "zellij", "herdr"];

function lifecycleEvents(mux: TelemetryMux): TelemetryEvent[] {
  const dimensions = {
    execution:
      mux === "none" ? ("in-process" as const) : ("interactive" as const),
    mux,
    invocation_source: "workflow" as const,
    model: "default",
    async: true,
    depth: 1,
    depth_bucket: "1" as const,
    completion_policy: "each" as const,
  };
  const unit = mux === "none" ? "job" : "turn";
  return [
    { event: "agent_created", ...dimensions },
    { event: "task_started", ...dimensions, unit },
    {
      event: "task_completed",
      ...dimensions,
      unit,
      status: "success",
      terminal_reason: "completed",
      duration_ms: 100,
      child_conversation_message_count: undefined,
    },
    {
      event: "agent_launch_resolved",
      ...dimensions,
      outcome: "started",
      requested_execution: dimensions.execution,
      requested_mux: mux === "none" ? "none" : "auto",
      fallback_attempted: false,
    },
  ];
}

function stubOrcaHost(present = true): void {
  for (const [name, value] of Object.entries({
    ORCA_AGENT_PANE: "1",
    ORCA_TERMINAL_HANDLE: "private-terminal-handle",
    ORCA_WORKTREE_ID: "private-worktree-id",
    ORCA_APP_VERSION: "private-host-version",
  })) {
    vi.stubEnv(name, present ? value : undefined);
  }
}

describe("Orca prompt-only telemetry attribution boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(childMuxes)(
    "keeps the observed %s child backend independent of Orca host markers",
    (mux) => {
      stubOrcaHost(false);
      const session = createTelemetrySession(
        true,
        "orchestrator_v2",
        undefined,
        "development",
      );
      const events = lifecycleEvents(mux);
      const before = events.map((event) =>
        buildTelemetryPayload(session, event),
      );
      stubOrcaHost();
      const hostedSession = createTelemetrySession(
        true,
        "orchestrator_v2",
        session.correlationId,
        "development",
      );
      const after = events.map((event) =>
        buildTelemetryPayload(hostedSession, event),
      );

      expect(after).toEqual(before);
      for (const payload of after) {
        expect(payload.properties.mux).toBe(mux);
        expect(payload.properties.mode).toBe("orchestrator_v2");
        expect(payload.properties).not.toHaveProperty("host");
        expect(payload.properties).not.toHaveProperty("parent_host");
        // Inspect properties only: the transport envelope contains a project token.
        expect(JSON.stringify(payload.properties)).not.toContain("private-");
      }
    },
  );

  it.each(["orca", "unknown", "private-host-id", undefined])(
    "allowlists only session-start host attribution: %s",
    (host) => {
      const session = createTelemetrySession(true);
      const event = {
        event: "session_started",
        session_host: host,
        orcaSessionId: "private-session-id",
        path: "/private/path",
      } as unknown as TelemetryEvent;
      const properties = buildTelemetryPayload(session, event).properties;
      expect(properties.session_host).toBe(
        host === "orca" ? "orca" : "unknown",
      );
      expect(JSON.stringify(properties)).not.toContain("private");
      for (const child of lifecycleEvents("tmux")) {
        expect(
          buildTelemetryPayload(session, {
            ...child,
            session_host: "orca",
          } as TelemetryEvent).properties,
        ).not.toHaveProperty("session_host");
      }
    },
  );

  it("does not turn a session observation into an external CLI agent launch", () => {
    const collector = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    stubOrcaHost();
    const session = createTelemetrySession(
      true,
      "orchestrator_v2",
      undefined,
      "development",
    );
    captureTelemetry(
      session,
      { event: "session_started" },
      { fetchImpl: collector },
    );

    expect(collector).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(collector.mock.calls[0][1]?.body));
    expect(payload.event).toBe("pi_subagentura_session_started");
    expect(payload.properties).not.toHaveProperty("mux");
    expect(telemetryOperationName("tool", "orca")).toBeUndefined();
    expect(telemetryOperationName("tool", "bash")).toBeUndefined();
  });

  it("does not recognize Orca as a currently supported child backend", () => {
    expect(sanitizeTelemetryRequestedMux("orca")).toBeUndefined();
    expect(sanitizeTelemetrySpawnFailureMux("orca")).toBeUndefined();
    expect(sanitizeTelemetryRuntimeFailureMux("orca")).toBeUndefined();
  });
});
