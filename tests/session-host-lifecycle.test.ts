import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeTelemetryTerminalProgram,
  type EnvironmentSnapshot,
} from "../src/environment";
import { registerSessionHandlers } from "../src/session-handlers";
import { clearSessionScopes } from "../src/session-scope";
import {
  buildTelemetryPayload,
  createTelemetrySession,
  TelemetryEvent,
} from "../src/telemetry";

type CapturedTelemetryPayload = {
  event: string;
  properties: Record<string, unknown>;
};

let root: string;
let captured: CapturedTelemetryPayload[];
const registrations: Map<string, Function>[] = [];

function environmentSnapshot(
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return Object.freeze({
    guidanceHost: "unknown",
    telemetryHost: "unknown",
    terminalProgram: "unknown",
    parentMux: "unknown",
    ...overrides,
  });
}

function registration(
  enabled = true,
  allowRoot = true,
  mode?: "orchestrator" | "orchestratorv2",
  environment = environmentSnapshot(),
) {
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: vi.fn(),
    getFlag: vi.fn((name: string) => name === mode),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  const scope = registerSessionHandlers(
    pi as unknown as ExtensionAPI,
    undefined,
    allowRoot,
    () => enabled,
    environment,
  );
  const ctx = {
    cwd: root,
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: () => "private-pi-id",
      getEntries: () => [],
      getBranch: () => [],
    },
  };
  registrations.push(handlers);
  return {
    handlers,
    scope,
    start: (reason = "new") => handlers.get("session_start")!({ reason }, ctx),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), "session-host-"));
  captured = [];
  vi.stubEnv("PI_SUBAGENTURA_TELEMETRY_ORIGIN", "development");
  vi.stubEnv("PI_SUBAGENTURA_CHILD", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      captured.push(
        JSON.parse(String(options?.body)) as CapturedTelemetryPayload,
      );
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  for (const handlers of registrations.splice(0))
    handlers.get("session_shutdown")?.({ reason: "reload" }, {});
  clearSessionScopes();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("session environment snapshot lifecycle", () => {
  it("uses the captured telemetry projection once and keeps it stable across reloads", () => {
    const environment = environmentSnapshot({
      guidanceHost: "orca",
      telemetryHost: "orca",
      terminalProgram: "agterm",
      parentMux: "tmux",
    });
    const { scope, start } = registration(true, true, undefined, environment);
    vi.stubEnv("AGTERM_ENABLED", "1");
    vi.stubEnv("TERM_PROGRAM", "/private/terminal");
    vi.stubEnv("TMUX", "/private/socket,123,0");
    start();
    start("reload");
    start("resume");

    expect(scope.environment).toBe(environment);
    const starts = captured.filter(
      (payload) => payload.event === "pi_subagentura_session_started",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.properties).toMatchObject({
      session_host: "orca",
      parent_mux: "tmux",
      terminal_program: "agterm",
    });
    expect(JSON.stringify(captured)).not.toContain("private-pi-id");
    expect(JSON.stringify(captured)).not.toContain("/private/socket");
    expect(JSON.stringify(captured)).not.toContain("/private/terminal");
    expect(JSON.stringify(captured)).not.toContain(root);
  });

  it("attributes Agterm in straight mode without orchestration flags", () => {
    registration(
      true,
      true,
      undefined,
      environmentSnapshot({ telemetryHost: "agterm" }),
    ).start();
    const start = captured.find(
      (payload) => payload.event === "pi_subagentura_session_started",
    );

    expect(start?.properties.mode).toBe("straight");
    expect(start?.properties.session_host).toBe("agterm");
  });

  it.each([
    ["straight", "orca", undefined],
    ["straight", "agterm", undefined],
    ["orchestrator", "orca", "orchestrator"],
    ["orchestrator", "agterm", "orchestrator"],
    ["orchestrator_v2", "orca", "orchestratorv2"],
    ["orchestrator_v2", "agterm", "orchestratorv2"],
  ] as const)(
    "captures %s host evidence independently of the orchestration mode",
    (modeName, host, flag) => {
      registration(
        true,
        true,
        flag,
        environmentSnapshot({ telemetryHost: host }),
      ).start();
      const start = captured.find(
        (payload) => payload.event === "pi_subagentura_session_started",
      );

      expect(start?.properties.mode).toBe(modeName);
      expect(start?.properties.session_host).toBe(host);
    },
  );

  it("captures an unknown host as a normal fresh-root event", () => {
    registration().start();
    const starts = captured.filter(
      (payload) => payload.event === "pi_subagentura_session_started",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0]?.properties.session_host).toBe("unknown");
  });

  it.each([
    "explicit child",
    "environment child",
    "telemetry off",
    "test origin",
  ])("does not submit a root start for %s", (kind) => {
    if (kind === "environment child") vi.stubEnv("PI_SUBAGENTURA_CHILD", "1");
    if (kind === "test origin")
      vi.stubEnv("PI_SUBAGENTURA_TELEMETRY_ORIGIN", "test");
    registration(
      kind !== "telemetry off",
      kind !== "explicit child",
      undefined,
      environmentSnapshot({ telemetryHost: "orca" }),
    ).start();
    expect(
      captured.filter(
        (payload) => payload.event === "pi_subagentura_session_started",
      ),
    ).toHaveLength(0);
    if (kind === "telemetry off" || kind === "test origin")
      expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["startup", "reload", "resume"])(
    "does not re-emit a persisted logical session start on %s",
    (reason) => {
      registration().start();
      captured.length = 0;
      registration().start(reason);
      expect(
        captured.some(
          (payload) => payload.event === "pi_subagentura_session_started",
        ),
      ).toBe(false);
    },
  );

  it.each(["new", "fork"])("captures a fresh %s logical root", (reason) => {
    const environment = environmentSnapshot({ telemetryHost: "orca" });
    const { start, scope } = registration(true, true, undefined, environment);
    start();
    const previousId = scope.telemetry?.correlationId;
    start(reason);
    expect(scope.environment).toBe(environment);
    expect(scope.telemetry?.correlationId).not.toBe(previousId);
    expect(
      captured.filter(
        (payload) => payload.event === "pi_subagentura_session_started",
      ),
    ).toHaveLength(2);
  });
});

describe("terminal program capture", () => {
  it("reports the captured terminal independently of Orca launch origin", () => {
    const { start } = registration(
      true,
      true,
      undefined,
      environmentSnapshot({
        telemetryHost: "orca",
        terminalProgram: "agterm",
      }),
    );
    vi.stubEnv("TERM_PROGRAM", "/private/terminal");
    start();
    expect(captured[0]?.properties).toMatchObject({
      session_host: "orca",
      terminal_program: "agterm",
    });
  });
});

describe("terminal program privacy", () => {
  it.each([
    ["agterm", "agterm"],
    ["ghostty", "ghostty"],
    ["iTerm.app", "iterm2"],
    ["Apple_Terminal", "apple_terminal"],
    ["vscode", "vscode"],
    ["WezTerm", "wezterm"],
    ["wezterm", "wezterm"],
    ["kitty", "kitty"],
    [undefined, "unknown"],
    ["", "unknown"],
    ["/private/terminal", "unknown"],
    ["agterm\n", "unknown"],
    ["agterm".repeat(1000), "unknown"],
  ])("maps %s to the closed label %s", (raw, expected) => {
    expect(sanitizeTelemetryTerminalProgram(raw)).toBe(expected);
  });

  it("sanitizes untrusted event values", () => {
    const session = createTelemetrySession(true);
    const event = {
      event: "session_started",
      terminal_program: "/private/raw",
    } as unknown as TelemetryEvent;
    expect(
      buildTelemetryPayload(session, event).properties.terminal_program,
    ).toBe("unknown");
    expect(
      buildTelemetryPayload(session, { event: "session_started" }).properties
        .terminal_program,
    ).toBe("unknown");
  });
});

describe("parent multiplexer capture", () => {
  it("reports the captured parent mux independently of terminal and child backend", () => {
    const { start } = registration(
      true,
      true,
      undefined,
      environmentSnapshot({
        terminalProgram: "agterm",
        parentMux: "tmux",
      }),
    );
    vi.stubEnv("TMUX", "/private/socket,123,0");
    vi.stubEnv("TERM_PROGRAM", "agterm");
    start();
    expect(captured[0]?.properties).toMatchObject({
      parent_mux: "tmux",
      terminal_program: "agterm",
    });
    expect(captured[0]?.properties).not.toHaveProperty("mux");
    expect(JSON.stringify(captured)).not.toContain("/private/socket");
  });
});
