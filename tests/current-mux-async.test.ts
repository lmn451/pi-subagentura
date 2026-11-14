import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { resolveCurrentMuxContextAsync } from "../src/multiplexer-current-context";
import { readProcessContextAsync } from "../src/multiplexer-process-context";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
const env = {
  TMUX: "/tmp/test-tmux.sock,80,0",
  TMUX_PANE: "%4",
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/tmp/test-herdr.sock",
  HERDR_PANE_ID: "w1:p2",
};
type Reply = (error: Error | null, output: string, stderr: string) => void;
let pending: { file: string; args: readonly string[]; reply: Reply }[];
const table = `${process.pid} 101 pts/2 node\n101 100 pts/2 sh\n100 1 ? tmux\n1 0 ? init\n`;

beforeEach(() => {
  vi.resetAllMocks();
  pending = [];
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error("sync discovery blocks Pi");
  });
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: readonly string[],
    _options: object,
    reply: Reply,
  ) => {
    pending.push({ file, args, reply });
    return { stdin: { end: vi.fn() } };
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("asynchronous current mux discovery", () => {
  it("keeps the event loop responsive while process inspection is pending", async () => {
    const result = readProcessContextAsync();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pending.map(({ file }) => file)).toEqual(["ps"]);
    expect(execFileSync).not.toHaveBeenCalled();
    pending.shift()!.reply(null, table, "");
    await expect(result).resolves.toMatchObject({ pid: process.pid });
  });

  it("probes inherited backends concurrently without synchronous execution", async () => {
    const result = resolveCurrentMuxContextAsync(env);
    pending.shift()!.reply(null, table, "");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pending.map(({ file }) => file).sort()).toEqual(["herdr", "tmux"]);
    const tmux = pending.find(({ file }) => file === "tmux")!;
    const herdr = pending.find(({ file }) => file === "herdr")!;
    tmux.reply(null, "%4\t101\t/dev/pts/2\n", "");
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    herdr.reply(new Error("timeout"), "", "");
    await expect(result).resolves.toMatchObject({
      kind: "ready",
      target: { mux: "tmux", paneId: "%4" },
    });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("has the same fail-closed behavior for failed or malformed process reads", async () => {
    const failed = resolveCurrentMuxContextAsync(env);
    pending.shift()!.reply(new Error("timeout"), "", "");
    await expect(failed).resolves.toMatchObject({ kind: "unavailable" });
    const malformed = readProcessContextAsync();
    pending.shift()!.reply(null, "not a process table\n", "");
    await expect(malformed).resolves.toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not start discovery for detached contexts", async () => {
    await expect(resolveCurrentMuxContextAsync({})).resolves.toEqual({
      kind: "absent",
    });
    expect(execFile).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
