import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { resolveTelemetrySessionHost } from "../src/session-host";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const launchEnv = {
  ORCA_RUNTIME_SOURCE_ID: "private-source",
  ORCA_RUNTIME_SOURCE_INCARNATION: "private-incarnation",
  ORCA_RUNTIME_SOURCE_PROFILE_PATH: "/private/profile",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Orca launch-origin session attribution", () => {
  it("recognizes the complete verified launch-origin stamp without terminal metadata", () => {
    expect(resolveTelemetrySessionHost(launchEnv, "darwin")).toBe("orca");
  });

  it("never executes commands, probes a runtime, or makes a network request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(resolveTelemetrySessionHost(launchEnv, "darwin")).toBe("orca");
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ORCA_AGENT_PANE: "private-pane" },
    { ORCA_TERMINAL_HANDLE: "private-handle", ORCA_PANE_KEY: "private-pane" },
    { ORCA_PI_STATUS_OWNED: "1" },
    { ORCA_CLI_COMMAND: "orca" },
    {
      ORCA_DEV_REPO_ROOT: "/private/dev",
      ORCA_WORKTREE_ID: "private-worktree",
    },
  ])(
    "does not infer origin from installed tools, paths, or loose markers: %j",
    (env) => {
      expect(resolveTelemetrySessionHost(env, "darwin")).toBe("unknown");
    },
  );

  it.each(Object.keys(launchEnv))(
    "requires every launch-stamp field: %s",
    (key) => {
      const env: NodeJS.ProcessEnv = { ...launchEnv };
      delete env[key];
      expect(resolveTelemetrySessionHost(env, "darwin")).toBe("unknown");
    },
  );

  it.each(Object.keys(launchEnv))(
    "rejects malformed or oversized %s",
    (key) => {
      for (const value of [
        undefined,
        "",
        "   ",
        "x".repeat(4097),
        "private\u0000value",
        "private\nvalue",
        1,
      ]) {
        const env = { ...launchEnv, [key]: value } as NodeJS.ProcessEnv;
        expect(resolveTelemetrySessionHost(env, "darwin")).toBe("unknown");
      }
    },
  );

  it.each(Object.entries(launchEnv))(
    "rejects raw control characters around %s",
    (key, value) => {
      for (const wrapped of [`\n${value}`, `${value}\n`, `\t${value}\t`]) {
        expect(
          resolveTelemetrySessionHost(
            { ...launchEnv, [key]: wrapped },
            "darwin",
          ),
        ).toBe("unknown");
      }
    },
  );

  it("matches the bundled stamp reader's whitespace normalization and bound", () => {
    const env = Object.fromEntries(
      Object.entries(launchEnv).map(([key, value]) => [key, `  ${value}  `]),
    );
    expect(resolveTelemetrySessionHost(env, "darwin")).toBe("orca");
    expect(
      resolveTelemetrySessionHost(
        { ...launchEnv, ORCA_RUNTIME_SOURCE_ID: "x".repeat(4096) },
        "darwin",
      ),
    ).toBe("orca");
  });

  it.each(["profile", "../private/profile", "~/private/profile"])(
    "rejects relative profile paths: %s",
    (profile) => {
      expect(
        resolveTelemetrySessionHost(
          { ...launchEnv, ORCA_RUNTIME_SOURCE_PROFILE_PATH: profile },
          "darwin",
        ),
      ).toBe("unknown");
    },
  );

  it.each(["darwin", "linux"] as const)(
    "uses absolute POSIX profile paths on %s without invoking orca",
    (platform) => {
      expect(resolveTelemetrySessionHost(launchEnv, platform)).toBe("orca");
      expect(
        resolveTelemetrySessionHost(
          {
            ...launchEnv,
            ORCA_RUNTIME_SOURCE_PROFILE_PATH: "C:\\private\\profile",
          },
          platform,
        ),
      ).toBe("unknown");
    },
  );

  it.each(["C:\\private\\profile", "\\\\host\\share\\profile"])(
    "accepts an absolute Windows launch profile: %s",
    (profile) => {
      expect(
        resolveTelemetrySessionHost(
          { ...launchEnv, ORCA_RUNTIME_SOURCE_PROFILE_PATH: profile },
          "win32",
        ),
      ).toBe("orca");
    },
  );

  it("treats inherited valid origin as provenance, never live-process authority", () => {
    const inherited = {
      ...launchEnv,
      ORCA_TERMINAL_HANDLE: "stale",
      ORCA_PANE_KEY: "mismatched",
      ORCA_ENVIRONMENT: "remote",
      ORCA_CLI_COMMAND: "/private/arbitrary",
    };
    expect(resolveTelemetrySessionHost(inherited, "darwin")).toBe("orca");
  });

  it("returns only closed labels and does not mutate, persist, or expose the stamp", () => {
    const env = Object.freeze({ ...launchEnv });
    expect(resolveTelemetrySessionHost(env, "darwin")).toBe("orca");
    expect(Object.keys(env)).toEqual(Object.keys(launchEnv));
    expect(
      JSON.stringify(resolveTelemetrySessionHost(env, "darwin")),
    ).not.toContain("private");
  });
});
