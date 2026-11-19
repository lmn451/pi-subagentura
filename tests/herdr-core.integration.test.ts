import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { expect, it, vi } from "vitest";
import { requestHerdrCore } from "../src/herdr-core-rpc.mjs";
import { HerdrCoreMultiplexer } from "../src/multiplexer-herdr-core";
import { shellEscape } from "../src/multiplexer-contracts";
import { launchInteractiveSubagent } from "../src/interactive-tmux";
import { loadInteractiveStates } from "../src/artifact";
import { removeSessionScope, sessionOwner } from "../src/session-scope";
import { createTestSessionScope } from "./session-scope-fixture";

// Opt in only with the endpoint of a separately launched, isolated test core.
it.skipIf(!process.env.HERDR_CORE_TEST_SOCKET)(
  "runs the real terminal lifecycle with literal input and separate Enter",
  async () => {
    const server = process.env.HERDR_CORE_TEST_SOCKET!;
    mkdirSync(".context", { recursive: true });
    const directory = mkdtempSync(resolve(".context/hc-integration-"));
    const output = join(directory, "output");
    const mux = new HerdrCoreMultiplexer();
    let child: string | undefined;
    const parent = await requestHerdrCore(server, "terminal.run", {
      argv: ["bash", "--noprofile", "--norc", "-i"],
      no_parent: true,
      no_notify: true,
    });
    const parentId = parent.address as string;
    try {
      const created = mux.createPane({
        context: {
          kind: "attached",
          mux: "herdr-core",
          paneId: parentId,
          server,
        },
        name: "integration",
        cwd: directory,
        background: true,
      });
      child = created.paneId;
      expect(mux.getPaneLiveness(child, undefined, server)).toBe("alive");
      expect(await mux.getPaneLivenessAsync(child, undefined, server)).toBe(
        "alive",
      );
      mux.sendKeys(
        child,
        `printf '%s' 'héllo 世界 👋' > ${shellEscape(output)}; printf 'visible-output'; exit`,
        undefined,
        server,
      );
      expect(existsSync(output)).toBe(false);
      mux.sendEnter(child, undefined, server);
      await requestHerdrCore(server, "terminal.wait", {
        terminal: child,
        timeout: 3,
      });
      expect(readFileSync(output, "utf8")).toBe("héllo 世界 👋");
      expect(mux.getPaneLiveness(child, undefined, server)).toBe("dead");
      const capture = await mux.capturePane(
        { paneId: child, server },
        { maxLines: 10, maxBytes: 1000 },
      );
      expect(capture.output).toContain("visible-output");
      mux.killPane(parentId, undefined, server);
      expect(await mux.getPaneLivenessAsync(parentId, undefined, server)).toBe(
        "dead",
      );
    } finally {
      for (const id of [child, parentId]) {
        if (!id) continue;
        mux.killPane(id, undefined, server);
        await requestHerdrCore(server, "terminal.rm", { terminal: id });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!process.env.HERDR_CORE_TEST_SOCKET)(
  "keeps a real Pi child alive when its executable is absent from the Core service PATH",
  async () => {
    const server = process.env.HERDR_CORE_TEST_SOCKET!;
    const repo = process.cwd();
    mkdirSync(".context", { recursive: true });
    const root = mkdtempSync(resolve(".context/hc-pi-"));
    const bin = join(root, "bin");
    const agent = join(root, "agent");
    const sessions = join(root, "sessions");
    const gates = join(root, "gates");
    for (const path of [bin, agent, sessions, gates]) mkdirSync(path);
    writeFileSync(join(gates, "release-interactive"), "");
    const childEnv = {
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: sessions,
      PI_TELEMETRY: "0",
      PI_SUBAGENTURA_TELEMETRY: "0",
      SUBAGENTURA_E2E_REPO: repo,
      SUBAGENTURA_E2E_REAL_PI:
        process.env.HERDR_CORE_TEST_PI ?? resolve("node_modules/.bin/pi"),
      SUBAGENTURA_E2E_GATE_DIR: gates,
      SUBAGENTURA_E2E_LOG: join(root, "provider.jsonl"),
      SUBAGENTURA_E2E_CORE_SOCKET: server,
      NODE_OPTIONS: `--require=${JSON.stringify(resolve("tests/terminal-e2e/fixtures/deny-network-except-core.cjs"))}`,
    };
    writeFileSync(
      join(bin, "pi"),
      [
        "#!/bin/bash",
        "set -e",
        ...Object.entries(childEnv).map(
          ([key, value]) => `export ${key}=${shellEscape(value)}`,
        ),
        `exec /bin/bash ${shellEscape(resolve("tests/terminal-e2e/fixtures/pi-child-wrapper.sh"))} "$@"`,
      ].join("\n"),
      { mode: 0o700 },
    );
    const originalEnv = process.env;
    const scope = createTestSessionScope();
    const mux = new HerdrCoreMultiplexer();
    let child: string | undefined;
    const parent = await requestHerdrCore(server, "terminal.run", {
      argv: ["bash", "--noprofile", "--norc", "-i"],
      no_parent: true,
      no_notify: true,
    });
    try {
      const coreEnv = await requestHerdrCore(server, "terminal.run", {
        argv: [
          "/bin/sh",
          "-c",
          'case "$PATH" in *"$1"*) exit 1;; esac',
          "--",
          bin,
        ],
        no_parent: true,
        no_notify: true,
        wait: true,
      });
      try {
        const exited = await requestHerdrCore(server, "terminal.get", {
          terminal: coreEnv.address,
        });
        expect(exited.exit_code).toBe(0);
      } finally {
        await requestHerdrCore(server, "terminal.rm", {
          terminal: coreEnv.address,
        });
      }
      process.env = {
        ...originalEnv,
        PATH: `${bin}:${originalEnv.PATH ?? "/usr/bin:/bin"}`,
        PI_CODING_AGENT_DIR: agent,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        HC_TERMINAL_ID: parent.address as string,
        HC_TERMINAL_SOCKET: server,
      };
      const state = launchInteractiveSubagent({
        name: "core-pi-path",
        task: "[E2E:CHILD_INTERACTIVE] Complete the fixture and remain in Pi.",
        model: "subagentura-e2e/mock",
        cwd: root,
        muxPreference: "herdr-core",
        parentSessionId: scope.sessionManager!.getSessionId!(),
        sessionScope: scope,
        supervisorOwner: sessionOwner(scope),
      });
      child = state.paneId;
      expect(loadInteractiveStates(root)?.states[state.id]?.muxServer).toBe(
        server,
      );
      await vi.waitFor(
        () => {
          const log = readFileSync(join(root, "provider.jsonl"), "utf8");
          expect(log).toContain('"afterStage":"complete"');
        },
        { timeout: 15_000, interval: 100 },
      );
      const events = readFileSync(
        join(state.artifactDir, "events.ndjson"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.some(
          (event) => event.type === "completion" && event.outcome === "done",
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "process_exit")).toBe(false);
      expect(
        readFileSync(join(state.artifactDir, "output.md"), "utf8"),
      ).toContain("INTERACTIVE_OUTPUT_1");
      await vi.waitFor(
        async () => {
          const terminal = await requestHerdrCore(server, "terminal.get", {
            terminal: child,
          });
          expect(terminal.state).toBe("live");
          expect(terminal.exit_code).toBeNull();
          expect(Date.now() - (terminal.created_ms as number)).toBeGreaterThan(
            1500,
          );
        },
        { timeout: 5_000, interval: 100 },
      );
    } finally {
      process.env = originalEnv;
      for (const id of [child, parent.address as string]) {
        if (!id) continue;
        mux.killPane(id, undefined, server);
        await requestHerdrCore(server, "terminal.rm", { terminal: id });
      }
      removeSessionScope(scope.id);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
