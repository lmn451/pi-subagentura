import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const ORCHESTRATOR_WORKSPACE_SCHEMA_VERSION = 1;
export const ORCHESTRATOR_WORKSPACE_DIR = "subagentura";
export const ORCHESTRATOR_WORKSPACE_FILE = "workspaces.json";
export const ORCHESTRATOR_WORKSPACE_LOCK = "workspaces.lock";
export const ORCHESTRATOR_WORKSPACE_MUTATION_LOCK = "workspaces.mutation.lock";
export const ORCHESTRATOR_WORKSPACE_OWNER_MARKER =
  "subagentura-workspace-owner.json";
export const MAX_ORCHESTRATOR_WORKSPACE_BYTES = 2 * 1024 * 1024;
export const MAX_ORCHESTRATOR_WORKSPACE_ASSIGNMENTS = 128;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const CHILD_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{16})$/;
const REF = /^refs\/heads\/[A-Za-z0-9._/@+-]+$/;
const OID = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;

export type ManagedWorkspaceLifecycle =
  | "reserved"
  | "provisioning"
  | "ready"
  | "assigned"
  | "retained"
  | "released"
  | "blocked";

export interface ManagedWorkspaceRepository {
  backend: "git";
  repoId: string;
  commonDir: string;
  objectFormat: "sha1" | "sha256";
}

export interface ManagedWorkspaceAssignment {
  assignmentId: string;
  generation: number;
  agentId: string;
  workItemId: string;
  parentSessionId?: string;
  sourceCwd: string;
  baseOid: string;
  branchRef: string;
  worktreeRoot: string;
  workingCwd: string;
  identityHash: string;
  lifecycle: ManagedWorkspaceLifecycle;
  createdAt: number;
  updatedAt: number;
  closedErrorCode?: string;
}

export interface ManagedWorkspaceLedger {
  schemaVersion: 1;
  revision: number;
  repository: ManagedWorkspaceRepository;
  assignments: ManagedWorkspaceAssignment[];
}

export interface WorkspaceOwnerMarker {
  schemaVersion: 1;
  repoId: string;
  assignmentId: string;
  generation: number;
  agentId: string;
  identityHash: string;
  worktreeRoot: string;
  branchRef: string;
}

export class OrchestratorWorkspaceStateError extends Error {
  readonly code:
    | "missing"
    | "malformed"
    | "future_schema"
    | "capacity"
    | "cas_conflict"
    | "lock_held"
    | "unsafe_path"
    | "io";
  constructor(code: OrchestratorWorkspaceStateError["code"], message: string) {
    super(message);
    this.name = "OrchestratorWorkspaceStateError";
    this.code = code;
  }
}

function assertString(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      `${label} is invalid`,
    );
  if (
    Buffer.byteLength(value, "utf8") > 4_096 ||
    (pattern && !pattern.test(value))
  )
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      `${label} is invalid`,
    );
  return value;
}
function assertPath(value: unknown, label: string): string {
  const path = assertString(value, label);
  if (!path.startsWith("/"))
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      `${label} must be absolute`,
    );
  return path;
}
function assertOid(value: unknown, label: string): string {
  return assertString(value, label, OID).toLowerCase();
}
function assertLedger(value: unknown): ManagedWorkspaceLedger {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "ledger must be an object",
    );
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.some(
      (key) =>
        !["schemaVersion", "revision", "repository", "assignments"].includes(
          key,
        ),
    )
  )
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "ledger contains an unknown field",
    );
  if (object.schemaVersion !== 1)
    throw new OrchestratorWorkspaceStateError(
      object.schemaVersion && Number(object.schemaVersion) > 1
        ? "future_schema"
        : "malformed",
      "unsupported workspace schema",
    );
  if (!Number.isSafeInteger(object.revision) || Number(object.revision) < 0)
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "ledger revision is invalid",
    );
  const repository = object.repository as Record<string, unknown>;
  if (!repository || repository.backend !== "git")
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "Git repository identity is required",
    );
  const repositoryRecord: ManagedWorkspaceRepository = {
    backend: "git",
    repoId: assertString(
      repository.repoId,
      "repository.repoId",
      /^[a-f0-9]{64}$/i,
    ).toLowerCase(),
    commonDir: assertPath(repository.commonDir, "repository.commonDir"),
    objectFormat:
      repository.objectFormat === "sha1" || repository.objectFormat === "sha256"
        ? repository.objectFormat
        : (() => {
            throw new OrchestratorWorkspaceStateError(
              "malformed",
              "repository object format is invalid",
            );
          })(),
  };
  if (
    !Array.isArray(object.assignments) ||
    object.assignments.length > MAX_ORCHESTRATOR_WORKSPACE_ASSIGNMENTS
  )
    throw new OrchestratorWorkspaceStateError(
      "capacity",
      "workspace assignment capacity exceeded",
    );
  const assignments = object.assignments.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new OrchestratorWorkspaceStateError(
        "malformed",
        `assignment ${index} is invalid`,
      );
    const item = raw as Record<string, unknown>;
    const allowed = [
      "assignmentId",
      "generation",
      "agentId",
      "workItemId",
      "parentSessionId",
      "sourceCwd",
      "baseOid",
      "branchRef",
      "worktreeRoot",
      "workingCwd",
      "identityHash",
      "lifecycle",
      "createdAt",
      "updatedAt",
      "closedErrorCode",
    ];
    if (Object.keys(item).some((key) => !allowed.includes(key)))
      throw new OrchestratorWorkspaceStateError(
        "malformed",
        `assignment ${index} has an unknown field`,
      );
    const lifecycle = item.lifecycle;
    if (
      ![
        "reserved",
        "provisioning",
        "ready",
        "assigned",
        "retained",
        "released",
        "blocked",
      ].includes(String(lifecycle))
    )
      throw new OrchestratorWorkspaceStateError(
        "malformed",
        `assignment ${index} lifecycle is invalid`,
      );
    const generation = item.generation;
    if (!Number.isSafeInteger(generation) || Number(generation) < 0)
      throw new OrchestratorWorkspaceStateError(
        "malformed",
        `assignment ${index} generation is invalid`,
      );
    if (
      !Number.isSafeInteger(item.createdAt) ||
      !Number.isSafeInteger(item.updatedAt)
    )
      throw new OrchestratorWorkspaceStateError(
        "malformed",
        `assignment ${index} timestamp is invalid`,
      );
    return {
      assignmentId: assertString(
        item.assignmentId,
        `assignment ${index}.assignmentId`,
        SAFE_ID,
      ),
      generation: Number(generation),
      agentId: assertString(
        item.agentId,
        `assignment ${index}.agentId`,
        CHILD_ID,
      ),
      workItemId: assertString(
        item.workItemId,
        `assignment ${index}.workItemId`,
        SAFE_ID,
      ),
      ...(item.parentSessionId === undefined
        ? {}
        : {
            parentSessionId: assertString(
              item.parentSessionId,
              `assignment ${index}.parentSessionId`,
            ),
          }),
      sourceCwd: assertPath(item.sourceCwd, `assignment ${index}.sourceCwd`),
      baseOid: assertOid(item.baseOid, `assignment ${index}.baseOid`),
      branchRef: assertString(
        item.branchRef,
        `assignment ${index}.branchRef`,
        REF,
      ),
      worktreeRoot: assertPath(
        item.worktreeRoot,
        `assignment ${index}.worktreeRoot`,
      ),
      workingCwd: assertPath(item.workingCwd, `assignment ${index}.workingCwd`),
      identityHash: assertString(
        item.identityHash,
        `assignment ${index}.identityHash`,
        /^[a-f0-9]{64}$/i,
      ).toLowerCase(),
      lifecycle: lifecycle as ManagedWorkspaceLifecycle,
      createdAt: Number(item.createdAt),
      updatedAt: Number(item.updatedAt),
      ...(item.closedErrorCode === undefined
        ? {}
        : {
            closedErrorCode: assertString(
              item.closedErrorCode,
              `assignment ${index}.closedErrorCode`,
            ),
          }),
    };
  });
  if (
    new Set(assignments.map((item) => item.assignmentId)).size !==
    assignments.length
  )
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "duplicate workspace assignment",
    );
  return {
    schemaVersion: 1,
    revision: Number(object.revision),
    repository: repositoryRecord,
    assignments,
  };
}

function ensureDir(commonDir: string): string {
  if (!commonDir.startsWith("/") || commonDir.includes("\0"))
    throw new OrchestratorWorkspaceStateError(
      "unsafe_path",
      "common directory is invalid",
    );
  const directory = join(commonDir, ORCHESTRATOR_WORKSPACE_DIR);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export function workspaceStatePath(commonDir: string): string {
  return join(ensureDir(commonDir), ORCHESTRATOR_WORKSPACE_FILE);
}
export function workspaceStateLockPath(commonDir: string): string {
  return join(ensureDir(commonDir), ORCHESTRATOR_WORKSPACE_LOCK);
}
export function workspaceMutationLockPath(commonDir: string): string {
  return join(ensureDir(commonDir), ORCHESTRATOR_WORKSPACE_MUTATION_LOCK);
}

function readFileBounded(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new OrchestratorWorkspaceStateError(
      "io",
      "workspace state cannot be opened",
    );
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > MAX_ORCHESTRATOR_WORKSPACE_BYTES
    )
      throw new OrchestratorWorkspaceStateError(
        "unsafe_path",
        "workspace state file is unsafe",
      );
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size)
      offset += readSync(fd, buffer, offset, stat.size - offset, null);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadOrchestratorWorkspace(
  commonDir: string,
): ManagedWorkspaceLedger | undefined {
  const content = readFileBounded(workspaceStatePath(commonDir));
  if (content === undefined) return undefined;
  try {
    return assertLedger(JSON.parse(content));
  } catch (error) {
    if (error instanceof OrchestratorWorkspaceStateError) throw error;
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      "workspace state JSON is invalid",
    );
  }
}

function fsyncDir(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeOwnedLock(path: string, fd: number): void {
  try {
    const current = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
    try {
      const expected = fstatSync(fd);
      const actual = fstatSync(current);
      if (expected.dev === actual.dev && expected.ino === actual.ino)
        unlinkSync(path);
    } finally {
      closeSync(current);
    }
  } catch {
    /* A failed cleanup must not remove another process's lock. */
  }
}
function atomicWrite(commonDir: string, ledger: ManagedWorkspaceLedger): void {
  const directory = ensureDir(commonDir);
  const file = join(directory, ORCHESTRATOR_WORKSPACE_FILE);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(assertLedger(ledger), null, 2);
  if (Buffer.byteLength(content, "utf8") > MAX_ORCHESTRATOR_WORKSPACE_BYTES)
    throw new OrchestratorWorkspaceStateError(
      "capacity",
      "workspace state exceeds its byte limit",
    );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    chmodSync(temporary, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    fsyncDir(directory);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the original persistence error. */
    }
    if (error instanceof OrchestratorWorkspaceStateError) throw error;
    throw new OrchestratorWorkspaceStateError(
      "io",
      "workspace state write failed",
    );
  }
}

export function withOrchestratorWorkspaceLock<T>(
  commonDir: string,
  action: () => T,
  mutation = false,
): T {
  const directory = ensureDir(commonDir);
  const path = join(
    directory,
    mutation
      ? ORCHESTRATOR_WORKSPACE_MUTATION_LOCK
      : ORCHESTRATOR_WORKSPACE_LOCK,
  );
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new OrchestratorWorkspaceStateError(
        "lock_held",
        "workspace lock is held",
      );
    throw new OrchestratorWorkspaceStateError(
      "io",
      "workspace lock cannot be acquired",
    );
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fsyncSync(fd);
    return action();
  } finally {
    removeOwnedLock(path, fd);
    closeSync(fd);
    try {
      fsyncDir(directory);
    } catch {
      /* Directory fsync is best effort after release. */
    }
  }
}

export async function withOrchestratorWorkspaceMutationLock<T>(
  commonDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const directory = ensureDir(commonDir);
  const path = join(directory, ORCHESTRATOR_WORKSPACE_MUTATION_LOCK);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new OrchestratorWorkspaceStateError(
        "lock_held",
        "workspace mutation lock is held",
      );
    throw new OrchestratorWorkspaceStateError(
      "io",
      "workspace mutation lock cannot be acquired",
    );
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fsyncSync(fd);
    return await action();
  } finally {
    removeOwnedLock(path, fd);
    closeSync(fd);
    try {
      fsyncDir(directory);
    } catch {
      /* Best effort after mutation lock release. */
    }
  }
}

export function updateOrchestratorWorkspace(
  commonDir: string,
  expectedRevision: number,
  mutate: (ledger: ManagedWorkspaceLedger) => void,
  initial: ManagedWorkspaceLedger,
): ManagedWorkspaceLedger {
  return withOrchestratorWorkspaceLock(commonDir, () => {
    const current = loadOrchestratorWorkspace(commonDir);
    if (current === undefined) {
      if (expectedRevision !== 0 || initial.revision !== 0)
        throw new OrchestratorWorkspaceStateError(
          "cas_conflict",
          "workspace state is missing",
        );
      const next = structuredClone(initial);
      mutate(next);
      next.revision = 1;
      atomicWrite(commonDir, next);
      return assertLedger(next);
    }
    if (current.revision !== expectedRevision)
      throw new OrchestratorWorkspaceStateError(
        "cas_conflict",
        "workspace state revision changed",
      );
    const next = structuredClone(current);
    mutate(next);
    next.revision = expectedRevision + 1;
    atomicWrite(commonDir, next);
    return assertLedger(next);
  });
}

export function writeWorkspaceOwnerMarker(
  adminDir: string,
  marker: WorkspaceOwnerMarker,
): void {
  const path = join(adminDir, ORCHESTRATOR_WORKSPACE_OWNER_MARKER);
  const content = JSON.stringify(marker, null, 2);
  let fd: number | undefined;
  try {
    fd = openSync(
      `${path}.tmp`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(`${path}.tmp`, path);
    try {
      fsyncDir(adminDir);
    } catch {
      /* Marker durability is still protected by the atomic rename. */
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(`${path}.tmp`);
    } catch {
      /* Preserve marker write failure. */
    }
    throw error;
  }
}
export function readWorkspaceOwnerMarker(
  adminDir: string,
): WorkspaceOwnerMarker | undefined {
  const content = readFileBounded(
    join(adminDir, ORCHESTRATOR_WORKSPACE_OWNER_MARKER),
  );
  if (content === undefined) return undefined;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const allowed = [
      "schemaVersion",
      "repoId",
      "assignmentId",
      "generation",
      "agentId",
      "identityHash",
      "worktreeRoot",
      "branchRef",
    ];
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new Error("owner marker has an unknown field");
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation))
      throw new Error("owner marker is malformed");
    return {
      schemaVersion: 1,
      repoId: assertString(
        value.repoId,
        "owner marker repoId",
        /^[a-f0-9]{64}$/i,
      ),
      assignmentId: assertString(
        value.assignmentId,
        "owner marker assignmentId",
        SAFE_ID,
      ),
      generation: Number(value.generation),
      agentId: assertString(value.agentId, "owner marker agentId", CHILD_ID),
      identityHash: assertString(
        value.identityHash,
        "owner marker identityHash",
        /^[a-f0-9]{64}$/i,
      ),
      worktreeRoot: assertPath(value.worktreeRoot, "owner marker worktreeRoot"),
      branchRef: assertString(value.branchRef, "owner marker branchRef", REF),
    };
  } catch (error) {
    throw new OrchestratorWorkspaceStateError(
      "malformed",
      error instanceof Error ? error.message : "owner marker is malformed",
    );
  }
}
