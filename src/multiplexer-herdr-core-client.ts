import { execFile, execFileSync } from "node:child_process";
import { isHerdrCorePid, isHerdrCoreTerminalId } from "./multiplexer-contracts";

export const CORE_CLI = "hc";
const TIMEOUT_MS = 1500;
const MAX_RESPONSE_BYTES = 64 * 1024;

function coreOptions(socket: string, env: NodeJS.ProcessEnv) {
  const pinnedEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("HC_")),
  );
  return {
    encoding: "utf8" as const,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_RESPONSE_BYTES,
    env: { ...pinnedEnv, HC_SOCKET: socket },
  };
}

function coreRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseCoreJson(output: string): Record<string, unknown> | undefined {
  try {
    return coreRecord(JSON.parse(output));
  } catch {
    // Malformed responses are not evidence. Do not retain the output.
    return undefined;
  }
}

type CoreReply =
  | { kind: "ok"; value: Record<string, unknown> }
  | { kind: "not_found" | "timeout" | "command_error" | "malformed_response" };

function coreReply(error: unknown, output = "", stderr = ""): CoreReply {
  if (error) {
    const failure = coreRecord(error);
    if (
      (failure?.status === 3 || failure?.code === 3) &&
      coreRecord(parseCoreJson(stderr)?.error)?.kind === "not_found"
    ) {
      return { kind: "not_found" };
    }
    return {
      kind:
        failure?.code === "ETIMEDOUT" || failure?.killed === true
          ? "timeout"
          : "command_error",
    };
  }
  const value = parseCoreJson(output);
  return value ? { kind: "ok", value } : { kind: "malformed_response" };
}

export function queryCore(
  socket: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CoreReply {
  try {
    const output = execFileSync(CORE_CLI, args, {
      ...coreOptions(socket, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return coreReply(null, output);
  } catch (error) {
    // Never surface a CLI error: it can contain arguments, stderr or stdout.
    const stderr = coreRecord(error)?.stderr;
    return coreReply(error, "", typeof stderr === "string" ? stderr : "");
  }
}

export async function queryCoreAsync(
  socket: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CoreReply> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        CORE_CLI,
        args,
        coreOptions(socket, env),
        (error, output, stderr) => {
          resolve(coreReply(error, output, stderr));
        },
      );
      child?.stdin?.end();
    } catch (error) {
      // Synchronous spawn failures carry the same private details.
      resolve(coreReply(error));
    }
  });
}

export function coreTerminal(reply: CoreReply, id: string) {
  if (
    reply.kind !== "ok" ||
    reply.value.address !== id ||
    !isHerdrCoreTerminalId(id)
  )
    return undefined;
  const { state, pid, exit_code: exitCode } = reply.value;
  if (state !== "live" && state !== "finished") return undefined;
  return {
    state,
    pid: isHerdrCorePid(pid) ? pid : undefined,
    exitCode:
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= -2147483648 &&
      exitCode <= 2147483647
        ? exitCode
        : undefined,
  };
}
