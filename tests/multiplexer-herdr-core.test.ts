import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  artifactPath,
  readEventRecords,
  readOutputForTurnId,
  writeOutput,
} from "../src/artifact";
import { CHILD_ARTIFACT_BOOTSTRAP_ENV } from "../src/child-artifact-ownership";
import {
  launchInteractiveSubagent,
  sendCommandToPane,
} from "../src/interactive-tmux";
import { rehydrateInteractiveSubagents } from "../src/rehydrate";
import { pollArtifactChanges } from "../src/artifact-poller";
import {
  MultiplexerContextUnavailableError,
  resolveMux,
} from "../src/multiplexer";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import {
  createPiSessionHarness,
  withIsolatedPiRuntime,
} from "./helpers/pi-session-harness";
import { createTestSessionScope } from "./session-scope-fixture";
import { HerdrCoreMultiplexer } from "../src/multiplexer-herdr-core";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
} from "../src/multiplexer-live-probes";
import type { ProcessContext } from "../src/multiplexer-process-context";

const { execSync, execAsync, lstat, readContext, queryId, queryIdAsync } =
  vi.hoisted(() => ({
    execSync: vi.fn(),
    execAsync: vi.fn(),
    lstat: vi.fn(),
    readContext: vi.fn(),
    queryId: vi.fn(),
    queryIdAsync: vi.fn(),
  }));
vi.mock("../src/multiplexer-process-context", async (original) => ({
  ...(await original<typeof import("../src/multiplexer-process-context")>()),
  readProcessContext: readContext,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: execSync,
  execFile: execAsync,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: lstat,
}));
vi.mock("../src/multiplexer-herdr-core-identity", async (original) => ({
  ...(await original<
    typeof import("../src/multiplexer-herdr-core-identity")
  >()),
  queryCoreId: queryId,
  queryCoreIdAsync: queryIdAsync,
}));

const socket = "/tmp/core example.sock";
const coreId = "a".repeat(32);
const target = { mux: "herdr-core", paneId: "t7", server: socket } as const;
const context = {
  ...target,
  kind: "attached",
  session: coreId,
  terminalPid: 80,
} as const;
const env = {
  PATH: "/parent tools:/usr/bin",
  HC_SESSION: "other",
  HC_SOCKET: "/tmp/other.sock",
  HC_TERMINAL_ID: "t99",
  HC_TERMINAL_SOCKET: "/tmp/wrong.sock",
  EXAMPLE_SECRET: "private-env-value",
};
const self = { pid: 100, parentPid: 80, command: "pi", tty: "ttys002" };
const parent = { pid: 80, parentPid: 1, command: "bash", tty: "ttys002" };
const processContext: ProcessContext = {
  pid: 100,
  ancestors: [parent],
  processes: new Map([
    [100, self],
    [80, parent],
  ]),
};

function reply(command: string, args: string[]): string {
  expect(command).toBe("hc");
  if (args[0] === "get")
    return JSON.stringify({ address: args[1], state: "live", pid: 80 });
  if (args[0] === "run")
    return JSON.stringify({ address: "t8", state: "live" });
  return "{}";
}

beforeEach(() => {
  vi.resetAllMocks();
  queryId.mockReturnValue(coreId);
  queryIdAsync.mockResolvedValue(coreId);
  lstat.mockReturnValue({
    isSocket: () => true,
    uid: BigInt(process.getuid?.() ?? -1),
    dev: 1n,
    ino: 2n,
  });
  execSync.mockImplementation(reply);
  execAsync.mockImplementation((command, args, _options, callback) =>
    callback(null, reply(command, args), ""),
  );
});

describe("Herdr Core ownership", () => {
  it("proves exact live terminal and process ancestry against a pinned local socket, sync and async", async () => {
    const expected = {
      kind: "match",
      target: { ...target, session: coreId, terminalPid: 80 },
      distance: 0,
    };
    expect(probeLiveMuxTarget(target, processContext, env)).toEqual(expected);
    expect(await probeLiveMuxTargetAsync(target, processContext, env)).toEqual(
      expected,
    );
    for (const call of [...execSync.mock.calls, ...execAsync.mock.calls]) {
      expect(call[2].env).toMatchObject({ HC_SOCKET: socket });
      expect(call[2].env).not.toHaveProperty("HC_SESSION");
      expect(call[2].env).not.toHaveProperty("HC_TERMINAL_ID");
    }
    execSync.mockImplementation((command, args) =>
      args[0] === "get"
        ? JSON.stringify({ address: "t7", state: "live", pid: 100 })
        : reply(command, args),
    );
    expect(probeLiveMuxTarget(target, processContext, env)).toEqual({
      ...expected,
      target: { ...expected.target, terminalPid: 100 },
      distance: -1,
    });
  });

  it.each([
    { address: "t9", state: "live", pid: 100 },
    { address: "t7", state: "finished", pid: 100 },
    { address: "t7", state: "live", pid: 50 },
    { address: "remote/t7", state: "live", pid: 100 },
    { address: "t7", state: "live" },
  ])("rejects non-authoritative response %j", (row) => {
    execSync.mockImplementation((command, args) =>
      args[0] === "get" ? JSON.stringify(row) : reply(command, args),
    );
    expect(probeLiveMuxTarget(target, processContext, env).kind).not.toBe(
      "match",
    );
  });

  it("rejects a foreground TTY mismatch, remote addresses and missing sockets", () => {
    const otherTTY = { ...parent, tty: "ttys003" };
    expect(
      probeLiveMuxTarget(
        target,
        { ...processContext, ancestors: [otherTTY] },
        env,
      ).kind,
    ).not.toBe("match");
    execSync.mockClear();
    expect(
      probeLiveMuxTarget(
        { ...target, paneId: "remote/t7" },
        processContext,
        env,
      ).kind,
    ).not.toBe("match");
    lstat.mockImplementation(() => {
      throw Error("stale");
    });
    expect(probeLiveMuxTarget(target, processContext, env).kind).not.toBe(
      "match",
    );
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("Herdr Core transport", () => {
  it.each([true, false])(
    "runs the prepared script directly, outliveParent=%s",
    (outliveParent) => {
      const mux = new HerdrCoreMultiplexer(env);
      expect(
        mux.createPane({
          context,
          name: "task",
          cwd: "/work dir",
          background: true,
          program: { script: "/private/wrapper script.sh", outliveParent },
        }),
      ).toEqual({ paneId: "t8", session: coreId, server: socket });
      const argv = execSync.mock.calls.find(
        (call) => call[1][0] === "run",
      )?.[1];
      expect(argv).toEqual([
        "run",
        "--bg",
        "--json",
        "--cwd",
        "/work dir",
        "--parent",
        "t7",
        "--no-notify",
        ...(outliveParent ? ["--outlive-parent"] : []),
        "--",
        "/usr/bin/env",
        `PATH=${env.PATH}`,
        "/bin/bash",
        "/private/wrapper script.sh",
      ]);
      expect(argv.join(" ")).not.toContain(env.EXAMPLE_SECRET);
    },
  );

  it("redacts raw CLI failures and refuses a changed Core identity before send or kill", () => {
    const mux = new HerdrCoreMultiplexer(env);
    execSync.mockImplementation((command, args) => {
      if (args[0] === "run")
        throw Error(`${socket} ${env.PATH} ${env.EXAMPLE_SECRET}`);
      return reply(command, args);
    });
    expect(() =>
      mux.createPane({
        context,
        name: "x",
        cwd: "/work",
        background: true,
        program: { script: "/wrapper", outliveParent: true },
      }),
    ).toThrow(
      new Error(
        "Herdr Core did not confirm terminal allocation. Check local Core status and list its terminals before retrying.",
      ),
    );
    execSync.mockClear();
    queryId.mockReturnValue("b".repeat(32));
    expect(() =>
      mux.sendMessage("t8", "private prompt", coreId, socket),
    ).toThrow(/identity/);
    mux.killPane("t8", coreId, socket);
    expect(mux.getPaneLiveness("t8", coreId, socket)).toBe("unknown");
    expect(execSync).not.toHaveBeenCalled();
  });

  it("uses the captured endpoint for status, send, cancel and attachment; reports no focus", async () => {
    const mux = new HerdrCoreMultiplexer(env);
    expect(await mux.getPaneLivenessAsync("t8", coreId, socket)).toBe("alive");
    mux.sendMessage("t8", "--literal\ntext", coreId, socket);
    mux.killPane("t8", coreId, socket);
    expect(execSync.mock.calls.map(([, args]) => args)).toContainEqual([
      "send",
      "--json",
      "--",
      "t8",
      "--literal\ntext",
    ]);
    expect(execSync.mock.calls.map(([, args]) => args)).toContainEqual([
      "kill",
      "--json",
      "t8",
    ]);
    expect(await mux.getPaneActivityAsync()).toBe("unknown");
    const { attachCommand, focusCommand } = mux.buildAttachCommands({
      paneId: "t8",
      session: coreId,
      server: socket,
    });
    expect(attachCommand).toContain(socket);
    expect(attachCommand).toContain(coreId);
    expect(attachCommand).toContain("t8");
    expect(focusCommand).toBe("");
  });
});

it("keeps explicit non-Core selection independent of stale Core markers", () => {
  vi.stubEnv("TMUX", undefined);
  vi.stubEnv("TMUX_PANE", undefined);
  vi.stubEnv("HC_TERMINAL_ID", "remote/t7");
  expect(resolveMux({ preference: "tmux" }).context).toMatchObject({
    mux: "tmux",
    kind: "detached",
  });
  expect(() => resolveMux({ preference: "herdr-core" })).toThrow(
    MultiplexerContextUnavailableError,
  );
  expect(() => resolveMux()).toThrow(MultiplexerContextUnavailableError);
  expect(execSync).not.toHaveBeenCalled();
});

it("rejects launch when a live Core terminal has restarted under the same address", () => {
  const mux = new HerdrCoreMultiplexer(env);
  execSync.mockImplementation((command, args) =>
    args[0] === "get"
      ? JSON.stringify({ address: "t7", state: "live", pid: 81 })
      : reply(command, args),
  );
  expect(() =>
    mux.createPane({
      context,
      name: "x",
      cwd: "/work",
      background: true,
      program: { script: "/wrapper", outliveParent: true },
    }),
  ).toThrow(MultiplexerContextUnavailableError);
  expect(execSync.mock.calls.map(([, args]) => args[0])).toEqual(["get"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearSessionScopes();
});

it("prepares one-use Pi authority before Core allocation and rehydrates the exact completed turn", async () => {
  await withIsolatedPiRuntime(async ({ agentDir, cwd }) => {
    // Match the canonical path used by the child bootstrap on macOS.
    process.env.PI_CODING_AGENT_SESSION_DIR = realpathSync(
      join(agentDir, "sessions"),
    );
    vi.stubEnv("HC_TERMINAL_ID", target.paneId);
    vi.stubEnv("HC_TERMINAL_SOCKET", socket);
    vi.stubEnv("HC_SOCKET", "/tmp/contradictory.sock");
    vi.stubEnv("HC_SESSION", "unrelated");
    readContext.mockReturnValue(processContext);
    const scope = createTestSessionScope({ cwd });
    const parentSessionId = scope.sessionManager?.getSessionId?.();
    expect(parentSessionId).toBeDefined();
    let bootstrap: string | undefined;
    execSync.mockImplementation((command, args) => {
      if (args[0] === "run") {
        const script = readFileSync(args.at(-1)!, "utf8");
        bootstrap = new RegExp(
          `^export ${CHILD_ARTIFACT_BOOTSTRAP_ENV}='([^']+)'$`,
          "m",
        ).exec(script)?.[1];
        expect(bootstrap).toBeDefined();
        expect(statSync(bootstrap!).mode & 0o777).toBe(0o600);
      }
      return reply(command, args);
    });
    const state = launchInteractiveSubagent({
      name: "Core child",
      task: "Synthetic task",
      cwd,
      muxPreference: "herdr-core",
      sessionScope: scope,
      parentSessionId,
    });
    expect(state).toMatchObject({
      mux: "herdr-core",
      paneId: "t8",
      muxSession: coreId,
      muxServer: socket,
      workingCwd: cwd,
      selectPaneCommand: "",
    });
    expect(
      execSync.mock.calls
        .filter(([, args]) => ["run", "send"].includes(args[0]))
        .map(([, args]) => args[0]),
    ).toEqual(["run"]);
    const art = artifactPath(
      dirname(state.artifactDir),
      basename(state.artifactDir),
    );
    vi.stubEnv("ARTIFACT_DIR", art.dir);
    vi.stubEnv(CHILD_ARTIFACT_BOOTSTRAP_ENV, bootstrap);
    const harness = await createPiSessionHarness(cwd, {
      extensionRoot: new URL("..", import.meta.url).pathname,
    });
    try {
      expect(existsSync(bootstrap!)).toBe(false);
      const run = harness.session.prompt("synthetic Pi turn");
      await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
      writeOutput(art, "Core child result");
      harness.completeNext("Core child result");
      await run;
      await harness.session.waitForIdle();
      const userEntry = harness.sessionManager
        .getEntries()
        .find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      expect(userEntry).toBeDefined();
      const events = readEventRecords(art).map(({ event }) => event);
      expect(events.map(({ type, turnId }) => [type, turnId])).toEqual([
        ["turn_started", userEntry?.id],
        ["completion", userEntry?.id],
      ]);
      expect(readOutputForTurnId(art, userEntry!.id)).toContain(
        "Core child result",
      );
      await pollArtifactChanges(scope.pi, sessionOwner(scope));
      expect(state.status).toBe("idle");
      scope.interactiveStates.clear();
      expect(
        rehydrateInteractiveSubagents(cwd, parentSessionId, [], scope),
      ).toMatchObject({ recovered: 1, alive: 1 });
      const restored = scope.interactiveStates.get(state.id)!;
      expect(restored).toMatchObject({
        mux: "herdr-core",
        muxServer: socket,
        muxSession: coreId,
        status: "idle",
      });
      expect(restored.attachCommand).toBe(state.attachCommand);
      sendCommandToPane(restored, "follow-up");
      expect(execSync.mock.calls.at(-1)?.[1]).toEqual([
        "send",
        "--json",
        "--",
        "t8",
        "follow-up",
      ]);
    } finally {
      harness.dispose();
    }
  });
});
