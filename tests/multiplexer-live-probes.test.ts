import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { probeLiveMuxTarget } from "../src/multiplexer-live-probes";
import type {
  ProcessContext,
  ProcessIdentity,
} from "../src/multiplexer-process-context";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
const exec = vi.mocked(execFileSync);
const session = "session:12345678-1234-1234-1234-123456789abc";
const paneId = "block:12345678-1234-1234-1234-123456789abc";
function context(commands = ["sh", "tmux", "zellij"]): ProcessContext {
  const own: ProcessIdentity = {
    pid: 100,
    parentPid: 90,
    tty: "pts/1",
    command: "node",
  };
  const ancestors = commands.map((command, index) => ({
    pid: 90 - index * 10,
    parentPid: 80 - index * 10,
    tty: "pts/1",
    command,
  }));
  return {
    pid: 100,
    ancestors,
    processes: new Map([own, ...ancestors].map((row) => [row.pid, row])),
  };
}
const tmux = { mux: "tmux", paneId: "%4" } as const;
const env = { TMUX: "/tmp/tmux-user/default,20,0" };
beforeEach(() => vi.resetAllMocks());
describe("read-only live mux ownership probes", () => {
  it("requires exact tmux pane identity and process ownership", () => {
    exec.mockReturnValue("%4\t90\t/dev/pts/1\n");
    expect(probeLiveMuxTarget(tmux, context(), env)).toEqual({
      kind: "match",
      target: tmux,
      distance: 0,
    });
    expect(exec).toHaveBeenCalledWith(
      "tmux",
      [
        "-N",
        "-S",
        "/tmp/tmux-user/default",
        "display-message",
        "-p",
        "-t",
        "%4",
        "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
      ],
      expect.objectContaining({
        timeout: 1500,
        maxBuffer: 65536,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["/tmp/mux sockets/live.sock", "/tmp/mux #1/live.sock"])(
    "accepts exact spaced Unix socket paths %s without shell parsing",
    (path) => {
      exec.mockReturnValue("%4\t90\t/dev/pts/1\n");
      expect
        .soft(
          probeLiveMuxTarget(tmux, context(), { TMUX: `${path},20,0` }).kind,
        )
        .toBe("match");
      expect
        .soft(exec.mock.calls.at(-1)?.[1])
        .toEqual(expect.arrayContaining(["-S", path]));
      exec.mockReturnValue(
        JSON.stringify({ result: { process_info: { shell_pid: 90 } } }),
      );
      expect
        .soft(
          probeLiveMuxTarget(
            { mux: "herdr", paneId: "w1:p2", session: path },
            context(),
            {},
          ).kind,
        )
        .toBe("match");
      expect
        .soft(exec.mock.calls.at(-1)?.[2])
        .toEqual(expect.objectContaining({ env: { HERDR_SOCKET_PATH: path } }));
      exec.mockReturnValue(JSON.stringify({ child: { pid: 90 } }));
      for (const server of [path, `unix://${path}`]) {
        expect
          .soft(
            probeLiveMuxTarget(
              { mux: "rex", paneId, session, server },
              context(),
              {},
            ).kind,
          )
          .toBe("match");
        expect
          .soft(exec.mock.calls.at(-1)?.[1])
          .toEqual(expect.arrayContaining(["--server", server]));
      }
      for (const call of exec.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ shell: false }));
      }
    },
  );
  it("accepts a directly execed agent as the pane root process", () => {
    exec.mockReturnValue("%4\t100\t/dev/pts/1\n");
    expect(probeLiveMuxTarget(tmux, context(), env)).toEqual({
      kind: "match",
      target: tmux,
      distance: -1,
    });
  });
  it.each([
    "%5\t90\t/dev/pts/1\n",
    "%4\t999\t/dev/pts/1\n",
    "%4\t90\t/dev/pts/9\n",
  ])("rejects stale or foreign tmux evidence %s", (output) => {
    exec.mockReturnValue(output);
    expect(probeLiveMuxTarget(tmux, context(), env).kind).toBe("mismatch");
  });
  it("does not treat matching tty alone as ownership", () => {
    exec.mockReturnValue("%4\t999\t/dev/pts/1\n");
    expect(probeLiveMuxTarget(tmux, context(), env).kind).not.toBe("match");
  });
  it("pins named tmux sockets without autostart", () => {
    exec.mockReturnValue("%4\t90\t/dev/pts/1\n");
    probeLiveMuxTarget(tmux, context(), {
      PI_SUBAGENTURA_TMUX_SOCKET: "my-server",
    });
    expect(exec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-N", "-L", "my-server"]),
    );
  });
  it("never lets an inherited named socket override the actual server path", () => {
    exec.mockReturnValue("%4\t90\t/dev/pts/1\n");
    const server = "/tmp/actual # socket ";
    probeLiveMuxTarget({ ...tmux, server }, context(), {
      TMUX: "/stale.sock,1,0",
      PI_SUBAGENTURA_TMUX_SOCKET: "contradictory",
    });
    expect(exec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-N", "-S", server]),
    );
    expect(exec.mock.calls[0]?.[1]).not.toContain("-L");
  });
  it("reads only the documented Herdr shell PID and pins its socket", () => {
    exec.mockReturnValue(
      JSON.stringify({ result: { process_info: { shell_pid: 90 } } }),
    );
    const target = {
      mux: "herdr",
      paneId: "w1:p2",
      session: "/tmp/herdr.sock",
    } as const;
    expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("match");
    expect(exec).toHaveBeenCalledWith(
      "herdr",
      ["pane", "process-info", "--pane", "w1:p2"],
      expect.objectContaining({
        env: { HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
      }),
    );
  });
  it("uses Rex child or foreground PID, never its reported ancestors", () => {
    const target = {
      mux: "rex",
      paneId,
      session,
      server: "unix:///tmp/rex.sock",
    } as const;
    exec.mockReturnValue(
      JSON.stringify({
        child: { pid: 999 },
        foreground: { pid: 90 },
        ancestors: [{ pid: 80 }],
      }),
    );
    expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("match");
    exec.mockReturnValue(
      JSON.stringify({ child: { pid: 999 }, ancestors: [{ pid: 90 }] }),
    );
    expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("mismatch");
    expect(exec.mock.calls[0]?.[1]).toEqual([
      "--autostart=false",
      "--timeout=1s",
      "--server",
      target.server,
      "block",
      "call",
      "--session",
      session,
      "--block",
      paneId,
      "process",
    ]);
  });
  it.each(["\x00", "\t", "\n", "\r", "\x1f", "\x7f"])(
    "rejects control characters in socket paths %j without exec",
    (control) => {
      const path = `/tmp/mux${control}/live.sock`;
      const targets = [
        { mux: "tmux", paneId: "%4" },
        { mux: "herdr", paneId: "w1:p2", session: path },
        { mux: "rex", paneId, session, server: path },
        { mux: "rex", paneId, session, server: `unix://${path}` },
      ] as const;
      for (const target of targets) {
        expect(
          probeLiveMuxTarget(target, context(), { TMUX: `${path},20,0` }).kind,
        ).toBe("unknown");
      }
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it("never compares remote Rex PIDs", () => {
    expect(
      probeLiveMuxTarget(
        { mux: "rex", paneId, session, server: "http://remote:8080" },
        context(),
        {},
      ).kind,
    ).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });
  it("requires closest Zellij ownership in both nesting directions", () => {
    const target = { mux: "zellij", paneId: "4", session: "work" } as const;
    exec.mockReturnValue(
      JSON.stringify([{ id: 4, is_plugin: false, exited: false }]),
    );
    expect(
      probeLiveMuxTarget(target, context(["sh", "zellij", "tmux"]), {}),
    ).toEqual({ kind: "match", target, distance: 1 });
    expect(
      probeLiveMuxTarget(target, context(["sh", "tmux", "zellij"]), {}).kind,
    ).not.toBe("match");
  });
  it.each([
    "work space",
    "work#1",
    "work space #1",
    "проект #1",
    "x".repeat(256),
  ])(
    "preserves valid Zellij session name %j as one literal argument",
    (session) => {
      const target = { mux: "zellij", paneId: "4", session } as const;
      exec.mockReturnValue(
        JSON.stringify([{ id: 4, is_plugin: false, exited: false }]),
      );
      expect(probeLiveMuxTarget(target, context(["sh", "zellij"]), {})).toEqual(
        { kind: "match", target, distance: 1 },
      );
      expect(exec).toHaveBeenCalledWith(
        "zellij",
        ["--session", session, "action", "list-panes", "--json"],
        expect.objectContaining({ shell: false }),
      );
      expect(exec).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "",
    " ",
    "--help",
    "work\0name",
    "work\tname",
    "work\nname",
    "work\rname",
    "work\x7fname",
    "x".repeat(257),
  ])(
    "rejects unsafe or oversized Zellij session name %j without exec",
    (session) => {
      expect(
        probeLiveMuxTarget(
          { mux: "zellij", paneId: "4", session },
          context(["sh", "zellij"]),
          {},
        ).kind,
      ).toBe("unknown");
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it.each([{ id: 4, is_plugin: true }, { id: 4, exited: true }, { id: 5 }])(
    "rejects unavailable Zellij pane %j",
    (pane) => {
      exec.mockReturnValue(JSON.stringify([pane]));
      expect(
        probeLiveMuxTarget(
          { mux: "zellij", paneId: "4", session: "work" },
          context(["zellij"]),
          {},
        ).kind,
      ).toBe("mismatch");
    },
  );
  it.each(["--help", "%4;kill-server", "%4\n%5"])(
    "rejects injected pane selector %s without exec",
    (paneId) => {
      expect(
        probeLiveMuxTarget({ mux: "tmux", paneId }, context(), env).kind,
      ).toBe("unknown");
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it.each(["unsupported", "{}", "[]", "null"])(
    "fails closed for unsupported output %s",
    (output) => {
      exec.mockReturnValue(output);
      expect(probeLiveMuxTarget(tmux, context(), env).kind).toBe("unknown");
    },
  );
  it.each([
    { mux: "herdr", paneId: "--help", session: "/tmp/herdr.sock" },
    { mux: "herdr", paneId: "w1:p1", session: "--help" },
    { mux: "zellij", paneId: "4", session: "--help" },
    { mux: "zellij", paneId: "4", session: "work\nspace" },
    { mux: "herdr", paneId: "pane space", session: "/tmp/herdr.sock" },
    { mux: "rex", paneId, session: "--help", server: "/tmp/rex.sock" },
    { mux: "rex", paneId, session, server: "unix:///tmp/rex.sock\n--help" },
  ] as const)("rejects injected backend selectors %j", (target) => {
    expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("unknown");
    expect(exec).not.toHaveBeenCalled();
  });
  it.each(["herdr", "rex"] as const)(
    "fails closed on unsupported %s process responses",
    (mux) => {
      const target =
        mux === "herdr"
          ? { mux, paneId: "w1:p1", session: "/tmp/herdr.sock" }
          : { mux, paneId, session, server: "/tmp/rex.sock" };
      for (const output of [
        "{}",
        "null",
        "[]",
        "unsupported",
        '{"result":{"process_info":{"shell_pid":-1}}}',
      ]) {
        exec.mockReturnValue(output);
        expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("unknown");
      }
    },
  );
  it("measures PID ownership at the matched ancestor and rejects foreign Herdr panes", () => {
    const target = {
      mux: "herdr",
      paneId: "w1:p1",
      session: "/tmp/herdr.sock",
    } as const;
    exec.mockReturnValue(
      JSON.stringify({ result: { process_info: { shell_pid: 70 } } }),
    );
    expect(probeLiveMuxTarget(target, context(), {})).toEqual({
      kind: "match",
      target,
      distance: 2,
    });
    exec.mockReturnValue(
      JSON.stringify({ result: { process_info: { shell_pid: 999 } } }),
    );
    expect(probeLiveMuxTarget(target, context(), {}).kind).toBe("mismatch");
  });
  it("does not prove Zellij ownership from a live focused pane alone", () => {
    exec.mockReturnValue(JSON.stringify([{ id: 4, is_focused: true }]));
    expect(
      probeLiveMuxTarget(
        { mux: "zellij", paneId: "4", session: "work" },
        context(["sh"]),
        {},
      ).kind,
    ).toBe("unknown");
  });
  it("swallows command timeouts without a fallback spawn", () => {
    exec.mockImplementation(() => {
      throw new Error("timeout secret output");
    });
    expect(probeLiveMuxTarget(tmux, context(), env)).toEqual({
      kind: "unknown",
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });
  describe("reviewed mux regressions", () => {
    it("matches a pane-root PID when a PTY wrapper gives the caller another TTY", () => {
      exec.mockReturnValue("%4\t90\t/dev/pts/1\n");
      const baseContext = context();
      const processes = new Map(baseContext.processes);
      const caller = processes.get(baseContext.pid)!;
      processes.set(baseContext.pid, { ...caller, tty: "pts/wrapper" });
      const processContext: ProcessContext = { ...baseContext, processes };

      expect(probeLiveMuxTarget(tmux, processContext, env)).toEqual({
        kind: "match",
        target: tmux,
        distance: 0,
      });
    });

    it("derives the tmux socket when the named-socket override is empty", () => {
      exec.mockReturnValue("%4\t90\t/dev/pts/1\n");

      expect(
        probeLiveMuxTarget(tmux, context(), {
          ...env,
          PI_SUBAGENTURA_TMUX_SOCKET: "",
        }),
      ).toEqual({ kind: "match", target: tmux, distance: 0 });
      expect(exec.mock.calls[0]?.[1]).toEqual([
        "-N",
        "-S",
        "/tmp/tmux-user/default",
        "display-message",
        "-p",
        "-t",
        "%4",
        "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
      ]);
    });

    it.each([
      "my server",
      "#server",
      "π",
      " server ",
      "-server",
      "x".repeat(128),
    ])("passes literal tmux label %j and proves ownership", (label) => {
      exec.mockReturnValue("%4\t90\t/dev/pts/1\n");

      expect(
        probeLiveMuxTarget(tmux, context(), {
          ...env,
          PI_SUBAGENTURA_TMUX_SOCKET: label,
        }),
      ).toEqual({ kind: "match", target: tmux, distance: 0 });
      expect(exec.mock.calls[0]?.[1]).toEqual([
        "-N",
        "-L",
        label,
        "display-message",
        "-p",
        "-t",
        "%4",
        "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
      ]);
    });

    it.each(["\x00", "\t", "\n", "\r", "\x1f", "\x7f", "x".repeat(129)])(
      "rejects unsafe or oversized tmux label %j without backend execution",
      (label) => {
        expect(
          probeLiveMuxTarget(tmux, context(), {
            ...env,
            PI_SUBAGENTURA_TMUX_SOCKET: label,
          }),
        ).toEqual({ kind: "unknown" });
        expect(exec).not.toHaveBeenCalled();
      },
    );

    it.each([" project", "project ", "  project  "])(
      "preserves accepted Zellij session name %j literally",
      (session) => {
        const target = { mux: "zellij", paneId: "4", session } as const;
        exec.mockReturnValue(
          JSON.stringify([{ id: 4, is_plugin: false, exited: false }]),
        );

        expect(
          probeLiveMuxTarget(target, context(["sh", "zellij"]), {}),
        ).toEqual({ kind: "match", target, distance: 1 });
        expect(exec.mock.calls[0]?.[1]).toEqual([
          "--session",
          session,
          "action",
          "list-panes",
          "--json",
        ]);
      },
    );
  });
});
