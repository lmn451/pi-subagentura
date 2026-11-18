import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHerdrCore } from "../src/herdr-core-rpc.mjs";

let server: Server;
let directory: string;
const sockets = new Set<Socket>();
async function host(onConnection: (socket: Socket) => void): Promise<string> {
  mkdirSync(".context", { recursive: true });
  directory = mkdtempSync(resolve(".context/hcr-"));
  const path = join(directory, "s");
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      /* Closed test clients can race a fixture write. */
    });
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(path, done);
  });
  return path;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy();
  if (server?.listening)
    await new Promise<void>((done) => server.close(() => done()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function frame(
  channel: number,
  kind: number,
  payload = Buffer.alloc(0),
): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header[4] = kind;
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

describe("herdr-core wire transport", () => {
  it("preserves multibyte text across the synchronous worker's stdin chunks", async () => {
    const text = "世界👋".repeat(40_000);
    const path = await host((socket) => {
      let request = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        request += chunk;
        if (!request.endsWith("\n")) return;
        const parsed = JSON.parse(request);
        socket.end(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: parsed.params }) +
            "\n",
        );
      });
    });
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/herdr-core-rpc.mjs", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    let result = "";
    child.stdout.on("data", (chunk) => {
      result += chunk;
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    child.stdin.end(
      JSON.stringify({
        server: path,
        method: "terminal.get",
        params: { text },
      }),
    );
    expect(await exited).toBe(0);
    expect(JSON.parse(result).result.text).toBe(text);
  });

  it("reads fragmented JSON", async () => {
    const path = await host((socket) =>
      socket.once("data", () => {
        socket.write('{"jsonrpc":"2.0","id":1,"result":{"address":"t1",');
        socket.end('"state":"live"}}\n');
      }),
    );
    expect(
      await requestHerdrCore(path, "terminal.get", { terminal: "t1" }),
    ).toEqual({ address: "t1", state: "live" });
  });

  it.each([
    [
      '{"jsonrpc":"2.0","id":1,"error":{"data":{"kind":"not_found"}}}\n',
      "not_found",
    ],
    ['{"jsonrpc":"2.0","id":2,"result":{}}\n', undefined],
    ['{"jsonrpc":"2.0","id":1,"result":', undefined],
    ["not json\n", undefined],
  ])(
    "rejects error, mismatched, malformed and truncated replies",
    async (reply, kind) => {
      const path = await host((socket) =>
        socket.once("data", () => socket.end(reply)),
      );
      const result = requestHerdrCore(path, "terminal.get", { terminal: "t1" });
      if (kind) await expect(result).rejects.toMatchObject({ kind });
      else await expect(result).rejects.toBeInstanceOf(Error);
    },
  );

  it("sends exact Unicode bytes on the negotiated channel and waits for CLOSE", async () => {
    const text = "hello\n'世界' 👋\r";
    let received = Buffer.alloc(0);
    let stage = "hello";
    const path = await host((socket) =>
      socket.on("data", (chunk) => {
        const data = Buffer.from(chunk);
        if (stage === "hello") {
          expect(JSON.parse(data.toString()).params).toEqual({
            generation: 1,
            framed: true,
          });
          stage = "attach";
          socket.write(
            '{"jsonrpc":"2.0","id":1,"result":{"generation":1,"framed":true}}\n',
          );
        } else if (stage === "attach") {
          expect(data.readUInt32LE(0)).toBe(0);
          expect(JSON.parse(data.subarray(9).toString()).method).toBe(
            "terminal.attach",
          );
          stage = "input";
          const reply = frame(
            0,
            0,
            Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"channel":7}}'),
          );
          socket.write(reply.subarray(0, 5));
          socket.write(reply.subarray(5));
        } else {
          received = Buffer.concat([received, data]);
          const length = Buffer.byteLength(text);
          if (received.length < 18 + length) return;
          expect(received.subarray(0, 9)).toEqual(
            frame(7, 0, Buffer.from(text)).subarray(0, 9),
          );
          expect(received.subarray(9, 9 + length).toString()).toBe(text);
          expect(received.subarray(9 + length)).toEqual(frame(7, 2));
          socket.end(frame(7, 2));
        }
      }),
    );
    await expect(
      requestHerdrCore(
        path,
        "terminal.attach",
        { terminal: "t1", cols: 80, rows: 24 },
        text,
      ),
    ).resolves.toEqual({});
  });

  it("rejects an oversized input before connecting", async () => {
    await expect(
      requestHerdrCore(
        "/no/socket",
        "terminal.attach",
        {},
        "世".repeat(400_000),
      ),
    ).rejects.toThrow("Invalid");
  });

  it("rejects an oversized declared frame before allocating its payload", async () => {
    const path = await host((socket) =>
      socket.once("data", () => {
        socket.write(
          '{"jsonrpc":"2.0","id":1,"result":{"generation":1,"framed":true}}\n',
        );
        socket.once("data", () => {
          const header = frame(0, 0);
          header.writeUInt32LE(6 * 1024 * 1024 + 1, 5);
          socket.end(header);
        });
      }),
    );
    await expect(
      requestHerdrCore(
        path,
        "terminal.attach",
        { terminal: "t1", cols: 80, rows: 24 },
        "hello",
      ),
    ).rejects.toThrow("exceeds limit");
  });

  it("times out a silent core", async () => {
    const path = await host(() => {});
    vi.useFakeTimers();
    const pending = expect(
      requestHerdrCore(path, "terminal.get", {}),
    ).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await pending;
  });
});
