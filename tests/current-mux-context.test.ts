import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCurrentMuxContext } from "../src/multiplexer-current-context";
import type { ProcessContext } from "../src/multiplexer-process-context";

const { readContext, nearest, probe } = vi.hoisted(() => ({
  readContext: vi.fn(),
  nearest: vi.fn(),
  probe: vi.fn(),
}));
vi.mock("../src/multiplexer-process-context", () => ({
  readProcessContext: readContext,
  closestMuxAncestor: nearest,
}));
vi.mock("../src/multiplexer-live-probes", () => ({
  probeLiveMuxTarget: probe,
}));
const context = {
  pid: 99,
  processes: new Map(),
  ancestors: [{ pid: 10, parentPid: 20, command: "zellij" }],
} as ProcessContext;
const nested = {
  TMUX: "/tmp/tmux.sock,1,0",
  TMUX_PANE: "%7",
  ZELLIJ: "0",
  ZELLIJ_SESSION_NAME: "work",
  ZELLIJ_PANE_ID: "3",
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_PANE_ID: "w1:p2",
  REX_SESSION: "session:01234567-89ab-cdef-0123-456789abcdef",
  REX_BLOCK: "block:01234567-89ab-cdef-0123-456789abcdef",
  REX_SERVER: "unix:///tmp/rex.sock",
};

describe("current mux ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readContext.mockReturnValue(context);
    probe.mockReturnValue({ kind: "unknown" });
  });

  it("keeps detached fallback free of process and server probes", () => {
    expect(
      resolveCurrentMuxContext({ REX_SERVER: "unix:///tmp/default.sock" }),
    ).toEqual({ kind: "absent" });
    expect(readContext).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["tmux", "zellij", "herdr", "rex"] as const)(
    "selects the live inner %s, not a fixed env priority",
    (mux) => {
      probe.mockImplementation((target) => ({
        kind: "match",
        target,
        distance: target.mux === mux ? 0 : 10,
      }));
      expect(resolveCurrentMuxContext(nested)).toMatchObject({
        kind: "ready",
        target: { mux },
      });
      expect(probe).toHaveBeenCalledTimes(4);
    },
  );

  it("does not let a stale outer marker veto proven inner ownership", () => {
    probe.mockImplementation((target) =>
      target.mux === "tmux"
        ? { kind: "match", target, distance: 1 }
        : { kind: "mismatch" },
    );
    expect(resolveCurrentMuxContext(nested)).toMatchObject({
      kind: "ready",
      target: { mux: "tmux", paneId: "%7" },
    });
  });

  it("refuses equally close or unverified targets instead of guessing", () => {
    probe.mockImplementation((target) => ({
      kind: "match",
      target,
      distance: 1,
    }));
    expect(resolveCurrentMuxContext(nested).kind).toBe("unavailable");
    probe.mockReturnValue({ kind: "unknown" });
    expect(resolveCurrentMuxContext(nested).kind).toBe("unavailable");
  });

  it("does not select a verified outer pane past an unverified inner mux", () => {
    nearest.mockReturnValue({ mux: "zellij", pid: 10 });
    probe.mockImplementation((target) =>
      target.mux === "tmux"
        ? { kind: "match", target, distance: 3 }
        : { kind: "unknown" },
    );
    expect(resolveCurrentMuxContext(nested).kind).toBe("unavailable");
  });

  it("does not let a farther outer mux ancestor veto a closer proven pane root", () => {
    nearest.mockReturnValue({ mux: "zellij", pid: 10 });
    probe.mockImplementation((target) =>
      target.mux === "tmux"
        ? { kind: "match", target, distance: -1 }
        : { kind: "unknown" },
    );
    expect(resolveCurrentMuxContext(nested)).toMatchObject({
      kind: "ready",
      target: { mux: "tmux" },
    });
  });

  it("fails closed without process evidence, including a single live-looking hint", () => {
    readContext.mockReturnValue(undefined);
    expect(
      resolveCurrentMuxContext({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%7" })
        .kind,
    ).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    { TMUX: "bad" },
    { TMUX_PANE: "%7" },
    { ZELLIJ: "0" },
    { HERDR_ENV: "1" },
    { TERM_PROGRAM: "rex" },
  ])("does not mistake incomplete markers for detached mode: %j", (env) => {
    expect(resolveCurrentMuxContext(env).kind).toBe("unavailable");
  });

  it("does not forward malformed selectors to backend commands", () => {
    expect(
      resolveCurrentMuxContext({
        ZELLIJ: "1",
        ZELLIJ_SESSION_NAME: "--bad",
        ZELLIJ_PANE_ID: "3",
      }).kind,
    ).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });
});
