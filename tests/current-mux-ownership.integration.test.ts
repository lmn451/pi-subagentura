import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { resolveCurrentMuxContext } from "../src/multiplexer-current-context";
import type { MuxName } from "../src/multiplexer-contracts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
const env = {
  TMUX: "/tmp/test-tmux.sock,80,0",
  TMUX_PANE: "%4",
  ZELLIJ: "0",
  ZELLIJ_SESSION_NAME: "test",
  ZELLIJ_PANE_ID: "4",
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/tmp/test-herdr.sock",
  HERDR_PANE_ID: "w1:p2",
  REX_SESSION: "session:12345678-1234-1234-1234-123456789abc",
  REX_BLOCK: "block:12345678-1234-1234-1234-123456789abc",
  REX_SERVER: "unix:///tmp/test-rex.sock",
};

function installNested(
  inner: MuxName,
  outer: MuxName,
  options: { panePid?: number; callerTty?: string } = {},
): void {
  vi.mocked(execFileSync).mockImplementation((file) => {
    if (file === "ps")
      return [
        `${process.pid} 101 ${options.callerTty ?? "pts/2"} node`,
        "101 100 pts/2 sh",
        `100 91 pts/1 ${inner}`,
        "91 90 pts/1 sh",
        `90 1 ? ${outer}`,
        "1 0 ? init",
        "",
      ].join("\n");
    const panePid = options.panePid ?? (file === inner ? 101 : 91);
    if (file === "tmux")
      return `%4\t${panePid}\t/dev/pts/${panePid === 101 ? 2 : 1}\n`;
    if (file === "herdr")
      return JSON.stringify({
        result: { process_info: { shell_pid: panePid } },
      });
    if (file === "rex") return JSON.stringify({ child: { pid: panePid } });
    if (file === "zellij")
      return JSON.stringify([{ id: 4, is_plugin: false, exited: false }]);
    throw new Error("unexpected process boundary");
  });
}

beforeEach(() => vi.resetAllMocks());
describe("process snapshot through live pane ownership", () => {
  it.each([
    ["tmux", "zellij"],
    ["zellij", "tmux"],
    ["herdr", "rex"],
    ["rex", "herdr"],
    ["tmux", "herdr"],
    ["herdr", "tmux"],
    ["zellij", "rex"],
    ["rex", "zellij"],
  ] as const)(
    "selects inner %s inside %s despite all inherited markers",
    (inner, outer) => {
      installNested(inner, outer);
      expect(resolveCurrentMuxContext(env)).toMatchObject({
        kind: "ready",
        target: { mux: inner },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(execFileSync)
          .mock.calls.every(
            ([, args]) =>
              !args?.some((arg) =>
                /^(new-pane|new-window|split|create|kill-pane)$/.test(arg),
              ),
          ),
      ).toBe(true);
    },
  );

  it("rejects outer pane evidence when an inner mux is not verifiable", () => {
    installNested("zellij", "tmux");
    expect(
      resolveCurrentMuxContext({ TMUX: env.TMUX, TMUX_PANE: env.TMUX_PANE })
        .kind,
    ).toBe("unavailable");
  });
  it("accepts verified pane ownership through a PTY wrapper with another TTY", () => {
    installNested("tmux", "zellij", { callerTty: "pts/9" });
    expect(
      resolveCurrentMuxContext({
        TMUX: env.TMUX,
        TMUX_PANE: env.TMUX_PANE,
      }),
    ).toMatchObject({
      kind: "ready",
      target: { mux: "tmux", paneId: "%4" },
    });
  });

  it.each([
    ["same-kind ancestor", "tmux", 91],
    ["same-kind pane-root/server boundary", "tmux", 100],
    ["different-kind ancestor", "zellij", 91],
    ["different-kind pane-root/server boundary", "zellij", 100],
  ] as const)(
    "keeps TMUX ownership unavailable at a %s",
    (_scenario, innerMux, panePid) => {
      installNested(innerMux, "rex", { panePid });
      expect(
        resolveCurrentMuxContext({
          TMUX: env.TMUX,
          TMUX_PANE: env.TMUX_PANE,
        }).kind,
      ).toBe("unavailable");
      expect(execFileSync).toHaveBeenCalledWith(
        "tmux",
        expect.any(Array),
        expect.objectContaining({ shell: false }),
      );
    },
  );
});
