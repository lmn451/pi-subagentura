import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Needs neither tmux nor Pi, so it lives in the normal unit suite and runs on
// every `npm test` rather than only under `test:tui`.
const guard = fileURLToPath(
  new URL("./terminal-e2e/fixtures/deny-network.cjs", import.meta.url),
);
const temporaryRoots: string[] = [];
type GuardedChildCompletion = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | undefined;
  stderr: string;
  records: unknown[];
  recordError: Error | undefined;
};
const activeChildren = new Map<ChildProcess, Promise<GuardedChildCompletion>>();

const escapePaths = [
  {
    name: "fetch",
    source:
      'fetch("http://127.0.0.1:9").then(() => process.exit(0), () => process.exit(7))',
    kind: "fetch",
  },
  {
    name: "net socket prototype",
    source: 'new (require("node:net").Socket)().connect(9, "127.0.0.1")',
    kind: "node:net.Socket.connect",
  },
  {
    name: "UDP",
    source:
      'require("node:dgram").createSocket("udp4").send("x", 9, "127.0.0.1")',
    kind: "node:dgram.createSocket",
  },
  {
    name: "DNS",
    source: 'require("node:dns").lookup("localhost", () => {})',
    kind: "node:dns.lookup",
  },
  {
    name: "HTTP/2",
    source: 'require("node:http2").connect("http://127.0.0.1:9")',
    kind: "node:http2.connect",
  },
  {
    name: "HTTP",
    source: 'require("node:http").request("http://127.0.0.1:9")',
    kind: "node:http.request",
  },
];

afterEach(async () => {
  const children = [...activeChildren.entries()];
  for (const [child] of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }
  await Promise.all(children.map(([, completion]) => completion));
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runGuarded(source: string) {
  const root = mkdtempSync(join(tmpdir(), "subagentura-network-guard-"));
  const log = join(root, "network.ndjson");
  temporaryRoots.push(root);

  const child = spawn(
    process.execPath,
    ["--require", guard, "--eval", source],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, SUBAGENTURA_E2E_NETWORK_LOG: log },
    },
  );
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data: string) => {
    stderr += data;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const completion = new Promise<GuardedChildCompletion>((resolve) => {
    child.once("close", (status, signal) => {
      let records: unknown[] = [];
      let recordError: Error | undefined;
      try {
        records = existsSync(log)
          ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as unknown)
          : [];
      } catch (error) {
        recordError = error instanceof Error ? error : new Error(String(error));
      }
      resolve({
        status,
        signal,
        error: spawnError,
        stderr,
        records,
        recordError,
      });
    });
  });
  activeChildren.set(child, completion);
  try {
    const result = await completion;
    const details = [
      result.error?.message,
      result.signal && `signal ${result.signal}`,
      result.status === null && "no process exit status",
      result.recordError?.message,
      result.stderr.trim() && `stderr:\n${result.stderr.trim()}`,
    ].filter(Boolean);
    if (
      result.error ||
      result.status === null ||
      result.signal !== null ||
      result.recordError
    ) {
      throw new Error(
        `Network guard subprocess did not complete cleanly: ${details.join("\n")}`,
      );
    }
    return { result, records: result.records };
  } finally {
    activeChildren.delete(child);
  }
}

describe("terminal E2E network guard", () => {
  it.each(escapePaths)(
    "denies $name before transport",
    async ({ source, kind }) => {
      const { result, records } = await runGuarded(source);

      expect(result.status).not.toBe(0);
      expect(records).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind })]),
      );
    },
  );

  it("records that it armed, so an empty log cannot pass vacuously", async () => {
    const { result, records } = await runGuarded("process.exit(0)");

    expect(result.status).toBe(0);
    expect(records).toEqual([
      expect.objectContaining({ kind: "armed", pid: expect.any(Number) }),
    ]);
  });

  it("labels a UNIX socket attempt local so it cannot read as egress", async () => {
    const { result, records } = await runGuarded(
      'require("node:net").connect("/tmp/subagentura-e2e-absent.sock")',
    );

    expect(result.status).not.toBe(0);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "node:net.connect", scope: "local" }),
      ]),
    );
  });
});
