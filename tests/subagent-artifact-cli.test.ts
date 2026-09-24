import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { CLI_SOURCE, writeCliScript } from "../src/subagent-artifact-cli";
import {
  MAX_EVENT_TEXT_LENGTH,
  MAX_OUTPUT_SNAPSHOT_BYTES,
} from "../src/artifact";

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
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("source", () => {
    it("starts with a shebang", () => {
      expect(CLI_SOURCE.startsWith("#!/usr/bin/env node")).toBe(true);
    });

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

  describe("start", () => {
    it("writes a started event", () => {
      const r = runCli(tmp, ["start"]);
      expect(r.status).toBe(0);
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n");
      expect(events).toHaveLength(1);
      const ev = JSON.parse(events[0]);
      expect(ev.type).toBe("started");
      expect(ev.status).toBe("running");
      expect(typeof ev.ts).toBe("number");
    });
  });

  describe("done", () => {
    it("writes a done event with exit code 0 → status done", () => {
      runCli(tmp, ["done", "0"]);
      const ev = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8").trim(),
      );
      expect(ev.type).toBe("completion");
      expect(ev.outcome).toBe("done");
      expect(ev.status).toBe("done");
      expect(ev.exitCode).toBe(0);
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
          processExitPhase: "active_tool",
          processExitKind: "unknown",
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
        processExitPhase: "after_completion",
        processExitKind: "normal",
      });
      expect(events.at(-1)).not.toHaveProperty("lastTool");
    });

    it("does not infer a signal from a signal-like exit status", () => {
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
        terminationReason: "nonzero_exit",
        processExitPhase: "unknown",
        processExitKind: "nonzero",
      });
      expect(events.at(-1)).not.toHaveProperty("signal");
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
        processExitPhase: "unknown",
        processExitKind: "nonzero",
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
        processExitPhase: "unknown",
        processExitKind: "unknown",
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
        processExitPhase: "unknown",
        processExitKind: "unknown",
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
      const events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "completion",
        source: "process_exit",
        outcome: "cancelled",
        exitCode: 143,
        processExitPhase: "active_tool",
        processExitKind: "cancelled",
      });
      expect(events[1]).toMatchObject({
        type: "process_exited",
        status: "cancelled",
        terminationReason: "cancelled",
        processExitPhase: "active_tool",
        processExitKind: "cancelled",
        lastTool: "bash",
      });
      expect(events[1]).not.toHaveProperty("signal");

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
      const event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8")
          .trim()
          .split("\n")
          .at(-1)!,
      );
      expect(event).toMatchObject({
        type: "process_exited",
        terminationReason: "normal_exit",
        processExitPhase: "after_completion",
        processExitKind: "normal",
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
      await Promise.all(
        commands.map(
          (args) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn("node", [cliPath, ...args], {
                env: { ...process.env, ARTIFACT_DIR: tmp },
              });
              child.once("error", reject);
              child.once("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`completion writer exited ${code}`));
              });
            }),
        ),
      );

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

describe("process-exit hardening regressions", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not infer an observed signal from a numeric exit status", () => {
    const result = runCli(dir, ["process-exit", "143"]);
    expect(result.status).toBe(0);
    const events = readFileSync(join(dir, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      processExitPhase: "unknown",
      processExitKind: "nonzero",
      terminationReason: "nonzero_exit",
    });
    expect(events.at(-1)).not.toHaveProperty("signal");
  });

  it("preserves a nonzero process exit after turn completion", () => {
    expect(runCli(dir, ["done", "0"]).status).toBe(0);
    expect(runCli(dir, ["process-exit", "1"]).status).toBe(0);
    const events = readFileSync(join(dir, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      status: "error",
      exitCode: 1,
      terminationReason: "nonzero_exit",
      processExitPhase: "after_completion",
      processExitKind: "nonzero",
    });
  });
});
