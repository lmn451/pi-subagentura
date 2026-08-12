import { mkdir, lstat, open, readdir, rename, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  WorkflowAppendReceipt,
  WorkflowEventEnvelope,
  WorkflowOwnerIdentity,
  WorkflowRunLaunch,
} from "./workflow-run-types";
import { validateWorkflowRunId } from "./workflow-run-types";
import { WorkflowNamespaceLease } from "./workflow-lease";
import { toDurableValue } from "./workflow-durable-value";
import { validateWorkflowPlan, type WorkflowPlan } from "./workflow-plan";

export type WorkflowConditionalAppendResult =
  | { status: "appended"; receipt: WorkflowAppendReceipt }
  | { status: "conflict"; actualLastEventOrdinal: number };

export interface WorkflowRunStoreOptions {
  rootDir: string;
  owner: WorkflowOwnerIdentity;
  maxEventBytes?: number;
  maxRunBytes?: number;
  maxRuns?: number;
  maxOwnerBytes?: number;
}

export interface WorkflowRunRecord {
  launch: WorkflowRunLaunch;
  events: WorkflowEventEnvelope[];
}

export interface WorkflowRunEventLog {
  readonly events: readonly WorkflowEventEnvelope[];
  readonly completeBytes: number;
  readonly tornTailBytes: number;
}

export interface WorkflowRunCreationEvent<P = unknown> {
  type: "run_created";
  payload: P;
  runEpoch?: number;
}

export class WorkflowRunCorruptionError extends Error {
  public readonly code = "WORKFLOW_RUN_CORRUPT";

  public constructor(
    public readonly runId: string,
    cause: unknown,
  ) {
    super(`Durable workflow run ${runId} is corrupt`, { cause });
    this.name = "WorkflowRunCorruptionError";
  }
}

export class WorkflowRunStorageError extends Error {
  public readonly code: "ENOSPC";

  public constructor(
    public readonly runId: string,
    cause: unknown,
  ) {
    super(`Durable workflow run ${runId} could not be persisted`, { cause });
    this.name = "WorkflowRunStorageError";
    this.code = "ENOSPC";
  }
}

export class WorkflowRunQuotaError extends Error {
  public readonly code = "QUOTA" as const;

  public constructor(
    public readonly runId: string,
    public readonly quota: "event" | "run byte" | "owner byte" | "run count",
  ) {
    super(`Durable workflow ${quota} quota exceeded for ${runId}`);
    this.name = "WorkflowRunQuotaError";
  }
}

function safePart(value: string, label: string): string {
  if (
    !value ||
    value.length > 200 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Invalid workflow ${label}`);
  }
  return value;
}

const CREATION_PREFIX = ".creating-";
const CREATION_STALE_AFTER_MS = 5 * 60_000;
const CREATION_NAME_PATTERN =
  /^\.creating-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const TOMBSTONE_PREFIX = ".tombstone-";
const MAX_CREATION_PLAN_BYTES = 512 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_KEYS = new Set([
  "schemaVersion",
  "eventId",
  "eventOrdinal",
  "runId",
  "runEpoch",
  "type",
  "payload",
]);

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ParsedJournal {
  events: WorkflowEventEnvelope[];
  completeBytes: number;
  tornTailBytes: number;
}

interface ReadRunResult {
  record: WorkflowRunRecord;
  tornTailBytes: number;
  completeBytes: number;
}

export class WorkflowRunStore {
  private static readonly leases = new Map<string, WorkflowNamespaceLease>();
  private static readonly locks = new Map<string, Promise<void>>();
  private readonly root: string;
  private readonly leaseKey: string;

  public static async releaseAllLeases(owner?: {
    ownerId: string;
    leaseToken: string;
  }): Promise<void> {
    const leaseEntries = [...WorkflowRunStore.leases.entries()];
    const entries =
      owner === undefined
        ? leaseEntries
        : leaseEntries.filter(([, lease]) =>
            lease.belongsTo(owner.ownerId, owner.leaseToken),
          );
    for (const [key, lease] of entries) {
      await lease.release();
      if (WorkflowRunStore.leases.get(key) === lease)
        WorkflowRunStore.leases.delete(key);
    }
  }

  constructor(private readonly options: WorkflowRunStoreOptions) {
    this.root = join(
      options.rootDir,
      safePart(options.owner.projectKey, "project key"),
      safePart(options.owner.piSessionId, "session id"),
    );
    this.leaseKey = this.root;
  }

  private async assertNamespaceLease(): Promise<WorkflowNamespaceLease> {
    let lease = WorkflowRunStore.leases.get(this.leaseKey);
    if (lease && !lease.isHeld) {
      WorkflowRunStore.leases.delete(this.leaseKey);
      lease = undefined;
    }
    if (
      lease &&
      !lease.belongsTo(
        this.options.owner.ownerId,
        this.options.owner.leaseToken,
      )
    ) {
      throw new Error("Workflow namespace lease is held by a different owner");
    }
    if (!lease) {
      lease = new WorkflowNamespaceLease({
        rootDir: this.root,
        namespace: "namespace",
        ownerId: this.options.owner.ownerId,
        leaseToken: this.options.owner.leaseToken,
        processId: process.pid,
        processStartTime: Math.floor(Date.now() - process.uptime() * 1000),
      });
      WorkflowRunStore.leases.set(this.leaseKey, lease);
    }
    if (!lease.isHeld) await lease.acquire();
    await lease.assertHeld();
    return lease;
  }

  public async getLeaseEpoch(): Promise<number> {
    const held = WorkflowRunStore.leases.get(this.leaseKey);
    if (
      held?.isHeld &&
      held.belongsTo(this.options.owner.ownerId, this.options.owner.leaseToken)
    )
      return held.leaseEpoch;
    const lease = await this.assertNamespaceLease();
    return lease.leaseEpoch;
  }

  public async release(): Promise<void> {
    const lease = WorkflowRunStore.leases.get(this.leaseKey);
    if (
      !lease ||
      !lease.belongsTo(
        this.options.owner.ownerId,
        this.options.owner.leaseToken,
      )
    )
      return;
    await lease.release();
    if (WorkflowRunStore.leases.get(this.leaseKey) === lease)
      WorkflowRunStore.leases.delete(this.leaseKey);
  }

  private async assertRegularFile(path: string): Promise<void> {
    const info = await lstat(path);
    assertRegularFileStats(path, info);
  }

  private async assertRegularDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.nlink < 1)
      throw new Error(`Workflow storage path is not a directory: ${path}`);
  }

  async createRun(
    input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
  ): Promise<WorkflowRunLaunch> {
    return this.withLock(input.runId, async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(() => this.createRunInternal(input));
    });
  }

  /**
   * Publish a new run only after launch.json and its initial journal prefix are
   * fully written and synced in a private directory.
   */
  async createRunWithInitialEvent<P>(
    input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
    initialEvent: WorkflowRunCreationEvent<P>,
  ): Promise<WorkflowRunLaunch> {
    return this.withLock(input.runId, async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(() =>
        this.createRunInternal(input, initialEvent),
      );
    });
  }

  private async createRunInternal<P>(
    input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
    initialEvent?: WorkflowRunCreationEvent<P>,
  ): Promise<WorkflowRunLaunch> {
    await this.assertNamespaceLease();
    validateWorkflowRunId(input.runId);
    assertSameOwner(input.owner, this.options.owner);
    validateLaunchInput(input);
    if (
      this.options.maxRuns !== undefined &&
      (!Number.isSafeInteger(this.options.maxRuns) || this.options.maxRuns <= 0)
    ) {
      throw new Error("Invalid workflow run count quota");
    }
    if (
      this.options.maxRuns !== undefined &&
      (await this.listRunIds()).length >= this.options.maxRuns
    ) {
      throw new WorkflowRunQuotaError(input.runId, "run count");
    }
    const launch: WorkflowRunLaunch = {
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
    };
    const runsDir = this.runsDir();
    const dir = this.runDir(launch.runId);
    const tombstone = this.tombstoneDir(launch.runId);
    const tempDir = join(
      runsDir,
      `${CREATION_PREFIX}${launch.runId}-${randomUUID()}`,
    );
    let published = false;
    try {
      await this.ensureStorageDirectories();
      if (await pathExists(dir))
        throw new Error(`Workflow run already exists: ${launch.runId}`);
      if (await pathExists(tombstone))
        throw new Error(
          `Workflow run has a pending retention tombstone: ${launch.runId}`,
        );
      await mkdir(tempDir, { mode: 0o700 });
      await this.assertRegularDirectory(tempDir);
      await writeSyncedFile(
        join(tempDir, "launch.json"),
        `${JSON.stringify(launch)}\n`,
        0o600,
      );
      const creationPayload =
        initialEvent === undefined
          ? undefined
          : normalizeCreationPayload(initialEvent);
      const eventBytes =
        initialEvent === undefined
          ? Buffer.alloc(0)
          : serializeEvent(
              {
                schemaVersion: 1,
                eventId: randomUUID(),
                eventOrdinal: 0,
                runId: launch.runId,
                runEpoch: initialEvent.runEpoch ?? 0,
                type: initialEvent.type,
                payload: creationPayload,
              },
              launch.runId,
            );
      if (initialEvent !== undefined) {
        assertQuota(this.options.maxEventBytes, "event");
        assertQuota(this.options.maxRunBytes, "run byte");
        if (
          this.options.maxEventBytes !== undefined &&
          eventBytes.length > this.options.maxEventBytes
        )
          throw new WorkflowRunQuotaError(launch.runId, "event");
        if (
          this.options.maxRunBytes !== undefined &&
          eventBytes.length > this.options.maxRunBytes
        )
          throw new WorkflowRunQuotaError(launch.runId, "run byte");
        assertQuota(this.options.maxOwnerBytes, "owner byte");
        if (this.options.maxOwnerBytes !== undefined) {
          let ownerBytes = 0;
          for (const existingRunId of await this.listRunIds()) {
            ownerBytes += (
              await this.readEventBytes(this.runDir(existingRunId))
            ).length;
          }
          if (ownerBytes + eventBytes.length > this.options.maxOwnerBytes)
            throw new WorkflowRunQuotaError(launch.runId, "owner byte");
        }
      }
      await writeSyncedFile(join(tempDir, "events.ndjson"), eventBytes, 0o600);
      await syncDirectory(tempDir);
      await this.assertNamespaceLease();
      await this.assertRegularDirectory(runsDir);
      if (await pathExists(dir))
        throw new Error(`Workflow run already exists: ${launch.runId}`);
      if (await pathExists(tombstone))
        throw new Error(
          `Workflow run has a pending retention tombstone: ${launch.runId}`,
        );
      await rename(tempDir, dir);
      published = true;
      await syncDirectory(runsDir);
      await this.assertRegularDirectory(dir);
      await this.assertRegularFile(join(dir, "launch.json"));
      await this.assertRegularFile(join(dir, "events.ndjson"));
    } catch (error) {
      if (!published) await removeCreationDirectory(tempDir, error);
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new WorkflowRunStorageError(launch.runId, error);
      }
      throw error;
    }
    return launch;
  }

  async append<T extends string, P>(
    runId: string,
    type: T,
    payload: P,
    runEpoch?: number,
    expectedLastEventOrdinal?: number,
  ): Promise<WorkflowAppendReceipt> {
    validateWorkflowRunId(runId);
    return this.withLock(runId, async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        const dir = this.runDir(runId);
        const launch = await this.readLaunch(runId, dir);
        assertSameOwner(launch.owner, this.options.owner);
        const path = join(dir, "events.ndjson");
        const file = await this.openVerifiedFile(
          path,
          fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          const before = await file.readFile();
          const parsed = parseJournal(runId, before);
          const actualLastEventOrdinal = parsed.events.length - 1;
          if (
            expectedLastEventOrdinal !== undefined &&
            expectedLastEventOrdinal !== actualLastEventOrdinal
          ) {
            throw new WorkflowConditionalAppendConflict(actualLastEventOrdinal);
          }
          const currentEpoch = lastRunEpoch(parsed.events);
          const nextRunEpoch = runEpoch ?? currentEpoch;
          if (nextRunEpoch < currentEpoch) {
            throw new Error(
              `Cannot append stale run epoch ${nextRunEpoch}; current epoch is ${currentEpoch}`,
            );
          }
          const line = serializeEvent(
            {
              schemaVersion: 1,
              eventId: randomUUID(),
              eventOrdinal: parsed.events.length,
              runId,
              runEpoch: nextRunEpoch,
              type,
              payload,
            },
            runId,
          );
          const maxEventBytes = this.options.maxEventBytes;
          const maxRunBytes = this.options.maxRunBytes;
          const lineBytes = line.length;
          if (
            maxRunBytes !== undefined &&
            (!Number.isSafeInteger(maxRunBytes) || maxRunBytes <= 0)
          ) {
            throw new Error("Invalid workflow run byte quota");
          }
          if (
            maxEventBytes !== undefined &&
            (!Number.isSafeInteger(maxEventBytes) ||
              maxEventBytes <= 0 ||
              parsed.completeBytes + lineBytes > maxEventBytes)
          ) {
            throw new WorkflowRunQuotaError(runId, "event");
          }
          if (
            maxRunBytes !== undefined &&
            parsed.completeBytes + lineBytes > maxRunBytes
          ) {
            throw new WorkflowRunQuotaError(runId, "run byte");
          }
          const maxOwnerBytes = this.options.maxOwnerBytes;
          if (
            maxOwnerBytes !== undefined &&
            (!Number.isSafeInteger(maxOwnerBytes) || maxOwnerBytes <= 0)
          ) {
            throw new Error("Invalid workflow owner byte quota");
          }
          if (maxOwnerBytes !== undefined) {
            let ownerBytes = 0;
            for (const existingRunId of await this.listRunIds()) {
              ownerBytes += await this.readEventBytes(
                this.runDir(existingRunId),
              ).then((bytes) => bytes.length);
            }
            if (ownerBytes + lineBytes > maxOwnerBytes) {
              throw new WorkflowRunQuotaError(runId, "owner byte");
            }
          }
          await this.assertNamespaceLease();
          await this.assertLaunchUnchanged(runId, dir, launch);
          await this.assertOpenFileTarget(file, path);
          if (parsed.tornTailBytes > 0) {
            await file.truncate(parsed.completeBytes);
            await file.sync();
            await this.assertNamespaceLease();
            await this.assertLaunchUnchanged(runId, dir, launch);
            await this.assertOpenFileTarget(file, path);
          }
          await this.assertNamespaceLease();
          await this.assertLaunchUnchanged(runId, dir, launch);
          await this.assertOpenFileTarget(file, path);
          try {
            await writeFully(file, line, parsed.completeBytes);
            await file.sync();
          } catch (error) {
            try {
              await this.assertOpenFileTarget(file, path);
              await file.truncate(parsed.completeBytes);
              await file.sync();
              await this.assertOpenFileTarget(file, path);
            } catch (rollbackError) {
              throw new Error("Failed to roll back workflow journal suffix", {
                cause: new AggregateError([error, rollbackError]),
              });
            }
            throw error;
          }
          await this.assertOpenFileTarget(file, path);
          return {
            eventId: JSON.parse(line.toString("utf8")).eventId as string,
            runId,
            startByte: parsed.completeBytes,
            endByte: parsed.completeBytes + lineBytes,
            eventOrdinal: parsed.events.length,
          };
        } finally {
          await file.close();
        }
      });
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") {
        throw new WorkflowRunStorageError(runId, error);
      }
      throw error;
    });
  }

  async appendIfCurrent<T extends string, P>(
    runId: string,
    expectedLastEventOrdinal: number,
    type: T,
    payload: P,
    runEpoch?: number,
  ): Promise<WorkflowConditionalAppendResult> {
    try {
      const receipt = await this.append(
        runId,
        type,
        payload,
        runEpoch,
        expectedLastEventOrdinal,
      );
      return { status: "appended", receipt };
    } catch (error) {
      if (error instanceof WorkflowConditionalAppendConflict)
        return {
          status: "conflict",
          actualLastEventOrdinal: error.actualLastEventOrdinal,
        };
      throw error;
    }
  }

  async readRun(runId: string): Promise<WorkflowRunRecord> {
    validateWorkflowRunId(runId);
    return this.withLock(runId, async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        try {
          return (await this.readRunUnderLock(runId, true)).record;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
          if (error instanceof WorkflowRunCorruptionError) throw error;
          if (isOwnershipError(error)) throw error;
          throw new WorkflowRunCorruptionError(runId, error);
        }
      });
    });
  }

  async listRunIds(): Promise<readonly string[]> {
    const runsDir = this.runsDir();
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((runId) => {
        try {
          validateWorkflowRunId(runId);
          return true;
        } catch {
          /* Temporary and tombstone directories are never authoritative runs. */
          return false;
        }
      })
      .sort();
  }

  async pruneTerminalRuns(options: {
    olderThanMs: number;
    maxRuns?: number;
  }): Promise<readonly string[]> {
    const lease = await this.assertNamespaceLease();
    return lease.withAuthority(async () => {
      if (
        !Number.isSafeInteger(options.olderThanMs) ||
        options.olderThanMs < 0
      ) {
        throw new Error("Invalid workflow retention age");
      }
      if (
        options.maxRuns !== undefined &&
        (!Number.isSafeInteger(options.maxRuns) || options.maxRuns < 0)
      ) {
        throw new Error("Invalid workflow retention limit");
      }
      const recovered = await this.recoverTombstones();
      const cutoff = Date.now() - options.olderThanMs;
      const candidates: Array<{ runId: string; createdAt: number }> = [];
      for (const runId of await this.listRunIds()) {
        const candidate = await this.withLock(runId, async () => {
          await this.assertNamespaceLease();
          try {
            const { record } = await this.readRunUnderLock(runId, true);
            if (
              record.launch.createdAt > cutoff ||
              !isRetentionEligible(record)
            )
              return undefined;
            return { runId, createdAt: record.launch.createdAt };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
        });
        if (candidate) candidates.push(candidate);
      }
      candidates.sort((left, right) => left.createdAt - right.createdAt);
      const selected =
        options.maxRuns === undefined
          ? candidates
          : candidates.slice(0, options.maxRuns);
      const pruned = new Set(recovered);
      for (const candidate of selected) {
        const deleted = await this.withLock(candidate.runId, async () => {
          await this.assertNamespaceLease();
          const dir = this.runDir(candidate.runId);
          const directory = await this.openVerifiedDirectory(dir);
          try {
            const { record } = await this.readRunUnderLock(
              candidate.runId,
              true,
            );
            if (
              record.launch.createdAt > cutoff ||
              !isRetentionEligible(record)
            )
              return false;
            const tombstone = this.tombstoneDir(candidate.runId);
            if (await pathExists(tombstone)) {
              if (await pathExists(dir))
                throw new Error(
                  `Workflow retention tombstone conflicts with live run: ${candidate.runId}`,
                );
              await this.deleteTombstone(tombstone);
              return true;
            }
            await this.assertNamespaceLease();
            if (await pathExists(tombstone))
              throw new Error(
                `Workflow retention tombstone appeared for ${candidate.runId}`,
              );
            await rename(dir, tombstone);
            await assertDirectoryDescriptorAndTarget(
              directory.file,
              tombstone,
              directory.identity,
            );
            await syncDirectory(this.runsDir());
            await this.assertNamespaceLease();
            await this.deleteVerifiedDirectory(
              tombstone,
              directory.file,
              directory.identity,
              ".deleting-",
            );
            return true;
          } finally {
            await directory.file.close();
          }
        });
        if (deleted) pruned.add(candidate.runId);
      }
      return [...pruned].sort();
    });
  }

  async readEventLog(runId: string): Promise<WorkflowRunEventLog> {
    validateWorkflowRunId(runId);
    return this.withLock(runId, async () => {
      const lease = await this.assertNamespaceLease();
      return lease.withAuthority(async () => {
        try {
          const result = await this.readRunUnderLock(runId, true);
          return {
            events: result.record.events,
            completeBytes: result.completeBytes,
            tornTailBytes: result.tornTailBytes,
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
          if (error instanceof WorkflowRunCorruptionError) throw error;
          if (isOwnershipError(error)) throw error;
          throw new WorkflowRunCorruptionError(runId, error);
        }
      });
    });
  }

  private async recoverTombstones(): Promise<string[]> {
    const runsDir = this.runsDir();
    let entries;
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const recovered: string[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
      const runId = entry.name.slice(TOMBSTONE_PREFIX.length);
      validateWorkflowRunId(runId);
      const deleted = await this.withLock(runId, async () => {
        await this.assertNamespaceLease();
        const tombstone = this.tombstoneDir(runId);
        if (!(await pathExists(tombstone))) return false;
        if (await pathExists(this.runDir(runId)))
          throw new Error(
            `Workflow retention tombstone conflicts with live run: ${runId}`,
          );
        const { record } = await this.readRunAtDir(runId, tombstone, true);
        if (!isRetentionEligible(record)) return false;
        await this.deleteTombstone(tombstone);
        return true;
      });
      if (deleted) recovered.push(runId);
    }
    return recovered;
  }

  private async deleteTombstone(tombstone: string): Promise<void> {
    await this.assertNamespaceLease();
    const directory = await this.openVerifiedDirectory(tombstone);
    try {
      await this.deleteVerifiedDirectory(
        tombstone,
        directory.file,
        directory.identity,
        ".deleting-",
      );
    } finally {
      await directory.file.close();
    }
  }

  private async readRunUnderLock(
    runId: string,
    repairTornTail: boolean,
  ): Promise<ReadRunResult> {
    return this.readRunAtDir(runId, this.runDir(runId), repairTornTail);
  }

  private async readRunAtDir(
    runId: string,
    dir: string,
    repairTornTail: boolean,
  ): Promise<ReadRunResult> {
    await this.assertRegularDirectory(dir);
    const launch = await this.readLaunch(runId, dir);
    const path = join(dir, "events.ndjson");
    const file = await this.openVerifiedFile(
      path,
      repairTornTail
        ? fsConstants.O_RDWR | fsConstants.O_NOFOLLOW
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const bytes = await file.readFile();
      await this.assertOpenFileTarget(file, path);
      const parsed = parseJournal(runId, bytes);
      if (parsed.tornTailBytes > 0 && repairTornTail) {
        await this.assertNamespaceLease();
        await this.assertLaunchUnchanged(runId, dir, launch);
        await this.assertOpenFileTarget(file, path);
        await file.truncate(parsed.completeBytes);
        await file.sync();
        await this.assertNamespaceLease();
        await this.assertLaunchUnchanged(runId, dir, launch);
        await this.assertOpenFileTarget(file, path);
      }
      return {
        record: { launch, events: parsed.events },
        tornTailBytes: parsed.tornTailBytes,
        completeBytes: parsed.completeBytes,
      };
    } finally {
      await file.close();
    }
  }

  private async readLaunch(
    runId: string,
    dir: string,
  ): Promise<WorkflowRunLaunch> {
    await this.assertRegularDirectory(dir);
    const path = join(dir, "launch.json");
    const file = await this.openVerifiedFile(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      let parsed: unknown;
      try {
        const bytes = await file.readFile();
        await this.assertOpenFileTarget(file, path);
        parsed = JSON.parse(decodeUtf8(bytes));
      } catch (error) {
        throw new WorkflowRunCorruptionError(runId, error);
      }
      validateLaunchRecord(parsed, runId);
      const launch = parsed as WorkflowRunLaunch;
      assertSameOwner(launch.owner, this.options.owner);
      return launch;
    } finally {
      await file.close();
    }
  }

  private async assertLaunchUnchanged(
    runId: string,
    dir: string,
    expected: WorkflowRunLaunch,
  ): Promise<void> {
    const current = await this.readLaunch(runId, dir);
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error("Workflow run launch authority changed");
  }

  private async readEventBytes(dir: string): Promise<Buffer> {
    await this.assertRegularDirectory(dir);
    const path = join(dir, "events.ndjson");
    const file = await this.openVerifiedFile(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      const bytes = await file.readFile();
      await this.assertOpenFileTarget(file, path);
      return bytes;
    } finally {
      await file.close();
    }
  }

  private async openVerifiedDirectory(path: string) {
    const before = await lstat(path);
    assertRegularDirectoryStats(path, before);
    const identity = fileIdentity(before);
    let file;
    try {
      file = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      await assertDirectoryDescriptorAndTarget(file, path, identity);
      return { file, identity };
    } catch (error) {
      if (file) {
        try {
          await file.close();
        } catch (closeError) {
          throw new Error(
            "Failed to close rejected workflow storage directory",
            {
              cause: closeError,
            },
          );
        }
      }
      throw error;
    }
  }

  private async deleteVerifiedDirectory(
    path: string,
    file: Awaited<ReturnType<typeof open>>,
    identity: FileIdentity,
    stagingPrefix: string,
  ): Promise<void> {
    await this.assertNamespaceLease();
    await assertDirectoryDescriptorAndTarget(file, path, identity);
    const staging = join(this.runsDir(), `${stagingPrefix}${randomUUID()}`);
    await rename(path, staging);
    await assertDirectoryDescriptorAndTarget(file, staging, identity);
    await rm(staging, { recursive: true, force: false });
    await syncDirectory(this.runsDir());
  }

  private async openVerifiedFile(path: string, flags: number, mode: number) {
    const before = await lstat(path);
    assertRegularFileStats(path, before);
    const expected = fileIdentity(before);
    let file;
    try {
      file = await open(path, flags, mode);
      await assertDescriptorAndTarget(file, path, expected);
      return file;
    } catch (error) {
      if (file) {
        try {
          await file.close();
        } catch (closeError) {
          throw new Error("Failed to close rejected workflow storage file", {
            cause: closeError,
          });
        }
      }
      throw error;
    }
  }

  private async assertOpenFileTarget(
    file: Awaited<ReturnType<typeof open>>,
    path: string,
  ): Promise<void> {
    await assertDescriptorAndTarget(file, path);
  }

  private runsDir(): string {
    return join(this.root, "runs");
  }

  private tombstoneDir(runId: string): string {
    return join(this.runsDir(), `${TOMBSTONE_PREFIX}${runId}`);
  }

  private runDir(runId: string): string {
    return join(this.runsDir(), safePart(runId, "run id"));
  }

  private async ensureStorageDirectories(): Promise<void> {
    await mkdir(dirname(this.root), { recursive: true, mode: 0o700 });
    await this.assertRegularDirectory(dirname(this.root));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertRegularDirectory(this.root);
    await syncDirectory(dirname(this.root));
    await mkdir(this.runsDir(), { recursive: true, mode: 0o700 });
    await this.assertRegularDirectory(this.runsDir());
    await syncDirectory(this.root);
    await this.recoverCreationDirectories();
  }

  private async recoverCreationDirectories(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.runsDir(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = Date.now() - CREATION_STALE_AFTER_MS;
    for (const entry of entries) {
      if (!entry.name.startsWith(CREATION_PREFIX)) continue;
      const match = CREATION_NAME_PATTERN.exec(entry.name);
      if (!match) continue;
      try {
        validateWorkflowRunId(match[1]);
      } catch {
        continue;
      }
      const path = join(this.runsDir(), entry.name);
      if (!entry.isDirectory()) continue;
      const directory = await this.openVerifiedDirectory(path);
      try {
        const info = await directory.file.stat();
        if (!Number.isFinite(info.mtimeMs) || info.mtimeMs > cutoff) continue;
        await this.deleteVerifiedDirectory(
          path,
          directory.file,
          directory.identity,
          ".stale-",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      } finally {
        await directory.file.close();
      }
    }
  }

  private async withLock<T>(
    _runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Namespace lease interlocks are filesystem-wide and non-reentrant. Keep
    // same-session run operations serialized in-process so cross-run
    // coordinators cannot race lease checks between per-run locks.
    const lockKey = this.root;
    const prior = WorkflowRunStore.locks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    WorkflowRunStore.locks.set(lockKey, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (WorkflowRunStore.locks.get(lockKey) === current)
        WorkflowRunStore.locks.delete(lockKey);
    }
  }
}

class WorkflowConditionalAppendConflict extends Error {
  public constructor(public readonly actualLastEventOrdinal: number) {
    super("Workflow journal revision conflict");
  }
}

function assertSameOwner(
  left: WorkflowOwnerIdentity,
  right: WorkflowOwnerIdentity,
): void {
  if (
    left.projectKey !== right.projectKey ||
    left.cwd !== right.cwd ||
    left.piSessionId !== right.piSessionId ||
    left.ownerId !== right.ownerId ||
    left.ownerGeneration !== right.ownerGeneration ||
    left.leaseToken !== right.leaseToken
  ) {
    throw new Error("Workflow run belongs to a different owner or session.");
  }
}

function assertQuota(
  value: number | undefined,
  quota: "event" | "run byte" | "owner byte",
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
    throw new Error(`Invalid workflow ${quota} quota`);
}

function validateLaunchInput(
  input: Omit<WorkflowRunLaunch, "schemaVersion" | "createdAt">,
): void {
  if (
    !Number.isSafeInteger(input.planRevision) ||
    input.planRevision < 0 ||
    !["manual", "on-session-start"].includes(input.resumePolicy)
  ) {
    throw new Error("Invalid workflow run launch");
  }
  if (input.planDigest !== undefined && typeof input.planDigest !== "string")
    throw new Error("Invalid workflow run plan digest");
}

function validateLaunchRecord(value: unknown, runId: string): void {
  if (!isRecord(value)) throw new Error("Launch record is not an object");
  if (value.schemaVersion !== 1 || value.runId !== runId)
    throw new Error("Launch record schema or run ID mismatch");
  validateWorkflowRunId(value.runId as string);
  if (
    !Number.isSafeInteger(value.planRevision) ||
    (value.planRevision as number) < 0 ||
    !["manual", "on-session-start"].includes(value.resumePolicy as string) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    (value.planDigest !== undefined && typeof value.planDigest !== "string")
  ) {
    throw new Error("Invalid launch record");
  }
  validateOwnerRecord(value.owner);
  const allowed = new Set([
    "schemaVersion",
    "runId",
    "planRevision",
    "resumePolicy",
    "owner",
    "createdAt",
    "planDigest",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown launch field: ${key}`);
}

function validateOwnerRecord(
  value: unknown,
): asserts value is WorkflowOwnerIdentity {
  if (!isRecord(value)) throw new Error("Launch owner is not an object");
  for (const key of [
    "projectKey",
    "cwd",
    "piSessionId",
    "ownerId",
    "leaseToken",
  ]) {
    if (
      typeof value[key] !== "string" ||
      value[key].length === 0 ||
      value[key].length > 500
    )
      throw new Error(`Invalid launch owner ${key}`);
  }
  if (
    !Number.isSafeInteger(value.ownerGeneration) ||
    (value.ownerGeneration as number) < 0
  )
    throw new Error("Invalid launch owner generation");
  const allowed = new Set([
    "projectKey",
    "cwd",
    "piSessionId",
    "ownerId",
    "ownerGeneration",
    "leaseToken",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`Unknown launch owner field: ${key}`);
}

function normalizeCreationPayload(
  initialEvent: WorkflowRunCreationEvent<unknown>,
): { plan: WorkflowPlan } {
  if (initialEvent.type !== "run_created")
    throw new Error("The initial workflow event must be run_created");
  const payload = requirePlainRecord(initialEvent.payload, "creation payload");
  assertExactKeys(payload, ["plan"], "creation payload");
  const plan = normalizeCreationPlan(
    readDataProperty(payload, "plan", "creation payload"),
  );
  const encoded = JSON.stringify({ plan });
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded, "utf8") > MAX_CREATION_PLAN_BYTES
  )
    throw new Error("Workflow creation plan exceeds the durable size limit");
  return { plan };
}

function normalizeCreationPlan(value: unknown): WorkflowPlan {
  const source = requirePlainRecord(value, "workflow plan");
  assertExactKeys(source, ["schemaVersion", "name", "phases"], "workflow plan");
  const schemaVersion = readDataProperty(source, "schemaVersion", "plan");
  const name = readDataProperty(source, "name", "plan");
  const phases = readDataProperty(source, "phases", "plan");
  if (schemaVersion !== 1 || typeof name !== "string" || !Array.isArray(phases))
    throw new Error("Invalid workflow plan definition");

  const normalizedPhases: WorkflowPlan["phases"] = phases.map(
    (phase, phaseIndex) => {
      const sourcePhase = requirePlainRecord(
        phase,
        `workflow phase ${phaseIndex}`,
      );
      assertExactKeys(sourcePhase, ["id", "mode", "tasks"], "workflow phase");
      const id = readDataProperty(sourcePhase, "id", "phase");
      const mode = readDataProperty(sourcePhase, "mode", "phase");
      const tasks = readDataProperty(sourcePhase, "tasks", "phase");
      if (
        typeof id !== "string" ||
        (mode !== "sequential" && mode !== "parallel") ||
        !Array.isArray(tasks)
      )
        throw new Error("Invalid workflow phase definition");
      return {
        id,
        mode: mode as "sequential" | "parallel",
        tasks: tasks.map((task, taskIndex) => {
          const sourceTask = requirePlainRecord(
            task,
            `workflow task ${phaseIndex}.${taskIndex}`,
          );
          assertAllowedKeys(
            sourceTask,
            ["id", "prompt", "label", "isolation", "input", "approval"],
            "workflow task",
          );
          const taskId = readDataProperty(sourceTask, "id", "task");
          const prompt = readDataProperty(sourceTask, "prompt", "task");
          const label = readOptionalDataProperty(sourceTask, "label", "task");
          const isolation = readOptionalDataProperty(
            sourceTask,
            "isolation",
            "task",
          );
          const input = readOptionalDataProperty(sourceTask, "input", "task");
          const approval = readOptionalDataProperty(
            sourceTask,
            "approval",
            "task",
          );
          if (typeof taskId !== "string" || typeof prompt !== "string")
            throw new Error("Invalid workflow task definition");
          if (Buffer.byteLength(prompt, "utf8") > 64 * 1024)
            throw new Error(
              "Workflow task prompt exceeds the durable size limit",
            );
          if (label !== undefined && typeof label !== "string")
            throw new Error("Invalid workflow task label");
          if (
            label !== undefined &&
            Buffer.byteLength(label, "utf8") > 8 * 1024
          )
            throw new Error(
              "Workflow task label exceeds the durable size limit",
            );
          if (
            isolation !== undefined &&
            isolation !== "in-process" &&
            isolation !== "process"
          )
            throw new Error("Invalid workflow task isolation");
          const normalizedInput =
            input === undefined ? undefined : toDurableValue(input);
          const normalizedApproval = normalizeTaskApproval(approval);
          return {
            id: taskId,
            prompt,
            ...(label === undefined ? {} : { label }),
            ...(isolation === undefined
              ? {}
              : { isolation: "in-process" as const }),
            ...(normalizedInput === undefined
              ? {}
              : { input: normalizedInput }),
            ...(normalizedApproval === undefined
              ? {}
              : { approval: normalizedApproval }),
          };
        }),
      };
    },
  );
  const plan = { schemaVersion: 1 as const, name, phases: normalizedPhases };
  validateWorkflowPlan(plan);
  return plan;
}

function normalizeTaskApproval(
  value: unknown,
): { policyHash: string; denial: "stop" | "skip" } | undefined {
  if (value === undefined) return undefined;
  const source = requirePlainRecord(value, "workflow task approval");
  assertExactKeys(source, ["policyHash", "denial"], "workflow task approval");
  const policyHash = readDataProperty(source, "policyHash", "approval");
  const denial = readDataProperty(source, "denial", "approval");
  if (
    typeof policyHash !== "string" ||
    !policyHash.trim() ||
    Buffer.byteLength(policyHash, "utf8") > 4 * 1024 ||
    (denial !== "stop" && denial !== "skip")
  ) {
    throw new Error("Invalid workflow task approval");
  }
  return { policyHash, denial };
}

function requirePlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const keys = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value).map(String),
  ];
  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    keys.length !== allowed.length
  )
    throw new Error(`Invalid ${label} fields`);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const keys = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value).map(String),
  ];
  if (keys.some((key) => !allowedKeys.has(key)))
    throw new Error(`Invalid ${label} fields`);
}

function readOptionalDataProperty(
  value: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor))
    throw new Error(`Invalid ${label} field: ${key}`);
  return descriptor.value;
}

function readDataProperty(
  value: Record<string, unknown>,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor))
    throw new Error(`Invalid ${label} field: ${key}`);
  return descriptor.value;
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseJournal(runId: string, bytes: Buffer): ParsedJournal {
  const completeBytes = bytes.lastIndexOf(0x0a) + 1;
  const tornTailBytes = bytes.length - completeBytes;
  const events: WorkflowEventEnvelope[] = [];
  const eventIds = new Set<string>();
  let offset = 0;
  let priorEpoch = 0;
  if (
    tornTailBytes > 0 &&
    new TextDecoder("utf-8").decode(bytes.subarray(completeBytes)).trim()
      .length === 0
  ) {
    throw new Error("Blank workflow journal record");
  }
  while (offset < completeBytes) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("Journal line boundary disappeared");
    const raw = bytes.subarray(offset, newline);
    if (raw.length === 0) throw new Error("Blank workflow journal record");
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeUtf8(raw));
    } catch (error) {
      throw new Error("Malformed workflow journal record", { cause: error });
    }
    validateEventRecord(parsed, runId, events.length);
    const event = parsed as WorkflowEventEnvelope;
    if (eventIds.has(event.eventId))
      throw new Error(`Duplicate workflow event ID: ${event.eventId}`);
    if (event.runEpoch < priorEpoch)
      throw new Error("Workflow journal run epoch moved backwards");
    priorEpoch = event.runEpoch;
    eventIds.add(event.eventId);
    events.push(event);
    offset = newline + 1;
  }
  return { events, completeBytes, tornTailBytes };
}

function validateEventRecord(
  value: unknown,
  runId: string,
  expectedOrdinal: number,
): void {
  if (!isRecord(value))
    throw new Error("Workflow journal record is not an object");
  for (const key of Object.keys(value))
    if (!EVENT_KEYS.has(key)) throw new Error(`Unknown journal field: ${key}`);
  if (
    value.schemaVersion !== 1 ||
    typeof value.eventId !== "string" ||
    !UUID_PATTERN.test(value.eventId) ||
    value.runId !== runId ||
    !Number.isSafeInteger(value.eventOrdinal) ||
    value.eventOrdinal !== expectedOrdinal ||
    !Number.isSafeInteger(value.runEpoch) ||
    (value.runEpoch as number) < 0 ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    value.type.length > 200 ||
    !Object.prototype.hasOwnProperty.call(value, "payload")
  ) {
    throw new Error("Invalid workflow journal record schema");
  }
}

function serializeEvent(event: WorkflowEventEnvelope, runId: string): Buffer {
  if (event.payload === undefined)
    throw new Error(`Workflow event for ${runId} is missing a payload`);
  validateEventRecord(event, runId, event.eventOrdinal ?? -1);
  const encoded = JSON.stringify(event);
  if (encoded === undefined)
    throw new Error(`Workflow event for ${runId} is not JSON serializable`);
  return Buffer.from(`${encoded}\n`, "utf8");
}

function lastRunEpoch(events: readonly WorkflowEventEnvelope[]): number {
  return events.at(-1)?.runEpoch ?? 0;
}

function isRetentionEligible(record: WorkflowRunRecord): boolean {
  const terminal = terminalState(record.events);
  if (!terminal) return false;
  const expectedDeliveryId = terminalDeliveryId(record.launch.runId);
  const terminalMarkerOrdinal = record.events.reduce(
    (latest, event, ordinal) =>
      event.type === "run_terminal" || event.type === "run_cancelled"
        ? ordinal
        : latest,
    terminal.ordinal,
  );
  const postTerminal = record.events.slice(terminalMarkerOrdinal + 1);
  const receipt = postTerminal.at(-1);
  if (
    !receipt ||
    receipt.type !== "delivery_receipt" ||
    !isRecord(receipt.payload) ||
    receipt.payload.deliveryId !== expectedDeliveryId
  )
    return false;
  const prefix = postTerminal.slice(0, -1);
  if (
    !prefix.some((event) => event.type === "delivery_intent") ||
    !prefix.some((event) => event.type === "delivery_dispatched")
  )
    return false;
  return prefix.every((event) =>
    ["delivery_intent", "delivery_dispatched", "delivery_receipt"].includes(
      event.type,
    ),
  );
}

function terminalState(
  events: readonly WorkflowEventEnvelope[],
): { status: "done" | "error" | "cancelled"; ordinal: number } | undefined {
  for (const [ordinal, event] of events.entries()) {
    if (event.type === "run_cancelled") return { status: "cancelled", ordinal };
    if (event.type !== "run_result" && event.type !== "run_terminal") continue;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const result = payload?.result ?? payload;
    if (!isRecord(result)) return undefined;
    const status = result.status;
    if (status === "done" || status === "error" || status === "cancelled")
      return { status, ordinal };
    return undefined;
  }
  return undefined;
}

function isOwnershipError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("different owner or session")
  );
}

function terminalDeliveryId(runId: string): string {
  return createHash("sha256")
    .update(`workflow:${runId}:terminal`)
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegularDirectoryStats(
  path: string,
  info: { isDirectory(): boolean; nlink: number },
): void {
  if (!info.isDirectory() || info.nlink < 1)
    throw new Error(`Workflow storage path is not a directory: ${path}`);
}

function assertRegularFileStats(
  path: string,
  info: { isFile(): boolean; nlink: number },
): void {
  if (!info.isFile() || info.nlink !== 1)
    throw new Error(`Workflow storage path is not regular: ${path}`);
}

function fileIdentity(info: { dev: number; ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function assertDirectoryDescriptorAndTarget(
  file: Awaited<ReturnType<typeof open>>,
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const descriptor = await file.stat();
  assertRegularDirectoryStats(path, descriptor);
  const target = await lstat(path);
  assertRegularDirectoryStats(path, target);
  const descriptorIdentity = fileIdentity(descriptor);
  const targetIdentity = fileIdentity(target);
  if (
    expected.dev !== descriptorIdentity.dev ||
    expected.ino !== descriptorIdentity.ino ||
    descriptorIdentity.dev !== targetIdentity.dev ||
    descriptorIdentity.ino !== targetIdentity.ino
  )
    throw new Error(`Workflow storage descriptor changed: ${path}`);
}

async function assertDescriptorAndTarget(
  file: Awaited<ReturnType<typeof open>>,
  path: string,
  expected?: FileIdentity,
): Promise<void> {
  const descriptor = await file.stat();
  assertRegularFileStats(path, descriptor);
  const target = await lstat(path);
  assertRegularFileStats(path, target);
  const descriptorIdentity = fileIdentity(descriptor);
  if (
    expected &&
    (descriptorIdentity.dev !== expected.dev ||
      descriptorIdentity.ino !== expected.ino)
  )
    throw new Error(`Workflow storage descriptor changed: ${path}`);
  const targetIdentity = fileIdentity(target);
  if (
    descriptorIdentity.dev !== targetIdentity.dev ||
    descriptorIdentity.ino !== targetIdentity.ino
  )
    throw new Error(`Workflow storage target changed: ${path}`);
}

async function writeSyncedFile(
  path: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  const file = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    mode,
  );
  try {
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    await writeFully(file, bytes, 0);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeFully(
  file: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await file.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0)
      throw new Error("Workflow journal short write");
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeCreationDirectory(
  path: string,
  originalError: unknown,
): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new Error("Failed to remove unpublished workflow run directory", {
      cause: new AggregateError([originalError, cleanupError]),
    });
  }
}

export function workflowRunStoreRoot(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
): string {
  return join(
    rootDir,
    safePart(owner.projectKey, "project key"),
    safePart(owner.piSessionId, "session id"),
  );
}

export function workflowRunPath(
  rootDir: string,
  owner: WorkflowOwnerIdentity,
  runId: string,
): string {
  validateWorkflowRunId(runId);
  return dirname(
    join(
      workflowRunStoreRoot(rootDir, owner),
      "runs",
      safePart(runId, "run id"),
      "events.ndjson",
    ),
  );
}
