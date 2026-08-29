import { afterEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

function installMockChildProcess(scenario: (args: string[]) => string): void {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (_file: string, args: string[]) => scenario(args),
    execFile: (
      _file: string,
      args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      try {
        callback(null, scenario(args));
      } catch (error) {
        callback(error as Error, "");
      }
    },
    spawn: vi.fn(),
  }));
}

describe("current pane activity", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.ZELLIJ;
    delete process.env.ZELLIJ_SESSION_NAME;
    delete process.env.ZELLIJ_PANE_ID;
  });

  it("reports an active tmux pane when the user's window has focus", async () => {
    process.env.TMUX = "/tmp/tmux.sock,123,0";
    process.env.TMUX_PANE = "%42";
    const calls: string[][] = [];
    installMockChildProcess((args) => {
      calls.push(args);
      return args[0] === "display-message" ? "1\t1\t0\n" : "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "active",
      mux: "tmux",
      paneId: "%42",
    });
    expect(calls).toContainEqual([
      "display-message",
      "-p",
      "-t",
      "%42",
      "#{window_active_clients}\t#{pane_active}\t#{pane_dead}",
    ]);
  });

  it("reports an inactive tmux pane when its window is not viewed", async () => {
    process.env.TMUX = "/tmp/tmux.sock,123,0";
    process.env.TMUX_PANE = "%42";
    installMockChildProcess((args) =>
      args[0] === "display-message" ? "0\t1\t0\n" : "",
    );

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "inactive",
      mux: "tmux",
      paneId: "%42",
    });
  });

  it("reports zellij activity for the current session and pane", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    process.env.ZELLIJ_PANE_ID = "42";
    installMockChildProcess((args) => {
      if (args.includes("list-clients")) {
        return "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\nclient-1 42 pi\n";
      }
      if (args.includes("list-tabs")) {
        return JSON.stringify([{ position: 0, tab_id: 7, active: true }]);
      }
      if (args.includes("list-panes")) {
        return JSON.stringify([
          {
            id: 42,
            is_plugin: false,
            is_focused: true,
            is_floating: false,
            is_suppressed: false,
            tab_id: 7,
            tab_position: 0,
          },
        ]);
      }
      return "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "active",
      mux: "zellij",
      paneId: "42",
      session: "main",
    });
  });

  it("reports zellij inactive when no client is attached", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    process.env.ZELLIJ_PANE_ID = "42";
    installMockChildProcess((args) => {
      if (args.includes("list-clients")) {
        return "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n";
      }
      if (args.includes("list-tabs")) {
        return JSON.stringify([{ position: 0, tab_id: 7, active: true }]);
      }
      if (args.includes("list-panes")) {
        return JSON.stringify([
          {
            id: 42,
            is_plugin: false,
            is_focused: true,
            is_floating: false,
            is_suppressed: false,
            tab_id: 7,
            tab_position: 0,
          },
        ]);
      }
      return "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "inactive",
      mux: "zellij",
      paneId: "42",
      session: "main",
    });
  });

  it("returns unknown when the current process has no mux pane identity", async () => {
    const calls: string[][] = [];
    installMockChildProcess((args) => {
      calls.push(args);
      return "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toEqual({
      status: "unknown",
    });
    expect(calls).toEqual([]);
  });

  it("registers activity guidance for child agents", async () => {
    const api = { registerTool: vi.fn() };
    const { registerInteractiveSubagentTools } = await importFresh<
      typeof import("../src/tools/interactive")
    >("../src/tools/interactive");

    registerInteractiveSubagentTools(api as any);
    const tool = api.registerTool.mock.calls
      .map(([definition]) => definition)
      .find((definition) => definition.name === "get_current_pane_activity");

    expect(tool).toBeDefined();
    expect(tool.description).toMatch(/user attention/i);
    expect(tool.promptGuidelines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/get_current_pane_activity/),
      ]),
    );
  });

  it("includes pane activity guidance in the child protocol", async () => {
    const { buildChildSubagentProtocol } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    const protocol = buildChildSubagentProtocol("/tmp/artifacts");

    expect(protocol).toContain("get_current_pane_activity");
    expect(protocol).toMatch(/If it reports active, continue/);
    expect(protocol).toMatch(/inactive or unknown, do not open a prompt here/);
  });
});
