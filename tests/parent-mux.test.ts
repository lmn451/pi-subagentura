import { describe, expect, it } from "vitest";
import {
  buildTelemetryPayload,
  createTelemetrySession,
  resolveTelemetryParentMux,
  type TelemetryEvent,
} from "../src/telemetry";

describe("parent multiplexer environment observation", () => {
  it.each([
    [{}, "unknown"],
    [{ TMUX: "/private/socket,123,0" }, "tmux"],
    [{ ZELLIJ_SESSION_NAME: "private-session" }, "zellij"],
    [{ HERDR_ENV: "1" }, "herdr"],
    [
      {
        REX_SESSION: "session:01234567-89ab-cdef-0123-456789abcdef",
        REX_BLOCK: "block:01234567-89ab-cdef-0123-456789abcdef",
        REX_SERVER: "unix:///tmp/rex.sock",
      },
      "rex",
    ],
    [
      {
        REX_SESSION: "session:01234567-89ab-cdef-0123-456789abcdef",
        REX_BLOCK: "block:01234567-89ab-cdef-0123-456789abcdef",
      },
      "unknown",
    ],
    [{ HERDR_ENV: "0" }, "unknown"],
    [{ HERDR_SOCKET_PATH: "/private/socket" }, "unknown"],
    [{ TMUX: "" }, "unknown"],
    [{ TMUX: "   " }, "unknown"],
    [{ TMUX: "bad\nvalue" }, "unknown"],
    [{ ZELLIJ_SESSION_NAME: "x".repeat(4097) }, "unknown"],
    [{ TMUX: "socket", ZELLIJ_SESSION_NAME: "name" }, "unknown"],
    [{ TMUX: "socket", HERDR_ENV: "1" }, "unknown"],
    [
      {
        TMUX: "socket",
        REX_SESSION: "session:01234567-89ab-cdef-0123-456789abcdef",
        REX_BLOCK: "block:01234567-89ab-cdef-0123-456789abcdef",
        REX_SERVER: "unix:///tmp/rex.sock",
      },
      "unknown",
    ],
    [{ ZELLIJ_SESSION_NAME: "name", HERDR_ENV: "1" }, "unknown"],
    [
      { TMUX: "socket", ZELLIJ_SESSION_NAME: "name", HERDR_ENV: "1" },
      "unknown",
    ],
  ] as const)("classifies case %# as %s", (env, expected) => {
    const input = Object.freeze({ ...env });
    expect(resolveTelemetryParentMux(input)).toBe(expected);
  });
  it("only emits closed labels on root starts", () => {
    const session = createTelemetrySession(true);
    const event = {
      event: "session_started",
      parent_mux: "/private/socket",
    } as unknown as TelemetryEvent;
    const payload = buildTelemetryPayload(session, event);
    expect(payload.properties.parent_mux).toBe("unknown");
    expect(JSON.stringify(payload)).not.toContain("/private/socket");
    expect(
      buildTelemetryPayload(session, { event: "session_started" }).properties
        .parent_mux,
    ).toBe("unknown");
    expect(
      buildTelemetryPayload(session, {
        event: "session_setup_failed",
        failure_stage: "state_recovery",
      }).properties,
    ).not.toHaveProperty("parent_mux");
  });
});
