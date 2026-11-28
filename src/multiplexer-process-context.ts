import { execFile, execFileSync } from "node:child_process";
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
const INSPECTION_TIMEOUT_MS = 1500;
const DETAIL_FIELDS = "pid=,ppid=,tty=,comm=";
type ProcessLink = Pick<ProcessIdentity, "pid" | "parentPid">;
type InspectionScope = "all" | "ancestry";

export function normalizeProcessTty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tty = value.startsWith("/dev/") ? value.slice(5) : value;
  if (tty.length > 128 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(tty)) {
    return undefined;
  }
  return tty === "-" ? undefined : tty;
}

function parseTable<T extends ProcessLink>(
  output: string,
  parseRow: (line: string) => T | undefined,
): Map<number, T> | undefined {
  // A partial final line cannot prove that the process snapshot is complete.
  if (!output.endsWith("\n") || Buffer.byteLength(output) > MAX_PROCESS_BYTES) {
    return undefined;
  }
  const lines = output.slice(0, -1).split("\n");
  if (lines.length > MAX_PROCESS_RECORDS) return undefined;
  const processes = new Map<number, T>();
  for (const line of lines) {
    const row = parseRow(line);
    if (
      !row ||
      !Number.isSafeInteger(row.pid) ||
      !Number.isSafeInteger(row.parentPid) ||
      processes.has(row.pid)
    ) {
      return undefined;
    }
    processes.set(row.pid, row);
  }
  return processes;
}

function parseLink(line: string): ProcessLink | undefined {
  const match = /^[ \t]*(\d+)[ \t]+(\d+)$/.exec(line);
  if (match) return { pid: Number(match[1]), parentPid: Number(match[2]) };
}

function parseIdentity(line: string): ProcessIdentity | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([^\x00-\x1f\x7f]+)$/.exec(line);
  if (!match) return undefined;
  const rawTty = match[3]!;
  const tty = normalizeProcessTty(rawTty);
  const command = match[4]!.trim();
  if (!command || (!tty && !["?", "??", "-"].includes(rawTty)))
    return undefined;
  return { pid: Number(match[1]), parentPid: Number(match[2]), tty, command };
}

function supportedProcessPid(pid: number): boolean {
  return (
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    (process.platform === "darwin" || process.platform === "linux")
  );
}

function processChain<T extends ProcessLink>(
  processes: ReadonlyMap<number, T> | undefined,
  pid: number,
): T[] | undefined {
  const chain: T[] = [];
  const seen = new Set<number>();
  while (pid !== 0) {
    const current = processes?.get(pid);
    if (!current || chain.length > MAX_ANCESTOR_LINKS || seen.has(pid)) {
      return undefined;
    }
    chain.push(current);
    seen.add(pid);
    pid = current.parentPid;
  }
  return chain;
}

interface Inspection {
  args: string[];
  timeout: number;
}

// Share the evidence checks and time budget between launch and advisory readers.
function* inspectProcesses(
  pid: number,
  scope: InspectionScope,
): Generator<Inspection, ProcessContext | undefined, string> {
  if (!supportedProcessPid(pid)) return undefined;
  const scoped = scope === "ancestry" && process.platform === "darwin";
  const deadline = performance.now() + INSPECTION_TIMEOUT_MS;
  let expected: ProcessLink[] | undefined;
  let args = ["-axo", DETAIL_FIELDS];
  let timeout = INSPECTION_TIMEOUT_MS;
  if (scoped) {
    const links = yield { args: ["-axo", "pid=,ppid="], timeout };
    expected = processChain(parseTable(links, parseLink), pid);
    if (!expected || expected.at(-1)?.pid !== 1) return undefined;
    args = [
      "-p",
      expected.map((row) => row.pid).join(","),
      "-o",
      DETAIL_FIELDS,
    ];
    timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) return undefined;
  }
  const details = yield { args, timeout };
  const processes = parseTable(details, parseIdentity);
  const chain = processChain(processes, pid);
  if (!processes || !chain) return undefined;
  if (
    expected &&
    (processes.size !== expected.length ||
      chain.length !== expected.length ||
      chain.some((row, index) => row.pid !== expected[index]!.pid) ||
      performance.now() >= deadline)
  )
    return undefined;
  return { pid, processes, ancestors: chain.slice(1) };
}

export function readProcessContext(
  pid = process.pid,
  scope: InspectionScope = "all",
): ProcessContext | undefined {
  const plan = inspectProcesses(pid, scope);
  let step = plan.next();
  try {
    while (!step.done) {
      const { args, timeout } = step.value;
      step = plan.next(
        execFileSync("ps", args, {
          encoding: "utf8",
          timeout,
          maxBuffer: MAX_PROCESS_BYTES,
          stdio: ["ignore", "pipe", "ignore"],
          shell: false,
        }),
      );
    }
    return step.value;
  } catch {
    // Failed inspection is missing evidence. Do not surface process output.
    return undefined;
  }
}

function queryProcessTable({ args, timeout }: Inspection): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "ps",
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: MAX_PROCESS_BYTES,
        shell: false,
      },
      (error, output) => {
        if (error) reject(error);
        else resolve(output);
      },
    );
    child?.stdin?.end();
  });
}

export async function readProcessContextAsync(
  pid = process.pid,
  scope: InspectionScope = "all",
): Promise<ProcessContext | undefined> {
  const plan = inspectProcesses(pid, scope);
  let step = plan.next();
  try {
    while (!step.done) step = plan.next(await queryProcessTable(step.value));
    return step.value;
  } catch {
    // As in the synchronous reader, do not surface process errors.
    return undefined;
  }
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
    else if (command === "herdr-core" || command === "hc") mux = "herdr-core";
    else if (command === "rex" || command === "Rex") mux = "rex";
    if (mux) return { mux, pid: ancestor.pid };
  }
  return undefined;
}
