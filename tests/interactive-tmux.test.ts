import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveInteractiveSubagentStatus,
  deriveInteractiveSubagentStatusFromEvents,
} from "../src/interactive-tmux";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFresh } from "./test-utils";
import { hashLineageRoot } from "../src/interactive-lineage";

import { loadInteractiveStates } from "../src/artifact";
/** Standard tmux pane id returned by mocks when "new-window"/"split-window" is called. */
const MOCK_PANE_ID = "%42";
/** Tab-separated session/window/pane — matches real tmux #{...} format. */
const MOCK_LOCATION = "sess\t1\t0\n";

function installMockExec(scenario: (file: string, args: string[]) => string) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) =>
      scenario("tmux", args as string[]),
  }));
  // Ensure getMux selects tmux, not zellij. The mock only handles tmux
  // commands; if ZELLIJ_SESSION_NAME is set from the outer environment,
  // getMux would pick zellij and the mock would not intercept its calls.
  delete process.env.ZELLIJ;
  delete process.env.ZELLIJ_SESSION_NAME;
}

function lineageNodesDir(sessionRoot: string, rootId: string): string {
  return join(
    sessionRoot,
    "subagentura",
    "trees",
    hashLineageRoot(rootId),
    "nodes",
  );
}

/** Write a schema-valid node manifest so the prune sweep can read it. */
function writeLineageNode(
  nodesDir: string,
  agentId: string,
  paneId: string,
  parentAgentId?: string,
): void {
  writeFileSync(
    join(nodesDir, `${agentId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      agentId,
      rootId: "root-session",
      rootHash: hashLineageRoot("root-session"),
      parentAgentId,
      ownerSessionId: "owner-session",
      name: agentId,
      taskPreview: "task",
      startedAt: "2026-07-25T10:00:00.000Z",
      cwd: "/repo",
      pane: { backend: "tmux", paneId },
    }) + "\n",
  );
}

function makeArgs() {
  return {
    TMUX: "/tmp/tmux-1000/default,12345,0",
    TMUX_PANE: "%1",
    HOME: process.env.HOME ?? "/tmp",
    PI_CODING_AGENT_SESSION_DIR: undefined as string | undefined,
  };
}

describe("interactive-tmux", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
  });

  afterEach(() => {
    rmSync(makeTmp(), { recursive: true, force: true });
    delete process.env.PI_SUBAGENTURA_AGENT_ID;
    delete process.env.PI_SUBAGENTURA_ROOT_ID;
    delete process.env.PI_SUBAGENTURA_DEPTH;
    delete process.env.PI_SUBAGENTURA_MAX_DEPTH;
    delete process.env.PI_SUBAGENTURA_MAX_NODES;
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.doUnmock("../src/artifact");
  });

  it("is unavailable when tmux binary is not on PATH", async () => {
    process.env.TMUX = "";
    vi.doMock(
      "node:child_process",
      () =>
        ({
          execFileSync: () => {
            throw new Error("command not found");
          },
        }) as unknown as typeof import("node:child_process"),
    );
    const { isTmuxAvailable } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    expect(isTmuxAvailable()).toBe(false);
  });

  it("launches in background mode by default (new-window) and stores window-name attach commands", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    // No `background` flag — should default to true (hidden).
    const state = mod.launchInteractiveSubagent({
      name: "Demo",
      task: "Run tests",
      persona: "You are a tester",
      cwd: tmp,
    });

    expect(state.paneId).toBe(MOCK_PANE_ID);
    expect(state.windowName).toBe("demo");
    // Background mode: attach command should target the named window, not the
    // pane — and the window target must carry the session qualifier
    // (MOCK_LOCATION reports session `sess`). A bare `-t 'demo'` resolves
    // against whichever session tmux scans first, so two agents sharing a
    // safe-segmented name would send the user to the wrong one.
    expect(state.attachCommand).toContain("select-window -t 'sess:demo'");
    expect(state.attachCommand).not.toContain("select-pane");
    expect(state.selectPaneCommand).toContain("select-window -t 'sess:demo'");

    // new-window was used (not split-window) — the user's tmux layout is undisturbed.
    const usedNewWindow = calls.some((args) => args[0] === "new-window");
    const usedSplitWindow = calls.some((args) => args[0] === "split-window");
    expect(usedNewWindow).toBe(true);
    expect(usedSplitWindow).toBe(false);

    // Launch script embeds an EXIT trap that writes @pi-exit-code to the pane.
    expect(existsSync(state.launchScriptFile)).toBe(true);
    const launchScript = readFileSync(state.launchScriptFile, "utf8");
    expect(launchScript).toContain("trap");
    expect(launchScript).toContain("@pi-exit-code");
    expect(launchScript).toContain("pi --session");
    // Tightened perms — only the owning user can read the script.
    expect(statSync(state.launchScriptFile).mode & 0o777).toBe(0o700);

    // Registry has the state.
    expect(mod.interactiveSubagentRegistry.get(state.id)).toBe(state);

    // Artifact dir was created and the inline CLI was written.
    expect(state.artifactDir).toBeTruthy();
    expect(existsSync(state.artifactDir)).toBe(true);
    expect(existsSync(join(state.artifactDir, "cli.mjs"))).toBe(true);
    expect(statSync(join(state.artifactDir, "cli.mjs")).mode & 0o777).toBe(
      0o700,
    );

    // Omitting parentSessionId keeps workflow-style children out of rehydrate state.
    expect(existsSync(join(tmp, ".pi", "subagentura-state.json"))).toBe(false);
  });

  it("writes a lineage manifest before exposure and propagates child identity", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_AGENT_ID = "parent-agent";
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_DEPTH = "1";
    process.env.PI_SUBAGENTURA_MAX_DEPTH = "4";
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";
    installMockExec((_file, args) => {
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    const state = mod.launchInteractiveSubagent({
      name: "Nested",
      task: "spawn recursively",
      cwd: tmp,
      parentSessionId: "owner-session",
      parentCwd: tmp,
    });

    const manifestPath = join(
      tmp,
      "subagentura",
      "trees",
      hashLineageRoot("root-session"),
      "nodes",
      `${state.id}.json`,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      agentId: state.id,
      parentAgentId: "parent-agent",
      rootId: "root-session",
      ownerSessionId: "owner-session",
      cwd: tmp,
    });
    const launchScript = readFileSync(state.launchScriptFile, "utf8");
    expect(launchScript).toContain(
      `export PI_SUBAGENTURA_AGENT_ID='${state.id}'`,
    );
    expect(launchScript).toContain("export PI_SUBAGENTURA_DEPTH='2'");
  });

  it("rejects recursive spawns beyond the configured depth before creating a pane", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_DEPTH = "2";
    process.env.PI_SUBAGENTURA_MAX_DEPTH = "2";
    process.env.TMUX = makeArgs().TMUX;
    const calls: string[][] = [];
    installMockExec((_file, args) => {
      calls.push(args);
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Too deep",
        task: "fail",
        cwd: tmp,
        parentSessionId: "owner-session",
      }),
    ).toThrow(/depth 3 exceeds max 2/);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
  });

  it("rejects recursive spawns when the lineage node cap is reached", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_MAX_NODES = "1";
    const nodesDir = join(
      tmp,
      "subagentura",
      "trees",
      hashLineageRoot("root-session"),
      "nodes",
    );
    mkdirSync(nodesDir, { recursive: true });
    writeFileSync(join(nodesDir, "existing.json"), "{}\n");
    process.env.TMUX = makeArgs().TMUX;
    const calls: string[][] = [];
    installMockExec((_file, args) => {
      calls.push(args);
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Too many",
        task: "fail",
        cwd: tmp,
        parentSessionId: "owner-session",
      }),
    ).toThrow(/reached max nodes 1/);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
  });

  it("prunes dead lineage nodes so an all-time spawn total cannot wedge the tree", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_MAX_NODES = "4";
    const nodesDir = lineageNodesDir(tmp, "root-session");
    mkdirSync(nodesDir, { recursive: true });
    for (let index = 0; index < 4; index++) {
      writeLineageNode(nodesDir, `dead${index}`, `%${index + 10}`);
    }
    process.env.TMUX = makeArgs().TMUX;
    installMockExec((_file, args) => {
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "list-panes") return "";
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    const state = mod.launchInteractiveSubagent({
      name: "Revived",
      task: "spawn after the tree filled up with dead nodes",
      cwd: tmp,
      parentSessionId: "owner-session",
      parentCwd: tmp,
    });

    expect(state.id).toBeTruthy();
    const remaining = readdirSync(nodesDir).filter((entry) =>
      entry.endsWith(".json"),
    );
    expect(remaining).toEqual([`${state.id}.json`]);
  });

  it("admits by active count when a dead ancestor is retained for a live child", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_MAX_NODES = "2";
    const nodesDir = lineageNodesDir(tmp, "root-session");
    mkdirSync(nodesDir, { recursive: true });
    writeLineageNode(nodesDir, "dead-parent", "%30");
    writeLineageNode(nodesDir, "live-child", "%31", "dead-parent");
    process.env.TMUX = makeArgs().TMUX;
    installMockExec((_file, args) => {
      if (args[0] === "list-panes") return "%31\n";
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    const state = mod.launchInteractiveSubagent({
      name: "Within active cap",
      task: "spawn while a stale ancestor preserves lineage",
      cwd: tmp,
      parentSessionId: "owner-session",
      parentCwd: tmp,
    });

    expect(state.id).toBeTruthy();
    expect(
      readdirSync(nodesDir).filter((entry) => entry.endsWith(".json")),
    ).toEqual(
      expect.arrayContaining([
        "dead-parent.json",
        "live-child.json",
        `${state.id}.json`,
      ]),
    );
  });

  it("counts unknown panes against spawn admission", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_MAX_NODES = "1";
    const nodesDir = lineageNodesDir(tmp, "root-session");
    mkdirSync(nodesDir, { recursive: true });
    writeLineageNode(nodesDir, "unknown", "%32");
    process.env.TMUX = makeArgs().TMUX;
    const calls: string[][] = [];
    installMockExec((_file, args) => {
      calls.push(args);
      if (args[0] === "list-panes") throw new Error("tmux socket unavailable");
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Unknown capacity",
        task: "must remain bounded",
        cwd: tmp,
        parentSessionId: "owner-session",
      }),
    ).toThrow(/reached max nodes 1/);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
    expect(readdirSync(nodesDir)).toEqual(["unknown.json"]);
  });

  it("still refuses a spawn when every retained lineage node is live", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.PI_SUBAGENTURA_ROOT_ID = "root-session";
    process.env.PI_SUBAGENTURA_MAX_NODES = "4";
    const nodesDir = lineageNodesDir(tmp, "root-session");
    mkdirSync(nodesDir, { recursive: true });
    for (let index = 0; index < 4; index++) {
      writeLineageNode(nodesDir, `live${index}`, `%${index + 20}`);
    }
    process.env.TMUX = makeArgs().TMUX;
    const calls: string[][] = [];
    installMockExec((_file, args) => {
      calls.push(args);
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "list-panes") {
        return "%20\n%21\n%22\n%23\n";
      }
      return "";
    });
    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );

    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Too many",
        task: "fail",
        cwd: tmp,
        parentSessionId: "owner-session",
      }),
    ).toThrow(/reached max nodes 4/);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
    expect(
      readdirSync(nodesDir).filter((entry) => entry.endsWith(".json")),
    ).toHaveLength(4);
  });

  it("launches in visible-split mode when background: false", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "split-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    const state = mod.launchInteractiveSubagent({
      name: "Demo",
      task: "Run tests",
      cwd: tmp,
      background: false,
    });

    // Visible-split mode: pane is in a side-by-side, attach by pane id.
    expect(state.paneId).toBe(MOCK_PANE_ID);
    expect(state.windowName).toBeUndefined();
    expect(state.attachCommand).toContain("select-pane -t '%42'");
    expect(state.selectPaneCommand).toBe("tmux select-pane -t '%42'");

    const usedSplitWindow = calls.some((args) => args[0] === "split-window");
    const usedNewWindow = calls.some((args) => args[0] === "new-window");
    expect(usedSplitWindow).toBe(true);
    expect(usedNewWindow).toBe(false);
  });

  it("kills the orphan pane if writeLaunchScript fails after createTmuxPane", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    // Pre-create a path that will collide with the launch script so writeFileSync
    // throws EEXIST. We do this by mocking fs to make writeFileSync fail on the
    // launch script path.
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });
    // Override fs so the launch script write throws.
    vi.doMock("node:fs", async () => {
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...real,
        writeFileSync: (path: any, data: any, options?: any) => {
          if (typeof path === "string" && path.endsWith("-launch.sh")) {
            throw new Error("simulated disk full");
          }
          return real.writeFileSync(path, data, options);
        },
      };
    });

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Demo",
        task: "Run tests",
        cwd: tmp,
      }),
    ).toThrow(/simulated disk full/);

    // F2 fix: the pane should have been killed (no orphan left in tmux).
    const killedPane = calls.some(
      (args) =>
        args[0] === "kill-pane" &&
        args.includes("-t") &&
        args.includes(MOCK_PANE_ID),
    );
    expect(killedPane).toBe(true);

    // Registry should not have the failed sub-agent.
    expect(mod.interactiveSubagentRegistry.size).toBe(0);
  });

  it("kills the pane and aborts launch if persisted state cannot be written", async () => {
    const tmp = makeTmp();
    process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
    process.env.TMUX = makeArgs().TMUX;
    process.env.TMUX_PANE = "%9";

    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "display-message") return MOCK_LOCATION;
      if (args[0] === "show-options") return "0\n";
      return "";
    });

    vi.doMock("../src/artifact", async () => {
      const real =
        await vi.importActual<typeof import("../src/artifact")>(
          "../src/artifact",
        );
      return {
        ...real,
        appendInteractiveState: () => {
          throw new Error("state write failed");
        },
      };
    });

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(() =>
      mod.launchInteractiveSubagent({
        name: "Demo",
        task: "Run tests",
        cwd: tmp,
        parentSessionId: "parent-session",
      }),
    ).toThrow(/state write failed/);

    const killedPane = calls.some(
      (args) =>
        args[0] === "kill-pane" &&
        args.includes("-t") &&
        args.includes(MOCK_PANE_ID),
    );
    expect(killedPane).toBe(true);
    expect(calls.some((args) => args[0] === "send-keys")).toBe(false);
    expect(mod.interactiveSubagentRegistry.size).toBe(0);
  });

  it("readPaneExitCode returns the captured exit code, or null when unset", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;

    // Mock returning a numeric exit code.
    installMockExec((_f, args) => {
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const mod1 = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(mod1.readPaneExitCode(MOCK_PANE_ID)).toBe(0);

    // Mock returning empty string (option not yet set).
    installMockExec((_f, args) => {
      if (args[0] === "show-options") return "\n";
      return "";
    });
    const mod2 = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(mod2.readPaneExitCode(MOCK_PANE_ID)).toBeNull();

    // Mock throwing (pane dead / option unset).
    installMockExec((_f, args) => {
      if (args[0] === "show-options") throw new Error("no such pane");
      return "";
    });
    const mod3 = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(mod3.readPaneExitCode(MOCK_PANE_ID)).toBeNull();
  });

  it("readPaneExitCode suppresses tmux stderr (regression: 'invalid option' leak into parent TUI)", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;

    // Capture the options passed to execFileSync so we can assert stdio ignores
    // stderr. This guards against the regression where, while the child is still
    // running, tmux's `invalid option: @pi-exit-code` leaked into the parent TUI.
    const capturedOptions: Array<Record<string, unknown> | undefined> = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[], options?: unknown) => {
        capturedOptions.push(options as Record<string, unknown> | undefined);
        if (args[0] === "show-options") throw new Error("unset");
        return "";
      },
    }));

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    expect(mod.readPaneExitCode(MOCK_PANE_ID)).toBeNull();

    // The execFileSync call must use stdio that explicitly ignores stderr.
    // Inheriting stderr would let tmux errors leak into the parent's TUI when
    // the option is unset.
    expect(capturedOptions.length).toBeGreaterThan(0);
    for (const opts of capturedOptions) {
      expect(opts).toBeDefined();
      const stdio = opts!.stdio as [string, string, string] | undefined;
      expect(
        stdio,
        "stdio must be specified to avoid inheriting stderr",
      ).toBeDefined();
      expect(stdio![2]).toBe("ignore");
    }
  });

  it("pruneDeadInteractiveSubagents uses the incremental lifecycle fold", async () => {
    process.env.PI_CODING_AGENT_SESSION_DIR = makeTmp();
    process.env.TMUX = makeArgs().TMUX;
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const message = `can't find pane: ${MOCK_PANE_ID}`;
        callback(new Error(message), "", message);
      },
    }));

    const mod = await importFresh<typeof import("../src/interactive-tmux")>(
      "../src/interactive-tmux",
    );
    const { mkdirSync } = await import("node:fs");

    // Case 1: artifact has a `done` event → "exited" with code 0.
    {
      const dir = join(makeTmp(), "a1");
      mkdirSync(dir, { recursive: true });
      const state: import("../src/interactive-tmux").InteractiveSubagentState =
        {
          id: "a1",
          name: "A",
          task: "t",
          paneId: MOCK_PANE_ID,
          sessionFile: "/nonexistent.jsonl",
          cwd: "/tmp",
          startedAt: Date.now(),
          status: "running",
          mux: "tmux",
          attachCommand: "",
          selectPaneCommand: "",
          launchScriptFile: "/dev/null",
          artifactDir: dir,
          lifecycle: {
            completionOutcome: "done",
            completionSource: "explicit",
            completionExitCode: 0,
          },
        };
      mod.interactiveSubagentRegistry.set(state.id, state);
      await mod.pruneDeadInteractiveSubagents();
      expect(state.status).toBe("exited");
      expect(state.exitCode).toBe(0);
    }

    // Case 2: artifact has a `cancelled` event → "cancelled".
    {
      const dir = join(makeTmp(), "a2");
      mkdirSync(dir, { recursive: true });
      const state: import("../src/interactive-tmux").InteractiveSubagentState =
        {
          id: "a2",
          name: "B",
          task: "t",
          paneId: MOCK_PANE_ID,
          sessionFile: "/nonexistent.jsonl",
          cwd: "/tmp",
          startedAt: Date.now(),
          status: "running",
          mux: "tmux",
          attachCommand: "",
          selectPaneCommand: "",
          launchScriptFile: "/dev/null",
          artifactDir: dir,
          lifecycle: { parentCancelled: true },
        };
      mod.interactiveSubagentRegistry.set(state.id, state);
      await mod.pruneDeadInteractiveSubagents();
      expect(state.status).toBe("cancelled");
    }
  });

  describe("deriveInteractiveSubagentStatus (pure status-decision matrix)", () => {
    // Event factories — keep them tiny, the matrix is what matters.
    const startedEv = {
      ts: 1,
      type: "started" as const,
      status: "running" as const,
    };
    const doneEv = {
      ts: 2,
      type: "done" as const,
      status: "done" as const,
      exitCode: 0,
    };
    const errorEv = {
      ts: 3,
      type: "error" as const,
      status: "error" as const,
      message: "boom",
    };
    const cancelledEv = {
      ts: 4,
      type: "cancelled" as const,
      status: "cancelled" as const,
    };
    const v2ErrorCompletion = {
      version: 2 as const,
      eventId: "event-error",
      turnId: "turn-error",
      ts: 5,
      type: "completion" as const,
      status: "error" as const,
      outcome: "error" as const,
      source: "agent_end" as const,
    };
    const processExited = {
      version: 2 as const,
      eventId: "event-exit",
      turnId: "turn-error",
      ts: 6,
      type: "process_exited" as const,
      status: "error" as const,
      exitCode: 1,
    };

    it("started event + pane alive → 'running' (mid-turn)", () => {
      expect(deriveInteractiveSubagentStatus(startedEv, true)).toBe("running");
    });
    it("no event + pane alive → 'running' (about to start)", () => {
      expect(deriveInteractiveSubagentStatus(null, true)).toBe("running");
    });
    it("done event + pane alive → 'idle' (the follow-up case)", () => {
      expect(deriveInteractiveSubagentStatus(doneEv, true)).toBe("idle");
    });
    it("done event + pane dead → 'exited' (terminal)", () => {
      expect(deriveInteractiveSubagentStatus(doneEv, false)).toBe("exited");
    });
    it("error event + pane alive → 'exited' (child declared it unrecoverable)", () => {
      expect(deriveInteractiveSubagentStatus(errorEv, true)).toBe("exited");
    });
    it("error event + pane dead → 'exited'", () => {
      expect(deriveInteractiveSubagentStatus(errorEv, false)).toBe("exited");
    });
    it("v2 error completion + pane alive → 'idle' for follow-up", () => {
      expect(deriveInteractiveSubagentStatus(v2ErrorCompletion, true)).toBe(
        "idle",
      );
    });
    it("process_exited + pane alive → 'exited' terminal", () => {
      expect(deriveInteractiveSubagentStatus(processExited, true)).toBe(
        "exited",
      );
    });
    it("trailing activity cannot mask current-turn completion", () => {
      expect(
        deriveInteractiveSubagentStatusFromEvents(
          [
            {
              version: 2,
              eventId: "start",
              turnId: "turn-error",
              ts: 1,
              type: "turn_started",
              status: "running",
            },
            v2ErrorCompletion,
            {
              version: 2,
              eventId: "activity",
              turnId: "turn-error",
              ts: 3,
              type: "tool_activity",
              status: "running",
              phase: "end",
            },
          ],
          true,
        ),
      ).toBe("idle");
    });
    it("trailing activity cannot mask process exit", () => {
      expect(
        deriveInteractiveSubagentStatusFromEvents(
          [
            processExited,
            {
              version: 2,
              eventId: "activity",
              turnId: "turn-error",
              ts: 7,
              type: "tool_activity",
              status: "running",
              phase: "end",
            },
          ],
          true,
        ),
      ).toBe("exited");
    });
    it("parent process cancellation is terminal without turn_started", () => {
      expect(
        deriveInteractiveSubagentStatusFromEvents(
          [
            {
              version: 2,
              eventId: "cancel",
              turnId: "process-cancel-id",
              ts: 1,
              type: "completion",
              status: "cancelled",
              outcome: "cancelled",
              source: "parent",
            },
          ],
          true,
        ),
      ).toBe("cancelled");
    });
    it("cancelled event + pane alive → 'cancelled' (terminal regardless of pane)", () => {
      expect(deriveInteractiveSubagentStatus(cancelledEv, true)).toBe(
        "cancelled",
      );
    });
    it("cancelled event + pane dead → 'cancelled'", () => {
      expect(deriveInteractiveSubagentStatus(cancelledEv, false)).toBe(
        "cancelled",
      );
    });
    it("no event + pane dead → 'unknown'", () => {
      expect(deriveInteractiveSubagentStatus(null, false)).toBe("unknown");
    });
  });

  // ------------------------------------------------------------------
  // Tests for the child completion protocol (buildChildSubagentProtocol),
  // the always-write system prompt behavior, the --append-system-prompt
  // wiring, and the buildPiInteractiveCommand CLI builder.
  // ------------------------------------------------------------------

  describe("buildChildSubagentProtocol", () => {
    // Fixture artifact dir used by the protocol tests. The function bakes the
    // path into the rendered prompt, so each test asserts against the same value.
    const FIXTURE_DIR = "/tmp/pi-subagentura-fixture";

    it("names all three completion signals (done / error / cancelled)", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);
      expect(protocol).toContain("done");
      expect(protocol).toContain("error");
      expect(protocol).toContain("cancelled");
    });

    it("points the child to the literal artifact paths (no shell var for write tool)", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);
      // The rendered protocol must use the literal absolute path, not a shell var.
      // The rendered protocol uses the literal absolute path in the actionable step
      // (the `write` tool checklist), AND mentions the $ARTIFACT_DIR form only in the
      // explanatory warning about why the literal form is required. The actionable form
      // is what the model will actually use; the explanatory mention exists to teach
      // it the failure mode of getting it wrong.
      expect(protocol).toContain(`${FIXTURE_DIR}/output.md`);
      expect(protocol).toContain(`${FIXTURE_DIR}/cli.mjs`);
      // Both forms should be present somewhere.
      expect(protocol).toMatch(/ARTIFACT_DIR/);
    });

    it("still shows the bash $ARTIFACT_DIR form for cli.mjs (env-var shell usage)", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);
      // The bash examples still use $ARTIFACT_DIR because the launch script exports it.
      expect(protocol).toContain("$ARTIFACT_DIR/cli.mjs");
    });

    it("tells the child to keep the REPL open after done", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);
      expect(protocol).toMatch(/REPL stays open/i);
      // The protocol explicitly warns against exiting the REPL (e.g. via /exit, Ctrl-D,
      // or by typing "exit"); phrasing varies but the message must reach the model.
      expect(protocol).toMatch(/do not call .\/exit.|press Ctrl-D/i);
    });

    it("tells the child to be brief after lifecycle completion", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);
      // The BE BRIEF directive lives at the top of the protocol so it gets
      // high attention. We match the literal "BE BRIEF" token so the exact
      // wording can be tuned without breaking the test.
      expect(protocol).toMatch(/BE BRIEF/);
    });

    it("requires done before the final assistant response on every turn", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol(FIXTURE_DIR);

      expect(protocol).toMatch(/A turn is not complete.*cli\.mjs.*returns/i);
      expect(protocol).toMatch(/every turn.*follow-up/i);
      expect(protocol).toMatch(
        /do not (?:produce|send|emit).*final assistant.*before.*cli\.mjs/i,
      );
      expect(protocol).toMatch(/final tool call/i);
      expect(protocol).toMatch(
        /if the command.*fails.*do not.*final assistant.*retry/i,
      );

      const doneCommand = protocol.indexOf('"$ARTIFACT_DIR/cli.mjs" done 0');
      const finalResponse = protocol.indexOf(
        "Only after the lifecycle command succeeds",
      );
      expect(doneCommand).toBeGreaterThanOrEqual(0);
      expect(finalResponse).toBeGreaterThan(doneCommand);
    });

    it("embeds the literal artifact dir in the rendered prompt", async () => {
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const protocol = buildChildSubagentProtocol("/tmp/some-other-dir");
      expect(protocol).toContain("/tmp/some-other-dir");
      // Sanity: the fixture from a different call must not appear here.
      expect(protocol).not.toContain("/tmp/pi-subagentura-fixture");
    });
  });

  it("repeats the mandatory completion contract in the initial task prompt", async () => {
    const { buildInteractivePrompt } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    const prompt = buildInteractivePrompt({ task: "inspect the project" });

    expect(prompt).toMatch(/^inspect the project/);
    expect(prompt).toMatch(/mandatory completion protocol/i);
    expect(prompt).toMatch(/before sending your final assistant response/i);
    expect(prompt).toContain('"$ARTIFACT_DIR/cli.mjs" done 0');
    expect(prompt).toMatch(/every turn/i);
  });

  describe("system prompt is always written", () => {
    // The "kills the orphan pane" test earlier in the file mocks node:fs to
    // throw on launch-script writes and never un-mocks it. Our tests need
    // real fs so launchInteractiveSubagent can write its files.
    beforeEach(() => {
      vi.doUnmock("node:fs");
    });

    it("writes a system-prompt file even when no persona is supplied", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const { buildChildSubagentProtocol } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const state = mod.launchInteractiveSubagent({
        name: "NoPersona",
        task: "x",
        cwd: tmp,
      });
      const sysFile = join(state.artifactDir, "nopersona-system.md");

      expect(existsSync(sysFile)).toBe(true);
      const content = readFileSync(sysFile, "utf8");
      // The system prompt must match the protocol function output for the
      // sub-agent's resolved artifactDir (the literal absolute path).
      expect(content).toBe(buildChildSubagentProtocol(state.artifactDir));
      expect(statSync(sysFile).mode & 0o777).toBe(0o600);
    });

    it("places the persona ABOVE the protocol (recency favors the protocol)", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "WithPersona",
        task: "x",
        persona: "PERSONA_MARKER",
        cwd: tmp,
      });

      const sysFile = join(state.artifactDir, "withpersona-system.md");

      const content = readFileSync(sysFile, "utf8");
      const personaIdx = content.indexOf("PERSONA_MARKER");
      const protocolIdx = content.indexOf("REPL stays open");
      expect(personaIdx).toBeGreaterThan(-1);
      expect(protocolIdx).toBeGreaterThan(-1);
      expect(personaIdx).toBeLessThan(protocolIdx);
    });

    it("rejects personas larger than 64 KiB", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec(() => MOCK_PANE_ID + "\n");

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const tooBig = "x".repeat(64 * 1024 + 1);
      let threw = false;
      try {
        mod.launchInteractiveSubagent({
          name: "BigPersona",
          task: "x",
          persona: tooBig,
          cwd: tmp,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/persona too large/);
      }
      expect(threw).toBe(true);
    });
  });

  describe("launch script wires --append-system-prompt", () => {
    // See note above about the orphan-pane test's stale fs mock.
    beforeEach(() => {
      vi.doUnmock("node:fs");
    });

    it("embeds --append-system-prompt with the system-prompt file path", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "Wire",
        task: "x",
        cwd: tmp,
      });

      const launchScript = readFileSync(state.launchScriptFile, "utf8");
      expect(launchScript).toContain("--append-system-prompt");
      // Filename should appear (shell-escaped) in the launch script.
      expect(launchScript).toMatch(/wire-system\.md/);
    });
  });

  describe("InteractiveSubagentState.notifyOnComplete", () => {
    // The public tool passes an effective mode before calling this low-level helper.
    // Direct callers without parent-session context retain the legacy inject fallback,
    // while the tool-level default is covered by subagent-interactive-default.test.ts.

    beforeEach(() => {
      vi.doUnmock("node:fs");
    });

    it("keeps the low-level inject fallback when mode is omitted", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "NoNotify",
        task: "x",
        cwd: tmp,
      });

      expect(state.notifyOnComplete).toBe("inject");
      expect(state.lastInjectedEventTs).toBeUndefined();
    });

    it("propagates notifyOnComplete: 'inject' from launchInteractiveSubagent to the state", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "InjectMode",
        task: "x",
        cwd: tmp,
        notifyOnComplete: "inject",
      });

      expect(state.notifyOnComplete).toBe("inject");
    });

    it("propagates notifyOnComplete: 'notify' from launchInteractiveSubagent to the state", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "NotifyMode",
        task: "x",
        cwd: tmp,
        notifyOnComplete: "notify",
      });

      expect(state.notifyOnComplete).toBe("notify");
    });

    it("propagates triggerTurnOnComplete from launchInteractiveSubagent to the state", async () => {
      const tmp = makeTmp();
      process.env.PI_CODING_AGENT_SESSION_DIR = tmp;
      process.env.TMUX = makeArgs().TMUX;
      process.env.TMUX_PANE = "%9";

      installMockExec((_f, args) => {
        if (args[0] === "new-window") return MOCK_PANE_ID + "\n";
        if (args[0] === "display-message") return MOCK_LOCATION;
        if (args[0] === "show-options") return "0\n";
        return "";
      });

      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "TriggerTurn",
        task: "x",
        cwd: tmp,
        notifyOnComplete: "notify",
        triggerTurnOnComplete: true,
        parentSessionId: "parent-session",
        parentCwd: tmp,
      });

      expect(state.triggerTurnOnComplete).toBe(true);
      expect(
        loadInteractiveStates(tmp)?.states[state.id]?.triggerTurnOnComplete,
      ).toBe(true);
    });
  });

  describe("buildPiInteractiveCommand", () => {
    it("starts with `cd <cwd> &&` and shell-escapes the cwd", async () => {
      const { buildPiInteractiveCommand } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const cmd = buildPiInteractiveCommand({
        sessionFile: "/s.jsonl",
        name: "n",
        promptFile: "/p.md",
        cwd: "/tmp/has space",
      });
      expect(cmd).toMatch(/^cd '\/tmp\/has space' &&/);
    });

    it("includes --session, --name, and the @<promptFile>", async () => {
      const { buildPiInteractiveCommand } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const cmd = buildPiInteractiveCommand({
        sessionFile: "/s.jsonl",
        name: "n",
        promptFile: "/p.md",
        cwd: "/c",
      });
      expect(cmd).toContain("--session '/s.jsonl'");
      expect(cmd).toContain("--name 'n'");
      // The prompt file is invoked via "@<file>" — verify the path appears in that form.
      expect(cmd).toMatch(/'\@\/p\.md'$/);
    });

    it("omits --model when undefined", async () => {
      const { buildPiInteractiveCommand } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const cmd = buildPiInteractiveCommand({
        sessionFile: "/s.jsonl",
        name: "n",
        promptFile: "/p.md",
        cwd: "/c",
      });
      expect(cmd).not.toContain("--model");
    });

    it("includes --model when set, escaped", async () => {
      const { buildPiInteractiveCommand } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const cmd = buildPiInteractiveCommand({
        sessionFile: "/s.jsonl",
        name: "n",
        promptFile: "/p.md",
        cwd: "/c",
        model: "p/m",
      });
      expect(cmd).toContain("--model 'p/m'");
    });

    it("includes --append-system-prompt when systemPromptFile is set", async () => {
      const { buildPiInteractiveCommand } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");
      const cmd = buildPiInteractiveCommand({
        sessionFile: "/s.jsonl",
        name: "n",
        promptFile: "/p.md",
        cwd: "/c",
        systemPromptFile: "/s.md",
      });
      expect(cmd).toContain("--append-system-prompt");
      expect(cmd).toContain("/s.md");
    });
  });
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-tmux-"));
}
