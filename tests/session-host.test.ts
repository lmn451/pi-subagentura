import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { detectEnvironment } from "../src/environment";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const launchEnv = {
  ORCA_RUNTIME_SOURCE_ID: "private-source",
  ORCA_RUNTIME_SOURCE_INCARNATION: "private-incarnation",
  ORCA_RUNTIME_SOURCE_PROFILE_PATH: "/private/profile",
};

const rexEnv = {
  REX_SESSION: "private-session",
  REX_BLOCK: "private-block",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("environment snapshot", () => {
  it("recognizes the complete Orca origin without terminal metadata", () => {
    const snapshot = detectEnvironment(launchEnv, "darwin");
    expect(snapshot.guidanceHost).toBe("orca");
    expect(snapshot.telemetryHost).toBe("orca");
  });

  it("does not execute commands, probe a runtime, or make network requests", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(detectEnvironment(launchEnv, "darwin").guidanceHost).toBe("orca");
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("recognizes Agterm only from its exact enabled marker", () => {
    const snapshot = detectEnvironment({ AGTERM_ENABLED: "1" }, "darwin");
    expect(snapshot.guidanceHost).toBe("agterm");
    expect(snapshot.telemetryHost).toBe("agterm");
    expect(
      detectEnvironment({ TERM_PROGRAM: "agterm" }, "darwin").guidanceHost,
    ).toBe("unknown");
  });

  it.each([
    ["tmux", { TMUX: "/tmp/tmux/default,1,0", TERM_PROGRAM: "tmux" }],
    ["zellij", { ZELLIJ_SESSION_NAME: "outer-zellij", TERM_PROGRAM: "zellij" }],
  ])(
    "keeps Agterm evidence independent of inherited %s context",
    (_mux, muxEnv) => {
      const snapshot = detectEnvironment(
        {
          AGTERM_ENABLED: "1",
          AGTERM_SESSION_ID: "stale-session",
          AGTERM_PANE_ID: "stale-pane",
          ...muxEnv,
        },
        "darwin",
      );
      expect(snapshot.guidanceHost).toBe("agterm");
      expect(snapshot.telemetryHost).toBe("agterm");
    },
  );

  it.each([undefined, "", "0", "true", " 1 ", "1\n"])(
    "fails closed for non-exact Agterm marker %j",
    (value) => {
      const snapshot = detectEnvironment({ AGTERM_ENABLED: value }, "darwin");
      expect(snapshot.guidanceHost).toBe("unknown");
      expect(snapshot.telemetryHost).toBe("unknown");
    },
  );

  it("keeps the legacy telemetry projection independent of valid Rex hints", () => {
    const snapshot = detectEnvironment(rexEnv, "darwin");
    expect(snapshot.guidanceHost).toBe("rex");
    expect(snapshot.telemetryHost).toBe("unknown");
  });

  it("returns unknown guidance for recognized conflicts while preserving telemetry", () => {
    const orcaAndRex = detectEnvironment({ ...launchEnv, ...rexEnv }, "darwin");
    expect(orcaAndRex.guidanceHost).toBe("unknown");
    expect(orcaAndRex.telemetryHost).toBe("orca");

    const agtermAndRex = detectEnvironment(
      { AGTERM_ENABLED: "1", ...rexEnv },
      "darwin",
    );
    expect(agtermAndRex.guidanceHost).toBe("unknown");
    expect(agtermAndRex.telemetryHost).toBe("agterm");

    const allHosts = detectEnvironment(
      { ...launchEnv, AGTERM_ENABLED: "1", ...rexEnv },
      "darwin",
    );
    expect(allHosts.guidanceHost).toBe("unknown");
    expect(allHosts.telemetryHost).toBe("unknown");
  });

  it("returns unknown telemetry when valid Orca and Agterm markers conflict", () => {
    const snapshot = detectEnvironment(
      { ...launchEnv, AGTERM_ENABLED: "1" },
      "darwin",
    );
    expect(snapshot.guidanceHost).toBe("unknown");
    expect(snapshot.telemetryHost).toBe("unknown");
  });

  it.each([
    {},
    { TMUX: "/tmp/tmux/default,1,0", ZELLIJ_SESSION_NAME: "nested" },
    { ORCA_AGENT_PANE: "private-pane" },
    { ORCA_TERMINAL_HANDLE: "private-handle", ORCA_PANE_KEY: "private-pane" },
    { ORCA_PI_STATUS_OWNED: "1" },
    { ORCA_CLI_COMMAND: "orca" },
    {
      ORCA_DEV_REPO_ROOT: "/private/dev",
      ORCA_WORKTREE_ID: "private-worktree",
    },
  ])(
    "does not infer host from installed tools, paths, or loose markers: %j",
    (env) => {
      const snapshot = detectEnvironment(env, "darwin");
      expect(snapshot.guidanceHost).toBe("unknown");
      expect(snapshot.telemetryHost).toBe("unknown");
    },
  );

  it.each(Object.keys(launchEnv))(
    "requires every Orca launch-stamp field: %s",
    (key) => {
      const env: NodeJS.ProcessEnv = { ...launchEnv };
      delete env[key];
      const snapshot = detectEnvironment(env, "darwin");
      expect(snapshot.guidanceHost).toBe("unknown");
      expect(snapshot.telemetryHost).toBe("unknown");
    },
  );

  it.each(Object.keys(launchEnv))(
    "rejects malformed or oversized Orca %s",
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
        const snapshot = detectEnvironment(
          { ...launchEnv, [key]: value } as NodeJS.ProcessEnv,
          "darwin",
        );
        expect(snapshot.guidanceHost).toBe("unknown");
        expect(snapshot.telemetryHost).toBe("unknown");
      }
    },
  );

  it.each(Object.keys(launchEnv))(
    "rejects raw control characters around %s",
    (key) => {
      const value = launchEnv[key as keyof typeof launchEnv];
      for (const wrapped of [`\n${value}`, `${value}\n`, `\t${value}\t`]) {
        expect(
          detectEnvironment({ ...launchEnv, [key]: wrapped }, "darwin")
            .guidanceHost,
        ).toBe("unknown");
      }
    },
  );

  it("matches the bundled stamp reader whitespace normalization and bound", () => {
    const env = Object.fromEntries(
      Object.entries(launchEnv).map(([key, value]) => [key, `  ${value}  `]),
    );
    expect(detectEnvironment(env, "darwin").telemetryHost).toBe("orca");
    expect(
      detectEnvironment(
        { ...launchEnv, ORCA_RUNTIME_SOURCE_ID: "x".repeat(4096) },
        "darwin",
      ).guidanceHost,
    ).toBe("orca");
  });

  it.each(["profile", "../private/profile", "~/private/profile"])(
    "rejects relative profile paths: %s",
    (profile) => {
      expect(
        detectEnvironment(
          { ...launchEnv, ORCA_RUNTIME_SOURCE_PROFILE_PATH: profile },
          "darwin",
        ).guidanceHost,
      ).toBe("unknown");
    },
  );

  it.each(["darwin", "linux"] as const)(
    "uses absolute POSIX profile paths on %s without invoking Orca",
    (platform) => {
      expect(detectEnvironment(launchEnv, platform).guidanceHost).toBe("orca");
      expect(
        detectEnvironment(
          {
            ...launchEnv,
            ORCA_RUNTIME_SOURCE_PROFILE_PATH: "C:\\private\\profile",
          },
          platform,
        ).guidanceHost,
      ).toBe("unknown");
    },
  );

  it.each(["C:\\private\\profile", "\\\\host\\share\\profile"])(
    "accepts an absolute Windows launch profile: %s",
    (profile) => {
      expect(
        detectEnvironment(
          { ...launchEnv, ORCA_RUNTIME_SOURCE_PROFILE_PATH: profile },
          "win32",
        ).guidanceHost,
      ).toBe("orca");
    },
  );

  it.each([
    [{ REX_SESSION: "session", REX_BLOCK: "block" }, "rex"],
    [{ REX_SESSION: "session" }, "unknown"],
    [{ REX_BLOCK: "block" }, "unknown"],
    [{ REX_SESSION: " ", REX_BLOCK: "block" }, "unknown"],
    [{ REX_SESSION: "x".repeat(4097), REX_BLOCK: "block" }, "unknown"],
    [{ REX_SESSION: "bad\nvalue", REX_BLOCK: "block" }, "unknown"],
  ] as const)(
    "recognizes only complete valid Rex location hints %#",
    (env, expected) => {
      expect(detectEnvironment(env, "darwin").guidanceHost).toBe(expected);
    },
  );

  it("normalizes terminal labels through the telemetry allowlist", () => {
    expect(detectEnvironment({ TERM_PROGRAM: "WezTerm" }).terminalProgram).toBe(
      "wezterm",
    );
    expect(
      detectEnvironment({ TERM_PROGRAM: "iTerm.app" }).terminalProgram,
    ).toBe("iterm2");
    expect(
      detectEnvironment({ TERM_PROGRAM: "private-terminal" }).terminalProgram,
    ).toBe("unknown");
  });

  it("retains only an immutable, closed snapshot across later environment changes", () => {
    const env: NodeJS.ProcessEnv = {
      ...launchEnv,
      REX_SESSION: "private-session",
      REX_BLOCK: "private-block",
      TMUX: "/private/tmux/socket",
      TERM_PROGRAM: "WezTerm",
    };
    const snapshot = detectEnvironment(env, "darwin");
    env.ORCA_RUNTIME_SOURCE_ID = "changed";
    env.ORCA_RUNTIME_SOURCE_INCARNATION = "changed";
    env.ORCA_RUNTIME_SOURCE_PROFILE_PATH = "/changed";
    env.REX_SESSION = undefined;
    env.REX_BLOCK = undefined;
    env.TMUX = undefined;
    env.TERM_PROGRAM = "changed";

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({
      guidanceHost: "unknown",
      telemetryHost: "orca",
      terminalProgram: "wezterm",
      parentMux: "tmux",
      hasTmuxHint: true,
      hasZellijHint: false,
      hasHerdrHint: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private-source|private-session|private-block|private\/|socket/,
    );
  });

  it("treats inherited origin as provenance rather than live authority", () => {
    const inherited = {
      ...launchEnv,
      ORCA_TERMINAL_HANDLE: "stale",
      ORCA_PANE_KEY: "mismatched",
      ORCA_ENVIRONMENT: "remote",
      ORCA_CLI_COMMAND: "/private/arbitrary",
    };
    expect(detectEnvironment(inherited, "darwin").guidanceHost).toBe("orca");
  });
});
