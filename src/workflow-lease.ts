import { lstat, mkdir, open, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const CURRENT_PROCESS_START_TIME = Math.floor(
  Date.now() - process.uptime() * 1000,
);

export interface WorkflowNamespaceLeaseRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  epoch: number;
  acquiredAt: number;
  processId?: number;
  processStartTime?: number;
}

export interface WorkflowOwnerFence {
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  leaseEpoch: number;
}

export interface WorkflowNamespaceLeaseOptions {
  rootDir: string;
  namespace: string;
  ownerId: string;
  leaseToken: string;
  ownerGeneration?: number;
  staleAfterMs?: number;
  now?: () => number;
  processId?: number;
  processStartTime?: number;
  processStartTimeForPid?: (
    processId: number,
  ) => number | undefined | Promise<number | undefined>;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface InterlockRecord {
  schemaVersion: 1;
  ownerId: string;
  leaseToken: string;
  lockToken: string;
  acquiredAt: number;
  processId?: number;
  processStartTime?: number;
}

const activeInterlockPaths = new Set<string>();

/**
 * Exclusive writer lease for one workflow namespace.
 *
 * Acquisition is create-only. A stale lease may be replaced only when its
 * record is valid and older than the configured threshold. Invalid or
 * ambiguous lease evidence fails closed rather than being overwritten.
 * Every authoritative operation also holds an interlock. This closes the
 * check-then-mutate window between lease validation and filesystem mutation.
 */
export class WorkflowNamespaceLease {
  private readonly path: string;
  private readonly interlockPath: string;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly processStartTimeForPid: (
    processId: number,
  ) => number | undefined | Promise<number | undefined>;
  private epoch = 0;
  private held = false;
  private interlockDepth = 0;
  private interlockFile?: Awaited<ReturnType<typeof open>>;
  private interlockIdentity?: FileIdentity;
  private interlockIdle: Promise<void> = Promise.resolve();
  private resolveInterlockIdle?: () => void;

  public constructor(private readonly options: WorkflowNamespaceLeaseOptions) {
    if (!options.ownerId || !options.leaseToken || !options.namespace) {
      throw new Error("Invalid workflow namespace lease identity");
    }
    if (
      options.ownerGeneration !== undefined &&
      (!Number.isSafeInteger(options.ownerGeneration) ||
        options.ownerGeneration < 0)
    ) {
      throw new Error("Invalid workflow namespace lease generation");
    }
    if (
      options.staleAfterMs !== undefined &&
      (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs <= 0)
    ) {
      throw new Error("Invalid workflow namespace lease timeout");
    }
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    const namespaceDir = join(options.rootDir, options.namespace);
    this.path = join(namespaceDir, "namespace.lease");
    this.interlockPath = join(namespaceDir, "namespace.interlock");
  }

  public get leaseEpoch(): number {
    return this.epoch;
  }

  public get isHeld(): boolean {
    return this.held;
  }

  public get activeOwnerFence(): WorkflowOwnerFence | undefined {
    if (!this.held) return undefined;
    return {
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      ...(this.options.ownerGeneration === undefined
        ? {}
        : { ownerGeneration: this.options.ownerGeneration }),
      leaseEpoch: this.epoch,
    };
  }

  public belongsTo(
    ownerId: string,
    leaseToken: string,
    ownerGeneration?: number,
  ): boolean {
    return (
      this.options.ownerId === ownerId &&
      this.options.leaseToken === leaseToken &&
      (ownerGeneration === undefined ||
        this.options.ownerGeneration === undefined ||
        this.options.ownerGeneration === ownerGeneration)
    );
  }

  public async acquire(): Promise<WorkflowNamespaceLeaseRecord> {
    if (this.held) {
      await this.assertHeld();
      const current = await this.read();
      if (!current) throw new Error("Workflow namespace lease disappeared");
      return current;
    }
    const namespaceDir = dirname(this.path);
    await mkdir(namespaceDir, { recursive: true, mode: 0o700 });
    await syncDirectory(this.options.rootDir);
    return this.withInterlock(async () => {
      const record = this.record(1);
      try {
        await this.writeExclusive(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await this.read();
        if (!current || this.now() - current.acquiredAt < this.staleAfterMs) {
          throw new Error("Workflow namespace lease is held");
        }
        if (
          current.processId !== undefined &&
          isProcessAlive(current.processId)
        ) {
          if (
            current.processId === process.pid &&
            current.processStartTime !== undefined &&
            current.processStartTime !== currentProcessStartTime()
          ) {
            throw new Error(
              "Workflow namespace lease process identity changed",
            );
          }
          throw new Error("Workflow namespace lease is held by a live process");
        }
        if (current.processId === undefined) {
          throw new Error("Workflow namespace lease identity is ambiguous");
        }
        const replacement = this.record(current.epoch + 1);
        await rm(this.path, { force: false });
        await syncDirectory(namespaceDir);
        try {
          await this.writeExclusive(replacement);
        } catch (retryError) {
          throw new Error("Workflow namespace lease takeover raced", {
            cause: retryError,
          });
        }
        this.epoch = replacement.epoch;
        this.held = true;
        return replacement;
      }
      this.epoch = record.epoch;
      this.held = true;
      return record;
    });
  }

  public async release(): Promise<void> {
    if (!this.held) return;
    if (this.interlockDepth > 0) await this.interlockIdle;
    if (!this.held) return;
    await this.withInterlock(async () => {
      const current = await this.read();
      if (
        current?.ownerId === this.options.ownerId &&
        current.leaseToken === this.options.leaseToken &&
        current.epoch === this.epoch
      ) {
        await rm(this.path, { force: false });
        await syncDirectory(dirname(this.path));
      }
      this.held = false;
    });
  }

  public async assertHeld(): Promise<void> {
    if (this.interlockDepth > 0) {
      await this.assertHeldUnlocked();
      return;
    }
    await this.withInterlock(async () => this.assertHeldUnlocked());
  }

  /** Run one filesystem mutation while the lease authority is interlocked. */
  public async withAuthority<T>(operation: () => Promise<T>): Promise<T> {
    await this.enterInterlock();
    try {
      await this.assertHeldUnlocked();
      return await operation();
    } finally {
      await this.leaveInterlock();
    }
  }

  private async assertHeldUnlocked(): Promise<void> {
    const current = await this.read();
    if (
      !this.held ||
      !current ||
      current.ownerId !== this.options.ownerId ||
      current.leaseToken !== this.options.leaseToken ||
      current.epoch !== this.epoch ||
      (this.options.ownerGeneration !== undefined &&
        current.ownerGeneration !== this.options.ownerGeneration)
    ) {
      throw new Error("Workflow namespace lease is not held");
    }
    const persistedEpoch = await this.readPersistedEpoch();
    if (persistedEpoch !== this.epoch) {
      throw new Error("Workflow namespace lease epoch changed");
    }
  }

  private record(epoch: number): WorkflowNamespaceLeaseRecord {
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      ...(this.options.ownerGeneration === undefined
        ? {}
        : { ownerGeneration: this.options.ownerGeneration }),
      epoch,
      acquiredAt: this.now(),
      processId: this.options.processId ?? process.pid,
      processStartTime:
        this.options.processStartTime ?? CURRENT_PROCESS_START_TIME,
    };
  }

  private interlockRecord(): InterlockRecord {
    return {
      schemaVersion: 1,
      ownerId: this.options.ownerId,
      leaseToken: this.options.leaseToken,
      lockToken: randomUUID(),
      acquiredAt: this.now(),
      ...(this.options.processId === undefined
        ? {}
        : {
            processId: this.options.processId,
            ...(this.options.processStartTime === undefined
              ? {}
              : { processStartTime: this.options.processStartTime }),
          }),
    };
  }

  private async withInterlock<T>(operation: () => Promise<T>): Promise<T> {
    await this.enterInterlock();
    try {
      return await operation();
    } finally {
      await this.leaveInterlock();
    }
  }

  private async enterInterlock(): Promise<void> {
    if (this.interlockDepth > 0) {
      this.interlockDepth++;
      return;
    }
    if (activeInterlockPaths.has(this.interlockPath))
      throw new Error("Workflow namespace lease interlock is held");
    await mkdir(dirname(this.interlockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      let file;
      try {
        file = await open(
          this.interlockPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        activeInterlockPaths.add(this.interlockPath);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "EEXIST" &&
          attempt === 0 &&
          (await recoverStaleInterlock(
            this.interlockPath,
            this.now,
            this.staleAfterMs,
          ))
        ) {
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Workflow namespace lease interlock is held", {
            cause: error,
          });
        }
        throw error;
      }
      try {
        const identity = fileIdentity(await file.stat());
        await writeFully(
          file,
          Buffer.from(`${JSON.stringify(this.interlockRecord())}\n`, "utf8"),
        );
        await file.sync();
        await assertDescriptorAndTarget(file, this.interlockPath, identity);
        this.interlockFile = file;
        this.interlockIdentity = identity;
        this.interlockIdle = new Promise<void>((resolve) => {
          this.resolveInterlockIdle = resolve;
        });
        this.interlockDepth = 1;
        return;
      } catch (error) {
        activeInterlockPaths.delete(this.interlockPath);
        try {
          await file.close();
        } catch (closeError) {
          throw new Error("Failed to close workflow namespace interlock", {
            cause: closeError,
          });
        }
        try {
          await rm(this.interlockPath, { force: false });
        } catch (cleanupError) {
          throw new Error("Failed to remove workflow namespace interlock", {
            cause: new AggregateError([error, cleanupError]),
          });
        }
        throw error;
      }
    }
    throw new Error("Workflow namespace interlock acquisition failed");
  }

  private async leaveInterlock(): Promise<void> {
    if (this.interlockDepth === 0) return;
    this.interlockDepth--;
    if (this.interlockDepth > 0) return;
    const file = this.interlockFile;
    const identity = this.interlockIdentity;
    this.interlockFile = undefined;
    this.interlockIdentity = undefined;
    try {
      if (!file || !identity)
        throw new Error("Workflow namespace interlock state is missing");
      await assertDescriptorAndTarget(file, this.interlockPath, identity);
      await rm(this.interlockPath, { force: false });
      await syncDirectory(dirname(this.interlockPath));
    } finally {
      activeInterlockPaths.delete(this.interlockPath);
      await file?.close();
      this.resolveInterlockIdle?.();
      this.resolveInterlockIdle = undefined;
      this.interlockIdle = Promise.resolve();
    }
  }

  private async writeExclusive(
    record: WorkflowNamespaceLeaseRecord,
  ): Promise<void> {
    const file = await open(
      this.path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await writeFully(
        file,
        Buffer.from(`${JSON.stringify(record)}\n`, "utf8"),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(this.path));
  }

  private async readPersistedEpoch(): Promise<number> {
    try {
      const info = await lstat(this.epochPath);
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error("Workflow namespace epoch path is not regular");
      }
      const text = await readFile(this.epochPath, "utf8");
      const epoch = Number(text.trim());
      if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error("Workflow namespace epoch is corrupt");
      }
      return epoch;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      if (error instanceof Error && error.message.includes("epoch"))
        throw error;
      throw new Error("Workflow namespace epoch is corrupt", { cause: error });
    }
  }

  private async persistEpoch(epoch: number): Promise<void> {
    if (!Number.isSafeInteger(epoch) || epoch <= 0) {
      throw new Error("Workflow namespace epoch is corrupt");
    }
    const file = await open(
      this.epochPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${epoch}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async read(): Promise<WorkflowNamespaceLeaseRecord | undefined> {
    let file;
    try {
      file = await open(
        this.path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const identity = fileIdentity(await file.stat());
      const parsed = JSON.parse((await file.readFile()).toString("utf8")) as
        WorkflowNamespaceLeaseRecord | undefined;
      await assertDescriptorAndTarget(file, this.path, identity);
      if (
        !parsed ||
        parsed.schemaVersion !== 1 ||
        typeof parsed.ownerId !== "string" ||
        parsed.ownerId.length === 0 ||
        typeof parsed.leaseToken !== "string" ||
        parsed.leaseToken.length === 0 ||
        !Number.isSafeInteger(parsed.epoch) ||
        parsed.epoch < 1 ||
        !Number.isSafeInteger(parsed.acquiredAt) ||
        parsed.acquiredAt < 0 ||
        (parsed.processId !== undefined &&
          (!Number.isSafeInteger(parsed.processId) || parsed.processId <= 0)) ||
        (parsed.processStartTime !== undefined &&
          (!Number.isSafeInteger(parsed.processStartTime) ||
            parsed.processStartTime < 0))
      ) {
        return undefined;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Workflow namespace lease is corrupt", { cause: error });
    } finally {
      await file?.close();
    }
  }
}

async function recoverStaleInterlock(
  path: string,
  now: () => number,
  staleAfterMs: number,
): Promise<boolean> {
  let file;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const identity = fileIdentity(await file.stat());
    const raw = (await file.readFile()).toString("utf8");
    const parsed = JSON.parse(raw) as Partial<InterlockRecord>;
    await assertDescriptorAndTarget(file, path, identity);
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.ownerId !== "string" ||
      parsed.ownerId.length === 0 ||
      typeof parsed.leaseToken !== "string" ||
      parsed.leaseToken.length === 0 ||
      typeof parsed.lockToken !== "string" ||
      parsed.lockToken.length === 0 ||
      typeof parsed.acquiredAt !== "number" ||
      !Number.isSafeInteger(parsed.acquiredAt) ||
      parsed.acquiredAt < 0 ||
      (parsed.processId !== undefined &&
        (!Number.isSafeInteger(parsed.processId) || parsed.processId <= 0)) ||
      (parsed.processStartTime !== undefined &&
        (!Number.isSafeInteger(parsed.processStartTime) ||
          parsed.processStartTime < 0))
    ) {
      throw new Error("Workflow namespace interlock is corrupt");
    }
    const acquiredAt = parsed.acquiredAt as number;
    if (now() - acquiredAt < staleAfterMs) {
      return false;
    }
    if (parsed.processId === undefined) {
      throw new Error("Workflow namespace interlock identity is ambiguous");
    }
    const samePidWithNewStart =
      parsed.processId === process.pid &&
      parsed.processStartTime !== undefined &&
      parsed.processStartTime !== currentProcessStartTime();
    if (!samePidWithNewStart && isProcessAlive(parsed.processId)) {
      return false;
    }
    await assertDescriptorAndTarget(file, path, identity);
    await rm(path, { force: false });
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (
      error instanceof Error &&
      error.message === "Workflow namespace interlock is held"
    )
      return false;
    throw error;
  } finally {
    await file?.close();
  }
}

function isProcessAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
}

function currentProcessStartTime(): number {
  return Math.floor(Date.now() - process.uptime() * 1000);
}

function fileIdentity(info: { dev: number; ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function assertDescriptorAndTarget(
  file: Awaited<ReturnType<typeof open>>,
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const descriptor = await file.stat();
  if (!descriptor.isFile() || descriptor.nlink !== 1)
    throw new Error(`Workflow storage path is not regular: ${path}`);
  const target = await lstat(path);
  if (!target.isFile() || target.nlink !== 1)
    throw new Error(`Workflow storage path is not regular: ${path}`);
  const targetIdentity = fileIdentity(target);
  if (
    expected.dev !== targetIdentity.dev ||
    expected.ino !== targetIdentity.ino
  )
    throw new Error(`Workflow storage descriptor changed: ${path}`);
  const descriptorIdentity = fileIdentity(descriptor);
  if (
    descriptorIdentity.dev !== targetIdentity.dev ||
    descriptorIdentity.ino !== targetIdentity.ino
  )
    throw new Error(`Workflow storage target changed: ${path}`);
}

async function writeFully(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      written,
    );
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0)
      throw new Error("Workflow namespace lease short write");
    written += result.bytesWritten;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
