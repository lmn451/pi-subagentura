import { afterEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

const socket = "/tmp/wezterm-test.sock";
const parentPane = "7";
const childPane = "8";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
});

describe("WezTermMultiplexer", () => {
  it("reports activity only for one valid attached client", async () => {
    let clientOutput = JSON.stringify([
      { focused_pane_id: Number(childPane) },
      { focused_pane_id: Number(parentPane) },
    ]);
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
      execFile: (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, output: string) => void,
      ) => {
        callback(null, clientOutput);
        return { stdin: { end: () => {} } };
      },
    }));
    const { WezTermMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-wezterm")
    >("../src/multiplexer-wezterm");
    const mux = new WezTermMultiplexer();

    expect(await mux.getPaneActivityAsync(childPane, undefined, socket)).toBe(
      "unknown",
    );
    clientOutput = JSON.stringify([{ focused_pane_id: Number(childPane) }]);
    expect(await mux.getPaneActivityAsync(childPane, undefined, socket)).toBe(
      "active",
    );
    clientOutput = JSON.stringify([{ focused_pane_id: Number(parentPane) }]);
    expect(await mux.getPaneActivityAsync(childPane, undefined, socket)).toBe(
      "inactive",
    );
    clientOutput = JSON.stringify([{ focused_pane_id: "8" }]);
    expect(await mux.getPaneActivityAsync(childPane, undefined, socket)).toBe(
      "unknown",
    );
  });

  it("targets the owning socket and supports the child pane lifecycle", async () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> =
      [];
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (
        _file: string,
        args: string[],
        options: Record<string, unknown>,
      ) => {
        calls.push({ args, options });
        if (args.includes("spawn")) return `${childPane}\n`;
        if (args.includes("list"))
          return JSON.stringify([{ pane_id: Number(childPane) }]);
        return "";
      },
      execFile: (
        _file: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, output: string) => void,
      ) => {
        calls.push({ args, options });
        callback(null, args.includes("get-text") ? "one\ntwo\nthree" : "[]");
        return { stdin: { end: () => {} } };
      },
    }));
    const { WezTermMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-wezterm")
    >("../src/multiplexer-wezterm");
    const mux = new WezTermMultiplexer();
    const created = mux.createPane({
      context: {
        kind: "attached",
        mux: "wezterm",
        paneId: parentPane,
        server: socket,
      },
      name: "probe",
      cwd: "/tmp",
      background: true,
    });
    expect(created).toMatchObject({ paneId: childPane, server: socket });
    expect(calls[0]?.args).toContain(parentPane);
    expect(mux.getPaneLiveness(childPane, undefined, socket)).toBe("alive");
    mux.sendKeys(childPane, "echo hello", undefined, socket);
    mux.sendEnter(childPane, undefined, socket);
    expect(calls.at(-2)?.options.input).toBe("echo hello");
    expect(calls.at(-1)?.options.input).toBe("\r");
    const capture = await mux.capturePane(
      { paneId: childPane, server: socket },
      { maxLines: 2, maxBytes: 100 },
    );
    expect(capture).toEqual({ output: "two\nthree", truncated: true });
    mux.killPane(childPane, undefined, socket);
    expect(
      calls.every(
        (call) =>
          (call.options.env as NodeJS.ProcessEnv).WEZTERM_UNIX_SOCKET ===
          socket,
      ),
    ).toBe(true);
  });
});
