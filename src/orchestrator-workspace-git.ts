import { spawn } from "node:child_process";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const REF = /^refs\/heads\/[A-Za-z0-9._/@+-]+$/;
const OID = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;

export interface OrchestratorGitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export type OrchestratorGitRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<OrchestratorGitResult>;

export interface OrchestratorRepository {
  root: string;
  commonDir: string;
  gitDir: string;
  repoId: string;
  objectFormat: "sha1" | "sha256";
}

export interface OrchestratorWorktree {
  root: string;
  adminDir: string;
  adminKey: string;
  branchRef?: string;
  headOid?: string;
  locked: boolean;
  prunable: boolean;
  workingTree: "clean" | "dirty" | "unknown";
}

export class OrchestratorWorkspaceGitError extends Error {
  readonly code:
    | "invalid_input"
    | "command_failed"
    | "timeout"
    | "unavailable"
    | "unsafe_state";
  constructor(code: OrchestratorWorkspaceGitError["code"], message: string) {
    super(message);
    this.name = "OrchestratorWorkspaceGitError";
    this.code = code;
  }
}

async function defaultRunner(
  args: readonly string[],
  cwd: string,
): Promise<OrchestratorGitResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "",
        GIT_EDITOR: "false",
        GIT_ASKPASS: "false",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else
        resolveResult({
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    };
    let exitCode: number | null = null;
    const append = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          /* The bounded command may have exited already. */
        }
        finish(
          new OrchestratorWorkspaceGitError(
            "unavailable",
            "Git output exceeded its bound",
          ),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      exitCode = code;
      finish();
    });
    timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* The process may have exited between the timeout and signal. */
      }
      finish(
        new OrchestratorWorkspaceGitError("timeout", "Git command timed out"),
      );
    }, DEFAULT_TIMEOUT_MS);
    timer.unref?.();
  });
}

function safePath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new OrchestratorWorkspaceGitError(
      "invalid_input",
      "Git path must be absolute",
    );
  return resolve(path);
}

function safeBranch(branchRef: string): string {
  if (!REF.test(branchRef) || branchRef.includes(".."))
    throw new OrchestratorWorkspaceGitError(
      "invalid_input",
      "branch ref is invalid",
    );
  return branchRef.slice("refs/heads/".length);
}

function safeOid(value: string): string {
  if (!OID.test(value) || /^0+$/.test(value))
    throw new OrchestratorWorkspaceGitError(
      "invalid_input",
      "base object id is invalid",
    );
  return value.toLowerCase();
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new OrchestratorWorkspaceGitError(
      "unavailable",
      "Git path cannot be canonicalized",
    );
  }
}

function adminIdentity(
  root: string,
  commonDir: string,
): {
  adminDir: string;
  adminKey: string;
} {
  const marker = join(root, ".git");
  const metadata = lstatSync(marker);
  if (metadata.isDirectory()) {
    const gitDir = canonical(marker);
    if (gitDir !== commonDir)
      throw new OrchestratorWorkspaceGitError(
        "unsafe_state",
        "main worktree Git directory changed",
      );
    return { adminDir: gitDir, adminKey: "main" };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new OrchestratorWorkspaceGitError(
      "unsafe_state",
      "worktree Git marker is not a regular file",
    );
  const content = requireMarker(marker);
  const match = /^gitdir:\s*(.+?)\s*$/.exec(content);
  if (!match)
    throw new OrchestratorWorkspaceGitError(
      "unsafe_state",
      "Git marker is malformed",
    );
  const adminDir = canonical(resolve(root, match[1]));
  const prefix = `${join(commonDir, "worktrees")}${sep}`;
  if (!adminDir.startsWith(prefix))
    throw new OrchestratorWorkspaceGitError(
      "unsafe_state",
      "Git admin directory escaped the repository",
    );
  const adminKey = adminDir.slice(prefix.length);
  if (!/^[A-Za-z0-9._-]+$/.test(adminKey))
    throw new OrchestratorWorkspaceGitError(
      "unsafe_state",
      "Git admin key is invalid",
    );
  return { adminDir, adminKey };
}

function requireMarker(path: string): string {
  return readFileSync(path, "utf8");
}

export class OrchestratorWorkspaceGit {
  private readonly runner: OrchestratorGitRunner;
  constructor(runner: OrchestratorGitRunner = defaultRunner) {
    this.runner = runner;
  }

  private async run(
    args: readonly string[],
    cwd: string,
    mutation = false,
  ): Promise<OrchestratorGitResult> {
    const command = args[0];
    const allowedRead =
      command === "rev-parse" || command === "worktree" || command === "status";
    const allowedMutation = command === "worktree" && args[1] === "add";
    if ((!mutation && !allowedRead) || (mutation && !allowedMutation))
      throw new OrchestratorWorkspaceGitError(
        "invalid_input",
        "Git command is not allowlisted",
      );
    if (
      mutation &&
      (args.includes("--force") ||
        args.includes("-f") ||
        args.includes("remove"))
    )
      throw new OrchestratorWorkspaceGitError(
        "invalid_input",
        "destructive Git operation is forbidden",
      );
    const result = await this.runner(args, safePath(cwd));
    if (result.exitCode !== 0)
      throw new OrchestratorWorkspaceGitError(
        "command_failed",
        "Git command failed",
      );
    return result;
  }

  async probeRepository(cwd: string): Promise<OrchestratorRepository> {
    const result = await this.run(
      [
        "rev-parse",
        "--show-toplevel",
        "--git-common-dir",
        "--git-dir",
        "--show-object-format",
        "--is-bare-repository",
      ],
      cwd,
    );
    const lines = result.stdout.trimEnd().split("\n");
    if (
      lines.length !== 5 ||
      (lines[3] !== "sha1" && lines[3] !== "sha256") ||
      lines[4] !== "false"
    )
      throw new OrchestratorWorkspaceGitError(
        "unsafe_state",
        "Git repository identity is unsupported",
      );
    const root = canonical(lines[0]!);
    const commonDir = canonical(
      isAbsolute(lines[1]!) ? lines[1]! : resolve(root, lines[1]!),
    );
    const gitDir = canonical(
      isAbsolute(lines[2]!) ? lines[2]! : resolve(root, lines[2]!),
    );
    const objectFormat = lines[3] as "sha1" | "sha256";
    const { createHash } = await import("node:crypto");
    const repoId = createHash("sha256")
      .update(
        `pi-subagentura:orchestrator-workspace:v1\0${commonDir}\0${objectFormat}`,
      )
      .digest("hex");
    return { root, commonDir, gitDir, repoId, objectFormat };
  }

  async listWorktrees(
    repository: OrchestratorRepository,
  ): Promise<OrchestratorWorktree[]> {
    const result = await this.run(
      ["worktree", "list", "--porcelain", "-z"],
      repository.root,
    );
    const records = result.stdout.split("\0");
    const worktrees: OrchestratorWorktree[] = [];
    for (let index = 0; index < records.length; index++) {
      if (!records[index]) continue;
      const fields = new Map<string, string>();
      const first = records[index]!;
      const addField = (field: string): void => {
        const split = field.indexOf(" ");
        const key = split < 0 ? field : field.slice(0, split);
        const value = split < 0 ? "" : field.slice(split + 1);
        if (
          !["worktree", "HEAD", "branch", "locked", "prunable"].includes(key) ||
          fields.has(key)
        )
          throw new OrchestratorWorkspaceGitError(
            "unsafe_state",
            "Git worktree output is malformed",
          );
        fields.set(key, value);
      };
      addField(first);
      while (index + 1 < records.length && records[index + 1])
        addField(records[++index]!);
      const rawRoot = fields.get("worktree");
      if (!rawRoot)
        throw new OrchestratorWorkspaceGitError(
          "unsafe_state",
          "Git worktree has no root",
        );
      let root: string;
      try {
        root = canonical(rawRoot);
      } catch {
        root = resolve(rawRoot);
      }
      let identity: { adminDir: string; adminKey: string };
      try {
        identity = adminIdentity(root, repository.commonDir);
      } catch {
        identity = {
          adminDir: join(repository.commonDir, "worktrees", "unknown"),
          adminKey: "unknown",
        };
      }
      const branchRef = fields.get("branch");
      if (branchRef !== undefined && !REF.test(branchRef))
        throw new OrchestratorWorkspaceGitError(
          "unsafe_state",
          "Git branch ref is malformed",
        );
      const head = fields.get("HEAD");
      const headOid =
        head && OID.test(head) && !/^0+$/.test(head)
          ? head.toLowerCase()
          : undefined;
      const status = await this.probeStatus(root);
      worktrees.push({
        root,
        ...identity,
        ...(branchRef ? { branchRef } : {}),
        ...(headOid ? { headOid } : {}),
        locked: fields.has("locked"),
        prunable: fields.has("prunable"),
        workingTree: status,
      });
    }
    return worktrees;
  }

  private async probeStatus(
    cwd: string,
  ): Promise<"clean" | "dirty" | "unknown"> {
    try {
      const result = await this.run(
        [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
        ],
        cwd,
      );
      return result.stdout.length === 0 ? "clean" : "dirty";
    } catch {
      return "unknown";
    }
  }

  async addLockedWorktree(
    repository: OrchestratorRepository,
    branchRef: string,
    root: string,
    baseOid: string,
  ): Promise<void> {
    const branch = safeBranch(branchRef);
    const path = safePath(root);
    safeOid(baseOid);
    try {
      lstatSync(path);
      throw new OrchestratorWorkspaceGitError(
        "unsafe_state",
        "workspace path already exists",
      );
    } catch (error) {
      if (error instanceof OrchestratorWorkspaceGitError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.run(
      ["worktree", "add", "--lock", "-b", branch, path, baseOid],
      repository.root,
      true,
    );
  }

  async observeWorktree(
    repository: OrchestratorRepository,
    root: string,
  ): Promise<OrchestratorWorktree | undefined> {
    const worktrees = await this.listWorktrees(repository);
    return worktrees.find((worktree) => worktree.root === canonical(root));
  }
}
