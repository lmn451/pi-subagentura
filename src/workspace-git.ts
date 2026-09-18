import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  createRepositoryRecord,
  type RepositoryRecord,
  type WorktreeObservation,
  type WorkspaceAdminStatus,
  type WorkspaceCheckout,
  type WorkspaceObjectFormat,
} from "./workspace-ledger";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_OUTPUT_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_WORKTREE_RECORD_BYTES = 64 * 1024;
const OID_PATTERN = /^[a-f0-9]+$/i;
const FULL_HEAD_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/@+-]+$/;
const SAFE_REMOTE_PATTERN = /^[A-Za-z0-9._:@/+~-]+$/;

export type WorkspaceGitErrorCode =
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "parse_error"
  | "command_failed"
  | "forbidden_command"
  | "unsafe_remote"
  | "branch_conflict"
  | "unavailable"
  | "unknown";

export class WorkspaceGitError extends Error {
  readonly code: WorkspaceGitErrorCode;
  readonly exitCode?: number;

  constructor(code: WorkspaceGitErrorCode, message: string, exitCode?: number) {
    super(message);
    this.name = "WorkspaceGitError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface WorkspaceGitRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface WorkspaceGitCommandResult {
  exitCode: number | null;
  stdout: Buffer | string;
  stderr: Buffer | string;
  timedOut?: boolean;
  cancelled?: boolean;
  outputLimited?: boolean;
  spawnError?: boolean;
}

export type WorkspaceGitRunner = (
  command: "git",
  args: readonly string[],
  options: WorkspaceGitRunOptions,
) => Promise<WorkspaceGitCommandResult> | WorkspaceGitCommandResult;

export interface WorkspaceRepositoryProbe extends RepositoryRecord {
  root: string;
  bare: false;
}

export interface WorkspaceWorktreeRecord {
  root: string;
  adminKey: string;
  kind: "main" | "linked";
  gitDir: string;
  branchRef?: string;
  headOid?: string;
  checkout: WorkspaceCheckout;
  locked: boolean;
  prunable: boolean;
}

export interface ParsedStatus {
  records: number;
  dirty: boolean;
  ignored: boolean;
  conflicted: boolean;
  paths: string[];
}

export interface ParsedIndexFlags {
  paths: string[];
  hidden: boolean;
}

export interface ParsedFilters {
  configured: boolean;
}

export interface ParsedAttributes {
  filtered: boolean;
}

export interface RemoteObservation {
  observedOid?: string;
  result: "equal" | "different" | "not_advertised" | "unknown";
  errorCode?:
    "auth" | "timeout" | "unavailable" | "malformed" | "remote_changed";
}

export interface WorkspaceGitOptions {
  runner?: WorkspaceGitRunner;
  run?: WorkspaceGitRunner;
  spawn?: WorkspaceGitRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
  hooksPath?: string;
}

function asBuffer(value: Buffer | string | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value ?? "", "utf8");
}

function decodeUtf8(value: Buffer | string): string {
  if (typeof value === "string") {
    if (value.includes("\0")) return value;
    return value;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new WorkspaceGitError(
      "parse_error",
      "git output was not valid UTF-8",
    );
  }
}

function assertCwd(cwd: string): string {
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) {
    throw new WorkspaceGitError(
      "unavailable",
      "git cwd must be an absolute path",
    );
  }
  return resolve(cwd);
}

function isSafeShortBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/")
  );
}

function isSafeRemote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.includes("\0") &&
    !value.includes("::") &&
    SAFE_REMOTE_PATTERN.test(value)
  );
}

function assertArgv(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0) {
    throw new WorkspaceGitError("forbidden_command", "empty Git argv");
  }
  if (
    args.length > 16 ||
    args.some(
      (arg) =>
        typeof arg !== "string" ||
        Buffer.byteLength(arg, "utf8") > 64 * 1024 ||
        arg.includes("\0"),
    )
  ) {
    throw new WorkspaceGitError(
      "forbidden_command",
      "Git argv contains an invalid argument",
    );
  }
  const command = args[0];
  const allowed = new Set([
    "rev-parse",
    "worktree",
    "status",
    "ls-files",
    "config",
    "check-attr",
    "check-ref-format",
    "ls-remote",
    "switch",
  ]);
  if (!allowed.has(command)) {
    throw new WorkspaceGitError(
      "forbidden_command",
      "Git command is not allowlisted",
    );
  }
  if (
    args.some((arg) =>
      [
        "--force",
        "-f",
        "--discard-changes",
        "reset",
        "clean",
        "stash",
        "prune",
        "delete",
        "push",
        "merge",
        "rebase",
        "unlock",
      ].includes(arg),
    )
  ) {
    throw new WorkspaceGitError(
      "forbidden_command",
      "destructive Git arguments are forbidden",
    );
  }
  if (command === "switch") {
    const valid =
      (args[1] === "--no-guess" &&
        args.length === 3 &&
        isSafeShortBranch(args[2])) ||
      (args[1] === "--create" &&
        args.length === 4 &&
        isSafeShortBranch(args[2]) &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(args[3]));
    if (!valid) {
      throw new WorkspaceGitError(
        "forbidden_command",
        "Git switch form is not allowlisted",
      );
    }
    return;
  }
  const identityRead =
    args.length === 7 &&
    args[1] === "--show-toplevel" &&
    args[2] === "--git-common-dir" &&
    args[3] === "--git-dir" &&
    args[4] === "--show-object-format" &&
    args[5] === "--is-bare-repository" &&
    args[6] === "--is-inside-work-tree";
  const objectRead =
    args.length === 4 &&
    args[1] === "--verify" &&
    args[2] === "--quiet" &&
    /^(?:refs\/heads\/[A-Za-z0-9._/@+-]+|[a-f0-9]{40,64})\^\{commit\}$/i.test(
      args[3],
    );
  const validRead =
    (command === "rev-parse" && (identityRead || objectRead)) ||
    (command === "worktree" &&
      args.join(" ") === "worktree list --porcelain -z") ||
    (command === "status" &&
      args.join(" ") ===
        "status --porcelain=v2 -z --untracked-files=all --ignored=matching") ||
    (command === "ls-files" && args.join(" ") === "ls-files -v -z") ||
    (command === "config" &&
      args.length === 4 &&
      args[1] === "--null" &&
      args[2] === "--get-regexp" &&
      args[3] === "^filter\\..*(clean|smudge|process)$") ||
    (command === "check-attr" &&
      args.join(" ") === "check-attr --all -z --stdin") ||
    (command === "check-ref-format" &&
      args.length === 3 &&
      args[1] === "--branch" &&
      isSafeShortBranch(args[2])) ||
    (command === "ls-remote" &&
      args.length === 5 &&
      args[1] === "--refs" &&
      args[2] === "--exit-code" &&
      isSafeRemote(args[3]) &&
      isFullBranchRef(args[4]));
  if (!validRead) {
    throw new WorkspaceGitError(
      "forbidden_command",
      "Git read form is not allowlisted",
    );
  }
}

function safeEnvironment(hooksPath: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const inherited = process.env;
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ]) {
    const value = inherited[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH ??= "/usr/bin:/bin";
  environment.LC_ALL = "C";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_PAGER = "";
  environment.PAGER = "";
  environment.GIT_EDITOR = "false";
  environment.GIT_SEQUENCE_EDITOR = "false";
  environment.GIT_ASKPASS = "false";
  environment.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_COUNT = "3";
  environment.GIT_CONFIG_KEY_0 = "core.hooksPath";
  environment.GIT_CONFIG_VALUE_0 = hooksPath;
  environment.GIT_CONFIG_KEY_1 = "credential.helper";
  environment.GIT_CONFIG_VALUE_1 = "";
  environment.GIT_CONFIG_KEY_2 = "core.fsmonitor";
  environment.GIT_CONFIG_VALUE_2 = "false";
  environment.GIT_ALLOW_PROTOCOL = "file:https:ssh:git";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.NO_COLOR = "1";
  return environment;
}

function terminateProcessGroup(
  child: ReturnType<typeof spawn>,
  shouldForceKill: () => boolean = () => true,
): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Windows and non-grouped runners need a direct child fallback.
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may have exited between the bounded probe and termination.
    }
  }
  const forceKill = setTimeout(() => {
    if (!shouldForceKill()) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process group may have exited after SIGTERM.
      }
    }
  }, 100) as ReturnType<typeof setTimeout> & { unref?: () => void };
  forceKill.unref?.();
}

function defaultRunner(
  command: "git",
  args: readonly string[],
  options: WorkspaceGitRunOptions,
): Promise<WorkspaceGitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputLimited = false;
    const finish = (result: WorkspaceGitCommandResult): void => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const append = (
      target: Buffer[],
      chunk: Buffer,
      stdoutTarget: boolean,
    ): void => {
      const limit = stdoutTarget
        ? options.maxStdoutBytes
        : options.maxStderrBytes;
      const current = stdoutTarget ? stdoutBytes : stderrBytes;
      if (current + chunk.byteLength > limit) {
        outputLimited = true;
        terminateProcessGroup(child, () => !settled);
        return;
      }
      target.push(chunk);
      if (stdoutTarget) stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, false));
    child.on("error", () => {
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        spawnError: true,
      });
    });
    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        cancelled,
        outputLimited,
      });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, () => !settled);
    }, options.timeoutMs) as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
    const abort = (): void => {
      cancelled = true;
      terminateProcessGroup(child, () => !settled);
    };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    child.on("close", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function parseLines(value: Buffer | string): string[] {
  const text = decodeUtf8(value);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.includes("\0"))) {
    throw new WorkspaceGitError(
      "parse_error",
      "Git line output contained a NUL",
    );
  }
  return lines;
}

function parseExactLines(value: Buffer | string, count: number): string[] {
  const lines = parseLines(value);
  if (lines.length !== count)
    throw new WorkspaceGitError(
      "parse_error",
      "Git returned an unexpected record count",
    );
  return lines;
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new WorkspaceGitError(
      "unavailable",
      "Git path is missing or cannot be canonicalized",
    );
  }
}

function fullOid(value: string, objectFormat: WorkspaceObjectFormat): string {
  const expectedLength = objectFormat === "sha1" ? 40 : 64;
  if (
    value.length !== expectedLength ||
    !OID_PATTERN.test(value) ||
    /^0+$/.test(value)
  ) {
    throw new WorkspaceGitError(
      "parse_error",
      "Git returned a non-full object id",
    );
  }
  return value.toLowerCase();
}

export function isFullBranchRef(value: string): boolean {
  return (
    typeof value === "string" &&
    FULL_HEAD_REF_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

export function shortBranchName(branchRef: string): string {
  if (!isFullBranchRef(branchRef)) {
    throw new WorkspaceGitError(
      "parse_error",
      "branch must be a full refs/heads ref",
    );
  }
  const short = branchRef.slice("refs/heads/".length);
  if (
    !short ||
    short.startsWith("/") ||
    short.endsWith("/") ||
    short.startsWith("-") ||
    short.includes("\\")
  ) {
    throw new WorkspaceGitError("parse_error", "branch name is invalid");
  }
  return short;
}

function safeRemote(remote: string): string {
  if (
    typeof remote !== "string" ||
    remote.length === 0 ||
    remote.startsWith("-") ||
    remote.includes("\0") ||
    remote.includes("::") ||
    !SAFE_REMOTE_PATTERN.test(remote)
  ) {
    throw new WorkspaceGitError(
      "unsafe_remote",
      "remote helper or unsafe remote is forbidden",
    );
  }
  return remote;
}

function parseNulRecords(value: Buffer | string): string[][] {
  const buffer = asBuffer(value);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new WorkspaceGitError(
      "parse_error",
      "Git NUL output was not valid UTF-8",
    );
  }
  const parts = text.split("\0");
  if (parts.at(-1) !== "")
    throw new WorkspaceGitError("parse_error", "Git NUL output was truncated");
  parts.pop();
  const records: string[][] = [];
  let current: string[] = [];
  for (const part of parts) {
    if (part === "") {
      if (current.length > 0) records.push(current);
      current = [];
    } else {
      current.push(part);
    }
  }
  if (current.length > 0) records.push(current);
  return records;
}

function parseWorktreeList(
  value: Buffer | string,
  repository: WorkspaceRepositoryProbe,
): WorkspaceWorktreeRecord[] {
  const records = parseNulRecords(value);
  return records.map((fields) => {
    const values = new Map<string, string>();
    for (const field of fields) {
      const separator = field.indexOf(" ");
      const key = separator < 0 ? field : field.slice(0, separator);
      const fieldValue = separator < 0 ? "" : field.slice(separator + 1);
      if (
        ![
          "worktree",
          "HEAD",
          "branch",
          "detached",
          "bare",
          "locked",
          "prunable",
        ].includes(key)
      ) {
        throw new WorkspaceGitError(
          "parse_error",
          "Git worktree output contained an unknown field",
        );
      }
      if (values.has(key))
        throw new WorkspaceGitError(
          "parse_error",
          "Git worktree output duplicated a field",
        );
      values.set(key, fieldValue);
    }
    const rawRoot = values.get("worktree");
    if (!rawRoot)
      throw new WorkspaceGitError(
        "parse_error",
        "Git worktree record has no root",
      );
    let root = isAbsolute(rawRoot)
      ? rawRoot
      : resolve(repository.root, rawRoot);
    try {
      root = realpathSync(root);
    } catch {
      // A missing worktree remains in the inventory as an explicitly unknown root.
    }
    let adminKey = "unknown";
    let kind: "main" | "linked" = "linked";
    let gitDir = join(repository.commonDir, "worktrees", "unknown");
    try {
      const marker = worktreeAdminMarker(root, repository.commonDir);
      adminKey = marker.adminKey;
      kind = marker.kind;
      gitDir = marker.gitDir;
    } catch {
      // Missing or malformed administrative markers are represented by unknown identity.
    }
    const head = values.get("HEAD");
    const headOid =
      head && OID_PATTERN.test(head) && !/^0+$/.test(head)
        ? head.toLowerCase()
        : undefined;
    const branch = values.get("branch");
    if (branch !== undefined && !isFullBranchRef(branch)) {
      throw new WorkspaceGitError(
        "parse_error",
        "Git worktree output contained an invalid branch ref",
      );
    }
    const checkout: WorkspaceCheckout = values.has("bare")
      ? "unknown"
      : head && /^0+$/.test(head)
        ? "unborn"
        : branch
          ? "branch"
          : values.has("detached")
            ? "detached"
            : "unknown";
    return {
      root,
      adminKey,
      kind,
      gitDir,
      ...(branch ? { branchRef: branch } : {}),
      ...(headOid ? { headOid } : {}),
      checkout,
      locked: values.has("locked"),
      prunable: values.has("prunable"),
    };
  });
}

interface WorktreeAdminMarker {
  adminKey: string;
  kind: "main" | "linked";
  gitDir: string;
}

function readMarkerFile(path: string, maximum: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maximum)
      throw new WorkspaceGitError(
        "parse_error",
        "Git administrative marker is invalid",
      );
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const count = readSync(fd, buffer, offset, metadata.size - offset, null);
      if (count <= 0)
        throw new WorkspaceGitError(
          "parse_error",
          "Git administrative marker is truncated",
        );
      offset += count;
    }
    return decodeUtf8(buffer);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The marker descriptor is no longer usable after the bounded read.
      }
    }
  }
}

function worktreeAdminMarker(
  root: string,
  commonDir: string,
): WorktreeAdminMarker {
  const markerPath = join(root, ".git");
  const metadata = lstatSync(markerPath);
  if (metadata.isDirectory()) {
    const gitDir = realpathSync(markerPath);
    if (gitDir !== commonDir)
      throw new WorkspaceGitError(
        "parse_error",
        "main Git marker points elsewhere",
      );
    return { adminKey: "main", kind: "main", gitDir };
  }
  if (!metadata.isFile() || metadata.size > MAX_WORKTREE_RECORD_BYTES) {
    throw new WorkspaceGitError(
      "parse_error",
      "linked worktree Git marker is not a regular file",
    );
  }
  const content = readMarkerFile(markerPath, MAX_WORKTREE_RECORD_BYTES);
  const match = /^gitdir:\s*(.+?)(?:\n)?$/.exec(content);
  if (!match)
    throw new WorkspaceGitError(
      "parse_error",
      "linked worktree Git marker is malformed",
    );
  const gitDir = realpathSync(resolve(root, match[1]));
  const worktreesRoot = join(commonDir, "worktrees") + sep;
  if (!gitDir.startsWith(worktreesRoot))
    throw new WorkspaceGitError(
      "parse_error",
      "linked worktree Git marker escapes the common dir",
    );
  const adminKey = gitDir.slice(worktreesRoot.length);
  if (
    !adminKey ||
    adminKey.includes(sep) ||
    !/^[A-Za-z0-9._-]+$/.test(adminKey)
  ) {
    throw new WorkspaceGitError(
      "parse_error",
      "linked worktree administrative key is invalid",
    );
  }
  return { adminKey, kind: "linked", gitDir };
}

function parseStatus(value: Buffer | string): ParsedStatus {
  const parts = decodeUtf8(value).split("\0");
  if (parts.at(-1) !== "")
    throw new WorkspaceGitError(
      "parse_error",
      "Git status output was truncated",
    );
  parts.pop();
  const result: ParsedStatus = {
    records: 0,
    dirty: false,
    ignored: false,
    conflicted: false,
    paths: [],
  };
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    if (!entry)
      throw new WorkspaceGitError(
        "parse_error",
        "Git status contained an empty record",
      );
    const type = entry[0];
    if (type === "2") {
      const originalPath = parts[index + 1];
      if (!originalPath)
        throw new WorkspaceGitError(
          "parse_error",
          "Git rename status record is truncated",
        );
      index++;
    }
    if (type === "1" || type === "2") {
      const fields = entry.split(" ");
      if (fields.length < 9 || fields[1]?.length !== 2)
        throw new WorkspaceGitError(
          "parse_error",
          "Git status record is malformed",
        );
      const xy = fields[1];
      if (xy.includes("U") || (xy.includes("A") && xy.includes("U")))
        result.conflicted = true;
      if (xy !== "..") result.dirty = true;
      result.paths.push(fields.slice(8).join(" "));
    } else if (type === "u") {
      if (entry.split(" ").length < 11)
        throw new WorkspaceGitError(
          "parse_error",
          "Git unmerged status record is malformed",
        );
      result.conflicted = true;
      result.dirty = true;
      const path = entry.indexOf(" ");
      if (path >= 0) result.paths.push(entry.slice(path + 1));
    } else if (type === "?" || type === "!") {
      if (entry.length <= 2)
        throw new WorkspaceGitError(
          "parse_error",
          "Git untracked status record is malformed",
        );
      if (type === "?") result.dirty = true;
      else result.ignored = true;
      result.paths.push(entry.slice(2));
    } else {
      throw new WorkspaceGitError(
        "parse_error",
        "Git status contained an unknown record",
      );
    }
    result.records++;
  }
  return result;
}

function parseIndexFlags(value: Buffer | string): ParsedIndexFlags {
  const parts = decodeUtf8(value).split("\0");
  if (parts.at(-1) !== "")
    throw new WorkspaceGitError(
      "parse_error",
      "Git index output was truncated",
    );
  parts.pop();
  const paths: string[] = [];
  let hidden = false;
  for (const entry of parts) {
    const separator = entry.indexOf(" ");
    if (separator !== 1 || entry.length <= 2)
      throw new WorkspaceGitError(
        "parse_error",
        "Git index flag record is malformed",
      );
    const flag = entry[0];
    if (!"HhSMRCKU?".includes(flag))
      throw new WorkspaceGitError("parse_error", "Git index flag is unknown");
    if (flag === "h" || flag === "S") hidden = true;
    paths.push(entry.slice(2));
  }
  return { paths, hidden };
}

function parseFilters(value: Buffer | string): ParsedFilters {
  const parts = decodeUtf8(value).split("\0");
  if (parts.at(-1) !== "")
    throw new WorkspaceGitError(
      "parse_error",
      "Git filter output was truncated",
    );
  parts.pop();
  if (parts.length === 0) return { configured: false };
  const records = parts.every((part) => part.includes("\n"))
    ? parts.map((part) => part.split("\n"))
    : parts.length % 2 === 0
      ? Array.from({ length: parts.length / 2 }, (_, index) => [
          parts[index * 2],
          parts[index * 2 + 1],
        ])
      : [];
  if (
    records.length === 0 ||
    records.some(
      ([key, filter], index) =>
        records[index].length !== 2 || !key || filter === undefined,
    )
  ) {
    throw new WorkspaceGitError(
      "parse_error",
      "Git filter output was not key/value aligned",
    );
  }
  return { configured: true };
}

function parseAttributes(value: Buffer | string): ParsedAttributes {
  const parts = decodeUtf8(value).split("\0");
  if (parts.at(-1) !== "")
    throw new WorkspaceGitError(
      "parse_error",
      "Git attribute output was truncated",
    );
  parts.pop();
  if (parts.length % 3 !== 0)
    throw new WorkspaceGitError(
      "parse_error",
      "Git attribute output was malformed",
    );
  for (let index = 0; index < parts.length; index += 3) {
    const attribute = parts[index + 1];
    const valuePart = parts[index + 2];
    if (!parts[index] || !attribute || valuePart === undefined)
      throw new WorkspaceGitError(
        "parse_error",
        "Git attribute record was malformed",
      );
    if (attribute === "filter" && valuePart !== "unspecified")
      return { filtered: true };
  }
  return { filtered: false };
}

function filesystemIdentity(root: string): string {
  const canonical = realpathSync(root);
  const metadata = statSync(canonical);
  return `${metadata.dev}:${metadata.ino}:${canonical}`;
}

function adminState(
  gitDir: string,
  record: WorkspaceWorktreeRecord,
): WorkspaceAdminStatus {
  if (record.locked) return "locked";
  if (record.prunable) return "prunable";
  try {
    if (lstatSync(join(gitDir, "index.lock"))) return "locked";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
  }
  return "normal";
}

function hasInProgressMarker(gitDir: string): boolean {
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
  ]) {
    try {
      if (lstatSync(join(gitDir, marker))) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

function unknownObservation(root: string): WorktreeObservation {
  return {
    root: resolve(root),
    filesystemIdentity: "unknown",
    checkout: "unknown",
    status: "unknown",
    admin: "unknown",
  };
}

export class WorkspaceGitAdapter {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly hooksPath: string;
  private readonly runner: WorkspaceGitRunner;

  constructor(optionsOrRunner: WorkspaceGitOptions | WorkspaceGitRunner = {}) {
    const options =
      typeof optionsOrRunner === "function"
        ? { runner: optionsOrRunner }
        : optionsOrRunner;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new WorkspaceGitError("unavailable", "Git timeout is invalid");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new WorkspaceGitError("unavailable", "Git output bound is invalid");
    }
    const hooksPath =
      options.hooksPath ?? mkdtempSync(join(tmpdir(), "pi-subagentura-hooks-"));
    if (!isAbsolute(hooksPath) || hooksPath.includes("\0")) {
      throw new WorkspaceGitError(
        "unavailable",
        "private hooks path is invalid",
      );
    }
    mkdirSync(hooksPath, { recursive: true, mode: 0o700 });
    const hookMetadata = lstatSync(hooksPath);
    if (!hookMetadata.isDirectory() || (hookMetadata.mode & 0o777) !== 0o700) {
      throw new WorkspaceGitError(
        "unavailable",
        "private hooks path is unsafe",
      );
    }
    if (readdirSync(hooksPath).length !== 0) {
      throw new WorkspaceGitError(
        "unavailable",
        "private hooks path is not empty",
      );
    }
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.hooksPath = realpathSync(hooksPath);
    this.runner =
      options.runner ?? options.run ?? options.spawn ?? defaultRunner;
  }

  async run(
    args: readonly string[],
    cwd: string,
    options: {
      signal?: AbortSignal;
      input?: string | Buffer;
      mutation?: boolean;
    } = {},
  ): Promise<WorkspaceGitCommandResult> {
    assertArgv(args);
    if ((args[0] === "switch") !== (options.mutation === true)) {
      throw new WorkspaceGitError(
        "forbidden_command",
        "Git mutation requires the allowlisted mutation flag",
      );
    }
    const inputBytes =
      options.input === undefined ? 0 : asBuffer(options.input).byteLength;
    if (inputBytes > MAX_STATUS_BYTES)
      throw new WorkspaceGitError(
        "output_limit",
        "Git input exceeded its bound",
      );
    const result = await this.runner("git", args, {
      cwd: assertCwd(cwd),
      env: safeEnvironment(this.hooksPath),
      shell: false,
      input: options.input,
      signal: options.signal,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: Math.min(this.maxOutputBytes, MAX_STATUS_BYTES),
      maxStderrBytes: Math.min(this.maxOutputBytes, MAX_STATUS_BYTES),
    });
    const outputLimit = Math.min(this.maxOutputBytes, MAX_STATUS_BYTES);
    if (
      asBuffer(result.stdout).byteLength > outputLimit ||
      asBuffer(result.stderr).byteLength > outputLimit
    ) {
      throw new WorkspaceGitError(
        "output_limit",
        "Git output exceeded its bound",
      );
    }
    if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) {
      throw new WorkspaceGitError(
        "parse_error",
        "Git runner returned an invalid exit code",
      );
    }
    if (result.timedOut)
      throw new WorkspaceGitError("timeout", "Git command timed out");
    if (result.cancelled)
      throw new WorkspaceGitError("cancelled", "Git command was cancelled");
    if (result.outputLimited)
      throw new WorkspaceGitError(
        "output_limit",
        "Git output exceeded its bound",
      );
    if (result.spawnError)
      throw new WorkspaceGitError(
        "unavailable",
        "Git process could not be started",
      );
    return result;
  }

  runGit(
    args: readonly string[],
    cwd: string,
    options: {
      signal?: AbortSignal;
      input?: string | Buffer;
      mutation?: boolean;
    } = {},
  ): Promise<WorkspaceGitCommandResult> {
    return this.run(args, cwd, options);
  }

  private async read(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    input?: string | Buffer,
  ): Promise<WorkspaceGitCommandResult> {
    const result = await this.run(args, cwd, { signal, input });
    if (result.exitCode !== 0) {
      throw new WorkspaceGitError(
        "command_failed",
        "Git read command failed",
        result.exitCode ?? undefined,
      );
    }
    return result;
  }

  async probeRepository(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceRepositoryProbe> {
    const result = await this.read(
      [
        "rev-parse",
        "--show-toplevel",
        "--git-common-dir",
        "--git-dir",
        "--show-object-format",
        "--is-bare-repository",
        "--is-inside-work-tree",
      ],
      cwd,
      signal,
    );
    const lines = parseExactLines(result.stdout, 6);
    if (
      (lines[3] !== "sha1" && lines[3] !== "sha256") ||
      lines[4] !== "false" ||
      lines[5] !== "true"
    ) {
      throw new WorkspaceGitError(
        "parse_error",
        "Git repository identity is unsupported",
      );
    }
    const root = canonicalExistingPath(lines[0]);
    const commonDir = canonicalExistingPath(
      isAbsolute(lines[1]) ? lines[1] : resolve(root, lines[1]),
    );
    const gitDir = canonicalExistingPath(
      isAbsolute(lines[2]) ? lines[2] : resolve(root, lines[2]),
    );
    const repository = createRepositoryRecord({
      commonDir,
      gitDir,
      objectFormat: lines[3] as WorkspaceObjectFormat,
    });
    return { ...repository, root, bare: false };
  }

  async listWorktrees(
    repository: WorkspaceRepositoryProbe,
    signal?: AbortSignal,
  ): Promise<WorkspaceWorktreeRecord[]> {
    const result = await this.read(
      ["worktree", "list", "--porcelain", "-z"],
      repository.root,
      signal,
    );
    if (asBuffer(result.stdout).byteLength > MAX_WORKTREE_RECORD_BYTES * 128) {
      throw new WorkspaceGitError(
        "output_limit",
        "Git worktree output exceeded its bound",
      );
    }
    return parseWorktreeList(result.stdout, repository);
  }

  async probeWorktree(
    repository: WorkspaceRepositoryProbe,
    record: WorkspaceWorktreeRecord,
    signal?: AbortSignal,
  ): Promise<WorktreeObservation> {
    const root = canonicalExistingPath(record.root);
    if (record.adminKey === "unknown") {
      throw new WorkspaceGitError(
        "parse_error",
        "worktree administrative identity is unknown",
      );
    }
    if (root !== record.root)
      throw new WorkspaceGitError(
        "parse_error",
        "worktree root changed identity",
      );
    const statusResult = await this.read(
      [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      root,
      signal,
    );
    const status = parseStatus(statusResult.stdout);
    const indexResult = await this.read(["ls-files", "-v", "-z"], root, signal);
    const index = parseIndexFlags(indexResult.stdout);
    const filterResult = await this.read(
      [
        "config",
        "--null",
        "--get-regexp",
        "^filter\\..*(clean|smudge|process)$",
      ],
      root,
      signal,
    ).catch((error: unknown) => {
      // No matching filter config returns Git's normal exit status 1.
      if (
        error instanceof WorkspaceGitError &&
        error.code === "command_failed" &&
        error.exitCode === 1
      ) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw error;
    });
    const filters = parseFilters(filterResult.stdout);
    const attributes = index.paths.length
      ? parseAttributes(
          (
            await this.read(
              ["check-attr", "--all", "-z", "--stdin"],
              root,
              signal,
              index.paths.map((path) => `${path}\0`).join(""),
            )
          ).stdout,
        )
      : { filtered: false };
    const admin = adminState(record.gitDir, record);
    const inProgress = admin === "normal" && hasInProgressMarker(record.gitDir);
    let observationStatus: WorktreeObservation["status"] = "clean";
    if (status.conflicted) observationStatus = "conflicted";
    else if (admin !== "normal")
      observationStatus = admin === "unknown" ? "unknown" : "in_progress";
    else if (inProgress) observationStatus = "in_progress";
    else if (status.ignored) observationStatus = "ignored";
    else if (
      status.dirty ||
      index.hidden ||
      filters.configured ||
      attributes.filtered
    )
      observationStatus = "dirty";
    return {
      root,
      filesystemIdentity: filesystemIdentity(root),
      ...(record.branchRef ? { branchRef: record.branchRef } : {}),
      ...(record.headOid
        ? { headOid: fullOid(record.headOid, repository.objectFormat) }
        : {}),
      checkout: record.checkout,
      status: observationStatus,
      admin,
    };
  }

  async observeWorktree(
    repository: WorkspaceRepositoryProbe,
    record: WorkspaceWorktreeRecord,
    signal?: AbortSignal,
  ): Promise<WorktreeObservation> {
    try {
      return await this.probeWorktree(repository, record, signal);
    } catch (error) {
      if (
        error instanceof WorkspaceGitError &&
        ["timeout", "cancelled"].includes(error.code)
      )
        throw error;
      const unknown = unknownObservation(record.root);
      return {
        ...unknown,
        checkout: record.checkout,
        admin: record.locked
          ? "locked"
          : record.prunable
            ? "prunable"
            : "unknown",
      };
    }
  }

  async validateBranchRef(
    branchRef: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const short = shortBranchName(branchRef);
    const result = await this.read(
      ["check-ref-format", "--branch", short],
      cwd,
      signal,
    );
    const output = parseExactLines(result.stdout, 1);
    if (output[0] !== short)
      throw new WorkspaceGitError(
        "parse_error",
        "Git branch validation was not exact",
      );
    return short;
  }

  async resolveBranchOid(
    branchRef: string,
    repository: WorkspaceRepositoryProbe,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const short = shortBranchName(branchRef);
    await this.validateBranchRef(branchRef, repository.root, signal);
    const result = await this.run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${short}^{commit}`],
      repository.root,
      { signal },
    );
    if (result.exitCode !== 0) {
      if (result.exitCode === 1 || result.exitCode === 2) return undefined;
      throw new WorkspaceGitError(
        "command_failed",
        "Git branch lookup failed",
        result.exitCode ?? undefined,
      );
    }
    const lines = parseExactLines(result.stdout, 1);
    return fullOid(lines[0], repository.objectFormat);
  }

  async verifyObjectOid(
    candidateOid: string,
    repository: WorkspaceRepositoryProbe,
    signal?: AbortSignal,
  ): Promise<string> {
    const expected = fullOid(candidateOid, repository.objectFormat);
    const result = await this.run(
      ["rev-parse", "--verify", "--quiet", `${expected}^{commit}`],
      repository.root,
      { signal },
    );
    if (result.exitCode !== 0)
      throw new WorkspaceGitError(
        "branch_conflict",
        "Git base object was not found",
        result.exitCode ?? undefined,
      );
    const lines = parseExactLines(result.stdout, 1);
    const resolved = fullOid(lines[0], repository.objectFormat);
    if (resolved !== expected)
      throw new WorkspaceGitError(
        "parse_error",
        "Git base object did not resolve exactly",
      );
    return resolved;
  }

  async switchExistingBranch(
    branchRef: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const short = await this.validateBranchRef(branchRef, cwd, signal);
    const result = await this.run(["switch", "--no-guess", short], cwd, {
      signal,
      mutation: true,
    });
    if (result.exitCode !== 0)
      throw new WorkspaceGitError(
        "command_failed",
        "Git branch switch failed",
        result.exitCode ?? undefined,
      );
  }

  async createBranch(
    branchRef: string,
    baseOid: string,
    repository: WorkspaceRepositoryProbe,
    signal?: AbortSignal,
    workingCwd = repository.root,
  ): Promise<void> {
    const short = await this.validateBranchRef(branchRef, workingCwd, signal);
    const expected = fullOid(baseOid, repository.objectFormat);
    const result = await this.run(
      ["switch", "--create", short, expected],
      workingCwd,
      { signal, mutation: true },
    );
    if (result.exitCode !== 0)
      throw new WorkspaceGitError(
        "branch_conflict",
        "Git branch creation failed",
        result.exitCode ?? undefined,
      );
  }

  async observeRemoteRef(
    remote: string,
    ref: string,
    candidateOid: string,
    repository: WorkspaceRepositoryProbe,
    signal?: AbortSignal,
  ): Promise<RemoteObservation> {
    const safe = safeRemote(remote);
    if (!isFullBranchRef(ref))
      throw new WorkspaceGitError("parse_error", "publication ref is invalid");
    const expected = fullOid(candidateOid, repository.objectFormat);
    const result = await this.run(
      ["ls-remote", "--refs", "--exit-code", safe, ref],
      repository.root,
      { signal },
    );
    if (result.exitCode !== 0) {
      return result.exitCode === 1 || result.exitCode === 2
        ? { result: "not_advertised" }
        : { result: "unknown", errorCode: "unavailable" };
    }
    let lines: string[];
    try {
      lines = parseLines(result.stdout);
    } catch {
      return { result: "unknown", errorCode: "malformed" };
    }
    if (lines.length !== 1)
      return { result: "unknown", errorCode: "malformed" };
    const fields = lines[0].split("\t");
    if (fields.length !== 2 || fields[1] !== ref)
      return { result: "unknown", errorCode: "malformed" };
    let observedOid: string;
    try {
      observedOid = fullOid(fields[0], repository.objectFormat);
    } catch {
      return { result: "unknown", errorCode: "malformed" };
    }
    return {
      observedOid,
      result: observedOid === expected ? "equal" : "different",
      ...(observedOid === expected
        ? {}
        : { errorCode: "remote_changed" as const }),
    };
  }
}

export const WorkspaceGit = WorkspaceGitAdapter;
export const parseWorkspaceStatus = parseStatus;
export const parseWorkspaceIndexFlags = parseIndexFlags;
export const parseWorkspaceFilters = parseFilters;
export const parseWorkspaceAttributes = parseAttributes;
export const parseWorkspaceWorktreeList = parseWorktreeList;
export const workspaceUnknownObservation = unknownObservation;
export const workspaceFilesystemIdentity = filesystemIdentity;
export const workspaceFullOid = fullOid;
export const workspaceRemoteName = safeRemote;

export function createWorkspaceGitAdapter(
  options: WorkspaceGitOptions = {},
): WorkspaceGitAdapter {
  return new WorkspaceGitAdapter(options);
}

export const GitWorkspaceAdapter = WorkspaceGitAdapter;
export const parsePorcelainV2Status = parseStatus;
export const parseLsFilesFlags = parseIndexFlags;
export const parseWorktreeListPorcelain = parseWorktreeList;
