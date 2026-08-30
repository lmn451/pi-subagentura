import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

function success(result: Record<string, unknown>): string {
  return JSON.stringify({ id: "test", result });
}

function pane(paneId: string, focused = false): Record<string, unknown> {
  return {
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused,
  };
}

function isCommandProbe(file: string, args: readonly string[]): boolean {
  return file === "/bin/sh" && args[0] === "-c";
}

function installMockExec(scenario: (call: ExecCall) => string): ExecCall[] {
  const calls: ExecCall[] = [];
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (
      file: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      const call = { file, args: [...args], options: options ?? {} };
      calls.push(call);
      return scenario(call);
    },
    execFile: (
      file: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const call = { file, args: [...args], options: options ?? {} };
      calls.push(call);
      try {
        callback(null, scenario(call));
      } catch (error) {
        callback(error as Error, "");
      }
    },
  }));
  return calls;
}

describe("multiplexer-herdr", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
    process.env.HERDR_WORKSPACE_ID = "w1";
    process.env.HERDR_PANE_ID = "w1:p1";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.doUnmock("node:child_process");
  });

  it("is available only from a Herdr-managed pane with the binary present", async () => {
    installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.isAvailable()).toBe(true);
    delete process.env.HERDR_ENV;
    expect(mux.isAvailable()).toBe(false);
    process.env.HERDR_ENV = "1";
    delete process.env.HERDR_SOCKET_PATH;
    expect(mux.isAvailable()).toBe(false);
  });

  it("creates background agents as unfocused tabs in the current workspace", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "tab") {
        return success({ root_pane: pane("w1:p2") });
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(
      new HerdrMultiplexer().createPane({
        name: "Code Review",
        cwd: "/repo",
        background: true,
      }),
    ).toEqual({
      paneId: "w1:p2",
      windowName: "code-review",
      session: "/tmp/herdr-test.sock",
    });
    const create = calls.find((call) => call.args[0] === "tab")!;
    expect(create.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "code-review",
      "--no-focus",
    ]);
    expect((create.options.env as NodeJS.ProcessEnv).HERDR_SOCKET_PATH).toBe(
      "/tmp/herdr-test.sock",
    );
  });

  it("creates visible agents as right-hand splits of the parent pane", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      return success({ pane: pane("w1:p3") });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(
      new HerdrMultiplexer().createPane({
        name: "review",
        cwd: "/repo",
        background: false,
        parentPane: "w1:p9",
      }),
    ).toEqual({ paneId: "w1:p3", session: "/tmp/herdr-test.sock" });
    expect(calls.find((call) => call.args[0] === "pane")!.args).toEqual([
      "pane",
      "split",
      "w1:p9",
      "--direction",
      "right",
      "--cwd",
      "/repo",
      "--no-focus",
    ]);
  });

  it("reports liveness from a complete pane listing", async () => {
    installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      return success({ panes: [pane("w1:p2"), pane("w1:p3")] });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.getPaneLiveness("w1:p2", "/tmp/other.sock")).toBe("alive");
    expect(mux.getPaneLiveness("w1:p8", "/tmp/other.sock")).toBe("dead");
    await expect(
      mux.getPaneLivenessAsync("w1:p3", "/tmp/other.sock"),
    ).resolves.toBe("alive");
  });

  it("returns unknown when a liveness listing is malformed", async () => {
    installMockExec(() => "not-json");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.getPaneLiveness("w1:p2")).toBe("unknown");
    await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("unknown");
  });

  it("derives pane activity from the session snapshot", async () => {
    installMockExec(() => success({ snapshot: { focused_pane_id: "w1:p2" } }));
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    await expect(mux.getPaneActivityAsync("w1:p2")).resolves.toBe("active");
    await expect(mux.getPaneActivityAsync("w1:p3")).resolves.toBe("inactive");
  });

  it("routes literal input and Enter through separate Herdr commands", async () => {
    const calls = installMockExec(() => success({ ok: true }));
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    mux.sendKeys("w1:p2", "-n literal\ntext", "/tmp/other.sock");
    mux.sendEnter("w1:p2", "/tmp/other.sock");
    expect(calls[0]!.args).toEqual([
      "pane",
      "send-text",
      "w1:p2",
      "-n literal\ntext",
    ]);
    expect(calls[1]!.args).toEqual(["pane", "send-keys", "w1:p2", "enter"]);
  });

  it("focuses the Pi agent occupying the target pane", async () => {
    const calls = installMockExec(() => success({ ok: true }));
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await new HerdrMultiplexer().focusPane({
      paneId: "w1:p2",
      session: "/tmp/other.sock",
    });
    expect(calls[0]!.args).toEqual(["agent", "focus", "w1:p2"]);
    expect((calls[0]!.options.env as NodeJS.ProcessEnv).HERDR_SOCKET_PATH).toBe(
      "/tmp/other.sock",
    );
  });

  it("captures recent unwrapped output and enforces line and byte bounds", async () => {
    const calls = installMockExec(() => "one\ntwo\nthree");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().capturePane(
        { paneId: "w1:p2", session: "/tmp/other.sock" },
        { maxLines: 2, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "two\nthree", truncated: true });
    expect(calls[0]!.args).toEqual([
      "pane",
      "read",
      "w1:p2",
      "--source",
      "recent-unwrapped",
      "--lines",
      "3",
    ]);
  });

  it("closes panes best-effort and declines unsupported native overlays", async () => {
    const calls = installMockExec((call) => {
      if (call.args[1] === "close") throw new Error("already gone");
      return "";
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(() => mux.killPane("w1:p2")).not.toThrow();
    await expect(mux.showNativeViewer("title", "content")).resolves.toBe(false);
    expect(calls[0]!.args).toEqual(["pane", "close", "w1:p2"]);
  });

  it("builds socket-scoped focus and attach commands", async () => {
    installMockExec(() => "");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    const commands = new HerdrMultiplexer().buildAttachCommands({
      paneId: "w1:p2",
      session: "/tmp/session's.sock",
    });
    expect(commands.focusCommand).toBe(
      "HERDR_SOCKET_PATH='/tmp/session'\\''s.sock' herdr agent focus 'w1:p2' >/dev/null",
    );
    expect(commands.attachCommand).toBe(
      `${commands.focusCommand}; HERDR_SOCKET_PATH='/tmp/session'\\''s.sock' herdr`,
    );
  });
});
