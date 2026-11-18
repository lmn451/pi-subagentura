import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

/** @param {number} channel @param {number} kind @param {Buffer} [payload] */
function frame(channel, kind, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header[4] = kind;
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/**
 * Generation-1 JSON-RPC, with a short-lived framed attach for literal input.
 * @param {string} server
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {string} [input]
 * @returns {Promise<Record<string, unknown>>}
 */
export function requestHerdrCore(server, method, params, input) {
  if (
    typeof server !== "string" ||
    !server.startsWith("/") ||
    server.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(server) ||
    (input !== undefined && Buffer.byteLength(input) > 1024 * 1024)
  ) {
    return Promise.reject(new Error("Invalid herdr-core request"));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(server);
    /** @type {Buffer} */
    let buffer = Buffer.alloc(0);
    let received = 0;
    let stage = input === undefined ? "request" : "hello";
    /** @type {number | undefined} */
    let channel;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("herdr-core timeout")),
      TIMEOUT_MS,
    );
    /** @param {unknown} [error] @param {Record<string, unknown>} [result] */
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    }
    /** @param {Buffer} payload @param {number} expectedId */
    function response(payload, expectedId) {
      const value = JSON.parse(payload.toString("utf8"));
      if (value?.jsonrpc !== "2.0" || value.id !== expectedId)
        throw new Error("Malformed herdr-core response");
      if (value.error) {
        const error = Object.assign(new Error("herdr-core request failed"), {
          kind: value.error.data?.kind,
        });
        throw error;
      }
      if (
        !value.result ||
        typeof value.result !== "object" ||
        Array.isArray(value.result)
      )
        throw new Error("Malformed herdr-core result");
      return value.result;
    }
    socket.once("connect", () => {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: stage === "hello" ? "hello" : method,
          params: stage === "hello" ? { generation: 1, framed: true } : params,
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      const data = Buffer.from(chunk);
      try {
        received += data.length;
        if (received > MAX_BYTES)
          throw new Error("herdr-core response exceeds limit");
        buffer = Buffer.concat([buffer, data]);
        if (stage === "hello" || stage === "request") {
          const end = buffer.indexOf(10);
          if (end < 0) return;
          const result = response(buffer.subarray(0, end), 1);
          buffer = buffer.subarray(end + 1);
          if (stage === "request") return finish(undefined, result);
          if (result.generation !== 1 || result.framed !== true)
            throw new Error("Unsupported herdr-core protocol");
          stage = "attach";
          socket.write(
            frame(
              0,
              0,
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "terminal.attach",
                  params,
                }),
              ),
            ),
          );
        }
        while (buffer.length >= 9) {
          const stream = buffer.readUInt32LE(0);
          const kind = buffer[4];
          const length = buffer.readUInt32LE(5);
          if (length > MAX_BYTES)
            throw new Error("herdr-core frame exceeds limit");
          if (buffer.length < 9 + length) return;
          const payload = buffer.subarray(9, 9 + length);
          buffer = buffer.subarray(9 + length);
          if (stream === 0 && kind === 0 && stage === "attach") {
            const result = response(payload, 2);
            const assigned = result.channel;
            if (
              typeof assigned !== "number" ||
              !Number.isSafeInteger(assigned) ||
              assigned <= 0 ||
              assigned > 0xffffffff
            )
              throw new Error("Invalid herdr-core input channel");
            channel = assigned;
            stage = "close";
            socket.write(
              Buffer.concat([
                frame(channel, 0, Buffer.from(input ?? "")),
                frame(channel, 2),
              ]),
            );
          } else if (stream === channel && kind === 2 && stage === "close") {
            if (payload.length !== 0)
              throw new Error("herdr-core terminal exited during input");
            return finish(undefined, {});
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () =>
      finish(new Error("herdr-core connection closed")),
    );
  });
}

/**
 * Isolate socket I/O from the parent thread for the synchronous mux API.
 * @param {string} server
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {string} [input]
 * @returns {Record<string, unknown>}
 */
export function requestHerdrCoreSync(server, method, params, input) {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.url)],
    {
      input: JSON.stringify({ server, method, params, input }),
      encoding: "utf8",
      timeout: TIMEOUT_MS + 1_000,
      maxBuffer: MAX_BYTES,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  const value = JSON.parse(output);
  if (value.error) {
    const error = Object.assign(new Error("herdr-core request failed"), {
      kind: value.error.kind,
    });
    throw error;
  }
  return value.result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_BYTES)
      throw new Error("Request exceeds limit");
  }
  const request = JSON.parse(input);
  try {
    const result = await requestHerdrCore(
      request.server,
      request.method,
      request.params,
      request.input,
    );
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    const kind =
      error && typeof error === "object" && "kind" in error
        ? error.kind
        : undefined;
    process.stdout.write(JSON.stringify({ error: { kind } }));
  }
}
