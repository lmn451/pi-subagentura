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

/**
 * Addressed Herdr commands take the pane id as their first positional
 * argument. Keep the fallback for fixtures that model the pre-0.8.2
 * `--`-terminated form while assertions pin the current direct-positional
 * argv.
 */
function paneTarget(args: readonly string[]): string | undefined {
  const terminator = args.indexOf("--");
  return terminator >= 0 ? args[terminator + 1] : args[2];
}

/**
 * How the fake socket puts a serialized response on the wire. The default
 * writes the whole newline-delimited frame in one chunk; tests that exercise
 * the framing reader supply their own split.
 */
type SocketDelivery = (
  line: string,
  emit: (chunk: Buffer) => void,
) => void | Promise<void>;

const deliverWholeFrame: SocketDelivery = (line, emit) => {
  emit(Buffer.from(line + "\n"));
};

/**
 * When true, `execFile` callbacks are parked in `pendingExec` instead of
 * firing, so a test can hold an async probe in flight while other work runs
 * and then land it with `flushPendingExec()`. Reset in `beforeEach`.
 */
let deferExec = false;
const pendingExec: (() => void)[] = [];

function flushPendingExec(): void {
  const queued = pendingExec.splice(0, pendingExec.length);
  for (const run of queued) run();
}

function installMockExec(
  scenario: (call: ExecCall) => string,
  socketScenario: SocketScenario = defaultSocketScenario,
  socketBehavior: SocketBehavior = "respond",
  deliver: SocketDelivery = deliverWholeFrame,
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
      // Run the scenario NOW and defer only the delivery, so a parked probe
      // reports the world as it was when the process was spawned — which is
      // the whole point of modelling a slow probe.
      let deliverResult: () => void;
      try {
        const stdout = scenario(call);
        deliverResult = () => callback(null, stdout, "");
      } catch (error) {
        deliverResult = () => callback(error as Error, "", "");
      }
      if (deferExec) pendingExec.push(deliverResult);
      else deliverResult();
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
            void deliver(JSON.stringify(payload), (chunk) => {
              listeners.get("data")?.(chunk);
            });
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
    deferExec = false;
    pendingExec.length = 0;
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
  it("disambiguates same-named background tabs with the sub-agent id", async () => {
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

    // Two agents named "review" must not present as two identical tabs.
    const created = new HerdrMultiplexer().createPane({
      name: "review",
      cwd: "/repo",
      background: true,
      id: "a1b2c3d4",
    });
    expect(created.windowName).toBe("review-a1b2c3d4");
    const create = calls.find((call) => call.args[0] === "tab")!;
    expect(create.args).toContain("review-a1b2c3d4");
    expect(create.args[create.args.indexOf("--label") + 1]).toBe(
      "review-a1b2c3d4",
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
          return success({ pane: pane(paneTarget(call.args) ?? "w1:p1") });
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
        const target = paneTarget(call.args)!;
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

    mux.sendKeys("w1:p2", "literal\ntext", "/tmp/other.sock");
    mux.sendEnter("w1:p2", "/tmp/other.sock");
    // Herdr 0.8.2 rejects the generic `--` terminator for positional
    // handlers, so pane ids and literal text stay direct positional args.
    // This is the same argv shape used by the real 0.8.2 CLI.
    expect(calls[0]!.args).toEqual([
      "pane",
      "send-text",
      "w1:p2",
      "literal\ntext",
    ]);
    expect(calls[1]!.args).toEqual(["pane", "send-keys", "w1:p2", "enter"]);
  });

  it("messages a moved pane through its canonical id", async () => {
    // Regression guard: sendKeys/sendEnter were the only pane ops that skipped
    // alias resolution, so after a workspace move every follow-up message went
    // to the retired id and was silently dropped.
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({
          pane: { ...pane("w2:p7"), workspace_id: "w2", tab_id: "w2:t1" },
        });
      }
      return success({ ok: true });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    // The move: liveness resolves the caller's id onto the server's new one.
    expect(mux.getPaneLiveness("w1:p2", "/tmp/other.sock")).toBe("alive");

    mux.sendKeys("w1:p2", "follow-up", "/tmp/other.sock");
    mux.sendEnter("w1:p2", "/tmp/other.sock");

    expect(calls.at(-2)!.args).toEqual([
      "pane",
      "send-text",
      "w2:p7",
      "follow-up",
    ]);
    expect(calls.at(-1)!.args).toEqual(["pane", "send-keys", "w2:p7", "enter"]);
  });

  it("retires a stale canonical alias and retries delivery with the caller id", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      const target = paneTarget(call.args);
      if (call.args[0] === "pane" && call.args[1] === "get") {
        return success({
          pane: { ...pane("w2:p7"), workspace_id: "w2", tab_id: "w2:t1" },
        });
      }
      if (call.args[0] === "pane" && call.args[1] === "send-text") {
        if (target === "w2:p7") {
          throw Object.assign(new Error("pane not found"), {
            status: 2,
            stderr: JSON.stringify({
              id: "test",
              error: { code: "pane_not_found", message: "missing" },
            }),
          });
        }
        if (target === "w1:p2") return "";
      }
      if (
        call.args[0] === "pane" &&
        call.args[1] === "send-keys" &&
        target === "w1:p2"
      ) {
        return "";
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    // Resolve the caller id onto the server's current canonical id.
    expect(mux.getPaneLiveness("w1:p2")).toBe("alive");

    // The canonical id is now stale. Delivery must retry once under the id
    // returned by createPane, then keep using that id on later sends.
    expect(() => mux.sendKeys("w1:p2", "first")).not.toThrow();
    expect(() => mux.sendKeys("w1:p2", "second")).not.toThrow();
    expect(() => mux.sendEnter("w1:p2")).not.toThrow();

    expect(
      calls
        .filter(
          (call) =>
            call.args[0] === "pane" &&
            (call.args[1] === "send-text" || call.args[1] === "send-keys"),
        )
        .map((call) => paneTarget(call.args)),
    ).toEqual(["w2:p7", "w1:p2", "w1:p2", "w1:p2"]);
  });

  it.each([
    [
      "the error message",
      Object.assign(new Error("unrelated transport pane_not_found mention"), {
        stderr: "",
      }),
    ],
    [
      "plain diagnostics",
      Object.assign(new Error("unrelated transport failure"), {
        stderr: "not-json diagnostics mention pane_not_found incidentally",
      }),
    ],
  ] as const)(
    "propagates a canonical delivery failure when %s merely mentions pane_not_found",
    async (_location, deliveryError) => {
      const calls = installMockExec((call) => {
        if (isCommandProbe(call.file, call.args)) return "";
        const target = paneTarget(call.args);
        if (call.args[0] === "pane" && call.args[1] === "get") {
          return success({
            pane: { ...pane("w2:p7"), workspace_id: "w2", tab_id: "w2:t1" },
          });
        }
        if (call.args[0] === "pane" && call.args[1] === "send-text") {
          if (target === "w2:p7") throw deliveryError;
          throw new Error(`unexpected caller-id retry: ${target}`);
        }
        throw new Error(`unexpected command: ${call.args.join(" ")}`);
      });
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");
      const mux = new HerdrMultiplexer();

      // Seed the cached original -> canonical alias before delivery fails.
      expect(mux.getPaneLiveness("w1:p2")).toBe("alive");

      let firstError: unknown;
      try {
        mux.sendKeys("w1:p2", "first");
      } catch (error) {
        firstError = error;
      }
      let secondError: unknown;
      try {
        mux.sendKeys("w1:p2", "second");
      } catch (error) {
        secondError = error;
      }

      // The command wrapper must preserve the original delivery failure.
      expect(firstError).toMatchObject({ cause: deliveryError });
      expect(secondError).toMatchObject({ cause: deliveryError });
      // Both sends stay on the cached canonical id: no retry and no retirement.
      expect(
        calls
          .filter(
            (call) => call.args[0] === "pane" && call.args[1] === "send-text",
          )
          .map((call) => paneTarget(call.args)),
      ).toEqual(["w2:p7", "w2:p7"]);
    },
  );

  it.each(["sync", "async"] as const)(
    "freshly re-probes the original id after a stale canonical alias on the %s path",
    async (path) => {
      let originalLookups = 0;
      const calls = installMockExec((call) => {
        if (isCommandProbe(call.file, call.args)) return "";
        if (call.args[0] === "pane" && call.args[1] === "get") {
          const target = paneTarget(call.args)!;
          if (target === "w1:p2" && originalLookups++ === 0) {
            return success({
              pane: {
                ...pane("w2:p7"),
                workspace_id: "w2",
                tab_id: "w2:t1",
              },
            });
          }
          if (target === "w1:p2" || target === "w2:p7") {
            throw Object.assign(new Error("pane not found"), {
              code: "pane_not_found",
              stderr: JSON.stringify({
                id: "test",
                error: { code: "pane_not_found", message: "missing" },
              }),
            });
          }
        }
        throw new Error(`unexpected command: ${call.args.join(" ")}`);
      });
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");
      const mux = new HerdrMultiplexer();

      if (path === "sync") {
        expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
        expect(mux.getPaneLiveness("w1:p2")).toBe("dead");
      } else {
        await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("alive");
        await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("dead");
      }

      // The fallback must be a fresh third lookup, not the original cached
      // found result that named the now-retired canonical id.
      expect(
        calls
          .filter((call) => call.args[0] === "pane" && call.args[1] === "get")
          .map((call) => paneTarget(call.args)),
      ).toEqual(["w1:p2", "w2:p7", "w1:p2"]);
    },
  );

  it("rejects pane ids that could be read as flags or carry argv metacharacters", async () => {
    const calls = installMockExec(() => success({ ok: true }));
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    for (const bad of ["-n", "--force", "w1 p2", "w1:p2\n", "w1:p2\0", ""]) {
      expect(() => mux.sendKeys(bad, "text")).toThrow("pane id");
      expect(() => mux.sendEnter(bad)).toThrow("pane id");
      expect(mux.getPaneLiveness(bad)).toBe("unknown");
      await expect(mux.getPaneLivenessAsync(bad)).resolves.toBe("unknown");
      // killPane stays best-effort: a bad id is a no-op, never a throw.
      expect(() => mux.killPane(bad)).not.toThrow();
      await expect(
        mux.capturePane({ paneId: bad }, { maxLines: 5, maxBytes: 4096 }),
      ).rejects.toThrow("pane id");
      await expect(mux.focusPane({ paneId: bad })).rejects.toThrow("pane id");
    }
    expect(calls.filter((call) => call.file === "herdr")).toHaveLength(0);
  });

  it("caches pane liveness probes for 500ms and dedups concurrent ones", async () => {
    // Herdr has no pane list in the liveness path, so every probe is a process
    // spawn. Without the tmux/zellij 500ms TTL a supervisor refresh over N
    // panes paid N spawns per redraw.
    vi.useFakeTimers();
    try {
      const calls = installMockExec((call) => {
        if (isCommandProbe(call.file, call.args)) return "";
        return success({ pane: pane(paneTarget(call.args) ?? "w1:p2") });
      });
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");
      const mux = new HerdrMultiplexer();
      const paneGets = () =>
        calls.filter((call) => call.args[1] === "get").length;

      expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
      expect(paneGets()).toBe(1);
      expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
      await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("alive");
      expect(paneGets()).toBe(1);

      // A second pane is a separate cache entry.
      expect(mux.getPaneLiveness("w1:p3")).toBe("alive");
      expect(paneGets()).toBe(2);

      // In-flight dedup: concurrent async probes share one spawn.
      await vi.advanceTimersByTimeAsync(600);
      const [a, b] = await Promise.all([
        mux.getPaneLivenessAsync("w1:p2"),
        mux.getPaneLivenessAsync("w1:p2"),
      ]);
      expect([a, b]).toEqual(["alive", "alive"]);
      expect(paneGets()).toBe(3);

      // Past the TTL the probe runs again.
      await vi.advanceTimersByTimeAsync(600);
      expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
      expect(paneGets()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the caller's own id when a cached canonical id has gone stale", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      const target = paneTarget(call.args);
      if (call.args[0] === "pane" && call.args[1] === "get") {
        if (target === "w2:p7") {
          throw Object.assign(new Error("pane not found"), {
            stderr: JSON.stringify({
              id: "test",
              error: { code: "pane_not_found", message: "missing" },
            }),
          });
        }
        return success({
          pane: { ...pane("w2:p7"), workspace_id: "w2", tab_id: "w2:t1" },
        });
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    const probedIds = () =>
      calls
        .filter((call) => call.args[1] === "get")
        .map((call) => paneTarget(call.args));

    // Call 1 has no alias yet: it probes the caller's id and the server's
    // record remaps it to w2:p7.
    expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
    expect(probedIds()).toEqual(["w1:p2"]);

    // Call 2 follows the alias to w2:p7, which the scenario now reports
    // missing. The pane is still reachable under the caller's own id, so it
    // must not be declared dead.
    expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
    expect(probedIds()).toEqual(["w1:p2", "w2:p7", "w1:p2"]);

    // ...and the retry must CONVERGE. The record naming w2:p7 is still cached
    // and still being read, so a retirement that lasted only for this call
    // would reinstall the alias on the next one and retire it again on the one
    // after — a spawn every other call, forever, for a pane that answers
    // perfectly well under its own id.
    const settled = probedIds().length;
    for (let i = 0; i < 5; i++) {
      expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
    }
    expect(probedIds()).toHaveLength(settled);
  });

  it("does not let a slow async probe overwrite a newer sync observation", async () => {
    // Ordering is by issue sequence, not by clock: both probes here are issued
    // within the same millisecond, so a `Date.now()` comparison could not tell
    // them apart and the stale async result would win — restamped fresh, so a
    // pane already observed dead would keep reporting alive for a full TTL.
    let paneGone = false;
    installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[0] === "pane" && call.args[1] === "get") {
        if (paneGone) {
          throw Object.assign(new Error("pane not found"), {
            stderr: JSON.stringify({
              id: "test",
              error: { code: "pane_not_found", message: "missing" },
            }),
          });
        }
        return success({ pane: pane("w1:p2") });
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    // Issue the async probe against a live pane, but hold its callback.
    deferExec = true;
    const pending = mux.getPaneLivenessAsync("w1:p2");

    // The pane dies, and a sync probe observes that first.
    paneGone = true;
    deferExec = false;
    expect(mux.getPaneLiveness("w1:p2")).toBe("dead");

    // Now the older async probe lands. It must not resurrect the pane.
    flushPendingExec();
    await expect(pending).resolves.toBe("alive");
    expect(mux.getPaneLiveness("w1:p2")).toBe("dead");
    await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("dead");
  });

  it("clears the in-flight probe when a probe rejects", async () => {
    // A rejected probe that leaves `inFlight` pinned would make every later
    // call await the same settled, rejected promise instead of retrying.
    installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      return success({ pane: pane("w1:p2") });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();
    const rejection = new Error("probe exploded");
    const lookup = vi
      .spyOn(
        mux as unknown as {
          lookupPaneAsync: (id: string, session?: string) => Promise<unknown>;
        },
        "lookupPaneAsync",
      )
      .mockRejectedValueOnce(rejection);

    await expect(mux.getPaneLivenessAsync("w1:p2")).rejects.toThrow(
      "probe exploded",
    );

    // The next call must issue a fresh probe rather than re-awaiting the
    // rejected one.
    lookup.mockRestore();
    await expect(mux.getPaneLivenessAsync("w1:p2")).resolves.toBe("alive");
  });

  it("bounds the alias cache and keeps recently used entries", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[1] === "close") return "";
      const target = paneTarget(call.args)!;
      return success({
        pane: pane(target.startsWith("c") ? target : `c${target}`),
      });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();
    const probed = (id: string) =>
      calls.some((call) => paneTarget(call.args) === id);
    // `killPane` resolves the alias and always spawns, so unlike a liveness
    // call it reveals the mapping without the probe cache answering first.
    const closedTarget = (id: string) => {
      mux.killPane(id);
      return paneTarget(calls.at(-1)!.args);
    };

    // Every pane reports a canonical id distinct from the requested one, so
    // each install writes two alias entries (requested -> canonical and
    // canonical -> canonical): 256 panes exactly fill the 512-entry bound.
    for (let i = 0; i < 256; i++) {
      expect(mux.getPaneLiveness(`p${i}`)).toBe("alive");
    }

    // Re-touch p0 through its alias so it becomes the most recently used
    // entry. This is also what proves the alias was installed at all: the
    // second call addresses cp0, which nothing had probed before.
    expect(probed("cp0")).toBe(false);
    mux.sendKeys("p0", "touch");
    expect(probed("cp0")).toBe(true);

    // Push 200 more panes (400 entries) through the bound, evicting the
    // oldest 400 — everything up to and including p200's pair.
    for (let i = 256; i < 456; i++) {
      expect(mux.getPaneLiveness(`p${i}`)).toBe("alive");
    }

    // p1 was never re-touched, so its alias aged out and the id now resolves
    // to itself.
    expect(closedTarget("p1")).toBe("p1");
    // p0 sat at the same age as p1 until the re-touch moved it to the front,
    // so it survived the identical eviction pressure.
    expect(closedTarget("p0")).toBe("cp0");
    // A pane from the newest batch is obviously still aliased.
    expect(closedTarget("p455")).toBe("cp455");
  });

  it("drops alias and probe state when a pane is closed", async () => {
    const calls = installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) return "";
      if (call.args[1] === "close") return "";
      return success({
        pane: { ...pane("w2:p7"), workspace_id: "w2", tab_id: "w2:t1" },
      });
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    expect(mux.getPaneLiveness("w1:p2")).toBe("alive");
    mux.killPane("w1:p2");
    expect(calls.at(-1)!.args).toEqual(["pane", "close", "w2:p7"]);

    // A pane id reused after the close must not resolve onto the dead alias,
    // and the cached "alive" probe must not answer for it either.
    mux.killPane("w1:p2");
    expect(calls.at(-1)!.args).toEqual(["pane", "close", "w1:p2"]);
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
  it("reassembles a Herdr response split across socket chunks", async () => {
    // The multi-chunk branch of the framing reader: a socket read boundary can
    // land anywhere, including mid-JSON and mid-UTF-8 sequence.
    const marker = "é中\u{1f4a1}"; // 2-, 3- and 4-byte code points.
    installMockExec(
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
            text: `before-${marker}-after`,
            revision: 11,
            truncated: false,
          },
        }),
      "respond",
      (line, emit) => {
        const frame = Buffer.from(line + "\n", "utf8");
        // Split inside the multibyte marker so no single chunk decodes alone.
        const mid = frame.indexOf(Buffer.from(marker, "utf8")) + 1;
        emit(frame.subarray(0, 7));
        emit(frame.subarray(7, mid));
        emit(frame.subarray(mid, frame.length - 3));
        emit(frame.subarray(frame.length - 3));
      },
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().capturePane(
        { paneId: "w1:p2", session: "/tmp/other.sock" },
        { maxLines: 5, maxBytes: 4096 },
      ),
    ).resolves.toEqual({
      output: `before-${marker}-after`,
      truncated: false,
    });
  });

  it("surfaces a structured Herdr socket error with its code and message", async () => {
    installMockExec(
      () => "",
      () => ({
        error: { code: "pane_not_found", message: "no such pane" },
      }),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      }),
    ).rejects.toThrow("pane focus failed (pane_not_found): no such pane");
  });

  it("rejects a Herdr socket error payload with a malformed shape", async () => {
    installMockExec(
      () => "",
      () => ({ error: { code: 7, message: "no such pane" } }),
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      }),
    ).rejects.toThrow("Malformed herdr socket error");
  });

  it("aborts a Herdr socket response that never stops growing", async () => {
    // An unframed or hostile server must not be able to buffer Pi to death:
    // the reader gives up once the response passes MAX_HERDR_RESPONSE_BYTES.
    installMockExec(
      () => "",
      () => socketSuccess({ type: "ok" }),
      "respond",
      (_line, emit) => {
        // 1 MiB per chunk, no newline ever — the byte cap must fire first.
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        for (let sent = 0; sent < 64; sent++) emit(chunk);
      },
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    await expect(
      new HerdrMultiplexer().focusPane({
        paneId: "w1:p2",
        session: "/tmp/other.sock",
      }),
    ).rejects.toThrow("exceeded the byte limit");
  });

  it("is unavailable when the herdr binary is missing", async () => {
    installMockExec((call) => {
      if (isCommandProbe(call.file, call.args)) {
        throw new Error("command not found: herdr");
      }
      throw new Error(`unexpected command: ${call.args.join(" ")}`);
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    const mux = new HerdrMultiplexer();

    // Env markers alone are not enough — a Herdr-managed pane whose binary is
    // off PATH must fall through to another backend, not throw at spawn time.
    expect(mux.isAvailable()).toBe(false);
    expect(() =>
      mux.createPane({ name: "no-binary", cwd: "/repo", background: true }),
    ).toThrow("Herdr is not available");
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

  it("does not spend the truncation probe slot on a trailing newline", async () => {
    // Herdr terminates the last row with `\n`. Counted as a line it consumed
    // the `maxLines + 1` probe slot, so an exactly-`maxLines` capture dropped
    // its oldest real line AND reported a truncation that never happened.
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
            text: "a\nb\nc\n",
            revision: 3,
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
        { maxLines: 3, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "a\nb\nc", truncated: false });
    // One line over the bound still reports truncation.
    expect(calls.some((call) => call.file === "node:net")).toBe(true);
  });

  it.each([3, 200])(
    "captures sparse viewport content with a %s-line limit",
    async (maxLines) => {
      const requested: number[] = [];
      installMockExec(
        () => "",
        (request) => {
          const lines = Number(request.params.lines);
          requested.push(lines);
          return socketSuccess({
            type: "pane_read",
            read: {
              pane_id: "w1:p2",
              workspace_id: "w1",
              tab_id: "w1:t1",
              source: "recent_unwrapped",
              format: "text",
              revision: 3,
              text: lines < 300 ? "" : "a\nb\nc\n",
              truncated: lines < 300,
            },
          });
        },
      );
      const { HerdrMultiplexer } = await importFresh<
        typeof import("../src/multiplexer-herdr")
      >("../src/multiplexer-herdr");

      await expect(
        new HerdrMultiplexer().capturePane(
          { paneId: "w1:p2", session: "/tmp/other.sock" },
          { maxLines, maxBytes: 4096 },
        ),
      ).resolves.toEqual({ output: "a\nb\nc", truncated: false });
      expect(requested[0]).toBe(maxLines + 1);
      expect(requested.at(-1)).toBeGreaterThanOrEqual(300);
      expect(Math.max(...requested)).toBeLessThanOrEqual(4096);
    },
  );

  it("bounds retries when a sparse viewport never yields content", async () => {
    const requested: number[] = [];
    installMockExec(
      () => "",
      (request) => {
        requested.push(Number(request.params.lines));
        return socketSuccess({
          type: "pane_read",
          read: {
            pane_id: "w1:p2",
            workspace_id: "w1",
            tab_id: "w1:t1",
            source: "recent_unwrapped",
            format: "text",
            revision: 3,
            text: "",
            truncated: true,
          },
        });
      },
    );
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");
    await expect(
      new HerdrMultiplexer().capturePane(
        { paneId: "w1:p2", session: "/tmp/other.sock" },
        { maxLines: 3, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "", truncated: true });
    expect(requested.at(-1)).toBe(4096);
    expect(requested.length).toBeLessThanOrEqual(12);
  });

  it("still reports truncation past maxLines with a trailing newline", async () => {
    installMockExec(
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
            text: "a\nb\nc\nd\n",
            revision: 4,
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
        { maxLines: 3, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "b\nc\nd", truncated: true });
  });

  it("preserves a genuinely blank trailing row", async () => {
    installMockExec(
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
            text: "a\nb\n\n",
            revision: 5,
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
        { maxLines: 3, maxBytes: 4096 },
      ),
    ).resolves.toEqual({ output: "a\nb\n", truncated: false });
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

  it("rejects terminal ids that would be parsed as Herdr options", async () => {
    const calls = installMockExec(() => {
      throw new Error("terminal attach must not be attempted");
    });
    const { HerdrMultiplexer } = await importFresh<
      typeof import("../src/multiplexer-herdr")
    >("../src/multiplexer-herdr");

    expect(() =>
      new HerdrMultiplexer().buildAttachCommands({
        paneId: "w1:p2",
        terminalId: "--takeover",
        session: "/tmp/herdr.sock",
      }),
    ).toThrow("stable terminal_id");
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
