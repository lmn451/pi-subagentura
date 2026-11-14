import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import {
  resolveCurrentMuxContext,
  resolveCurrentMuxContextAsync,
} from "../src/multiplexer-current-context";

const { exec, sync, forbidden, unexpected } = vi.hoisted(() => ({
  exec: vi.fn<
    (
      command: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => ChildProcess
  >(),
  sync: vi.fn(),
  forbidden: vi.fn(() => {
    throw new Error("unexpected child_process API");
  }),
  unexpected: [] as string[],
}));
vi.mock("node:child_process", () => ({
  execFile: exec,
  execFileSync: sync,
  exec: forbidden,
  execSync: forbidden,
  spawn: forbidden,
  spawnSync: forbidden,
  fork: forbidden,
}));

const psArgs = ["-axo", "pid=,ppid=,tty=,comm="];
const modes = ["sync", "async"] as const;
function environment(session: string): NodeJS.ProcessEnv {
  return {
    ZELLIJ: "0",
    ZELLIJ_SESSION_NAME: session,
    ZELLIJ_PANE_ID: "4",
  };
}
function respond(
  command: string,
  args: readonly string[],
  session: string,
): string {
  if (command === "ps" && JSON.stringify(args) === JSON.stringify(psArgs)) {
    const shellPid = process.pid + 100;
    const muxPid = process.pid + 101;
    return (
      "1 0 ? /sbin/init\n" +
      `${muxPid} 1 pts/2 /usr/bin/zellij\n` +
      `${shellPid} ${muxPid} pts/2 /bin/sh\n` +
      `${process.pid} ${shellPid} pts/2 /usr/bin/node\n`
    );
  }
  if (
    command === "zellij" &&
    JSON.stringify(args) ===
      JSON.stringify(["--session", session, "action", "list-panes", "--json"])
  ) {
    return JSON.stringify([{ id: 4, is_plugin: false, exited: false }]);
  }
  unexpected.push(`${command} ${JSON.stringify(args)}`);
  throw new Error("unexpected subprocess command");
}
function installResponses(session: string): void {
  sync.mockImplementation((command: string, args: readonly string[]) =>
    respond(command, args, session),
  );
  exec.mockImplementation((command, args, _options, callback) => {
    const output = respond(command, args, session);
    queueMicrotask(() => callback(null, output, ""));
    return {} as ChildProcess;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  unexpected.length = 0;
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  forbidden.mockImplementation(() => {
    throw new Error("unexpected child_process API");
  });
  sync.mockImplementation(() => {
    unexpected.push("unconfigured execFileSync");
    throw new Error("unconfigured execFileSync");
  });
  exec.mockImplementation(() => {
    unexpected.push("unconfigured execFile");
    throw new Error("unconfigured execFile");
  });
});
afterEach(() => {
  expect(unexpected).toEqual([]);
  expect(forbidden).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe.each(modes)("%s Zellij session-name resolver integration", (mode) => {
  it.each(["project work", "project#1", "project work #1"])(
    "resolves the exact literal session %j using live ancestry",
    async (session) => {
      installResponses(session);
      const env = environment(session);
      const result =
        mode === "sync"
          ? resolveCurrentMuxContext(env)
          : await resolveCurrentMuxContextAsync(env);
      expect(result).toEqual({
        kind: "ready",
        target: { mux: "zellij", paneId: "4", session },
      });
      const active = mode === "sync" ? sync : exec;
      const inactive = mode === "sync" ? exec : sync;
      expect(inactive).not.toHaveBeenCalled();
      expect(active).toHaveBeenCalledTimes(2);
      expect(active.mock.calls[0]?.slice(0, 3)).toEqual([
        "ps",
        psArgs,
        expect.objectContaining({ shell: false }),
      ]);
      expect(active.mock.calls[1]?.slice(0, 3)).toEqual([
        "zellij",
        ["--session", session, "action", "list-panes", "--json"],
        expect.objectContaining({ shell: false, env }),
      ]);
    },
  );

  it.each([
    "bad\nname",
    "bad\rname",
    "bad\tname",
    "bad\u001bname",
    "bad\u007fname",
    "bad\0name",
    "--help",
    "-session",
  ])("never executes a mux command for unsafe session %j", async (session) => {
    installResponses(session);
    const env = environment(session);
    const result =
      mode === "sync"
        ? resolveCurrentMuxContext(env)
        : await resolveCurrentMuxContextAsync(env);
    expect(result.kind).toBe("unavailable");
    const active = mode === "sync" ? sync : exec;
    const inactive = mode === "sync" ? exec : sync;
    expect(inactive).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledTimes(1);
    expect(active.mock.calls[0]?.slice(0, 3)).toEqual([
      "ps",
      psArgs,
      expect.objectContaining({ shell: false }),
    ]);
  });
});
