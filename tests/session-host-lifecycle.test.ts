import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTelemetrySessionHost } from "../src/session-host";
import { registerSessionHandlers } from "../src/session-handlers";
import { clearSessionScopes } from "../src/session-scope";

vi.mock("../src/session-host", () => ({
  resolveTelemetrySessionHost: vi.fn(() => "unknown"),
}));

let root: string;
let captured: any[];
const registrations: Map<string, Function>[] = [];

function registration(enabled = true, allowRoot = true) {
  const handlers = new Map<string, Function>();
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: vi.fn(),
    getFlag: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  const scope = registerSessionHandlers(
    pi as any,
    undefined,
    allowRoot,
    () => enabled,
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
  vi.mocked(resolveTelemetrySessionHost).mockReturnValue("unknown");
  root = mkdtempSync(join(tmpdir(), "session-host-"));
  captured = [];
  vi.stubEnv("PI_SUBAGENTURA_TELEMETRY_ORIGIN", "development");
  vi.stubEnv("PI_SUBAGENTURA_CHILD", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      captured.push(JSON.parse(String(options?.body)));
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

describe("session host capture lifecycle", () => {
  it("classifies once for a fresh root, suppressing reload/resume and keeping identifiers local", () => {
    vi.mocked(resolveTelemetrySessionHost).mockReturnValue("orca");
    const { start } = registration();
    start();
    start("reload");
    start("resume");
    expect(resolveTelemetrySessionHost).toHaveBeenCalledOnce();
    const starts = captured.filter(
      (p) => p.event === "pi_subagentura_session_started",
    );
    expect(starts).toHaveLength(1);
    expect(starts[0].properties.session_host).toBe("orca");
    expect(starts[0].properties).not.toHaveProperty("mux");
    expect(JSON.stringify(captured)).not.toContain("private-pi-id");
    expect(JSON.stringify(captured)).not.toContain(root);
  });

  it("keeps unknown session capture synchronous without any probe", () => {
    registration().start();
    expect(captured[0].properties.session_host).toBe("unknown");
  });

  it.each([
    "explicit child",
    "environment child",
    "telemetry off",
    "test origin",
  ])("does not classify or submit a root start for %s", (kind) => {
    if (kind === "environment child") vi.stubEnv("PI_SUBAGENTURA_CHILD", "1");
    if (kind === "test origin")
      vi.stubEnv("PI_SUBAGENTURA_TELEMETRY_ORIGIN", "test");
    registration(kind !== "telemetry off", kind !== "explicit child").start();
    expect(resolveTelemetrySessionHost).not.toHaveBeenCalled();
    expect(
      captured.filter((p) => p.event === "pi_subagentura_session_started"),
    ).toHaveLength(0);
    if (kind === "telemetry off" || kind === "test origin")
      expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["startup", "reload", "resume"])(
    "does not reclassify a persisted logical session on %s",
    (reason) => {
      registration().start();
      vi.mocked(resolveTelemetrySessionHost).mockClear();
      captured.length = 0;
      registration().start(reason);
      expect(resolveTelemetrySessionHost).not.toHaveBeenCalled();
      expect(
        captured.some((p) => p.event === "pi_subagentura_session_started"),
      ).toBe(false);
    },
  );

  it.each(["new", "fork"])("classifies a fresh %s logical root", (reason) => {
    const { start, scope } = registration();
    start();
    const previousId = scope.telemetry?.correlationId;
    start(reason);
    expect(resolveTelemetrySessionHost).toHaveBeenCalledTimes(2);
    expect(scope.telemetry?.correlationId).not.toBe(previousId);
    expect(
      captured.filter((p) => p.event === "pi_subagentura_session_started"),
    ).toHaveLength(2);
  });
});
