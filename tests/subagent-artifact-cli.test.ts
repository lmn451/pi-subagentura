import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CLI_SOURCE, writeCliScript } from "../src/subagent-artifact-cli";
import {
  MAX_EVENT_TEXT_LENGTH,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  readEvents,
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

interface PromptErrorCall {
  turnId: string;
  message: string;
  previousUserEntryId?: string;
}

function runImportedReporter(
  artDir: string,
  calls: PromptErrorCall[],
): { status: number; stdout: string; stderr: string } {
  const cliPath = join(artDir, "cli.mjs");
  writeCliScript(cliPath);
  const cliUrl = pathToFileURL(cliPath).href;
  // The generated module is emitted under ARTIFACT_DIR, so its runtime import cannot be static.
  const source = [
    `const { reportPromptError } = await import(${JSON.stringify(cliUrl)});`,
    `for (const call of ${JSON.stringify(calls)}) {`,
    "  const result = reportPromptError(call.turnId, call.message, call.previousUserEntryId);",
    "  if (result !== undefined || result instanceof Promise) {",
    "    throw new Error('reportPromptError must synchronously return undefined');",
    "  }",
    "}",
  ].join("\n");
  const res = spawnSync("node", ["--input-type=module", "-e", source], {
    env: { ...process.env, ARTIFACT_DIR: artDir },
    encoding: "utf8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

describe("subagent-artifact CLI", () => {
  let tmp: string;
  let spawnedChildren: ReturnType<typeof spawn>[];

  beforeEach(() => {
    tmp = makeTmp();
    spawnedChildren = [];
  });

  afterEach(async () => {
    const exits = spawnedChildren.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
        }),
    );
    for (const child of spawnedChildren) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(exits);
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
  describe("prompt errors", () => {
    it("imports without dispatch and keeps direct CLI execution through symlinks", () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const cliUrl = pathToFileURL(cliPath).href;
      // The generated module is created in the artifact directory, so its import boundary must be exercised dynamically.
      const imported = spawnSync(
        "node",
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(cliUrl)});`,
        ],
        { env: { ...process.env, ARTIFACT_DIR: "" }, encoding: "utf8" },
      );
      expect(imported.status).toBe(0);
      expect(existsSync(join(tmp, "events.ndjson"))).toBe(false);

      const linkedCliPath = join(tmp, "linked-cli.mjs");
      symlinkSync(cliPath, linkedCliPath);
      const executed = spawnSync("node", [linkedCliPath, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: tmp },
        encoding: "utf8",
      });
      expect(executed.status).toBe(0);
      const event = JSON.parse(
        readFileSync(join(tmp, "events.ndjson"), "utf8"),
      );
      expect(event).toMatchObject({
        type: "completion",
        outcome: "done",
        source: "explicit",
        exitCode: 0,
      });
    });

    it("reports raw pre-turn errors with distinct Pi IDs, empty snapshots, and process-exit dedup", () => {
      const manager = SessionManager.create(tmp, join(tmp, "sessions"));
      const previousUserEntryId = manager.appendMessage({
        role: "user",
        content: "previous user turn",
        timestamp: Date.now(),
      });
      const failedTurnId = manager.appendCustomEntry(
        "subagentura-prompt-error",
        { schemaVersion: 1 },
      );
      const oversizedTurnId = manager.appendCustomEntry(
        "subagentura-prompt-error",
        { schemaVersion: 1 },
      );
      const symlinkTurnId = manager.appendCustomEntry(
        "subagentura-prompt-error",
        { schemaVersion: 1 },
      );
      const recoveredTurnId = manager.appendMessage({
        role: "user",
        content: "recovery turn",
        timestamp: Date.now(),
      });
      const outputPath = join(tmp, "output.md");
      const staleOutput = "stale output from a prior turn";
      writeFileSync(outputPath, staleOutput);
      const rawMessage =
        'provider error: {"credential":"not-redacted"}\u0000\n\u001b[31mraw\u001b[0m';

      const firstReport = runImportedReporter(tmp, [
        {
          turnId: failedTurnId,
          message: rawMessage,
          previousUserEntryId,
        },
        { turnId: failedTurnId, message: "must not replace first report" },
      ]);
      expect(firstReport.status).toBe(0);
      let events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      let completion = events.find(
        (event) => event.type === "completion" && event.turnId === failedTurnId,
      );
      expect(completion).toMatchObject({
        version: 2,
        status: "error",
        outcome: "error",
        source: "prompt_error",
        exitCode: 1,
        message: rawMessage,
        errorMessage: rawMessage,
        output: { bytes: 0 },
      });
      expect(readFileSync(completion.output.path, "utf8")).toBe("");
      const parsedCompletion = readEvents({
        id: failedTurnId,
        dir: tmp,
        statusFile: join(tmp, "events.ndjson"),
        outputFile: outputPath,
      }).find(
        (event) => event.type === "completion" && event.turnId === failedTurnId,
      );
      expect(parsedCompletion).toMatchObject({
        source: "prompt_error",
        outcome: "error",
        output: { bytes: 0 },
      });
      expect(readFileSync(outputPath, "utf8")).toBe(staleOutput);
      expect(
        events.filter(
          (event) =>
            event.type === "completion" && event.turnId === failedTurnId,
        ),
      ).toHaveLength(1);
      expect(events.some((event) => event.type === "turn_started")).toBe(false);
      expect(
        JSON.parse(readFileSync(join(tmp, "active-turn.json"), "utf8")),
      ).toMatchObject({
        turnId: failedTurnId,
        started: false,
        previousUserEntryId,
      });

      expect(runCli(tmp, ["process-exit", "1"]).status).toBe(0);
      events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) =>
            event.type === "completion" && event.turnId === failedTurnId,
        ),
      ).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "process_exited",
        turnId: failedTurnId,
        exitCode: 1,
      });

      const newerActiveTurn = JSON.stringify({
        turnId: recoveredTurnId,
        started: true,
        previousUserEntryId,
      });
      writeFileSync(join(tmp, "active-turn.json"), newerActiveTurn);
      expect(
        runImportedReporter(tmp, [
          {
            turnId: failedTurnId,
            message: "late duplicate must not reset active metadata",
          },
        ]).status,
      ).toBe(0);
      expect(readFileSync(join(tmp, "active-turn.json"), "utf8")).toBe(
        newerActiveTurn,
      );
      events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter(
          (event) =>
            event.type === "completion" && event.turnId === failedTurnId,
        ),
      ).toHaveLength(1);

      const oversizedOutput = Buffer.alloc(MAX_OUTPUT_SNAPSHOT_BYTES + 1, 120);
      writeFileSync(outputPath, oversizedOutput);
      const longMessage = "x".repeat(MAX_EVENT_TEXT_LENGTH + 10);
      const oversizedReport = runImportedReporter(tmp, [
        { turnId: oversizedTurnId, message: longMessage },
      ]);
      expect(oversizedReport.status).toBe(0);
      events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      completion = events.find(
        (event) =>
          event.type === "completion" && event.turnId === oversizedTurnId,
      );
      expect(completion).toMatchObject({
        source: "prompt_error",
        exitCode: 1,
        message: longMessage,
        errorMessage: longMessage,
        output: { bytes: 0 },
      });
      expect(completion).not.toHaveProperty("outputError");
      expect(readFileSync(completion.output.path)).toEqual(Buffer.alloc(0));
      const parsedOversizedCompletion = readEvents({
        id: oversizedTurnId,
        dir: tmp,
        statusFile: join(tmp, "events.ndjson"),
        outputFile: outputPath,
      }).find(
        (event) =>
          event.type === "completion" && event.turnId === oversizedTurnId,
      );
      expect(parsedOversizedCompletion).toMatchObject({
        source: "prompt_error",
        outcome: "error",
        message: longMessage,
        errorMessage: longMessage,
      });
      expect(readFileSync(outputPath)).toEqual(oversizedOutput);

      rmSync(outputPath);
      const stagedOutputPath = join(tmp, "staged-output.md");
      const stagedOutput = "symlinked stale output";
      writeFileSync(stagedOutputPath, stagedOutput);
      symlinkSync(stagedOutputPath, outputPath);
      const symlinkReport = runImportedReporter(tmp, [
        { turnId: symlinkTurnId, message: "symlink staging remains untouched" },
      ]);
      expect(symlinkReport.status).toBe(0);
      expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(stagedOutputPath, "utf8")).toBe(stagedOutput);
      events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      completion = events.find(
        (event) =>
          event.type === "completion" && event.turnId === symlinkTurnId,
      );
      expect(completion).toMatchObject({
        source: "prompt_error",
        exitCode: 1,
        output: { bytes: 0 },
      });
      expect(completion).not.toHaveProperty("outputError");
      expect(readFileSync(completion.output.path)).toEqual(Buffer.alloc(0));

      rmSync(outputPath);
      writeFileSync(outputPath, "normal recovery output");
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId: recoveredTurnId, started: true }),
      );
      expect(runCli(tmp, ["done", "0"]).status).toBe(0);
      events = readFileSync(join(tmp, "events.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      completion = events.find(
        (event) =>
          event.type === "completion" && event.turnId === recoveredTurnId,
      );
      expect(completion).toMatchObject({
        type: "completion",
        outcome: "done",
        source: "explicit",
        exitCode: 0,
      });
      expect(readFileSync(completion.output.path, "utf8")).toBe(
        "normal recovery output",
      );
      expect(
        new Set(
          events
            .filter((event) => event.type === "completion")
            .map((event) => event.turnId),
        ).size,
      ).toBe(4);
    });
    it.each(["parent API", "CLI command"])(
      "serializes real prompt-error publication with %s cancellation",
      async (cancellationWriter) => {
        const cliPath = join(tmp, "cli.mjs");
        writeCliScript(cliPath);
        const cliUrl = pathToFileURL(cliPath).href;
        const moduleUrl = pathToFileURL(
          join(process.cwd(), "src", "interactive-tmux.ts"),
        ).href;
        const pausedPath = join(tmp, "reporter-paused");
        const releasePath = join(tmp, "release-reporter");
        const waitingPath = join(tmp, "cancellation-waiting");
        const observerPath = join(tmp, "lock-observer.mjs");
        const attemptTurnId = "pi-prompt-attempt";
        const previousTurnId = "previous-pi-turn";
        const eventsPath = join(tmp, "events.ndjson");
        writeFileSync(
          join(tmp, "active-turn.json"),
          JSON.stringify({ turnId: previousTurnId, started: true }),
        );
        const reporterSource = `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const append = fs.appendFileSync.bind(fs);
          fs.appendFileSync = (path, data, ...args) => {
            if (String(path) === ${JSON.stringify(eventsPath)}) {
              const event = JSON.parse(String(data));
              if (event.type === "completion" && event.source === "prompt_error") {
                fs.writeFileSync(${JSON.stringify(pausedPath)}, "");
                const waiter = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(${JSON.stringify(releasePath)})) {
                  Atomics.wait(waiter, 0, 0, 10);
                }
              }
            }
            return append(path, data, ...args);
          };
          syncBuiltinESMExports();
          const { reportPromptError } = await import(${JSON.stringify(cliUrl)});
          reportPromptError(${JSON.stringify(attemptTurnId)}, "raw provider rejection", ${JSON.stringify(previousTurnId)});
        `;
        const reporter = spawn(
          process.execPath,
          ["--input-type=module", "-e", reporterSource],
          {
            env: { ...process.env, ARTIFACT_DIR: tmp },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        spawnedChildren.push(reporter);
        const reporterResult = waitForChild(reporter);
        await vi.waitFor(() => expect(existsSync(pausedPath)).toBe(true), {
          timeout: 5_000,
          interval: 10,
        });

        const loaderPath = join(tmp, "ts-loader.mjs");
        const settingsStubPath = join(tmp, "settings-stub.mjs");
        writeFileSync(
          settingsStubPath,
          "export const getSetting = () => undefined;",
        );
        writeFileSync(
          loaderPath,
          `import { existsSync } from "node:fs";
           import { fileURLToPath, pathToFileURL } from "node:url";
           export async function resolve(specifier, context, nextResolve) {
             if (specifier === "@juanibiapina/pi-extension-settings") {
               return {
                 url: pathToFileURL(
                   ${JSON.stringify(settingsStubPath)}
                 ).href,
                 shortCircuit: true,
               };
             }
             if (specifier.startsWith(".") && !/\\.[a-z0-9]+$/i.test(specifier)) {
               for (const suffix of [".ts", ".mjs", ".js"]) {
                 const candidate = new URL(specifier + suffix, context.parentURL);
                 if (existsSync(fileURLToPath(candidate))) {
                   return { url: pathToFileURL(fileURLToPath(candidate)).href, shortCircuit: true };
                 }
               }
             }
             return nextResolve(specifier, context);
           }`,
        );
        writeFileSync(
          observerPath,
          `import fs from "node:fs";
           import { syncBuiltinESMExports } from "node:module";
           const rename = fs.renameSync.bind(fs);
          fs.renameSync = (source, destination, ...args) => {
            if (String(destination).endsWith(".active-turn.lock")) {
              fs.writeFileSync(${JSON.stringify(waitingPath)}, "");
            }
            return rename(source, destination, ...args);
          };
           syncBuiltinESMExports();`,
        );
        const state = {
          id: "cancel-race-agent",
          name: "cancel race",
          task: "cancel race",
          paneId: "%42",
          mux: "tmux",
          sessionFile: join(tmp, "child-session.jsonl"),
          cwd: tmp,
          startedAt: Date.now(),
          status: "running",
          attachCommand: "",
          selectPaneCommand: "",
          launchScriptFile: join(tmp, "launch.sh"),
          artifactDir: tmp,
        };
        const cancellationSource = `
          import childProcess from "node:child_process";
              import { syncBuiltinESMExports } from "node:module";
          childProcess.execFileSync = () => "";
              syncBuiltinESMExports();
          const { cancelInteractiveSubagent } = await import(${JSON.stringify(moduleUrl)});
          cancelInteractiveSubagent(${JSON.stringify(state.id)}, "cancel_interactive_subagent", ${JSON.stringify(state)});
        `;
        const cancellationArgs =
          cancellationWriter === "CLI command"
            ? ["--import", observerPath, cliPath, "cancelled"]
            : [
                "--no-warnings",
                "--experimental-strip-types",
                "--loader",
                loaderPath,
                "--import",
                observerPath,
                "--input-type=module",
                "-e",
                cancellationSource,
              ];
        const cancellation = spawn(process.execPath, cancellationArgs, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ARTIFACT_DIR: tmp,
            SUBAGENT_CANCEL_SNAPSHOT: "",
            SUBAGENT_CANCEL_SNAPSHOT_DIR: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        spawnedChildren.push(cancellation);
        const cancellationResult = waitForChild(cancellation);
        const hasParentCancellation = () => {
          if (!existsSync(eventsPath)) return false;
          return readFileSync(eventsPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .some((line) => {
              try {
                const event = JSON.parse(line);
                return (
                  event.type === "completion" &&
                  event.source === "parent" &&
                  event.outcome === "cancelled"
                );
              } catch (error) {
                if (error instanceof SyntaxError) return false;
                throw error;
              }
            });
        };
        await vi.waitFor(
          () => {
            expect(
              existsSync(waitingPath) ||
                hasParentCancellation() ||
                cancellation.exitCode !== null,
            ).toBe(true);
          },
          { timeout: 5_000, interval: 10 },
        );
        const cancellationHadToWait = existsSync(waitingPath);
        if (!cancellationHadToWait && !hasParentCancellation()) {
          writeFileSync(releasePath, "");
          const result = await cancellationResult;
          throw new Error(`cancellation writer failed: ${result.stderr}`);
        }
        writeFileSync(releasePath, "");

        const [reporterExit, cancellationExit] = await Promise.all([
          reporterResult,
          cancellationResult,
        ]);
        expect(reporterExit.status, reporterExit.stderr).toBe(0);
        expect(cancellationExit.status, cancellationExit.stderr).toBe(0);

        const events = readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const promptErrorIndex = events.findIndex(
          (event) =>
            event.type === "completion" && event.source === "prompt_error",
        );
        const cancellationIndex = events.findIndex(
          (event) =>
            event.type === "completion" &&
            event.source === "parent" &&
            event.outcome === "cancelled",
        );
        expect(promptErrorIndex).toBeGreaterThanOrEqual(0);
        expect(cancellationIndex).toBeGreaterThan(promptErrorIndex);
        expect(events[promptErrorIndex]).toMatchObject({
          turnId: attemptTurnId,
          errorMessage: "raw provider rejection",
        });
        expect(events[cancellationIndex].turnId).not.toBe(previousTurnId);
        expect(readFileSync(join(tmp, "active-turn.json"), "utf8")).toContain(
          attemptTurnId,
        );
        expect(existsSync(join(tmp, ".cancelled"))).toBe(true);
      },
    );
  });
  describe("terminal publication", () => {
    it.each(["done", "error"])(
      "does not publish a late CLI %s completion after cancellation seals the active turn",
      async (command) => {
        const cliPath = join(tmp, "cli.mjs");
        writeCliScript(cliPath);
        const eventsPath = join(tmp, "events.ndjson");
        const pausedPath = join(tmp, "terminal-writer-paused");
        const releasePath = join(tmp, "release-terminal-writer");
        const preloadPath = join(tmp, "pause-terminal-writer.mjs");
        const oldTurnId = "previous-turn";
        const activeTurnId = "active-turn";
        const history = {
          version: 2,
          eventId: "historical-event",
          turnId: "historical-turn",
          ts: 1,
          type: "completion",
          status: "done",
          outcome: "done",
          source: "explicit",
          exitCode: 0,
        };
        const commandArgs =
          command === "done" ? ["done", "0"] : ["error", "raw terminal error"];
        writeFileSync(eventsPath, JSON.stringify(history) + "\n");
        writeFileSync(
          join(tmp, "active-turn.json"),
          JSON.stringify({ turnId: oldTurnId, started: true }),
        );
        writeFileSync(
          preloadPath,
          `
            import fs from "node:fs";
            import { syncBuiltinESMExports } from "node:module";
            const activeTurnFile = ${JSON.stringify(join(tmp, "active-turn.json"))};
            const open = fs.openSync.bind(fs);
            const read = fs.readSync.bind(fs);
            const close = fs.closeSync.bind(fs);
            const activeTurnDescriptors = new Set();
            let paused = false;
            fs.openSync = (path, ...args) => {
              const fd = open(path, ...args);
              if (String(path) === activeTurnFile) activeTurnDescriptors.add(fd);
              return fd;
            };
            fs.readSync = (fd, ...args) => {
              const bytesRead = read(fd, ...args);
              if (activeTurnDescriptors.has(fd) && !paused) {
                paused = true;
                fs.writeFileSync(${JSON.stringify(pausedPath)}, "");
                const waiter = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(${JSON.stringify(releasePath)})) {
                  Atomics.wait(waiter, 0, 0, 10);
                }
              }
              return bytesRead;
            };
            fs.closeSync = (fd, ...args) => {
              activeTurnDescriptors.delete(fd);
              return close(fd, ...args);
            };
            syncBuiltinESMExports();
          `,
        );

        const terminalWriter = spawn(
          process.execPath,
          ["--import", preloadPath, cliPath, ...commandArgs],
          {
            env: { ...process.env, ARTIFACT_DIR: tmp },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        spawnedChildren.push(terminalWriter);
        const terminalWriterResult = waitForChild(terminalWriter);
        await vi.waitFor(() => expect(existsSync(pausedPath)).toBe(true), {
          timeout: 5_000,
          interval: 10,
        });

        writeFileSync(
          join(tmp, "active-turn.json"),
          JSON.stringify({ turnId: activeTurnId, started: true }),
        );
        const cancellation = spawnSync(
          process.execPath,
          [cliPath, "cancelled"],
          {
            env: { ...process.env, ARTIFACT_DIR: tmp },
            encoding: "utf8",
          },
        );
        expect(cancellation.status, cancellation.stderr).toBe(0);
        writeFileSync(releasePath, "");

        const terminalResult = await terminalWriterResult;
        expect(terminalResult.status, terminalResult.stderr).toBe(0);
        const events = readFileSync(eventsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events[0]).toEqual(history);
        expect(
          events.filter(
            (event) =>
              event.type === "completion" && event.turnId === oldTurnId,
          ),
        ).toEqual([]);
        const cancellationEvents = events.filter(
          (event) =>
            event.type === "completion" && event.turnId === activeTurnId,
        );
        expect(cancellationEvents).toHaveLength(1);
        expect(cancellationEvents[0]).toMatchObject({
          outcome: "cancelled",
          source: "parent",
        });
        expect(existsSync(join(tmp, ".cancelled"))).toBe(true);
      },
    );

    it("does not let a delayed stale-lock waiter unlink a fresh active-turn owner", async () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const lockPath = join(tmp, ".active-turn.lock");
      const firstHoldsPath = join(tmp, "first-owner-holds-lock");
      const releaseFirstPath = join(tmp, "release-first-owner");
      const secondObservedPath = join(tmp, "second-observed-stale-lock");
      const releaseSecondStatPath = join(tmp, "release-second-stale-stat");
      const secondAttemptedPath = join(tmp, "second-retried-active-lock");
      const secondAcquiredPath = join(tmp, "second-acquired-active-lock");
      const firstPreloadPath = join(tmp, "first-lock-owner.mjs");
      const secondPreloadPath = join(tmp, "second-lock-waiter.mjs");
      mkdirSync(lockPath, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({
          pid: 999_999_999,
          token: "11111111-1111-4111-8111-111111111111",
          createdAt: Date.now() - 120_000,
        }),
      );
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId: "stale-lock-turn", started: true }),
      );
      writeFileSync(
        firstPreloadPath,
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const remove = fs.rmSync.bind(fs);
          const rename = fs.renameSync.bind(fs);
          const append = fs.appendFileSync.bind(fs);
          const waitForSecond = () => {
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(${JSON.stringify(secondObservedPath)})) {
              Atomics.wait(waiter, 0, 0, 10);
            }
          };
          fs.rmSync = (path, ...args) => {
            if (String(path) === ${JSON.stringify(lockPath)}) waitForSecond();
            return remove(path, ...args);
          };
          fs.renameSync = (from, to, ...args) => {
            if (
              String(from) === ${JSON.stringify(lockPath)} &&
              String(to).startsWith(${JSON.stringify(lockPath + ".reclaimed-")})
            ) {
              waitForSecond();
            }
            return rename(from, to, ...args);
          };
          fs.appendFileSync = (path, data, ...args) => {
            if (String(path) === ${JSON.stringify(join(tmp, "events.ndjson"))}) {
              const event = JSON.parse(String(data));
              if (event.type === "completion" && event.source === "parent") {
                fs.writeFileSync(${JSON.stringify(firstHoldsPath)}, "");
                const waiter = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(${JSON.stringify(releaseFirstPath)})) {
                  Atomics.wait(waiter, 0, 0, 10);
                }
              }
            }
            return append(path, data, ...args);
          };
          syncBuiltinESMExports();
        `,
      );
      writeFileSync(
        secondPreloadPath,
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const stat = fs.statSync.bind(fs);
          const open = fs.openSync.bind(fs);
          const read = fs.readSync.bind(fs);
          const close = fs.closeSync.bind(fs);
          const mkdir = fs.mkdirSync.bind(fs);
          const rename = fs.renameSync.bind(fs);
          const ownerPath = ${JSON.stringify(join(lockPath, "owner.json"))};
          const ownerDescriptors = new Set();
          let observed = false;
          let lockMkdirAttempts = 0;
          const markSecondAttempt = () => {
            if (fs.existsSync(${JSON.stringify(releaseSecondStatPath)})) {
              fs.writeFileSync(${JSON.stringify(secondAttemptedPath)}, "");
            }
          };
          const markSecondAcquired = () => {
            fs.writeFileSync(${JSON.stringify(secondAcquiredPath)}, "");
            markSecondAttempt();
          };
          const observeSecond = () => {
            if (observed) return;
            observed = true;
            fs.writeFileSync(${JSON.stringify(secondObservedPath)}, "");
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(${JSON.stringify(releaseSecondStatPath)})) {
              Atomics.wait(waiter, 0, 0, 10);
            }
          };
          fs.statSync = (path, ...args) => {
            const result = stat(path, ...args);
            if (String(path) === ${JSON.stringify(lockPath)}) observeSecond();
            return result;
          };
          fs.openSync = (path, ...args) => {
            const fd = open(path, ...args);
            if (String(path) === ownerPath) ownerDescriptors.add(fd);
            return fd;
          };
          fs.readSync = (fd, ...args) => {
            const bytesRead = read(fd, ...args);
            if (ownerDescriptors.has(fd)) observeSecond();
            return bytesRead;
          };
          fs.closeSync = (fd, ...args) => {
            ownerDescriptors.delete(fd);
            return close(fd, ...args);
          };
          fs.mkdirSync = (path, ...args) => {
            if (String(path) !== ${JSON.stringify(lockPath)}) {
              return mkdir(path, ...args);
            }
            lockMkdirAttempts += 1;
            try {
              const result = mkdir(path, ...args);
              if (lockMkdirAttempts > 1) markSecondAcquired();
              return result;
            } catch (error) {
              if (lockMkdirAttempts > 1) markSecondAttempt();
              throw error;
            }
          };
          fs.renameSync = (from, to, ...args) => {
            try {
              const result = rename(from, to, ...args);
              if (String(to) === ${JSON.stringify(lockPath)}) {
                markSecondAcquired();
              } else if (String(from) === ${JSON.stringify(lockPath)}) {
                markSecondAttempt();
              }
              return result;
            } catch (error) {
              if (
                String(to) === ${JSON.stringify(lockPath)} ||
                String(from) === ${JSON.stringify(lockPath)}
              ) {
                markSecondAttempt();
              }
              throw error;
            }
          };
          syncBuiltinESMExports();
        `,
      );

      const first = spawn(
        process.execPath,
        ["--import", firstPreloadPath, cliPath, "cancelled"],
        {
          env: { ...process.env, ARTIFACT_DIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedChildren.push(first);
      const firstResult = waitForChild(first);
      const second = spawn(
        process.execPath,
        ["--import", secondPreloadPath, cliPath, "cancelled"],
        {
          env: { ...process.env, ARTIFACT_DIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedChildren.push(second);
      const secondResult = waitForChild(second);
      await vi.waitFor(() => expect(existsSync(firstHoldsPath)).toBe(true), {
        timeout: 5_000,
        interval: 10,
      });
      writeFileSync(releaseSecondStatPath, "");
      await vi.waitFor(
        () => expect(existsSync(secondAttemptedPath)).toBe(true),
        { timeout: 5_000, interval: 10 },
      );
      expect(existsSync(secondAcquiredPath)).toBe(false);

      writeFileSync(releaseFirstPath, "");
      const [firstExit, secondExit] = await Promise.all([
        firstResult,
        secondResult,
      ]);
      expect(firstExit.status, firstExit.stderr).toBe(0);
      expect(secondExit.status, secondExit.stderr).toBe(0);
    });
    it("protects a fresh owner from a delayed waiter that observed an aged live owner", async () => {
      const cliPath = join(tmp, "cli.mjs");
      writeCliScript(cliPath);
      const lockPath = join(tmp, ".active-turn.lock");
      const ownerPath = join(lockPath, "owner.json");
      const eventsPath = join(tmp, "events.ndjson");
      const turnId = "delayed-live-owner-turn";
      const firstPreloadPath = join(tmp, "aged-live-owner.mjs");
      const secondPreloadPath = join(tmp, "delayed-reclaimer.mjs");
      const thirdPreloadPath = join(tmp, "fresh-owner.mjs");
      const firstHoldsPath = join(tmp, "first-owner-holds-lock");
      const releaseFirstPath = join(tmp, "release-first-owner");
      const secondKillWaitingPath = join(tmp, "second-waits-on-live-owner");
      const releaseSecondKillPath = join(tmp, "release-second-liveness-check");
      const secondRenameWaitingPath = join(
        tmp,
        "second-waits-before-stale-rename",
      );
      const releaseSecondRenamePath = join(tmp, "release-second-stale-rename");
      const secondRenameAttemptedPath = join(
        tmp,
        "second-stale-rename-attempted",
      );
      const secondAcquiredPath = join(tmp, "second-acquired-fresh-slot");
      const thirdHoldsPath = join(tmp, "third-owner-holds-lock");
      const releaseThirdPath = join(tmp, "release-third-owner");
      const thirdOwnerTokenPath = join(tmp, "third-owner-token");
      writeFileSync(
        join(tmp, "active-turn.json"),
        JSON.stringify({ turnId, started: true }),
      );
      writeFileSync(
        firstPreloadPath,
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const append = fs.appendFileSync.bind(fs);
          const rename = fs.renameSync.bind(fs);
          fs.renameSync = (from, to, ...args) => {
            const result = rename(from, to, ...args);
            if (String(to) === ${JSON.stringify(lockPath)}) {
              const owner = JSON.parse(fs.readFileSync(${JSON.stringify(ownerPath)}, "utf8"));
              owner.createdAt = Date.now() - 120_000;
              fs.writeFileSync(${JSON.stringify(ownerPath)}, JSON.stringify(owner));
            }
            return result;
          };
          fs.appendFileSync = (path, data, ...args) => {
            if (String(path) === ${JSON.stringify(eventsPath)}) {
              const event = JSON.parse(String(data));
              if (event.type === "completion" && event.turnId === ${JSON.stringify(turnId)}) {
                fs.writeFileSync(${JSON.stringify(firstHoldsPath)}, "");
                const waiter = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(${JSON.stringify(releaseFirstPath)})) {
                  Atomics.wait(waiter, 0, 0, 10);
                }
              }
            }
            return append(path, data, ...args);
          };
          syncBuiltinESMExports();
        `,
      );
      const first = spawn(
        process.execPath,
        ["--import", firstPreloadPath, cliPath, "done", "0"],
        {
          env: { ...process.env, ARTIFACT_DIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedChildren.push(first);
      const firstResult = waitForChild(first);
      const firstPid = first.pid;
      if (firstPid === undefined) throw new Error("first child has no PID");
      await vi.waitFor(() => expect(existsSync(firstHoldsPath)).toBe(true), {
        timeout: 5_000,
        interval: 10,
      });
      writeFileSync(
        secondPreloadPath,
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const kill = process.kill.bind(process);
          const rename = fs.renameSync.bind(fs);
          let delayedLivenessCheck = false;
          let delayedRename = false;
          const waitFor = (path) => {
            const waiter = new Int32Array(new SharedArrayBuffer(4));
            while (!fs.existsSync(path)) Atomics.wait(waiter, 0, 0, 10);
          };
          process.kill = (pid, signal) => {
            if (pid === ${firstPid} && signal === 0 && !delayedLivenessCheck) {
              delayedLivenessCheck = true;
              fs.writeFileSync(${JSON.stringify(secondKillWaitingPath)}, "");
              waitFor(${JSON.stringify(releaseSecondKillPath)});
            }
            return kill(pid, signal);
          };
          fs.renameSync = (from, to, ...args) => {
            const staleRename =
              String(from) === ${JSON.stringify(lockPath)} &&
              String(to).startsWith(${JSON.stringify(lockPath + ".reclaimed-")});
            if (staleRename && !delayedRename) {
              delayedRename = true;
              fs.writeFileSync(${JSON.stringify(secondRenameWaitingPath)}, "");
              waitFor(${JSON.stringify(releaseSecondRenamePath)});
            }
            try {
              const result = rename(from, to, ...args);
              if (staleRename) fs.writeFileSync(${JSON.stringify(secondRenameAttemptedPath)}, "");
              if (String(to) === ${JSON.stringify(lockPath)}) {
                fs.writeFileSync(${JSON.stringify(secondAcquiredPath)}, "");
              }
              return result;
            } catch (error) {
              if (staleRename) fs.writeFileSync(${JSON.stringify(secondRenameAttemptedPath)}, "");
              throw error;
            }
          };
          syncBuiltinESMExports();
        `,
      );
      const second = spawn(
        process.execPath,
        ["--import", secondPreloadPath, cliPath, "error", "delayed duplicate"],
        {
          env: { ...process.env, ARTIFACT_DIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedChildren.push(second);
      const secondResult = waitForChild(second);
      await vi.waitFor(
        () => expect(existsSync(secondKillWaitingPath)).toBe(true),
        { timeout: 5_000, interval: 10 },
      );

      writeFileSync(releaseFirstPath, "");
      const firstExit = await firstResult;
      expect(firstExit.status, firstExit.stderr).toBe(0);
      writeFileSync(releaseSecondKillPath, "");
      await vi.waitFor(
        () => expect(existsSync(secondRenameWaitingPath)).toBe(true),
        { timeout: 5_000, interval: 10 },
      );
      writeFileSync(
        thirdPreloadPath,
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          const append = fs.appendFileSync.bind(fs);
          const rename = fs.renameSync.bind(fs);
          fs.renameSync = (from, to, ...args) => {
            const result = rename(from, to, ...args);
            if (String(to) === ${JSON.stringify(lockPath)}) {
              const owner = JSON.parse(fs.readFileSync(${JSON.stringify(ownerPath)}, "utf8"));
              fs.writeFileSync(${JSON.stringify(thirdOwnerTokenPath)}, owner.token);
            }
            return result;
          };
          fs.appendFileSync = (path, data, ...args) => {
            if (String(path) === ${JSON.stringify(eventsPath)}) {
              const event = JSON.parse(String(data));
              if (event.type === "process_exited") {
                fs.writeFileSync(${JSON.stringify(thirdHoldsPath)}, "");
                const waiter = new Int32Array(new SharedArrayBuffer(4));
                while (!fs.existsSync(${JSON.stringify(releaseThirdPath)})) {
                  Atomics.wait(waiter, 0, 0, 10);
                }
              }
            }
            return append(path, data, ...args);
          };
          syncBuiltinESMExports();
        `,
      );
      const third = spawn(
        process.execPath,
        ["--import", thirdPreloadPath, cliPath, "process-exit", "1"],
        {
          env: { ...process.env, ARTIFACT_DIR: tmp },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      spawnedChildren.push(third);
      const thirdResult = waitForChild(third);
      await vi.waitFor(() => expect(existsSync(thirdHoldsPath)).toBe(true), {
        timeout: 5_000,
        interval: 10,
      });
      const thirdOwnerToken = readFileSync(thirdOwnerTokenPath, "utf8");
      expect(JSON.parse(readFileSync(ownerPath, "utf8")).token).toBe(
        thirdOwnerToken,
      );

      writeFileSync(releaseSecondRenamePath, "");
      await vi.waitFor(
        () => expect(existsSync(secondRenameAttemptedPath)).toBe(true),
        { timeout: 5_000, interval: 10 },
      );
      const acquiredWhileThirdHeld = existsSync(secondAcquiredPath);
      const thirdStillOwnsLock =
        existsSync(ownerPath) &&
        JSON.parse(readFileSync(ownerPath, "utf8")).token === thirdOwnerToken;
      writeFileSync(releaseThirdPath, "");
      const [secondExit, thirdExit] = await Promise.all([
        secondResult,
        thirdResult,
      ]);
      expect(secondExit.status, secondExit.stderr).toBe(0);
      expect(thirdExit.status, thirdExit.stderr).toBe(0);
      expect(acquiredWhileThirdHeld).toBe(false);
      expect(thirdStillOwnsLock).toBe(true);
      const events = readEvents({
        id: "delayed-live-owner",
        dir: tmp,
        statusFile: eventsPath,
        outputFile: join(tmp, "output.md"),
      });
      expect(
        events.filter(
          (event) => event.type === "completion" && event.turnId === turnId,
        ),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) => event.type === "process_exited" && event.turnId === turnId,
        ),
      ).toBe(true);
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
