import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";

export const CORE_IDENTITY_URL = import.meta.url;
const MAX_STATUS_BYTES = 64 * 1024;
const STATUS_TIMEOUT_MS = 1_500;

export function coreSocketIdentity(socket: string): string | undefined {
  if (
    !socket.startsWith("/") ||
    socket.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(socket)
  )
    return undefined;
  try {
    const stat = lstatSync(socket, { bigint: true });
    if (stat.isSocket() && stat.uid === BigInt(process.getuid?.() ?? -1)) {
      return `${stat.dev}:${stat.ino}`;
    }
  } catch {
    // Absent or inaccessible sockets cannot authorize a CLI call.
  }
  return undefined;
}

function parseStatus(line: string): string | undefined {
  try {
    const response = JSON.parse(line) as {
      jsonrpc?: unknown;
      id?: unknown;
      error?: unknown;
      result?: { core?: { id?: unknown } };
    } | null;
    const id = response?.result?.core?.id;
    if (
      response?.jsonrpc === "2.0" &&
      response.id === 1 &&
      response.error === undefined &&
      typeof id === "string" &&
      /^[0-9a-f]{32}$/.test(id)
    )
      return id;
  } catch {
    // A malformed response cannot establish identity.
  }
  return undefined;
}

/** A direct read-only request: the hc CLI would auto-start on a stale socket. */
export async function queryCoreIdAsync(
  socket: string,
): Promise<string | undefined> {
  const identity = coreSocketIdentity(socket);
  if (!identity) return undefined;
  return new Promise((resolve) => {
    const client = createConnection(socket);
    let data = "";
    let bytes = 0;
    const finish = (id?: string) => {
      clearTimeout(timeout);
      client.destroy();
      resolve(id);
    };
    const timeout = setTimeout(finish, STATUS_TIMEOUT_MS);
    client.once("connect", () => {
      if (coreSocketIdentity(socket) !== identity) return finish();
      client.write(
        '{"jsonrpc":"2.0","id":1,"method":"server.status","params":{}}\n',
      );
    });
    client.once("error", () => finish());
    client.once("end", () => finish());
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STATUS_BYTES) return finish();
      data += chunk;
      const newline = data.indexOf("\n");
      if (newline >= 0) finish(parseStatus(data.slice(0, newline)));
    });
  });
}

export function queryCoreId(socket: string): string | undefined {
  if (!coreSocketIdentity(socket)) return undefined;
  try {
    const id = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { queryCoreIdAsync } = await import(process.argv[1]); process.stdout.write((await queryCoreIdAsync(process.argv[2])) ?? "");',
        "--",
        CORE_IDENTITY_URL,
        socket,
      ],
      {
        env: {},
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: STATUS_TIMEOUT_MS + 500,
        maxBuffer: 64,
      },
    );
    return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
  } catch {
    // Do not expose failures that include the socket path or helper contents.
    return undefined;
  }
}
