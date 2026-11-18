import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFresh } from "./test-utils";

const parentAddress = "t1";
const childAddress = "t2";
const childName = "pi-0123456789abcdef";
const server = "/tmp/herdr-core-test.sock";
const context = {
  kind: "attached",
  mux: "herdr-core",
  paneId: parentAddress,
  server,
} as const;

interface CoreCall {
  readonly file: string;
  readonly args: string[];
  readonly options?: Record<string, unknown>;
}

let originalEnvironment: NodeJS.ProcessEnv;
let socketIsSocket = true;
let runOutput = JSON.stringify({
  address: childAddress,
  name: childName,
  state: "live",
});
let runError: Error | undefined;
let syncGetOutput = JSON.stringify({
  address: childAddress,
  name: childName,
  pid: 1234,
  state: "live",
});
let syncGetError: Error | undefined;
let asyncGetOutput = syncGetOutput;
let asyncGetError: Error | undefined;
let readOutput = JSON.stringify({
  complete: true,
  how: "history",
  text: "full",
});
let readError: Error | undefined;

function setCoreEnvironment(): void {
  process.env.HC_TERMINAL_ID = parentAddress;
  process.env.HC_TERMINAL_SOCKET = server;
  delete process.env.HC_SOCKET;
}

function installCoreMock(): CoreCall[] {
  const calls: CoreCall[] = [];
  vi.resetModules();
  vi.doMock("node:fs", () => ({
    statSync: vi.fn(() => ({ isSocket: () => socketIsSocket })),
  }));
  vi.doMock("node:child_process", () => ({
    execFileSync: (
      file: string,
      args: string[],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ file, args: [...args], options });
      if (args[0] === "run") {
        if (runError) throw runError;
        const name = args[args.indexOf("--name") + 1] ?? "";
        return runOutput.replaceAll(childName, name);
      }
      if (args[0] === "get") {
        if (syncGetError) throw syncGetError;
        return syncGetOutput;
      }
      return "";
    },
    execFile: (
      file: string,
      args: string[],
      options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string, stderr?: string) => void,
    ) => {
      calls.push({ file, args: [...args], options });
      if (args[0] === "get") {
        callback(
          asyncGetError ?? null,
          asyncGetError ? "" : asyncGetOutput,
          "",
        );
      } else if (args[0] === "read") {
        callback(readError ?? null, readError ? "" : readOutput, "");
      } else {
        callback(null, "", "");
      }
    },
  }));
  return calls;
}

async function loadCore(): Promise<
  typeof import("../src/multiplexer-herdr-core")
> {
  return importFresh<typeof import("../src/multiplexer-herdr-core")>(
    "../src/multiplexer-herdr-core",
  );
}

function cliError(status: number, output: string): Error {
  return Object.assign(new Error("hc command failed"), {
    status,
    stdout: output,
  });
}

beforeEach(() => {
  originalEnvironment = { ...process.env };
  setCoreEnvironment();
  socketIsSocket = true;
  runOutput = JSON.stringify({
    address: childAddress,
    name: childName,
    state: "live",
  });
  runError = undefined;
  syncGetOutput = JSON.stringify({
    address: childAddress,
    name: childName,
    pid: 1234,
    state: "live",
  });
  syncGetError = undefined;
  asyncGetOutput = syncGetOutput;
  asyncGetError = undefined;
  readOutput = JSON.stringify({ complete: true, how: "history", text: "full" });
  readError = undefined;
});

afterEach(() => {
  process.env = originalEnvironment;
  vi.doUnmock("node:fs");
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
});

describe("HerdrCoreMultiplexer", () => {
  it("launches only pinned detached children and rejects visible split requests", async () => {
    const calls = installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();

    expect(
      mux.createPane({
        context,
        name: "Review agent",
        cwd: "/workspace/project",
        background: true,
        id: "0123456789abcdef",
      }),
    ).toEqual({ paneId: childName, server });

    const run = calls.find((call) => call.args[0] === "run");
    expect(run?.file).toBe("hc");
    expect(run?.args).toEqual([
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--name",
      childName,
      "--cwd",
      "/workspace/project",
      "--json",
      "--",
      "/bin/sh",
      "-i",
    ]);
    expect(run?.options?.env).toMatchObject({ HC_SOCKET: server });
    expect(run?.options?.timeout).toBe(10_000);
    expect(run?.options?.maxBuffer).toBe(256 * 1024);

    expect(() =>
      mux.createPane({
        context,
        name: "Visible agent",
        cwd: "/workspace/project",
        background: false,
      }),
    ).toThrow(/detached children only/);
    expect(calls.filter((call) => call.args[0] === "run")).toHaveLength(1);
  });
  it("rejects mismatched run identity and cleans up only its requested name", async () => {
    const calls = installCoreMock();
    runOutput = JSON.stringify({
      address: "t3",
      name: "pi-ffffffffffffffff",
      state: "live",
    });
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();

    expect(() =>
      mux.createPane({
        context,
        name: "Review agent",
        cwd: "/workspace/project",
        background: true,
        id: "0123456789abcdef",
      }),
    ).toThrow(/did not return the requested live terminal/);
    expect(calls.find((call) => call.args[0] === "kill")?.args).toEqual([
      "kill",
      "--json",
      "--",
      childName,
    ]);
  });

  it("uses a random 16-hex name when the caller omits its id", async () => {
    const calls = installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const created = new HerdrCoreMultiplexer().createPane({
      context,
      name: "Review agent",
      cwd: "/workspace/project",
      background: true,
    });
    expect(created.paneId).toMatch(/^pi-[a-f0-9]{16}$/);
    expect(calls.find((call) => call.args[0] === "run")?.args).toContain(
      created.paneId,
    );
  });

  it("checks live, finished, explicit not-found, and unknown liveness", async () => {
    installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();

    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("alive");
    syncGetOutput = JSON.stringify({
      address: childAddress,
      name: childName,
      pid: 1234,
      state: "finished",
    });
    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("dead");

    syncGetError = cliError(
      3,
      JSON.stringify({ error: { kind: "not_found" } }),
    );
    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("dead");
    syncGetError = cliError(
      1,
      JSON.stringify({ error: { kind: "unavailable" } }),
    );
    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("unknown");
    syncGetError = undefined;
    syncGetOutput = "not json";
    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("unknown");

    asyncGetOutput = JSON.stringify({
      address: childAddress,
      name: childName,
      state: "finished",
    });
    await expect(
      mux.getPaneLivenessAsync(childName, undefined, server),
    ).resolves.toBe("dead");
    asyncGetError = cliError(3, JSON.stringify({ kind: "not_found" }));
    await expect(
      mux.getPaneLivenessAsync(childName, undefined, server),
    ).resolves.toBe("dead");
    asyncGetError = new Error("transport failed");
    await expect(
      mux.getPaneLivenessAsync(childName, undefined, server),
    ).resolves.toBe("unknown");
  });

  it("sends model text atomically and routes every command through the saved socket", async () => {
    const calls = installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();
    const text = "--literal 'text'\nsecond line\n";

    mux.sendCommand(childName, text, undefined, server);
    mux.killPane(childName, undefined, server);

    const send = calls.find((call) => call.args[0] === "send");
    expect(send?.args).toEqual(["send", "--json", "--", childName, text]);
    expect(send?.options?.env).toMatchObject({ HC_SOCKET: server });
    expect(send?.args).not.toContain("--force");
    expect(calls.find((call) => call.args[0] === "kill")?.args).toEqual([
      "kill",
      "--json",
      "--",
      childName,
    ]);
    await expect(
      mux.getPaneActivityAsync(childName, undefined, server),
    ).resolves.toBe("unknown");
    await expect(mux.showNativeViewer("Supervisor", "summary")).resolves.toBe(
      false,
    );
    await expect(mux.focusPane({ paneId: childName, server })).rejects.toThrow(
      /does not support programmatic focus/,
    );
  });

  it("bounds capture and preserves Core's incomplete-history signal", async () => {
    const calls = installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();

    readOutput = JSON.stringify({
      complete: false,
      how: "history",
      text: "first\nlast",
    });
    await expect(
      mux.capturePane(
        { paneId: childName, server },
        { maxBytes: 64, maxLines: 1 },
      ),
    ).resolves.toEqual({ output: "last", truncated: true });

    readOutput = JSON.stringify({
      complete: false,
      how: "history",
      text: "full",
    });
    await expect(
      mux.capturePane(
        { paneId: childName, server },
        { maxBytes: 64, maxLines: 10 },
      ),
    ).resolves.toEqual({ output: "full", truncated: true });
    readOutput = JSON.stringify({
      complete: true,
      how: "history",
      text: "full",
    });
    await expect(
      mux.capturePane(
        { paneId: childName, server },
        { maxBytes: 3, maxLines: 10 },
      ),
    ).resolves.toEqual({ output: "ull", truncated: true });
    const read = calls.filter((call) => call.args[0] === "read").at(-1);
    expect(read?.args).toEqual([
      "read",
      "--json",
      "--lines",
      "10",
      "--",
      childName,
    ]);
    expect(read?.options?.maxBuffer).toBe(1024 * 1024 * 6 + 64 * 1024);
    expect(read?.options?.timeout).toBe(5_000);
    expect(read?.options?.env).toMatchObject({ HC_SOCKET: server });
  });

  it("builds a shell-safe pinned attach command without inventing focus", async () => {
    installCoreMock();
    const { HerdrCoreMultiplexer } = await loadCore();
    const commands = new HerdrCoreMultiplexer().buildAttachCommands({
      paneId: childName,
      server: "/tmp/core socket.sock",
    });
    expect(commands).toEqual({
      attachCommand: `HC_SOCKET='/tmp/core socket.sock' hc attach '${childName}'`,
      focusCommand: "",
    });
  });

  it("never contacts hc when the saved socket is not a Unix socket", async () => {
    const calls = installCoreMock();
    socketIsSocket = false;
    const { HerdrCoreMultiplexer } = await loadCore();
    const mux = new HerdrCoreMultiplexer();

    expect(mux.getPaneLiveness(childName, undefined, server)).toBe("unknown");
    expect(() =>
      mux.createPane({
        context,
        name: "Review agent",
        cwd: "/workspace/project",
        background: true,
      }),
    ).toThrow(/refusing to contact the default Core/);
    expect(() =>
      mux.sendCommand(childName, "hello", undefined, server),
    ).toThrow(/refusing to contact the default Core/);
    expect(calls).toHaveLength(0);
  });
});
