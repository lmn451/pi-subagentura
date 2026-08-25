/**
 * Tests for the launch script's EXIT trap behavior.
 *
 * The launch script is the bash wrapper that runs the child pi process. Its EXIT
 * trap always records one `process_exited` event and creates a completion only
 * when the child did not already publish one. Completion is idempotent even
 * when later activity rows follow the explicit completion.
 *
 * See: AGENTS.md "cli.mjs done is the contract for interactive sub-agents".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

import {
  launchInteractiveSubagent,
  writeLaunchScript,
} from "../src/interactive-tmux";
import { stateFilePath, loadInteractiveStates } from "../src/artifact";
import { importFresh } from "./test-utils";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";

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

function countCompletions(
  dir: string,
  outcome: string,
): Array<Record<string, unknown>> {
  return readEvents(dir).filter(
    (event) => event.type === "completion" && event.outcome === outcome,
  );
}

describe("launch script EXIT trap (idempotency)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmp();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("preserves explicit completion and appends one process_exited event", () => {
    const artDir = join(tmp, "artifacts", "abc12345");
    const launchScript = join(artDir, "launch.sh");

    // Simulate the child obeying the protocol: it called `cli.mjs done 0`, then
    // the user exited the REPL, which made the bash script exit 0.
    const childBody = `"${join(artDir, "cli.mjs")}" done 0\nexit 0`;
    expect(runLaunchScript(artDir, launchScript, childBody)).toBe(0);

    const completions = countCompletions(artDir, "done");
    const exits = countEvents(artDir, "process_exited");
    expect(completions).toHaveLength(1);
    expect(completions[0].exitCode).toBe(0);
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(0);
  });

  it("preserves a non-zero wrapper rc in completion and process_exited", () => {
    const artDir = join(tmp, "artifacts", "abc12346");
    const launchScript = join(artDir, "launch.sh");

    // Child crashed/exited without calling done. The trap is the ONLY source of
    // the terminal event in this case — it must still fire so the parent learns
    // the child is gone.
    const childBody = `exit 1`;
    expect(runLaunchScript(artDir, launchScript, childBody)).toBe(1);

    const doneEvents = countCompletions(artDir, "error");
    const exits = countEvents(artDir, "process_exited");
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].status).toBe("error");
    expect(doneEvents[0].exitCode).toBe(1);
    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(1);
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

    expect(countCompletions(artDir, "cancelled")).toHaveLength(1);
    expect(countEvents(artDir, "process_exited")).toEqual([
      expect.objectContaining({
        status: "cancelled",
        exitCode: 0,
      }),
    ]);
  });

  it("does not duplicate an explicit error completion when the child exits", () => {
    const artDir = join(tmp, "artifacts", "abc12348");
    const launchScript = join(artDir, "launch.sh");

    // Child declared an unrecoverable failure via cli.mjs error, then exited 0.
    // The trap must not append a second terminal event that would replace the
    // child's own error signal.
    const childBody = `"${join(artDir, "cli.mjs")}" error "boom"\nexit 0`;
    runLaunchScript(artDir, launchScript, childBody);

    expect(countCompletions(artDir, "error")).toHaveLength(1);
    expect(countCompletions(artDir, "done")).toHaveLength(0);
    expect(countCompletions(artDir, "error")[0].message).toBe("boom");
    expect(countEvents(artDir, "process_exited")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
    ]);
  });

  it("does not replace explicit completion when cancellation is flagged later", () => {
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

    expect(countCompletions(artDir, "done")).toHaveLength(1);
    expect(countCompletions(artDir, "cancelled")).toHaveLength(0);
    expect(countEvents(artDir, "process_exited")).toHaveLength(1);
  });

  it("does not duplicate explicit completion after trailing activity", () => {
    const artDir = join(tmp, "artifacts", "abc12350");
    const launchScript = join(artDir, "launch.sh");
    const childBody =
      `"${join(artDir, "cli.mjs")}" done 0\n` +
      `printf '%s\\n' '{"ts":2,"type":"tool_activity","status":"running"}' >> "${join(artDir, "events.ndjson")}"\n` +
      `exit 7`;

    expect(runLaunchScript(artDir, launchScript, childBody)).toBe(7);

    expect(countCompletions(artDir, "done")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
    ]);
    expect(countEvents(artDir, "tool_activity")).toHaveLength(1);
    expect(countEvents(artDir, "process_exited")).toEqual([
      expect.objectContaining({ exitCode: 7 }),
    ]);
  });
});

// ── Mock tmux exec so launchInteractiveSubagent doesn't create real tmux
// windows during the test run. The existing launch script tests above run
// real bash + the wrapper and don't need a tmux mock; the spawn-persistence
// tests below drive launchInteractiveSubagent directly and would otherwise
// leave orphan tmux windows behind (test pollution).
function installTmuxMock() {
  vi.resetModules();
  const calls: string[][] = [];
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      calls.push(args);
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
  return calls;
}

const SPAWN_ENV_NAMES = [
  "TMUX",
  "TMUX_PANE",
  "HOME",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_SUBAGENTURA_AGENT_ID",
  "PI_SUBAGENTURA_ROOT_ID",
  "PI_SUBAGENTURA_LINEAGE_SESSION_ROOT",
  "PI_SUBAGENTURA_DEPTH",
  "PI_SUBAGENTURA_MAX_DEPTH",
  "PI_SUBAGENTURA_MAX_NODES",
  "PI_SUBAGENTURA_LINEAGE_BOOTSTRAP",
] as const;

type SpawnEnvName = (typeof SPAWN_ENV_NAMES)[number];

describe("spawn-time state persistence", () => {
  let cwd: string;
  let tmuxCalls: string[][];
  let savedEnv: Record<SpawnEnvName, string | undefined>;
  const SESSION = "019e500a-bae9-783a-869a-ac7c106b4ab7";

  beforeEach(() => {
    tmuxCalls = installTmuxMock();
    cwd = mkdtempSync(join(tmpdir(), "pi-subagentura-spawn-persist-"));
    savedEnv = Object.fromEntries(
      SPAWN_ENV_NAMES.map((name) => [name, process.env[name]]),
    ) as Record<SpawnEnvName, string | undefined>;
    process.env.PI_CODING_AGENT_SESSION_DIR = cwd;
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = cwd;
    delete process.env.PI_SUBAGENTURA_AGENT_ID;
    delete process.env.PI_SUBAGENTURA_ROOT_ID;
    delete process.env.PI_SUBAGENTURA_DEPTH;
    delete process.env.PI_SUBAGENTURA_MAX_DEPTH;
    delete process.env.PI_SUBAGENTURA_MAX_NODES;
    delete process.env.PI_SUBAGENTURA_LINEAGE_BOOTSTRAP;
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
    for (const name of SPAWN_ENV_NAMES) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("launchInteractiveSubagent with parentSessionId writes the state file", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
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
    // Path-segment containment, not a prefix match: `startsWith` would also
    // accept an unintended sibling such as `${cwd}-other/...`.
    expect(relative(cwd, state.artifactDir).split(sep)[0]).not.toBe("..");
    expect(isAbsolute(relative(cwd, state.artifactDir))).toBe(false);
  });

  it("launchInteractiveSubagent without parentSessionId does NOT write the state file", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    launchInteractiveSubagent({ name: "Demo", task: "t", cwd });
    expect(existsSync(stateFilePath(cwd))).toBe(false);
  });

  it("execs the wrapper so child exit cannot leave a shell target", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    launchInteractiveSubagent({ name: "Demo", task: "t", cwd });

    const sendKeys = tmuxCalls.find((args) => args[0] === "send-keys");
    expect(sendKeys).toBeDefined();
    expect(sendKeys?.join(" ")).toContain("exec bash");
  });

  it("passes lineage through a one-use bootstrap instead of ambient variables", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    process.env.PI_SUBAGENTURA_ROOT_ID = "ambient-live-root";
    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      parentSessionId: "pi",
      spawnTreeContext: createRootSpawnTreeContext("pi", cwd),
    });

    const script = readFileSync(state.launchScriptFile, "utf8");
    expect(script).toContain("PI_SUBAGENTURA_LINEAGE_BOOTSTRAP=");
    expect(script).not.toContain("PI_SUBAGENTURA_ROOT_ID=");
    expect(script).not.toContain("PI_SUBAGENTURA_LINEAGE_SESSION_ROOT=");
    expect(script).not.toContain("PI_SUBAGENTURA_AGENT_ID=");
    expect(script).not.toContain("PI_SUBAGENTURA_DEPTH=");
    const bootstrapName = readdirSync(state.artifactDir).find((name) =>
      name.startsWith(".lineage-bootstrap-"),
    );
    expect(bootstrapName).toBeDefined();
    const bootstrap = JSON.parse(
      readFileSync(join(state.artifactDir, bootstrapName!), "utf8"),
    );
    expect(bootstrap.context).toMatchObject({
      role: "descendant",
      rootId: "pi",
      currentAgentId: state.id,
      depth: 1,
    });
  });

  it("the persisted entry records windowName, mux, and artifactDir", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
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
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
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
