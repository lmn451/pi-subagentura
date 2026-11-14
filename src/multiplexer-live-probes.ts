import { execFileSync } from "node:child_process";
import {
  isRexBlockId,
  isRexSessionId,
  type MuxName,
} from "./multiplexer-contracts";
import {
  closestMuxAncestor,
  normalizeProcessTty,
  type ProcessContext,
} from "./multiplexer-process-context";

export interface LiveMuxTarget {
  readonly mux: MuxName;
  readonly paneId: string;
  readonly session?: string;
  readonly server?: string;
}
export type LiveMuxProbe =
  | { kind: "match"; target: LiveMuxTarget; distance: number }
  | { kind: "mismatch" }
  | { kind: "unknown" };

const UNKNOWN: LiveMuxProbe = { kind: "unknown" };
const MISMATCH: LiveMuxProbe = { kind: "mismatch" };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function selector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("-") &&
    !/[\x00-\x20\x7f#]/.test(value)
  );
}
function socket(value: unknown): value is string {
  return selector(value) && value.startsWith("/");
}
function pid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function query(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
    env,
  });
}
function matchPids(
  target: LiveMuxTarget,
  context: ProcessContext,
  pids: number[],
  tty?: string,
): LiveMuxProbe {
  const callerTty = normalizeProcessTty(
    context.processes.get(context.pid)?.tty,
  );
  if (tty && callerTty && tty !== callerTty) return MISMATCH;
  if (pids.includes(context.pid))
    return { kind: "match", target, distance: -1 };
  const distance = context.ancestors.findIndex((ancestor) =>
    pids.includes(ancestor.pid),
  );
  if (distance < 0) return MISMATCH;
  const ownerTty = normalizeProcessTty(context.ancestors[distance]?.tty);
  if (callerTty && ownerTty && callerTty !== ownerTty) return MISMATCH;
  return { kind: "match", target, distance };
}
function tmuxProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): LiveMuxProbe {
  if (!/^%\d+$/.test(target.paneId)) return UNKNOWN;
  let socketArgs: string[];
  if (env.PI_SUBAGENTURA_TMUX_SOCKET !== undefined) {
    const name = env.PI_SUBAGENTURA_TMUX_SOCKET;
    if (!selector(name) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name))
      return UNKNOWN;
    socketArgs = ["-L", name];
  } else {
    const path = /^(.*),\d+,\d+$/.exec(env.TMUX ?? "")?.[1];
    if (!socket(path)) return UNKNOWN;
    socketArgs = ["-S", path];
  }
  const output = query(
    "tmux",
    [
      "-N",
      ...socketArgs,
      "display-message",
      "-p",
      "-t",
      target.paneId,
      "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
    ],
    env,
  );
  const row = /^(%\d+)\t([1-9]\d*)\t([^\r\n\t]+)\n?$/.exec(output);
  if (!row || !pid(Number(row[2]))) return UNKNOWN;
  const tty = normalizeProcessTty(row[3]);
  if (!tty) return UNKNOWN;
  if (row[1] !== target.paneId) return MISMATCH;
  return matchPids(target, context, [Number(row[2])], tty);
}
function herdrProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): LiveMuxProbe {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.paneId))
    return UNKNOWN;
  const path = target.session ?? env.HERDR_SOCKET_PATH;
  if (!socket(path)) return UNKNOWN;
  const parsed: unknown = JSON.parse(
    query("herdr", ["pane", "process-info", "--pane", target.paneId], {
      ...env,
      HERDR_SOCKET_PATH: path,
    }),
  );
  if (
    !record(parsed) ||
    parsed.error !== undefined ||
    !record(parsed.result) ||
    !record(parsed.result.process_info)
  )
    return UNKNOWN;
  const shellPid = parsed.result.process_info.shell_pid;
  if (!pid(shellPid)) return UNKNOWN;
  return matchPids(target, context, [shellPid]);
}
function rexProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): LiveMuxProbe {
  if (!isRexBlockId(target.paneId) || !isRexSessionId(target.session))
    return UNKNOWN;
  const server = target.server;
  if (
    !selector(server) ||
    !(
      (server.startsWith("unix:///") && socket(server.slice(7))) ||
      socket(server)
    )
  )
    return UNKNOWN;
  const parsed: unknown = JSON.parse(
    query(
      "rex",
      [
        "--autostart=false",
        "--timeout=1s",
        "--server",
        server,
        "block",
        "call",
        "--session",
        target.session,
        "--block",
        target.paneId,
        "process",
      ],
      env,
    ),
  );
  if (!record(parsed)) return UNKNOWN;
  const candidates = [parsed.child, parsed.foreground]
    .filter(record)
    .map((value) => value.pid)
    .filter(pid);
  if (!candidates.length) return UNKNOWN;
  // Reported ancestors can include unrelated server processes, not ownership.
  return matchPids(target, context, candidates);
}
function zellijProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): LiveMuxProbe {
  if (
    !/^(?:terminal_)?\d+$/.test(target.paneId) ||
    !selector(target.session) ||
    target.session.length > 256
  )
    return UNKNOWN;
  const parsed: unknown = JSON.parse(
    query(
      "zellij",
      ["--session", target.session, "action", "list-panes", "--json"],
      env,
    ),
  );
  if (!Array.isArray(parsed)) return UNKNOWN;
  for (const row of parsed) {
    if (
      !record(row) ||
      !(
        (typeof row.id === "number" &&
          Number.isSafeInteger(row.id) &&
          row.id >= 0) ||
        (typeof row.id === "string" && /^\d+$/.test(row.id))
      ) ||
      (row.is_plugin !== undefined && typeof row.is_plugin !== "boolean") ||
      (row.exited !== undefined && typeof row.exited !== "boolean")
    )
      return UNKNOWN;
  }
  const id = target.paneId.replace(/^terminal_/, "");
  if (
    !parsed.some(
      (row) =>
        String(row.id) === id && row.is_plugin !== true && row.exited !== true,
    )
  )
    return MISMATCH;
  const owner = closestMuxAncestor(context);
  if (owner?.mux !== "zellij") return UNKNOWN;
  const distance = context.ancestors.findIndex(
    (ancestor) => ancestor.pid === owner.pid,
  );
  return distance < 0 ? UNKNOWN : { kind: "match", target, distance };
}

/** Read-only live ownership proof. Unsupported CLIs and missing evidence fail closed. */
export function probeLiveMuxTarget(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv = process.env,
): LiveMuxProbe {
  if (
    !selector(target.paneId) ||
    (target.session !== undefined && !selector(target.session)) ||
    (target.server !== undefined && !selector(target.server))
  )
    return UNKNOWN;
  try {
    switch (target.mux) {
      case "tmux":
        return tmuxProbe(target, context, env);
      case "herdr":
        return herdrProbe(target, context, env);
      case "rex":
        return rexProbe(target, context, env);
      case "zellij":
        return zellijProbe(target, context, env);
      default:
        return UNKNOWN;
    }
  } catch {
    // CLI failures are missing evidence. Never surface child-controlled output.
    return UNKNOWN;
  }
}
