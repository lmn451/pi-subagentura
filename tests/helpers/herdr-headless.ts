import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = resolve(SCRIPT, "../../..");
const TEST_TIMEOUT_MS = 240_000;

export function assertManagedHerdr(env: NodeJS.ProcessEnv): void {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
    throw new Error(
      "Herdr integration requires the binary and a managed pane " +
        "(HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID)",
    );
  }
  execFileSync("herdr", ["pane", "get", env.HERDR_PANE_ID], {
    env,
    stdio: "pipe",
    timeout: 5_000,
  });
}

export function assertHerdrResults(report: {
  success: boolean;
  numTotalTests: number;
  numPassedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  numFailedTests: number;
}): void {
  if (
    report.success !== true ||
    !Number.isInteger(report.numTotalTests) ||
    report.numTotalTests < 14 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numFailedTests !== 0
  ) {
    throw new Error(
      "Herdr coverage requires at least 14 passed tests and zero skips",
    );
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runInsidePane(root: string): void {
  let status = 1;
  const log = openSync(join(root, "vitest.log"), "w");
  try {
    // These values must be injected by the real server, not fabricated by CI.
    assertManagedHerdr(process.env);
    execFileSync(
      "npm",
      [
        "run",
        "test:herdr",
        "--",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${join(root, "results.json")}`,
      ],
      {
        cwd: REPO,
        env: { ...process.env, PI_SUBAGENTURA_HERDR_REQUIRED: "1" },
        stdio: ["ignore", log, log],
        timeout: TEST_TIMEOUT_MS,
      },
    );
    assertHerdrResults(
      JSON.parse(readFileSync(join(root, "results.json"), "utf8")),
    );
    status = 0;
  } catch (error) {
    writeFileSync(log, `${String(error)}\n`);
  } finally {
    closeSync(log);
    // Write only after the process and report checks have both completed.
    writeFileSync(join(root, "exit-code.tmp"), String(status));
    renameSync(join(root, "exit-code.tmp"), join(root, "exit-code"));
  }
  process.exitCode = status;
}

async function runHeadless(): Promise<void> {
  execFileSync("herdr", ["--version"], { stdio: "inherit", timeout: 5_000 });
  // Unix sockets have short path limits, including on macOS.
  const root = mkdtempSync("/tmp/ps-herdr-");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("HERDR_") ||
      ["ENV", "BASH_ENV", "NODE_OPTIONS"].includes(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, {
    HERDR_CONFIG_PATH: join(root, "config.toml"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    NO_COLOR: "1",
  });
  writeFileSync(
    env.HERDR_CONFIG_PATH!,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n' +
      "[update]\nversion_check = false\nmanifest_check = false\n",
  );
  const cli = (args: string[]) =>
    execFileSync("herdr", ["--session", "ci", ...args], {
      env,
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  const log = openSync(join(root, "server.log"), "w");
  const server = spawn("herdr", ["--session", "ci", "server"], {
    env,
    cwd: REPO,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  let serverError: Error | undefined;
  server.on("error", (error) => {
    serverError = error;
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const waitFor = async (predicate: () => boolean, timeout: number) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (interrupted) throw new Error("Herdr integration interrupted");
      if (serverError) throw serverError;
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error("Herdr server exited before the tests completed");
      }
      if (Date.now() >= deadline)
        throw new Error("Herdr integration timed out");
      await delay(100);
    }
  };
  let passed = false;
  try {
    await waitFor(() => {
      try {
        cli(["workspace", "list"]);
        return true;
      } catch {
        return false; /* Server may still be binding its socket. */
      }
    }, 15_000);
    const created = JSON.parse(
      cli([
        "workspace",
        "create",
        "--cwd",
        REPO,
        "--label",
        "integration",
        "--no-focus",
      ]),
    );
    const paneId = created.result.root_pane.pane_id;
    if (typeof paneId !== "string" || !paneId)
      throw new Error("No Herdr test pane");
    const command = [
      process.execPath,
      "--experimental-strip-types",
      SCRIPT,
      "--inside",
      root,
    ]
      .map(quote)
      .join(" ");
    cli(["pane", "run", paneId, command]);
    await waitFor(
      () => existsSync(join(root, "exit-code")),
      TEST_TIMEOUT_MS + 15_000,
    );
    process.stdout.write(readFileSync(join(root, "vitest.log"), "utf8"));
    if (readFileSync(join(root, "exit-code"), "utf8") !== "0") {
      throw new Error("Herdr integration failed inside the managed pane");
    }
    assertHerdrResults(
      JSON.parse(readFileSync(join(root, "results.json"), "utf8")),
    );
    passed = true;
  } finally {
    try {
      if (
        server.pid &&
        server.exitCode === null &&
        server.signalCode === null
      ) {
        cli(["server", "stop"]);
        const deadline = Date.now() + 5_000;
        while (
          server.exitCode === null &&
          server.signalCode === null &&
          Date.now() < deadline
        ) {
          await delay(100);
        }
        if (server.exitCode === null && server.signalCode === null) {
          throw new Error("Herdr server did not stop");
        }
      }
    } catch (error) {
      passed = false;
      process.exitCode = 1;
      console.error(`Herdr cleanup failed: ${String(error)}`);
      if (server.pid) {
        try {
          process.kill(-server.pid, "SIGKILL");
        } catch (killError) {
          // The server may have exited while its stop request timed out.
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") {
            console.error(`Herdr force-stop failed: ${String(killError)}`);
          }
        }
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const diagnostics = process.env.SUBAGENTURA_HERDR_DIAGNOSTICS;
    if (diagnostics) {
      mkdirSync(diagnostics, { recursive: true });
      cpSync(root, join(diagnostics, basename(root)), {
        recursive: true,
        filter: (path) => !lstatSync(path).isSocket(),
      });
    }
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`Herdr diagnostics retained at ${root}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  if (process.argv[2] === "--inside" && process.argv[3]) {
    runInsidePane(process.argv[3]);
  } else {
    runHeadless().catch((error) => {
      console.error(String(error));
      process.exitCode = 1;
    });
  }
}
