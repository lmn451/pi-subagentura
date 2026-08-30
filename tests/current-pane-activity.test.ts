import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as InteractiveTools from "../src/tools/interactive";
import type * as InteractiveTmux from "../src/interactive-tmux";
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
    delete process.env.PI_SUBAGENTURA_CHILD;
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

  it("returns unknown when the tmux activity probe fails", async () => {
    process.env.TMUX = "/tmp/tmux.sock,123,0";
    process.env.TMUX_PANE = "%42";
    installMockChildProcess((args) => {
      if (args[0] === "display-message") throw new Error("tmux unavailable");
      return "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "unknown",
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

  it("returns unknown when the zellij activity payload is malformed", async () => {
    process.env.ZELLIJ = "0";
    process.env.ZELLIJ_SESSION_NAME = "main";
    process.env.ZELLIJ_PANE_ID = "42";
    installMockChildProcess((args) => {
      if (args.includes("list-clients")) {
        return "CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\nclient-1 42 pi\n";
      }
      if (args.includes("list-tabs")) return "not-json";
      if (args.includes("list-panes")) return "[]";
      return "";
    });

    const { getCurrentPaneActivity } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");

    await expect(getCurrentPaneActivity()).resolves.toMatchObject({
      status: "unknown",
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

  it("keeps activity guidance neutral for non-v2 child agents", async () => {
    process.env.PI_SUBAGENTURA_CHILD = "1";
    const registerTool = vi.fn();
    // This test exercises only tool registration from the Pi API surface.
    const api = { registerTool } as unknown as ExtensionAPI;
    const { registerInteractiveSubagentTools } = await importFresh<
      typeof InteractiveTools
    >("../src/tools/interactive");

    registerInteractiveSubagentTools(api);
    const tool = registerTool.mock.calls
      .map(([definition]) => definition)
      .find((definition) => definition.name === "get_current_pane_activity");
    const result = await tool.execute();

    expect(tool).toBeDefined();
    expect(tool.description).not.toMatch(/before requesting user attention/i);
    expect(tool.promptSnippet).toBeUndefined();
    expect(tool.promptGuidelines).toBeUndefined();
    expect(result.content[0].text).not.toMatch(
      /do not request user attention|orchestrator/i,
    );
  });

  it("keeps parent user attention available when pane activity is unknown", async () => {
    const registerTool = vi.fn();
    // This test exercises only tool registration from the Pi API surface.
    const api = { registerTool } as unknown as ExtensionAPI;
    const { registerInteractiveSubagentTools } = await importFresh<
      typeof InteractiveTools
    >("../src/tools/interactive");

    registerInteractiveSubagentTools(api);
    const tool = registerTool.mock.calls
      .map(([definition]) => definition)
      .find((definition) => definition.name === "get_current_pane_activity");
    const result = await tool.execute();

    expect(tool.promptSnippet).toBeUndefined();
    expect(tool.description).not.toMatch(/before requesting user attention/i);
    expect(tool.promptGuidelines).toBeUndefined();
    expect(result.content[0].text).toContain("Current pane activity: unknown.");
    expect(result.content[0].text).not.toMatch(
      /do not request user attention|orchestrator/i,
    );
  });

  it("limits user-attention guidance to Orchestrator v2 children", async () => {
    const { buildChildSubagentProtocol } = await importFresh<
      typeof InteractiveTmux
    >("../src/interactive-tmux");
    const genericProtocol = buildChildSubagentProtocol("/tmp/artifacts");
    const orchestratorV2Protocol = buildChildSubagentProtocol(
      "/tmp/artifacts",
      true,
    );

    expect(genericProtocol).not.toContain("get_current_pane_activity");
    expect(orchestratorV2Protocol).toContain("get_current_pane_activity");
    expect(orchestratorV2Protocol).toMatch(/If it reports active, continue/);
    expect(orchestratorV2Protocol).toMatch(
      /inactive or unknown, do not open a prompt here/,
    );
  });
});
