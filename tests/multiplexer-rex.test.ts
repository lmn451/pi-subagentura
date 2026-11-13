import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

const sessionId = "session:01234567-89ab-cdef-0123-456789abcdef";
const currentBlockId = "block:01234567-89ab-cdef-0123-456789abcdef";
const childBlockId = "block:11234567-89ab-cdef-0123-456789abcdef";
const server = "unix:///tmp/rex.sock";
const cliHelp =
  "--json --cwd --label --keep-open --shell --focus --split --block --session --trim enter";

interface RexCall {
  readonly file: string;
  readonly args: string[];
  readonly options?: Record<string, unknown>;
}

let originalEnvironment: NodeJS.ProcessEnv;
let blockListing: unknown;
let createOutput = JSON.stringify({ block_ids: [childBlockId] });
let captureOutput = "first\nlast";
let captureError: Error | undefined;

function setRexEnvironment(): void {
  process.env.REX_SESSION = sessionId;
  process.env.REX_BLOCK = currentBlockId;
  process.env.REX_SERVER = server;
  delete process.env.TERM_PROGRAM;
}

function installRexMock(): RexCall[] {
  const calls: RexCall[] = [];
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: (
      file: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ file, args: [...args], options });
      if (file === "/bin/sh") return "";
      if (args[0] === "help") return cliHelp;
      if (args.includes("whoami")) {
        return JSON.stringify({
          endpoint: server,
          session_id: sessionId,
          block_id: currentBlockId,
        });
      }
      if (args.includes("ls")) return JSON.stringify(blockListing);
      if (args.includes("run")) return createOutput;
      return "";
    },
    execFile: (
      file: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr?: string) => void,
    ) => {
      calls.push({ file, args: [...args], options });
      if (args.includes("capture")) {
        callback(captureError ?? null, captureError ? "" : captureOutput, "");
      } else if (args.includes("ls")) {
        callback(null, JSON.stringify(blockListing), "");
      } else {
        callback(null, "", "");
      }
    },
  }));
  return calls;
}

async function loadRex(): Promise<typeof import("../src/multiplexer-rex")> {
  return await importFresh<typeof import("../src/multiplexer-rex")>(
    "../src/multiplexer-rex",
  );
}

beforeEach(() => {
  originalEnvironment = { ...process.env };
  setRexEnvironment();
  blockListing = { blocks: [{ block_id: currentBlockId }] };
  createOutput = JSON.stringify({ block_ids: [childBlockId] });
  captureOutput = "first\nlast";
  captureError = undefined;
});

afterEach(() => {
  process.env = originalEnvironment;
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
});

describe("RexMultiplexer", () => {
  it("requires a live Rex context and the documented CLI command set", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    expect(new RexMultiplexer().isAvailable()).toBe(true);
    expect(calls.filter((call) => call.args[0] === "help")).toHaveLength(8);

    delete process.env.REX_SESSION;
    expect(new RexMultiplexer().isAvailable()).toBe(false);
  });

  it("creates a background block in the current Rex session and persists server identity", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    const created = new RexMultiplexer().createPane({
      name: "Review agent",
      cwd: "/workspace/project",
      background: true,
      windowName: "review-agent",
    });
    expect(created).toEqual({
      paneId: childBlockId,
      windowName: "review-agent",
      session: sessionId,
      server,
    });

    const run = calls.find(
      (call) => call.args[0] === "--server" && call.args.includes("run"),
    );
    expect(run?.args).toContain("--json");
    expect(run?.args).toContain("--focus=false");
    expect(run?.args).toContain("--keep-open");
    expect(run?.args).not.toContain("--shell=none");
    expect(run?.args).toContain("--cwd");
    expect(run?.args).toContain("/workspace/project");
    expect(run?.args.slice(-5)).toEqual([
      "--",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-i",
    ]);
    expect(run?.options?.timeout).toBe(10_000);
  });

  it("anchors visible Rex splits to the exact current block", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    new RexMultiplexer().createPane({
      name: "Review agent",
      cwd: "/workspace/project",
      background: false,
      parentPane: currentBlockId,
    });
    const run = calls.find(
      (call) => call.args[0] === "--server" && call.args.includes("run"),
    );
    expect(run?.args).toContain("--split=right");
    expect(run?.args).toContain("--block");
    expect(run?.args).toContain(currentBlockId);
  });

  it("sends literal text through stdin and targets the persisted server/session", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    const mux = new RexMultiplexer();
    mux.sendKeys(childBlockId, "-literal text\n", sessionId, server);
    mux.sendEnter(childBlockId, sessionId, server);
    const sends = calls.filter((call) => call.file === "rex");
    const textSend = sends.find((call) => call.args.includes("send"));
    expect(textSend?.args).toEqual([
      "--server",
      server,
      "send",
      "--block",
      childBlockId,
      "--session",
      sessionId,
    ]);
    expect(textSend?.options?.input).toBe("-literal text\n");
    expect(sends.some((call) => call.args.includes("send-key"))).toBe(true);
    expect(() => mux.sendKeys("-bad", "text", sessionId, server)).toThrow(
      /Invalid Rex block id/,
    );
  });

  it("uses tri-state liveness, but makes no undocumented activity claim", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    const mux = new RexMultiplexer();
    expect(mux.getPaneLiveness(currentBlockId, sessionId, server)).toBe(
      "alive",
    );
    blockListing = { blocks: [] };
    expect(mux.getPaneLiveness(childBlockId, sessionId, server)).toBe("dead");
    blockListing = { malformed: true };
    expect(mux.getPaneLiveness(childBlockId, sessionId, server)).toBe(
      "unknown",
    );
    await expect(
      mux.getPaneActivityAsync(currentBlockId, sessionId, server),
    ).resolves.toBe("unknown");
    expect(calls.some((call) => call.args.includes("client"))).toBe(false);
  });

  it("bounds capture by a hard subprocess buffer and fails closed on overflow", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    const mux = new RexMultiplexer();
    const ref = { paneId: childBlockId, session: sessionId, server };
    await expect(
      mux.capturePane(ref, { maxBytes: 64, maxLines: 1 }),
    ).resolves.toEqual({ output: "last", truncated: true });
    const capture = calls.find((call) => call.args.includes("capture"));
    expect(capture?.args).toContain("--trim");
    expect(capture?.options?.maxBuffer).toBe(1024 * 1024);
    expect(capture?.options?.timeout).toBe(5_000);

    captureError = new Error("maxBuffer exceeded");
    await expect(
      mux.capturePane(ref, { maxBytes: 64, maxLines: 1 }),
    ).rejects.toThrow(/safe read bound/);
  });

  it("focuses and builds attach commands from persisted server-scoped IDs", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    const mux = new RexMultiplexer();
    const ref = { paneId: childBlockId, session: sessionId, server };
    await expect(mux.focusPane(ref)).resolves.toBeUndefined();
    expect(mux.buildAttachCommands(ref)).toEqual({
      attachCommand: `rex --server '${server}' focus '${childBlockId}' --session '${sessionId}'`,
      focusCommand: `rex --server '${server}' focus '${childBlockId}' --session '${sessionId}'`,
    });
    expect(calls.some((call) => call.args.includes("focus"))).toBe(true);
    expect(() =>
      mux.buildAttachCommands({ paneId: childBlockId, session: sessionId }),
    ).toThrow(/missing its validated server\/session identity/);
  });

  it("closes a Rex block best-effort through the public CLI", async () => {
    const calls = installRexMock();
    const { RexMultiplexer } = await loadRex();
    new RexMultiplexer().killPane(childBlockId, sessionId, server);
    expect(
      calls.some(
        (call) =>
          call.args.includes("close") && call.args.includes(childBlockId),
      ),
    ).toBe(true);
  });
});
