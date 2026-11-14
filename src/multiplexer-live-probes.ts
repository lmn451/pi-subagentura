import { execFile, execFileSync } from "node:child_process";
import {
  isRexBlockId,
  isRexSessionId,
  isZellijSessionName,
  isTmuxSocketLabel,
  type MuxName,
} from "./multiplexer-contracts";
import {
  normalizeProcessTty,
  type ProcessContext,
} from "./multiplexer-process-context";

export interface LiveMuxTarget {
  readonly mux: MuxName;
  readonly paneId: string;
  readonly session?: string;
  readonly server?: string;
  readonly socketName?: string;
}
export type LiveMuxProbe =
  | { kind: "match"; target: LiveMuxTarget; distance: number }
  | { kind: "mismatch" }
  | { kind: "unknown" };

interface ProbePlan {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly parse: (output: string) => LiveMuxProbe;
}

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
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    value.startsWith("/") &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function pid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function query(plan: ProbePlan): string {
  return execFileSync(plan.command, plan.args, {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
    env: plan.env,
  });
}
function queryAsync(plan: ProbePlan): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      plan.command,
      plan.args,
      {
        encoding: "utf8",
        timeout: 1500,
        maxBuffer: 64 * 1024,
        shell: false,
        env: plan.env,
      },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
    child?.stdin?.end();
  });
}
function matchPids(
  target: LiveMuxTarget,
  context: ProcessContext,
  pids: number[],
  tty?: string,
): LiveMuxProbe {
  let distance = -1;
  let paneRoot = context.processes.get(context.pid);
  if (!pids.includes(context.pid)) {
    distance = context.ancestors.findIndex((ancestor) =>
      pids.includes(ancestor.pid),
    );
    if (distance < 0) return MISMATCH;
    paneRoot = context.ancestors[distance];
  }
  const rootTty = normalizeProcessTty(paneRoot?.tty);
  if (tty && rootTty && tty !== rootTty) return MISMATCH;
  return { kind: "match", target, distance };
}
function tmuxProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): ProbePlan | LiveMuxProbe {
  if (!/^%\d+$/.test(target.paneId)) return UNKNOWN;
  let socketArgs: string[];
  const actualServer = target.server;
  const name = env.PI_SUBAGENTURA_TMUX_SOCKET;
  if (actualServer !== undefined) {
    if (!socket(actualServer)) return UNKNOWN;
    socketArgs = ["-S", actualServer];
  } else if (name !== undefined && name !== "") {
    if (!isTmuxSocketLabel(name)) return UNKNOWN;
    socketArgs = ["-L", name];
  } else {
    const path = /^(.*),\d+,\d+$/.exec(env.TMUX ?? "")?.[1];
    if (!socket(path)) return UNKNOWN;
    socketArgs = ["-S", path];
  }
  return {
    command: "tmux",
    args: [
      "-N",
      ...socketArgs,
      "display-message",
      "-p",
      "-t",
      target.paneId,
      "#{pane_id}\t#{pane_pid}\t#{pane_tty}",
    ],
    env,
    parse(output) {
      const row = /^(%\d+)\t([1-9]\d*)\t([^\r\n\t]+)\n?$/.exec(output);
      if (!row || !pid(Number(row[2]))) return UNKNOWN;
      const tty = normalizeProcessTty(row[3]);
      if (!tty) return UNKNOWN;
      if (row[1] !== target.paneId) return MISMATCH;
      return matchPids(target, context, [Number(row[2])], tty);
    },
  };
}
function herdrProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): ProbePlan | LiveMuxProbe {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target.paneId))
    return UNKNOWN;
  const path = target.session ?? env.HERDR_SOCKET_PATH;
  if (!socket(path)) return UNKNOWN;
  return {
    command: "herdr",
    args: ["pane", "process-info", "--pane", target.paneId],
    env: { ...env, HERDR_SOCKET_PATH: path },
    parse(output) {
      const parsed: unknown = JSON.parse(output);
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
    },
  };
}
function rexProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): ProbePlan | LiveMuxProbe {
  if (!isRexBlockId(target.paneId) || !isRexSessionId(target.session))
    return UNKNOWN;
  const server = target.server;
  if (
    typeof server !== "string" ||
    !(
      (server.startsWith("unix:///") && socket(server.slice(7))) ||
      socket(server)
    )
  )
    return UNKNOWN;
  return {
    command: "rex",
    args: [
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
    parse(output) {
      const parsed: unknown = JSON.parse(output);
      if (!record(parsed)) return UNKNOWN;
      const candidates = [parsed.child, parsed.foreground]
        .filter(record)
        .map((value) => value.pid)
        .filter(pid);
      if (!candidates.length) return UNKNOWN;
      // Reported ancestors can include unrelated server processes, not ownership.
      return matchPids(target, context, candidates);
    },
  };
}
function zellijProbe(
  target: LiveMuxTarget,
  env: NodeJS.ProcessEnv,
): ProbePlan | LiveMuxProbe {
  if (
    !/^(?:terminal_)?\d+$/.test(target.paneId) ||
    !isZellijSessionName(target.session)
  )
    return UNKNOWN;
  return {
    command: "zellij",
    args: ["--session", target.session, "action", "list-panes", "--json"],
    env,
    parse(output) {
      const parsed: unknown = JSON.parse(output);
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
            String(row.id) === id &&
            row.is_plugin !== true &&
            row.exited !== true,
        )
      )
        return MISMATCH;
      // The public listing exposes no pane PID. A Zellij ancestor cannot bind
      // these inherited session/pane selectors to the caller's process.
      return UNKNOWN;
    },
  };
}

function prepareProbe(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv,
): ProbePlan | LiveMuxProbe {
  if (
    !selector(target.paneId) ||
    (target.session !== undefined &&
      !(target.mux === "herdr"
        ? socket(target.session)
        : target.mux === "zellij"
          ? isZellijSessionName(target.session)
          : selector(target.session))) ||
    (target.server !== undefined &&
      !(target.mux === "rex"
        ? (target.server.startsWith("unix:///") &&
            socket(target.server.slice(7))) ||
          socket(target.server)
        : target.mux === "tmux"
          ? socket(target.server)
          : selector(target.server)))
  )
    return UNKNOWN;
  switch (target.mux) {
    case "tmux":
      return tmuxProbe(target, context, env);
    case "herdr":
      return herdrProbe(target, context, env);
    case "rex":
      return rexProbe(target, context, env);
    case "zellij":
      return zellijProbe(target, env);
    default:
      return UNKNOWN;
  }
}

/** Read-only live ownership proof. Unsupported CLIs and missing evidence fail closed. */
export function probeLiveMuxTarget(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv = process.env,
): LiveMuxProbe {
  try {
    const plan = prepareProbe(target, context, env);
    return "command" in plan ? plan.parse(query(plan)) : plan;
  } catch {
    // CLI failures are missing evidence. Never surface child-controlled output.
    return UNKNOWN;
  }
}

/** Same validation and response parsing, without blocking on backend processes. */
export async function probeLiveMuxTargetAsync(
  target: LiveMuxTarget,
  context: ProcessContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveMuxProbe> {
  try {
    const plan = prepareProbe(target, context, env);
    return "command" in plan ? plan.parse(await queryAsync(plan)) : plan;
  } catch {
    // Advisory probes cannot surface process errors or child-controlled output.
    return UNKNOWN;
  }
}
