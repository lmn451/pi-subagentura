import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { SessionOwnerToken } from "./session-scope";

export const RALPLAN_STATE_SCHEMA_VERSION = 1;
export const MAX_RALPLAN_STATE_BYTES = 1_000_000;
export const MAX_RALPLAN_RECORDS = 128;
const MAX_PATH_CHARS = 4096;

export type RalplanPhase =
  | "planning"
  | "reviewing"
  | "pending_approval"
  | "approved_handoff"
  | "rejected"
  | "capped"
  | "cancelled"
  | "failed"
  | "interrupted";

export type RalplanApprovalStatus =
  "pending" | "approved" | "rejected" | "unavailable";

export interface RalplanArtifactPaths {
  plan?: string;
  drafts: string[];
  architectReviews: string[];
  criticReviews: string[];
}

export interface RalplanRunRecord {
  runId: string;
  workflowId: string;
  workflowName: string;
  cwd: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  phase: RalplanPhase;
  approvalStatus: RalplanApprovalStatus;
  active: boolean;
  artifactPaths: RalplanArtifactPaths;
  planDigest?: string;
  sourceDraftDigest?: string;
  createdAt: number;
  updatedAt: number;
  deactivationReason?: string;
}

interface RalplanStateFile {
  schemaVersion: 1;
  records: RalplanRunRecord[];
}

interface RalplanBinding {
  cwd: string;
  runId: string;
}

const workflowBindings = new Map<string, RalplanBinding>();

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function ralplanStatePath(cwd: string): string {
  return join(canonicalCwd(cwd), ".pi", "ralplan-state.json");
}

function emptyState(): RalplanStateFile {
  return { schemaVersion: RALPLAN_STATE_SCHEMA_VERSION, records: [] };
}

function isOwner(value: unknown): value is SessionOwnerToken {
  if (!value || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return Number.isInteger(owner.id) && Number.isInteger(owner.generation);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= MAX_PATH_CHARS,
    )
  );
}

function isArtifactPaths(value: unknown): value is RalplanArtifactPaths {
  if (!value || typeof value !== "object") return false;
  const paths = value as Record<string, unknown>;
  return (
    (paths.plan === undefined ||
      (typeof paths.plan === "string" &&
        paths.plan.length > 0 &&
        paths.plan.length <= MAX_PATH_CHARS)) &&
    isStringArray(paths.drafts) &&
    isStringArray(paths.architectReviews) &&
    isStringArray(paths.criticReviews)
  );
}

const PHASES = new Set<RalplanPhase>([
  "planning",
  "reviewing",
  "pending_approval",
  "approved_handoff",
  "rejected",
  "capped",
  "cancelled",
  "failed",
  "interrupted",
]);
const APPROVALS = new Set<RalplanApprovalStatus>([
  "pending",
  "approved",
  "rejected",
  "unavailable",
]);

function isRecord(value: unknown): value is RalplanRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === "string" &&
    /^rp_[a-f0-9]{20}$/.test(record.runId) &&
    typeof record.workflowId === "string" &&
    record.workflowId.length > 0 &&
    typeof record.workflowName === "string" &&
    record.workflowName.length > 0 &&
    typeof record.cwd === "string" &&
    record.cwd.length > 0 &&
    isOwner(record.owner) &&
    (record.parentSessionId === undefined ||
      typeof record.parentSessionId === "string") &&
    typeof record.phase === "string" &&
    PHASES.has(record.phase as RalplanPhase) &&
    typeof record.approvalStatus === "string" &&
    APPROVALS.has(record.approvalStatus as RalplanApprovalStatus) &&
    typeof record.active === "boolean" &&
    isArtifactPaths(record.artifactPaths) &&
    (record.planDigest === undefined ||
      typeof record.planDigest === "string") &&
    (record.sourceDraftDigest === undefined ||
      typeof record.sourceDraftDigest === "string") &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    (record.deactivationReason === undefined ||
      typeof record.deactivationReason === "string")
  );
}

function validateState(value: unknown): RalplanStateFile {
  if (!value || typeof value !== "object") {
    throw new Error("RALPLAN state schema is invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== RALPLAN_STATE_SCHEMA_VERSION ||
    !Array.isArray(state.records) ||
    state.records.length > MAX_RALPLAN_RECORDS ||
    !state.records.every(isRecord)
  ) {
    throw new Error("RALPLAN state schema is invalid");
  }
  return state as unknown as RalplanStateFile;
}

function readState(cwd: string): RalplanStateFile {
  const path = ralplanStatePath(cwd);
  if (!existsSync(path)) return emptyState();
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("RALPLAN state path must not be a symbolic link");
  }
  const stats = statSync(path);
  if (!stats.isFile())
    throw new Error("RALPLAN state path is not a regular file");
  if (stats.size > MAX_RALPLAN_STATE_BYTES) {
    throw new Error("RALPLAN state file is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `RALPLAN state JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateState(parsed);
}

function writeState(cwd: string, state: RalplanStateFile): void {
  const boundedRecords = state.records.slice(-MAX_RALPLAN_RECORDS);
  const content = `${JSON.stringify({
    schemaVersion: RALPLAN_STATE_SCHEMA_VERSION,
    records: boundedRecords,
  })}\n`;
  if (Buffer.byteLength(content) > MAX_RALPLAN_STATE_BYTES) {
    throw new Error("RALPLAN state exceeds the bounded file size");
  }
  const path = ralplanStatePath(cwd);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) {
    throw new Error("RALPLAN state directory must not be a symbolic link");
  }
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* a failed cleanup must not hide the original persistence result */
    }
  }
}

function emptyArtifacts(): RalplanArtifactPaths {
  return { drafts: [], architectReviews: [], criticReviews: [] };
}

function cleanPath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS
    ? value
    : undefined;
}

function cleanPaths(value: unknown): RalplanArtifactPaths {
  if (!value || typeof value !== "object") return emptyArtifacts();
  const paths = value as Record<string, unknown>;
  const list = (entry: unknown): string[] =>
    Array.isArray(entry)
      ? entry
          .map(cleanPath)
          .filter((item): item is string => item !== undefined)
          .slice(0, 64)
      : [];
  return {
    ...(cleanPath(paths.plan) ? { plan: cleanPath(paths.plan) } : {}),
    drafts: list(paths.drafts),
    architectReviews: list(paths.architectReviews),
    criticReviews: list(paths.criticReviews),
  };
}

function upsertRecord(cwd: string, record: RalplanRunRecord): RalplanRunRecord {
  const state = readState(cwd);
  const index = state.records.findIndex((item) => item.runId === record.runId);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
  writeState(cwd, state);
  return record;
}

function bindingFor(workflowId: string): RalplanBinding | undefined {
  return workflowBindings.get(workflowId);
}

export function isRalplanWorkflowName(name: string): boolean {
  return name === "ralplan-occ" || name === "ralplan-consensus";
}

export function createRalplanRun(input: {
  cwd: string;
  workflowId: string;
  workflowName: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  now?: number;
}): RalplanRunRecord {
  if (!isRalplanWorkflowName(input.workflowName)) {
    throw new Error(
      "Only canonical RALPLAN workflows may create RALPLAN state",
    );
  }
  const cwd = canonicalCwd(input.cwd);
  const existing = getRalplanRunForWorkflow(cwd, input.workflowId);
  if (existing) return existing;
  const now = input.now ?? Date.now();
  const record: RalplanRunRecord = {
    runId: `rp_${randomBytes(10).toString("hex")}`,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    cwd,
    owner: { ...input.owner },
    parentSessionId: input.parentSessionId,
    phase: "planning",
    approvalStatus: "pending",
    active: true,
    artifactPaths: emptyArtifacts(),
    createdAt: now,
    updatedAt: now,
  };
  workflowBindings.set(input.workflowId, { cwd, runId: record.runId });
  return upsertRecord(cwd, record);
}

export function getRalplanRunById(
  cwd: string,
  runId: string,
): RalplanRunRecord | undefined {
  return readState(cwd).records.find((record) => record.runId === runId);
}

export function getRalplanRunForWorkflow(
  cwd: string,
  workflowId: string,
): RalplanRunRecord | undefined {
  const binding = bindingFor(workflowId);
  const canonical = canonicalCwd(cwd);
  if (binding?.cwd === canonical) {
    return getRalplanRunById(canonical, binding.runId);
  }
  const record = readState(canonical).records.find(
    (item) => item.workflowId === workflowId,
  );
  if (record)
    workflowBindings.set(workflowId, { cwd: canonical, runId: record.runId });
  return record;
}

export function markRalplanReviewing(input: {
  cwd: string;
  workflowId: string;
  now?: number;
}): RalplanRunRecord {
  const record = getRalplanRunForWorkflow(input.cwd, input.workflowId);
  if (!record)
    throw new Error(`RALPLAN workflow ${input.workflowId} is not registered`);
  if (!record.active || record.phase !== "planning") return record;
  return upsertRecord(record.cwd, {
    ...record,
    phase: "reviewing",
    updatedAt: input.now ?? Date.now(),
  });
}

export function completeRalplanRun(input: {
  cwd: string;
  workflowId: string;
  result: unknown;
  now?: number;
}): RalplanRunRecord {
  const record = getRalplanRunForWorkflow(input.cwd, input.workflowId);
  if (!record)
    throw new Error(`RALPLAN workflow ${input.workflowId} is not registered`);
  const result =
    input.result && typeof input.result === "object"
      ? (input.result as Record<string, unknown>)
      : {};
  const now = input.now ?? Date.now();
  const artifactPaths = cleanPaths(result.artifactPaths);
  const consensus = result.consensus === true;
  const pending = result.pending_approval === true;
  const planDigest = cleanPath(result.planDigest);
  let phase: RalplanPhase;
  let approvalStatus: RalplanApprovalStatus;
  let active: boolean;
  let deactivationReason: string | undefined;
  if (consensus && pending && planDigest && artifactPaths.plan) {
    phase = "pending_approval";
    approvalStatus = "pending";
    active = true;
  } else if (result.capped === true) {
    phase = "capped";
    approvalStatus = "unavailable";
    active = false;
    deactivationReason = "planning round cap reached";
  } else if (result.status === "no_consensus") {
    phase = "rejected";
    approvalStatus = "unavailable";
    active = false;
    deactivationReason = "planning consensus not reached";
  } else {
    phase = "failed";
    approvalStatus = "unavailable";
    active = false;
    deactivationReason = `planning ended with status ${String(result.status ?? "unknown")}`;
  }
  return upsertRecord(record.cwd, {
    ...record,
    phase,
    approvalStatus,
    active,
    artifactPaths,
    planDigest,
    sourceDraftDigest: cleanPath(result.sourceDraftDigest),
    updatedAt: now,
    ...(deactivationReason ? { deactivationReason } : {}),
  });
}

export function failRalplanRun(input: {
  cwd?: string;
  workflowId: string;
  reason: string;
  phase?: "failed" | "cancelled";
  now?: number;
}): RalplanRunRecord {
  const binding = input.cwd
    ? {
        cwd: canonicalCwd(input.cwd),
        runId: getRalplanRunForWorkflow(input.cwd, input.workflowId)?.runId,
      }
    : bindingFor(input.workflowId);
  if (!binding?.runId)
    throw new Error(`RALPLAN workflow ${input.workflowId} is not registered`);
  const record = getRalplanRunById(binding.cwd, binding.runId);
  if (!record)
    throw new Error(`RALPLAN run for workflow ${input.workflowId} is missing`);
  return upsertRecord(record.cwd, {
    ...record,
    phase: input.phase ?? "failed",
    approvalStatus: "unavailable",
    active: false,
    updatedAt: input.now ?? Date.now(),
    deactivationReason: input.reason,
  });
}

function exactOwner(
  record: RalplanRunRecord,
  owner: SessionOwnerToken,
): boolean {
  return (
    record.owner.id === owner.id && record.owner.generation === owner.generation
  );
}

function requirePendingOwned(input: {
  cwd: string;
  runId: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
}): RalplanRunRecord {
  const record = getRalplanRunById(input.cwd, input.runId);
  if (!record) throw new Error("RALPLAN run not found");
  if (!exactOwner(record, input.owner))
    throw new Error("RALPLAN owner mismatch");
  if (record.parentSessionId !== input.parentSessionId) {
    throw new Error("RALPLAN parent session mismatch");
  }
  if (
    !record.active ||
    record.phase !== "pending_approval" ||
    record.approvalStatus !== "pending"
  ) {
    throw new Error("RALPLAN run is not pending approval");
  }
  return record;
}

export function approveRalplanRun(input: {
  cwd: string;
  runId: string;
  planDigest: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  now?: number;
}): RalplanRunRecord {
  const record = requirePendingOwned(input);
  if (record.planDigest !== input.planDigest) {
    throw new Error("RALPLAN plan digest mismatch");
  }
  return upsertRecord(record.cwd, {
    ...record,
    phase: "approved_handoff",
    approvalStatus: "approved",
    active: false,
    updatedAt: input.now ?? Date.now(),
    deactivationReason: "explicit host approval recorded",
  });
}

export function rejectRalplanRun(input: {
  cwd: string;
  runId: string;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  reason: string;
  now?: number;
}): RalplanRunRecord {
  const record = requirePendingOwned(input);
  return upsertRecord(record.cwd, {
    ...record,
    phase: "rejected",
    approvalStatus: "rejected",
    active: false,
    updatedAt: input.now ?? Date.now(),
    deactivationReason: input.reason,
  });
}

export function interruptRalplanRuns(input: {
  cwd: string;
  owner: SessionOwnerToken;
  lifecycleReason: string;
  now?: number;
}): RalplanRunRecord[] {
  const state = readState(input.cwd);
  const now = input.now ?? Date.now();
  const fresh =
    input.lifecycleReason === "new" || input.lifecycleReason === "fork";
  const changed: RalplanRunRecord[] = [];
  state.records = state.records.map((record) => {
    if (!record.active || !exactOwner(record, input.owner)) return record;
    const updated: RalplanRunRecord = {
      ...record,
      phase: fresh ? "cancelled" : "interrupted",
      approvalStatus: "unavailable",
      active: false,
      updatedAt: now,
      deactivationReason: `session ${input.lifecycleReason}`,
    };
    changed.push(updated);
    return updated;
  });
  if (changed.length > 0) writeState(input.cwd, state);
  return changed;
}

export function listRalplanRuns(
  cwd: string,
  access: { owner?: SessionOwnerToken; parentSessionId?: string },
): RalplanRunRecord[] {
  const records = readState(cwd).records;
  if (!access.owner && !access.parentSessionId) return records;
  return records.filter(
    (record) =>
      (access.owner !== undefined && exactOwner(record, access.owner)) ||
      (record.phase === "interrupted" &&
        access.parentSessionId !== undefined &&
        record.parentSessionId === access.parentSessionId),
  );
}

export function prepareRalplanRecovery(input: {
  cwd: string;
  runId: string;
  parentSessionId?: string;
}): {
  runId: string;
  readOnly: true;
  automaticResume: false;
  phase: RalplanPhase;
  planPath?: string;
  planDigest?: string;
  sourceDraftDigest?: string;
} {
  const record = getRalplanRunById(input.cwd, input.runId);
  if (!record || record.parentSessionId !== input.parentSessionId) {
    throw new Error(
      "RALPLAN recovery evidence not found for this parent session",
    );
  }
  if (record.phase !== "interrupted") {
    throw new Error("RALPLAN recovery is available only for interrupted runs");
  }
  return {
    runId: record.runId,
    readOnly: true,
    automaticResume: false,
    phase: record.phase,
    planPath: record.artifactPaths.plan,
    planDigest: record.planDigest,
    sourceDraftDigest: record.sourceDraftDigest,
  };
}

export function clearRalplanBindingsForTests(): void {
  workflowBindings.clear();
}
