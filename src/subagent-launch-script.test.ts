/**
 * Tests for the launch script's EXIT trap behavior.
 *
 * The launch script is the bash wrapper that runs the child pi process. Its EXIT
 * trap records a terminal event in `events.ndjson` so the parent can observe the
 * child's outcome. The trap must be idempotent: if the child already called
 * `cli.mjs done` (or `error`) before exiting, the trap must NOT write a second
 * terminal event. A second event would re-trigger the parent's notification +
 * inject path and re-prompt the user with the same output.
 *
 * See: AGENTS.md "cli.mjs done is the contract for interactive sub-agents"
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  launchInteractiveSubagent,
  writeLaunchScript,
} from "./interactive-tmux";
import { stateFilePath, loadInteractiveStates } from "./artifact";
import { importFresh } from "./test-utils";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-launch-"));
}

/** Parse the events.ndjson file into an array of event objects. */
function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Write a launch script whose `command` is `body`, then spawn it under bash.
 * The trap is part of the generated script and fires when bash exits.
 */
function runLaunchScript(
  artDir: string,
  launchScriptPath: string,
  body: string,
): number {
  writeLaunchScript(launchScriptPath, body, artDir);
  // writeLaunchScript sets 0o700; chmod again for safety on platforms where the umask wins.
  chmodSync(launchScriptPath, 0o700);
  const res = spawnSync("bash", [launchScriptPath], {
    env: { ...process.env, ARTIFACT_DIR: artDir },
    encoding: "utf8",
  });
  return res.status ?? -1;
}

/** Count events of a given type in the artifact. */
function countEvents(
  dir: string,
  type: string,
): Array<Record<string, unknown>> {
  return readEvents(dir).filter((e) => e.type === type);
}

describe("launch script EXIT trap (idempotency)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes exactly one `done` event when the child calls `cli.mjs done` and then exits cleanly (REPL exit after success)", () => {
    const artDir = join(tmp, "artifacts", "abc12345");
    const launchScript = join(artDir, "launch.sh");

    // Simulate the child obeying the protocol: it called `cli.mjs done 0`, then
    // the user exited the REPL, which made the bash script exit 0.
    const childBody = `"${join(artDir, "cli.mjs")}" done 0\nexit 0`;
    runLaunchScript(artDir, launchScript, childBody);

    expect(countEvents(artDir, "done")).toHaveLength(1);
  });

  it("writes exactly one `done` event when the child exits the REPL with a non-zero code WITHOUT calling done", () => {
    const artDir = join(tmp, "artifacts", "abc12346");
    const launchScript = join(artDir, "launch.sh");

    // Child crashed/exited without calling done. The trap is the ONLY source of
    // the terminal event in this case — it must still fire so the parent learns
    // the child is gone.
    const childBody = `exit 1`;
    runLaunchScript(artDir, launchScript, childBody);

    const doneEvents = countEvents(artDir, "done");
    expect(doneEvents).toHaveLength(1);
    // The trap wrote the only `done` event with the script's exit code.
    expect(doneEvents[0].status).toBe("error");
    expect(doneEvents[0].exitCode).toBe(1);
  });

  it("writes exactly one `cancelled` event when the .cancelled flag is present and the child did not call done", () => {
    const artDir = join(tmp, "artifacts", "abc12347");
    const launchScript = join(artDir, "launch.sh");

    // Parent called cancel_interactive_subagent, which writes the .cancelled flag.
    // The child then exits the REPL. Trap should write exactly one `cancelled` event.
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, ".cancelled"), "", { mode: 0o600 });
    const childBody = `exit 0`;
    runLaunchScript(artDir, launchScript, childBody);

    expect(countEvents(artDir, "cancelled")).toHaveLength(1);
  });

  it("does NOT overwrite an explicit `error` event with a trap-emitted `done` (child declared failure, then exited)", () => {
    const artDir = join(tmp, "artifacts", "abc12348");
    const launchScript = join(artDir, "launch.sh");

    // Child declared an unrecoverable failure via cli.mjs error, then exited 0.
    // The trap must not append a second terminal event that would replace the
    // child's own error signal.
    const childBody = `"${join(artDir, "cli.mjs")}" error "boom"\nexit 0`;
    runLaunchScript(artDir, launchScript, childBody);

    expect(countEvents(artDir, "error")).toHaveLength(1);
    expect(countEvents(artDir, "done")).toHaveLength(0);
    expect(countEvents(artDir, "error")[0].message).toBe("boom");
  });

  it("does NOT write a `cancelled` event when the child already called `done` and the .cancelled flag is set later", () => {
    // Edge case: child finished a turn, then the parent cancelled (e.g. to clean up
    // the pane). The .cancelled flag is set AFTER the child's explicit `done`. The
    // trap should observe the existing `done` and not emit a second terminal event —
    // the child's success is the source of truth, the cancellation is just cleanup.
    const artDir = join(tmp, "artifacts", "abc12349");
    const launchScript = join(artDir, "launch.sh");

    // The child runs and writes a done event, then the wrapper writes the
    // .cancelled flag (simulating cancel_interactive_subagent landing between
    // the child's done and the script's exit), then exits.
    const childBody =
      `"${join(artDir, "cli.mjs")}" done 0\n` +
      `touch "${artDir}/.cancelled"\n` +
      `exit 0`;
    runLaunchScript(artDir, launchScript, childBody);

    expect(countEvents(artDir, "done")).toHaveLength(1);
    expect(countEvents(artDir, "cancelled")).toHaveLength(0);
  });
});

// ── Mock tmux exec so launchInteractiveSubagent doesn't create real tmux
// windows during the test run. The existing launch script tests above run
// real bash + the wrapper and don't need a tmux mock; the spawn-persistence
// tests below drive launchInteractiveSubagent directly and would otherwise
// leave orphan tmux windows behind (test pollution).
function installTmuxMock() {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      // new-window / new-session / split-window return a pane id; everything
      // else is a no-op (display-message would otherwise throw).
      if (
        args[0] === "new-window" ||
        args[0] === "split-window" ||
        args[0] === "new-session"
      ) {
        return "%99\n";
      }
      if (args[0] === "display-message") {
        return "sess\t1\t0\n";
      }
      return "";
    },
  }));
}

describe("spawn-time state persistence", () => {
  let cwd: string;
  const SESSION = "019e500a-bae9-783a-869a-ac7c106b4ab7";

  beforeEach(() => {
    installTmuxMock();
    cwd = mkdtempSync(join(tmpdir(), "pi-subagentura-spawn-persist-"));
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    process.env.HOME = process.env.HOME ?? "/tmp";
    // Ensure getMux selects tmux, not zellij. The test mock only handles
    // tmux commands; if ZELLIJ_SESSION_NAME is set from the outer environment,
    // getMux would pick zellij and the mock would not intercept its calls.
    delete process.env.ZELLIJ;
    delete process.env.ZELLIJ_SESSION_NAME;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("launchInteractiveSubagent with parentSessionId writes the state file", async () => {
    const { launchInteractiveSubagent } =
      await importFresh<typeof import("./interactive-tmux")>(
        "./interactive-tmux",
      );
    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      parentSessionId: "pi",
    });
    expect(existsSync(stateFilePath(cwd))).toBe(true);
    const loaded = loadInteractiveStates(cwd);
    expect(loaded?.states[state.id]?.paneId).toBe(state.paneId);
    expect(loaded?.states[state.id]?.mux).toBe(state.mux);
  });

  it("launchInteractiveSubagent without parentSessionId does NOT write the state file", async () => {
    const { launchInteractiveSubagent } =
      await importFresh<typeof import("./interactive-tmux")>(
        "./interactive-tmux",
      );
    launchInteractiveSubagent({ name: "Demo", task: "t", cwd });
    expect(existsSync(stateFilePath(cwd))).toBe(false);
  });

  it("the persisted entry records windowName, mux, and artifactDir", async () => {
    const { launchInteractiveSubagent } =
      await importFresh<typeof import("./interactive-tmux")>(
        "./interactive-tmux",
      );
    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      parentSessionId: "pi",
    });
    const loaded = loadInteractiveStates(cwd);
    const entry = loaded?.states[state.id];
    expect(entry?.windowName).toBe(state.windowName);
    expect(entry?.mux).toBe(state.mux);
    expect(entry?.artifactDir).toBe(state.artifactDir);
    expect(entry?.sessionFile).toBe(state.sessionFile);
  });

  it("the state has parentSessionId populated for terminal cleanup", async () => {
    const { launchInteractiveSubagent } =
      await importFresh<typeof import("./interactive-tmux")>(
        "./interactive-tmux",
      );
    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      parentSessionId: "pi",
    });
    expect(state.parentSessionId).toBe("pi");
    expect(state.cwd).toBe(cwd);
  });
});
