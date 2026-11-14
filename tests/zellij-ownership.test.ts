import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, ExecFileOptions } from "node:child_process";
import {
  resolveCurrentMuxContext,
  resolveCurrentMuxContextAsync,
} from "../src/multiplexer-current-context";
import { resolveMux } from "../src/multiplexer";

const { sync, exec } = vi.hoisted(() => ({
  sync: vi.fn(),
  exec: vi.fn<
    (
      command: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => ChildProcess
  >(),
}));
vi.mock("node:child_process", () => ({
  execFileSync: sync,
  execFile: exec,
}));

const env = {
  ZELLIJ: "0",
  ZELLIJ_SESSION_NAME: "work",
  ZELLIJ_PANE_ID: "4",
};
const modes = ["sync", "async"] as const;

function respond(command: string, args: readonly string[]): string {
  if (command === "ps") {
    return (
      "1 0 ? /sbin/init\n" +
      "2 1 ? tmux\n" +
      "3 2 ? zellij\n" +
      "4 3 pts/1 sh\n" +
      `${process.pid} 4 pts/1 node\n`
    );
  }
  if (command === "tmux" && args.includes("display-message")) {
    return "%1\t2\t/dev/pts/1\n";
  }
  if (command === "zellij" && args.includes("list-panes")) {
    return JSON.stringify([
      { id: 4, is_plugin: false, exited: false },
      { id: 999, is_plugin: false, exited: false },
    ]);
  }
  throw new Error(`Unexpected command: ${command}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  sync.mockImplementation(respond);
  exec.mockImplementation((command, args, _options, callback) => {
    queueMicrotask(() => callback(null, respond(command, args), ""));
    return {} as ChildProcess;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(modes)("%s Zellij ownership", (mode) => {
  async function resolve(observation: NodeJS.ProcessEnv) {
    return mode === "sync"
      ? resolveCurrentMuxContext(observation)
      : resolveCurrentMuxContextAsync(observation);
  }

  it.each([
    { name: "foreign session", ZELLIJ_SESSION_NAME: "other-session" },
    { name: "another live pane in the same session", ZELLIJ_PANE_ID: "999" },
  ])(
    "rejects inherited selectors for $name",
    async ({ name: _name, ...hints }) => {
      const result = await resolve({ ...env, ...hints });
      expect(result.kind).toBe("unavailable");
      expect(
        (mode === "sync" ? sync : exec).mock.calls.map(([command]) => command),
      ).toEqual(["ps", "zellij"]);
    },
  );

  it("does not fall through an unverified Zellij to a verified outer tmux", async () => {
    const result = await resolve({
      ...env,
      TMUX: "/tmp/outer.sock,2,0",
      TMUX_PANE: "%1",
    });
    expect(result.kind).toBe("unavailable");
  });
});

it("preserves explicit Zellij selection without claiming automatic ownership", () => {
  vi.stubEnv("ZELLIJ", env.ZELLIJ);
  vi.stubEnv("ZELLIJ_SESSION_NAME", env.ZELLIJ_SESSION_NAME);
  vi.stubEnv("ZELLIJ_PANE_ID", env.ZELLIJ_PANE_ID);
  expect(resolveMux({ preference: "zellij" }).context).toEqual({
    kind: "attached",
    mux: "zellij",
    session: "work",
    paneId: "4",
  });
  expect(sync).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});
