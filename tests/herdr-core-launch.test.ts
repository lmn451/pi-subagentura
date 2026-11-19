import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

vi.mock("../src/multiplexer-current-context", () => {
  const ready = () => ({
    kind: "ready" as const,
    target: {
      mux: "herdr-core" as const,
      paneId: "t1abc",
      server: "/tmp/herdr-core-launch-test.sock",
    },
  });
  return {
    resolveCurrentMuxContext: vi.fn(ready),
    resolveCurrentMuxContextAsync: vi.fn(async () => ready()),
    resolveExplicitHerdrCoreContext: vi.fn(ready),
  };
});

describe("Herdr Core child launch", () => {
  it("runs the official Pi CLI with a daemon PATH that has neither pi nor node", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-herdr-core-launch-"));
    const originalArgv1 = process.argv[1];
    const originalPath = process.env.PATH;
    const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    let clearScopes: (() => void) | undefined;
    let resetCoreMux: (() => void) | undefined;

    try {
      const workspace = join(root, "workspace");
      const packageRoot = join(root, "pi-package");
      const binDir = join(packageRoot, "bin");
      const daemonBin = join(root, "daemon-bin");
      const marker = join(root, "cli-ran");
      const cliEntry = join(binDir, "pi.mjs");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(daemonBin);
      symlinkSync("/bin/bash", join(daemonBin, "bash"));
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          bin: { pi: "./bin/pi.mjs" },
        }),
      );
      writeFileSync(
        cliEntry,
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.PI_TEST_CLI_MARKER, JSON.stringify(process.argv.slice(2)));",
          "",
        ].join("\n"),
      );

      // Model a daemon that retained only a usable shell on PATH. The test
      // process still runs normally through its already-started Node runtime.
      process.env.PATH = daemonBin;
      process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
      process.argv[1] = cliEntry;

      const [
        { launchInteractiveSubagent },
        { __setHerdrCoreMultiplexer },
        { createTestSessionScope },
        { clearSessionScopes },
      ] = await Promise.all([
        import("../src/interactive-tmux"),
        import("../src/multiplexer"),
        import("./session-scope-fixture"),
        import("../src/session-scope"),
      ]);
      clearScopes = clearSessionScopes;
      resetCoreMux = () => __setHerdrCoreMultiplexer(undefined);

      let commandStatus: number | null | undefined;
      let commandError: Error | undefined;
      let commandStderr = "";
      const sendCommand = vi.fn((_paneId: string, command: string) => {
        const result = spawnSync("/bin/bash", ["-c", command], {
          env: {
            ...process.env,
            PATH: daemonBin,
            PI_TEST_CLI_MARKER: marker,
          },
          encoding: "utf8",
        });
        commandStatus = result.status;
        commandError = result.error;
        commandStderr = result.stderr;
      });
      __setHerdrCoreMultiplexer({
        name: "herdr-core",
        createPane: vi.fn(() => ({
          paneId: "pi-0123456789abcdef",
          server: "/tmp/herdr-core-launch-test.sock",
        })),
        sendCommand,
        buildAttachCommands: vi.fn(() => ({
          attachCommand: "herdr-core attach",
          focusCommand: "herdr-core focus",
        })),
        getPaneLiveness: vi.fn(() => "alive"),
        getPaneLivenessAsync: vi.fn(async () => "alive"),
        killPane: vi.fn(),
      } as never);

      const state = launchInteractiveSubagent({
        name: "daemon-path",
        task: "verify the official CLI is launched",
        cwd: workspace,
        muxPreference: "herdr-core",
        sessionScope: createTestSessionScope(),
      });

      expect(commandError).toBeUndefined();
      expect(commandStatus, commandStderr).toBe(0);
      expect(existsSync(marker)).toBe(true);
      const events = readFileSync(
        join(state.artifactDir, "events.ndjson"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "process_exited", exitCode: 0 }),
      );
    } finally {
      resetCoreMux?.();
      clearScopes?.();
      if (originalArgv1 === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalArgv1;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalSessionDir === undefined)
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
