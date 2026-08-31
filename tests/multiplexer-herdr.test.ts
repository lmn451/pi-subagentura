import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInteractiveStates } from "../src/artifact";
import { importFresh } from "./test-utils";

interface ExecCall {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

interface SocketRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type SocketScenario = (request: SocketRequest) => Record<string, unknown>;

type SocketBehavior = "respond" | "hang";
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
function createdPane(paneId: string): Record<string, unknown> {
  return { ...pane(paneId), terminal_id: `terminal-${paneId}` };
}

function socketSuccess(
  result: Record<string, unknown>,
  id?: string,
): Record<string, unknown> {
  return { ...(id ? { id } : {}), result };
}

function defaultSocketScenario(
  request: SocketRequest,
): Record<string, unknown> {
  if (request.method === "pane.read") {
    return socketSuccess({
      type: "pane_read",
      read: {
        pane_id: String(request.params.pane_id),
        workspace_id: "w1",
        tab_id: "w1:t1",
        source: "recent_unwrapped",
        format: "text",
        text: "",
        revision: 0,
        truncated: false,
      },
    });
  }
  if (request.method === "pane.focus") {
    return socketSuccess({
      type: "pane_info",
      pane: {
        ...pane(String(request.params.pane_id)),
        terminal_id: `terminal-${String(request.params.pane_id)}`,
      },
    });
  }
  return socketSuccess({ type: "ok" });
}

function isCommandProbe(file: string, args: readonly string[]): boolean {
  return file === "/bin/sh" && args[0] === "-c";
}

function installMockExec(
  scenario: (call: ExecCall) => string,
  socketScenario: SocketScenario = defaultSocketScenario,
  socketBehavior: SocketBehavior = "respond",
): ExecCall[] {
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
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const call = { file, args: [...args], options: options ?? {} };
      calls.push(call);
      try {
        callback(null, scenario(call), "");
      } catch (error) {
        callback(error as Error, "", "");
      }
    },
  }));
  vi.doMock("node:net", () => ({
    createConnection: (options: { path: string }) => {
      const call: ExecCall = {
        file: "node:net",
        args: [],
        options: { ...options },
      };
      calls.push(call);
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const socket = {
        setTimeout: (_ms: number, callback: () => void) => {
          listeners.set("timeout", callback as (...args: unknown[]) => void);
          return socket;
        },
        on: (event: string, callback: (...args: unknown[]) => void) => {
          listeners.set(event, callback);
          return socket;
        },
        write: (requestText: string) => {
          call.args = [requestText];
          const request = JSON.parse(requestText) as SocketRequest;
          const response = socketScenario(request);
          const payload =
            response.id === undefined
              ? { ...response, id: request.id }
              : response;
          queueMicrotask(() => {
            listeners.get("data")?.(
              Buffer.from(JSON.stringify(payload) + "\n"),
            );
          });
          return true;
        },
        destroy: () => socket,
      };
      if (socketBehavior === "respond") {
        queueMicrotask(() => listeners.get("connect")?.());
      }
      return socket;
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
    vi.doUnmock("node:net");
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
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({ pane: pane("w1:p1") });
      }
      if (call.args[0] === "tab") {
        return success({ root_pane: createdPane("w1:p2") });
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
      muxTerminalId: "terminal-w1:p2",
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
  it("resolves the background workspace from the current pane record", async () => {
    process.env.HERDR_WORKSPACE_ID = "stale-workspace";

    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({
          pane: {
            ...pane("w2:p1"),
            workspace_id: "w2",
            tab_id: "w2:t1",
          },
        });
      }
      if (call.args[0] === "tab") {
        return success({ root_pane: createdPane("w2:p2") });
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    new HerdrMultiplexer().createPane({
      name: "moved",
      cwd: "/repo",
      background: true,
    });
    const create = calls.find((call) => call.args[0] === "tab")!;
    expect(create.args).toContain("w2");
    expect(create.args).not.toContain("stale-workspace");
  });
  it("persists the stable Herdr terminal identity before registry exposure", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-herdr-spawn-"));
    try {
      process.env.PI_CODING_AGENT_SESSION_DIR = cwd;
      process.env.HERDR_ENV = "1";
      process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
      process.env.HERDR_PANE_ID = "w1:p1";
      const calls = installMockExec((call) => {
        if (isCommandProbe(call.file, call.args)) return "";
        if (call.args[0] === "pane" && call.args[1] === "get") {
          return success({ pane: pane("w1:p1") });
        }
        if (call.args[0] === "tab") {
          return success({ root_pane: createdPane("w1:p2") });
        }
        return "";
      });
      const { launchInteractiveSubagent } = await importFresh<
        typeof import("../src/interactive-tmux")
      >("../src/interactive-tmux");

      const state = launchInteractiveSubagent({
        name: "persisted",
        task: "keep a stable attach target",
        cwd,
        parentCwd: cwd,
        parentSessionId: "parent",
        muxPreference: "herdr",
      });

      expect(state.muxTerminalId).toBe("terminal-w1:p2");
      expect(loadInteractiveStates(cwd)?.states[state.id]?.muxTerminalId).toBe(
        "terminal-w1:p2",
      );
      expect(
        calls.filter(
          (call) => call.args[0] === "pane" && call.args[1] === "get",
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rehydrates persisted Herdr attach commands without pane rediscovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-herdr-rehydrate-"));
    try {
      process.env.PI_CODING_AGENT_SESSION_DIR = cwd;
      process.env.HERDR_ENV = "1";
      process.env.HERDR_SOCKET_PATH = "/tmp/herdr-test.sock";
      process.env.HERDR_PANE_ID = "w1:p1";
      const calls = installMockExec((call) => {
        if (isCommandProbe(call.file, call.args)) return "";
        if (call.args[0] === "pane" && call.args[1] === "get") {
          return success({ pane: pane(call.args[2] ?? "w1:p1") });
        }
        if (call.args[0] === "tab") {
          return success({ root_pane: createdPane("w1:p2") });
        }
        return "";
      });
      const mod = await importFresh<typeof import("../src/interactive-tmux")>(
        "../src/interactive-tmux",
      );
      const state = mod.launchInteractiveSubagent({
        name: "rehydrate",
        task: "keep a stable attach target",
        cwd,
        parentCwd: cwd,
        parentSessionId: "parent",
        muxPreference: "herdr",
      });
      const paneGetsBefore = calls.filter(
        (call) => call.args[0] === "pane" && call.args[1] === "get",
      ).length;
      mod.interactiveSubagentRegistry.clear();

      const { rehydrateInteractiveSubagents } =
        await importFresh<typeof import("../src/rehydrate")>(
          "../src/rehydrate",
        );
      rehydrateInteractiveSubagents(cwd, "parent");

      expect(mod.interactiveSubagentRegistry.get(state.id)).toMatchObject({
        muxTerminalId: "terminal-w1:p2",
        attachCommand: expect.stringContaining(
          "herdr terminal attach 'terminal-w1:p2'",
        ),
      });
      expect(
        calls.filter(
          (call) => call.args[0] === "pane" && call.args[1] === "get",
        ).length,
      ).toBe(paneGetsBefore + 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates visible agents as right-hand splits of the parent pane", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      return success({ pane: createdPane("w1:p3") });
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
    ).toEqual({
      paneId: "w1:p3",
      muxTerminalId: "terminal-w1:p3",
      session: "/tmp/herdr-test.sock",
    });
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

  it("rejects Herdr create responses without a stable terminal identity", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({ pane: pane("w1:p1") });
      }
      if (call.args[0] === "tab") {
        return success({ root_pane: pane("w1:p2") });
      }
      if (call.args[0] === "pane" && call.args[1] === "close") return "";
      return "";
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(() =>
      new HerdrMultiplexer().createPane({
        name: "missing-terminal",
        cwd: "/repo",
        background: true,
      }),
    ).toThrow("stable terminal_id");
    expect(calls).toContainEqual(
      expect.objectContaining({
        args: ["pane", "close", "w1:p2"],
      }),
    );
  });

  it("closes a split pane when its terminal identity is malformed", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "split") {
        return success({
          pane: { ...pane("w1:p3"), terminal_id: 123 },
        });
      }
      if (call.args[0] === "pane" && call.args[1] === "close") return "";
      return "";
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(() =>
      new HerdrMultiplexer().createPane({
        name: "bad-terminal",
        cwd: "/repo",
        background: false,
        parentPane: "w1:p1",
      }),
    ).toThrow("stable terminal_id");
    expect(calls).toContainEqual(
      expect.objectContaining({
        args: ["pane", "close", "w1:p3"],
      }),
    );
  });
  it("reports tri-state liveness from authoritative pane records", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        const target = call.args[2]!;
        if (target === "w1:p8") {
          throw Object.assign(new Error("pane not found"), {
            stderr: JSON.stringify({
              id: "test",
              error: { code: "pane_not_found", message: "missing" },
            }),
          });
        }
        return success({ pane: pane(target) });
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
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
    expect(calls.some((call) => call.args[1] === "list")).toBe(false);
  });

  it("closes a moved pane through its canonical id after alias resolution", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({
          pane: {
            ...pane("w2:p1"),
            workspace_id: "w2",
            tab_id: "w2:t1",
          },
        });
      }
      if (call.args[0] === "pane" && call.args[1] === "close") return "";
      if (call.args[0] === "pane" && call.args[1] === "list") {
        throw new Error("pane list must not be used for liveness");
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.getPaneLiveness("w1:p1")).toBe("alive");
    mux.killPane("w1:p1");

    expect(calls.at(-1)!.args).toEqual(["pane", "close", "w2:p1"]);
  });

  it("returns unknown when an authoritative pane record is malformed", async () => {
    installMockExec(() => "not-json");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.getPaneLiveness("w1:p2")).toBe("unknown");
    await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("unknown");
  });

  it("does not treat server-global focus as user activity", async () => {
    const calls = installMockExec(() => {
      throw new Error("activity must not query Herdr");
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    await expect(mux.getPaneActivityAsync("w1:p2")).resolves.toBe("unknown");
    await expect(mux.getPaneActivityAsync("w1:p3")).resolves.toBe("unknown");
    expect(calls).toHaveLength(0);
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

  it("focuses a pane through Herdr's agent-independent control socket", async () => {
    const calls = installMockExec(() => "");
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await new HerdrMultiplexer().focusPane({
      paneId: "w1:p2",
      session: "/tmp/other.sock",
    });
    const focusCall = calls.find((call) => call.file === "node:net")!;
    const request = JSON.parse(focusCall.args[0]!) as SocketRequest;
    expect(request.method).toBe("pane.focus");
    expect(request.params).toEqual({ pane_id: "w1:p2" });
    expect(focusCall.options.path).toBe("/tmp/other.sock");
  });
  it("rejects Herdr socket responses with a mismatched request id", async () => {
    installMockExec(
      () => "",
      (request) =>
        socketSuccess(
          {
            type: "pane_info",
            pane: pane(String(request.params.pane_id)),
          },
          "different-request",
        ),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      }),
    ).rejects.toThrow("response id");
  });

  it("rejects focus responses without a typed pane_info result", async () => {
    installMockExec(
      () => "",
      () => socketSuccess({ type: "ok" }),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      }),
    ).rejects.toThrow("pane.focus response");
  });
  it("enforces an absolute deadline while the Herdr socket stays connected", async () => {
    vi.useFakeTimers();
    try {
      installMockExec(() => "", defaultSocketScenario, "hang");
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");
      const pending = new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      });
      const rejection = expect(pending).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures recent output with Herdr's structured read metadata", async () => {
    const calls = installMockExec(
      () => "",
      (request) =>
        request.method === "pane.read"
          ? socketSuccess({
              type: "pane_read",
              read: {
                pane_id: "w1:p2",
                workspace_id: "w1",
                tab_id: "w1:t1",
                source: "recent_unwrapped",
                format: "text",
                text: "one\ntwo\nthree",
                revision: 7,
                truncated: false,
              },
            })
          : socketSuccess({ type: "ok" }),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().capturePane(
        { paneId: "w1:p2", session: "/tmp/other.sock" },
        { maxLines: 2, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "two\nthree", truncated: true });
    const readCall = calls.find((call) => call.file === "node:net")!;
    const request = JSON.parse(readCall.args[0]!) as SocketRequest;
    expect(request.method).toBe("pane.read");
    expect(request.params).toMatchObject({
      pane_id: "w1:p2",
      source: "recent_unwrapped",
      lines: 3,
      format: "text",
      strip_ansi: true,
    });
  });
  it("rejects pane reads with the wrong source or format", async () => {
    for (const [source, format] of [
      ["recent", "text"],
      ["recent_unwrapped", "ansi"],
    ] as const) {
      installMockExec(
        () => "",
        () =>
          socketSuccess({
            type: "pane_read",
            read: {
              pane_id: "w1:p2",
              workspace_id: "w1",
              tab_id: "w1:t1",
              source,
              format,
              text: "complete",
              revision: 9,
              truncated: false,
            },
          }),
      );
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");

      await expect(
        new HerdrMultiplexer().capturePane(
          { paneId: "w1:p2", session: "/tmp/other.sock" },
          { maxLines: 5, maxBytes: 4096 },
        ),
      ).rejects.toThrow("pane.read response");
    }
  });

  it("preserves Herdr server truncation metadata", async () => {
    const calls = installMockExec(
      () => "",
      () =>
        socketSuccess({
          type: "pane_read",
          read: {
            pane_id: "w1:p2",
            workspace_id: "w1",
            tab_id: "w1:t1",
            source: "recent_unwrapped",
            format: "text",
            text: "complete",
            revision: 8,
            truncated: true,
          },
        }),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().capturePane(
        { paneId: "w1:p2", session: "/tmp/other.sock" },
        { maxLines: 5, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "complete", truncated: true });
    expect(calls.some((call) => call.file === "node:net")).toBe(true);
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

  it("builds terminal-scoped focus and attach commands", async () => {
    const calls = installMockExec((call) => {
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({
          pane: {
            ...pane("w1:p2"),
            terminal_id: "terminal-42",
          },
        });
      }
      return "";
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    const commands = new HerdrMultiplexer().buildAttachCommands({
      paneId: "w1:p2",
      session: "/tmp/session's.sock",
    });
    const expected =
      "HERDR_SOCKET_PATH='/tmp/session'\\''s.sock' herdr terminal attach 'terminal-42'";
    expect(commands.focusCommand).toBe(expected);
    expect(commands.attachCommand).toBe(expected);
    expect(calls[0]!.args).toEqual(["pane", "get", "w1:p2"]);
  });

  it("uses a persisted terminal identity without rediscovering the pane", async () => {
    const calls = installMockExec((call) => {
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    const commands = new HerdrMultiplexer().buildAttachCommands({
      paneId: "w1:p2",
      terminalId: "terminal-42",
      session: "/tmp/herdr.sock",
    });
    expect(commands.attachCommand).toContain(
      "herdr terminal attach 'terminal-42'",
    );
    expect(commands.focusCommand).toBe(commands.attachCommand);
    expect(calls).toHaveLength(0);
  });

  it("rejects attach commands without a stable Herdr terminal id", async () => {
    installMockExec((call) =>
      call.args[0] === "pane" && call.args[1] === "get"
        ? success({ pane: pane("w1:p2") })
        : "",
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(() =>
      new HerdrMultiplexer().buildAttachCommands({
        paneId: "w1:p2",
        session: "/tmp/herdr.sock",
      }),
    ).toThrow("stable terminal_id");
  });
});
