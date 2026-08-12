import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { constants as fsConstants, type Dir, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
  type DurableValueOptions,
} from "./workflow-durable-value";
import { foldWorkflowRunEvents } from "./workflow-projection-repository";
import {
  assertWorkflowQuota,
  WorkflowQuotaError,
  resolveWorkflowQuotaLimits,
  type WorkflowQuotaLimits,
  type WorkflowQuotaOptions,
} from "./workflow-quotas";
import {
  DEFAULT_WORKFLOW_RETENTION_POLICY,
  classifyWorkflowRunRetention,
  resolveWorkflowRetentionPolicy,
  type WorkflowRetentionCandidate,
  type WorkflowRetentionClassification,
  type WorkflowRetentionPolicy,
  type WorkflowRetentionPolicyOptions,
} from "./workflow-retention";
import {
  WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
  WORKFLOW_RUN_SCHEMA_VERSION,
  createWorkflowSha256Digest,
  isDurableWorkflowOwner,
  isDurableWorkflowRunId,
  isWorkflowIdentifier,
  isWorkflowLeaseToken,
  isWorkflowRunEvent,
  isWorkflowSha256Digest,
  type DurableWorkflowOwner,
  type DurableWorkflowRunId,
  type WorkflowBlobReference,
  type WorkflowEventReceipt,
  type WorkflowNamespaceLeaseFence,
  type WorkflowRunEpochAcquiredEvent,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
  type WorkflowSha256Digest,
} from "./workflow-run-types";

const STORE_SEGMENTS = [".pi-subagentura", "workflow-runs", "v1"] as const;
const LEASE_FILE = "owner-lease.json";
const RUNS_DIRECTORY = "runs";
const LAUNCH_FILE = "launch.json";
const EVENTS_FILE = "events.ndjson";
const STATE_FILE = "state.json";
const RESULT_FILE = "result.json";
const DEFINITIONS_DIRECTORY = "definitions";
const OUTPUTS_DIRECTORY = "outputs";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PI_SESSION_ID_BYTES = 4096;
const MAX_PORTABLE_PATH_COMPONENT_BYTES = 255;
const PROCESS_START_IDENTITY_MAX_LENGTH = 1024;

export type WorkflowLeaseLiveness = "live" | "stale" | "ambiguous";
export type WorkflowRunEpochAcquisitionReason =
  "reload" | "resume" | "startup" | "stale_takeover";

export interface WorkflowLeaseProcessIdentity {
  readonly pid: number;
  readonly processStartIdentity: string;
}

export interface PersistedWorkflowNamespaceLease extends WorkflowLeaseProcessIdentity {
  readonly schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  readonly durableOwner: DurableWorkflowOwner;
  readonly scopeId: number;
  readonly generation: number;
  readonly leaseToken: string;
}

export type WorkflowLeaseLivenessResolver = (
  lease: PersistedWorkflowNamespaceLease,
) => WorkflowLeaseLiveness | Promise<WorkflowLeaseLiveness>;

export type WorkflowRunStoreSyncPurpose =
  "lease" | "launch" | "events" | "definition" | "output" | "state" | "result";

export type WorkflowRunJournalMode = "execution" | "terminal_maintenance";

export interface WorkflowRunStoreSyncHooks {
  readonly file?: (
    handle: FileHandle,
    purpose: WorkflowRunStoreSyncPurpose,
  ) => void | Promise<void>;
  readonly directory?: (
    handle: FileHandle,
    purpose: WorkflowRunStoreSyncPurpose,
  ) => void | Promise<void>;
}
export type WorkflowRunStoreWriteBoundary =
  "append" | "temporary_write" | "publish" | "replace" | "prune" | "recover";

export interface WorkflowRunStoreIoHooks {
  readonly before?: (
    boundary: WorkflowRunStoreWriteBoundary,
    purpose: WorkflowRunStoreSyncPurpose,
  ) => void | Promise<void>;
}

export interface WorkflowRunStoreOptions {
  readonly homeDir: string;
  readonly processIdentity?: WorkflowLeaseProcessIdentity;
  readonly resolveLeaseLiveness?: WorkflowLeaseLivenessResolver;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly sync?: WorkflowRunStoreSyncHooks;
  readonly io?: WorkflowRunStoreIoHooks;
  readonly quotas?: WorkflowQuotaOptions;
  readonly retention?: WorkflowRetentionPolicyOptions | false;
  readonly now?: () => number;
}

export interface WorkflowLeaseAcquisition {
  readonly scopeId: number;
  readonly generation: number;
}

export interface WorkflowRunCreation {
  readonly runId: DurableWorkflowRunId;
  readonly launch: unknown;
}

export interface WorkflowEventLogRead {
  readonly events: readonly WorkflowRunEvent[];
  readonly completeBytes: number;
  readonly tornTailBytes: number;
}

export interface WorkflowRunLaunchRecord {
  readonly schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  readonly durableOwner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly initialRunEpoch: 1;
  readonly launch: DurableValue;
}

export interface WorkflowRunResultRecord {
  readonly schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
  readonly durableOwner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly runEpoch: number;
  readonly terminalEventId: string;
  readonly baseEventByteEndExclusive: number;
  readonly result: WorkflowBlobReference;
}

export interface WorkflowRunResultWrite {
  readonly terminalEventId: string;
  readonly baseEventByteEndExclusive: number;
  readonly result: WorkflowBlobReference;
}

export type WorkflowRunStoreErrorCode =
  | "invalid_owner"
  | "invalid_run_id"
  | "invalid_process_identity"
  | "invalid_lease_identity"
  | "lease_live"
  | "lease_ambiguous"
  | "lease_corrupt"
  | "fence_lost"
  | "run_exists"
  | "run_not_found"
  | "path_mismatch"
  | "symlink_rejected"
  | "malformed_complete_line"
  | "event_mismatch"
  | "sequence_mismatch"
  | "epoch_mismatch"
  | "hash_mismatch"
  | "size_mismatch"
  | "immutable_conflict"
  | "result_exists";

export class WorkflowRunStoreError extends Error {
  readonly code: WorkflowRunStoreErrorCode;
  readonly byteOffset?: number;

  constructor(
    code: WorkflowRunStoreErrorCode,
    message: string,
    options: { readonly byteOffset?: number; readonly cause?: unknown } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkflowRunStoreError";
    this.code = code;
    this.byteOffset = options.byteOffset;
  }
}

interface OwnerPaths {
  readonly namespace: string;
  readonly lease: string;
  readonly runs: string;
}

interface RunPaths {
  readonly directory: string;
  readonly launch: string;
  readonly events: string;
  readonly state: string;
  readonly result: string;
  readonly definitions: string;
  readonly outputs: string;
}

interface ScannedEvent {
  readonly event: WorkflowRunEvent;
  readonly byteStart: number;
  readonly byteEndExclusive: number;
  readonly lineBytes: Buffer;
}

interface ScannedJournal extends WorkflowEventLogRead {
  readonly records: readonly ScannedEvent[];
}

interface RunQuotaUsage {
  readonly bytes: number;
  readonly blobs: number;
  readonly lastActivityMs: number;
}

interface OwnerQuotaUsage {
  readonly bytes: number;
  readonly runs: ReadonlyMap<DurableWorkflowRunId, RunQuotaUsage>;
}

interface WorkflowQuotaGrowth {
  readonly bytes: number;
  readonly blobs: number;
  readonly events: number;
  readonly runs: number;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isProcessIdentity(
  value: unknown,
): value is WorkflowLeaseProcessIdentity {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["pid", "processStartIdentity"]) &&
    isPositiveSafeInteger(value.pid) &&
    typeof value.processStartIdentity === "string" &&
    value.processStartIdentity.length > 0 &&
    value.processStartIdentity.length <= PROCESS_START_IDENTITY_MAX_LENGTH
  );
}

function isPersistedLease(
  value: unknown,
): value is PersistedWorkflowNamespaceLease {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "durableOwner",
      "scopeId",
      "generation",
      "leaseToken",
      "pid",
      "processStartIdentity",
    ]) &&
    value.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION &&
    isDurableWorkflowOwner(value.durableOwner) &&
    isNonNegativeSafeInteger(value.scopeId) &&
    isPositiveSafeInteger(value.generation) &&
    isWorkflowLeaseToken(value.leaseToken) &&
    isPositiveSafeInteger(value.pid) &&
    typeof value.processStartIdentity === "string" &&
    value.processStartIdentity.length > 0 &&
    value.processStartIdentity.length <= PROCESS_START_IDENTITY_MAX_LENGTH
  );
}

function isLaunchRecord(value: unknown): value is WorkflowRunLaunchRecord {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "durableOwner",
      "runId",
      "initialRunEpoch",
      "launch",
    ]) &&
    value.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION &&
    isDurableWorkflowOwner(value.durableOwner) &&
    isDurableWorkflowRunId(value.runId) &&
    value.initialRunEpoch === 1
  );
}

function isBlobReference(value: unknown): value is WorkflowBlobReference {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["sha256", "sizeBytes"]) &&
    isWorkflowSha256Digest(value.sha256) &&
    isNonNegativeSafeInteger(value.sizeBytes)
  );
}

function isResultRecord(value: unknown): value is WorkflowRunResultRecord {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      "schemaVersion",
      "durableOwner",
      "runId",
      "runEpoch",
      "terminalEventId",
      "baseEventByteEndExclusive",
      "result",
    ]) &&
    value.schemaVersion === WORKFLOW_RUN_SCHEMA_VERSION &&
    isDurableWorkflowOwner(value.durableOwner) &&
    isDurableWorkflowRunId(value.runId) &&
    isPositiveSafeInteger(value.runEpoch) &&
    isWorkflowIdentifier(value.terminalEventId) &&
    isNonNegativeSafeInteger(value.baseEventByteEndExclusive) &&
    isBlobReference(value.result)
  );
}

function ownerEquals(
  left: DurableWorkflowOwner,
  right: DurableWorkflowOwner,
): boolean {
  return (
    left.projectKey === right.projectKey &&
    left.piSessionKey === right.piSessionKey
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function assertContained(root: string, target: string): void {
  const child = relative(root, target);
  if (child === "" || child === ".") return;
  if (
    child === ".." ||
    child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(child)
  ) {
    throw new WorkflowRunStoreError(
      "path_mismatch",
      "Derived workflow store path escaped its trusted root.",
    );
  }
}

function randomToken(randomBytes: (size: number) => Uint8Array): string {
  return Buffer.from(randomBytes(32)).toString("base64url");
}

function defaultProcessIdentity(): WorkflowLeaseProcessIdentity {
  const approximateStart = Math.max(
    0,
    Math.floor(Date.now() - process.uptime() * 1000),
  );
  return {
    pid: process.pid,
    processStartIdentity: `node-start-${approximateStart}`,
  };
}

/**
 * Derive durable owner keys without allowing either raw path data or an unsafe
 * session identifier to become path authority.
 */
export async function deriveDurableWorkflowOwner(
  cwd: string,
  piSessionId: string,
  resolveRealPath: (path: string) => Promise<string> = realpath,
): Promise<DurableWorkflowOwner> {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new WorkflowRunStoreError("invalid_owner", "A cwd is required.");
  }
  if (
    typeof piSessionId !== "string" ||
    piSessionId.length === 0 ||
    Buffer.byteLength(piSessionId, "utf8") > MAX_PI_SESSION_ID_BYTES
  ) {
    throw new WorkflowRunStoreError(
      "invalid_owner",
      "Pi session identity is empty or exceeds the durable owner bound.",
    );
  }
  const canonicalCwd = await resolveRealPath(cwd);
  const projectKey = sha256(Buffer.from(canonicalCwd, "utf8"));
  const piSessionKey =
    isWorkflowIdentifier(piSessionId) &&
    Buffer.byteLength(piSessionId, "utf8") <= MAX_PORTABLE_PATH_COMPONENT_BYTES
      ? piSessionId
      : sha256(Buffer.from(piSessionId, "utf8"));
  const owner = { projectKey, piSessionKey };
  if (!isDurableWorkflowOwner(owner)) {
    throw new WorkflowRunStoreError(
      "invalid_owner",
      "Could not derive a safe durable workflow owner.",
    );
  }
  return owner;
}

export class WorkflowRunStore {
  readonly rootDirectory: string;
  readonly processIdentity: WorkflowLeaseProcessIdentity;
  readonly quotas: WorkflowQuotaLimits;

  readonly #homeDir: string;
  readonly #resolveLiveness: WorkflowLeaseLivenessResolver;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #syncHooks: WorkflowRunStoreSyncHooks;
  readonly #ioHooks: WorkflowRunStoreIoHooks;
  readonly #retentionPolicy: WorkflowRetentionPolicy | undefined;
  readonly #now: () => number;
  readonly #valueLimits: DurableValueOptions;
  readonly #eventLimits: DurableValueOptions;
  readonly #retentionCandidates = new WeakSet<object>();
  readonly #ownerMutationTails = new Map<string, Promise<void>>();

  constructor(options: WorkflowRunStoreOptions) {
    if (typeof options.homeDir !== "string" || options.homeDir.length === 0) {
      throw new TypeError("WorkflowRunStore requires an injected homeDir.");
    }
    const identity = options.processIdentity ?? defaultProcessIdentity();
    if (!isProcessIdentity(identity)) {
      throw new WorkflowRunStoreError(
        "invalid_process_identity",
        "Workflow lease process identity is invalid.",
      );
    }
    this.#homeDir = resolve(options.homeDir);
    this.rootDirectory = join(this.#homeDir, ...STORE_SEGMENTS);
    this.processIdentity = Object.freeze({ ...identity });
    this.#randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.#syncHooks = options.sync ?? {};
    this.#ioHooks = options.io ?? {};
    this.#now = options.now ?? Date.now;
    this.quotas = resolveWorkflowQuotaLimits(options.quotas);
    this.#retentionPolicy =
      options.retention === undefined || options.retention === false
        ? undefined
        : resolveWorkflowRetentionPolicy({
            ...options.retention,
            minimumRunsPerOwner: Math.min(
              options.retention.minimumRunsPerOwner ??
                DEFAULT_WORKFLOW_RETENTION_POLICY.minimumRunsPerOwner,
              Math.max(0, this.quotas.maxRunsPerOwner - 1),
            ),
          });
    this.#valueLimits = Object.freeze({
      maxDepth: this.quotas.maxValueDepth,
      maxNodes: this.quotas.maxValueNodes,
      maxStringBytes: this.quotas.maxValueStringBytes,
      maxBytes: this.quotas.maxValueBytes,
    });
    this.#eventLimits = Object.freeze({
      ...this.#valueLimits,
      maxBytes: Math.min(
        this.quotas.maxValueBytes,
        this.quotas.maxEventBytes - 1,
      ),
    });
    this.#resolveLiveness =
      options.resolveLeaseLiveness ??
      ((lease) => {
        if (
          lease.pid === this.processIdentity.pid &&
          lease.processStartIdentity ===
            this.processIdentity.processStartIdentity
        ) {
          return "live";
        }
        try {
          process.kill(lease.pid, 0);
          return "ambiguous";
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ESRCH"
          ) {
            return "stale";
          }
          return "ambiguous";
        }
      });
  }

  deriveOwner(cwd: string, piSessionId: string): Promise<DurableWorkflowOwner> {
    return deriveDurableWorkflowOwner(cwd, piSessionId);
  }

  async acquireLease(
    owner: DurableWorkflowOwner,
    acquisition: WorkflowLeaseAcquisition,
  ): Promise<WorkflowRunLease> {
    if (!isDurableWorkflowOwner(owner)) {
      throw new WorkflowRunStoreError(
        "invalid_owner",
        "Durable workflow owner is invalid.",
      );
    }
    if (
      !isNonNegativeSafeInteger(acquisition.scopeId) ||
      !isPositiveSafeInteger(acquisition.generation)
    ) {
      throw new WorkflowRunStoreError(
        "invalid_lease_identity",
        "Workflow lease scope or generation is invalid.",
      );
    }
    const paths = await this.#ownerPaths(owner, true);
    const leaseToken = randomToken(this.#randomBytes);
    if (!isWorkflowLeaseToken(leaseToken)) {
      throw new WorkflowRunStoreError(
        "invalid_lease_identity",
        "Injected lease entropy did not produce a valid token.",
      );
    }
    const next: PersistedWorkflowNamespaceLease = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      durableOwner: owner,
      scopeId: acquisition.scopeId,
      generation: acquisition.generation,
      leaseToken,
      pid: this.processIdentity.pid,
      processStartIdentity: this.processIdentity.processStartIdentity,
    };

    let staleTakeover = false;
    await this.#recoverImmutableDirectory(
      undefined,
      paths,
      paths.namespace,
      "lease",
      (name) => name === LEASE_FILE,
    );
    const current = await this.#readLease(paths.lease);
    if (current !== undefined) {
      if (!ownerEquals(current.durableOwner, owner)) {
        throw new WorkflowRunStoreError(
          "lease_corrupt",
          "Workflow namespace lease owner does not match its path namespace.",
        );
      }
      const liveness = await this.#resolveLiveness(current);
      if (liveness === "live") {
        throw new WorkflowRunStoreError(
          "lease_live",
          "A provably live workflow namespace owner cannot be displaced.",
        );
      }
      if (liveness !== "stale") {
        throw new WorkflowRunStoreError(
          "lease_ambiguous",
          "Workflow namespace lease liveness is ambiguous.",
        );
      }
      staleTakeover = true;
      await this.#replaceStaleLease(paths, current, next);
    } else {
      const encoded = encodeDurableValue(next, this.#valueLimits);
      try {
        await this.#publishImmutable(
          paths.namespace,
          paths.lease,
          Buffer.from(encoded.json, "utf8"),
          "lease",
        );
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new WorkflowRunStoreError(
            "lease_ambiguous",
            "Workflow namespace lease changed during acquisition.",
            { cause: error },
          );
        }
        throw error;
      }
    }

    try {
      await this.#recoverOwnerPublishes(next, paths);
      await this.#recoverRetiredRuns(next, paths);
      await this.#runAutomaticRetention(next, paths);
    } catch (error) {
      await this._releaseLease(next, paths).catch(() => undefined);
      throw error;
    }
    return new WorkflowRunLease(this, paths, next, staleTakeover);
  }

  async openRun(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowRunJournal> {
    const paths = await this.#existingRunPaths(owner, runId);
    const launch = await this.#readLaunch(paths.launch, owner, runId);
    return new WorkflowRunJournal(this, owner, runId, paths, launch, undefined);
  }

  async listRunIds(
    owner: DurableWorkflowOwner,
    maxResults = this.quotas.maxRunsPerOwner,
  ): Promise<readonly DurableWorkflowRunId[]> {
    if (!Number.isSafeInteger(maxResults) || maxResults <= 0) {
      throw new TypeError(
        "Workflow run listing bound must be a positive safe integer.",
      );
    }
    const paths = await this.#ownerPaths(owner, false);
    const runIds: DurableWorkflowRunId[] = [];
    let directory: Dir;
    try {
      directory = await opendir(paths.runs);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    try {
      for await (const entry of directory) {
        if (entry.isSymbolicLink()) {
          throw new WorkflowRunStoreError(
            "symlink_rejected",
            "A symlink was found in the workflow run namespace.",
          );
        }
        if (!entry.isDirectory() || !isDurableWorkflowRunId(entry.name)) {
          throw new WorkflowRunStoreError(
            "path_mismatch",
            "An invalid entry was found in the workflow run namespace.",
          );
        }
        runIds.push(entry.name);
        if (runIds.length > maxResults) {
          throw new WorkflowQuotaError(
            "maxStartupRuns",
            maxResults,
            runIds.length,
          );
        }
        assertWorkflowQuota("maxRunsPerOwner", runIds.length, this.quotas);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return runIds.sort();
  }

  async _withOwnerMutation<Result>(
    owner: DurableWorkflowOwner,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const key = `${owner.projectKey}\u0000${owner.piSessionKey}`;
    const previous = this.#ownerMutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#ownerMutationTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#ownerMutationTails.get(key) === tail) {
        this.#ownerMutationTails.delete(key);
      }
    }
  }

  async _createRun(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    input: WorkflowRunCreation,
  ): Promise<WorkflowRunJournal> {
    await this._assertNamespaceFence(lease, ownerPaths);
    if (!isDurableWorkflowRunId(input.runId)) {
      throw new WorkflowRunStoreError(
        "invalid_run_id",
        "Durable workflow run ID is invalid.",
      );
    }
    const launchValue = decodeDurableValue(
      encodeDurableValue(input.launch, this.#valueLimits).json,
      this.#valueLimits,
    );
    const launch: WorkflowRunLaunchRecord = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      durableOwner: lease.durableOwner,
      runId: input.runId,
      initialRunEpoch: 1,
      launch: launchValue,
    };
    const encodedLaunch = encodeDurableValue(launch, this.#valueLimits);
    await this.#assertOwnerGrowth(ownerPaths, undefined, {
      bytes: encodedLaunch.bytes,
      blobs: 0,
      events: 0,
      runs: 1,
    });

    const paths = this.#derivedRunPaths(ownerPaths, input.runId);
    try {
      await mkdir(paths.directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (isAlreadyExists(error)) {
        const existing = await lstat(paths.directory);
        if (existing.isSymbolicLink()) {
          throw new WorkflowRunStoreError(
            "symlink_rejected",
            "Workflow run directories cannot be symbolic links.",
            { cause: error },
          );
        }
        throw new WorkflowRunStoreError(
          "run_exists",
          "Durable workflow run IDs are no-replace.",
          { cause: error },
        );
      }
      throw error;
    }
    await chmod(paths.directory, PRIVATE_DIRECTORY_MODE);
    await this.#syncDirectory(ownerPaths.runs, "launch");
    await this.#ensureDirectory(paths.definitions, true);
    await this.#ensureDirectory(paths.outputs, true);
    await this.#publishImmutable(
      paths.directory,
      paths.launch,
      Buffer.from(encodedLaunch.json, "utf8"),
      "launch",
    );
    const events = await open(
      paths.events,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await chmod(paths.events, PRIVATE_FILE_MODE);
      await this.#syncFile(events, "events");
    } finally {
      await events.close();
    }
    await this.#syncDirectory(paths.directory, "events");
    await this._assertNamespaceFence(lease, ownerPaths);
    const fence = this.#runFence(lease, input.runId, 1);
    return new WorkflowRunJournal(
      this,
      lease.durableOwner,
      input.runId,
      paths,
      launch,
      fence,
    );
  }

  async _acquireRun(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    runId: DurableWorkflowRunId,
    reason: WorkflowRunEpochAcquisitionReason,
  ): Promise<WorkflowRunJournal> {
    await this._assertNamespaceFence(lease, ownerPaths);
    const paths = await this.#existingRunPaths(lease.durableOwner, runId);
    const launch = await this.#readLaunch(
      paths.launch,
      lease.durableOwner,
      runId,
    );
    const scanned = await this._scanJournal(paths, runId);
    const previousEpoch = this.#currentEpoch(launch, scanned.events);
    if (previousEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new WorkflowRunStoreError(
        "epoch_mismatch",
        "Workflow run epoch cannot be incremented safely.",
      );
    }
    const runEpoch = previousEpoch + 1;
    const fence = this.#runFence(lease, runId, runEpoch);
    const journal = new WorkflowRunJournal(
      this,
      lease.durableOwner,
      runId,
      paths,
      launch,
      fence,
    );
    if (scanned.tornTailBytes > 0) {
      await this._repairTornTail(lease, paths, runId);
    }
    const afterRepair = await this._scanJournal(paths, runId);
    const sequence =
      (afterRepair.events[afterRepair.events.length - 1]?.sequence ?? 0) + 1;
    const event: WorkflowRunEpochAcquiredEvent = {
      schemaVersion: WORKFLOW_RUN_EVENT_SCHEMA_VERSION,
      eventId: `epoch-${runEpoch}-${randomToken(this.#randomBytes)}`,
      runId,
      runEpoch,
      sequence,
      type: "run_epoch_acquired",
      payload: {
        fence,
        previousRunEpoch: previousEpoch,
        reason,
      },
    };
    await this._append(journal, event, true);
    return journal;
  }
  async _openTerminalMaintenanceRun(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowRunJournal> {
    await this._assertNamespaceFence(lease, ownerPaths);
    const paths = await this.#existingRunPaths(lease.durableOwner, runId);
    const launch = await this.#readLaunch(
      paths.launch,
      lease.durableOwner,
      runId,
    );
    let scanned = await this._scanJournal(paths, runId);
    if (scanned.tornTailBytes > 0) {
      await this._repairTornTail(lease, paths, runId);
      scanned = await this._scanJournal(paths, runId);
    }
    const terminal = [...scanned.events]
      .reverse()
      .find((event) => event.type === "run_terminal");
    if (
      terminal === undefined ||
      this.#currentEpoch(launch, scanned.events) !== terminal.runEpoch
    ) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Terminal maintenance requires an authoritative terminal run.",
      );
    }
    return new WorkflowRunJournal(
      this,
      lease.durableOwner,
      runId,
      paths,
      launch,
      this.#runFence(lease, runId, terminal.runEpoch),
      "terminal_maintenance",
    );
  }

  async _releaseLease(
    lease: PersistedWorkflowNamespaceLease,
    paths: OwnerPaths,
  ): Promise<void> {
    await this._assertNamespaceFence(lease, paths);
    await unlink(paths.lease);
    await this.#syncDirectory(paths.namespace, "lease");
  }

  async _assertNamespaceFence(
    expected: PersistedWorkflowNamespaceLease,
    paths: OwnerPaths,
  ): Promise<void> {
    const current = await this.#readLease(paths.lease);
    if (
      current === undefined ||
      !ownerEquals(current.durableOwner, expected.durableOwner) ||
      current.scopeId !== expected.scopeId ||
      current.generation !== expected.generation ||
      current.leaseToken !== expected.leaseToken
    ) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Workflow namespace lease fence is no longer current.",
      );
    }
  }

  async _append(
    journal: WorkflowRunJournal,
    event: WorkflowRunEvent,
    allowEpochAdvance = false,
  ): Promise<WorkflowEventReceipt> {
    if (
      journal.mode === "terminal_maintenance" &&
      event.type !== "delivery_intent_recorded" &&
      event.type !== "delivery_receipt_recorded"
    ) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "A terminal-maintenance journal may append only delivery events.",
      );
    }
    const fence = journal._requiredFence();
    const lease = journal._leaseRecord();
    const ownerPaths = await this.#ownerPaths(journal.owner, false);
    await this._assertNamespaceFence(lease, ownerPaths);
    if (!isWorkflowRunEvent(event)) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Workflow event does not match the exact persisted schema.",
      );
    }
    if (event.runId !== journal.runId || event.runEpoch !== fence.runEpoch) {
      throw new WorkflowRunStoreError(
        "epoch_mismatch",
        "Workflow event does not match its journal fence.",
      );
    }
    if (
      event.type === "run_created" &&
      !ownerEquals(event.payload.durableOwner, journal.owner)
    ) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Workflow creation event owner does not match its journal.",
      );
    }
    if (
      event.type === "run_epoch_acquired" &&
      (!ownerEquals(event.payload.fence.durableOwner, fence.durableOwner) ||
        event.payload.fence.scopeId !== fence.scopeId ||
        event.payload.fence.generation !== fence.generation ||
        event.payload.fence.leaseToken !== fence.leaseToken ||
        event.payload.fence.runId !== fence.runId ||
        event.payload.fence.runEpoch !== fence.runEpoch)
    ) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Workflow epoch event does not match its current journal fence.",
      );
    }

    let scanned = await this._scanJournal(journal._paths(), journal.runId);
    const currentEpoch = this.#currentEpoch(journal._launch(), scanned.events);
    if (
      (!allowEpochAdvance && currentEpoch !== fence.runEpoch) ||
      (allowEpochAdvance && currentEpoch + 1 !== fence.runEpoch)
    ) {
      throw new WorkflowRunStoreError(
        "epoch_mismatch",
        "Workflow run epoch fence is stale.",
      );
    }
    if (scanned.tornTailBytes > 0) {
      await this._repairTornTail(lease, journal._paths(), journal.runId);
      scanned = await this._scanJournal(journal._paths(), journal.runId);
    }

    const encoded = encodeDurableValue(event, this.#eventLimits);
    const lineBytes = Buffer.from(`${encoded.json}\n`, "utf8");
    const existing = scanned.records.find(
      (record) => record.event.eventId === event.eventId,
    );
    if (existing !== undefined) {
      if (!existing.lineBytes.equals(lineBytes)) {
        throw new WorkflowRunStoreError(
          "event_mismatch",
          "A workflow event ID already names different authoritative bytes.",
        );
      }
      const handle = await this.#openRegularHandle(
        journal._paths().events,
        fsConstants.O_RDWR,
        "events",
      );
      try {
        await this.#assertRegularFile(handle, "events");
        await this.#syncFile(handle, "events");
        await this.#assertHandleNamesPath(
          handle,
          journal._paths().events,
          "events",
        );
      } finally {
        await handle.close();
      }
      await this._assertNamespaceFence(lease, ownerPaths);
      return this.#receipt(existing, event);
    }

    const previousSequence =
      scanned.events[scanned.events.length - 1]?.sequence ?? 0;
    if (event.sequence !== previousSequence + 1) {
      throw new WorkflowRunStoreError(
        "sequence_mismatch",
        "Workflow event sequence does not extend the physical prefix.",
      );
    }
    await this.#assertOwnerGrowth(ownerPaths, journal.runId, {
      bytes: lineBytes.length,
      blobs: 0,
      events: scanned.records.length + 1,
      runs: 0,
    });
    const byteStart = scanned.completeBytes;
    const handle = await this.#openRegularHandle(
      journal._paths().events,
      fsConstants.O_RDWR,
      "events",
    );
    try {
      await this.#assertRegularFile(handle, "events");
      await this.#beforeIo("append", "events");
      let written = 0;
      while (written < lineBytes.length) {
        const result = await handle.write(
          lineBytes,
          written,
          lineBytes.length - written,
          byteStart + written,
        );
        if (result.bytesWritten <= 0) {
          throw new Error("Workflow event append made no forward progress.");
        }
        written += result.bytesWritten;
      }
      await this.#syncFile(handle, "events");
      await this.#assertHandleNamesPath(
        handle,
        journal._paths().events,
        "events",
      );
    } finally {
      await handle.close();
    }
    await this._assertNamespaceFence(lease, ownerPaths);
    return {
      schemaVersion: 1,
      runId: event.runId,
      eventId: event.eventId,
      runEpoch: event.runEpoch,
      byteStart,
      byteEndExclusive: byteStart + lineBytes.length,
      lineDigest: createWorkflowSha256Digest(sha256(lineBytes)),
    };
  }

  async _scanJournal(
    paths: RunPaths,
    runId: DurableWorkflowRunId,
  ): Promise<ScannedJournal> {
    const bytes = await this.#readRegularFile(
      paths.events,
      "events",
      this.quotas.maxBytesPerRun,
    );
    const records: ScannedEvent[] = [];
    let byteStart = 0;
    let previousSequence = 0;
    let previousEpoch = 0;
    while (byteStart < bytes.length) {
      const newline = bytes.indexOf(0x0a, byteStart);
      if (newline < 0) break;
      const byteEndExclusive = newline + 1;
      const content = bytes.subarray(byteStart, newline);
      let decoded: unknown;
      try {
        assertWorkflowQuota(
          "maxEventBytes",
          byteEndExclusive - byteStart,
          this.quotas,
        );
        decoded = decodeDurableValue(content, this.#eventLimits);
      } catch (error) {
        throw new WorkflowRunStoreError(
          "malformed_complete_line",
          "A complete workflow journal line is malformed or non-canonical.",
          { byteOffset: byteStart, cause: error },
        );
      }
      if (!isWorkflowRunEvent(decoded) || decoded.runId !== runId) {
        throw new WorkflowRunStoreError(
          "malformed_complete_line",
          "A complete workflow journal line does not match the run event schema.",
          { byteOffset: byteStart },
        );
      }
      if (
        decoded.sequence !== previousSequence + 1 ||
        decoded.runEpoch < previousEpoch
      ) {
        throw new WorkflowRunStoreError(
          "malformed_complete_line",
          "A complete workflow journal line violates sequence or epoch order.",
          { byteOffset: byteStart },
        );
      }
      const lineBytes = bytes.subarray(byteStart, byteEndExclusive);
      records.push({
        event: decoded,
        byteStart,
        byteEndExclusive,
        lineBytes,
      });
      assertWorkflowQuota("maxEventsPerRun", records.length, this.quotas);
      previousSequence = decoded.sequence;
      previousEpoch = decoded.runEpoch;
      byteStart = byteEndExclusive;
    }
    return {
      records,
      events: records.map((record) => record.event),
      completeBytes: byteStart,
      tornTailBytes: bytes.length - byteStart,
    };
  }

  async _repairTornTail(
    lease: PersistedWorkflowNamespaceLease,
    paths: RunPaths,
    runId: DurableWorkflowRunId,
  ): Promise<number> {
    const ownerPaths = await this.#ownerPaths(lease.durableOwner, false);
    await this._assertNamespaceFence(lease, ownerPaths);
    const scanned = await this._scanJournal(paths, runId);
    if (scanned.tornTailBytes === 0) return 0;
    const handle = await this.#openRegularHandle(
      paths.events,
      fsConstants.O_RDWR,
      "events",
    );
    try {
      await this._assertNamespaceFence(lease, ownerPaths);
      await this.#beforeIo("replace", "events");
      await handle.truncate(scanned.completeBytes);
      await this.#syncFile(handle, "events");
      await this.#assertHandleNamesPath(handle, paths.events, "events");
    } finally {
      await handle.close();
    }
    await this._assertNamespaceFence(lease, ownerPaths);
    return scanned.tornTailBytes;
  }

  async _writeDefinition(
    journal: WorkflowRunJournal,
    source: string,
  ): Promise<WorkflowBlobReference> {
    if (typeof source !== "string") {
      throw new TypeError("Workflow definition source must be a string.");
    }
    await this.#assertJournalFence(journal);
    const byteLength = Buffer.byteLength(source, "utf8");
    assertWorkflowQuota("maxBlobBytes", byteLength, this.quotas);
    const bytes = Buffer.from(source, "utf8");
    const digest = createWorkflowSha256Digest(sha256(bytes));
    const destination = join(journal._paths().definitions, `${digest}.js`);
    assertContained(journal._paths().definitions, destination);
    await this.#publishOrVerifyBlob(
      journal,
      journal._paths().definitions,
      destination,
      bytes,
      digest,
      "definition",
    );
    await this.#assertJournalFence(journal);
    return { sha256: digest, sizeBytes: bytes.length };
  }

  async _readDefinition(
    journal: WorkflowRunJournal,
    reference: WorkflowBlobReference,
  ): Promise<string> {
    const bytes = await this.#readBlob(
      journal._paths().definitions,
      ".js",
      reference,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async _writeOutput(
    journal: WorkflowRunJournal,
    value: unknown,
  ): Promise<WorkflowBlobReference> {
    await this.#assertJournalFence(journal);
    const encoded = encodeDurableValue(value, this.#valueLimits);
    assertWorkflowQuota("maxBlobBytes", encoded.bytes, this.quotas);
    const bytes = Buffer.from(encoded.json, "utf8");
    const digest = createWorkflowSha256Digest(encoded.sha256);
    const destination = join(journal._paths().outputs, `${digest}.json`);
    assertContained(journal._paths().outputs, destination);
    await this.#publishOrVerifyBlob(
      journal,
      journal._paths().outputs,
      destination,
      bytes,
      digest,
      "output",
    );
    await this.#assertJournalFence(journal);
    return { sha256: digest, sizeBytes: encoded.bytes };
  }

  async _readOutput(
    journal: WorkflowRunJournal,
    reference: WorkflowBlobReference,
  ): Promise<DurableValue> {
    const bytes = await this.#readBlob(
      journal._paths().outputs,
      ".json",
      reference,
    );
    return decodeDurableValue(bytes, this.#valueLimits);
  }

  async _writeState(
    journal: WorkflowRunJournal,
    value: unknown,
  ): Promise<void> {
    await this.#assertJournalFence(journal);
    const encoded = encodeDurableValue(value, this.#valueLimits);
    const bytes = Buffer.from(encoded.json, "utf8");
    const previousBytes = await this.#optionalRegularFileSize(
      journal._paths().state,
      "state",
    );
    const ownerPaths = await this.#ownerPaths(journal.owner, false);
    await this.#assertOwnerGrowth(ownerPaths, journal.runId, {
      bytes: Math.max(0, bytes.length - previousBytes),
      blobs: 0,
      events: 0,
      runs: 0,
    });
    await this.#replaceDisposable(
      journal._paths().directory,
      journal._paths().state,
      bytes,
      "state",
    );
    await this.#assertJournalFence(journal);
  }

  async _readState(
    journal: WorkflowRunJournal,
  ): Promise<DurableValue | undefined> {
    try {
      const bytes = await this.#readRegularFile(
        journal._paths().state,
        "state",
        this.quotas.maxValueBytes,
      );
      return decodeDurableValue(bytes, this.#valueLimits);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async _writeResult(
    journal: WorkflowRunJournal,
    input: WorkflowRunResultWrite,
  ): Promise<WorkflowRunResultRecord> {
    const fence = journal._requiredFence();
    if (
      !isWorkflowIdentifier(input.terminalEventId) ||
      !isNonNegativeSafeInteger(input.baseEventByteEndExclusive) ||
      !isBlobReference(input.result)
    ) {
      throw new TypeError("Workflow result binding is invalid.");
    }
    await this.#assertJournalFence(journal);
    const scanned = await this._scanJournal(journal._paths(), journal.runId);
    if (input.baseEventByteEndExclusive > scanned.completeBytes) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Workflow result is bound beyond the authoritative event prefix.",
      );
    }
    const terminal = scanned.records.find(
      (record) => record.event.eventId === input.terminalEventId,
    );
    if (
      terminal === undefined ||
      terminal.event.type !== "run_terminal" ||
      terminal.byteEndExclusive > input.baseEventByteEndExclusive
    ) {
      throw new WorkflowRunStoreError(
        "event_mismatch",
        "Workflow result terminal event is absent from its bound prefix.",
      );
    }
    await this.#readBlob(journal._paths().outputs, ".json", input.result);
    const record: WorkflowRunResultRecord = {
      schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
      durableOwner: journal.owner,
      runId: journal.runId,
      runEpoch: fence.runEpoch,
      terminalEventId: input.terminalEventId,
      baseEventByteEndExclusive: input.baseEventByteEndExclusive,
      result: input.result,
    };
    const encoded = encodeDurableValue(record, this.#valueLimits);
    try {
      await this.#assertPathIsRegularFile(journal._paths().result, "result");
      throw new WorkflowRunStoreError(
        "result_exists",
        "Workflow terminal results are immutable.",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const ownerPaths = await this.#ownerPaths(journal.owner, false);
    await this.#assertOwnerGrowth(ownerPaths, journal.runId, {
      bytes: encoded.bytes,
      blobs: 0,
      events: 0,
      runs: 0,
    });
    try {
      await this.#publishImmutable(
        journal._paths().directory,
        journal._paths().result,
        Buffer.from(encoded.json, "utf8"),
        "result",
      );
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new WorkflowRunStoreError(
          "result_exists",
          "Workflow terminal results are immutable.",
          { cause: error },
        );
      }
      throw error;
    }
    await this.#assertJournalFence(journal);
    return record;
  }

  async _readResult(
    journal: WorkflowRunJournal,
  ): Promise<WorkflowRunResultRecord | undefined> {
    let decoded: unknown;
    try {
      const bytes = await this.#readRegularFile(
        journal._paths().result,
        "result",
        this.quotas.maxValueBytes,
      );
      decoded = decodeDurableValue(bytes, this.#valueLimits);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (
      !isResultRecord(decoded) ||
      !ownerEquals(decoded.durableOwner, journal.owner) ||
      decoded.runId !== journal.runId
    ) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow result binding is corrupt.",
      );
    }
    await this.#readBlob(journal._paths().outputs, ".json", decoded.result);
    const scanned = await this._scanJournal(journal._paths(), journal.runId);
    const terminal = scanned.records.find(
      (record) => record.event.eventId === decoded.terminalEventId,
    );
    if (
      decoded.baseEventByteEndExclusive > scanned.completeBytes ||
      terminal === undefined ||
      terminal.event.type !== "run_terminal" ||
      terminal.event.runEpoch !== decoded.runEpoch ||
      terminal.byteEndExclusive > decoded.baseEventByteEndExclusive
    ) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow result does not match its authoritative event prefix.",
      );
    }
    return decoded;
  }

  async _revalidateJournalFence(journal: WorkflowRunJournal): Promise<void> {
    await this.#assertJournalFence(journal);
  }

  async _classifyRetention(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    options: WorkflowRetentionPolicyOptions = {},
  ): Promise<readonly WorkflowRetentionClassification[]> {
    await this._assertNamespaceFence(lease, ownerPaths);
    const policy = resolveWorkflowRetentionPolicy(options);
    const usage = await this.#measureOwner(ownerPaths, false);
    const ordered = [...usage.runs.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        left.lastActivityMs - right.lastActivityMs ||
        leftId.localeCompare(rightId),
    );
    const capacity = Math.max(0, usage.runs.size - policy.minimumRunsPerOwner);
    const classifications: WorkflowRetentionClassification[] = [];
    let eligibleCount = 0;
    for (const [runId, runUsage] of ordered) {
      const classification = await this.#classifyStoredRun(
        lease.durableOwner,
        runId,
        usage.runs.size,
        runUsage.lastActivityMs,
        policy,
      );
      if (!classification.eligible) {
        classifications.push(classification);
        continue;
      }
      if (eligibleCount >= capacity) {
        classifications.push(
          Object.freeze({
            owner: classification.owner,
            runId: classification.runId,
            runEpoch: classification.runEpoch,
            lastActivityMs: classification.lastActivityMs,
            eligible: false,
            reason: "owner_minimum_runs",
          }),
        );
        continue;
      }
      if (eligibleCount >= policy.maxPrunesPerPass) {
        classifications.push(
          Object.freeze({
            owner: classification.owner,
            runId: classification.runId,
            runEpoch: classification.runEpoch,
            lastActivityMs: classification.lastActivityMs,
            eligible: false,
            reason: "pass_limit",
          }),
        );
        continue;
      }
      eligibleCount += 1;
      this.#retentionCandidates.add(classification);
      classifications.push(classification);
    }
    return Object.freeze(classifications);
  }
  async #runAutomaticRetention(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
  ): Promise<void> {
    if (this.#retentionPolicy === undefined) return;
    const classifications = await this._classifyRetention(
      lease,
      ownerPaths,
      this.#retentionPolicy,
    );
    for (const classification of classifications) {
      if (!classification.eligible) continue;
      await this._pruneRetentionCandidate(lease, ownerPaths, classification);
    }
  }

  async _pruneRetentionCandidate(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    candidate: WorkflowRetentionCandidate,
  ): Promise<void> {
    if (
      !this.#retentionCandidates.has(candidate) ||
      !ownerEquals(candidate.owner, lease.durableOwner)
    ) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Retention candidate was not issued to the current trusted owner.",
      );
    }
    await this._assertNamespaceFence(lease, ownerPaths);
    const usage = await this.#measureOwner(ownerPaths, false);
    const runUsage = usage.runs.get(candidate.runId);
    if (runUsage === undefined) {
      throw new WorkflowRunStoreError(
        "run_not_found",
        "Retention candidate no longer exists.",
      );
    }
    const current = await this.#classifyStoredRun(
      lease.durableOwner,
      candidate.runId,
      usage.runs.size,
      runUsage.lastActivityMs,
      candidate.policy,
    );
    if (
      !current.eligible ||
      current.runEpoch !== candidate.runEpoch ||
      current.terminalEventId !== candidate.terminalEventId ||
      current.resultEventId !== candidate.resultEventId ||
      current.deliveryReceiptEventId !== candidate.deliveryReceiptEventId
    ) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Retention evidence changed before destructive prune.",
      );
    }
    await this._assertNamespaceFence(lease, ownerPaths);
    await this.#pruneRunFiles(
      lease,
      ownerPaths,
      this.#derivedRunPaths(ownerPaths, candidate.runId),
    );
    this.#retentionCandidates.delete(candidate);
  }

  async #classifyStoredRun(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
    ownerRunCount: number,
    lastActivityMs: number,
    policy: WorkflowRetentionPolicyOptions,
  ): Promise<WorkflowRetentionClassification> {
    let runEpoch = 0;
    try {
      const paths = await this.#existingRunPaths(owner, runId);
      const launch = await this.#readLaunch(paths.launch, owner, runId);
      const scanned = await this._scanJournal(paths, runId);
      runEpoch = this.#currentEpoch(launch, scanned.events);
      const projection = foldWorkflowRunEvents(scanned.events);
      const journal = new WorkflowRunJournal(
        this,
        owner,
        runId,
        paths,
        launch,
        undefined,
      );
      const result = await this._readResult(journal);
      const durableResultMatches =
        result !== undefined &&
        projection.result !== undefined &&
        projection.terminal !== undefined &&
        result.terminalEventId === projection.terminal.eventId &&
        result.result.sha256 === projection.result.result.sha256 &&
        result.result.sizeBytes === projection.result.result.sizeBytes;
      return classifyWorkflowRunRetention(
        {
          projection,
          events: scanned.events,
          durableResultMatches,
          lastActivityMs,
          ownerRunCount,
          nowMs: this.#now(),
        },
        policy,
      );
    } catch {
      return Object.freeze({
        owner,
        runId,
        runEpoch,
        lastActivityMs,
        eligible: false,
        reason: "authoritative_corruption",
      });
    }
  }

  async #assertJournalFence(journal: WorkflowRunJournal): Promise<void> {
    const fence = journal._requiredFence();
    const lease = journal._leaseRecord();
    const ownerPaths = await this.#ownerPaths(journal.owner, false);
    await this._assertNamespaceFence(lease, ownerPaths);
    const scanned = await this._scanJournal(journal._paths(), journal.runId);
    if (
      this.#currentEpoch(journal._launch(), scanned.events) !== fence.runEpoch
    ) {
      throw new WorkflowRunStoreError(
        "epoch_mismatch",
        "Workflow run epoch fence is stale.",
      );
    }
  }

  #runFence(
    lease: PersistedWorkflowNamespaceLease,
    runId: DurableWorkflowRunId,
    runEpoch: number,
  ): WorkflowRunEpochFence {
    return {
      durableOwner: lease.durableOwner,
      scopeId: lease.scopeId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
      runId,
      runEpoch,
    };
  }

  #currentEpoch(
    launch: WorkflowRunLaunchRecord,
    events: readonly WorkflowRunEvent[],
  ): number {
    let epoch: number = launch.initialRunEpoch;
    for (const event of events) epoch = Math.max(epoch, event.runEpoch);
    return epoch;
  }

  #receipt(
    record: ScannedEvent,
    event: WorkflowRunEvent,
  ): WorkflowEventReceipt {
    return {
      schemaVersion: 1,
      runId: event.runId,
      eventId: event.eventId,
      runEpoch: event.runEpoch,
      byteStart: record.byteStart,
      byteEndExclusive: record.byteEndExclusive,
      lineDigest: createWorkflowSha256Digest(sha256(record.lineBytes)),
    };
  }

  async #replaceStaleLease(
    paths: OwnerPaths,
    expected: PersistedWorkflowNamespaceLease,
    next: PersistedWorkflowNamespaceLease,
  ): Promise<void> {
    const current = await this.#readLease(paths.lease);
    if (
      current === undefined ||
      current.leaseToken !== expected.leaseToken ||
      current.pid !== expected.pid ||
      current.processStartIdentity !== expected.processStartIdentity
    ) {
      throw new WorkflowRunStoreError(
        "lease_ambiguous",
        "Workflow namespace lease changed during stale takeover.",
      );
    }
    const retired = join(
      paths.namespace,
      `.owner-lease-retired-${randomToken(this.#randomBytes)}`,
    );
    assertContained(paths.namespace, retired);
    const expectedStats = await this.#assertPathIsRegularFile(
      paths.lease,
      "lease",
    );
    await rename(paths.lease, retired);
    const retiredStats = await this.#assertPathIsRegularFile(retired, "lease");
    const moved = await this.#readLease(retired);
    if (
      retiredStats.dev !== expectedStats.dev ||
      retiredStats.ino !== expectedStats.ino ||
      moved === undefined ||
      !ownerEquals(moved.durableOwner, expected.durableOwner) ||
      moved.scopeId !== expected.scopeId ||
      moved.generation !== expected.generation ||
      moved.leaseToken !== expected.leaseToken ||
      moved.pid !== expected.pid ||
      moved.processStartIdentity !== expected.processStartIdentity
    ) {
      try {
        await link(retired, paths.lease);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      await unlink(retired);
      await this.#syncDirectory(paths.namespace, "lease");
      throw new WorkflowRunStoreError(
        "lease_ambiguous",
        "Workflow namespace lease changed during stale takeover.",
      );
    }
    try {
      const encoded = encodeDurableValue(next, this.#valueLimits);
      await this.#publishImmutable(
        paths.namespace,
        paths.lease,
        Buffer.from(encoded.json, "utf8"),
        "lease",
      );
    } catch (error) {
      try {
        await link(retired, paths.lease);
      } catch {
        // A concurrent lease is authoritative; never replace it with the retired one.
      }
      throw error;
    } finally {
      try {
        await unlink(retired);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await this.#syncDirectory(paths.namespace, "lease");
  }

  async #readLease(
    path: string,
  ): Promise<PersistedWorkflowNamespaceLease | undefined> {
    let decoded: unknown;
    try {
      const bytes = await this.#readRegularFile(
        path,
        "lease",
        this.quotas.maxValueBytes,
      );
      decoded = decodeDurableValue(bytes, this.#valueLimits);
    } catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof WorkflowRunStoreError) throw error;
      throw new WorkflowRunStoreError(
        "lease_corrupt",
        "Workflow namespace lease is malformed.",
        { cause: error },
      );
    }
    if (!isPersistedLease(decoded)) {
      throw new WorkflowRunStoreError(
        "lease_corrupt",
        "Workflow namespace lease has an invalid exact shape.",
      );
    }
    return decoded;
  }

  async #readLaunch(
    path: string,
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowRunLaunchRecord> {
    let decoded: unknown;
    try {
      const bytes = await this.#readRegularFile(
        path,
        "launch",
        this.quotas.maxValueBytes,
      );
      decoded = decodeDurableValue(bytes, this.#valueLimits);
    } catch (error) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow launch snapshot is malformed.",
        { cause: error },
      );
    }
    if (
      !isLaunchRecord(decoded) ||
      !ownerEquals(decoded.durableOwner, owner) ||
      decoded.runId !== runId
    ) {
      throw new WorkflowRunStoreError(
        "immutable_conflict",
        "Workflow launch snapshot owner or run binding is invalid.",
      );
    }
    return decoded;
  }

  async #ownerPaths(
    owner: DurableWorkflowOwner,
    create: boolean,
  ): Promise<OwnerPaths> {
    if (!isDurableWorkflowOwner(owner)) {
      throw new WorkflowRunStoreError(
        "invalid_owner",
        "Durable workflow owner is invalid.",
      );
    }
    let current = this.#homeDir;
    for (const segment of STORE_SEGMENTS) {
      current = join(current, segment);
      await this.#ensureDirectory(current, create);
    }
    const project = join(current, owner.projectKey);
    const namespace = join(project, owner.piSessionKey);
    const runs = join(namespace, RUNS_DIRECTORY);
    assertContained(this.rootDirectory, project);
    assertContained(this.rootDirectory, namespace);
    await this.#ensureDirectory(project, create);
    await this.#ensureDirectory(namespace, create);
    await this.#ensureDirectory(runs, create);
    return {
      namespace,
      lease: join(namespace, LEASE_FILE),
      runs,
    };
  }

  #derivedRunPaths(
    ownerPaths: OwnerPaths,
    runId: DurableWorkflowRunId,
  ): RunPaths {
    if (!isDurableWorkflowRunId(runId)) {
      throw new WorkflowRunStoreError(
        "invalid_run_id",
        "Durable workflow run ID is invalid.",
      );
    }
    const directory = join(ownerPaths.runs, runId);
    assertContained(ownerPaths.runs, directory);
    return {
      directory,
      launch: join(directory, LAUNCH_FILE),
      events: join(directory, EVENTS_FILE),
      state: join(directory, STATE_FILE),
      result: join(directory, RESULT_FILE),
      definitions: join(directory, DEFINITIONS_DIRECTORY),
      outputs: join(directory, OUTPUTS_DIRECTORY),
    };
  }

  async #existingRunPaths(
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
  ): Promise<RunPaths> {
    const ownerPaths = await this.#ownerPaths(owner, false);
    const paths = this.#derivedRunPaths(ownerPaths, runId);
    try {
      await this.#ensureDirectory(paths.directory, false);
      await this.#ensureDirectory(paths.definitions, false);
      await this.#ensureDirectory(paths.outputs, false);
    } catch (error) {
      if (isMissing(error)) {
        throw new WorkflowRunStoreError(
          "run_not_found",
          "Durable workflow run does not exist.",
          { cause: error },
        );
      }
      throw error;
    }
    return paths;
  }

  async #ensureDirectory(path: string, create: boolean): Promise<void> {
    let created = false;
    if (create) {
      try {
        await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
        created = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new WorkflowRunStoreError(
        "symlink_rejected",
        "Workflow store directories cannot be symbolic links.",
      );
    }
    if (!stats.isDirectory()) {
      throw new WorkflowRunStoreError(
        "path_mismatch",
        "Workflow store path is not a directory.",
      );
    }
    if (created) {
      await chmod(path, PRIVATE_DIRECTORY_MODE);
    } else if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      throw new WorkflowRunStoreError(
        "path_mismatch",
        "Workflow store directories must have exact owner-only mode 0700.",
      );
    }
  }
  async #recoverImmutableDirectory(
    lease: PersistedWorkflowNamespaceLease | undefined,
    ownerPaths: OwnerPaths,
    directoryPath: string,
    purpose: WorkflowRunStoreSyncPurpose,
    isDestinationName: (name: string) => boolean,
  ): Promise<void> {
    await this.#ensureDirectory(directoryPath, false);
    const names: string[] = [];
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) names.push(entry.name);
    } finally {
      await directory.close().catch(() => undefined);
    }

    let changed = false;
    for (const name of names) {
      if (!name.startsWith(".publish-")) continue;
      const token = name.slice(".publish-".length, -".tmp".length);
      if (!name.endsWith(".tmp") || !isWorkflowLeaseToken(token)) {
        throw new WorkflowRunStoreError(
          "path_mismatch",
          "Malformed immutable publish recovery path.",
        );
      }
      const temporary = join(directoryPath, name);
      assertContained(directoryPath, temporary);
      const temporaryStats = await lstat(temporary);
      if (
        temporaryStats.isSymbolicLink() ||
        !temporaryStats.isFile() ||
        (temporaryStats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        (temporaryStats.nlink !== 1 && temporaryStats.nlink !== 2)
      ) {
        throw new WorkflowRunStoreError(
          temporaryStats.isSymbolicLink()
            ? "symlink_rejected"
            : "path_mismatch",
          "Immutable publish recovery found an unsafe temporary file.",
        );
      }

      let destination: string | undefined;
      if (temporaryStats.nlink === 2) {
        for (const candidateName of names) {
          if (candidateName === name || !isDestinationName(candidateName))
            continue;
          const candidate = join(directoryPath, candidateName);
          assertContained(directoryPath, candidate);
          const candidateStats = await lstat(candidate);
          if (
            candidateStats.dev === temporaryStats.dev &&
            candidateStats.ino === temporaryStats.ino
          ) {
            if (destination !== undefined) {
              throw new WorkflowRunStoreError(
                "path_mismatch",
                "Immutable publish recovery found ambiguous hard links.",
              );
            }
            destination = candidate;
          }
        }
        if (destination === undefined) {
          throw new WorkflowRunStoreError(
            "path_mismatch",
            "Immutable publish recovery could not identify its destination.",
          );
        }
      }

      if (lease !== undefined) {
        await this._assertNamespaceFence(lease, ownerPaths);
      }
      await this.#beforeIo("recover", purpose);
      await unlink(temporary);
      changed = true;
      if (destination !== undefined) {
        await this.#assertPathIsRegularFile(destination, purpose);
      }
    }
    if (changed) await this.#syncDirectory(directoryPath, purpose);
  }

  async #recoverOwnerPublishes(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
  ): Promise<void> {
    await this._assertNamespaceFence(lease, ownerPaths);
    const runIds: DurableWorkflowRunId[] = [];
    const directory = await opendir(ownerPaths.runs);
    try {
      for await (const entry of directory) {
        if (
          entry.isSymbolicLink() ||
          !entry.isDirectory() ||
          !isDurableWorkflowRunId(entry.name)
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            "Invalid entry in workflow owner run namespace.",
          );
        }
        runIds.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (const runId of runIds) {
      const paths = this.#derivedRunPaths(ownerPaths, runId);
      await this.#recoverImmutableDirectory(
        lease,
        ownerPaths,
        paths.directory,
        "launch",
        (name) => name === LAUNCH_FILE || name === RESULT_FILE,
      );
      await this.#recoverImmutableDirectory(
        lease,
        ownerPaths,
        paths.definitions,
        "definition",
        (name) =>
          name.endsWith(".js") &&
          isWorkflowSha256Digest(name.slice(0, -".js".length)),
      );
      await this.#recoverImmutableDirectory(
        lease,
        ownerPaths,
        paths.outputs,
        "output",
        (name) =>
          name.endsWith(".json") &&
          isWorkflowSha256Digest(name.slice(0, -".json".length)),
      );
    }
  }

  async #publishImmutable(
    directory: string,
    destination: string,
    bytes: Buffer,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    assertContained(directory, destination);
    try {
      const existing = await lstat(destination);
      this.#assertRegularFileStats(existing, purpose);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const temporary = join(
      directory,
      `.publish-${randomToken(this.#randomBytes)}.tmp`,
    );
    assertContained(directory, temporary);
    try {
      const handle = await open(
        temporary,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        await chmod(temporary, PRIVATE_FILE_MODE);
        await this.#assertRegularFile(handle, purpose);
        await this.#beforeIo("temporary_write", purpose);
        await handle.writeFile(bytes);
        await this.#syncFile(handle, purpose);
      } finally {
        await handle.close();
      }
      await this.#beforeIo("publish", purpose);
      await link(temporary, destination);
      await chmod(destination, PRIVATE_FILE_MODE);
      await this.#syncDirectory(directory, purpose);
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await this.#assertPathIsRegularFile(destination, purpose);
    await this.#syncDirectory(directory, purpose);
  }

  async #publishOrVerifyBlob(
    journal: WorkflowRunJournal,
    directory: string,
    destination: string,
    bytes: Buffer,
    digest: WorkflowSha256Digest,
    purpose: "definition" | "output",
  ): Promise<void> {
    const reference = { sha256: digest, sizeBytes: bytes.length };
    const extension = purpose === "definition" ? ".js" : ".json";
    try {
      const existing = await this.#readBlob(directory, extension, reference);
      if (!existing.equals(bytes)) {
        throw new WorkflowRunStoreError(
          "immutable_conflict",
          "Immutable workflow blob bytes conflict with their digest path.",
        );
      }
      const handle = await this.#openRegularHandle(
        destination,
        fsConstants.O_RDONLY,
        purpose,
      );
      try {
        await this.#syncFile(handle, purpose);
      } finally {
        await handle.close();
      }
      await this.#syncDirectory(directory, purpose);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const ownerPaths = await this.#ownerPaths(journal.owner, false);
    await this.#assertOwnerGrowth(ownerPaths, journal.runId, {
      bytes: bytes.length,
      blobs: 1,
      events: 0,
      runs: 0,
    });
    await this.#assertJournalFence(journal);
    try {
      await this.#publishImmutable(directory, destination, bytes, purpose);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.#readBlob(directory, extension, reference);
      if (!existing.equals(bytes)) {
        throw new WorkflowRunStoreError(
          "immutable_conflict",
          "Immutable workflow blob bytes conflict with their digest path.",
        );
      }
      await this.#syncDirectory(directory, purpose);
    }
  }

  async #readBlob(
    directory: string,
    extension: ".js" | ".json",
    reference: WorkflowBlobReference,
  ): Promise<Buffer> {
    if (!isBlobReference(reference)) {
      throw new TypeError("Workflow blob reference is invalid.");
    }
    assertWorkflowQuota("maxBlobBytes", reference.sizeBytes, this.quotas);
    const path = join(directory, `${reference.sha256}${extension}`);
    assertContained(directory, path);
    const bytes = await this.#readRegularFile(
      path,
      extension === ".js" ? "definition" : "output",
      this.quotas.maxBlobBytes,
    );
    if (bytes.length !== reference.sizeBytes) {
      throw new WorkflowRunStoreError(
        "size_mismatch",
        "Immutable workflow blob size does not match its reference.",
      );
    }
    if (sha256(bytes) !== reference.sha256) {
      throw new WorkflowRunStoreError(
        "hash_mismatch",
        "Immutable workflow blob digest does not match its reference.",
      );
    }
    return bytes;
  }

  async #replaceDisposable(
    directory: string,
    destination: string,
    bytes: Buffer,
    purpose: "state",
  ): Promise<void> {
    assertContained(directory, destination);
    try {
      this.#assertRegularFileStats(await lstat(destination), purpose);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const temporary = join(
      directory,
      `.state-${randomToken(this.#randomBytes)}.tmp`,
    );
    assertContained(directory, temporary);
    try {
      const handle = await open(
        temporary,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      try {
        await chmod(temporary, PRIVATE_FILE_MODE);
        await this.#assertRegularFile(handle, purpose);
        await this.#beforeIo("temporary_write", purpose);
        await handle.writeFile(bytes);
        await this.#syncFile(handle, purpose);
      } finally {
        await handle.close();
      }
      await this.#beforeIo("replace", purpose);
      await rename(temporary, destination);
      await chmod(destination, PRIVATE_FILE_MODE);
      await this.#assertPathIsRegularFile(destination, purpose);
      await this.#syncDirectory(directory, purpose);
    } finally {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async #assertPathIsRegularFile(
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<Stats> {
    const stats = await lstat(path);
    this.#assertRegularFileStats(stats, purpose);
    return stats;
  }

  #assertRegularFileStats(
    stats: Stats,
    purpose: WorkflowRunStoreSyncPurpose,
  ): void {
    if (stats.isSymbolicLink()) {
      throw new WorkflowRunStoreError(
        "symlink_rejected",
        `Workflow ${purpose} path cannot be a symbolic link.`,
      );
    }
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== PRIVATE_FILE_MODE
    ) {
      throw new WorkflowRunStoreError(
        "path_mismatch",
        `Workflow ${purpose} path must be one regular, owner-only file.`,
      );
    }
  }

  async #openRegularHandle(
    path: string,
    flags: number,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<FileHandle> {
    const before = await this.#assertPathIsRegularFile(path, purpose);
    const handle = await open(path, flags | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      this.#assertRegularFileStats(opened, purpose);
      const after = await this.#assertPathIsRegularFile(path, purpose);
      if (
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        throw new WorkflowRunStoreError(
          "path_mismatch",
          `Workflow ${purpose} path changed while it was opened.`,
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #readRegularFile(
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
    maxBytes: number,
  ): Promise<Buffer> {
    const handle = await this.#openRegularHandle(
      path,
      fsConstants.O_RDONLY,
      purpose,
    );
    try {
      const before = await handle.stat();
      if (before.size > maxBytes) {
        throw new WorkflowRunStoreError(
          "size_mismatch",
          `Workflow ${purpose} file exceeds its bounded read limit.`,
        );
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const current = await this.#assertPathIsRegularFile(path, purpose);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        current.dev !== after.dev ||
        current.ino !== after.ino ||
        bytes.length !== after.size
      ) {
        throw new WorkflowRunStoreError(
          "path_mismatch",
          `Workflow ${purpose} file changed during its bounded read.`,
        );
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async #assertRegularFile(
    handle: FileHandle,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    this.#assertRegularFileStats(await handle.stat(), purpose);
  }

  async #assertHandleNamesPath(
    handle: FileHandle,
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    const opened = await handle.stat();
    this.#assertRegularFileStats(opened, purpose);
    const current = await this.#assertPathIsRegularFile(path, purpose);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new WorkflowRunStoreError(
        "path_mismatch",
        `Workflow ${purpose} path was substituted during I/O.`,
      );
    }
  }

  async #optionalRegularFileSize(
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<number> {
    try {
      return (await this.#assertPathIsRegularFile(path, purpose)).size;
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
  }

  async #measureBlobDirectory(
    directoryPath: string,
    extension: ".js" | ".json",
    purpose: "definition" | "output",
  ): Promise<RunQuotaUsage> {
    await this.#ensureDirectory(directoryPath, false);
    let bytes = 0;
    let blobs = 0;
    let lastActivityMs = 0;
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        if (
          entry.isSymbolicLink() ||
          !entry.isFile() ||
          !entry.name.endsWith(extension) ||
          !isWorkflowSha256Digest(entry.name.slice(0, -extension.length))
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            `Invalid entry in workflow ${purpose} blob directory.`,
          );
        }
        const path = join(directoryPath, entry.name);
        assertContained(directoryPath, path);
        const stats = await this.#assertPathIsRegularFile(path, purpose);
        bytes += stats.size;
        blobs += 1;
        lastActivityMs = Math.max(lastActivityMs, Math.floor(stats.mtimeMs));
        assertWorkflowQuota("maxBlobsPerRun", blobs, this.quotas);
        assertWorkflowQuota("maxBytesPerRun", bytes, this.quotas);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return { bytes, blobs, lastActivityMs };
  }

  async #measureRun(paths: RunPaths): Promise<RunQuotaUsage> {
    await this.#ensureDirectory(paths.directory, false);
    let bytes = 0;
    let lastActivityMs = 0;
    let sawLaunch = false;
    let sawEvents = false;
    let sawDefinitions = false;
    let sawOutputs = false;
    const directory = await opendir(paths.directory);
    try {
      for await (const entry of directory) {
        const path = join(paths.directory, entry.name);
        assertContained(paths.directory, path);
        if (
          entry.name === DEFINITIONS_DIRECTORY ||
          entry.name === OUTPUTS_DIRECTORY
        ) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new WorkflowRunStoreError(
              entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
              "Workflow blob namespace is not a contained directory.",
            );
          }
          await this.#ensureDirectory(path, false);
          sawDefinitions ||= entry.name === DEFINITIONS_DIRECTORY;
          sawOutputs ||= entry.name === OUTPUTS_DIRECTORY;
          continue;
        }
        const purpose =
          entry.name === LAUNCH_FILE
            ? "launch"
            : entry.name === EVENTS_FILE
              ? "events"
              : entry.name === STATE_FILE
                ? "state"
                : entry.name === RESULT_FILE
                  ? "result"
                  : undefined;
        if (
          purpose === undefined ||
          entry.isSymbolicLink() ||
          !entry.isFile()
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            "Unexpected entry in workflow run directory.",
          );
        }
        const stats = await this.#assertPathIsRegularFile(path, purpose);
        bytes += stats.size;
        lastActivityMs = Math.max(lastActivityMs, Math.floor(stats.mtimeMs));
        sawLaunch ||= purpose === "launch";
        sawEvents ||= purpose === "events";
        assertWorkflowQuota("maxBytesPerRun", bytes, this.quotas);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    if (!sawLaunch || !sawEvents || !sawDefinitions || !sawOutputs) {
      throw new WorkflowRunStoreError(
        "path_mismatch",
        "Workflow run layout is incomplete.",
      );
    }
    const definitions = await this.#measureBlobDirectory(
      paths.definitions,
      ".js",
      "definition",
    );
    const outputs = await this.#measureBlobDirectory(
      paths.outputs,
      ".json",
      "output",
    );
    bytes += definitions.bytes + outputs.bytes;
    const blobs = definitions.blobs + outputs.blobs;
    lastActivityMs = Math.max(
      lastActivityMs,
      definitions.lastActivityMs,
      outputs.lastActivityMs,
    );
    assertWorkflowQuota("maxBlobsPerRun", blobs, this.quotas);
    assertWorkflowQuota("maxBytesPerRun", bytes, this.quotas);
    return { bytes, blobs, lastActivityMs };
  }

  async #measureOwner(
    paths: OwnerPaths,
    enforceOwnerQuotas = true,
  ): Promise<OwnerQuotaUsage> {
    let bytes = await this.#optionalRegularFileSize(paths.lease, "lease");
    const runs = new Map<DurableWorkflowRunId, RunQuotaUsage>();
    const directory = await opendir(paths.runs);
    try {
      for await (const entry of directory) {
        if (
          entry.isSymbolicLink() ||
          !entry.isDirectory() ||
          !isDurableWorkflowRunId(entry.name)
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            "Invalid entry in workflow owner run namespace.",
          );
        }
        const usage = await this.#measureRun(
          this.#derivedRunPaths(paths, entry.name),
        );
        runs.set(entry.name, usage);
        bytes += usage.bytes;
        if (enforceOwnerQuotas) {
          assertWorkflowQuota("maxRunsPerOwner", runs.size, this.quotas);
          assertWorkflowQuota("maxBytesPerOwner", bytes, this.quotas);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return { bytes, runs };
  }

  async #assertOwnerGrowth(
    paths: OwnerPaths,
    runId: DurableWorkflowRunId | undefined,
    growth: WorkflowQuotaGrowth,
  ): Promise<void> {
    for (const value of [
      growth.bytes,
      growth.blobs,
      growth.events,
      growth.runs,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(
          "Workflow quota growth must be non-negative and safe.",
        );
      }
    }
    const usage = await this.#measureOwner(paths);
    assertWorkflowQuota(
      "maxRunsPerOwner",
      usage.runs.size + growth.runs,
      this.quotas,
    );
    assertWorkflowQuota(
      "maxBytesPerOwner",
      usage.bytes + growth.bytes,
      this.quotas,
    );
    if (growth.events > 0) {
      assertWorkflowQuota("maxEventsPerRun", growth.events, this.quotas);
    }
    if (runId === undefined) {
      assertWorkflowQuota("maxBytesPerRun", growth.bytes, this.quotas);
      assertWorkflowQuota("maxBlobsPerRun", growth.blobs, this.quotas);
      return;
    }
    const run = usage.runs.get(runId);
    if (run === undefined) {
      throw new WorkflowRunStoreError(
        "run_not_found",
        "Quota authority could not find the target workflow run.",
      );
    }
    assertWorkflowQuota(
      "maxBytesPerRun",
      run.bytes + growth.bytes,
      this.quotas,
    );
    assertWorkflowQuota(
      "maxBlobsPerRun",
      run.blobs + growth.blobs,
      this.quotas,
    );
  }

  #runPathsInDirectory(directory: string): RunPaths {
    return {
      directory,
      launch: join(directory, LAUNCH_FILE),
      events: join(directory, EVENTS_FILE),
      state: join(directory, STATE_FILE),
      result: join(directory, RESULT_FILE),
      definitions: join(directory, DEFINITIONS_DIRECTORY),
      outputs: join(directory, OUTPUTS_DIRECTORY),
    };
  }

  async #recoverRetiredRuns(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
  ): Promise<void> {
    const retired: string[] = [];
    const directory = await opendir(ownerPaths.namespace);
    try {
      for await (const entry of directory) {
        if (!entry.name.startsWith(".prune-")) continue;
        const token = entry.name.slice(".prune-".length, -".tmp".length);
        if (
          !entry.name.endsWith(".tmp") ||
          !isWorkflowLeaseToken(token) ||
          entry.isSymbolicLink() ||
          !entry.isDirectory()
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            "Malformed retired workflow run path.",
          );
        }
        const path = join(ownerPaths.namespace, entry.name);
        assertContained(ownerPaths.namespace, path);
        retired.push(path);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (const path of retired) {
      await this.#deleteRetiredRunFiles(
        lease,
        ownerPaths,
        this.#runPathsInDirectory(path),
      );
    }
  }

  async #blobPathsForPrune(
    directoryPath: string,
    extension: ".js" | ".json",
    purpose: "definition" | "output",
    optional = false,
  ): Promise<readonly string[]> {
    try {
      await this.#ensureDirectory(directoryPath, false);
    } catch (error) {
      if (optional && isMissing(error)) return [];
      throw error;
    }
    const paths: string[] = [];
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        if (
          entry.isSymbolicLink() ||
          !entry.isFile() ||
          !entry.name.endsWith(extension) ||
          !isWorkflowSha256Digest(entry.name.slice(0, -extension.length))
        ) {
          throw new WorkflowRunStoreError(
            entry.isSymbolicLink() ? "symlink_rejected" : "path_mismatch",
            `Invalid workflow ${purpose} path during prune.`,
          );
        }
        const path = join(directoryPath, entry.name);
        assertContained(directoryPath, path);
        await this.#assertPathIsRegularFile(path, purpose);
        paths.push(path);
        assertWorkflowQuota("maxBlobsPerRun", paths.length, this.quotas);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    return paths;
  }

  async #unlinkForPrune(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
    optional = false,
  ): Promise<void> {
    try {
      await this._assertNamespaceFence(lease, ownerPaths);
      await this.#assertPathIsRegularFile(path, purpose);
      await this.#beforeIo("prune", purpose);
      await unlink(path);
    } catch (error) {
      if (optional && isMissing(error)) return;
      throw error;
    }
  }

  async #rmdirForPrune(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    path: string,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    try {
      await this._assertNamespaceFence(lease, ownerPaths);
      await this.#ensureDirectory(path, false);
      await this.#beforeIo("prune", purpose);
      await rmdir(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  async #deleteRetiredRunFiles(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    paths: RunPaths,
  ): Promise<void> {
    const definitions = await this.#blobPathsForPrune(
      paths.definitions,
      ".js",
      "definition",
      true,
    );
    const outputs = await this.#blobPathsForPrune(
      paths.outputs,
      ".json",
      "output",
      true,
    );
    for (const path of definitions) {
      await this.#unlinkForPrune(lease, ownerPaths, path, "definition", true);
    }
    for (const path of outputs) {
      await this.#unlinkForPrune(lease, ownerPaths, path, "output", true);
    }
    await this.#unlinkForPrune(lease, ownerPaths, paths.state, "state", true);
    await this.#unlinkForPrune(lease, ownerPaths, paths.result, "result", true);
    await this.#unlinkForPrune(lease, ownerPaths, paths.events, "events", true);
    await this.#unlinkForPrune(lease, ownerPaths, paths.launch, "launch", true);
    await this.#rmdirForPrune(
      lease,
      ownerPaths,
      paths.definitions,
      "definition",
    );
    await this.#rmdirForPrune(lease, ownerPaths, paths.outputs, "output");
    await this.#rmdirForPrune(lease, ownerPaths, paths.directory, "events");
    await this.#syncDirectory(ownerPaths.namespace, "events");
  }

  async #pruneRunFiles(
    lease: PersistedWorkflowNamespaceLease,
    ownerPaths: OwnerPaths,
    paths: RunPaths,
  ): Promise<void> {
    await this.#measureRun(paths);
    const retiredDirectory = join(
      ownerPaths.namespace,
      `.prune-${randomToken(this.#randomBytes)}.tmp`,
    );
    assertContained(ownerPaths.namespace, retiredDirectory);
    await this._assertNamespaceFence(lease, ownerPaths);
    await this.#beforeIo("prune", "events");
    await rename(paths.directory, retiredDirectory);
    await this.#syncDirectory(ownerPaths.runs, "events");
    await this.#syncDirectory(ownerPaths.namespace, "events");
    await this.#deleteRetiredRunFiles(
      lease,
      ownerPaths,
      this.#runPathsInDirectory(retiredDirectory),
    );
  }

  async #beforeIo(
    boundary: WorkflowRunStoreWriteBoundary,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    await this.#ioHooks.before?.(boundary, purpose);
  }

  async #syncFile(
    handle: FileHandle,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    if (this.#syncHooks.file !== undefined) {
      await this.#syncHooks.file(handle, purpose);
      return;
    }
    await handle.sync();
  }

  async #syncDirectory(
    directory: string,
    purpose: WorkflowRunStoreSyncPurpose,
  ): Promise<void> {
    await this.#ensureDirectory(directory, false);
    const before = await lstat(directory);
    const handle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isDirectory() ||
        (opened.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino
      ) {
        throw new WorkflowRunStoreError(
          "path_mismatch",
          "Workflow directory changed while it was opened for sync.",
        );
      }
      if (this.#syncHooks.directory !== undefined) {
        await this.#syncHooks.directory(handle, purpose);
      } else {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  }
}

export class WorkflowRunLease {
  readonly owner: DurableWorkflowOwner;
  readonly fence: WorkflowNamespaceLeaseFence;

  readonly #store: WorkflowRunStore;
  readonly #ownerPaths: OwnerPaths;
  readonly #lease: PersistedWorkflowNamespaceLease;
  readonly #staleTakeover: boolean;
  readonly #runs = new Map<DurableWorkflowRunId, WorkflowRunJournal>();
  #released = false;

  constructor(
    store: WorkflowRunStore,
    ownerPaths: OwnerPaths,
    lease: PersistedWorkflowNamespaceLease,
    staleTakeover: boolean,
  ) {
    this.#store = store;
    this.#ownerPaths = ownerPaths;
    this.#lease = lease;
    this.#staleTakeover = staleTakeover;
    this.owner = lease.durableOwner;
    this.fence = Object.freeze({
      durableOwner: lease.durableOwner,
      scopeId: lease.scopeId,
      generation: lease.generation,
      leaseToken: lease.leaseToken,
    });
  }

  async createRun(input: WorkflowRunCreation): Promise<WorkflowRunJournal> {
    this.#assertOpen();
    const journal = await this.#store._withOwnerMutation(this.owner, () =>
      this.#store._createRun(this.#lease, this.#ownerPaths, input),
    );
    this.#runs.set(input.runId, journal);
    return journal;
  }

  async acquireRun(
    runId: DurableWorkflowRunId,
    reason: WorkflowRunEpochAcquisitionReason = this.#staleTakeover
      ? "stale_takeover"
      : "startup",
  ): Promise<WorkflowRunJournal> {
    this.#assertOpen();
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing;
    const journal = await this.#store._withOwnerMutation(this.owner, () =>
      this.#store._acquireRun(this.#lease, this.#ownerPaths, runId, reason),
    );
    this.#runs.set(runId, journal);
    return journal;
  }
  async openTerminalMaintenanceRun(
    runId: DurableWorkflowRunId,
  ): Promise<WorkflowRunJournal> {
    this.#assertOpen();
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._openTerminalMaintenanceRun(
        this.#lease,
        this.#ownerPaths,
        runId,
      ),
    );
  }

  openRun(
    runId: DurableWorkflowRunId,
    reason?: WorkflowRunEpochAcquisitionReason,
  ): Promise<WorkflowRunJournal> {
    return this.acquireRun(runId, reason);
  }

  async listRetentionCandidates(
    options: WorkflowRetentionPolicyOptions = {},
  ): Promise<readonly WorkflowRetentionClassification[]> {
    this.#assertOpen();
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._classifyRetention(this.#lease, this.#ownerPaths, options),
    );
  }

  async pruneRetentionCandidate(
    candidate: WorkflowRetentionCandidate,
  ): Promise<void> {
    this.#assertOpen();
    await this.#store._withOwnerMutation(this.owner, () =>
      this.#store._pruneRetentionCandidate(
        this.#lease,
        this.#ownerPaths,
        candidate,
      ),
    );
  }

  async release(): Promise<void> {
    this.#assertOpen();
    this.#released = true;
    await this.#store._withOwnerMutation(this.owner, async () => {
      try {
        await this.#store._releaseLease(this.#lease, this.#ownerPaths);
      } catch (error) {
        try {
          await this.#store._assertNamespaceFence(
            this.#lease,
            this.#ownerPaths,
          );
        } catch {
          throw error;
        }
        this.#released = false;
        throw error;
      }
    });
  }

  #assertOpen(): void {
    if (this.#released) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "Workflow namespace lease has been released.",
      );
    }
  }
}

export class WorkflowRunJournal {
  readonly owner: DurableWorkflowOwner;
  readonly runId: DurableWorkflowRunId;
  readonly fence?: WorkflowRunEpochFence;
  readonly mode: WorkflowRunJournalMode;

  readonly #store: WorkflowRunStore;
  readonly #paths: RunPaths;
  readonly #launchRecord: WorkflowRunLaunchRecord;
  #appendTail: Promise<void> = Promise.resolve();
  #lease?: PersistedWorkflowNamespaceLease;

  constructor(
    store: WorkflowRunStore,
    owner: DurableWorkflowOwner,
    runId: DurableWorkflowRunId,
    paths: RunPaths,
    launch: WorkflowRunLaunchRecord,
    fence: WorkflowRunEpochFence | undefined,
    mode: WorkflowRunJournalMode = "execution",
  ) {
    this.#store = store;
    this.owner = owner;
    this.runId = runId;
    this.#paths = paths;
    this.#launchRecord = launch;
    this.fence = fence;
    this.mode = mode;
    if (fence !== undefined) {
      this.#lease = {
        schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
        durableOwner: fence.durableOwner,
        scopeId: fence.scopeId,
        generation: fence.generation,
        leaseToken: fence.leaseToken,
        pid: store.processIdentity.pid,
        processStartIdentity: store.processIdentity.processStartIdentity,
      };
    }
  }

  get runEpoch(): number | undefined {
    return this.fence?.runEpoch;
  }

  readLaunch(): DurableValue {
    return this.#launchRecord.launch;
  }

  async readEventLog(): Promise<WorkflowEventLogRead> {
    const scanned = await this.#store._scanJournal(this.#paths, this.runId);
    return {
      events: scanned.events,
      completeBytes: scanned.completeBytes,
      tornTailBytes: scanned.tornTailBytes,
    };
  }

  async readEvents(): Promise<readonly WorkflowRunEvent[]> {
    return (await this.readEventLog()).events;
  }

  /**
   * Revalidate both the namespace lease token and this run's authoritative
   * epoch without publishing an event or blob.
   */
  revalidateFence(): Promise<void> {
    return this.#store._revalidateJournalFence(this);
  }

  append(event: WorkflowRunEvent): Promise<WorkflowEventReceipt> {
    const appendTail = this.#appendTail;
    const operation = this.#store._withOwnerMutation(this.owner, () =>
      appendTail.then(() => this.#store._append(this, event)),
    );
    this.#appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async repairTornTail(): Promise<number> {
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._repairTornTail(this._leaseRecord(), this.#paths, this.runId),
    );
  }

  writeDefinition(source: string): Promise<WorkflowBlobReference> {
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._writeDefinition(this, source),
    );
  }

  readDefinition(reference: WorkflowBlobReference): Promise<string> {
    return this.#store._readDefinition(this, reference);
  }

  writeOutput(value: unknown): Promise<WorkflowBlobReference> {
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._writeOutput(this, value),
    );
  }

  readOutput(reference: WorkflowBlobReference): Promise<DurableValue> {
    return this.#store._readOutput(this, reference);
  }

  writeState(value: unknown): Promise<void> {
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._writeState(this, value),
    );
  }

  readState(): Promise<DurableValue | undefined> {
    return this.#store._readState(this);
  }

  writeResult(input: WorkflowRunResultWrite): Promise<WorkflowRunResultRecord> {
    return this.#store._withOwnerMutation(this.owner, () =>
      this.#store._writeResult(this, input),
    );
  }

  readResult(): Promise<WorkflowRunResultRecord | undefined> {
    return this.#store._readResult(this);
  }

  _requiredFence(): WorkflowRunEpochFence {
    if (this.fence === undefined) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "A current owner lease and run epoch fence are required.",
      );
    }
    return this.fence;
  }

  _leaseRecord(): PersistedWorkflowNamespaceLease {
    this._requiredFence();
    if (this.#lease === undefined) {
      throw new WorkflowRunStoreError(
        "fence_lost",
        "A current owner namespace lease is required.",
      );
    }
    return this.#lease;
  }

  _paths(): RunPaths {
    return this.#paths;
  }

  _launch(): WorkflowRunLaunchRecord {
    return this.#launchRecord;
  }
}
