import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCurrentMuxContext,
  resolveExplicitHerdrCoreContext,
} from "../src/multiplexer-current-context";
import type {
  ProcessContext,
  ProcessIdentity,
} from "../src/multiplexer-process-context";

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
const own: ProcessIdentity = {
  pid: 99,
  parentPid: 10,
  command: "node",
};
const muxAncestor: ProcessIdentity = {
  pid: 10,
  parentPid: 20,
  command: "zellij",
};
const init: ProcessIdentity = {
  pid: 20,
  parentPid: 0,
  command: "init",
};
const context: ProcessContext = {
  pid: own.pid,
  processes: new Map([own, muxAncestor, init].map((row) => [row.pid, row])),
  ancestors: [muxAncestor],
};
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

  it.each(["/tmp/mux sockets #1/live.sock", "/tmp/live.sock "])(
    "preserves exact actual tmux socket %s despite a contradictory named socket",
    (server) => {
      probe.mockImplementation((target) => ({
        kind: "match",
        target,
        distance: 0,
      }));
      expect(
        resolveCurrentMuxContext({
          TMUX: `${server},1,0`,
          TMUX_PANE: "%7",
          PI_SUBAGENTURA_TMUX_SOCKET: "contradictory",
        }),
      ).toEqual({
        kind: "ready",
        target: { mux: "tmux", paneId: "%7", server },
      });
      expect(probe.mock.calls[0]?.[0]).toEqual({
        mux: "tmux",
        paneId: "%7",
        server,
      });
    },
  );

  it("keeps detached fallback free of process and server probes", () => {
    expect(
      resolveCurrentMuxContext({ REX_SERVER: "unix:///tmp/default.sock" }),
    ).toEqual({ kind: "absent" });
    expect(readContext).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("selects a verified WezTerm pane and rejects incomplete markers", () => {
    probe.mockImplementation((target) => ({
      kind: "match",
      target,
      distance: 0,
    }));
    expect(
      resolveCurrentMuxContext({
        WEZTERM_PANE: "7",
        WEZTERM_UNIX_SOCKET: "/tmp/wezterm.sock",
      }),
    ).toEqual({
      kind: "ready",
      target: { mux: "wezterm", paneId: "7", server: "/tmp/wezterm.sock" },
    });
    expect(resolveCurrentMuxContext({ WEZTERM_PANE: "7" }).kind).toBe(
      "unavailable",
    );
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

  it("selects a verified Herdr Core terminal among nested host markers", () => {
    nearest.mockReturnValue({ mux: "zellij", pid: 10 });
    probe.mockImplementation((target) => ({
      kind: target.mux === "herdr-core" ? "match" : "mismatch",
      ...(target.mux === "herdr-core" ? { target, distance: -1 } : {}),
    }));
    expect(
      resolveCurrentMuxContext({
        ...nested,
        HC_TERMINAL_ID: "t1abc",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
      }),
    ).toEqual({
      kind: "ready",
      target: {
        mux: "herdr-core",
        paneId: "t1abc",
        server: "/tmp/core.sock",
      },
    });
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it("does not treat a stale Core marker as detached or forward invalid addresses", () => {
    expect(
      resolveCurrentMuxContext({
        HC_TERMINAL_ID: "t1abc",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
      }).kind,
    ).toBe("unavailable");
    probe.mockClear();
    expect(
      resolveCurrentMuxContext({
        HC_TERMINAL_ID: "t0not-local",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
      }).kind,
    ).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("explicit Core verification ignores unrelated mux markers", () => {
    probe.mockImplementation((target) =>
      target.mux === "herdr-core"
        ? { kind: "match", target, distance: -1 }
        : { kind: "unknown" },
    );
    expect(
      resolveExplicitHerdrCoreContext({
        ...nested,
        HC_TERMINAL_ID: "t1abc",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
      }),
    ).toMatchObject({
      kind: "ready",
      target: { mux: "herdr-core", paneId: "t1abc" },
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0].mux).toBe("herdr-core");
  });

  it("requires live Core ownership for explicit Core selection", () => {
    expect(
      resolveExplicitHerdrCoreContext({
        HC_TERMINAL_ID: "t1abc",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
      }).kind,
    ).toBe("unavailable");
  });
});
