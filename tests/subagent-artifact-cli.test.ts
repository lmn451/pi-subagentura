import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, constants } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CLI_SOURCE, writeCliScript } from "../src/subagent-artifact-cli";
import {
  artifactPath,
  MAX_EVENT_TEXT_LENGTH,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  readEvents,
} from "../src/artifact";
import {
  COMPLETION_LOCK_PROTOCOL_FILE,
  completionLockPathForTurn,
  initializeCompletionLockProtocol,
  readCompletionLockProtocol,
  withCompletionWriterLock,
} from "../src/completion-writer-lock.mjs";
const platformSignals = constants.signals as Record<string, number>;
const hostSignalName =
  platformSignals.SIGINFO !== undefined
    ? "SIGINFO"
    : platformSignals.SIGSTKFLT !== undefined
      ? "SIGSTKFLT"
      : undefined;
function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-cli-"));
}

function runCli(
  artDir: string,
  args: string[],
  input?: string,
): { status: number; stdout: string; stderr: string } {
  // Write the CLI source to the artifact dir, then invoke it.
  const cliPath = join(artDir, "cli.mjs");
  writeCliScript(cliPath);
  const res = spawnSync("node", [cliPath, ...args], {
    env: { ...process.env, ARTIFACT_DIR: artDir },
    input,
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("subagent-artifact CLI", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
    initializeCompletionLockProtocol(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("source", () => {
    it("parses as valid JavaScript (node --check)", () => {
      // Strip the shebang (node can't parse it as a file) and write to a
      // temp .mjs file, then `node --check` it.
      const body = CLI_SOURCE.replace(/^#!.*\n/, "");
      const target = join(tmp, "check.mjs");
      writeFileSync(target, body);
      const r = spawnSync("node", ["--check", target], { encoding: "utf8" });
      expect({ status: r.status, stderr: r.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
    });

    it("the generated cli.mjs is 0o700", () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      expect(statSync(cliPath).mode & 0o777).toBe(0o700);
    });
  });

  describe("done", () => {
    it("writes one explicit v2 completion for repeated done commands", () => {
      runCli(tmp, ["done", "0"]);
      runCli(tmp, ["done", "0"]);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        version: 2,
        type: "completion",
        source: "explicit",
        outcome: "done",
        status: "done",
        exitCode: 0,
      });
    });

    it("writes a done event with non-zero exit code → status error", () => {
      runCli(tmp, ["done", "1"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.status).toBe("error");
      expect(ev.exitCode).toBe(1);
    });

    it("records outputError instead of snapshotting oversized output.md", () => {
      const bytes = MAX_OUTPUT_SNAPSHOT_BYTES + 1;
      writeFileSync(join(tmp, "output.md"), Buffer.alloc(bytes, 120));

      const r = runCli(tmp, ["done", "0"]);

      expect(r.status).toBe(0);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.output).toBeUndefined();
      expect(ev.outputError).toEqual({
        code: "output_too_large",
        bytes,
        maxBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
      });
      expect(existsSync(join(tmp, "outputs", `${ev.eventId}.md`))).toBe(false);
    });

    it("diagnoses an exit while a tool is active without recording arguments", () => {
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({
          turnId: "active-turn",
          started: true,
          activeTools: [
            {
              name: "bash",
              callId: "tool-2",
              startedAt: Date.now(),
            },
          ],
          lastTool: "bash",
          secretArguments: "Bearer do-not-persist",
        }),
      );
      const r = runCli(tmp, ["process-exit", "0"]);
      expect(r.status).toBe(0);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "process_exited",
          status: "done",
          exitCode: 0,
          terminationReason: "active_tool",
          lastTool: "bash",
        }),
      );
      expect(JSON.stringify(events)).not.toContain("do-not-persist");
    });
  });

  describe("process-exit diagnostics", () => {
    it("uses normal_exit after an explicit completion", () => {
      expect(runCli(tmp, ["done", "0"]).status).toBe(0);
      expect(runCli(tmp, ["process-exit", "0"]).status).toBe(0);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        type: "process_exited",
        status: "done",
        exitCode: 0,
        terminationReason: "normal_exit",
      });
      expect(events.at(-1)).not.toHaveProperty("lastTool");
    });

    it("records a signal alongside an unexpected exit reason", () => {
      const r = runCli(tmp, ["process-exit", "143"]);
      expect(r.status).toBe(0);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        type: "process_exited",
        status: "error",
        exitCode: 143,
        terminationReason: "signal",
        signal: "SIGTERM",
      });
    });

    it("records nonzero exits without inventing a signal", () => {
      const r = runCli(tmp, ["process-exit", "17"]);
      expect(r.status).toBe(0);
      const event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8")
          .trim()
          .split("\n")
          .at(-1)!,
      );
      expect(event).toMatchObject({
        type: "process_exited",
        status: "error",
        exitCode: 17,
        terminationReason: "nonzero_exit",
      });
      expect(event).not.toHaveProperty("signal");
    });

    it("ignores malformed and oversized active-turn diagnostics", () => {
      const secret = "prompt secret and raw stderr";
      writeFileSync(join(tmp, "active-turn.json"), `${secret}\n`);
      expect(runCli(tmp, ["process-exit", "0"]).status).toBe(0);
      const malformedEvents = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(malformedEvents.at(-1)).toMatchObject({
        type: "process_exited",
        terminationReason: "unknown",
      });
      expect(JSON.stringify(malformedEvents)).not.toContain(secret);

      rmSync(join(tmp, "events.ndjson"));
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({
          turnId: "turn",
          started: true,
          lastTool: "x".repeat(20_000),
        }),
      );
      expect(runCli(tmp, ["process-exit", "0"]).status).toBe(0);
      const oversizedEvents = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(oversizedEvents.at(-1)).toMatchObject({
        type: "process_exited",
        terminationReason: "unknown",
      });
      expect(JSON.stringify(oversizedEvents)).not.toContain("x".repeat(200));
    });

    it("keeps cancellation and completion precedence over active metadata", () => {
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({
          turnId: "active-turn",
          started: true,
          activeTools: [{ name: "bash", startedAt: Date.now() }],
          lastTool: "bash",
        }),
      );
      writeFileSync(join(tmp, ".cancelled"), "", { mode: 0o600 });
      expect(runCli(tmp, ["process-exit", "143"]).status).toBe(0);
      let event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8")
          .trim()
          .split("\n")
          .at(-1)!,
      );
      expect(event).toMatchObject({
        type: "process_exited",
        status: "cancelled",
        terminationReason: "cancelled",
        signal: "SIGTERM",
        lastTool: "bash",
      });

      rmSync(join(tmp, "events.ndjson"));
      rmSync(join(tmp, ".cancelled"));
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({
          turnId: "active-turn",
          started: true,
          activeTools: [{ name: "bash", startedAt: Date.now() }],
          lastTool: "bash",
        }),
      );
      expect(runCli(tmp, ["done", "0"]).status).toBe(0);
      expect(runCli(tmp, ["process-exit", "0"]).status).toBe(0);
      event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8")
          .trim()
          .split("\n")
          .at(-1)!,
      );
      expect(event).toMatchObject({
        type: "process_exited",
        terminationReason: "normal_exit",
      });
      expect(event).not.toHaveProperty("lastTool");
    });
  });

  describe("completion locking", () => {
    it("serializes concurrent completion writers for one turn", async () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId: "shared-turn", startedAt: Date.now() }),
      );
      writeFileSync(join(tmp, "output.md"), "stable output");

      const commands = Array.from({ length: 16 }, (_, index) =>
        index % 3 === 0 ? ["cancelled"] : ["done", "0"],
      );
      const results = await Promise.allSettled(
        commands.map(
          (args) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn("node", [cliPath, ...args], {
                env: { ...process.env, ARTIFACT_DIR: tmp },
              });
              const stderr: string[] = [];
              const timeout = setTimeout(() => child.kill(), 5_000);
              child.stderr?.setEncoding("utf8");
              child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
              child.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
              });
              child.once("close", (code) => {
                clearTimeout(timeout);
                if (code === 0) resolve();
                else {
                  reject(
                    new Error(
                      `completion writer exited ${code}: ${stderr.join("")}`,
                    ),
                  );
                }
              });
            }),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
      expect(failures).toEqual([]);

      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) =>
            event.type === "completion" && event.turnId === "shared-turn",
        ),
      ).toHaveLength(1);
      expect(existsSync(join(tmp, "outputs"))).toBe(true);
    });

    it("refuses to complete a markerless resumed artifact", () => {
      rmSync(join(tmp, COMPLETION_LOCK_PROTOCOL_FILE));
      const turnId = "legacy-cli-turn";
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId, startedAt: Date.now() }),
      );
      const lock = completionLockPathForTurn(tmp, turnId);
      mkdirSync(lock);
      utimesSync(lock, new Date(0), new Date(0));

      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const result = spawnSync(process.execPath, [cliPath, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: tmp },
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("legacy completion writer");
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(join(tmp, "events.ndjson"))).toBe(false);
    });

    it("uses atomic recovery for a freshly marked artifact", () => {
      const turnId = "fresh-cli-turn";
      initializeCompletionLockProtocol(tmp);
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId, startedAt: Date.now() }),
      );
      const lock = completionLockPathForTurn(tmp, turnId);
      mkdirSync(lock);
      utimesSync(lock, new Date(0), new Date(0));

      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const result = spawnSync(process.execPath, [cliPath, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: tmp },
        encoding: "utf8",
        timeout: 5000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(lock)).toBe(false);
      const event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(event).toMatchObject({ type: "completion", turnId });
    });

    for (const [label, args] of [
      ["completion", ["done", "0"]],
      ["cancellation", ["cancelled"]],
    ] as const) {
      it.skipIf(process.platform === "win32")(
        `does not block the generated ${label} helper on a FIFO marker`,
        () => {
          const markerPath = join(tmp, COMPLETION_LOCK_PROTOCOL_FILE);
          rmSync(markerPath);
          const fifo = spawnSync("mkfifo", [markerPath], {
            encoding: "utf8",
            timeout: 1_000,
          });
          expect(fifo.error).toBeUndefined();
          expect(fifo.status).toBe(0);

          const cliPath = join(tmp, "cli.mjs");
          writeCliScript(cliPath);
          const result = spawnSync(process.execPath, [cliPath, ...args], {
            env: { ...process.env, ARTIFACT_DIR: tmp },
            encoding: "utf8",
            timeout: 2_000,
          });

          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(
            "unsupported completion lock protocol",
          );
          expect(existsSync(join(tmp, "events.ndjson"))).toBe(false);
        },
      );
    }

    it("uses one atomic lock path for TypeScript and the generated CLI", async () => {
      const artDir = join(tmp, "shared-protocol-artifact");
      mkdirSync(artDir);
      initializeCompletionLockProtocol(artDir);
      const turnId = "shared-protocol-turn";
      writeFileSync(
        join(artDir, "active-turn.json"),
        JSON.stringify({ turnId, startedAt: Date.now() }),
      );
      writeFileSync(join(artDir, "output.md"), "shared output");
      const lock = completionLockPathForTurn(artDir, turnId);
      const cliPath = join(artDir, "cli.mjs");
      const startedPath = join(tmp, "cli-started");
      const preloadPath = join(tmp, "mark-cli-start.cjs");
      writeCliScript(cliPath);
      writeFileSync(
        preloadPath,
        `require("node:fs").writeFileSync(${JSON.stringify(startedPath)}, "started");`,
      );
      let childExit: Promise<number> | undefined;
      let childStderr = "";
      let childStartedWhileHeld = false;
      let completionWrittenWhileHeld = false;

      expect(readCompletionLockProtocol(artDir)).toBe("atomic");
      expect(
        withCompletionWriterLock(
          lock,
          () => {
            const child = spawn(
              process.execPath,
              ["-r", preloadPath, cliPath, "done", "0"],
              { env: { ...process.env, ARTIFACT_DIR: artDir } },
            );
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk) => {
              childStderr += String(chunk);
            });
            childExit = new Promise<number>((resolve, reject) => {
              const timeout = setTimeout(() => child.kill(), 5_000);
              child.once("error", (error) => {
                clearTimeout(timeout);
                reject(error);
              });
              child.once("close", (code) => {
                clearTimeout(timeout);
                resolve(code ?? -1);
              });
            });
            const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
            const startupDeadline = Date.now() + 2_000;
            while (!existsSync(startedPath) && Date.now() < startupDeadline) {
              Atomics.wait(waitBuffer, 0, 0, 10);
            }
            childStartedWhileHeld = existsSync(startedPath);
            Atomics.wait(waitBuffer, 0, 0, 50);
            completionWrittenWhileHeld = existsSync(
              join(artDir, "events.ndjson"),
            );
            return "parent-held-lock";
          },
          1_000,
          "atomic",
        ),
      ).toBe("parent-held-lock");

      if (!childExit) throw new Error("generated CLI did not start");
      expect(await childExit, childStderr).toBe(0);
      expect(childStartedWhileHeld).toBe(true);
      expect(completionWrittenWhileHeld).toBe(false);
      const events = readFileSync(join(artDir, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) => event.type === "completion" && event.turnId === turnId,
        ),
      ).toHaveLength(1);
    });
  });

  describe("error", () => {
    it("writes an error event with message", () => {
      runCli(tmp, ["error", "boom"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("error");
      expect(ev.status).toBe("error");
      expect(ev.message).toBe("boom");
    });

    it("bounds generated CLI error text", () => {
      const message = "x".repeat(MAX_EVENT_TEXT_LENGTH + 10);
      const r = runCli(tmp, ["error", message]);

      expect(r.status).toBe(0);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.message).toBe("x".repeat(MAX_EVENT_TEXT_LENGTH));
      expect(ev.errorMessage).toBe("x".repeat(MAX_EVENT_TEXT_LENGTH));
    });
  });

  describe("cancelled", () => {
    it("writes a cancelled event", () => {
      runCli(tmp, ["cancelled"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("cancelled");
      expect(ev.status).toBe("cancelled");
    });
  });

  describe("errors", () => {
    it("fails when ARTIFACT_DIR is unset", () => {
      // Spawn without ARTIFACT_DIR
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const r = spawnSync("node", [cliPath, "start"], {
        env: { ...process.env, ARTIFACT_DIR: "" },
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("ARTIFACT_DIR not set");
    });

    it("fails on unknown subcommand", () => {
      const r = runCli(tmp, ["bogus"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Unknown command");
    });
  });
});

describe("platform process-exit signals", () => {
  it.each(["SIGBUS", "SIGUSR1"] as const)(
    "uses the platform number for %s",
    (signal) => {
      const tmp = makeTmp();
      try {
        initializeCompletionLockProtocol(tmp);
        const exitCode = 128 + constants.signals[signal];
        expect(runCli(tmp, ["process-exit", String(exitCode)]).status).toBe(0);
        const event = JSON.parse(
          readFileSync(join(tmp, "events.ndjson"), "utf8")
            .trim()
            .split("\n")
            .at(-1)!,
        );
        expect(event).toMatchObject({
          type: "process_exited",
          exitCode,
          signal,
        });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(hostSignalName === undefined)(
    `preserves host-only ${hostSignalName ?? "signal"} through readEvents`,
    () => {
      const tmp = makeTmp();
      try {
        const art = artifactPath(tmp, "child");
        mkdirSync(art.dir);
        initializeCompletionLockProtocol(art.dir);
        const signalName = hostSignalName!;
        const signalNumber = platformSignals[signalName];
        const exitCode = 128 + signalNumber;
        expect(runCli(art.dir, ["process-exit", String(exitCode)]).status).toBe(
          0,
        );

        const signalAliases = Object.entries(platformSignals)
          .filter(([, number]) => number === signalNumber)
          .map(([signal]) => signal);
        const event = readEvents(art).at(-1);
        expect(event).toMatchObject({
          type: "process_exited",
          exitCode,
          terminationReason: "signal",
        });
        expect(event?.type === "process_exited" ? signalAliases : []).toContain(
          event?.type === "process_exited" ? event.signal : undefined,
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(["SIGINFO", "SIGSTKFLT"] as const)(
    "normalizes portable platform signal %s",
    (signal) => {
      const tmp = makeTmp();
      try {
        const art = artifactPath(tmp, "child");
        mkdirSync(art.dir);
        writeFileSync(
          art.statusFile,
          `${JSON.stringify({
            version: 2,
            eventId: `event-${signal}`,
            turnId: "turn",
            ts: 1,
            type: "process_exited",
            status: "error",
            exitCode: 157,
            terminationReason: "signal",
            signal,
          })}\n`,
        );

        expect(readEvents(art)).toMatchObject([
          {
            type: "process_exited",
            terminationReason: "signal",
            signal,
          },
        ]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
