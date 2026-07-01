import { afterEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

/** Standard tmux pane id returned by mocks when creating a new pane. */
const MOCK_PANE_ID = "%42";
/**
 * Tab-separated session/window/pane output matching real
 * `display-message -p -t <id> "#{session_name}\t#{window_index}\t#{pane_index}"`.
 */
const MOCK_LOCATION = "main\t1\t0\n";

function installMockExec(scenario: (args: string[]) => string) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => scenario(args as string[]),
  }));
}

describe("multiplexer-tmux", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  /* ------------------------------------------------------------------ */
  /*  isAvailable                                                        */
  /* ------------------------------------------------------------------ */

  it("isAvailable returns true when tmux binary exists and TMUX env var is set", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    installMockExec((args) => {
      // /bin/sh -lc "command -v 'tmux'" succeeds
      if (args.includes("-lc")) return "";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().isAvailable()).toBe(true);
  });

  it("isAvailable is binary-only: returns true even when TMUX env var is unset", async () => {
    // Symmetric with ZellijMultiplexer: isAvailable must NOT require TMUX.
    installMockExec((args) => {
      if (args.includes("-lc")) return "";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().isAvailable()).toBe(true);
  });

  it("isAvailable returns false when tmux binary is not on PATH", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    installMockExec((args) => {
      if (args.includes("-lc")) throw new Error("command not found");
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().isAvailable()).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — background mode (new-window)                          */
  /* ------------------------------------------------------------------ */

  it("createPane background mode uses new-window -d -n and returns % prefixed paneId + windowName", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "new-window") return `${MOCK_PANE_ID}\n`;
      // createPane doesn't call display-message; buildsAttachCommands does.
      // sendKeys / sendEnter / isPaneAlive are not called here.
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const result = new TmuxMultiplexer().createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
    });

    expect(result.paneId).toBe(MOCK_PANE_ID);
    expect(result.windowName).toBe("demo");

    const nw = calls.find((a) => a[0] === "new-window");
    expect(nw).toBeDefined();
    // -d = detached; -n = name; -P -F #{pane_id} = print pane id
    expect(nw).toContain("-d");
    expect(nw).toContain("-n");
    expect(nw).toContain("demo");
    expect(nw).toContain("-P");
    expect(nw).toContain("-F");
    expect(nw).toContain("#{pane_id}");
    // Working directory
    expect(nw).toContain("-c");
    expect(nw).toContain("/tmp");
  });

  it("createPane background mode uses explicit windowName when provided", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "new-window") return "%99\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const result = new TmuxMultiplexer().createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
      windowName: "my-custom-name",
    });

    expect(result.paneId).toBe("%99");
    expect(result.windowName).toBe("my-custom-name");

    const nw = calls.find((a) => a[0] === "new-window");
    expect(nw).toContain("my-custom-name");
  });

  it("createPane throws when tmux returns a non-% pane id (unexpected format)", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    installMockExec((args) => {
      if (args[0] === "new-window") return "42\n"; // missing % prefix
      if (args.includes("-lc")) return ""; // commandExists
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(() =>
      new TmuxMultiplexer().createPane({
        name: "Demo",
        cwd: "/tmp",
        background: true,
      }),
    ).toThrow(/Unexpected tmux pane id/);
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — visible split mode (split-window)                     */
  /* ------------------------------------------------------------------ */

  it("createPane visible split mode uses split-window -h -d and returns paneId with parentPane", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "split-window") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "select-pane") return "";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const result = new TmuxMultiplexer().createPane({
      name: "Demo",
      cwd: "/tmp",
      background: false,
      parentPane: "%5",
    });

    expect(result.paneId).toBe(MOCK_PANE_ID);
    // Visible split has no windowName (same window as parent)
    expect(result.windowName).toBeUndefined();

    const sw = calls.find((a) => a[0] === "split-window");
    expect(sw).toBeDefined();
    expect(sw).toContain("-h");
    expect(sw).toContain("-d");
    expect(sw).toContain("-P");
    expect(sw).toContain("-F");
    expect(sw).toContain("#{pane_id}");
    expect(sw).toContain("-c");
    expect(sw).toContain("/tmp");
    // -t targets the parent pane
    expect(sw).toContain("-t");
    expect(sw).toContain("%5");

    // Cosmetic: sets pane title
    const sp = calls.find((a) => a[0] === "select-pane");
    expect(sp).toBeDefined();
    expect(sp).toContain("-T");
    expect(sp).toContain("Demo");
  });

  it("createPane visible split falls back to TMUX_PANE when parentPane is omitted", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%9";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "split-window") return "%88\n";
      if (args[0] === "select-pane") return "";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().createPane({
      name: "T",
      cwd: "/tmp",
      background: false,
      // parentPane omitted — should use TMUX_PANE
    });

    const sw = calls.find((a) => a[0] === "split-window");
    expect(sw).toContain("-t");
    expect(sw).toContain("%9");
  });

  /* ------------------------------------------------------------------ */
  /*  createPane — relaxed path (parent not in tmux)                     */
  /* ------------------------------------------------------------------ */

  it("createPane relaxed path creates a new detached session when TMUX is unset", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "new-session") return `${MOCK_PANE_ID}\n`;
      if (args[0] === "rename-window") return "";
      if (args.includes("-lc")) return ""; // commandExists
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const result = new TmuxMultiplexer().createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
      id: "abc12345",
    });

    expect(result.paneId).toBe(MOCK_PANE_ID);
    // Relaxed path always defines windowName (renamed from default "0")
    expect(result.windowName).toBe("demo");

    const ns = calls.find((a) => a[0] === "new-session");
    expect(ns).toBeDefined();
    expect(ns).toContain("-d");
    expect(ns).toContain("-s");
    expect(ns).toContain("pi-subagent-abc12345");
    expect(ns).toContain("-c");
    expect(ns).toContain("/tmp");
    expect(ns).toContain("-P");
    expect(ns).toContain("-F");
    expect(ns).toContain("#{pane_id}");

    const rn = calls.find((a) => a[0] === "rename-window");
    expect(rn).toBeDefined();
    expect(rn).toContain("pi-subagent-abc12345:0");
    expect(rn).toContain("demo");
  });

  it("createPane relaxed path validates pane id starts with %", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    installMockExec((args) => {
      if (args[0] === "new-session") return "XX\n"; // bad format
      if (args.includes("-lc")) return "";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(() =>
      new TmuxMultiplexer().createPane({
        name: "Demo",
        cwd: "/tmp",
        background: true,
        id: "abc12345",
      }),
    ).toThrow(/Unexpected tmux pane id/);
  });

  it("createPane relaxed path throws when tmux binary is not available", async () => {
    delete process.env.TMUX;
    installMockExec((args) => {
      if (args.includes("-lc")) throw new Error("command not found");
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(() =>
      new TmuxMultiplexer().createPane({
        name: "Demo",
        cwd: "/tmp",
        background: true,
        id: "abc12345",
      }),
    ).toThrow(/tmux is not available/);
  });

  /* ------------------------------------------------------------------ */
  /*  isPaneAlive                                                        */
  /* ------------------------------------------------------------------ */

  it("isPaneAlive returns true when display-message succeeds", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    installMockExec((args) => {
      if (args[0] === "display-message") return "#{pane_id}\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().isPaneAlive("%42")).toBe(true);
  });

  it("isPaneAlive returns false when display-message throws", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    installMockExec((args) => {
      if (args[0] === "display-message") throw new Error("no such pane");
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().isPaneAlive("%99")).toBe(false);
  });

  it("isPaneAlive uses correct tmux args: display-message -p -t paneId #{pane_id}", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "display-message") return "#{pane_id}\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().isPaneAlive("%42");

    const dm = calls.find((a) => a[0] === "display-message");
    expect(dm).toBeDefined();
    expect(dm).toContain("-p");
    expect(dm).toContain("-t");
    expect(dm).toContain("%42");
    expect(dm).toContain("#{pane_id}");
  });

  /* ------------------------------------------------------------------ */
  /*  sendKeys + sendEnter                                               */
  /* ------------------------------------------------------------------ */

  it("sendKeys calls send-keys -l with the text", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().sendKeys("%42", "echo hello");

    const sk = calls.find((a) => a[0] === "send-keys");
    expect(sk).toBeDefined();
    expect(sk).toContain("-t");
    expect(sk).toContain("%42");
    expect(sk).toContain("-l");
    expect(sk).toContain("echo hello");
  });

  it("sendKeys sends text with newlines verbatim", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().sendKeys("%42", "line1\nline2");

    const sk = calls.find((a) => a[0] === "send-keys");
    expect(sk).toBeDefined();
    expect(sk).toContain("line1\nline2");
  });

  it("sendEnter calls send-keys with Enter key name", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().sendEnter("%42");

    const sk = calls.find((a) => a[0] === "send-keys");
    expect(sk).toBeDefined();
    expect(sk).toContain("-t");
    expect(sk).toContain("%42");
    // zellij sends "13" (byte value); tmux uses the named key "Enter"
    expect(sk).toContain("Enter");
  });

  /* ------------------------------------------------------------------ */
  /*  killPane                                                           */
  /* ------------------------------------------------------------------ */

  it("killPane calls kill-pane -t with the pane id", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().killPane("%42");

    const kp = calls.find((a) => a[0] === "kill-pane");
    expect(kp).toBeDefined();
    expect(kp).toContain("-t");
    expect(kp).toContain("%42");
  });

  it("killPane does not throw on error (best-effort)", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    installMockExec(() => {
      throw new Error("no such pane");
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(() => new TmuxMultiplexer().killPane("%99")).not.toThrow();
  });

  /* ------------------------------------------------------------------ */
  /*  buildAttachCommands — with windowName (background mode)            */
  /* ------------------------------------------------------------------ */

  it("buildAttachCommands with windowName returns session+select-window commands via getPaneLocation", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const cmds = new TmuxMultiplexer().buildAttachCommands({
      paneId: "%42",
      windowName: "demo",
    });

    // getPaneLocation was called (display-message)
    expect(calls.some((a) => a[0] === "display-message")).toBe(true);

    expect(cmds.attachCommand).toContain("tmux attach -t 'main'");
    // \; is the tmux command separator for chaining
    expect(cmds.attachCommand).toContain("\\;");
    expect(cmds.attachCommand).toContain("select-window -t 'demo'");

    expect(cmds.focusCommand).toBe("tmux select-window -t 'demo'");
  });

  /* ------------------------------------------------------------------ */
  /*  buildAttachCommands — without windowName (split mode)              */
  /* ------------------------------------------------------------------ */

  it("buildAttachCommands without windowName returns chain targeting session:window + select-pane", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "display-message") return MOCK_LOCATION;
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const cmds = new TmuxMultiplexer().buildAttachCommands({
      paneId: "%42",
    });

    expect(cmds.attachCommand).toBe(
      "tmux attach -t 'main' \\; select-window -t 'main:1' \\; select-pane -t '%42'",
    );
    expect(cmds.focusCommand).toBe("tmux select-pane -t '%42'");
  });

  it("buildAttachCommands getPaneLocation consumes the tab-separated display-message output", async () => {
    // Contract: display-message with #{session_name}\t#{window_index}\t#{pane_index}
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      // Output format: session_name\twindow_index\tpane_index (tab-separated)
      if (args[0] === "display-message") return "my-session\t3\t2\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    const cmds = new TmuxMultiplexer().buildAttachCommands({
      paneId: "%42",
    });

    // session=my-session, window=3, pane=2
    expect(cmds.attachCommand).toContain("'my-session'");
    expect(cmds.attachCommand).toContain("'my-session:3'");
    expect(cmds.attachCommand).toContain("'%42'");

    // The display-message format template must include all three fields
    // (they're tab-separated into one arg element, so check substring).
    const fm = calls.find((a) => a[0] === "display-message");
    expect(fm).toBeDefined();
    const formatArg = fm!.find((s) => s.includes("#{session_name}"));
    expect(formatArg).toBeDefined();
    expect(formatArg!).toContain("#{window_index}");
    expect(formatArg!).toContain("#{pane_index}");
  });

  /* ------------------------------------------------------------------ */
  /*  readPaneExitCode — command contract (subset; detailed tests in     */
  /*  interactive-tmux.test.ts cover return values)                      */
  /* ------------------------------------------------------------------ */

  it("readPaneExitCode uses show-options -p -v -t paneId @pi-exit-code", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "show-options") return "0\n";
      return "";
    });
    const { readPaneExitCode } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    readPaneExitCode("%42");

    const so = calls.find((a) => a[0] === "show-options");
    expect(so).toBeDefined();
    expect(so).toContain("-p"); // pane-scoped
    expect(so).toContain("-v"); // value only (no name)
    expect(so).toContain("-t");
    expect(so).toContain("%42");
    expect(so).toContain("@pi-exit-code");
  });

  it("readPaneExitCode suppresses stderr to avoid leaking 'invalid option' into parent TUI", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const capturedOptions: Array<Record<string, unknown> | undefined> = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[], options?: unknown) => {
        capturedOptions.push(options as Record<string, unknown> | undefined);
        if (args[0] === "show-options") throw new Error("unset");
        return "";
      },
    }));
    const { readPaneExitCode } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(readPaneExitCode("%42")).toBeNull();

    const opts = capturedOptions.find(
      (o) => o && Array.isArray((o as any).stdio),
    );
    expect(opts).toBeDefined();
    const stdio = (opts as any).stdio as [string, string, string];
    expect(stdio[2]).toBe("ignore");
  });
});

/* ------------------------------------------------------------------ */
/*  improved diagnostics on command failure                           */
/* ------------------------------------------------------------------ */

it("buildAttachCommands throws improved diagnostic on display-message failure", async () => {
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args[0] === "display-message") {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("can't find pane: %99");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { TmuxMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-tmux")
  >("../src/multiplexer-tmux");
  expect(() =>
    new TmuxMultiplexer().buildAttachCommands({ paneId: "%99" }),
  ).toThrow(
    /\[tmux\] display-message failed.*exit code 1.*stderr: can't find pane/,
  );
});

it("createPane background throws improved diagnostic on new-window failure", async () => {
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args.includes("-lc")) return ""; // commandExists succeeds
      if (args[0] === "new-window") {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("no such session");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { TmuxMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-tmux")
  >("../src/multiplexer-tmux");
  expect(() =>
    new TmuxMultiplexer().createPane({
      name: "Test",
      cwd: "/tmp",
      background: true,
    }),
  ).toThrow(/\[tmux\] new-window failed.*exit code 1.*stderr: no such session/);
});

it("sendKeys throws improved diagnostic on send-keys failure", async () => {
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args[0] === "send-keys" && args.includes("-l")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("can't find pane: %99");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { TmuxMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-tmux")
  >("../src/multiplexer-tmux");
  expect(() => new TmuxMultiplexer().sendKeys("%99", "echo hi")).toThrow(
    /\[tmux\] send-keys failed.*exit code 1.*stderr: can't find pane/,
  );
});

it("sendEnter throws improved diagnostic on send-keys Enter failure", async () => {
  process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => {
      if (args[0] === "send-keys" && args.includes("Enter")) {
        const err = new Error("Command failed") as Error & {
          stderr?: Buffer;
          status?: number;
        };
        err.stderr = Buffer.from("no such pane: %99");
        err.status = 1;
        throw err;
      }
      return "";
    },
  }));
  const { TmuxMultiplexer } = await importFresh<
    typeof import("../src/multiplexer-tmux")
  >("../src/multiplexer-tmux");
  expect(() => new TmuxMultiplexer().sendEnter("%99")).toThrow(
    /\[tmux\] send-keys Enter failed.*exit code 1.*stderr: no such pane/,
  );
});
