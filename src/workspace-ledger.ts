import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

export const WORKSPACE_LEDGER_SCHEMA_VERSION = 1;
export const WORKSPACE_LEDGER_FILE = "subagentura-workspace.json";
export const WORKSPACE_LOCK_FILE = "subagentura-workspace.lock";
export const WORKSPACE_RECOVERY_LOCK_FILE =
  "subagentura-workspace.lock.recovery";

export const MAX_WORKSPACE_LEDGER_BYTES = 8 * 1024 * 1024;
export const MAX_WORKSPACE_SLOTS = 128;
export const MAX_WORKSPACE_WORK_ITEMS = 512;
export const MAX_WORKSPACE_ASSIGNMENTS = 2_048;
export const MAX_WORKSPACE_INTENTS = 256;
export const MAX_WORKSPACE_OUTCOMES = 512;
export const MAX_WORKSPACE_PUBLICATIONS = 512;
export const MAX_WORKSPACE_PR_ASSOCIATIONS = 256;
export const MAX_WORKSPACE_PR_OBSERVATIONS = 512;
export const MAX_WORKSPACE_PROPOSAL_RECEIPTS = 512;
export const MAX_WORKSPACE_PROPOSAL_CURSORS = 512;
export const MAX_WORKSPACE_CLAIMS = MAX_WORKSPACE_ASSIGNMENTS;
export const MAX_WORKSPACE_BRANCHES = MAX_WORKSPACE_WORK_ITEMS;
export const MAX_WORKSPACE_OPERATION_INTENTS = MAX_WORKSPACE_INTENTS;
export const MAX_WORKSPACE_OPERATION_OUTCOMES = MAX_WORKSPACE_OUTCOMES;
export const MAX_WORKSPACE_PUBLICATION_REFS = 128;

export const MAX_WORKSPACE_ID_BYTES = 256;
export const MAX_WORKSPACE_PATH_BYTES = 4_096;
export const MAX_WORKSPACE_REF_BYTES = 1_024;
export const MAX_WORKSPACE_TEXT_BYTES = 4_096;
export const MAX_WORKSPACE_PROVIDER_BYTES = 128;
export const MAX_WORKSPACE_EXTERNAL_ID_BYTES = 512;
export const MAX_WORKSPACE_FILESYSTEM_ID_BYTES = 512;

export const MAX_LEDGER_BYTES = MAX_WORKSPACE_LEDGER_BYTES;
export const MAX_SLOTS = MAX_WORKSPACE_SLOTS;
export const MAX_WORK_ITEMS = MAX_WORKSPACE_WORK_ITEMS;
export const MAX_ASSIGNMENTS = MAX_WORKSPACE_ASSIGNMENTS;
export const MAX_INTENTS = MAX_WORKSPACE_INTENTS;
export const MAX_OUTCOMES = MAX_WORKSPACE_OUTCOMES;

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const FULL_HEAD_REF_PATTERN = /^refs\/heads\/[A-Za-z0-9._/@+-]+$/;
const HEX_PATTERN = /^[a-f0-9]+$/i;
const CHILD_ID_PATTERN = /^(?:[a-f0-9]{8}|[a-f0-9]{16})$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type WorkspaceObjectFormat = "sha1" | "sha256";
export type WorkspaceSlotKind = "main" | "linked";
export type WorkspaceSlotState =
  | "unmanaged"
  | "available"
  | "reserved"
  | "assigned"
  | "transitioning"
  | "blocked"
  | "adoption_required";
export type WorkspaceCheckout = "branch" | "detached" | "unborn" | "unknown";
export type WorkspaceObservationStatus =
  "clean" | "dirty" | "ignored" | "conflicted" | "in_progress" | "unknown";
export type WorkspaceAdminStatus = "normal" | "locked" | "prunable" | "unknown";
export type WorkspaceAssignmentState =
  "reserved" | "bound" | "retired" | "blocked";
export type WorkspaceClaimState = "held" | "released" | "orphaned";
export type WorkspaceOperationAction = "switch_existing" | "create_branch";
export type WorkspaceOperationPhase =
  "prepared" | "committed" | "interrupted" | "blocked";
export type WorkspaceOperationClassification =
  | "after"
  | "before"
  | "mismatch"
  | "unknown"
  | "admin_locked"
  | "parse_error"
  | "timeout"
  | "cancelled";
export type WorkspaceOperationCommand =
  "not_started" | "success" | "error" | "timeout" | "cancelled";
export type WorkspaceOperationErrorCode =
  | "timeout"
  | "cancelled"
  | "parse_error"
  | "output_limit"
  | "ledger_io"
  | "branch_conflict"
  | "unknown";

export interface PublicationRef {
  remote: string;
  ref: string;
}

export interface RepositoryRecord {
  repoId: string;
  commonDir: string;
  gitDir: string;
  objectFormat: WorkspaceObjectFormat;
  publicationRefs: PublicationRef[];
}

export interface WorktreeObservation {
  root: string;
  filesystemIdentity: string;
  branchRef?: string;
  headOid?: string;
  checkout: WorkspaceCheckout;
  status: WorkspaceObservationStatus;
  admin: WorkspaceAdminStatus;
}

export interface SlotRecord {
  slotId: string;
  kind: WorkspaceSlotKind;
  adminKey: string;
  root: string;
  gitDir: string;
  state: WorkspaceSlotState;
  revision: number;
  assignmentEpoch: number;
  activeAssignmentId?: string;
  observation?: WorktreeObservation;
}

export interface DurableOwner {
  processInstanceId: string;
  parentSessionId?: string;
  nonce: string;
  pid?: number;
}

export interface AssignmentRecord {
  assignmentId: string;
  slotId: string;
  workItemId: string;
  branchRef: string;
  epoch: number;
  expectedRoot: string;
  expectedHeadOid?: string;
  owner: DurableOwner;
  childId?: string;
  state: WorkspaceAssignmentState;
}

export interface OperationIntent {
  operationId: string;
  action: WorkspaceOperationAction;
  claimId: string;
  assignmentId: string;
  fromEpoch: number;
  toEpoch: number;
  expectedRevision: number;
  requestedBranchRef: string;
  requestedBaseOid?: string;
  before: WorktreeObservation;
  intendedAfter: WorktreeObservation;
  phase: WorkspaceOperationPhase;
}

export interface OperationOutcome {
  operationId: string;
  classification: WorkspaceOperationClassification;
  command: WorkspaceOperationCommand;
  observed?: WorktreeObservation;
  errorCode?: WorkspaceOperationErrorCode;
}

export interface BranchRecord {
  branchRef: string;
  headOid?: string;
  state: "present" | "missing" | "unknown";
}

export interface WorkItemRecord {
  workItemId: string;
  branchRef: string;
  lifecycle: "active" | "parked" | "archived";
  assignmentIds: string[];
}

export interface ClaimRecord {
  claimId: string;
  scope: "repository" | "slot";
  slotId?: string;
  owner: DurableOwner;
  state: WorkspaceClaimState;
  claimEpoch: number;
  acquiredAt: number;
}

export interface PublicationObservation {
  observationId: string;
  workItemId: string;
  assignmentEpoch: number;
  remote: string;
  ref: string;
  candidateOid: string;
  candidateBranchRef: string;
  observedOid?: string;
  result: "equal" | "different" | "not_advertised" | "unknown";
  freshness: "fresh" | "stale" | "unknown";
  source: "git_remote_probe";
  checkedAt: number;
  errorCode?:
    "auth" | "timeout" | "unavailable" | "malformed" | "remote_changed";
}

export interface PrAssociation {
  associationId: string;
  workItemId: string;
  provider: string;
  externalId: string;
  claimedHeadOid?: string;
  claimedBaseRef?: string;
  provenance: "parent" | "child_proposal";
  recordedAt: number;
}

export interface PrObservation {
  observationId: string;
  associationId: string;
  state: "unknown" | "open" | "closed" | "merged";
  draft?: boolean;
  verification:
    "unsupported" | "unverified" | "verified" | "unavailable" | "mismatch";
  headRepo?: string;
  headRef?: string;
  headOid?: string;
  baseRef?: string;
  freshness: "fresh" | "stale" | "unknown";
  source: "provider" | "manual_parent";
  recordedAt: number;
}

export interface ProposalReceipt {
  receiptId: string;
  proposalId: string;
  payloadHash: string;
  childId: string;
  assignmentEpoch: number;
  turnId: string;
  result: "accepted" | "duplicate" | "stale" | "invalid";
  recordedAt: number;
}

export interface WorkspaceLedgerV1 {
  schemaVersion: 1;
  ledgerRevision: number;
  repository: RepositoryRecord;
  slots: SlotRecord[];
  branches: BranchRecord[];
  workItems: WorkItemRecord[];
  assignments: AssignmentRecord[];
  claims: ClaimRecord[];
  operations: OperationIntent[];
  outcomes: OperationOutcome[];
  publications: PublicationObservation[];
  prAssociations: PrAssociation[];
  prObservations: PrObservation[];
  proposalCursors: Record<string, number>;
  proposalReceipts: ProposalReceipt[];
}

export interface AdoptionRequest {
  repoId: string;
  slotId: string;
  assignmentId: string;
  expectedRevision: number;
  expectedEpoch: number;
  confirmed: boolean;
  confirmationToken?: string;
}

export interface RecoveryRequest {
  operationId: string;
  expectedRevision: number;
  action: "reconcile" | "abandon-before-state";
  confirmed: boolean;
  confirmationToken?: string;
}

export interface RecoveryDecision {
  operationId: string;
  classification: WorkspaceOperationClassification;
  slotState: "transitioning" | "available" | "blocked" | "adoption_required";
  assignmentState: WorkspaceAssignmentState;
  claimState: "held" | "released" | "orphaned";
  replayed: false;
}

export type WorkspaceLedgerErrorCode =
  | "missing"
  | "malformed"
  | "future_schema"
  | "oversized"
  | "unsafe_path"
  | "wrong_mode"
  | "cas_conflict"
  | "capacity"
  | "claim_held"
  | "lock_held"
  | "ledger_io"
  | "repository_mismatch";

export class WorkspaceLedgerError extends Error {
  readonly code: WorkspaceLedgerErrorCode;

  constructor(code: WorkspaceLedgerErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceLedgerError";
    this.code = code;
  }
}

function fail(code: WorkspaceLedgerErrorCode, message: string): never {
  throw new WorkspaceLedgerError(code, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("malformed", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key))
      fail("malformed", `${path} contains an unknown field`);
  }
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(
  value: unknown,
  path: string,
  maximum: number,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("malformed", `${path} must be a non-empty string`);
  }
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maximum) {
    fail("malformed", `${path} exceeds its bound`);
  }
  if (pattern && !pattern.test(value)) fail("malformed", `${path} is invalid`);
  return value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  maximum: number,
  pattern?: RegExp,
): string | undefined {
  if (!has(value, key) || value[key] === undefined) return undefined;
  return boundedString(value[key], `${path}.${key}`, maximum, pattern);
}

function boundedInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("malformed", `${path} must be a bounded integer`);
  }
  return value as number;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  path: string,
  minimum = 0,
): number | undefined {
  if (!has(value, key) || value[key] === undefined) return undefined;
  return boundedInteger(value[key], `${path}.${key}`, minimum);
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail("malformed", `${path} contains an unsupported value`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  if (!has(value, key) || value[key] === undefined) return undefined;
  return enumValue(value[key], `${path}.${key}`, allowed);
}

function pathValue(value: unknown, path: string): string {
  return boundedString(
    value,
    path,
    MAX_WORKSPACE_PATH_BYTES,
    undefined,
  ).trim() === value
    ? isAbsolute(value as string)
      ? (value as string)
      : fail("malformed", `${path} must be absolute`)
    : fail("malformed", `${path} has surrounding whitespace`);
}

function fullRef(value: unknown, path: string): string {
  const ref = boundedString(value, path, MAX_WORKSPACE_REF_BYTES);
  if (
    !FULL_HEAD_REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    /[\s\u0000-\u001f\u007f]/.test(ref)
  ) {
    fail("malformed", `${path} must be a full branch ref`);
  }
  return ref;
}

function oid(value: unknown, path: string): string {
  const candidate = boundedString(value, path, 64, HEX_PATTERN);
  if (
    (candidate.length !== 40 && candidate.length !== 64) ||
    /^0+$/.test(candidate) ||
    !HEX_PATTERN.test(candidate)
  ) {
    fail("malformed", `${path} must be a full object id`);
  }
  return candidate.toLowerCase();
}

function safeId(value: unknown, path: string): string {
  const id = boundedString(
    value,
    path,
    MAX_WORKSPACE_ID_BYTES,
    SAFE_ID_PATTERN,
  );
  if (id === "__proto__" || id === "constructor" || id === "prototype") {
    fail("malformed", `${path} is reserved`);
  }
  return id;
}

function validatedChildId(value: unknown, path: string): string {
  const id = safeId(value, path);
  if (!CHILD_ID_PATTERN.test(id))
    fail("malformed", `${path} is not a child id`);
  return id;
}

function remoteValue(value: unknown, path: string): string {
  const remote = safeId(value, path);
  if (remote.startsWith("-") || remote.includes("::"))
    fail("malformed", `${path} is unsafe`);
  return remote;
}

function timestamp(value: unknown, path: string): number {
  return boundedInteger(value, path);
}

function arrayValue(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail("malformed", `${path} must be an array`);
  if (value.length > maximum) fail("capacity", `${path} exceeds capacity`);
  return value;
}

function ownerValue(value: unknown, path: string): DurableOwner {
  const obj = record(value, path);
  keys(obj, ["processInstanceId", "parentSessionId", "nonce", "pid"], path);
  const parentSessionId = optionalString(
    obj,
    "parentSessionId",
    path,
    MAX_WORKSPACE_ID_BYTES,
  );
  const pid = optionalInteger(obj, "pid", path, 1);
  return {
    processInstanceId: safeId(
      obj.processInstanceId,
      `${path}.processInstanceId`,
    ),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    nonce: safeId(obj.nonce, `${path}.nonce`),
    ...(pid === undefined ? {} : { pid }),
  };
}

function observationValue(value: unknown, path: string): WorktreeObservation {
  const obj = record(value, path);
  keys(
    obj,
    [
      "root",
      "filesystemIdentity",
      "branchRef",
      "headOid",
      "checkout",
      "status",
      "admin",
    ],
    path,
  );
  const branchRef = optionalString(
    obj,
    "branchRef",
    path,
    MAX_WORKSPACE_REF_BYTES,
  );
  if (branchRef !== undefined) fullRef(branchRef, `${path}.branchRef`);
  const headOid = optionalString(obj, "headOid", path, 64, HEX_PATTERN);
  if (headOid !== undefined) oid(headOid, `${path}.headOid`);
  const checkout = enumValue(obj.checkout, `${path}.checkout`, [
    "branch",
    "detached",
    "unborn",
    "unknown",
  ] as const);
  if (checkout === "branch" && branchRef === undefined) {
    fail("malformed", `${path}.branchRef is required for a branch checkout`);
  }
  return {
    root: pathValue(obj.root, `${path}.root`),
    filesystemIdentity: boundedString(
      obj.filesystemIdentity,
      `${path}.filesystemIdentity`,
      MAX_WORKSPACE_FILESYSTEM_ID_BYTES,
    ),
    ...(branchRef === undefined ? {} : { branchRef }),
    ...(headOid === undefined ? {} : { headOid }),
    checkout,
    status: enumValue(obj.status, `${path}.status`, [
      "clean",
      "dirty",
      "ignored",
      "conflicted",
      "in_progress",
      "unknown",
    ] as const),
    admin: enumValue(obj.admin, `${path}.admin`, [
      "normal",
      "locked",
      "prunable",
      "unknown",
    ] as const),
  };
}

function repositoryValue(value: unknown): RepositoryRecord {
  const obj = record(value, "repository");
  keys(
    obj,
    ["repoId", "commonDir", "gitDir", "objectFormat", "publicationRefs"],
    "repository",
  );
  const refs = arrayValue(
    obj.publicationRefs,
    "repository.publicationRefs",
    MAX_WORKSPACE_PUBLICATION_REFS,
  ).map((entry, index) => {
    const item = record(entry, `repository.publicationRefs[${index}]`);
    keys(item, ["remote", "ref"], `repository.publicationRefs[${index}]`);
    return {
      remote: remoteValue(
        item.remote,
        `repository.publicationRefs[${index}].remote`,
      ),
      ref: fullRef(item.ref, `repository.publicationRefs[${index}].ref`),
    };
  });
  return {
    repoId: boundedString(
      obj.repoId,
      "repository.repoId",
      64,
      /^[a-f0-9]{64}$/i,
    ).toLowerCase(),
    commonDir: pathValue(obj.commonDir, "repository.commonDir"),
    gitDir: pathValue(obj.gitDir, "repository.gitDir"),
    objectFormat: enumValue(obj.objectFormat, "repository.objectFormat", [
      "sha1",
      "sha256",
    ] as const),
    publicationRefs: refs,
  };
}

function slotValue(value: unknown, index: number): SlotRecord {
  const path = `slots[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "slotId",
      "kind",
      "adminKey",
      "root",
      "gitDir",
      "state",
      "revision",
      "assignmentEpoch",
      "activeAssignmentId",
      "observation",
    ],
    path,
  );
  const activeAssignmentId = optionalString(
    obj,
    "activeAssignmentId",
    path,
    MAX_WORKSPACE_ID_BYTES,
    SAFE_ID_PATTERN,
  );
  const observation = has(obj, "observation")
    ? observationValue(obj.observation, `${path}.observation`)
    : undefined;
  return {
    slotId: safeId(obj.slotId, `${path}.slotId`),
    kind: enumValue(obj.kind, `${path}.kind`, ["main", "linked"] as const),
    adminKey: safeId(obj.adminKey, `${path}.adminKey`),
    root: pathValue(obj.root, `${path}.root`),
    gitDir: pathValue(obj.gitDir, `${path}.gitDir`),
    state: enumValue(obj.state, `${path}.state`, [
      "unmanaged",
      "available",
      "reserved",
      "assigned",
      "transitioning",
      "blocked",
      "adoption_required",
    ] as const),
    revision: boundedInteger(obj.revision, `${path}.revision`),
    assignmentEpoch: boundedInteger(
      obj.assignmentEpoch,
      `${path}.assignmentEpoch`,
    ),
    ...(activeAssignmentId === undefined ? {} : { activeAssignmentId }),
    ...(observation === undefined ? {} : { observation }),
  };
}

function assignmentValue(value: unknown, index: number): AssignmentRecord {
  const path = `assignments[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "assignmentId",
      "slotId",
      "workItemId",
      "branchRef",
      "epoch",
      "expectedRoot",
      "expectedHeadOid",
      "owner",
      "childId",
      "state",
    ],
    path,
  );
  const expectedHeadOid = optionalString(
    obj,
    "expectedHeadOid",
    path,
    64,
    HEX_PATTERN,
  );
  if (expectedHeadOid !== undefined)
    oid(expectedHeadOid, `${path}.expectedHeadOid`);
  const childId = has(obj, "childId")
    ? validatedChildId(obj.childId, `${path}.childId`)
    : undefined;
  return {
    assignmentId: safeId(obj.assignmentId, `${path}.assignmentId`),
    slotId: safeId(obj.slotId, `${path}.slotId`),
    workItemId: safeId(obj.workItemId, `${path}.workItemId`),
    branchRef: fullRef(obj.branchRef, `${path}.branchRef`),
    epoch: boundedInteger(obj.epoch, `${path}.epoch`),
    expectedRoot: pathValue(obj.expectedRoot, `${path}.expectedRoot`),
    ...(expectedHeadOid === undefined ? {} : { expectedHeadOid }),
    owner: ownerValue(obj.owner, `${path}.owner`),
    ...(childId === undefined ? {} : { childId }),
    state: enumValue(obj.state, `${path}.state`, [
      "reserved",
      "bound",
      "retired",
      "blocked",
    ] as const),
  };
}

function operationValue(value: unknown, index: number): OperationIntent {
  const path = `operations[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "operationId",
      "action",
      "claimId",
      "assignmentId",
      "fromEpoch",
      "toEpoch",
      "expectedRevision",
      "requestedBranchRef",
      "requestedBaseOid",
      "before",
      "intendedAfter",
      "phase",
    ],
    path,
  );
  const requestedBaseOid = optionalString(
    obj,
    "requestedBaseOid",
    path,
    64,
    HEX_PATTERN,
  );
  if (requestedBaseOid !== undefined)
    oid(requestedBaseOid, `${path}.requestedBaseOid`);
  return {
    operationId: safeId(obj.operationId, `${path}.operationId`),
    action: enumValue(obj.action, `${path}.action`, [
      "switch_existing",
      "create_branch",
    ] as const),
    claimId: safeId(obj.claimId, `${path}.claimId`),
    assignmentId: safeId(obj.assignmentId, `${path}.assignmentId`),
    fromEpoch: boundedInteger(obj.fromEpoch, `${path}.fromEpoch`),
    toEpoch: boundedInteger(obj.toEpoch, `${path}.toEpoch`),
    expectedRevision: boundedInteger(
      obj.expectedRevision,
      `${path}.expectedRevision`,
    ),
    requestedBranchRef: fullRef(
      obj.requestedBranchRef,
      `${path}.requestedBranchRef`,
    ),
    ...(requestedBaseOid === undefined ? {} : { requestedBaseOid }),
    before: observationValue(obj.before, `${path}.before`),
    intendedAfter: observationValue(obj.intendedAfter, `${path}.intendedAfter`),
    phase: enumValue(obj.phase, `${path}.phase`, [
      "prepared",
      "committed",
      "interrupted",
      "blocked",
    ] as const),
  };
}

function outcomeValue(value: unknown, index: number): OperationOutcome {
  const path = `outcomes[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    ["operationId", "classification", "command", "observed", "errorCode"],
    path,
  );
  const observed = has(obj, "observed")
    ? observationValue(obj.observed, `${path}.observed`)
    : undefined;
  return {
    operationId: safeId(obj.operationId, `${path}.operationId`),
    classification: enumValue(obj.classification, `${path}.classification`, [
      "after",
      "before",
      "mismatch",
      "unknown",
      "admin_locked",
      "parse_error",
      "timeout",
      "cancelled",
    ] as const),
    command: enumValue(obj.command, `${path}.command`, [
      "not_started",
      "success",
      "error",
      "timeout",
      "cancelled",
    ] as const),
    ...(observed === undefined ? {} : { observed }),
    ...(has(obj, "errorCode")
      ? {
          errorCode: enumValue(obj.errorCode, `${path}.errorCode`, [
            "timeout",
            "cancelled",
            "parse_error",
            "output_limit",
            "ledger_io",
            "branch_conflict",
            "unknown",
          ] as const),
        }
      : {}),
  };
}

function branchValue(value: unknown, index: number): BranchRecord {
  const path = `branches[${index}]`;
  const obj = record(value, path);
  keys(obj, ["branchRef", "headOid", "state"], path);
  const headOid = optionalString(obj, "headOid", path, 64, HEX_PATTERN);
  if (headOid !== undefined) oid(headOid, `${path}.headOid`);
  return {
    branchRef: fullRef(obj.branchRef, `${path}.branchRef`),
    ...(headOid === undefined ? {} : { headOid }),
    state: enumValue(obj.state, `${path}.state`, [
      "present",
      "missing",
      "unknown",
    ] as const),
  };
}

function workItemValue(value: unknown, index: number): WorkItemRecord {
  const path = `workItems[${index}]`;
  const obj = record(value, path);
  keys(obj, ["workItemId", "branchRef", "lifecycle", "assignmentIds"], path);
  const assignmentIds = arrayValue(
    obj.assignmentIds,
    `${path}.assignmentIds`,
    MAX_WORKSPACE_ASSIGNMENTS,
  ).map((item, itemIndex) =>
    safeId(item, `${path}.assignmentIds[${itemIndex}]`),
  );
  return {
    workItemId: safeId(obj.workItemId, `${path}.workItemId`),
    branchRef: fullRef(obj.branchRef, `${path}.branchRef`),
    lifecycle: enumValue(obj.lifecycle, `${path}.lifecycle`, [
      "active",
      "parked",
      "archived",
    ] as const),
    assignmentIds,
  };
}

function claimValue(value: unknown, index: number): ClaimRecord {
  const path = `claims[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "claimId",
      "scope",
      "slotId",
      "owner",
      "state",
      "claimEpoch",
      "acquiredAt",
    ],
    path,
  );
  const slotId = optionalString(
    obj,
    "slotId",
    path,
    MAX_WORKSPACE_ID_BYTES,
    SAFE_ID_PATTERN,
  );
  const scope = enumValue(obj.scope, `${path}.scope`, [
    "repository",
    "slot",
  ] as const);
  if (scope === "slot" && slotId === undefined)
    fail("malformed", "slot claim requires slotId");
  if (scope === "repository" && slotId !== undefined)
    fail("malformed", "repository claim cannot have slotId");
  return {
    claimId: safeId(obj.claimId, `${path}.claimId`),
    scope,
    ...(slotId === undefined ? {} : { slotId }),
    owner: ownerValue(obj.owner, `${path}.owner`),
    state: enumValue(obj.state, `${path}.state`, [
      "held",
      "released",
      "orphaned",
    ] as const),
    claimEpoch: boundedInteger(obj.claimEpoch, `${path}.claimEpoch`),
    acquiredAt: timestamp(obj.acquiredAt, `${path}.acquiredAt`),
  };
}

function publicationValue(
  value: unknown,
  index: number,
): PublicationObservation {
  const path = `publications[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "observationId",
      "workItemId",
      "assignmentEpoch",
      "remote",
      "ref",
      "candidateOid",
      "candidateBranchRef",
      "observedOid",
      "result",
      "freshness",
      "source",
      "checkedAt",
      "errorCode",
    ],
    path,
  );
  const observedOid = optionalString(obj, "observedOid", path, 64, HEX_PATTERN);
  if (observedOid !== undefined) oid(observedOid, `${path}.observedOid`);
  return {
    observationId: safeId(obj.observationId, `${path}.observationId`),
    workItemId: safeId(obj.workItemId, `${path}.workItemId`),
    assignmentEpoch: boundedInteger(
      obj.assignmentEpoch,
      `${path}.assignmentEpoch`,
    ),
    remote: remoteValue(obj.remote, `${path}.remote`),
    ref: fullRef(obj.ref, `${path}.ref`),
    candidateOid: oid(obj.candidateOid, `${path}.candidateOid`),
    candidateBranchRef: fullRef(
      obj.candidateBranchRef,
      `${path}.candidateBranchRef`,
    ),
    ...(observedOid === undefined ? {} : { observedOid }),
    result: enumValue(obj.result, `${path}.result`, [
      "equal",
      "different",
      "not_advertised",
      "unknown",
    ] as const),
    freshness: enumValue(obj.freshness, `${path}.freshness`, [
      "fresh",
      "stale",
      "unknown",
    ] as const),
    source: enumValue(obj.source, `${path}.source`, [
      "git_remote_probe",
    ] as const),
    checkedAt: timestamp(obj.checkedAt, `${path}.checkedAt`),
    ...(has(obj, "errorCode")
      ? {
          errorCode: enumValue(obj.errorCode, `${path}.errorCode`, [
            "auth",
            "timeout",
            "unavailable",
            "malformed",
            "remote_changed",
          ] as const),
        }
      : {}),
  };
}

function prAssociationValue(value: unknown, index: number): PrAssociation {
  const path = `prAssociations[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "associationId",
      "workItemId",
      "provider",
      "externalId",
      "claimedHeadOid",
      "claimedBaseRef",
      "provenance",
      "recordedAt",
    ],
    path,
  );
  const claimedHeadOid = optionalString(
    obj,
    "claimedHeadOid",
    path,
    64,
    HEX_PATTERN,
  );
  if (claimedHeadOid !== undefined)
    oid(claimedHeadOid, `${path}.claimedHeadOid`);
  const claimedBaseRef = optionalString(
    obj,
    "claimedBaseRef",
    path,
    MAX_WORKSPACE_REF_BYTES,
  );
  if (claimedBaseRef !== undefined)
    fullRef(claimedBaseRef, `${path}.claimedBaseRef`);
  return {
    associationId: safeId(obj.associationId, `${path}.associationId`),
    workItemId: safeId(obj.workItemId, `${path}.workItemId`),
    provider: boundedString(
      obj.provider,
      `${path}.provider`,
      MAX_WORKSPACE_PROVIDER_BYTES,
    ),
    externalId: boundedString(
      obj.externalId,
      `${path}.externalId`,
      MAX_WORKSPACE_EXTERNAL_ID_BYTES,
    ),
    ...(claimedHeadOid === undefined ? {} : { claimedHeadOid }),
    ...(claimedBaseRef === undefined ? {} : { claimedBaseRef }),
    provenance: enumValue(obj.provenance, `${path}.provenance`, [
      "parent",
      "child_proposal",
    ] as const),
    recordedAt: timestamp(obj.recordedAt, `${path}.recordedAt`),
  };
}

function prObservationValue(value: unknown, index: number): PrObservation {
  const path = `prObservations[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "observationId",
      "associationId",
      "state",
      "draft",
      "verification",
      "headRepo",
      "headRef",
      "headOid",
      "baseRef",
      "freshness",
      "source",
      "recordedAt",
    ],
    path,
  );
  const draft = has(obj, "draft")
    ? typeof obj.draft === "boolean"
      ? obj.draft
      : fail("malformed", `${path}.draft must be boolean`)
    : undefined;
  const headRepo = optionalString(
    obj,
    "headRepo",
    path,
    MAX_WORKSPACE_PATH_BYTES,
  );
  const headRef = optionalString(obj, "headRef", path, MAX_WORKSPACE_REF_BYTES);
  if (headRef !== undefined) fullRef(headRef, `${path}.headRef`);
  const headOid = optionalString(obj, "headOid", path, 64, HEX_PATTERN);
  if (headOid !== undefined) oid(headOid, `${path}.headOid`);
  const baseRef = optionalString(obj, "baseRef", path, MAX_WORKSPACE_REF_BYTES);
  if (baseRef !== undefined) fullRef(baseRef, `${path}.baseRef`);
  return {
    observationId: safeId(obj.observationId, `${path}.observationId`),
    associationId: safeId(obj.associationId, `${path}.associationId`),
    state: enumValue(obj.state, `${path}.state`, [
      "unknown",
      "open",
      "closed",
      "merged",
    ] as const),
    ...(draft === undefined ? {} : { draft }),
    verification: enumValue(obj.verification, `${path}.verification`, [
      "unsupported",
      "unverified",
      "verified",
      "unavailable",
      "mismatch",
    ] as const),
    ...(headRepo === undefined ? {} : { headRepo }),
    ...(headRef === undefined ? {} : { headRef }),
    ...(headOid === undefined ? {} : { headOid }),
    ...(baseRef === undefined ? {} : { baseRef }),
    freshness: enumValue(obj.freshness, `${path}.freshness`, [
      "fresh",
      "stale",
      "unknown",
    ] as const),
    source: enumValue(obj.source, `${path}.source`, [
      "provider",
      "manual_parent",
    ] as const),
    recordedAt: timestamp(obj.recordedAt, `${path}.recordedAt`),
  };
}

function proposalReceiptValue(value: unknown, index: number): ProposalReceipt {
  const path = `proposalReceipts[${index}]`;
  const obj = record(value, path);
  keys(
    obj,
    [
      "receiptId",
      "proposalId",
      "payloadHash",
      "childId",
      "assignmentEpoch",
      "turnId",
      "result",
      "recordedAt",
    ],
    path,
  );
  const payloadHash = boundedString(
    obj.payloadHash,
    `${path}.payloadHash`,
    64,
    /^[a-f0-9]{64}$/i,
  );
  return {
    receiptId: safeId(obj.receiptId, `${path}.receiptId`),
    proposalId: safeId(obj.proposalId, `${path}.proposalId`),
    payloadHash: payloadHash.toLowerCase(),
    childId: validatedChildId(obj.childId, `${path}.childId`),
    assignmentEpoch: boundedInteger(
      obj.assignmentEpoch,
      `${path}.assignmentEpoch`,
    ),
    turnId: safeId(obj.turnId, `${path}.turnId`),
    result: enumValue(obj.result, `${path}.result`, [
      "accepted",
      "duplicate",
      "stale",
      "invalid",
    ] as const),
    recordedAt: timestamp(obj.recordedAt, `${path}.recordedAt`),
  };
}

function unique(items: readonly string[], path: string): void {
  if (new Set(items).size !== items.length)
    fail("malformed", `${path} contains duplicate identities`);
}

function checkCount<T>(items: T[], maximum: number, path: string): void {
  if (items.length > maximum) fail("capacity", `${path} exceeds capacity`);
}

function validateLedgerRelations(params: {
  slots: SlotRecord[];
  workItems: WorkItemRecord[];
  assignments: AssignmentRecord[];
  claims: ClaimRecord[];
  operations: OperationIntent[];
  outcomes: OperationOutcome[];
  prAssociations: PrAssociation[];
  prObservations: PrObservation[];
}): void {
  const slots = new Set(params.slots.map((slot) => slot.slotId));
  const workItems = new Set(params.workItems.map((item) => item.workItemId));
  const assignments = new Map(
    params.assignments.map((item) => [item.assignmentId, item]),
  );
  const operations = new Set(params.operations.map((item) => item.operationId));
  const associations = new Set(
    params.prAssociations.map((item) => item.associationId),
  );
  for (const slot of params.slots) {
    if (slot.activeAssignmentId) {
      const assignment = assignments.get(slot.activeAssignmentId);
      if (
        !assignment ||
        assignment.slotId !== slot.slotId ||
        assignment.state === "retired"
      )
        fail("malformed", "slot active assignment is inconsistent");
    }
  }
  for (const assignment of params.assignments) {
    if (!slots.has(assignment.slotId) || !workItems.has(assignment.workItemId))
      fail("malformed", "assignment references missing state");
    if (assignment.state === "bound" && !assignment.childId)
      fail("malformed", "bound assignment has no child");
  }
  for (const item of params.workItems) {
    unique(item.assignmentIds, `workItem ${item.workItemId}.assignmentIds`);
    if (item.assignmentIds.some((id) => !assignments.has(id)))
      fail("malformed", "work item references missing assignment");
    for (const assignment of params.assignments) {
      if (
        assignment.workItemId === item.workItemId &&
        !item.assignmentIds.includes(assignment.assignmentId)
      )
        fail("malformed", "work item omits an assignment history record");
    }
  }
  for (const claim of params.claims) {
    if (claim.scope === "slot" && (!claim.slotId || !slots.has(claim.slotId)))
      fail("malformed", "slot claim references missing slot");
    if (claim.scope === "repository" && claim.slotId !== undefined)
      fail("malformed", "repository claim cannot have a slot");
  }
  for (const operation of params.operations) {
    if (
      !operations.has(operation.operationId) ||
      !assignments.has(operation.assignmentId)
    )
      fail("malformed", "operation references missing state");
    if (!params.claims.some((claim) => claim.claimId === operation.claimId))
      fail("malformed", "operation references missing claim");
  }
  for (const outcome of params.outcomes)
    if (!operations.has(outcome.operationId))
      fail("malformed", "outcome references missing operation");
  for (const association of params.prAssociations)
    if (!workItems.has(association.workItemId))
      fail("malformed", "PR association references missing work item");
  for (const observation of params.prObservations)
    if (!associations.has(observation.associationId))
      fail("malformed", "PR observation references missing association");
}

export function validateWorkspaceLedger(value: unknown): WorkspaceLedgerV1 {
  const obj = record(value, "ledger");
  keys(
    obj,
    [
      "schemaVersion",
      "ledgerRevision",
      "repository",
      "slots",
      "branches",
      "workItems",
      "assignments",
      "claims",
      "operations",
      "outcomes",
      "publications",
      "prAssociations",
      "prObservations",
      "proposalCursors",
      "proposalReceipts",
    ],
    "ledger",
  );
  if (obj.schemaVersion !== WORKSPACE_LEDGER_SCHEMA_VERSION) {
    if (
      typeof obj.schemaVersion === "number" &&
      obj.schemaVersion > WORKSPACE_LEDGER_SCHEMA_VERSION
    ) {
      fail("future_schema", "workspace ledger uses a future schema");
    }
    fail("malformed", "workspace ledger schema is unsupported");
  }
  const repository = repositoryValue(obj.repository);
  const slots = arrayValue(obj.slots, "slots", MAX_WORKSPACE_SLOTS).map(
    slotValue,
  );
  const branches = arrayValue(
    obj.branches,
    "branches",
    MAX_WORKSPACE_WORK_ITEMS,
  ).map(branchValue);
  const workItems = arrayValue(
    obj.workItems,
    "workItems",
    MAX_WORKSPACE_WORK_ITEMS,
  ).map(workItemValue);
  const assignments = arrayValue(
    obj.assignments,
    "assignments",
    MAX_WORKSPACE_ASSIGNMENTS,
  ).map(assignmentValue);
  const claims = arrayValue(
    obj.claims,
    "claims",
    MAX_WORKSPACE_ASSIGNMENTS,
  ).map(claimValue);
  const operations = arrayValue(
    obj.operations,
    "operations",
    MAX_WORKSPACE_INTENTS,
  ).map(operationValue);
  const outcomes = arrayValue(
    obj.outcomes,
    "outcomes",
    MAX_WORKSPACE_OUTCOMES,
  ).map(outcomeValue);
  const publications = arrayValue(
    obj.publications,
    "publications",
    MAX_WORKSPACE_PUBLICATIONS,
  ).map(publicationValue);
  const prAssociations = arrayValue(
    obj.prAssociations,
    "prAssociations",
    MAX_WORKSPACE_PR_ASSOCIATIONS,
  ).map(prAssociationValue);
  const prObservations = arrayValue(
    obj.prObservations,
    "prObservations",
    MAX_WORKSPACE_PR_OBSERVATIONS,
  ).map(prObservationValue);
  const proposalReceipts = arrayValue(
    obj.proposalReceipts,
    "proposalReceipts",
    MAX_WORKSPACE_PROPOSAL_RECEIPTS,
  ).map(proposalReceiptValue);
  const oidLength = repository.objectFormat === "sha1" ? 40 : 64;
  const checkOidLength = (value: string | undefined, path: string): void => {
    if (value !== undefined && value.length !== oidLength)
      fail("malformed", `${path} does not match the repository object format`);
  };
  for (const branch of branches)
    checkOidLength(branch.headOid, "branch headOid");
  for (const assignment of assignments)
    checkOidLength(assignment.expectedHeadOid, "assignment expectedHeadOid");
  for (const operation of operations) {
    checkOidLength(operation.requestedBaseOid, "operation requestedBaseOid");
    checkOidLength(operation.before.headOid, "operation before headOid");
    checkOidLength(
      operation.intendedAfter.headOid,
      "operation intendedAfter headOid",
    );
  }
  for (const outcome of outcomes)
    checkOidLength(outcome.observed?.headOid, "outcome observed headOid");
  for (const publication of publications) {
    checkOidLength(publication.candidateOid, "publication candidateOid");
    checkOidLength(publication.observedOid, "publication observedOid");
  }
  for (const association of prAssociations)
    checkOidLength(association.claimedHeadOid, "PR claimedHeadOid");
  for (const observation of prObservations)
    checkOidLength(observation.headOid, "PR headOid");
  const rawCursors = record(obj.proposalCursors, "proposalCursors");
  const cursorEntries = Object.entries(rawCursors);
  checkCount(cursorEntries, MAX_WORKSPACE_PROPOSAL_CURSORS, "proposalCursors");
  const proposalCursors: Record<string, number> = Object.create(null);
  for (const [key, cursor] of cursorEntries) {
    proposalCursors[safeId(key, "proposalCursors key")] = boundedInteger(
      cursor,
      `proposalCursors.${key}`,
    );
  }
  unique(
    slots.map((item) => item.slotId),
    "slots",
  );
  unique(
    branches.map((item) => item.branchRef),
    "branches",
  );
  unique(
    workItems.map((item) => item.workItemId),
    "workItems",
  );
  unique(
    assignments.map((item) => item.assignmentId),
    "assignments",
  );
  unique(
    claims.map((item) => item.claimId),
    "claims",
  );
  unique(
    operations.map((item) => item.operationId),
    "operations",
  );
  unique(
    outcomes.map((item) => item.operationId),
    "outcomes",
  );
  unique(
    publications.map((item) => item.observationId),
    "publications",
  );
  unique(
    prAssociations.map((item) => item.associationId),
    "prAssociations",
  );
  unique(
    prObservations.map((item) => item.observationId),
    "prObservations",
  );
  unique(
    proposalReceipts.map((item) => item.receiptId),
    "proposalReceipts",
  );
  validateLedgerRelations({
    slots,
    workItems,
    assignments,
    claims,
    operations,
    outcomes,
    prAssociations,
    prObservations,
  });
  return {
    schemaVersion: 1,
    ledgerRevision: boundedInteger(obj.ledgerRevision, "ledgerRevision"),
    repository,
    slots,
    branches,
    workItems,
    assignments,
    claims,
    operations,
    outcomes,
    publications,
    prAssociations,
    prObservations,
    proposalCursors,
    proposalReceipts,
  };
}

export function repositoryIdFor(
  commonDir: string,
  objectFormat: WorkspaceObjectFormat,
): string {
  const canonical = `${realpathSync(commonDir)}\0${objectFormat}`;
  return createHash("sha256")
    .update("pi-subagentura:workspace:v1\0")
    .update(canonical)
    .digest("hex");
}

export function createRepositoryRecord(params: {
  commonDir: string;
  gitDir: string;
  objectFormat: WorkspaceObjectFormat;
  publicationRefs?: readonly PublicationRef[];
}): RepositoryRecord {
  const commonDir = realpathSync(params.commonDir);
  const gitDir = realpathSync(params.gitDir);
  const record: RepositoryRecord = {
    repoId: repositoryIdFor(commonDir, params.objectFormat),
    commonDir,
    gitDir,
    objectFormat: params.objectFormat,
    publicationRefs: [...(params.publicationRefs ?? [])],
  };
  return repositoryValue(record);
}

export function createEmptyWorkspaceLedger(
  repository: RepositoryRecord,
): WorkspaceLedgerV1 {
  const normalizedRepository = repositoryValue(repository);
  return {
    schemaVersion: 1,
    ledgerRevision: 0,
    repository: normalizedRepository,
    slots: [],
    branches: [],
    workItems: [],
    assignments: [],
    claims: [],
    operations: [],
    outcomes: [],
    publications: [],
    prAssociations: [],
    prObservations: [],
    proposalCursors: {},
    proposalReceipts: [],
  };
}

export function workspaceLedgerPath(commonDir: string): string {
  if (!isAbsolute(commonDir) || commonDir.includes("\0")) {
    fail("unsafe_path", "workspace common directory must be absolute");
  }
  return join(commonDir, WORKSPACE_LEDGER_FILE);
}

export function workspaceLockPath(commonDir: string): string {
  return join(commonDir, WORKSPACE_LOCK_FILE);
}

export function workspaceRecoveryLockPath(commonDir: string): string {
  return join(commonDir, WORKSPACE_RECOVERY_LOCK_FILE);
}

interface Snapshot {
  kind: "missing" | "valid" | "invalid";
  content?: string;
  reason?: WorkspaceLedgerErrorCode;
}

function readLedgerSnapshot(commonDir: string): Snapshot {
  const file = workspaceLedgerPath(commonDir);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "invalid",
      reason: code === "ELOOP" ? "unsafe_path" : "ledger_io",
    };
  }
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      return { kind: "invalid", reason: "unsafe_path" };
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      return { kind: "invalid", reason: "wrong_mode" };
    }
    if (
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > MAX_WORKSPACE_LEDGER_BYTES
    ) {
      return { kind: "invalid", reason: "oversized" };
    }
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const count = readSync(fd, buffer, offset, metadata.size - offset, null);
      if (count <= 0) return { kind: "invalid", reason: "ledger_io" };
      offset += count;
    }
    try {
      return {
        kind: "valid",
        content: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
      };
    } catch {
      return { kind: "invalid", reason: "malformed" };
    }
  } catch {
    return { kind: "invalid", reason: "ledger_io" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor is no longer usable after a bounded snapshot read.
    }
  }
}

export type WorkspaceLedgerReadResult =
  | { kind: "missing" }
  | { kind: "valid"; ledger: WorkspaceLedgerV1 }
  | { kind: "invalid"; reason: WorkspaceLedgerErrorCode };

export function readWorkspaceLedger(
  commonDir: string,
): WorkspaceLedgerReadResult {
  const snapshot = readLedgerSnapshot(commonDir);
  if (snapshot.kind === "missing") return { kind: "missing" };
  if (snapshot.kind === "invalid")
    return { kind: "invalid", reason: snapshot.reason ?? "ledger_io" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content!);
  } catch {
    return { kind: "invalid", reason: "malformed" };
  }
  try {
    return { kind: "valid", ledger: validateWorkspaceLedger(parsed) };
  } catch (error) {
    if (error instanceof WorkspaceLedgerError)
      return { kind: "invalid", reason: error.code };
    return { kind: "invalid", reason: "malformed" };
  }
}

export function loadWorkspaceLedger(
  commonDir: string,
): WorkspaceLedgerV1 | undefined {
  const result = readWorkspaceLedger(commonDir);
  if (result.kind === "missing") return undefined;
  if (result.kind === "invalid") {
    throw new WorkspaceLedgerError(
      result.reason,
      `workspace ledger cannot be used: ${result.reason}`,
    );
  }
  return result.ledger;
}

function serializeWorkspaceLedger(ledger: WorkspaceLedgerV1): string {
  validateWorkspaceLedger(ledger);
  const content = JSON.stringify(ledger, null, 2);
  if (Buffer.byteLength(content, "utf8") > MAX_WORKSPACE_LEDGER_BYTES) {
    fail("oversized", "workspace ledger exceeds its byte cap");
  }
  return content;
}

function ensureCommonDirectory(commonDir: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(commonDir);
    if (!statSync(canonical).isDirectory())
      fail("unsafe_path", "common directory is not a directory");
  } catch (error) {
    if (error instanceof WorkspaceLedgerError) throw error;
    fail("ledger_io", "common directory cannot be opened");
  }
  return canonical;
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY | O_NOFOLLOW);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Directory fsync is best effort only after the file has been committed.
      }
    }
  }
}

function atomicWriteLedger(commonDir: string, ledger: WorkspaceLedgerV1): void {
  const canonicalDir = ensureCommonDirectory(commonDir);
  const file = workspaceLedgerPath(canonicalDir);
  const content = serializeWorkspaceLedger(ledger);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    chmodSync(temporary, 0o600);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    renamed = true;
    fsyncDirectory(canonicalDir);
  } catch (error) {
    throw new WorkspaceLedgerError(
      "ledger_io",
      error instanceof Error
        ? "workspace ledger write failed"
        : "workspace ledger write failed",
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original ledger write result.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch {
        // A failed temporary write may have left no file to remove.
      }
    }
  }
}

interface LockIdentity {
  fd: number;
  device: number;
  inode: number;
  metadata: string;
}

function acquireWorkspaceLock(commonDir: string): LockIdentity {
  const canonicalDir = ensureCommonDirectory(commonDir);
  const file = workspaceLockPath(canonicalDir);
  const metadata = JSON.stringify({ pid: process.pid, token: randomUUID() });
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, metadata, { encoding: "utf8" });
    fsyncSync(fd);
    const stat = fstatSync(fd);
    return { fd, device: stat.dev, inode: stat.ino, metadata };
  } catch (error) {
    if (typeof fd === "number") {
      try {
        closeSync(fd);
      } catch {
        // The lock descriptor cannot be used after a failed acquisition.
      }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceLedgerError(
        "lock_held",
        "workspace ledger lock is held",
      );
    }
    throw new WorkspaceLedgerError(
      "ledger_io",
      "workspace ledger lock cannot be acquired",
    );
  }
}

function releaseWorkspaceLock(commonDir: string, identity: LockIdentity): void {
  const file = workspaceLockPath(ensureCommonDirectory(commonDir));
  try {
    const currentFd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
    const current = fstatSync(currentFd);
    const currentMetadata = (() => {
      const buffer = Buffer.alloc(4_096);
      const count = readSync(currentFd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, count).toString("utf8");
    })();
    closeSync(currentFd);
    if (
      current.dev === identity.device &&
      current.ino === identity.inode &&
      currentMetadata === identity.metadata
    ) {
      unlinkSync(file);
    }
  } catch {
    // Never remove a replacement owner's lock during cleanup.
  } finally {
    try {
      closeSync(identity.fd);
    } catch {
      // The descriptor may already have been closed after a failed action.
    }
  }
}

export function withWorkspaceLedgerLock<T>(
  commonDir: string,
  action: () => T,
): T {
  const lock = acquireWorkspaceLock(commonDir);
  try {
    return action();
  } finally {
    releaseWorkspaceLock(commonDir, lock);
  }
}

export function saveWorkspaceLedger(
  commonDir: string,
  ledger: WorkspaceLedgerV1,
  expectedRevision?: number,
): WorkspaceLedgerV1 {
  return withWorkspaceLedgerLock(commonDir, () => {
    const current = readWorkspaceLedger(commonDir);
    if (current.kind === "invalid") {
      throw new WorkspaceLedgerError(
        current.reason,
        `workspace ledger cannot be replaced: ${current.reason}`,
      );
    }
    const currentRevision =
      current.kind === "missing" ? 0 : current.ledger.ledgerRevision;
    if (current.kind === "missing" && ledger.ledgerRevision !== 0) {
      throw new WorkspaceLedgerError(
        "cas_conflict",
        "new workspace ledger must start at revision zero",
      );
    }
    if (
      expectedRevision !== undefined &&
      currentRevision !== expectedRevision
    ) {
      throw new WorkspaceLedgerError(
        "cas_conflict",
        "workspace ledger revision changed",
      );
    }
    if (current.kind === "valid" && ledger.ledgerRevision <= currentRevision) {
      throw new WorkspaceLedgerError(
        "cas_conflict",
        "workspace ledger revision must advance",
      );
    }
    const validated = validateWorkspaceLedger(ledger);
    atomicWriteLedger(commonDir, validated);
    return validated;
  });
}

export function updateWorkspaceLedger(
  commonDir: string,
  expectedRevision: number,
  mutate: (ledger: WorkspaceLedgerV1) => void,
  initial?: WorkspaceLedgerV1,
): WorkspaceLedgerV1 {
  return withWorkspaceLedgerLock(commonDir, () => {
    const current = readWorkspaceLedger(commonDir);
    if (current.kind === "invalid") {
      throw new WorkspaceLedgerError(
        current.reason,
        `workspace ledger cannot be updated: ${current.reason}`,
      );
    }
    if (current.kind === "missing") {
      if (expectedRevision !== 0 || !initial) {
        throw new WorkspaceLedgerError(
          "cas_conflict",
          "workspace ledger is missing",
        );
      }
      if (initial.ledgerRevision !== 0) {
        throw new WorkspaceLedgerError(
          "cas_conflict",
          "initial workspace ledger must start at revision zero",
        );
      }
      validateWorkspaceLedger(initial);
      const next = JSON.parse(JSON.stringify(initial)) as WorkspaceLedgerV1;
      mutate(next);
      next.ledgerRevision = 1;
      const validated = validateWorkspaceLedger(next);
      atomicWriteLedger(commonDir, validated);
      return validated;
    }
    if (current.ledger.ledgerRevision !== expectedRevision) {
      throw new WorkspaceLedgerError(
        "cas_conflict",
        "workspace ledger revision changed",
      );
    }
    const next = JSON.parse(
      JSON.stringify(current.ledger),
    ) as WorkspaceLedgerV1;
    mutate(next);
    next.ledgerRevision = expectedRevision + 1;
    const validated = validateWorkspaceLedger(next);
    atomicWriteLedger(commonDir, validated);
    return validated;
  });
}

export function newDurableOwner(params: {
  processInstanceId: string;
  parentSessionId?: string;
  pid?: number;
}): DurableOwner {
  return {
    processInstanceId: safeId(params.processInstanceId, "processInstanceId"),
    ...(params.parentSessionId === undefined
      ? {}
      : { parentSessionId: safeId(params.parentSessionId, "parentSessionId") }),
    nonce: randomUUID(),
    ...(params.pid === undefined
      ? {}
      : { pid: boundedInteger(params.pid, "pid", 1) }),
  };
}

export function canonicalWorkspaceJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("malformed", "canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalWorkspaceJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const pairs = Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalWorkspaceJson(object[key])}`,
      );
    return `{${pairs.join(",")}}`;
  }
  fail("malformed", "canonical JSON contains an unsupported value");
}

export function workspacePayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalWorkspaceJson(value))
    .digest("hex");
}

export interface WorkspaceClaimRequest {
  claimId?: string;
  scope: "repository" | "slot";
  slotId?: string;
  owner: DurableOwner;
  claimEpoch: number;
  acquiredAt?: number;
}

export function acquireWorkspaceClaim(
  commonDir: string,
  expectedRevision: number,
  request: WorkspaceClaimRequest,
  initial?: WorkspaceLedgerV1,
): { ledger: WorkspaceLedgerV1; claim: ClaimRecord } {
  const claimId = request.claimId ?? randomUUID();
  const acquiredAt = request.acquiredAt ?? Date.now();
  let claim: ClaimRecord | undefined;
  const ledger = updateWorkspaceLedger(
    commonDir,
    expectedRevision,
    (next) => {
      const existing = next.claims.find((item) => item.claimId === claimId);
      if (existing) {
        if (!sameDurableOwner(existing.owner, request.owner)) {
          fail("claim_held", "workspace claim belongs to another owner");
        }
        if (
          existing.scope !== request.scope ||
          existing.slotId !== request.slotId
        ) {
          fail("claim_held", "workspace claim scope does not match");
        }
        existing.state = "held";
        existing.claimEpoch = request.claimEpoch;
        existing.acquiredAt = acquiredAt;
        claim = existing;
        return;
      }
      if (next.claims.length >= MAX_WORKSPACE_ASSIGNMENTS)
        fail("capacity", "workspace claim capacity reached");
      claim = {
        claimId,
        scope: request.scope,
        ...(request.slotId === undefined ? {} : { slotId: request.slotId }),
        owner: request.owner,
        state: "held",
        claimEpoch: request.claimEpoch,
        acquiredAt,
      };
      next.claims.push(claim);
    },
    initial,
  );
  if (!claim) fail("ledger_io", "workspace claim was not materialized");
  return {
    ledger,
    claim: ledger.claims.find((item) => item.claimId === claim!.claimId)!,
  };
}

function sameDurableOwner(first: DurableOwner, second: DurableOwner): boolean {
  return (
    first.processInstanceId === second.processInstanceId &&
    first.nonce === second.nonce &&
    first.parentSessionId === second.parentSessionId
  );
}

export function releaseWorkspaceClaim(
  commonDir: string,
  expectedRevision: number,
  claimId: string,
  owner: DurableOwner,
): WorkspaceLedgerV1 {
  return updateWorkspaceLedger(commonDir, expectedRevision, (next) => {
    const claim = next.claims.find((item) => item.claimId === claimId);
    if (!claim) fail("missing", "workspace claim is not recorded");
    if (!sameDurableOwner(claim.owner, owner))
      fail("claim_held", "workspace claim belongs to another owner");
    claim.state = "released";
  });
}

export function findHeldWorkspaceClaim(
  ledger: WorkspaceLedgerV1,
  scope: "repository" | "slot",
  slotId?: string,
): ClaimRecord | undefined {
  return ledger.claims.find(
    (claim) =>
      claim.state === "held" &&
      claim.scope === scope &&
      claim.slotId === slotId,
  );
}
