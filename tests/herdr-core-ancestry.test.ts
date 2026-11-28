import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resolveCurrentMuxContext,
  resolveCurrentMuxContextAsync,
} from "../src/multiplexer-current-context";

type Query = (
  file: string,
  args: string[],
  options: { timeout: number },
) => string;
const { query } = vi.hoisted(() => ({ query: vi.fn<Query>() }));
vi.mock("node:child_process", () => ({
  execFileSync: query,
  execFile: (
    file: string,
    args: string[],
    options: { timeout: number },
    reply: (error: unknown, output: string) => void,
  ) => {
    try {
      reply(null, query(file, args, options));
    } catch (error) {
      reply(error, "");
    }
    return { stdin: { end() {} } };
  },
}));
// Isolate process and host observations from the developer's socket and environment.
vi.mock("../src/multiplexer-herdr-core", async (original) => ({
  ...(await original<typeof import("../src/multiplexer-herdr-core")>()),
  herdrCoreEnv: (_socket: string, env: NodeJS.ProcessEnv) => env,
}));
const env = {
  HC_TERMINAL_ID: "t1",
  HC_TERMINAL_SOCKET: "/tmp/synthetic-core.sock",
};
const self = process.pid;
const shell = self + 1;
const server = self + 2;
const pids = `${self},${shell},${server},1`;
const links = `${self} ${shell}\n${shell} ${server}\n${server} 1\n1 0\n`;
const details = `${self} ${shell} ttys001 pi\n${shell} ${server} ttys001 sh\n${server} 1 ?? hc\n1 0 ?? launchd\n`;
const ancestryFailure = {
  kind: "unavailable",
  message:
    "Herdr Core context is unavailable: process ancestry unavailable; refusing to guess. Use an explicit mux preference to override.",
};
const ownershipFailure = {
  kind: "unavailable",
  message:
    "Herdr Core context is unavailable: host ownership not verified; refusing to guess. Use an explicit mux preference to override.",
};
let graph: string;
let snapshot: string;
let reportPid: number;
let now: number;
let linkTime: number;
let detailTime: number;
let hostError: boolean;

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  graph = links + `${self + 3} 1\n`;
  snapshot = details;
  reportPid = shell;
  now = 0;
  linkTime = 0;
  detailTime = 0;
  hostError = false;
  query.mockReset().mockImplementation((file, args) => {
    if (file === "hc" && !hostError)
      return JSON.stringify({ address: "t1", state: "live", pid: reportPid });
    if (file === "ps" && args.join(" ") === "-axo pid=,ppid=") {
      now += linkTime;
      return graph;
    }
    if (
      file === "ps" &&
      args.join(" ") === `-p ${pids} -o pid=,ppid=,tty=,comm=`
    ) {
      now += detailTime;
      return snapshot;
    }
    throw new Error("private subprocess diagnostic");
  });
});
afterEach(() => vi.restoreAllMocks());

for (const resolve of [
  resolveCurrentMuxContext,
  resolveCurrentMuxContextAsync,
]) {
  it(`${resolve.name}: queries details only for the validated chain and verifies the host`, async () => {
    // ps does not have to return selected rows in ancestry order.
    snapshot = details.trimEnd().split("\n").reverse().join("\n") + "\n";
    expect(await resolve(env)).toMatchObject({
      kind: "ready",
      target: { mux: "herdr-core", paneId: "t1" },
    });
    expect(query.mock.calls.map(([file]) => file)).toEqual(["ps", "ps", "hc"]);
  });

  it.each([
    ["cycle", links.replace(`${server} 1`, `${server} ${self}`)],
    ["missing parent", links.replace(`${server} 1\n`, "")],
    ["premature root", links.replace(`${server} 1`, `${server} 0`)],
    ["duplicate PID", links + `${server} 1\n`],
    ["unsafe PID", links + "9007199254740992 1\n"],
    ["negative PID", links + "-9 1\n"],
    ["truncated row", links.trimEnd()],
    ["too many records", links + "9 1\n".repeat(8192)],
    [
      "too many ancestors",
      Array.from(
        { length: 66 },
        (_, i) => `${self + i} ${self + i + 1}\n`,
      ).join("") + `${self + 66} 1\n1 0\n`,
    ],
  ])(
    `${resolve.name}: rejects a %s in process links`,
    async (_label, invalid) => {
      graph = invalid;
      expect(await resolve(env)).toEqual(ancestryFailure);
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "reparented caller",
      details.replace(`${self} ${shell}`, `${self} ${server}`),
    ],
    [
      "reparented ancestor",
      details.replace(`${shell} ${server}`, `${shell} 1`),
    ],
    [
      "same PIDs with different parents",
      `${self} ${server} ttys001 pi\n${server} ${shell} ttys001 sh\n${shell} 1 ?? hc\n1 0 ?? launchd\n`,
    ],
    ["missing detail", details.replace(`${shell} ${server} ttys001 sh\n`, "")],
    ["malformed tty", details.replace("ttys001", "../tty")],
    ["unexpected row", details + `${self + 3} 1 ?? sh\n`],
  ])(
    `${resolve.name}: rejects %s before any host check`,
    async (_label, invalid) => {
      snapshot = invalid;
      expect(await resolve(env)).toEqual(ancestryFailure);
      expect(query).toHaveBeenCalledTimes(2);
    },
  );

  it(`${resolve.name}: refuses a live host with an unrelated PID`, async () => {
    reportPid = self + 3;
    expect(await resolve(env)).toEqual(ownershipFailure);
    expect(query.mock.calls.at(-1)?.[0]).toBe("hc");
  });
  it(`${resolve.name}: refuses an outer shell beyond a nearer mux`, async () => {
    snapshot = details
      .replace("ttys001 sh", "ttys001 tmux")
      .replace("?? hc", "ttys002 sh");
    reportPid = server;
    expect(await resolve(env)).toEqual(ownershipFailure);
  });
  it(`${resolve.name}: reports host verification failure without exposing subprocess text`, async () => {
    hostError = true;
    expect(await resolve(env)).toEqual(ownershipFailure);
  });
  it.each([1, 2])(
    `${resolve.name}: fails closed when process read %d times out`,
    async (failedRead) => {
      if (failedRead === 2) query.mockReturnValueOnce(graph);
      query.mockImplementationOnce(() => {
        throw Object.assign(new Error("private process diagnostic"), {
          code: "ETIMEDOUT",
        });
      });
      expect(await resolve(env)).toEqual(ancestryFailure);
      expect(query).toHaveBeenCalledTimes(failedRead);
    },
  );
  it(`${resolve.name}: deducts time spent in the first read`, async () => {
    linkTime = 1211;
    expect((await resolve(env)).kind).toBe("ready");
    expect(
      query.mock.calls.slice(0, 2).map(([, , options]) => options.timeout),
    ).toEqual([1500, 289]);
  });
  it.each([
    [1500, 0, 1],
    [1200, 301, 2],
  ])(
    `${resolve.name}: refuses late process evidence (%d + %d ms)`,
    async (first, second, calls) => {
      linkTime = first;
      detailTime = second;
      expect(await resolve(env)).toEqual(ancestryFailure);
      expect(query).toHaveBeenCalledTimes(calls);
    },
  );
  it(`${resolve.name}: uses only selected PIDs on Linux`, async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    for (const row of links.trim().split("\n"))
      query.mockReturnValueOnce(row + "\n");
    expect((await resolve(env)).kind).toBe("ready");
    expect(query.mock.calls.slice(0, 4).map(([, args]) => args)).toEqual(
      pids.split(",").map((pid) => ["-p", pid, "-o", "pid=,ppid="]),
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("hc");
  });
  it(`${resolve.name}: keeps incomplete Core markers unavailable`, async () => {
    query.mockReturnValueOnce(details);
    expect(
      await resolve({ HC_TERMINAL_SOCKET: env.HC_TERMINAL_SOCKET }),
    ).toEqual(ownershipFailure);
    expect(query.mock.calls[0]?.[1]).toEqual(["-axo", "pid=,ppid=,tty=,comm="]);
    expect(query).toHaveBeenCalledTimes(1);
  });
}
