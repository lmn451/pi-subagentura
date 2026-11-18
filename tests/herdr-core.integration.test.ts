import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HerdrCoreMultiplexer } from "../src/multiplexer-herdr-core";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
} from "../src/multiplexer-live-probes";
import { readProcessContext } from "../src/multiplexer-process-context";

const enabled = process.env.PI_SUBAGENTURA_TEST_HERDR_CORE === "1";

describe.runIf(enabled)("isolated Herdr Core CLI contract", () => {
  it("binds a real local PID, launches with PATH only, submits, and scopes child lifetime", async () => {
    // Keep the socket path short even when the host's TMPDIR is long.
    const root = mkdtempSync("/tmp/pi-hc-");
    const socket = join(root, "core.sock");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      HC_SESSION: `test-${root.split("-").at(-1)}`,
      HC_SOCKET: socket,
    };
    const call = (...args: string[]) =>
      JSON.parse(
        execFileSync("hc", args, {
          env,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 65536,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    const working = join(root, "work dir");
    const ready = join(working, "ready");
    const received = join(working, "received");
    const wrapper = join(root, "wrapper.sh");
    mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    mkdirSync(working, { mode: 0o700 });
    try {
      const status = call("server", "start", "--json");
      expect(existsSync(socket)).toBe(true);
      const { address } = call(
        "run",
        "--bg",
        "--json",
        "--no-parent",
        "--",
        "/bin/sleep",
        "30",
      );
      const { pid } = call("get", address, "--json");
      const processes = readProcessContext(pid);
      expect(processes?.pid).toBe(pid);
      const candidate = {
        mux: "herdr-core",
        paneId: address,
        server: socket,
      } as const;
      const target = {
        ...candidate,
        session: status.core.id,
        terminalPid: pid,
      };
      expect(probeLiveMuxTarget(candidate, processes!, env)).toEqual({
        kind: "match",
        distance: -1,
        target,
      });
      expect(await probeLiveMuxTargetAsync(candidate, processes!, env)).toEqual(
        { kind: "match", distance: -1, target },
      );

      writeFileSync(
        wrapper,
        'printf "%s\\n" "$PWD" "$PATH" "${PI_CORE_TEST_PRIVATE-unset}" > ready\nIFS= read -r msg\nprintf "%s" "$msg" > received\nexit 37\n',
        { mode: 0o700 },
      );
      const launchPath = `${root}/custom bin:${env.PATH ?? "/usr/bin:/bin"}`;
      const mux = new HerdrCoreMultiplexer({
        ...env,
        PATH: launchPath,
        PI_CORE_TEST_PRIVATE: "must-not-inherit",
      });
      const launch = (script: string, outliveParent: boolean) =>
        mux.createPane({
          context: { ...target, kind: "attached" },
          name: "smoke",
          cwd: working,
          background: true,
          program: { script, outliveParent },
        });
      const standalone = launch(wrapper, true);
      const workflowScript = join(root, "workflow.sh");
      writeFileSync(workflowScript, "exec /bin/sleep 30\n", { mode: 0o700 });
      const workflow = launch(workflowScript, false);
      expect(
        (
          await mux.getPaneLivenessDiagnosticAsync(
            workflow.paneId,
            workflow.session,
            workflow.server,
          )
        ).liveness,
      ).toBe("alive");
      call("kill", "--json", address);
      await vi.waitFor(async () => {
        expect(
          await mux.getPaneLivenessAsync(
            workflow.paneId,
            workflow.session,
            workflow.server,
          ),
        ).toBe("dead");
        expect(readFileSync(ready, "utf8").split("\n")).toEqual([
          working,
          launchPath,
          "unset",
          "",
        ]);
      });
      expect(
        await mux.getPaneLivenessAsync(
          standalone.paneId,
          standalone.session,
          standalone.server,
        ),
      ).toBe("alive");
      mux.sendMessage(
        standalone.paneId,
        "--literal text",
        standalone.session,
        standalone.server,
      );
      await vi.waitFor(async () => {
        expect(
          await mux.getPaneLivenessDiagnosticAsync(
            standalone.paneId,
            standalone.session,
            standalone.server,
          ),
        ).toEqual({ liveness: "dead", exitCode: 37 });
      });
      expect(readFileSync(received, "utf8")).toBe("--literal text");
    } finally {
      try {
        if (existsSync(socket)) call("server", "stop", "--json");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it("does not auto-start a Core for a stale socket", async () => {
    const root = mkdtempSync("/tmp/pi-hc-");
    const live = join(root, "listener.sock");
    const stale = join(root, "stale.sock");
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      HC_TERMINAL_ID: "t1",
      HC_TERMINAL_SOCKET: stale,
      HC_SOCKET: stale,
    };
    const server = createServer();
    let autoStarted = false;
    mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(live, resolve);
      });
      renameSync(live, stale);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(existsSync(stale)).toBe(true);
      autoStarted = new HerdrCoreMultiplexer(env).isAvailable();
      expect(autoStarted).toBe(false);
    } finally {
      try {
        if (autoStarted)
          execFileSync("hc", ["server", "stop", "--json"], {
            env,
            timeout: 5000,
            stdio: "ignore",
          });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
