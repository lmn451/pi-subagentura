import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness } from "./harness.mjs";

async function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(
      () => rejectPromise(new Error("timed out waiting for child output")),
      15_000,
    );
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolvePromise(buffer.slice(0, newline));
    });
  });
}

function signalWithCompetingListener(position: "before" | "after") {
  const harnessUrl = new URL("./harness.mjs", import.meta.url).href;
  const script = `
    import { existsSync } from "node:fs";
    import { MessageChannel } from "node:worker_threads";
    import { createHarness } from ${JSON.stringify(harnessUrl)};
    let harness;
    const keepAlive = new MessageChannel();
    keepAlive.port1.on("message", () => {});
    const otherListener = () => {
      setImmediate(() => {
        keepAlive.port1.close();
        keepAlive.port2.close();
        console.log(JSON.stringify({
          listener: "other",
          rootExists: existsSync(harness.root),
        }));
      });
    };
    if (${JSON.stringify(position)} === "before") {
      process.once("SIGTERM", otherListener);
    }
    harness = createHarness({ scenario: "signal-ownership" });
    if (${JSON.stringify(position)} === "after") {
      process.once("SIGTERM", otherListener);
    }
    process.kill(process.pid, "SIGTERM");
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 10_000,
    }),
  );
}

describe("terminal harness lifecycle", () => {
  it("approves only the isolated fixture project when launching children", () => {
    const root = mkdtempSync(join(tmpdir(), "subagentura-wrapper-contract-"));
    const fakePi = join(root, "pi");
    writeFileSync(fakePi, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    try {
      const args = execFileSync(
        "bash",
        [
          new URL("./fixtures/pi-child-wrapper.sh", import.meta.url).pathname,
          "--session",
          "fixture-session.jsonl",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SUBAGENTURA_E2E_REAL_PI: fakePi,
            SUBAGENTURA_E2E_REPO: root,
          },
        },
      )
        .trim()
        .split("\n");
      expect(args.slice(0, 2)).toEqual(["--offline", "--approve"]);
      expect(args.slice(-2)).toEqual(["--session", "fixture-session.jsonl"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("kills a server created before pane discovery fails", async () => {
    const harness = createHarness({ scenario: "startup-failure" });
    const runTmux = harness.tmux.bind(harness);
    harness.tmux = (args, options) => {
      if (args[0] === "display-message") {
        throw new Error("injected pane discovery failure");
      }
      return runTmux(args, options);
    };

    const startError = await harness.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(startError)).toContain("injected pane discovery failure");
    await harness.cleanup(true);

    expect(() =>
      execFileSync("tmux", ["-L", harness.socket, "has-session"], {
        stdio: "ignore",
        timeout: 2_000,
      }),
    ).toThrow();
  });

  it("keeps diagnostics from repeated scenarios in separate directories", async () => {
    const diagnosticsRoot = mkdtempSync(
      join(tmpdir(), "subagentura-e2e-diagnostics-"),
    );
    const previousDiagnostics = process.env.SUBAGENTURA_E2E_DIAGNOSTICS;
    process.env.SUBAGENTURA_E2E_DIAGNOSTICS = diagnosticsRoot;
    const first = createHarness({ scenario: "interactive" });
    const second = createHarness({ scenario: "interactive" });
    try {
      first.setupFiles();
      second.setupFiles();
      first.diagnostics();
      second.diagnostics();
      const directories = readdirSync(diagnosticsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(directories).toHaveLength(2);
      expect(new Set(directories).size).toBe(2);
    } finally {
      await Promise.all([first.cleanup(false), second.cleanup(false)]);
      if (previousDiagnostics === undefined) {
        delete process.env.SUBAGENTURA_E2E_DIAGNOSTICS;
      } else {
        process.env.SUBAGENTURA_E2E_DIAGNOSTICS = previousDiagnostics;
      }
      rmSync(diagnosticsRoot, { recursive: true, force: true });
    }
  });

  it("does not inherit hostile NODE_OPTIONS preloads into children", async () => {
    const hostileRoot = mkdtempSync(join(tmpdir(), "hostile-node-options-"));
    const hostilePreload = join(hostileRoot, "hostile.cjs");
    const hostileMarker = join(hostileRoot, "loaded");
    writeFileSync(
      hostilePreload,
      `require("node:fs").writeFileSync(${JSON.stringify(hostileMarker)}, "loaded");`,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${hostilePreload}`;
    const harness = createHarness({ scenario: "node-options" });
    try {
      harness.setupFiles();
      execFileSync(process.execPath, ["--eval", ""], {
        env: harness.env,
        stdio: "ignore",
        timeout: 5_000,
      });

      expect(harness.env.NODE_OPTIONS).not.toContain(hostilePreload);
      expect(existsSync(hostileMarker)).toBe(false);
      expect(harness.networkEvents()).toContainEqual(
        expect.objectContaining({ kind: "armed" }),
      );
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
      await harness.cleanup(false);
      rmSync(hostileRoot, { recursive: true, force: true });
    }
  });

  it("does not claim a signal with an earlier listener", () => {
    expect(signalWithCompetingListener("before")).toEqual({
      listener: "other",
      rootExists: false,
    });
  });

  it("does not claim a signal with a later listener", () => {
    expect(signalWithCompetingListener("after")).toEqual({
      listener: "other",
      rootExists: false,
    });
  });

  it("kills active harnesses when the test process receives SIGTERM", async () => {
    const harnessUrl = new URL("./harness.mjs", import.meta.url).href;
    const script = `import { createHarness } from ${JSON.stringify(harnessUrl)}; const harness = createHarness({ scenario: "signal" }); await harness.start(); console.log(JSON.stringify({ socket: harness.socket, root: harness.root })); setInterval(() => {}, 1000);`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      const info = JSON.parse(await nextLine(child.stdout));
      const exited = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolvePromise) => {
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      });
      child.kill("SIGTERM");
      const result = await exited;
      const processes = execFileSync("ps", ["-axww", "-o", "command="], {
        encoding: "utf8",
      });

      expect(result).toEqual({ code: 143, signal: null });
      expect(processes).not.toContain(info.root);
      expect(() =>
        execFileSync("tmux", ["-L", info.socket, "has-session"], {
          stdio: "ignore",
          timeout: 2_000,
        }),
      ).toThrow();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    // Assert the absence of the thing under test, not an empty stream: the child
    // is `node --eval`, so one ExperimentalWarning on a Node minor bump would
    // otherwise fail a test about signal handling.
    expect(stderr).not.toMatch(/emergency cleanup failed|teardown incomplete/);
  }, 30_000);
});
