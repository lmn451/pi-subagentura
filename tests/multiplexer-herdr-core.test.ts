import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrCoreMultiplexer } from "../src/multiplexer-herdr-core";
import {
  probeLiveMuxTarget,
  probeLiveMuxTargetAsync,
} from "../src/multiplexer-live-probes";
import { getMux, resolveMux } from "../src/multiplexer";
import { detectEnvironment } from "../src/environment";

const { request, requestSync } = vi.hoisted(() => ({
  request: vi.fn(),
  requestSync: vi.fn(),
}));
vi.mock("../src/herdr-core-rpc.mjs", () => ({
  requestHerdrCore: request,
  requestHerdrCoreSync: requestSync,
}));
const server = "/tmp/hc socket's.sock";
const context = {
  kind: "attached",
  mux: "herdr-core",
  paneId: "t1",
  server,
} as const;

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("herdr-core backend", () => {
  it("prefers the injected owning socket over a contradictory CLI override", () => {
    vi.stubEnv("HC_TERMINAL_ID", "t1");
    vi.stubEnv("HC_TERMINAL_SOCKET", server);
    vi.stubEnv("HC_SOCKET", "/tmp/another-core.sock");
    expect(resolveMux({ preference: "herdr-core" }).context).toEqual(context);
    expect(
      detectEnvironment({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: server })
        .parentMux,
    ).toBe("herdr-core");
  });
  it("labels only complete unambiguous parent environment markers", () => {
    expect(
      detectEnvironment({ HC_TERMINAL_ID: "t1", HC_SOCKET: server }).parentMux,
    ).toBe("herdr-core");
    expect(detectEnvironment({ HC_TERMINAL_ID: "t1" }).parentMux).toBe(
      "unknown",
    );
    expect(
      detectEnvironment({
        HC_TERMINAL_ID: "t1",
        HC_SOCKET: server,
        TMUX: "/tmp/outer.sock",
      }).parentMux,
    ).toBe("unknown");
  });
  it("registers explicit launch context and preserves the owning endpoint", () => {
    vi.stubEnv("HC_TERMINAL_ID", "t1");
    vi.stubEnv("HC_SOCKET", server);
    const resolved = resolveMux({ preference: "herdr-core" });
    expect(resolved.adapter).toBe(getMux({ preference: "herdr-core" }));
    expect(resolved.context).toEqual(context);
    requestSync.mockReturnValue({ address: "t1b", state: "live" });
    const child = resolved.adapter.createPane({
      context,
      name: "Review!",
      id: "abcdef12",
      cwd: "/work repo",
      background: false,
    });
    expect(child).toMatchObject({ paneId: "t1b", server });
    expect(requestSync).toHaveBeenCalledWith(
      server,
      "terminal.run",
      expect.objectContaining({
        argv: ["bash", "--noprofile", "--norc", "-i"],
        parent: "t1",
        cwd: "/work repo",
        no_notify: true,
        outlive_parent: true,
      }),
    );
    expect(resolved.adapter.buildAttachCommands(child).attachCommand).toContain(
      "herdr-core attach t1b",
    );
    expect(resolved.adapter.capabilities).toEqual({
      structuredFocus: false,
      boundedCapture: true,
      nativeOverlay: false,
    });
  });

  it("keeps literal input and Enter separate and does not use the submitting send API", () => {
    const mux = new HerdrCoreMultiplexer();
    requestSync.mockReturnValue({ cols: 200, rows: 120 });
    mux.sendKeys("t1b", "hello\n'世界' 👋", undefined, server);
    mux.sendEnter("t1b", undefined, server);
    expect(requestSync.mock.calls).toEqual([
      [server, "terminal.get", { terminal: "t1b" }],
      [
        server,
        "terminal.attach",
        { terminal: "t1b", cols: 200, rows: 120 },
        "hello\n'世界' 👋",
      ],
      [server, "terminal.get", { terminal: "t1b" }],
      [
        server,
        "terminal.attach",
        { terminal: "t1b", cols: 200, rows: 120 },
        "\r",
      ],
    ]);
    expect(() => mux.sendKeys("--bad", "x", undefined, server)).toThrow();
    expect(() => mux.sendKeys("t1", "x")).toThrow();
    expect(requestSync).toHaveBeenCalledTimes(4);
  });

  it("distinguishes terminal exit/removal from unavailable or malformed probes", async () => {
    const mux = new HerdrCoreMultiplexer();
    for (const [value, expected] of [
      [{ address: "t1", state: "live" }, "alive"],
      [{ address: "t1", state: "finished" }, "dead"],
      [{ address: "t2", state: "live" }, "unknown"],
      [{ address: "t1", state: "unexpected" }, "unknown"],
    ] as const) {
      requestSync.mockReturnValue(value);
      request.mockResolvedValue(value);
      expect(mux.getPaneLiveness("t1", undefined, server)).toBe(expected);
      expect(await mux.getPaneLivenessAsync("t1", undefined, server)).toBe(
        expected,
      );
    }
    for (const [kind, expected] of [
      ["not_found", "dead"],
      ["unavailable", "unknown"],
    ]) {
      requestSync.mockImplementation(() => {
        throw { kind };
      });
      request.mockRejectedValue({ kind });
      expect(mux.getPaneLiveness("t1", undefined, server)).toBe(expected);
      expect(await mux.getPaneLivenessAsync("t1", undefined, server)).toBe(
        expected,
      );
    }
    expect(() => mux.killPane("t1", undefined, server)).not.toThrow();
    expect(await mux.getPaneActivityAsync()).toBe("unknown");
    expect(await mux.hasAttachedClientAsync()).toBeUndefined();
  });

  it("bounds captures and preserves incomplete-read metadata", async () => {
    const mux = new HerdrCoreMultiplexer();
    request.mockResolvedValue({ text: "one\ntwo\n世界\n", complete: true });
    expect(
      await mux.capturePane(
        { paneId: "t1", server },
        { maxLines: 2, maxBytes: 100 },
      ),
    ).toEqual({ output: "two\n世界", truncated: true });
    request.mockResolvedValue({ text: "one\n", complete: false });
    expect(
      await mux.capturePane(
        { paneId: "t1", server },
        { maxLines: 2, maxBytes: 100 },
      ),
    ).toEqual({ output: "one", truncated: true });
  });

  it("proves terminal root ancestry and refuses an unrelated foreground PID", async () => {
    const own = { pid: 99, parentPid: 10, command: "node" };
    const parent = { pid: 10, parentPid: 1, command: "bash" };
    const processContext = {
      pid: 99,
      ancestors: [parent],
      processes: new Map([
        [99, own],
        [10, parent],
      ]),
    };
    const target = { mux: "herdr-core", paneId: "t1", server } as const;
    const value = { address: "t1", state: "live", pid: 10 };
    requestSync.mockReturnValue(value);
    request.mockResolvedValue(value);
    expect(probeLiveMuxTarget(target, processContext)).toEqual({
      kind: "match",
      target,
      distance: 0,
    });
    expect(await probeLiveMuxTargetAsync(target, processContext)).toEqual({
      kind: "match",
      target,
      distance: 0,
    });
    requestSync.mockReturnValue({
      ...value,
      pid: 500,
      foreground: { pid: 99 },
    });
    expect(probeLiveMuxTarget(target, processContext).kind).toBe("mismatch");
    requestSync.mockReturnValue({ ...value, pid: null });
    expect(probeLiveMuxTarget(target, processContext).kind).toBe("unknown");
  });
});
