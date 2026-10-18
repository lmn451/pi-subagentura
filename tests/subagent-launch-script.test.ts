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
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildPiInteractiveCommand,
  cancelInteractiveSubagent,
  writeLaunchScript,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { stateFilePath, loadInteractiveStates } from "../src/artifact";
import { importFresh } from "./test-utils";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { awaitInteractiveResult } from "../src/workflow-worker";
import { createTelemetrySession } from "../src/telemetry";
import {
  clearSessionScopes,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";
import { createTestSessionScope } from "./session-scope-fixture";

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
    __setTmuxMultiplexer(undefined);
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
    expect(exits[0]).toMatchObject({
      exitCode: 0,
      terminationReason: "normal_exit",
    });
    expect(exits[0].exitCode).toBe(0);
  });

  it("records an active-tool reason for an rc=0 abrupt exit", () => {
    const artDir = join(tmp, "artifacts", "active-tool");
    const launchScript = join(artDir, "launch.sh");
    mkdirSync(artDir, { recursive: true });
    writeFileSync(
      join(artDir, "active-turn.json"),
      JSON.stringify({
        turnId: "active-turn",
        started: true,
        activeTools: [
          { name: "bash", callId: "tool-1", startedAt: Date.now() },
        ],
        lastTool: "bash",
        command: "secret must not be persisted",
      }),
    );

    expect(runLaunchScript(artDir, launchScript, "exit 0")).toBe(0);
    const events = readEvents(artDir);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "process_exited",
        status: "done",
        exitCode: 0,
        terminationReason: "active_tool",
        lastTool: "bash",
      }),
    );
    expect(JSON.stringify(events)).not.toContain("secret must not");
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
  it("returns the process-exit snapshot for an unbound provisional turn", async () => {
    const artDir = join(tmp, "artifacts", "early-exit");
    const launchScript = join(artDir, "launch.sh");
    const turnOutput = "startup diagnostics before exit";
    const childBody = [
      `printf '%s' '{"turnId":"turn-pending","started":false}' > "${join(artDir, "active-turn.json")}"`,
      `printf '%s' '${turnOutput}' > "${join(artDir, "output.md")}"`,
      "exit 1",
    ].join("\n");

    expect(runLaunchScript(artDir, launchScript, childBody)).toBe(1);
    writeFileSync(join(artDir, "output.md"), "output changed after exit");

    const state = {
      id: "early-exit",
      name: "Early exit",
      task: "retain process-exit diagnostics",
      paneId: "%99",
      mux: "tmux",
      sessionFile: join(tmp, "session.jsonl"),
      cwd: tmp,
      startedAt: Date.now(),
      status: "running",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: launchScript,
      artifactDir: artDir,
    } satisfies InteractiveSubagentState;
    __setTmuxMultiplexer({
      getPaneLiveness: () => "dead",
      getPaneLivenessAsync: async () => "dead",
    } as never);

    const result = await awaitInteractiveResult(state, undefined, 0);
    const [completion] = countCompletions(artDir, "error");
    expect(completion).toMatchObject({
      turnId: "turn-pending",
      source: "process_exit",
    });
    expect(result).toMatchObject({
      isError: true,
      output: turnOutput,
      errorMessage: completion.message,
    });
  });

  it("writes one parent-cancelled completion for the current turn when only the .cancelled marker exists", () => {
    const artDir = join(tmp, "artifacts", "abc12347");
    const launchScript = join(artDir, "launch.sh");
    const turnId = "cancelled-current-turn";

    // The parent marker is present without a completion; process exit must
    // publish the current turn's cancellation before recording its exit.
    mkdirSync(artDir, { recursive: true });
    writeFileSync(
      join(artDir, "active-turn.json"),
      JSON.stringify({ turnId, started: true }),
    );
    writeFileSync(join(artDir, ".cancelled"), "", { mode: 0o600 });
    expect(runLaunchScript(artDir, launchScript, "exit 0")).toBe(0);

    expect(countEvents(artDir, "completion")).toEqual([
      expect.objectContaining({
        type: "completion",
        turnId,
        status: "cancelled",
        outcome: "cancelled",
        source: "parent",
      }),
    ]);
    expect(countEvents(artDir, "process_exited")).toEqual([
      expect.objectContaining({
        turnId,
        status: "cancelled",
        exitCode: 0,
        terminationReason: "cancelled",
      }),
    ]);
  });

  it("deduplicates a runtime parent-cancellation completion when recording process exit", () => {
    const artDir = join(tmp, "artifacts", "abc12351");
    const launchScript = join(artDir, "launch.sh");
    const turnId = "runtime-cancelled-turn";
    mkdirSync(artDir, { recursive: true });
    writeFileSync(
      join(artDir, "active-turn.json"),
      JSON.stringify({ turnId, started: true }),
    );

    const state = {
      id: "abc12351",
      name: "Runtime cancellation",
      task: "exercise cancellation publication",
      paneId: "%99",
      mux: "tmux",
      sessionFile: join(tmp, "session.jsonl"),
      cwd: tmp,
      startedAt: Date.now(),
      status: "running",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: launchScript,
      artifactDir: artDir,
    } satisfies InteractiveSubagentState;
    __setTmuxMultiplexer({ getPaneLiveness: () => "dead" } as never);
    cancelInteractiveSubagent(state.id, "cancel_interactive_subagent", state);

    expect(runLaunchScript(artDir, launchScript, "exit 0")).toBe(0);

    expect(countEvents(artDir, "completion")).toEqual([
      expect.objectContaining({
        type: "completion",
        turnId,
        status: "cancelled",
        outcome: "cancelled",
        source: "parent",
        cancellationOrigin: "cancel_interactive_subagent",
      }),
    ]);
    expect(countEvents(artDir, "process_exited")).toEqual([
      expect.objectContaining({
        turnId,
        status: "cancelled",
        exitCode: 0,
        terminationReason: "normal_exit",
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

  it("uses the public Pi entry, preserves nested Node options, and reports a raw pre-turn error", () => {
    const childRoot = join(tmp, "child workspace with spaces ' and $()");
    const cwd = join(childRoot, "cwd with spaces ' and $()");
    const packageRoot = join(childRoot, "installed Pi package");
    const binDir = join(childRoot, "bin");
    const artifactDir = join(tmp, "artifact path with spaces ' and $()");
    const launchScript = join(artifactDir, "launch script.sh");
    const sessionFile = join(cwd, "session ' with spaces.jsonl");
    const promptFile = join(artifactDir, "prompt ' with spaces.md");
    const systemPromptFile = join(artifactDir, "system ' with spaces.md");
    const name = "Pi's Child $()";
    const model = "anthropic/claude-sonnet-4-5";
    const promptMessage =
      "Anthropic provider is not configured: raw value <unchanged>";
    const entryId = "pi-owned-prompt-error-entry";
    const proofFile = join(tmp, "public-main.json");
    const uiErrorFile = join(tmp, "ui-error.txt");
    const customEntryFile = join(tmp, "custom-entry.json");
    const originalCliMarker = join(tmp, "original-cli-ran");
    const guardPath = join(tmp, "network-guard.cjs");
    const inheritedNodeOptions = `--require=${guardPath}`;
    const injectionMarker = join(tmp, "preload-command-ran");
    const preloadPath = join(
      tmp,
      `preloader $(touch$IFS${injectionMarker}) $HOME`,
      "child-prompt-errors.mjs",
    );
    const preloadUrl = pathToFileURL(preloadPath).href;
    expect(preloadUrl).toContain("$(");
    expect(preloadUrl).toContain("$HOME");

    mkdirSync(join(preloadPath, ".."), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../src/child-prompt-errors.mjs", import.meta.url)),
      preloadPath,
    );
    mkdirSync(cwd, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const cliPath = join(packageRoot, "dist", "bundle", "cli.mjs");
    mkdirSync(join(packageRoot, "dist", "bundle"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        bin: { pi: "./dist/bundle/cli.mjs" },
        exports: {
          ".": {
            import: "./index.mjs",
            default: "./non-import-root.mjs",
          },
        },
      }),
    );
    writeFileSync(
      join(packageRoot, "non-import-root.mjs"),
      'throw new Error("the wrong conditional root was imported");',
    );
    writeFileSync(
      join(packageRoot, "index.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "export class AgentSession {",
        "  constructor(sessionFile) {",
        "    this.isStreaming = false;",
        "    this.sessionManager = {",
        "      sessionFile,",
        "      getSessionFile() {",
        "        return this.sessionFile;",
        "      },",
        "      getLeafId() {",
        "        return null;",
        "      },",
        "      getEntries() {",
        "        return [];",
        "      },",
        "      appendCustomEntry(type, data) {",
        "        writeFileSync(process.env.PI_TEST_CUSTOM_ENTRY, JSON.stringify({ type, data }));",
        `        return ${JSON.stringify(entryId)};`,
        "      },",
        "    };",
        "  }",
        "  async prompt() {",
        "    throw new Error(process.env.PI_TEST_PROMPT_ERROR);",
        "  }",
        "}",
        "export class AgentSessionRuntime {",
        "  constructor(session) { this.session = session; }",
        "  apply() { return this.session; }",
        "}",
        "export async function main(args) {",
        '  const sessionIndex = args.indexOf("--session");',
        "  const session = new AgentSession(args[sessionIndex + 1]);",
        "  writeFileSync(process.env.PI_TEST_PROOF, JSON.stringify({",
        "    args,",
        "    cwd: process.cwd(),",
        "    nodeOptions: process.env.NODE_OPTIONS,",
        "    guardLoaded: process.env.PI_TEST_GUARD_LOADED,",
        "  }));",
        "  try {",
        "    await session.prompt();",
        "  } catch (error) {",
        "    writeFileSync(process.env.PI_TEST_UI_ERROR, error.message);",
        "  }",
        "  return 0;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      cliPath,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.env.PI_TEST_ORIGINAL_MARKER, "original CLI ran");',
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(cliPath, 0o700);
    symlinkSync(cliPath, join(binDir, "pi"));
    writeFileSync(guardPath, 'process.env.PI_TEST_GUARD_LOADED = "yes";');

    const command = buildPiInteractiveCommand({
      sessionFile,
      name,
      promptFile,
      systemPromptFile,
      model,
      cwd,
    });
    writeLaunchScript(launchScript, command, artifactDir, {}, preloadUrl);
    const result = spawnSync("bash", [launchScript], {
      env: {
        ...process.env,
        ARTIFACT_DIR: artifactDir,
        NODE_OPTIONS: inheritedNodeOptions,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PI_TEST_CUSTOM_ENTRY: customEntryFile,
        PI_TEST_GUARD_LOADED: "",
        PI_TEST_ORIGINAL_MARKER: originalCliMarker,
        PI_TEST_PROOF: proofFile,
        PI_TEST_PROMPT_ERROR: promptMessage,
        PI_TEST_UI_ERROR: uiErrorFile,
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);

    const proof = JSON.parse(readFileSync(proofFile, "utf8"));
    expect(proof).toEqual({
      args: [
        "--session",
        sessionFile,
        "--name",
        name,
        "--model",
        model,
        "--append-system-prompt",
        systemPromptFile,
        `@${promptFile}`,
      ],
      cwd: expect.any(String),
      nodeOptions: inheritedNodeOptions,
      guardLoaded: "yes",
    });
    expect(realpathSync(proof.cwd)).toBe(realpathSync(cwd));
    expect(readFileSync(uiErrorFile, "utf8")).toBe(promptMessage);
    expect(JSON.parse(readFileSync(customEntryFile, "utf8"))).toEqual({
      type: "subagentura-prompt-error",
      data: { schemaVersion: 1 },
    });
    expect(existsSync(originalCliMarker)).toBe(false);
    expect(existsSync(injectionMarker)).toBe(false);
    expect(countCompletions(artifactDir, "error")).toContainEqual(
      expect.objectContaining({
        turnId: entryId,
        status: "error",
        outcome: "error",
        source: "prompt_error",
        message: promptMessage,
        errorMessage: promptMessage,
      }),
    );
  });
});

// ── Mock tmux exec so launchInteractiveSubagent doesn't create real tmux
// windows during the test run. The existing launch script tests above run
// real bash + the wrapper and don't need a tmux mock; the spawn-persistence
// tests below drive launchInteractiveSubagent directly and would otherwise
// leave orphan tmux windows behind (test pollution).
interface TmuxMockOptions {
  sendKeysError?: string;
  attachError?: string;
}

let tmuxMockOptions: TmuxMockOptions = {};
let tmuxMockCalls: string[][] = [];
let tmuxDisplayMessageCalls = 0;

function installTmuxMock(options: TmuxMockOptions = {}): string[][] {
  tmuxMockOptions = options;
  tmuxMockCalls = [];
  tmuxDisplayMessageCalls = 0;
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      tmuxMockCalls.push(args);
      if (args[0] === "send-keys" && tmuxMockOptions.sendKeysError) {
        throw new Error(tmuxMockOptions.sendKeysError);
      }
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
        tmuxDisplayMessageCalls += 1;
        if (tmuxDisplayMessageCalls > 1 && tmuxMockOptions.attachError) {
          throw new Error(tmuxMockOptions.attachError);
        }
        return "sess\t1\t0\n";
      }
      return "";
    },
  }));
  return tmuxMockCalls;
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
  let scope: SessionScope;
  let tmuxCalls: string[][];
  let savedEnv: Record<SpawnEnvName, string | undefined>;
  const SESSION = "019e500a-bae9-783a-869a-ac7c106b4ab7";

  beforeEach(() => {
    tmuxCalls = installTmuxMock();
    cwd = mkdtempSync(join(tmpdir(), "pi-subagentura-spawn-persist-"));
    clearSessionScopes();
    scope = createTestSessionScope({
      cwd,
      sessionManager: { getSessionId: () => "pi" },
    });
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
    vi.doUnmock("../src/spawn-tree-context");
    vi.unstubAllGlobals();
    clearSessionScopes();
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
      sessionScope: scope,
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

  it("records one created agent when an interactive pane launches", async () => {
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const spawnTreeContext = createRootSpawnTreeContext(
      SESSION,
      cwd,
      false,
      true,
      4,
    );
    const scope = registerSessionScope({
      id: 777,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      telemetry: createTelemetrySession(true, "orchestrator_v2"),
      spawnTreeContext,
    });
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "never sent to telemetry",
      cwd,
      parentSessionId: SESSION,
      sessionScope: scope,
      spawnTreeContext,
      telemetryInvocationSource: "interactive",
      telemetryAsync: true,
      completionPolicy: "each",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi_subagentura_agent_created",
      properties: {
        mode: "orchestrator_v2",
        execution: "interactive",
        mux: "tmux",
        invocation_source: "interactive",
        depth: 1,
        completion_policy: "each",
      },
    });
    expect(JSON.stringify(payloads)).not.toContain("never sent to telemetry");
    expect(
      loadInteractiveStates(cwd)?.states[state.id]?.telemetry,
    ).toMatchObject({ depth: 1, depthBucket: "1", mux: "tmux" });
  });

  it("defers creation telemetry until coordinated registration succeeds", async () => {
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const spawnTreeContext = createRootSpawnTreeContext(
      SESSION,
      cwd,
      false,
      true,
      4,
    );
    const scope = registerSessionScope({
      id: 778,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      telemetry: createTelemetrySession(true, "orchestrator_v2"),
      spawnTreeContext,
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    const state = mod.launchInteractiveSubagent({
      name: "Deferred",
      task: "never sent to telemetry",
      cwd,
      parentSessionId: SESSION,
      sessionScope: scope,
      spawnTreeContext,
      telemetryInvocationSource: "interactive",
      telemetryAsync: true,
      completionPolicy: "group",
      deferAgentCreatedTelemetry: true,
    });

    expect(payloads).toHaveLength(0);
    mod.captureInteractiveSubagentCreatedTelemetry(state);
    mod.captureInteractiveSubagentCreatedTelemetry(state);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi_subagentura_agent_created",
      properties: { execution: "interactive", completion_policy: "group" },
    });
  });

  it("reports lineage bootstrap write failures as state_persistence", async () => {
    tmuxCalls = installTmuxMock();
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    vi.doMock("../src/spawn-tree-context", async () => {
      const real = await vi.importActual<
        typeof import("../src/spawn-tree-context")
      >("../src/spawn-tree-context");
      return {
        ...real,
        writeLineageBootstrap: () => {
          throw new Error("lineage persistence failed");
        },
      };
    });
    const spawnTreeContext = createRootSpawnTreeContext(
      SESSION,
      cwd,
      false,
      true,
      4,
    );
    const scope = registerSessionScope({
      id: 779,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      telemetry: createTelemetrySession(true, "orchestrator_v2"),
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Lineage failure",
        task: "not sent to telemetry",
        cwd,
        parentSessionId: SESSION,
        sessionScope: scope,
        spawnTreeContext,
        telemetryInvocationSource: "interactive",
        telemetryAsync: true,
      }),
    ).toThrow(/lineage persistence failed/);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi_subagentura_agent_spawn_failed",
      properties: {
        failure_stage: "state_persistence",
        failure_operation: "lineage_bootstrap_write",
      },
    });
    expect(tmuxCalls.some((args) => args[0] === "send-keys")).toBe(false);
  });

  it.each([
    {
      label: "mux send",
      options: { sendKeysError: "mux send failed" },
      message: "send-keys failed",
    },
    {
      label: "mux attach",
      options: { attachError: "mux attach failed" },
      message: "display-message failed",
    },
  ] as const)("reports $label failures as pane_launch", async (testCase) => {
    tmuxCalls = installTmuxMock(testCase.options);
    const payloads: Array<{
      event: string;
      properties: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }),
    );
    const scope = registerSessionScope({
      id: 780,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      telemetry: createTelemetrySession(true, "orchestrator_v2"),
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Mux failure",
        task: "not sent to telemetry",
        cwd,
        parentSessionId: SESSION,
        sessionScope: scope,
        telemetryInvocationSource: "interactive",
        telemetryAsync: true,
      }),
    ).toThrow(new RegExp(testCase.message));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi_subagentura_agent_spawn_failed",
      properties: { failure_stage: "pane_launch" },
    });
    expect(tmuxCalls.some((args) => args[0] === "kill-pane")).toBe(true);
  });

  it("launchInteractiveSubagent without parentSessionId does NOT write the state file", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      sessionScope: scope,
    });
    expect(existsSync(stateFilePath(cwd))).toBe(false);
  });

  it("execs the wrapper so child exit cannot leave a shell target", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      sessionScope: scope,
    });

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
      sessionScope: scope,
      spawnTreeContext: createRootSpawnTreeContext(
        "pi",
        cwd,
        false,
        false,
        undefined,
        "123e4567-e89b-42d3-a456-426614174000",
        "orchestrator_v2",
      ),
    });

    const script = readFileSync(state.launchScriptFile, "utf8");
    expect(script).toContain("PI_SUBAGENTURA_LINEAGE_BOOTSTRAP=");
    expect(script).not.toContain("PI_SUBAGENTURA_ROOT_ID=");
    expect(script).not.toContain("PI_SUBAGENTURA_LINEAGE_SESSION_ROOT=");
    expect(script).not.toContain("PI_SUBAGENTURA_AGENT_ID=");
    expect(script).not.toContain("PI_SUBAGENTURA_DEPTH=");
    expect(script).not.toContain("PI_SUBAGENTURA_TELEMETRY_SESSION_ID=");
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
      telemetrySessionId: "123e4567-e89b-42d3-a456-426614174000",
      telemetryMode: "orchestrator_v2",
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
      sessionScope: scope,
    });
    const loaded = loadInteractiveStates(cwd);
    const entry = loaded?.states[state.id];
    expect(entry?.windowName).toBe(state.windowName);
    expect(entry?.mux).toBe(state.mux);
    expect(entry?.artifactDir).toBe(state.artifactDir);
    expect(entry?.sessionFile).toBe(state.sessionFile);
  });

  it("persists only a sanitized custom model telemetry dimension", async () => {
    const { launchInteractiveSubagent } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    const payloads: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        payloads.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    scope.telemetry = createTelemetrySession(true);
    const state = launchInteractiveSubagent({
      name: "Demo",
      task: "t",
      cwd,
      parentSessionId: "pi",
      model: "private-provider/customer-deployment-secret",
      sessionScope: scope,
    });

    expect(loadInteractiveStates(cwd)?.states[state.id]?.telemetry?.model).toBe(
      "custom",
    );
    expect(readFileSync(stateFilePath(cwd), "utf8")).not.toContain(
      "customer-deployment-secret",
    );
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
      sessionScope: scope,
    });
    expect(state.parentSessionId).toBe("pi");
    expect(state.cwd).toBe(cwd);
  });
});
