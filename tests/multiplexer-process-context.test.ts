import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  closestMuxAncestor,
  normalizeProcessTty,
  readProcessContext,
} from "../src/multiplexer-process-context";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const probe = vi.mocked(execFileSync);
const table =
  "1 0 ? /sbin/init\n10 1 ?? /usr/bin/tmux: server\n20 10 pts/2 /bin/zellij\n30 20 /dev/ttys003 /bin/node\n40 1 - /bin/herdr\n";

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  probe.mockReturnValue(table);
});
afterEach(() => vi.restoreAllMocks());

describe("normalizeProcessTty", () => {
  it.each(["ttys003", "pts/2", "tty1", "/dev/pts/2", "/dev/ttys003"])(
    "normalizes %s",
    (value) => {
      expect(normalizeProcessTty(value)).toBe(value.replace(/^\/dev\//, ""));
    },
  );
  it.each([
    undefined,
    null,
    42,
    "",
    "?",
    "??",
    "-",
    "../pts/2",
    "/tmp/tty",
    "pts//2",
    "pts/../2",
    "tty\n1",
    "tty\u001b1",
    "tty 1",
    "x".repeat(129),
  ])("rejects unsafe tty %s", (value) => {
    expect(normalizeProcessTty(value)).toBeUndefined();
  });
});

describe("readProcessContext", () => {
  it.each(["linux", "darwin"] as const)(
    "reads bounded comm-only evidence on %s",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const context = readProcessContext(30)!;
      expect(context.pid).toBe(30);
      expect(context.ancestors.map((entry) => entry.pid)).toEqual([20, 10, 1]);
      expect(context.processes.get(30)?.tty).toBe("ttys003");
      expect(context.processes.get(20)?.tty).toBe("pts/2");
      expect(context.processes.get(1)?.tty).toBeUndefined();
      expect(probe).toHaveBeenLastCalledWith(
        "ps",
        ["-axo", "pid=,ppid=,tty=,comm="],
        {
          encoding: "utf8",
          timeout: 1500,
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          shell: false,
        },
      );
    },
  );
  it("defaults to the current pid", () => {
    probe.mockReturnValue(`1 0 ? init\n${process.pid} 1 ? node\n`);
    expect(readProcessContext()?.pid).toBe(process.pid);
  });
  it("does not probe unsupported platforms or invalid pids", () => {
    probe.mockClear();
    expect(readProcessContext(0)).toBeUndefined();
    expect(readProcessContext(NaN)).toBeUndefined();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(readProcessContext(30)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
  it.each([
    "",
    table.trimEnd(),
    table + "broken\n",
    table + "30 1 ? node\n",
    table.replace("20 10", "20 30"),
    table.replace("20 10", "20 999"),
    table.replace("20 10", "20 20"),
    table.replace("30 20", "9007199254740992 20"),
    table.replace("pts/2", "../bad"),
    table.replace("/bin/node", "node\u001b"),
    "x".repeat(1024 * 1024 + 1) + "\n",
    Array.from({ length: 8193 }, (_, i) => `${i + 1} 0 ? init\n`).join(""),
    Array.from({ length: 67 }, (_, i) => `${i + 1} ${i} ? node\n`).join(""),
  ])("fails closed for malformed or incomplete evidence %#", (output) => {
    probe.mockReturnValue(output);
    expect(
      readProcessContext(output.startsWith("1 0 ? node") ? 67 : 30),
    ).toBeUndefined();
  });
  it("accepts exactly 8192 records and 64 ancestor links", () => {
    probe.mockReturnValue(
      Array.from(
        { length: 8192 },
        (_, i) => `${i + 1} ${i < 65 ? i : 0} ? node\n`,
      ).join(""),
    );
    const context = readProcessContext(65)!;
    expect(context.processes.size).toBe(8192);
    expect(context.ancestors).toHaveLength(64);
    expect(readProcessContext(66)?.ancestors).toHaveLength(0);
  });
  it("fails closed when the target is missing", () => {
    expect(readProcessContext(999)).toBeUndefined();
  });
  it.each(["timeout", "ENOBUFS", "ENOENT", "nonzero exit"])(
    "fails closed on %s",
    (message) => {
      probe.mockImplementationOnce(() => {
        throw new Error(message);
      });
      expect(readProcessContext(30)).toBeUndefined();
    },
  );
});

describe("closestMuxAncestor", () => {
  it("selects zellij inside tmux and ignores unrelated herdr", () => {
    expect(closestMuxAncestor(readProcessContext(30)!)).toEqual({
      mux: "zellij",
      pid: 20,
    });
  });
  it("selects tmux inside zellij", () => {
    probe.mockReturnValue(
      table
        .replace("/usr/bin/tmux: server", "/bin/zellij")
        .replace("/bin/zellij\n30", "/bin/tmux: server\n30"),
    );
    expect(closestMuxAncestor(readProcessContext(30)!)).toEqual({
      mux: "tmux",
      pid: 20,
    });
  });
  it.each([
    ["tmux", "tmux"],
    ["tmux: server", "tmux"],
    ["zellij", "zellij"],
    ["herdr", "herdr"],
    ["rex", "rex"],
    ["Rex", "rex"],
  ])("recognizes exact basename %s", (command, mux) => {
    probe.mockReturnValue(
      `1 0 ? init\n20 1 ? /Applications/${command}\n30 20 ? node\n`,
    );
    expect(closestMuxAncestor(readProcessContext(30)!)).toEqual({
      mux,
      pid: 20,
    });
  });
  it.each([
    "tmux-client",
    "notzellij",
    "herdr-helper",
    "Rex Helper",
    "TMUX",
    "tmux -L secret",
  ])("does not match %s", (command) => {
    probe.mockReturnValue(
      `1 0 ? init\n20 1 ? ${command}\n30 20 ? node\n40 1 ? tmux\n`,
    );
    expect(closestMuxAncestor(readProcessContext(30)!)).toBeUndefined();
  });
});
