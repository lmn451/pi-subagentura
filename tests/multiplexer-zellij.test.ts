import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MultiplexerZellijModule from "../src/multiplexer-zellij";
import { importFresh } from "./test-utils";

/** Standard zellij pane id returned by mocks. Zellij uses bare integers. */
const MOCK_PANE_ID = "42";

/** JSON returned by `list-panes --json` when one pane exists. */
const PANES_BEFORE = JSON.stringify([{ id: 1, tab_position: 0 }]);

/** JSON with an added pane after `new-tab`. */
const PANES_AFTER = JSON.stringify([
  { id: 1, tab_position: 0 },
  { id: 2, tab_position: 1 },
]);

function installMockExec(scenario: (file: string, args: string[]) => string) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) =>
      scenario("zellij", args as string[]),
    execFile: (
      _file: string,
      args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      try {
        callback(null, scenario("zellij", args));
      } catch (error) {
        callback(error as Error, "");
      }
    },
  }));
}

function installMockSpawn(
  scenario: (
    args: string[],
    stdout: PassThrough,
    stderr: PassThrough,
    close: (code: number | null, signal?: NodeJS.Signals | null) => void,
  ) => void,
): void {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: () => "",
    spawn: (_file: string, args: string[]) => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        kill: vi.fn(() => true),
      });
      queueMicrotask(() =>
        scenario(args, stdout, stderr, (code, signal = null) => {
          child.emit("close", code, signal);
        }),
      );
      return child;
    },
  }));
}

/**
 * True for the `commandExists` availability probe.
 *
 * Pins the argv shape: `/bin/sh -c "command -v 'zellij'"`. Notably `-c`, NOT
 * `-lc` — the probe must not source the user's login profile on every call.
 */
function isCommandProbe(args: readonly string[]): boolean {
  return args[0] === "-c" && (args[1] ?? "").startsWith("command -v");
}

describe("multiplexer-zellij", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    delete process.env.ZELLIJ;
    delete process.env.ZELLIJ_SESSION_NAME;
  });

  /* ------------------------------------------------------------------ */
  /*  isAvailable                                                        */
  /* ------------------------------------------------------------------ */

  it("isAvailable returns true when ZELLIJ env var is set and binary exists", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      // command -v zellij — return empty means success
      if (isCommandProbe(args)) return "";
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isAvailable()).toBe(true);
  });

  it("isAvailable is binary-only: returns true even when ZELLIJ env var is unset", async () => {
    // Regression for the auto-resolution bug: isAvailable must NOT require
    // ZELLIJ === "0". The "am I inside zellij" heuristic lives in getMux();
    // keeping it out of isAvailable lets the relaxed-spawn fallback select
    // zellij from a plain terminal. Symmetric with TmuxMultiplexer.
    process.env.ZELLIJ = "";
    delete process.env.ZELLIJ_SESSION_NAME;
    installMockExec((_f, args) => {
      if (isCommandProbe(args)) return ""; // command -v zellij succeeds
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isAvailable()).toBe(true);
  });

  it("isAvailable returns false when zellij binary is not on PATH", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (isCommandProbe(args)) throw new Error("command not found");
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isAvailable()).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — background mode (new-tab)                             */
  /* ------------------------------------------------------------------ */

  it("createPane in background mode (new-tab) returns paneId and windowName", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    let listCallCount = 0;

    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("list-panes") && args.includes("--json")) {
        listCallCount++;
        return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
      }
      if (args.includes("new-tab")) return "";
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
    });

    expect(result.paneId).toBe("2");
    expect(result.windowName).toBe("demo");
    // In-session spawn: session is ZELLIJ_SESSION_NAME so later ops target it.
    expect(result.session).toBe("main");

    const usedNewTab = calls.some((a) => a.includes("new-tab"));
    const usedNewPane = calls.some((a) => a.includes("new-pane"));
    expect(usedNewTab).toBe(true);
    expect(usedNewPane).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — visible-split mode (new-pane)                         */
  /* ------------------------------------------------------------------ */

  it("createPane in visible-split mode (in zellij) uses new-pane and recovers the list-panes id via diff", async () => {
    // `new-pane`'s `terminal_<n>` stdout counter is NOT the same number as the
    // `id` field in `list-panes` (verified on zellij 0.44.3), so createPane
    // recovers the canonical id from a before/after list-panes diff — the same
    // number every other op (liveness/sendKeys/killPane) compares against.
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    let listCallCount = 0;

    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("list-panes") && args.includes("--json")) {
        listCallCount++;
        return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
      }
      if (args.includes("new-pane")) return "terminal_2\n"; // distinct counter; must be ignored
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: false,
    });

    expect(result.paneId).toBe("2"); // from list-panes diff, not new-pane stdout
    expect(result.windowName).toBeUndefined();

    const usedNewPane = calls.some((a) => a.includes("new-pane"));
    const usedNewTab = calls.some((a) => a.includes("new-tab"));
    expect(usedNewPane).toBe(true);
    expect(usedNewTab).toBe(false);
  });

  it("createPane new-pane passes neither --in-pane-id nor --close-on-exit", async () => {
    // `new-pane` has no `--in-pane-id` flag (parentPane has no mapping in
    // zellij — it splits the focused pane). And `--close-on-exit` makes a
    // trailing <COMMAND> mandatory, so passing it without a command makes
    // zellij exit non-zero. Both must be absent.
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    let listCallCount = 0;

    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("list-panes") && args.includes("--json")) {
        listCallCount++;
        return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
      }
      if (args.includes("new-pane")) return "terminal_2\n";
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: false,
      parentPane: "1",
    });

    const newPaneCall = calls.find((a) => a.includes("new-pane"));
    expect(newPaneCall).toBeDefined();
    expect(newPaneCall).not.toContain("--in-pane-id");
    expect(newPaneCall).not.toContain("--close-on-exit");
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — relaxed path (parent not in zellij)                   */
  /* ------------------------------------------------------------------ */

  it("createPane relaxed path creates a background session and forces new-tab (no attached client → no split)", async () => {
    // Parent not in zellij ⇒ no attached client. A visible split is invisible
    // and isn't tracked by list-panes in a detached session, so createPane
    // must force background (new-tab) mode even when background:false is asked
    // — mirroring the tmux backend's relaxed path.
    process.env.ZELLIJ = "";
    delete process.env.ZELLIJ_SESSION_NAME;
    const calls: string[][] = [];
    let listCallCount = 0;

    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("attach") && args.includes("--create-background"))
        return "";
      if (args.includes("list-panes") && args.includes("--json")) {
        listCallCount++;
        return listCallCount === 1 ? PANES_BEFORE : PANES_AFTER;
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: false, // asked for split, but relaxed path must override
      id: "abc12345",
    });

    expect(result.paneId).toBe("2");
    // The created session must be returned so the orchestrator can persist it
    // on state.muxSession and target later ops — it is NOT held on the
    // (resolver-shared) backend instance.
    expect(result.session).toBe("pi-subagent-abc12345");
    const attachCall = calls.find((a) => a.includes("attach"));
    expect(attachCall).toBeDefined();
    expect(attachCall).toContain("--create-background");
    expect(attachCall).toContain("pi-subagent-abc12345");
    // Forced background: new-tab, never new-pane.
    expect(calls.some((a) => a.includes("new-tab"))).toBe(true);
    expect(calls.some((a) => a.includes("new-pane"))).toBe(false);
    // And every action after session creation must carry --session <name>.
    const newTabCall = calls.find((a) => a.includes("new-tab"));
    expect(newTabCall).toEqual(
      expect.arrayContaining(["--session", "pi-subagent-abc12345"]),
    );
  });

  /* ------------------------------------------------------------------ */
  /*  pane liveness                                                      */
  /* ------------------------------------------------------------------ */

  it("reports a terminal pane present in a complete synchronous listing as alive", async () => {
    installMockExec((_file, args) => {
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 1 }, { id: 42 }, { id: 3 }]);
      }
      return "";
    });
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    expect(new ZellijMultiplexer().isPaneAlive("42")).toBe(true);
  });

  it("returns false when the synchronous listing omits the pane", async () => {
    installMockExec((_file, args) => {
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 1 }, { id: 2 }]);
      }
      return "";
    });
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    expect(new ZellijMultiplexer().isPaneAlive("99")).toBe(false);
  });

  it("returns false when a synchronous listing fails or is malformed", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("server unavailable");
      },
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    expect(new ZellijMultiplexer().isPaneAlive("42")).toBe(false);

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "{}",
    }));
    const malformedModule = await importFresh<typeof MultiplexerZellijModule>(
      "../src/multiplexer-zellij",
    );
    expect(new malformedModule.ZellijMultiplexer().isPaneAlive("42")).toBe(
      false,
    );
  });

  it("observePane uses execFile rather than execFileSync", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("sync liveness probe must not run");
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, JSON.stringify([{ id: 42 }])),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    await expect(new ZellijMultiplexer().observePane("42")).resolves.toEqual({
      kind: "alive",
    });
  });

  it("observePane distinguishes backend unavailability from confirmed death", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: NodeJS.ErrnoException | null, stdout: string) => void,
      ) => {
        const error = new Error("spawn zellij ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        callback(error, "");
      },
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    const unavailable = await new ZellijMultiplexer().observePane("42");
    expect(unavailable.kind).toBe("unavailable");
    if (unavailable.kind !== "unavailable") return;
    expect(unavailable.reason).toBeTypeOf("string");
  });

  it("observePane reports malformed JSON as explicitly unknown", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, "{not-json"),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    const unknown = await new ZellijMultiplexer().observePane("42");
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind !== "unknown") return;
    expect(unknown.reason).toBeTypeOf("string");
  });

  it.each([
    ["a non-array listing", { id: 42 }],
    ["a non-object row", [null]],
    ["a record without an id", [{ name: "pane" }]],
    ["an empty pane id", [{ id: "" }]],
    ["a prefixed pane id", [{ id: "terminal_7" }]],
    ["a leading-zero pane id", [{ id: "07" }]],
    ["a fractional pane id", [{ id: 4.2 }]],
    ["an unsafe pane id", [{ id: Number.MAX_SAFE_INTEGER + 1 }]],
    ["a record with non-boolean plugin kind", [{ id: 42, is_plugin: 0 }]],
    ["a record with non-boolean exited", [{ id: 42, exited: "yes" }]],
    [
      "a valid target before a malformed record",
      [{ id: 42, exited: true }, { id: "bad" }],
    ],
    ["duplicate non-target terminal ids", [{ id: 7 }, { id: "7" }]],
    [
      "duplicate plugin ids",
      [
        { id: 7, is_plugin: true },
        { id: "7", is_plugin: true },
      ],
    ],
  ] as const)("observePane reports %s as unknown", async (_name, records) => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, JSON.stringify(records)),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof MultiplexerZellijModule
    >("../src/multiplexer-zellij");

    const unknown = await new ZellijMultiplexer().observePane("42");
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind !== "unknown") return;
    expect(unknown.reason).toBeTypeOf("string");
  });

  it("validates the complete listing before accepting a matching target", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, JSON.stringify([{ id: 42 }, { id: "bad" }])),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof MultiplexerZellijModule
    >("../src/multiplexer-zellij");
    await expect(
      new ZellijMultiplexer().observePane("42"),
    ).resolves.toMatchObject({ kind: "unknown" });
  });

  it("allows terminal and plugin rows to share an id without treating them as duplicates", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) =>
        callback(
          null,
          JSON.stringify([
            { id: 42, is_plugin: true },
            { id: 42, is_plugin: false },
          ]),
        ),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof MultiplexerZellijModule
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    await expect(mux.observePane("terminal_42")).resolves.toEqual({
      kind: "alive",
    });
    await expect(mux.observePane("plugin_42")).resolves.toEqual({
      kind: "alive",
    });
  });

  it("observePane treats an absent pane in valid output as confirmed dead", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, JSON.stringify([{ id: 7 }])),
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof MultiplexerZellijModule
    >("../src/multiplexer-zellij");

    await expect(new ZellijMultiplexer().observePane("42")).resolves.toEqual({
      kind: "dead",
    });
  });

  /* ------------------------------------------------------------------ */
  /*  sendKeys + sendEnter                                               */
  /* ------------------------------------------------------------------ */

  it("sendKeys calls write-chars with the text", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];

    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.sendKeys("42", "echo hello");

    const writeCharsCall = calls.find((a) => a.includes("write-chars"));
    expect(writeCharsCall).toEqual([
      "action",
      "write-chars",
      "--pane-id",
      "42",
      "--",
      "echo hello",
    ]);
  });

  it("sendKeys terminates flags with -- so leading-dash text is not parsed as a flag", async () => {
    // Real zellij 0.44.3: `action write-chars --pane-id 0 "-n hi"` fails with
    // `Found argument '-n' which wasn't expected` and even suggests `-- -n`.
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    new ZellijMultiplexer().sendKeys("42", "-n not-a-flag");

    const call = calls.find((a) => a.includes("write-chars"))!;
    expect(call[call.indexOf("-n not-a-flag") - 1]).toBe("--");
  });

  it("sendEnter calls write with 13 (Enter key)", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];

    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.sendEnter("42");

    const writeCall = calls.find(
      (a) => a.includes("write") && !a.includes("write-chars"),
    );
    expect(writeCall).toEqual([
      "action",
      "write",
      "--pane-id",
      "42",
      "--",
      "13",
    ]);
  });

  /* ------------------------------------------------------------------ */
  /*  killPane                                                           */
  /* ------------------------------------------------------------------ */

  it("killPane calls close-pane", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];

    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.killPane("42");

    const closeCall = calls.find((a) => a.includes("close-pane"));
    expect(closeCall).toBeDefined();
    expect(closeCall).toContain("--pane-id");
    expect(closeCall).toContain("42");
  });

  it("killPane does not throw on error (best-effort)", async () => {
    process.env.ZELLIJ = "0";
    installMockExec(() => {
      throw new Error("pane not found");
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(() => mux.killPane("42")).not.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  buildAttachCommands — with windowName (tab mode)                   */
  /* ------------------------------------------------------------------ */

  it("buildAttachCommands with windowName returns tab-focused commands", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const cmds = mux.buildAttachCommands({ paneId: "42", windowName: "demo" });

    expect(cmds.attachCommand).toBe("zellij attach 'main'");
    expect(cmds.focusCommand).toBe("zellij action go-to-tab-name 'demo'");
  });

  /* ------------------------------------------------------------------ */
  /*  buildAttachCommands — without windowName (pane mode)               */
  /* ------------------------------------------------------------------ */

  it("buildAttachCommands without windowName returns pane-focused commands", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const cmds = mux.buildAttachCommands({ paneId: "42" });

    expect(cmds.attachCommand).toBe("zellij attach 'main'");
    // The action is `focus-pane-id <id>` — there is no `focus-pane` subcommand.
    // The pane id is escaped like every other interpolated value in these
    // copy-paste strings (the tmux twin already escaped its pane id).
    expect(cmds.focusCommand).toBe("zellij action focus-pane-id '42'");
  });

  it("buildAttachCommands normalizes a terminal_<n> paneId in the focus command", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const cmds = mux.buildAttachCommands({ paneId: "terminal_42" });
    expect(cmds.focusCommand).toBe("zellij action focus-pane-id '42'");
  });

  it("attachCommand for visible split does NOT use tmux ; chaining (zellij doesn't support it)", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const cmds = mux.buildAttachCommands({ paneId: "42" });

    // Zellij does not support tmux-style \; command chaining.
    // The attach command should be a simple `zellij attach <sess>`
    // without chained actions.
    expect(cmds.attachCommand).not.toContain("\\;");
    expect(cmds.attachCommand).toBe("zellij attach 'main'");
  });

  it("buildAttachCommands uses the session passed via opts (relaxed-path session)", async () => {
    // The relaxed-path session name is threaded in through opts.session
    // (persisted on state.muxSession by the orchestrator), NOT stored on the
    // shared backend instance — so concurrent spawns can't clobber it.
    process.env.ZELLIJ = "";
    delete process.env.ZELLIJ_SESSION_NAME;

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();

    const cmds = mux.buildAttachCommands({
      paneId: "42",
      windowName: "demo",
      session: "pi-subagent-abc123",
    });
    expect(cmds.attachCommand).toBe("zellij attach 'pi-subagent-abc123'");
    expect(cmds.focusCommand).toBe("zellij action go-to-tab-name 'demo'");
  });

  /* ------------------------------------------------------------------ */
  /*  structured focus + bounded capture                                 */
  /* ------------------------------------------------------------------ */

  it("exposes structured focus and bounded capture capabilities", async () => {
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    expect(new ZellijMultiplexer().capabilities).toEqual({
      structuredFocus: true,
      boundedCapture: true,
      nativeOverlay: true,
    });
  });

  /**
   * The floating viewer is a detached, ignored-stdio child. A successful mock
   * stays running through the startup grace window; rejection exits early.
   */
  function installAsyncViewerMock(
    onCall: (args: string[]) => Error | null,
    calls: string[][],
  ): void {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: (_file: string, args: string[]) => {
        calls.push(args);
        const child = new EventEmitter();
        Object.assign(child, { unref: vi.fn() });
        queueMicrotask(() => {
          if (onCall(args)) child.emit("exit", 1, null);
        });
        return child;
      },
      execFileSync: () => {
        throw new Error("showNativeViewer must not block the event loop");
      },
    }));
  }

  it("opens a floating native viewer only when attached to zellij", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    installAsyncViewerMock(() => null, calls);
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await expect(
      new ZellijMultiplexer().showNativeViewer("Agent", "bounded output"),
    ).resolves.toBe(true);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "--session",
        "main",
        "new-pane",
        "--floating",
        "Agent",
      ]),
    );
  });

  it("declines native floating presentation outside zellij", async () => {
    delete process.env.ZELLIJ;
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    await expect(
      new ZellijMultiplexer().showNativeViewer("Agent", "output"),
    ).resolves.toBe(false);
  });

  it("reports failure when zellij rejects the floating pane", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    installAsyncViewerMock(() => new Error("session not found"), calls);
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await expect(
      new ZellijMultiplexer().showNativeViewer("Agent", "output"),
    ).resolves.toBe(false);
  });

  it("sanitizes the floating pane name (leading dash would be parsed as a flag)", async () => {
    // Real zellij 0.44.3: `--name '-rf'` fails with
    // `Found argument '-r' which wasn't expected`. The name is the
    // attacker-reachable sub-agent name, so it is sanitized identically to the
    // tmux popup title (which additionally needs `#` stripped).
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    installAsyncViewerMock(() => null, calls);
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await expect(
      new ZellijMultiplexer().showNativeViewer("--rf #(id) agent", "output"),
    ).resolves.toBe(true);

    const args = calls[0]!;
    const name = args[args.indexOf("--name") + 1]!;
    expect(name.startsWith("-")).toBe(false);
    expect(name).not.toContain("#");
    expect(name).toBe("rf (id) agent");
  });

  it("focusPane targets the supplied session and background tab", async () => {
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        calls.push(args);
        callback(null, "");
      },
      execFileSync: () => "",
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await new ZellijMultiplexer().focusPane({
      paneId: "42",
      windowName: "demo",
      session: "pi-subagent-abc123",
    });

    expect(calls).toEqual([
      ["--session", "pi-subagent-abc123", "action", "go-to-tab-name", "demo"],
    ]);
  });

  it("focusPane targets a normalized split pane id", async () => {
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        calls.push(args);
        callback(null, "");
      },
      execFileSync: () => "",
    }));
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await new ZellijMultiplexer().focusPane({
      paneId: "terminal_42",
      session: "main",
    });

    expect(calls).toEqual([
      ["--session", "main", "action", "focus-pane-id", "42"],
    ]);
  });

  it("capturePane dumps a session-scoped pane and bounds output by lines and bytes", async () => {
    const calls: string[][] = [];
    installMockSpawn((args, stdout, _stderr, close) => {
      calls.push(args);
      stdout.end("one\ntwo\nthree\nfour");
      close(0);
    });
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    const result = await new ZellijMultiplexer().capturePane(
      { paneId: "terminal_42", session: "main" },
      { maxLines: 2, maxBytes: 7 },
    );

    // argv contract, verified against zellij 0.44.3:
    //   * NO positional path. `dump-screen` is `[OPTIONS]` only and STDOUT is
    //     the default sink; the `/dev/stdout` positional this used to assert
    //     was rejected client-side by clap ("Found argument '/dev/stdout'
    //     which wasn't expected", exit 2) so the command never reached a
    //     session — both `v` snapshot and `n` native viewer were dead on
    //     zellij while this test asserted the broken argv was correct.
    //   * `--full` to include scrollback, matching tmux's `-S -<lines>`.
    expect(calls[0]).toEqual([
      "--session",
      "main",
      "action",
      "dump-screen",
      "--full",
      "--pane-id",
      "42",
    ]);
    expect(calls[0]).not.toContain("/dev/stdout");
    expect(result).toEqual({ output: "ee\nfour", truncated: true });
  });

  it("streams more than 1 MiB into a caller-bounded UTF-8 tail", async () => {
    installMockSpawn((_args, stdout, _stderr, close) => {
      stdout.write(Buffer.alloc(1024 * 1024 + 17, "x"));
      stdout.end("αβtail");
      close(0);
    });
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await expect(
      new ZellijMultiplexer().capturePane(
        { paneId: "42", session: "main" },
        { maxLines: 20, maxBytes: 7 },
      ),
    ).resolves.toEqual({ output: "βtail", truncated: true });
  });

  it("propagates a non-zero dump-screen exit with bounded stderr", async () => {
    installMockSpawn((_args, _stdout, stderr, close) => {
      stderr.end("permission denied");
      close(2);
    });
    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");

    await expect(
      new ZellijMultiplexer().capturePane(
        { paneId: "42", session: "main" },
        { maxLines: 20, maxBytes: 100 },
      ),
    ).rejects.toThrow(/dump-screen failed: permission denied/);
  });

  it("terminates and then force-kills a timed-out dump-screen process", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      const kill = vi.fn((signal: NodeJS.Signals) => {
        if (signal === "SIGKILL") child.emit("close", null, signal);
        return true;
      });
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill,
      });
      vi.resetModules();
      vi.doMock("node:child_process", () => ({
        execFileSync: () => "",
        spawn: () => child,
      }));
      const { ZellijMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-zellij")
      >("../src/multiplexer-zellij");
      const capture = new ZellijMultiplexer().capturePane(
        { paneId: "42", session: "main" },
        { maxLines: 20, maxBytes: 100 },
      );

      const rejection = expect(capture).rejects.toThrow(
        /dump-screen timed out/,
      );
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      await vi.advanceTimersByTimeAsync(1000);
      expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(kill).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /* ------------------------------------------------------------------ */
  /*  session threading + exited-guard / normalization                   */
  /* ------------------------------------------------------------------ */

  it("ops target the supplied session via --session and normalize prefixed ids", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("list-panes")) return JSON.stringify([{ id: 42 }]);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const sess = "pi-subagent-xyz";

    expect(mux.getPaneLiveness("terminal_42", sess)).toBe("alive");
    mux.sendKeys("terminal_42", "echo hi", sess);
    mux.sendEnter("terminal_42", sess);
    mux.killPane("terminal_42", sess);

    // Every call carries --session, and the pane id is the bare integer.
    for (const verb of ["list-panes", "write-chars", "write", "close-pane"]) {
      const call = calls.find((a) => a.includes(verb));
      expect(call, verb).toEqual(expect.arrayContaining(["--session", sess]));
    }
    const writeChars = calls.find((a) => a.includes("write-chars"))!;
    expect(writeChars).toEqual(expect.arrayContaining(["--pane-id", "42"]));
    expect(writeChars).not.toContain("terminal_42");
  });

  it("returns dead for a pane reported as exited", async () => {
    // `--close-on-exit` is not always set, so a finished pane can linger in
    // list-panes with exited:true. Presence alone must not mean `alive`.
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 42, exited: true }]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.getPaneLiveness("42")).toBe("dead");
  });

  /* ------------------------------------------------------------------ */
  /*  plugin_<n> prefix normalization                                    */
  /* ------------------------------------------------------------------ */

  it("preserves the plugin_<n> namespace while normalizing its numeric id", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes")) {
        return JSON.stringify([{ id: 42, is_plugin: true }]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    // The prefix selects the plugin namespace while the backend receives id 42.
    expect(mux.getPaneLiveness("plugin_42")).toBe("alive");
    // Non-existent pane is absent from a successful listing.
    expect(mux.getPaneLiveness("plugin_99")).toBe("dead");
  });

  it("ignores plugin rows that share our terminal pane's integer id", async () => {
    // zellij numbers `terminal_N` and `plugin_N` in SEPARATE namespaces, and
    // `normalizePaneId` strips the prefix, collapsing both onto one integer.
    // Verified against zellij 0.44.3: a fresh session lists a `zellij:link`
    // plugin pane with `id: 0` next to the shell's terminal pane, also `id: 0`.
    // So after the sub-agent's terminal pane closes, the plugin row kept
    // answering "alive" for it — the artifact poller would never see the child
    // finish. Our pane is always a terminal pane (`createPane` only ever
    // selects `!is_plugin`), so plugin rows must be excluded outright.
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes")) {
        // Terminal pane 0 is gone; only the same-id plugin pane remains.
        return JSON.stringify([
          { id: 0, is_plugin: true, exited: false },
          { id: 3, is_plugin: true, exited: false },
        ]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.getPaneLiveness("0")).toBe("dead");
    await expect(mux.observePane("0")).resolves.toEqual({ kind: "dead" });
  });

  it("reports alive when a terminal row accompanies a colliding plugin row", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes")) {
        return JSON.stringify([
          { id: 0, is_plugin: true, exited: false },
          { id: 0, is_plugin: false, exited: false },
        ]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.getPaneLiveness("0")).toBe("alive");
  });

  it("createPane diffs terminal panes only, so a colliding plugin id cannot mask the new pane", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    let listCalls = 0;
    installMockExec((_f, args) => {
      if (isCommandProbe(args)) return "";
      if (args.includes("list-panes")) {
        listCalls += 1;
        // Before: only the plugin pane, which already occupies integer 5.
        if (listCalls === 1) {
          return JSON.stringify([{ id: 5, is_plugin: true }]);
        }
        // After: the new terminal pane also lands on integer 5. Keeping the
        // plugin id in the "before" set would have filtered it out as not-new.
        return JSON.stringify([
          { id: 5, is_plugin: true },
          { id: 5, is_plugin: false },
        ]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const created = new ZellijMultiplexer().createPane({
      name: "Collide child",
      cwd: "/tmp",
      background: true,
    });
    expect(created.paneId).toBe("5");
  });

  it("sendKeys normalizes plugin_<n> prefix in pane id", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.sendKeys("plugin_7", "echo hi");

    const wc = calls.find((a) => a.includes("write-chars"));
    expect(wc).toEqual(expect.arrayContaining(["--pane-id", "7"]));
    expect(wc).not.toContain("plugin_7");
  });

  it("sendEnter normalizes plugin_<n> prefix in pane id", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.sendEnter("plugin_7");

    const w = calls.find(
      (a) => a.includes("write") && !a.includes("write-chars"),
    );
    expect(w).toEqual(expect.arrayContaining(["--pane-id", "7"]));
    expect(w).not.toContain("plugin_7");
  });

  it("killPane normalizes plugin_<n> prefix in pane id", async () => {
    process.env.ZELLIJ = "0";
    const calls: string[][] = [];
    installMockExec((_f, args) => {
      calls.push(args);
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    mux.killPane("plugin_7");

    const cp = calls.find((a) => a.includes("close-pane"));
    expect(cp).toEqual(expect.arrayContaining(["--pane-id", "7"]));
    expect(cp).not.toContain("plugin_7");
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — failures                                              */
  /* ------------------------------------------------------------------ */

  it("createPane throws when no panes are detectable after creation", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    installMockExec((_f, args) => {
      if (args.includes("list-panes") && args.includes("--json")) {
        // Both before and after return completely empty
        return JSON.stringify([]);
      }
      if (args.includes("new-tab")) return "";
      if (args.includes("current-tab-info")) return "position: 0\n";
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(() =>
      mux.createPane({
        name: "Demo",
        cwd: "/tmp",
        background: true,
      }),
    ).toThrow(/Failed to determine pane ID/);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — background with explicit windowName                   */
  /* ------------------------------------------------------------------ */

  it("createPane background mode passes explicit windowName to new-tab --name", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    const calls: string[][] = [];
    let listCallCount = 0;
    installMockExec((_f, args) => {
      calls.push(args);
      if (args.includes("list-panes") && args.includes("--json")) {
        listCallCount++;
        return listCallCount === 1
          ? JSON.stringify([{ id: 1, tab_position: 0 }])
          : JSON.stringify([
              { id: 1, tab_position: 0 },
              { id: 2, tab_position: 1 },
            ]);
      }
      // Return position for current-tab-info so tab-focus restore is exercised
      if (args.includes("current-tab-info")) return "position: 0\n";
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const result = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
      windowName: "my-custom-tab",
    });

    expect(result.windowName).toBe("my-custom-tab");
    // The new-tab call must carry --name my-custom-tab
    const nt = calls.find((a) => a.includes("new-tab"));
    expect(nt).toBeDefined();
    expect(nt).toContain("--name");
    expect(nt).toContain("my-custom-tab");
  });
});

/* ------------------------------------------------------------------ */
/*  improved diagnostics on command failure                           */
/* ------------------------------------------------------------------ */

it("createPane relaxed path throws improved diagnostic on attach failure", async () => {
  delete process.env.ZELLIJ;
  delete process.env.ZELLIJ_SESSION_NAME;
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (isCommandProbe(args)) return ""; // commandExists succeeds
      if (args[0] === "attach" && args.includes("--create-background")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("no server running");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { ZellijMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-zellij")
  >("../src/multiplexer-zellij");
  const mux = new ZellijMultiplexer();
  expect(() =>
    mux.createPane({
      name: "Test",
      cwd: "/tmp",
      background: true,
      id: "abc12345",
    }),
  ).toThrow(
    /\[zellij\] attach --create-background failed.*exit code 1.*stderr: no server running/,
  );
});

it("createPane background throws improved diagnostic on new-tab failure", async () => {
  process.env.ZELLIJ = "0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (isCommandProbe(args)) return ""; // commandExists succeeds
      if (args.includes("new-tab")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("cannot create tab: session is read-only");
        err.status = 1;
        throw err;
      }
      return ""; // list-panes, current-tab-info all return empty
    },
  }));
  const { ZellijMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-zellij")
  >("../src/multiplexer-zellij");
  const mux = new ZellijMultiplexer();
  expect(() =>
    mux.createPane({
      name: "Test",
      cwd: "/tmp",
      background: true,
    }),
  ).toThrow(
    /\[zellij\] new-tab failed.*exit code 1.*stderr: cannot create tab/,
  );
});

it("sendKeys throws improved diagnostic on write-chars failure", async () => {
  process.env.ZELLIJ = "0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args.includes("write-chars")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("no such pane: 99");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { ZellijMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-zellij")
  >("../src/multiplexer-zellij");
  const mux = new ZellijMultiplexer();
  expect(() => mux.sendKeys("99", "echo hi")).toThrow(
    /\[zellij\] write-chars failed.*exit code 1.*stderr: no such pane: 99/,
  );
});

it("sendEnter throws improved diagnostic on write 13 failure", async () => {
  process.env.ZELLIJ = "0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args.includes("write") && !args.includes("write-chars")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("pane not found: 99");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { ZellijMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-zellij")
  >("../src/multiplexer-zellij");
  const mux = new ZellijMultiplexer();
  expect(() => mux.sendEnter("99")).toThrow(
    /\[zellij\] write 13 failed.*exit code 1.*stderr: pane not found: 99/,
  );
});
