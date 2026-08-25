// Hermeticity boundary: the guards installed here are Node-level. Pi runs with
// `--approve`, so a tool-issued shell command (`curl`, `git fetch`, `ssh`) is
// not intercepted by fixtures/deny-network.cjs. `_env` therefore also points
// every proxy variable at a closed port so non-Node clients fail closed, but
// this suite does not claim kernel-level network isolation. See
// docs/terminal-e2e.md.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const sleep = (ms) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * The editor key-hint line Pi paints once its raw-mode reader is attached. A
 * half-drawn splash does not contain it, so gating `start()` on this string is
 * a real readiness signal rather than "some banner appeared".
 *
 * Verified against pi v0.80.6, which is the only SDK leg that runs `test:tui`
 * (see docs/terminal-e2e.md).
 */
const PI_EDITOR_READY = "ctrl+o";

/** `set -g extended-keys on` does not parse before tmux 3.2. */
const MINIMUM_TMUX = { major: 3, minor: 2 };

const activeHarnesses = new Set();
let exitCleanupInstalled = false;

function cleanupActiveHarnessesSync() {
  for (const harness of [...activeHarnesses]) {
    try {
      harness.cleanupSync();
    } catch (error) {
      console.error(`terminal E2E emergency cleanup failed: ${error}`);
    }
  }
}

function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", cleanupActiveHarnessesSync);
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    const ownsSignal = process.listenerCount(signal) === 0;
    process.once(signal, () => {
      cleanupActiveHarnessesSync();
      // Ownership is established before registration so an earlier `once`
      // listener cannot disappear before this callback and make the harness
      // mistake the signal for its own. Re-check at delivery time so listeners
      // registered after the harness also retain control of shutdown.
      if (ownsSignal && process.listenerCount(signal) === 0) {
        process.exit(exitCode);
      }
    });
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** Screen text with whitespace runs collapsed, so a line Pi soft-wrapped at the
 *  pane width still matches a single-line expectation. */
function normalizeScreen(text) {
  return text.replace(/\s+/g, " ").trim();
}

let cachedTmuxVersion;
function tmuxVersion() {
  if (cachedTmuxVersion) return cachedTmuxVersion;
  let output;
  try {
    output = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`tmux is required for terminal E2E tests: ${error}`);
  }
  const match = output.match(/(\d+)\.(\d+)/);
  const version = {
    text: output,
    major: Number(match?.[1] ?? 0),
    minor: Number(match?.[2] ?? 0),
  };
  if (
    version.major < MINIMUM_TMUX.major ||
    (version.major === MINIMUM_TMUX.major && version.minor < MINIMUM_TMUX.minor)
  ) {
    throw new Error(
      `terminal E2E tests require tmux >= ${MINIMUM_TMUX.major}.${MINIMUM_TMUX.minor} ` +
        `because the generated config sets "extended-keys on"; found ${output}`,
    );
  }
  cachedTmuxVersion = version;
  return version;
}

const MISSING_PI =
  "terminal E2E tests require the real Pi CLI: install dependencies so " +
  "node_modules/.bin/pi exists, put `pi` on PATH, or point " +
  "SUBAGENTURA_E2E_REAL_PI at its absolute path";

let cachedPi;
function resolvePi() {
  if (cachedPi) return cachedPi;
  if (process.env.SUBAGENTURA_E2E_REAL_PI) {
    cachedPi = resolve(process.env.SUBAGENTURA_E2E_REAL_PI);
    return cachedPi;
  }
  const localPi = join(REPO, "node_modules", ".bin", "pi");
  if (existsSync(localPi)) {
    cachedPi = localPi;
    return cachedPi;
  }
  const found = spawnSync("/bin/sh", ["-c", "command -v pi"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  cachedPi = found.status === 0 ? found.stdout.trim() : "";
  if (!cachedPi) throw new Error(MISSING_PI);
  return cachedPi;
}

function resolveProcessGroupId(processId) {
  try {
    const output = execFileSync(
      "ps",
      ["-o", "pgid=", "-p", String(processId)],
      { encoding: "utf8", timeout: 2_000 },
    ).trim();
    const processGroupId = Number(output);
    return Number.isInteger(processGroupId) && processGroupId > 1
      ? processGroupId
      : undefined;
  } catch {
    /* the pane process may exit between tmux enumeration and ps */
    return undefined;
  }
}

function processGroupsForRoot(root) {
  const output = execFileSync("ps", ["-axww", "-o", "pgid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
  });
  const processGroupIds = new Set();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    const processGroupId = Number(match?.[1]);
    const command = match?.[2] ?? "";
    if (command.includes(root) && processGroupId > 1) {
      processGroupIds.add(processGroupId);
    }
  }
  return processGroupIds;
}

function processGroupIsAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 1) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
    throw error;
  }
}

function signalProcessGroups(processGroupIds, signal) {
  for (const processGroupId of processGroupIds) {
    if (!processGroupIsAlive(processGroupId)) continue;
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

/**
 * `kill(-pgid, 0)` also succeeds while a group holds nothing but zombies, which
 * a non-reaping PID 1 (docker, `act`) never collects. Treat such a group as
 * gone so teardown does not fail a suite that actually passed.
 */
function processGroupHasRunningMember(processGroupId) {
  let output;
  try {
    output = execFileSync("ps", ["-axww", "-o", "pgid=,stat="], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return true; /* cannot prove the group is only zombies */
  }
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    if (!match || Number(match[1]) !== processGroupId) continue;
    if (!match[2].startsWith("Z")) return true;
  }
  return false;
}

async function waitForProcessGroups(processGroupIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let live = processGroupIds.filter(processGroupIsAlive);
  while (live.length > 0 && Date.now() < deadline) {
    await sleep(50);
    live = live.filter(processGroupIsAlive);
  }
  return live.filter(processGroupHasRunningMember);
}

function findFiles(root, fileName) {
  if (!existsSync(root)) return [];
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(path, fileName));
    else if (entry.isFile() && entry.name === fileName) matches.push(path);
  }
  return matches;
}

export class TerminalHarness {
  constructor({ scenario = "smoke", keep = false } = {}) {
    this.scenario = scenario;
    this.keep = keep;
    this.root = mkdtempSync(join(tmpdir(), "pi-subagentura-terminal-e2e-"));
    this.workspace = join(this.root, "workspace");
    this.home = join(this.root, "home");
    this.agentDir = join(this.root, "agent");
    this.sessionDir = join(this.root, "sessions");
    this.gates = join(this.root, "gates");
    this.wrapperBin = join(this.root, "bin");
    this.providerLog = join(this.root, "provider.ndjson");
    this.networkLog = join(this.root, "network.ndjson");
    this.diagnosticsDir =
      process.env.SUBAGENTURA_E2E_DIAGNOSTICS ?? join(this.root, "diagnostics");
    this.socket = `subagentura-e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
    this.session = `e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
    this.parentPane = undefined;
    this.trackedPids = new Set();
    this.echoedInput = [];
    this.started = false;
    this.serverOwned = false;
    this.version = tmuxVersion();
    activeHarnesses.add(this);
    installExitCleanup();
  }

  get env() {
    return this._env;
  }

  setupFiles() {
    for (const directory of [
      this.workspace,
      this.home,
      this.agentDir,
      this.sessionDir,
      this.gates,
      this.wrapperBin,
      this.diagnosticsDir,
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.agentDir, "auth.json"),
      JSON.stringify({
        "subagentura-e2e": { type: "api_key", key: "subagentura-e2e-test-key" },
      }),
      { mode: 0o600 },
    );
    const wrapper = join(this.wrapperBin, "pi");
    cpSync(join(HERE, "fixtures/pi-child-wrapper.sh"), wrapper);
    chmodSync(wrapper, 0o700);
    const versionConfig = ["set -g extended-keys on"];
    if (
      this.version.major > 3 ||
      (this.version.major === 3 && this.version.minor >= 5)
    )
      versionConfig.push("set -g extended-keys-format csi-u");
    this.tmuxConfig = join(this.root, "tmux.conf");
    writeFileSync(this.tmuxConfig, `${versionConfig.join("\n")}\n`, {
      mode: 0o600,
    });
    // The wrapper directory is prepended, so it always wins for `pi`. Nothing
    // else may be dropped: node_modules/.bin/pi is a `#!/usr/bin/env node`
    // script, and filtering version-manager directories out of PATH (nvm, fnm,
    // asdf, volta) removes the only `node` the pane can exec.
    const safePath = [this.wrapperBin, process.env.PATH ?? "/usr/bin:/bin"]
      .filter(Boolean)
      .join(":");
    this._env = {
      HOME: this.home,
      PATH: safePath,
      TERM: "xterm-256color",
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: this.agentDir,
      PI_CODING_AGENT_SESSION_DIR: this.sessionDir,
      PI_SUBAGENTURA_TMUX_SOCKET: this.socket,
      SUBAGENTURA_E2E_GATE_DIR: this.gates,
      SUBAGENTURA_E2E_LOG: this.providerLog,
      SUBAGENTURA_E2E_NETWORK_LOG: this.networkLog,
      SUBAGENTURA_E2E_REPO: REPO,
      SUBAGENTURA_E2E_API_KEY: "subagentura-e2e-test-key",
      SUBAGENTURA_E2E_REAL_PI: resolvePi(),
      NODE_OPTIONS: `--require=${join(HERE, "fixtures/deny-network.cjs")}`,
      // Node ignores these, but tool-issued `curl`/`git`/`wget` do not, so
      // non-Node egress fails closed instead of silently succeeding.
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      no_proxy: "",
      NO_PROXY: "",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    this.assertChildCanExecNode(safePath);
    appendFileSync(
      this.providerLog,
      `${JSON.stringify({ event: "harness", scenario: this.scenario, tmux: this.version.text })}\n`,
      { mode: 0o600 },
    );
  }

  /**
   * Fails fast when the child environment cannot exec `node`. Without this the
   * pane dies instantly with `env: node: No such file or directory` and the
   * only symptom is a 15s "real Pi did not paint its editor" timeout whose dump
   * never mentions PATH.
   */
  assertChildCanExecNode(safePath) {
    const found = spawnSync("/bin/sh", ["-c", "command -v node"], {
      env: this._env,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (found.status === 0 && found.stdout.trim()) return;
    throw new Error(
      'the terminal E2E child environment cannot resolve "node", so the Pi ' +
        "pane would die before painting anything. " +
        `PATH=${safePath}`,
    );
  }

  tmux(args, options = {}) {
    return execFileSync(
      "tmux",
      ["-f", this.tmuxConfig, "-L", this.socket, ...args],
      {
        encoding: "utf8",
        env: this._env,
        timeout: options.timeout ?? 10_000,
        stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      },
    );
  }

  async start() {
    this.setupFiles();
    const pi = resolvePi();
    const command = [
      pi,
      // Keep the startup resource list visible when CI enables quiet startup.
      "--verbose",
      "--offline",
      "--approve",
      "--api-key",
      "subagentura-e2e-test-key",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "-e",
      join(REPO, "src/subagent.ts"),
      "-e",
      join(HERE, "fixtures/mock-provider.ts"),
      "--model",
      "subagentura-e2e/mock",
      "--session-dir",
      this.sessionDir,
    ]
      .map(shellQuote)
      .join(" ");
    this.tmux([
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      "100",
      "-y",
      "32",
      "-c",
      this.workspace,
      command,
    ]);
    this.serverOwned = true;
    this.parentPane = this.tmux([
      "display-message",
      "-p",
      "-t",
      `${this.session}:0.0`,
      "#{pane_id}",
    ]).trim();
    this.started = true;
    await this.waitForScreen(
      (screen) => screen.includes(PI_EDITOR_READY),
      `real Pi did not paint its editor (waiting for "${PI_EDITOR_READY}")`,
    );
    this.refreshProcesses();
    return this;
  }

  sendText(text) {
    if (!this.parentPane)
      throw new Error("terminal E2E harness is not started");
    this.tmux(["send-keys", "-t", this.parentPane, "-l", "--", text]);
  }

  sendKey(key) {
    this.tmux(["send-keys", "-t", this.parentPane, key]);
  }

  pressEnter() {
    this.sendKey("Enter");
  }

  /**
   * Types a prompt, waits until Pi has echoed it into the editor, then submits.
   * Keystrokes sent while the TUI is still initialising are discarded, and the
   * echo wait turns that into an immediate, self-explaining failure instead of a
   * downstream 30s gate timeout on an empty prompt.
   *
   * The submitted text is also recorded so `renderedScreen()` can subtract it:
   * an assertion must be satisfied by what the fixture painted, never by the
   * echo of what the test itself typed.
   */
  async sendPrompt(text) {
    this.sendText(text);
    const needle = normalizeScreen(text);
    // Deliberately not waitForScreen: that subtracts already-recorded input, so
    // re-sending an identical prompt would never observe its own echo.
    await this.waitFor(
      () => normalizeScreen(this.currentScreen()).includes(needle),
      `Pi did not echo typed input: ${text.slice(0, 40)}`,
    );
    this.echoedInput.push(text);
    this.pressEnter();
  }

  /** Capture with wrapped lines joined, so a long expectation that straddles
   *  column 100 still matches. */
  currentScreen(pane = this.parentPane) {
    return pane ? this.tmux(["capture-pane", "-p", "-J", "-t", pane]) : "";
  }

  /** Un-joined capture; keeps column fidelity for diagnostics. */
  rawScreen(pane = this.parentPane) {
    return pane ? this.tmux(["capture-pane", "-p", "-t", pane]) : "";
  }

  /**
   * The screen as assertions see it: wrapped lines joined, whitespace runs
   * collapsed, and every prompt this harness submitted subtracted. Stripping the
   * echo is what stops "renders an error" from being satisfied by the word
   * "error" in the prompt the test typed one line earlier.
   */
  renderedScreen(pane = this.parentPane) {
    let text = normalizeScreen(this.currentScreen(pane));
    for (const echo of this.echoedInput) {
      text = text.split(normalizeScreen(echo)).join(" ");
    }
    return text;
  }

  /**
   * `renderedScreen` for a specific pane. Unlike passing `undefined` to
   * `renderedScreen`, a missing id throws instead of silently reading the parent
   * pane and letting a child-pane regression assert against the wrong screen.
   */
  paneScreen(paneId) {
    if (!paneId)
      throw new Error(
        "terminal E2E paneScreen requires a pane id; the pane was not found",
      );
    return this.renderedScreen(paneId);
  }

  scrollback(pane = this.parentPane) {
    return pane ? this.tmux(["capture-pane", "-p", "-S", "-", "-t", pane]) : "";
  }

  panes() {
    try {
      const output = this.tmux([
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}",
      ]);
      return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, pid, session, window, pane, active, command] =
            line.split("\t");
          return {
            id,
            pid: Number(pid),
            session,
            window,
            pane,
            active: active === "1",
            command,
          };
        });
    } catch {
      return [];
    }
  }

  refreshProcesses() {
    const ownProcessGroupId = resolveProcessGroupId(process.pid);
    const processGroupIds = processGroupsForRoot(this.root);
    for (const pane of this.panes()) {
      const processGroupId = resolveProcessGroupId(pane.pid);
      if (processGroupId) processGroupIds.add(processGroupId);
    }
    for (const processGroupId of processGroupIds) {
      if (processGroupId !== ownProcessGroupId) {
        this.trackedPids.add(processGroupId);
      }
    }
  }

  readJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }

  providerEvents() {
    return this.readJsonl(this.providerLog);
  }
  networkEvents() {
    return this.readJsonl(this.networkLog);
  }

  artifactEvents() {
    return findFiles(this.sessionDir, "events.ndjson").flatMap((path) =>
      this.readJsonl(path).map((event) => ({ path, ...event })),
    );
  }

  release(name) {
    writeFileSync(join(this.gates, name), "release\n", { mode: 0o600 });
  }

  async waitFor(predicate, description, timeoutMs = 15_000) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        if (await predicate()) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(75);
    }
    const details = [
      `Timed out waiting for ${description}`,
      lastError ? String(lastError) : "",
      "--- current screen ---",
      this.currentScreen(),
      "--- provider log ---",
      readFileSync(this.providerLog, "utf8"),
      "--- network log ---",
      existsSync(this.networkLog)
        ? readFileSync(this.networkLog, "utf8")
        : "(empty)",
      "--- panes ---",
      JSON.stringify(this.panes(), null, 2),
      "--- scrollback ---",
      this.scrollback(),
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(details);
  }

  async waitForScreen(predicate, description, timeoutMs = 15_000) {
    return this.waitFor(
      () => predicate(this.renderedScreen()),
      description,
      timeoutMs,
    );
  }

  async waitForProvider(predicate, description, timeoutMs = 30_000) {
    return this.waitFor(
      () => predicate(this.providerEvents()),
      description,
      timeoutMs,
    );
  }

  /**
   * Positive control first, negative assertion second.
   *
   * `networkEvents()` staying empty proves nothing on its own: if the
   * `NODE_OPTIONS=--require` preload ever fails to apply, the log stays empty and
   * every caller passes vacuously forever. So require an `armed` record from
   * every process that actually ran the scripted provider — the provider logs its
   * own pid, which covers the parent pane and each process-isolated child — and
   * only then assert that nothing was denied.
   */
  async assertNoNetwork() {
    const events = this.networkEvents();
    const armed = new Set(
      events
        .filter((event) => event.kind === "armed")
        .map((event) => event.pid),
    );
    if (armed.size === 0) {
      throw new Error(
        "the terminal E2E network guard never armed: no process recorded " +
          `loading fixtures/deny-network.cjs in ${this.networkLog}. ` +
          "assertNoNetwork() cannot distinguish a hermetic run from a missing " +
          "NODE_OPTIONS preload, so this is a failure, not a pass.",
      );
    }
    const unguarded = [
      ...new Set(
        this.providerEvents()
          .map((event) => event.pid)
          .filter(Boolean),
      ),
    ].filter((pid) => !armed.has(pid));
    if (unguarded.length > 0) {
      throw new Error(
        `the terminal E2E network guard is not loaded in process(es) ${unguarded.join(", ")}, ` +
          `which ran the scripted provider (armed: ${[...armed].join(", ") || "none"})`,
      );
    }
    const denials = events.filter((event) => event.kind !== "armed");
    if (denials.length > 0) {
      throw new Error(`network denial was invoked: ${JSON.stringify(denials)}`);
    }
  }

  diagnostics() {
    const harnessDiagnosticsDir = join(
      this.diagnosticsDir,
      `${this.scenario}-${this.session}`,
    );
    mkdirSync(harnessDiagnosticsDir, { recursive: true });
    const writeDiagnostic = (suffix, content) => {
      writeFileSync(join(harnessDiagnosticsDir, suffix), content);
    };
    writeDiagnostic("screen.txt", this.rawScreen());
    writeDiagnostic("scrollback.txt", this.scrollback());
    writeDiagnostic(
      "provider.ndjson",
      existsSync(this.providerLog) ? readFileSync(this.providerLog) : "",
    );
    writeDiagnostic(
      "network.ndjson",
      existsSync(this.networkLog) ? readFileSync(this.networkLog) : "",
    );
    writeDiagnostic("panes.json", JSON.stringify(this.panes(), null, 2));
    writeDiagnostic(
      "artifact-events.json",
      JSON.stringify(this.artifactEvents(), null, 2),
    );
  }

  cleanupSync() {
    this.refreshProcesses();
    const processGroupIds = [...this.trackedPids];
    signalProcessGroups(processGroupIds, "SIGKILL");
    if (this.serverOwned || this.started) {
      try {
        execFileSync("tmux", ["-L", this.socket, "kill-server"], {
          stdio: "ignore",
          env: this._env,
          timeout: 2_000,
        });
      } catch {
        /* server may already be gone during emergency cleanup */
      }
    }
    if (!this.keep) rmSync(this.root, { recursive: true, force: true });
    this.started = false;
    this.serverOwned = false;
    activeHarnesses.delete(this);
  }

  async cleanup(failed = false) {
    // SUBAGENTURA_E2E_DIAGNOSTICS only chooses *where* diagnostics land; writing
    // a full screen + scrollback + logs dump per harness on every green run
    // costs real time and is then discarded by an `if: failure()` upload.
    if (failed || this.keep) {
      try {
        this.diagnostics();
      } catch {
        /* diagnostics are best effort during teardown */
      }
    }
    this.refreshProcesses();
    const processGroupIds = [...this.trackedPids];
    signalProcessGroups(processGroupIds, "SIGTERM");
    try {
      execFileSync("tmux", ["-L", this.socket, "kill-server"], {
        stdio: "ignore",
        env: this._env,
        timeout: 5_000,
      });
    } catch {
      /* server may already be gone */
    }
    let remaining = await waitForProcessGroups(processGroupIds, 2_000);
    if (remaining.length > 0) {
      signalProcessGroups(remaining, "SIGKILL");
      remaining = await waitForProcessGroups(remaining, 2_000);
    }
    let serverAlive = false;
    try {
      execFileSync("tmux", ["-L", this.socket, "has-session"], {
        stdio: "ignore",
        env: this._env,
        timeout: 2_000,
      });
      serverAlive = true;
    } catch {
      /* no server/session is the expected teardown state */
    }
    if (!this.keep) rmSync(this.root, { recursive: true, force: true });
    this.started = false;
    this.serverOwned = false;
    activeHarnesses.delete(this);
    if (remaining.length > 0 || serverAlive) {
      throw new Error(
        `terminal E2E teardown incomplete: process groups=${remaining.join(",") || "none"}, serverAlive=${serverAlive}`,
      );
    }
  }
}

export function createHarness(options) {
  return new TerminalHarness(options);
}
export { REPO, tmuxVersion };
