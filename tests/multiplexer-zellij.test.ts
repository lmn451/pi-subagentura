import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  }));
}

describe("multiplexer-zellij", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
  });

  /* ------------------------------------------------------------------ */
  /*  isAvailable                                                        */
  /* ------------------------------------------------------------------ */

  it("isAvailable returns true when ZELLIJ env var is set and binary exists", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      // command -v zellij — return empty means success
      if (args.includes("-lc")) return "";
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
      if (args.includes("-lc")) return ""; // command -v zellij succeeds
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
      if (args.includes("-lc")) throw new Error("command not found");
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
    // number every other op (isPaneAlive/sendKeys/killPane) compares against.
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
  /*  isPaneAlive                                                        */
  /* ------------------------------------------------------------------ */

  it("isPaneAlive returns true when pane exists in list", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes") && args.includes("--json")) {
        return JSON.stringify([{ id: 1 }, { id: 42 }, { id: 3 }]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isPaneAlive("42")).toBe(true);
  });

  it("isPaneAlive returns false when pane does not exist in list", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes") && args.includes("--json")) {
        return JSON.stringify([{ id: 1 }, { id: 2 }]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isPaneAlive("99")).toBe(false);
  });

  it("isPaneAlive returns false on exec error", async () => {
    process.env.ZELLIJ = "0";
    installMockExec(() => {
      throw new Error("no such pane");
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    expect(mux.isPaneAlive("42")).toBe(false);
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
    expect(writeCharsCall).toBeDefined();
    expect(writeCharsCall).toContain("--pane-id");
    expect(writeCharsCall).toContain("42");
    expect(writeCharsCall).toContain("echo hello");
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
    expect(writeCall).toBeDefined();
    expect(writeCall).toContain("--pane-id");
    expect(writeCall).toContain("42");
    expect(writeCall).toContain("13");
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
    expect(cmds.focusCommand).toBe("zellij action focus-pane-id 42");
  });

  it("buildAttachCommands normalizes a terminal_<n> paneId in the focus command", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    const cmds = mux.buildAttachCommands({ paneId: "terminal_42" });
    expect(cmds.focusCommand).toBe("zellij action focus-pane-id 42");
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
  /*  session threading + isPaneAlive exited-guard / normalization       */
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

    expect(mux.isPaneAlive("terminal_42", sess)).toBe(true);
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

  it("isPaneAlive returns false for a pane reported as exited", async () => {
    // `--close-on-exit` is not always set, so a finished pane can linger in
    // list-panes with exited:true. Presence alone must not mean 'alive'.
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
    expect(mux.isPaneAlive("42")).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  plugin_<n> prefix normalization                                    */
  /* ------------------------------------------------------------------ */

  it("isPaneAlive normalizes plugin_<n> prefix (symmetric with terminal_<n>)", async () => {
    process.env.ZELLIJ = "0";
    installMockExec((_f, args) => {
      if (args.includes("list-panes")) {
        // list-panes --json returns bare integer ids, never plugin_ prefix
        return JSON.stringify([{ id: 42 }]);
      }
      return "";
    });

    const { ZellijMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-zellij")
    >("../src/multiplexer-zellij");
    const mux = new ZellijMultiplexer();
    // plugin_42 should normalize to bare integer 42 for list-panes lookup
    expect(mux.isPaneAlive("plugin_42")).toBe(true);
    // Non-existent pane should still return false
    expect(mux.isPaneAlive("plugin_99")).toBe(false);
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
      if (args.includes("-lc")) return ""; // commandExists succeeds
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
      if (args.includes("-lc")) return ""; // commandExists succeeds
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
