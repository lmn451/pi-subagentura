import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { RalplanRunRecord } from "./ralplan-state";
import type { SessionOwnerToken } from "./session-scope";

export const EXECUTION_SCHEMA_VERSION = 1;
export const MAX_EXECUTION_RECORD_BYTES = 1_000_000;
export const MAX_EXECUTION_TASKS = 32;
export const MAX_EXECUTION_RECORDS = 128;
export const MAX_EXECUTION_PROMPT_CHARS = 20_000;
export const MAX_EXECUTION_TOTAL_PROMPT_CHARS = 100_000;

export type ExecutionStatus =
  | "pending_execution_approval"
  | "approved"
  | "running"
  | "interrupted"
  | "completed"
  | "cancelled"
  | "failed";

export type ExecutionTaskStatus =
  "pending" | "running" | "committed" | "unknown" | "skipped" | "failed";

export interface DeclarativeExecutionTask {
  id: string;
  phase: string;
  title: string;
  prompt: string;
  dependsOn: string[];
}

export interface ExecutionTaskState {
  taskId: string;
  status: ExecutionTaskStatus;
  attempt: number;
  operationId?: string;
  summary?: string;
  outputDigest?: string;
  evidence?: string;
  error?: string;
}

export interface ExecutionLease {
  owner: SessionOwnerToken;
  epoch: number;
}

export interface DurableExecutionRecord {
  schemaVersion: 1;
  executionId: string;
  ralplanRunId: string;
  planPath: string;
  planDigest: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  status: ExecutionStatus;
  executionApproved: boolean;
  active: boolean;
  exactlyOnce: false;
  revision: number;
  executionEpoch: number;
  tasks: DeclarativeExecutionTask[];
  taskStates: ExecutionTaskState[];
  lease?: ExecutionLease;
  createdAt: number;
  updatedAt: number;
  terminalReason?: string;
}

export interface ExecutionOperation {
  executionId: string;
  operationId: string;
  task: DeclarativeExecutionTask;
  attempt: number;
  leaseEpoch: number;
  revision: number;
}

const executionBindings = new Map<string, string>();

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function executionDirectory(cwd: string): string {
  return join(canonicalCwd(cwd), ".pi", "ralplan-executions");
}

function assertExecutionDirectoryIdentity(
  cwd: string,
  directory: string,
): void {
  const project = canonicalCwd(cwd);
  const piDirectory = join(project, ".pi");
  const expected = join(piDirectory, "ralplan-executions");
  if (
    resolve(directory) !== expected ||
    realpathSync(piDirectory) !== piDirectory ||
    realpathSync(directory) !== expected
  ) {
    throw new Error(
      "Durable execution directory escaped the canonical project",
    );
  }
}

function staleLockCanBeRemoved(lockPath: string): boolean {
  const stats = lstatSync(lockPath);
  if (stats.isSymbolicLink() || !stats.isFile()) return false;
  const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

function ensureExecutionDirectory(
  cwd: string,
  create: boolean,
): string | undefined {
  const project = canonicalCwd(cwd);
  const piDirectory = join(project, ".pi");
  if (!existsSync(piDirectory)) {
    if (!create) return undefined;
    mkdirSync(piDirectory, { recursive: false, mode: 0o700 });
  }
  const piStats = lstatSync(piDirectory);
  if (piStats.isSymbolicLink() || !piStats.isDirectory()) {
    throw new Error("Durable execution .pi path must be a real directory");
  }
  const directory = join(piDirectory, "ralplan-executions");
  if (!existsSync(directory)) {
    if (!create) return undefined;
    mkdirSync(directory, { recursive: false, mode: 0o700 });
  }
  const executionStats = lstatSync(directory);
  if (executionStats.isSymbolicLink() || !executionStats.isDirectory()) {
    throw new Error("Durable execution directory must be a real directory");
  }
  assertExecutionDirectoryIdentity(cwd, directory);
  return directory;
}

function withExecutionLock<T>(
  cwd: string,
  executionId: string,
  action: () => T,
): T {
  const directory = ensureExecutionDirectory(cwd, true)!;
  assertExecutionDirectoryIdentity(cwd, directory);
  const lockPath = `${runStorePath(cwd, executionId)}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST" &&
      staleLockCanBeRemoved(lockPath)
    ) {
      unlinkSync(lockPath);
      descriptor = openSync(lockPath, "wx", 0o600);
    } else {
      throw new Error("Durable execution record is locked by another writer");
    }
  }
  writeFileSync(descriptor, `${process.pid}\n`, { encoding: "utf8" });
  assertExecutionDirectoryIdentity(cwd, directory);
  try {
    return action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock cleanup is best effort after the descriptor is closed */
    }
  }
}

function validateExecutionId(executionId: string): void {
  if (!/^rx_[a-f0-9]{20}$/.test(executionId)) {
    throw new Error("Invalid durable execution id");
  }
}

export function runStorePath(cwd: string, executionId: string): string {
  validateExecutionId(executionId);
  return join(executionDirectory(cwd), `${executionId}.json`);
}

function exactOwner(a: SessionOwnerToken, b: SessionOwnerToken): boolean {
  return a.id === b.id && a.generation === b.generation;
}

function validateText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validateTasks(tasks: unknown): DeclarativeExecutionTask[] {
  if (
    !Array.isArray(tasks) ||
    tasks.length === 0 ||
    tasks.length > MAX_EXECUTION_TASKS
  ) {
    throw new Error(
      `Execution preview requires 1-${MAX_EXECUTION_TASKS} tasks`,
    );
  }
  const seen = new Set<string>();
  let totalPromptChars = 0;
  const validated: DeclarativeExecutionTask[] = [];
  for (const raw of tasks) {
    if (!raw || typeof raw !== "object")
      throw new Error("Execution task is invalid");
    const task = raw as Record<string, unknown>;
    if (
      typeof task.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(task.id)
    ) {
      throw new Error("Execution task id is unsafe");
    }
    if (seen.has(task.id))
      throw new Error(`Duplicate execution task id ${task.id}`);
    if (!validateText(task.phase, 128) || !validateText(task.title, 256)) {
      throw new Error(`Execution task ${task.id} phase or title is invalid`);
    }
    if (!validateText(task.prompt, MAX_EXECUTION_PROMPT_CHARS)) {
      throw new Error(
        `Execution task ${task.id} prompt is invalid or too large`,
      );
    }
    if (
      !Array.isArray(task.dependsOn) ||
      task.dependsOn.length > MAX_EXECUTION_TASKS ||
      !task.dependsOn.every(
        (dependency) => typeof dependency === "string" && seen.has(dependency),
      )
    ) {
      throw new Error(
        `Execution task ${task.id} dependencies must reference earlier tasks`,
      );
    }
    totalPromptChars += task.prompt.length;
    if (totalPromptChars > MAX_EXECUTION_TOTAL_PROMPT_CHARS) {
      throw new Error("Execution task prompts exceed the total bounded size");
    }
    seen.add(task.id);
    validated.push({
      id: task.id,
      phase: task.phase,
      title: task.title,
      prompt: task.prompt,
      dependsOn: [...task.dependsOn],
    });
  }
  return validated;
}

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending_execution_approval",
  "approved",
  "running",
  "interrupted",
  "completed",
  "cancelled",
  "failed",
]);
const TASK_STATUSES = new Set<ExecutionTaskStatus>([
  "pending",
  "running",
  "committed",
  "unknown",
  "skipped",
  "failed",
]);

function validateRecord(value: unknown): DurableExecutionRecord {
  if (!value || typeof value !== "object") {
    throw new Error("Durable execution state schema is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== EXECUTION_SCHEMA_VERSION ||
    typeof record.executionId !== "string" ||
    !/^rx_[a-f0-9]{20}$/.test(record.executionId) ||
    typeof record.ralplanRunId !== "string" ||
    !validateText(record.planPath, 4096) ||
    !validateText(record.planDigest, 4096) ||
    !record.owner ||
    typeof record.owner !== "object" ||
    !Number.isInteger((record.owner as Record<string, unknown>).id) ||
    !Number.isInteger((record.owner as Record<string, unknown>).generation) ||
    (record.parentSessionId !== undefined &&
      typeof record.parentSessionId !== "string") ||
    typeof record.status !== "string" ||
    !EXECUTION_STATUSES.has(record.status as ExecutionStatus) ||
    typeof record.executionApproved !== "boolean" ||
    typeof record.active !== "boolean" ||
    record.exactlyOnce !== false ||
    !Number.isInteger(record.revision) ||
    !Number.isInteger(record.executionEpoch) ||
    !Array.isArray(record.tasks) ||
    !Array.isArray(record.taskStates) ||
    record.tasks.length !== record.taskStates.length ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    throw new Error("Durable execution state schema is invalid");
  }
  const tasks = validateTasks(record.tasks);
  const states = record.taskStates as Array<Record<string, unknown>>;
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    if (
      !state ||
      state.taskId !== tasks[index].id ||
      typeof state.status !== "string" ||
      !TASK_STATUSES.has(state.status as ExecutionTaskStatus) ||
      !Number.isInteger(state.attempt)
    ) {
      throw new Error("Durable execution task-state schema is invalid");
    }
  }
  if (record.lease !== undefined) {
    const lease = record.lease as Record<string, unknown>;
    if (
      !lease.owner ||
      typeof lease.owner !== "object" ||
      !Number.isInteger((lease.owner as Record<string, unknown>).id) ||
      !Number.isInteger((lease.owner as Record<string, unknown>).generation) ||
      !Number.isInteger(lease.epoch)
    ) {
      throw new Error("Durable execution lease schema is invalid");
    }
  }
  return { ...(record as unknown as DurableExecutionRecord), tasks };
}

function readRecord(cwd: string, executionId: string): DurableExecutionRecord {
  if (!ensureExecutionDirectory(cwd, false)) {
    throw new Error("Durable execution record not found");
  }
  const path = runStorePath(cwd, executionId);
  if (!existsSync(path)) throw new Error("Durable execution record not found");
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Durable execution record must not be a symbolic link");
  }
  const stats = statSync(path);
  if (!stats.isFile())
    throw new Error("Durable execution record is not a regular file");
  if (stats.size > MAX_EXECUTION_RECORD_BYTES) {
    throw new Error("Durable execution record is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Durable execution JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertExecutionDirectoryIdentity(cwd, executionDirectory(cwd));
  return validateRecord(parsed);
}

function writeRecord(
  cwd: string,
  record: DurableExecutionRecord,
): DurableExecutionRecord {
  validateRecord(record);
  const directory = ensureExecutionDirectory(cwd, true)!;
  assertExecutionDirectoryIdentity(cwd, directory);
  const path = runStorePath(cwd, record.executionId);
  const content = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(content) > MAX_EXECUTION_RECORD_BYTES) {
    throw new Error("Durable execution record exceeds bounded size");
  }
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    assertExecutionDirectoryIdentity(cwd, directory);
    chmodSync(temp, 0o600);
    assertExecutionDirectoryIdentity(cwd, directory);
    renameSync(temp, path);
    chmodSync(path, 0o600);
    assertExecutionDirectoryIdentity(cwd, directory);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* preserve the original persistence outcome */
    }
  }
  executionBindings.set(record.executionId, canonicalCwd(cwd));
  return record;
}

function mutateRecord(
  cwd: string,
  executionId: string,
  expectedRevision: number,
  mutate: (record: DurableExecutionRecord) => DurableExecutionRecord,
): DurableExecutionRecord {
  return withExecutionLock(cwd, executionId, () => {
    const record = readRecord(cwd, executionId);
    if (record.revision !== expectedRevision) {
      throw new Error(
        `Durable execution revision mismatch: expected ${expectedRevision}, current ${record.revision}`,
      );
    }
    return writeRecord(cwd, mutate(record));
  });
}

function requireOwnerSession(
  record: DurableExecutionRecord,
  owner: SessionOwnerToken,
  parentSessionId?: string,
): void {
  if (!exactOwner(record.owner, owner))
    throw new Error("Execution owner mismatch");
  if (record.parentSessionId !== parentSessionId) {
    throw new Error("Execution parent session mismatch");
  }
}

function requireLease(
  record: DurableExecutionRecord,
  owner: SessionOwnerToken,
  leaseEpoch: number,
): void {
  if (record.status !== "running" || !record.lease) {
    throw new Error("Execution is not running with an active lease");
  }
  if (
    !exactOwner(record.lease.owner, owner) ||
    record.lease.epoch !== leaseEpoch
  ) {
    throw new Error("Execution lease owner or epoch mismatch");
  }
}

export function createExecutionPreview(input: {
  cwd: string;
  ralplan: RalplanRunRecord;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  planDigest: string;
  tasks: unknown;
  now?: number;
}): DurableExecutionRecord {
  const cwd = canonicalCwd(input.cwd);
  if (
    input.ralplan.phase !== "approved_handoff" ||
    input.ralplan.approvalStatus !== "approved" ||
    input.ralplan.active ||
    !input.ralplan.artifactPaths.plan
  ) {
    throw new Error("RALPLAN run is not an approved inactive handoff");
  }
  if (canonicalCwd(input.ralplan.cwd) !== cwd) {
    throw new Error("RALPLAN cwd mismatch");
  }
  if (!exactOwner(input.ralplan.owner, input.owner)) {
    throw new Error("RALPLAN owner mismatch");
  }
  if (input.ralplan.parentSessionId !== input.parentSessionId) {
    throw new Error("RALPLAN parent session mismatch");
  }
  if (input.ralplan.planDigest !== input.planDigest) {
    throw new Error("RALPLAN plan digest mismatch");
  }
  if (listExecutionRecords(cwd, {}).length >= MAX_EXECUTION_RECORDS) {
    throw new Error(
      `At most ${MAX_EXECUTION_RECORDS} durable executions are retained`,
    );
  }
  const tasks = validateTasks(input.tasks);
  const now = input.now ?? Date.now();
  const record: DurableExecutionRecord = {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    executionId: `rx_${randomBytes(10).toString("hex")}`,
    ralplanRunId: input.ralplan.runId,
    planPath: input.ralplan.artifactPaths.plan,
    planDigest: input.planDigest,
    owner: { ...input.owner },
    parentSessionId: input.parentSessionId,
    status: "pending_execution_approval",
    executionApproved: false,
    active: true,
    exactlyOnce: false,
    revision: 1,
    executionEpoch: 0,
    tasks,
    taskStates: tasks.map((task) => ({
      taskId: task.id,
      status: "pending",
      attempt: 0,
    })),
    createdAt: now,
    updatedAt: now,
  };
  return writeRecord(cwd, record);
}

export function getExecutionRecord(
  cwd: string,
  executionId: string,
): DurableExecutionRecord | undefined {
  try {
    return readRecord(cwd, executionId);
  } catch (error) {
    if (error instanceof Error && /not found/.test(error.message))
      return undefined;
    throw error;
  }
}

export function listExecutionRecords(
  cwd: string,
  access: { owner?: SessionOwnerToken; parentSessionId?: string },
): DurableExecutionRecord[] {
  const directory = ensureExecutionDirectory(cwd, false);
  if (!directory) return [];
  const records = readdirSync(directory)
    .filter((name) => /^rx_[a-f0-9]{20}\.json$/.test(name))
    .slice(0, 256)
    .map((name) => readRecord(cwd, name.slice(0, -5)));
  if (!access.owner && !access.parentSessionId) return records;
  return records.filter(
    (record) =>
      (access.owner !== undefined && exactOwner(record.owner, access.owner)) ||
      (access.parentSessionId !== undefined &&
        record.parentSessionId === access.parentSessionId),
  );
}

export function approveExecutionPreview(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  planDigest: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  now?: number;
}): DurableExecutionRecord {
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      requireOwnerSession(record, input.owner, input.parentSessionId);
      if (record.status !== "pending_execution_approval" || !record.active) {
        throw new Error("Execution preview is not pending approval");
      }
      if (record.planDigest !== input.planDigest) {
        throw new Error("Execution plan digest mismatch");
      }
      return {
        ...record,
        status: "approved",
        executionApproved: true,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
      };
    },
  );
}

export function startExecutionRecord(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  now?: number;
}): DurableExecutionRecord {
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      requireOwnerSession(record, input.owner, input.parentSessionId);
      if (
        record.status !== "approved" ||
        !record.executionApproved ||
        !record.active
      ) {
        throw new Error("Execution is not approved to start");
      }
      const epoch = record.executionEpoch + 1;
      return {
        ...record,
        status: "running",
        executionEpoch: epoch,
        lease: { owner: { ...input.owner }, epoch },
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
      };
    },
  );
}

export function beginNextExecutionOperation(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  leaseEpoch: number;
  owner: SessionOwnerToken;
  now?: number;
}): ExecutionOperation | null {
  let operation: ExecutionOperation | null = null;
  mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      requireLease(record, input.owner, input.leaseEpoch);
      const committed = new Set(
        record.taskStates
          .filter(
            (state) =>
              state.status === "committed" || state.status === "skipped",
          )
          .map((state) => state.taskId),
      );
      const index = record.taskStates.findIndex(
        (state, taskIndex) =>
          state.status === "pending" &&
          record.tasks[taskIndex].dependsOn.every((dependency) =>
            committed.has(dependency),
          ),
      );
      if (index < 0) return record;
      const task = record.tasks[index];
      const attempt = record.taskStates[index].attempt + 1;
      const operationId = `op_${record.executionId.slice(3)}_${task.id}_${attempt}`;
      const taskStates = record.taskStates.map((state, stateIndex) =>
        stateIndex === index
          ? { ...state, status: "running" as const, attempt, operationId }
          : state,
      );
      const revision = record.revision + 1;
      operation = {
        executionId: record.executionId,
        operationId,
        task,
        attempt,
        leaseEpoch: input.leaseEpoch,
        revision,
      };
      return {
        ...record,
        taskStates,
        revision,
        updatedAt: input.now ?? Date.now(),
      };
    },
  );
  return operation;
}

export function commitExecutionOperation(input: {
  cwd: string;
  executionId: string;
  operationId: string;
  leaseEpoch: number;
  owner: SessionOwnerToken;
  summary: string;
  outputDigest: string;
  now?: number;
}): DurableExecutionRecord {
  if (
    !validateText(input.summary, 4096) ||
    !validateText(input.outputDigest, 4096)
  ) {
    throw new Error("Execution outcome summary or digest is invalid");
  }
  const current = readRecord(input.cwd, input.executionId);
  return mutateRecord(
    input.cwd,
    input.executionId,
    current.revision,
    (record) => {
      requireLease(record, input.owner, input.leaseEpoch);
      const index = record.taskStates.findIndex(
        (state) =>
          state.status === "running" && state.operationId === input.operationId,
      );
      if (index < 0) throw new Error("Execution operation is not active");
      const taskStates = record.taskStates.map((state, stateIndex) =>
        stateIndex === index
          ? {
              ...state,
              status: "committed" as const,
              summary: input.summary,
              outputDigest: input.outputDigest,
            }
          : state,
      );
      return {
        ...record,
        taskStates,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
      };
    },
  );
}

export function failExecutionOperation(input: {
  cwd: string;
  executionId: string;
  operationId: string;
  leaseEpoch: number;
  owner: SessionOwnerToken;
  error: string;
  now?: number;
}): DurableExecutionRecord {
  const current = readRecord(input.cwd, input.executionId);
  return mutateRecord(
    input.cwd,
    input.executionId,
    current.revision,
    (record) => {
      requireLease(record, input.owner, input.leaseEpoch);
      const index = record.taskStates.findIndex(
        (state) =>
          state.status === "running" && state.operationId === input.operationId,
      );
      if (index < 0) throw new Error("Execution operation is not active");
      const taskStates = record.taskStates.map((state, stateIndex) =>
        stateIndex === index
          ? {
              ...state,
              status: "failed" as const,
              error: input.error.slice(0, 4096),
            }
          : state,
      );
      return {
        ...record,
        status: "failed",
        active: false,
        lease: undefined,
        taskStates,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
        terminalReason: `task operation ${input.operationId} failed`,
      };
    },
  );
}

export function completeExecutionRecord(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  leaseEpoch: number;
  owner: SessionOwnerToken;
  now?: number;
}): DurableExecutionRecord {
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      requireLease(record, input.owner, input.leaseEpoch);
      if (
        !record.taskStates.every(
          (state) => state.status === "committed" || state.status === "skipped",
        )
      ) {
        throw new Error("Execution tasks are not all committed");
      }
      return {
        ...record,
        status: "completed",
        active: false,
        lease: undefined,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
        terminalReason: "all declarative tasks committed",
      };
    },
  );
}

export function cancelExecutionRecord(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  reason: string;
  now?: number;
}): DurableExecutionRecord {
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      requireOwnerSession(record, input.owner, input.parentSessionId);
      if (!record.active) throw new Error("Execution is already terminal");
      const taskStates = record.taskStates.map((state) =>
        state.status === "running"
          ? {
              ...state,
              status: "unknown" as const,
              evidence: "cancelled in flight",
            }
          : state,
      );
      return {
        ...record,
        status: "cancelled",
        active: false,
        lease: undefined,
        taskStates,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
        terminalReason: input.reason.slice(0, 4096),
      };
    },
  );
}

export function interruptExecutionsForOwner(input: {
  cwd: string;
  owner: SessionOwnerToken;
  lifecycleReason: string;
  now?: number;
}): DurableExecutionRecord[] {
  const records = listExecutionRecords(input.cwd, {});
  const changed: DurableExecutionRecord[] = [];
  for (const initial of records) {
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current.active || !exactOwner(current.owner, input.owner)) break;
      try {
        const updated = mutateRecord(
          input.cwd,
          current.executionId,
          current.revision,
          (record) => {
            if (!record.active || !exactOwner(record.owner, input.owner)) {
              return record;
            }
            const taskStates = record.taskStates.map((state) =>
              state.status === "running"
                ? {
                    ...state,
                    status: "unknown" as const,
                    evidence: `interrupted by session ${input.lifecycleReason}`,
                  }
                : state,
            );
            return {
              ...record,
              status: "interrupted",
              active: false,
              lease: undefined,
              taskStates,
              revision: record.revision + 1,
              updatedAt: input.now ?? Date.now(),
              terminalReason: `session ${input.lifecycleReason}`,
            };
          },
        );
        if (updated.status === "interrupted") changed.push(updated);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/revision mismatch/.test(error.message)
        ) {
          throw error;
        }
        current = readRecord(input.cwd, current.executionId);
      }
    }
  }
  return changed;
}

export function recoverColdExecutionRecords(input: {
  cwd: string;
  parentSessionId?: string;
  now?: number;
}): DurableExecutionRecord[] {
  const records = listExecutionRecords(input.cwd, {});
  const recovered: DurableExecutionRecord[] = [];
  for (const initial of records) {
    if (!initial.active || initial.parentSessionId !== input.parentSessionId)
      continue;
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updated = mutateRecord(
          input.cwd,
          current.executionId,
          current.revision,
          (record) => {
            if (
              !record.active ||
              record.parentSessionId !== input.parentSessionId
            ) {
              return record;
            }
            const taskStates = record.taskStates.map((state) =>
              state.status === "running"
                ? {
                    ...state,
                    status: "unknown" as const,
                    evidence: "recovered from a cold process boundary",
                  }
                : state,
            );
            return {
              ...record,
              status: "interrupted",
              active: false,
              lease: undefined,
              taskStates,
              revision: record.revision + 1,
              updatedAt: input.now ?? Date.now(),
              terminalReason: "cold startup recovery",
            };
          },
        );
        if (updated.status === "interrupted") recovered.push(updated);
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/revision mismatch/.test(error.message)
        ) {
          throw error;
        }
        current = readRecord(input.cwd, current.executionId);
      }
    }
  }
  return recovered;
}

export function resolveUnknownExecutionOperation(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  operationId: string;
  parentSessionId?: string;
  owner: SessionOwnerToken;
  resolution: "retry" | "accept" | "fail";
  evidence: string;
  outputDigest?: string;
  now?: number;
}): DurableExecutionRecord {
  if (!validateText(input.evidence, 4096)) {
    throw new Error("Manual resolution evidence is required");
  }
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      if (record.parentSessionId !== input.parentSessionId) {
        throw new Error("Execution parent session mismatch");
      }
      if (record.owner.id !== input.owner.id) {
        throw new Error("Execution owner identity mismatch");
      }
      if (record.status !== "interrupted") {
        throw new Error(
          "Only interrupted executions can resolve unknown operations",
        );
      }
      const index = record.taskStates.findIndex(
        (state) =>
          state.status === "unknown" && state.operationId === input.operationId,
      );
      if (index < 0) throw new Error("Unknown execution operation not found");
      const taskStates = record.taskStates.map((state, stateIndex) => {
        if (stateIndex !== index) return state;
        if (input.resolution === "retry") {
          return {
            taskId: state.taskId,
            status: "pending" as const,
            attempt: state.attempt,
            evidence: input.evidence,
          };
        }
        if (input.resolution === "accept") {
          if (!validateText(input.outputDigest, 4096)) {
            throw new Error("Accept resolution requires an output digest");
          }
          return {
            ...state,
            status: "committed" as const,
            summary: "manually accepted after interruption",
            outputDigest: input.outputDigest,
            evidence: input.evidence,
          };
        }
        return {
          ...state,
          status: "failed" as const,
          error: input.evidence,
          evidence: input.evidence,
        };
      });
      const failed = input.resolution === "fail";
      return {
        ...record,
        owner: { ...input.owner },
        status: failed ? "failed" : "interrupted",
        active: false,
        taskStates,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
        ...(failed
          ? { terminalReason: "unknown operation resolved as failed" }
          : {}),
      };
    },
  );
}

export function resumeExecutionRecord(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  now?: number;
}): DurableExecutionRecord {
  return mutateRecord(
    input.cwd,
    input.executionId,
    input.expectedRevision,
    (record) => {
      if (record.parentSessionId !== input.parentSessionId) {
        throw new Error("Execution parent session mismatch");
      }
      if (record.owner.id !== input.owner.id) {
        throw new Error("Execution owner identity mismatch");
      }
      if (record.status !== "interrupted") {
        throw new Error("Only interrupted execution can be resumed");
      }
      if (record.taskStates.some((state) => state.status === "unknown")) {
        throw new Error(
          "Unknown operations require explicit resolution before resume",
        );
      }
      return {
        ...record,
        owner: { ...input.owner },
        status: record.executionApproved
          ? "approved"
          : "pending_execution_approval",
        active: true,
        lease: undefined,
        revision: record.revision + 1,
        updatedAt: input.now ?? Date.now(),
        terminalReason: undefined,
      };
    },
  );
}

export function clearExecutionBindingsForTests(): void {
  executionBindings.clear();
}
