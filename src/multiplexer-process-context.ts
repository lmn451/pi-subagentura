import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { MuxName } from "./multiplexer-contracts";

export interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly tty?: string;
  readonly command: string;
}

export interface ProcessContext {
  readonly pid: number;
  readonly processes: ReadonlyMap<number, ProcessIdentity>;
  /** Nearest parent first, excluding the queried process itself. */
  readonly ancestors: readonly ProcessIdentity[];
}

const MAX_PROCESS_BYTES = 1024 * 1024;
const MAX_PROCESS_RECORDS = 8192;
const MAX_ANCESTOR_LINKS = 64;

export function normalizeProcessTty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tty = value.startsWith("/dev/") ? value.slice(5) : value;
  if (tty.length > 128 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(tty)) {
    return undefined;
  }
  return tty === "-" ? undefined : tty;
}

function parseProcessTable(
  output: string,
): Map<number, ProcessIdentity> | undefined {
  // A partial final line cannot prove that the process snapshot is complete.
  if (!output.endsWith("\n") || Buffer.byteLength(output) > MAX_PROCESS_BYTES) {
    return undefined;
  }
  const lines = output.slice(0, -1).split("\n");
  if (lines.length > MAX_PROCESS_RECORDS) return undefined;
  const processes = new Map<number, ProcessIdentity>();
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([^\x00-\x1f\x7f]+)$/.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const rawTty = match[3]!;
    const tty = normalizeProcessTty(rawTty);
    const command = match[4]!.trim();
    if (
      !Number.isSafeInteger(pid) ||
      pid < 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      processes.has(pid) ||
      !command ||
      (!tty && !["?", "??", "-"].includes(rawTty))
    ) {
      return undefined;
    }
    processes.set(pid, { pid, parentPid, tty, command });
  }
  return processes;
}

export function readProcessContext(
  pid = process.pid,
): ProcessContext | undefined {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (process.platform !== "darwin" && process.platform !== "linux")
  ) {
    return undefined;
  }
  let output: string;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,tty=,comm="], {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: MAX_PROCESS_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
  } catch {
    // Process inspection is optional evidence, never a reason to fail launch.
    return undefined;
  }
  const processes = parseProcessTable(output);
  let current = processes?.get(pid);
  if (!processes || !current) return undefined;
  const ancestors: ProcessIdentity[] = [];
  const seen = new Set([pid]);
  while (current.parentPid !== 0) {
    if (ancestors.length >= MAX_ANCESTOR_LINKS || seen.has(current.parentPid)) {
      return undefined;
    }
    const parent = processes.get(current.parentPid);
    if (!parent) return undefined;
    seen.add(parent.pid);
    ancestors.push(parent);
    current = parent;
  }
  return { pid, processes, ancestors };
}

export function closestMuxAncestor(
  context: ProcessContext,
): { mux: MuxName; pid: number } | undefined {
  for (const ancestor of context.ancestors) {
    const command = basename(ancestor.command);
    let mux: MuxName | undefined;
    if (command === "tmux" || command === "tmux: server") mux = "tmux";
    else if (command === "zellij") mux = "zellij";
    else if (command === "herdr") mux = "herdr";
    else if (command === "rex" || command === "Rex") mux = "rex";
    if (mux) return { mux, pid: ancestor.pid };
  }
  return undefined;
}
