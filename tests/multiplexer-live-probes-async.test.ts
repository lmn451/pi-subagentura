import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import {
  probeLiveMuxTargetAsync,
  type LiveMuxTarget,
} from "../src/multiplexer-live-probes";
import type {
  ProcessContext,
  ProcessIdentity,
} from "../src/multiplexer-process-context";

const { exec, sync } = vi.hoisted(() => ({
  exec: vi.fn<
    (
      command: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => ChildProcess
  >(),
  sync: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: exec,
  execFileSync: sync,
}));
const session = "session:12345678-1234-1234-1234-123456789abc";
const paneId = "block:12345678-1234-1234-1234-123456789abc";
const socket = "/tmp/mux sockets #1/live.sock";
const env = { TMUX: `${socket},20,0` };
const targets = [
  { mux: "tmux", paneId: "%4" },
  { mux: "herdr", paneId: "w1:p2", session: socket },
  { mux: "rex", paneId, session, server: `unix://${socket}` },
  { mux: "zellij", paneId: "terminal_4", session: "work" },
] as const;
function context(): ProcessContext {
  const own: ProcessIdentity = {
    pid: 100,
    parentPid: 90,
    tty: "pts/1",
    command: "node",
  };
  const ancestors = [
    { pid: 90, parentPid: 80, tty: "pts/1", command: "sh" },
    { pid: 80, parentPid: 1, tty: "pts/1", command: "zellij" },
  ];
  return {
    pid: 100,
    ancestors,
    processes: new Map([own, ...ancestors].map((row) => [row.pid, row])),
  };
}
function respond(stdout: string, error: Error | null = null): void {
  exec.mockImplementation((_command, _args, _options, callback) => {
    queueMicrotask(() => callback(error, stdout, "private stderr"));
    return {} as ChildProcess;
  });
}
function output(mux: LiveMuxTarget["mux"]): string {
  switch (mux) {
    case "tmux":
      return "%4\t90\t/dev/pts/1\n";
    case "herdr":
      return JSON.stringify({ result: { process_info: { shell_pid: 90 } } });
    case "rex":
      return JSON.stringify({ child: { pid: 90 } });
    case "zellij":
      return JSON.stringify([{ id: 4, is_plugin: false, exited: false }]);
  }
}
beforeEach(() => {
  vi.resetAllMocks();
  sync.mockImplementation(() => {
    throw new Error("synchronous child process calls are forbidden");
  });
});
afterEach(() => expect(sync).not.toHaveBeenCalled());
describe("asynchronous read-only live mux ownership probes", () => {
  it.each(targets)(
    "proves live ownership for $mux without sync calls",
    async (target) => {
      respond(output(target.mux));
      const pending = probeLiveMuxTargetAsync(target, context(), env);
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toEqual({
        kind: "match",
        target,
        distance: target.mux === "zellij" ? 1 : 0,
      });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({
          encoding: "utf8",
          timeout: 1500,
          maxBuffer: 65536,
          shell: false,
        }),
      );
    },
  );
  it("preserves exact spaced tmux socket argv and disables server start", async () => {
    respond(output("tmux"));
    await probeLiveMuxTargetAsync(targets[0], context(), env);
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual([
      "tmux",
      [
        "-N",
        "-S",
        socket,
        "display-message",
        "-p",
        "-t",
        "%4",
        "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
      ],
    ]);
  });
  it("pins named tmux sockets without server start", async () => {
    respond(output("tmux"));
    await probeLiveMuxTargetAsync(targets[0], context(), {
      PI_SUBAGENTURA_TMUX_SOCKET: "named-server",
    });
    expect(exec.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["-N", "-L", "named-server"]),
    );
  });
  it("pins Herdr's exact spaced socket in the child environment", async () => {
    respond(output("herdr"));
    await probeLiveMuxTargetAsync(targets[1], context(), {});
    expect(exec.mock.calls[0]?.slice(0, 2)).toEqual([
      "herdr",
      ["pane", "process-info", "--pane", "w1:p2"],
    ]);
    expect(exec.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ env: { HERDR_SOCKET_PATH: socket } }),
    );
  });
  it.each([socket, `unix://${socket}`])(
    "pins Rex socket %s without autostart",
    async (server) => {
      respond(output("rex"));
      await expect(
        probeLiveMuxTargetAsync({ ...targets[2], server }, context(), {}),
      ).resolves.toMatchObject({ kind: "match" });
      expect(exec.mock.calls[0]?.slice(0, 2)).toEqual([
        "rex",
        [
          "--autostart=false",
          "--timeout=1s",
          "--server",
          server,
          "block",
          "call",
          "--session",
          session,
          "--block",
          paneId,
          "process",
        ],
      ]);
    },
  );
  it.each([
    "work space",
    "work#1",
    "work space #1",
    "проект #1",
    "x".repeat(256),
  ])(
    "preserves valid Zellij session name %j as one literal async argument",
    async (session) => {
      const target = { mux: "zellij", paneId: "4", session } as const;
      respond(output("zellij"));
      await expect(
        probeLiveMuxTargetAsync(target, context(), {}),
      ).resolves.toEqual({ kind: "match", target, distance: 1 });
      expect(exec).toHaveBeenCalledWith(
        "zellij",
        ["--session", session, "action", "list-panes", "--json"],
        expect.objectContaining({ shell: false }),
        expect.any(Function),
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
    "rejects unsafe or oversized Zellij session name %j without async exec",
    async (session) => {
      await expect(
        probeLiveMuxTargetAsync(
          { mux: "zellij", paneId: "4", session },
          context(),
          {},
        ),
      ).resolves.toEqual({ kind: "unknown" });
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it.each([
    { mux: "tmux", paneId: "--help" },
    { mux: "tmux", paneId: "%4\n%5" },
    { mux: "herdr", paneId: "w1:p2", session: "/tmp/bad\0.sock" },
    { mux: "herdr", paneId: "--help", session: socket },
    { mux: "rex", paneId, session, server: "http://remote:8080" },
    { mux: "rex", paneId, session, server: "unix:///tmp/bad\n.sock" },
    { mux: "rex", paneId, session: "--help", server: socket },
    { mux: "zellij", paneId: "4", session: "--help" },
    { mux: "zellij", paneId: "4", session: "opaque\nname" },
  ] as const)(
    "rejects invalid target $mux $paneId before exec",
    async (target) => {
      await expect(
        probeLiveMuxTargetAsync(target, context(), env),
      ).resolves.toEqual({ kind: "unknown" });
      expect(exec).not.toHaveBeenCalled();
    },
  );
  it.each(targets)("fails closed on $mux timeouts", async (target) => {
    respond(
      "private output",
      Object.assign(new Error("timeout"), { killed: true, code: "ETIMEDOUT" }),
    );
    await expect(
      probeLiveMuxTargetAsync(target, context(), env),
    ).resolves.toEqual({ kind: "unknown" });
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(targets)("fails closed on malformed $mux output", async (target) => {
    respond("not valid protocol output");
    await expect(
      probeLiveMuxTargetAsync(target, context(), env),
    ).resolves.toEqual({ kind: "unknown" });
  });
  it.each([
    [targets[0], "%5\t90\t/dev/pts/1\n"],
    [targets[0], "%4\t999\t/dev/pts/1\n"],
    [targets[0], "%4\t90\t/dev/pts/9\n"],
    [
      targets[1],
      JSON.stringify({ result: { process_info: { shell_pid: 999 } } }),
    ],
    [
      targets[2],
      JSON.stringify({ child: { pid: 999 }, ancestors: [{ pid: 90 }] }),
    ],
    [targets[3], JSON.stringify([{ id: 5 }])],
  ] as const)(
    "rejects foreign or mismatched pane %j",
    async (target, response) => {
      respond(response);
      await expect(
        probeLiveMuxTargetAsync(target, context(), env),
      ).resolves.toEqual({ kind: "mismatch" });
    },
  );
});
