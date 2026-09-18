import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";

/** A new format, deliberately unrelated to the removed experimental plan store. */
export const WORKFLOW_RUN_FORMAT = 1;
export const MAX_RUN_BYTES = 256 * 1024 * 1024;
export const MAX_RUN_EVENT_BYTES = 4 * 1024 * 1024;
const RUN_ID = /^wfd_[a-f0-9]{32}$/;
const EVENT_KINDS = new Set([
  "created",
  "request",
  "response",
  "attempt",
  "outcome",
  "process",
  "progress",
  "interrupted",
  "terminal",
  "cancelled",
  "accepted",
  "dispatch",
  "delivery",
]);

export interface RunScope {
  cwd: string;
  sessionId: string;
  /** Tests may supply a private temporary store. Never taken from workflow args. */
  root?: string;
}

export interface RunEvent {
  kind: string;
  data: any;
}

export class WorkflowPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkflowPersistenceError";
  }
}

export class WorkflowRecoveryRequiredError extends WorkflowPersistenceError {}

export function requiresWorkflowRecovery(error: unknown): boolean {
  for (let depth = 0; depth < 6 && error instanceof Error; depth++) {
    if (error instanceof WorkflowRecoveryRequiredError) return true;
    error = error.cause;
  }
  return false;
}

export function encodeRunValue(value: unknown): string {
  let bytes: Buffer;
  try {
    bytes = serialize(value);
  } catch (error) {
    throw new WorkflowPersistenceError(
      "Workflow value cannot be durably serialized.",
      error,
    );
  }
  if (bytes.length > MAX_RUN_EVENT_BYTES / 2) {
    throw new WorkflowPersistenceError("Durable workflow value exceeds 2 MiB.");
  }
  return bytes.toString("base64");
}

export function decodeRunValue<T = unknown>(value: string): T {
  if (typeof value !== "string" || value.length > MAX_RUN_EVENT_BYTES) {
    throw new WorkflowPersistenceError("Invalid durable workflow value.");
  }
  return deserialize(Buffer.from(value, "base64")) as T;
}

/** V8 bytes are a storage encoding, not a canonical value fingerprint. */
export function runValueMatches(recorded: string, current: unknown): boolean {
  const left = decodeRunValue(recorded);
  const right = decodeRunValue(encodeRunValue(current));
  if (!isDeepStrictEqual(left, right)) return false;
  const pairs = new Map<object, object>();
  const reverse = new Set<object>();
  function ordered(a: any, b: any): boolean {
    if (a === null || typeof a !== "object") return Object.is(a, b);
    if (pairs.has(a)) return pairs.get(a) === b;
    if (reverse.has(b)) return false;
    pairs.set(a, b);
    reverse.add(b);
    // Map/Set iteration and reference sharing are observable by the program;
    // deep equality alone deliberately ignores these distinctions.
    if (a instanceof Map) return ordered([...a], [...b]);
    if (a instanceof Set) return ordered([...a], [...b]);
    const keys = Object.keys(a);
    const other = Object.keys(b);
    return (
      keys.length === other.length &&
      keys.every((key, i) => key === other[i] && ordered(a[key], b[key]))
    );
  }
  return ordered(left, right);
}

async function scopeDirectory(scope: RunScope): Promise<string> {
  if (!scope.sessionId || typeof scope.sessionId !== "string") {
    throw new WorkflowPersistenceError(
      "Durable workflows require a stable Pi session id.",
    );
  }
  const cwd = await realpath(scope.cwd);
  const key = createHash("sha256")
    .update(JSON.stringify([hostname(), cwd, scope.sessionId]))
    .digest("hex");
  return join(
    scope.root ?? join(homedir(), ".pi-subagentura", "workflow-runs"),
    "v1",
    key,
  );
}

async function readBounded(path: string, max = MAX_RUN_BYTES): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > max) {
      throw new WorkflowPersistenceError(
        "Invalid or oversized workflow run file.",
      );
    }
    // Bound the read even if another process appends after stat.
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
}

function ownerIsDead(owner: LockOwner): boolean {
  if (
    owner.host !== hostname() ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM and unrecognised errors are not evidence of death. PID reuse blocks
    // recovery conservatively; a timeout is never permission to steal a lease.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function claimLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, "owner.json");
  const token = randomUUID();
  const owner: LockOwner = { pid: process.pid, host: hostname(), token };
  // Link/rename contenders must never unlink a newly replaced owner. A separate
  // short recovery lock serializes the read/dead-check/removal with acquisition.
  const guard = join(directory, "claim.json");
  const candidate = join(directory, `claim-${token}.json`);
  const file = await open(candidate, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
    await file.sync();
  } finally {
    await file.close();
  }
  const { link } = await import("node:fs/promises");
  try {
    try {
      await link(candidate, guard);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = JSON.parse(
        (await readBounded(guard, 4096)).toString(),
      ) as LockOwner;
      if (!ownerIsDead(prior))
        throw new WorkflowPersistenceError(
          "Workflow run is locked by another controller.",
        );
      // A crashed claim is not auto-removed: two simultaneous reapers could
      // otherwise delete each other's lock. Fail closed with a recoverable file.
      throw new WorkflowPersistenceError(
        "Workflow claim was interrupted. Inspect the dead controller's claim.json before removing it.",
      );
    }
    try {
      try {
        const prior = JSON.parse(
          (await readBounded(path, 4096)).toString(),
        ) as LockOwner;
        if (!ownerIsDead(prior))
          throw new WorkflowPersistenceError(
            "Workflow run is already owned by a live controller.",
          );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await rename(candidate, path);
      await syncDirectory(directory);
    } finally {
      await unlink(guard);
    }
  } finally {
    try {
      await unlink(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return async () => {
    const current = JSON.parse(
      (await readBounded(path, 4096)).toString(),
    ) as LockOwner;
    if (current.token !== token)
      throw new WorkflowPersistenceError(
        "Workflow ownership changed before release.",
      );
    await unlink(path);
    await syncDirectory(directory);
  };
}

async function parseJournal(bytes: Buffer): Promise<{
  events: RunEvent[];
  checksum: string;
  length: number;
}> {
  const events: RunEvent[] = [];
  let checksum = "";
  let length = 0;
  let lastYield = 0;
  while (length < bytes.length) {
    const end = bytes.indexOf(10, length);
    if (end === -1) break; // Only an incomplete final line is recoverable.
    if (end - length > MAX_RUN_EVENT_BYTES)
      throw new WorkflowPersistenceError("Oversized workflow journal event.");
    const row = JSON.parse(bytes.subarray(length, end).toString("utf8"));
    const { hash, ...content } = row;
    const expected = createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
    if (
      hash !== expected ||
      content.previous !== checksum ||
      content.sequence !== events.length ||
      !EVENT_KINDS.has(content.kind)
    ) {
      throw new WorkflowPersistenceError(
        "Workflow journal is corrupt; refusing recovery.",
      );
    }
    events.push({ kind: content.kind, data: content.data });
    checksum = hash;
    length = end + 1;
    if (length - lastYield >= 256 * 1024) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = length;
    }
  }
  if (
    events.length === 0 ||
    events[0].kind !== "created" ||
    events[0].data.format !== WORKFLOW_RUN_FORMAT
  ) {
    throw new WorkflowPersistenceError(
      "Unsupported or incomplete workflow run format.",
    );
  }
  return { events, checksum, length };
}

/** Serialized, fsynced append log. A failed append poisons this writer. */
export class WorkflowRunStore {
  readonly events: RunEvent[];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(
    readonly id: string,
    readonly directory: string,
    private file: FileHandle,
    private release: () => Promise<void>,
    events: RunEvent[],
    private checksum: string,
    private length: number,
  ) {
    this.events = events;
  }

  static async create(
    scope: RunScope,
    definition: object,
  ): Promise<WorkflowRunStore> {
    const id = `wfd_${randomUUID().replaceAll("-", "")}`;
    const parent = await scopeDirectory(scope);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = join(parent, id);
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(parent);
    const release = await claimLock(directory);
    const file = await open(join(directory, "journal.ndjson"), "ax", 0o600);
    const store = new WorkflowRunStore(id, directory, file, release, [], "", 0);
    try {
      await store.append("created", {
        ...definition,
        format: WORKFLOW_RUN_FORMAT,
        id,
        host: hostname(),
        cwd: await realpath(scope.cwd),
        sessionId: scope.sessionId,
        createdAt: Date.now(),
        nodeMajor: process.versions.node.split(".")[0],
      });
      await syncDirectory(directory);
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  static async inspect(
    scope: RunScope,
    id: string,
  ): Promise<RunEvent[] | undefined> {
    if (!RUN_ID.test(id)) return undefined;
    try {
      const directory = join(await scopeDirectory(scope), id);
      return (
        await parseJournal(await readBounded(join(directory, "journal.ndjson")))
      ).events;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  static async list(scope: RunScope): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = await readdir(await scopeDirectory(scope), {
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
        .map((e) => e.name)
        .sort()
        .slice(0, 1000);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  static async resume(scope: RunScope, id: string): Promise<WorkflowRunStore> {
    if (!RUN_ID.test(id))
      throw new WorkflowPersistenceError("Invalid durable workflow run id.");
    const directory = join(await scopeDirectory(scope), id);
    const release = await claimLock(directory);
    let file: FileHandle | undefined;
    try {
      const path = join(directory, "journal.ndjson");
      const journal = await parseJournal(await readBounded(path));
      const created = journal.events[0].data;
      if (
        created.id !== id ||
        created.host !== hostname() ||
        created.cwd !== (await realpath(scope.cwd)) ||
        created.sessionId !== scope.sessionId ||
        created.nodeMajor !== process.versions.node.split(".")[0]
      ) {
        throw new WorkflowPersistenceError(
          "Workflow run does not match this host, cwd, Pi session, or Node major version.",
        );
      }
      file = await open(
        path,
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      await file.truncate(journal.length);
      await file.sync();
      return new WorkflowRunStore(
        id,
        directory,
        file,
        release,
        journal.events,
        journal.checksum,
        journal.length,
      );
    } catch (error) {
      await file?.close();
      await release();
      throw error;
    }
  }

  append(kind: string, data: unknown): Promise<void> {
    if (this.closed)
      return Promise.reject(
        new WorkflowPersistenceError("Workflow writer is closed."),
      );
    this.tail = this.tail.then(async () => {
      if (!EVENT_KINDS.has(kind))
        throw new WorkflowPersistenceError("Unknown workflow event kind.");
      const content = {
        sequence: this.events.length,
        previous: this.checksum,
        kind,
        data,
      };
      const hash = createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex");
      const line = Buffer.from(JSON.stringify({ ...content, hash }) + "\n");
      if (
        line.length > MAX_RUN_EVENT_BYTES ||
        this.length + line.length > MAX_RUN_BYTES
      ) {
        throw new WorkflowPersistenceError(
          "Workflow journal storage bound exceeded.",
        );
      }
      await this.file.writeFile(line);
      await this.file.sync();
      this.events.push({ kind, data });
      this.checksum = hash;
      this.length += line.length;
    });
    return this.tail;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.tail;
    } finally {
      try {
        await this.file.close();
      } finally {
        await this.release();
      }
    }
  }
}
