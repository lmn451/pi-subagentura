import {
  closeSync,
  lstatSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_WORKSPACE_ID_BYTES,
  MAX_WORKSPACE_PATH_BYTES,
  MAX_WORKSPACE_REF_BYTES,
  canonicalWorkspaceJson,
  workspacePayloadHash,
} from "./workspace-ledger";

export const WORKSPACE_ASSIGNMENT_MARKER = "workspace-assignment.json";
export const WORKSPACE_PROPOSALS_FILE = "workspace-proposals.ndjson";
export const WORKSPACE_REPORT_SCHEMA_VERSION = 1;
export const MAX_WORKSPACE_PROPOSAL_BYTES = 64 * 1024;
export const MAX_WORKSPACE_PROPOSAL_FILE_BYTES = 512 * 1024;
export const MAX_WORKSPACE_FACT_KEYS = 32;
export const MAX_WORKSPACE_FACT_BYTES = 16 * 1024;
export const MAX_WORKSPACE_FACT_ITEMS = 128;

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const FULL_HEAD_REF = /^refs\/heads\/[A-Za-z0-9._/@+-]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const CHILD_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{16})$/;

export interface WorkspaceAssignmentMarker {
  schemaVersion: 1;
  repoId: string;
  slotId: string;
  assignmentId: string;
  assignmentEpoch: number;
  childId: string;
  root: string;
  branchRef: string;
}

export type WorkspaceProposalKind =
  "status" | "observation" | "publication" | "pr" | "progress";
export type WorkspaceFact =
  | string
  | number
  | boolean
  | null
  | WorkspaceFact[]
  | { [key: string]: WorkspaceFact };

export interface WorkspaceProposal {
  schemaVersion: 1;
  proposalId: string;
  childId: string;
  assignmentId: string;
  assignmentEpoch: number;
  turnId: string;
  kind: WorkspaceProposalKind;
  facts: Record<string, WorkspaceFact>;
  reportedAt: number;
}

export interface WorkspaceProposalInput {
  proposalId: string;
  turnId: string;
  kind: WorkspaceProposalKind;
  facts: Record<string, WorkspaceFact>;
  reportedAt?: number;
}

export class WorkspaceReportError extends Error {
  readonly code:
    | "missing"
    | "malformed"
    | "oversized"
    | "wrong_mode"
    | "unsafe_path"
    | "io"
    | "invalid_input"
    | "capacity";

  constructor(code: WorkspaceReportError["code"], message: string) {
    super(message);
    this.name = "WorkspaceReportError";
    this.code = code;
  }
}

function fail(code: WorkspaceReportError["code"], message: string): never {
  throw new WorkspaceReportError(code, message);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("malformed", `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    fail("malformed", `${path} contains an unknown field`);
  }
}

function id(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_WORKSPACE_ID_BYTES ||
    value.includes("\0") ||
    !SAFE_ID.test(value)
  ) {
    fail("malformed", `${path} is invalid`);
  }
  return value;
}

function pathValue(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_WORKSPACE_PATH_BYTES ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    fail("malformed", `${path} is invalid`);
  }
  return value;
}

function branchRef(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_WORKSPACE_REF_BYTES ||
    !FULL_HEAD_REF.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("malformed", `${path} is invalid`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("malformed", `${path} is invalid`);
  }
  return value as number;
}

function validateMarker(value: unknown): WorkspaceAssignmentMarker {
  const obj = objectValue(value, "assignment marker");
  exactKeys(
    obj,
    [
      "schemaVersion",
      "repoId",
      "slotId",
      "assignmentId",
      "assignmentEpoch",
      "childId",
      "root",
      "branchRef",
    ],
    "assignment marker",
  );
  if (obj.schemaVersion !== WORKSPACE_REPORT_SCHEMA_VERSION) {
    fail("malformed", "assignment marker schema is unsupported");
  }
  return {
    schemaVersion: 1,
    repoId: (() => {
      const repoId = id(obj.repoId, "assignment marker.repoId");
      if (!SHA256.test(repoId))
        fail("malformed", "assignment marker repository id is invalid");
      return repoId.toLowerCase();
    })(),
    slotId: id(obj.slotId, "assignment marker.slotId"),
    assignmentId: id(obj.assignmentId, "assignment marker.assignmentId"),
    assignmentEpoch: nonnegativeInteger(
      obj.assignmentEpoch,
      "assignment marker.assignmentEpoch",
    ),
    childId: (() => {
      const childId = id(obj.childId, "assignment marker.childId");
      if (!CHILD_ID.test(childId))
        fail("malformed", "assignment marker child id is invalid");
      return childId;
    })(),
    root: pathValue(obj.root, "assignment marker.root"),
    branchRef: branchRef(obj.branchRef, "assignment marker.branchRef"),
  };
}

function validateFact(
  value: unknown,
  depth: number,
  path: string,
): WorkspaceFact {
  if (depth > 4) fail("invalid_input", `${path} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (
      typeof value === "string" &&
      (value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_FACT_BYTES)
    ) {
      fail("invalid_input", `${path} exceeds its byte bound`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("invalid_input", `${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_WORKSPACE_FACT_ITEMS)
      fail("capacity", `${path} exceeds its item bound`);
    return value.map((item, index) =>
      validateFact(item, depth + 1, `${path}[${index}]`),
    );
  }
  const obj = objectValue(value, path);
  if (Object.keys(obj).length > MAX_WORKSPACE_FACT_KEYS)
    fail("capacity", `${path} exceeds its key bound`);
  const result: Record<string, WorkspaceFact> = Object.create(null);
  for (const [key, item] of Object.entries(obj)) {
    if (
      !key ||
      key.includes("\0") ||
      Buffer.byteLength(key, "utf8") > 128 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      fail("invalid_input", `${path} contains an invalid key`);
    }
    result[key] = validateFact(item, depth + 1, `${path}.${key}`);
  }
  return result;
}

export function validateWorkspaceProposal(value: unknown): WorkspaceProposal {
  const obj = objectValue(value, "workspace proposal");
  exactKeys(
    obj,
    [
      "schemaVersion",
      "proposalId",
      "childId",
      "assignmentId",
      "assignmentEpoch",
      "turnId",
      "kind",
      "facts",
      "reportedAt",
    ],
    "workspace proposal",
  );
  if (obj.schemaVersion !== WORKSPACE_REPORT_SCHEMA_VERSION)
    fail("malformed", "workspace proposal schema is unsupported");
  const kind = obj.kind;
  if (
    !["status", "observation", "publication", "pr", "progress"].includes(
      kind as string,
    )
  )
    fail("invalid_input", "workspace proposal kind is unsupported");
  const factsObject = objectValue(obj.facts, "workspace proposal.facts");
  if (Object.keys(factsObject).length > MAX_WORKSPACE_FACT_KEYS)
    fail("capacity", "workspace proposal facts exceed capacity");
  const facts: Record<string, WorkspaceFact> = Object.create(null);
  for (const [key, fact] of Object.entries(factsObject)) {
    if (
      !key ||
      key.includes("\0") ||
      Buffer.byteLength(key, "utf8") > 128 ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    )
      fail("invalid_input", "workspace proposal contains an invalid fact key");
    facts[key] = validateFact(fact, 0, `workspace proposal.facts.${key}`);
  }
  const proposal: WorkspaceProposal = {
    schemaVersion: 1,
    proposalId: id(obj.proposalId, "workspace proposal.proposalId"),
    childId: id(obj.childId, "workspace proposal.childId"),
    assignmentId: id(obj.assignmentId, "workspace proposal.assignmentId"),
    assignmentEpoch: nonnegativeInteger(
      obj.assignmentEpoch,
      "workspace proposal.assignmentEpoch",
    ),
    turnId: id(obj.turnId, "workspace proposal.turnId"),
    kind: kind as WorkspaceProposalKind,
    facts,
    reportedAt: nonnegativeInteger(
      obj.reportedAt,
      "workspace proposal.reportedAt",
    ),
  };
  if (
    Buffer.byteLength(canonicalWorkspaceJson(proposal), "utf8") >
    MAX_WORKSPACE_PROPOSAL_BYTES
  ) {
    fail("oversized", "workspace proposal exceeds its byte cap");
  }
  return proposal;
}

function safeArtifactDir(artifactDir: string): string {
  if (typeof artifactDir !== "string" || artifactDir.includes("\0"))
    fail("unsafe_path", "artifact directory is invalid");
  try {
    const metadata = lstatSync(artifactDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("unsafe_path", "artifact directory is not a real directory");
    if ((metadata.mode & 0o777) !== 0o700)
      fail("wrong_mode", "artifact directory has unsafe permissions");
    return realpathSync(artifactDir);
  } catch (error) {
    if (error instanceof WorkspaceReportError) throw error;
    fail("unsafe_path", "artifact directory cannot be opened");
  }
}

function privateFileSnapshot(
  file: string,
  maximum: number,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("io", "workspace report file cannot be opened");
  }
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1)
      fail("unsafe_path", "workspace report file is not regular");
    if ((metadata.mode & 0o777) !== 0o600)
      fail("wrong_mode", "workspace report file has unsafe permissions");
    if (!Number.isSafeInteger(metadata.size) || metadata.size > maximum)
      fail("oversized", "workspace report file exceeds its byte cap");
    const buffer = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < metadata.size) {
      const count = readSync(fd, buffer, offset, metadata.size - offset, null);
      if (count <= 0) fail("io", "workspace report file could not be read");
      offset += count;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      fail("malformed", "workspace report file is not UTF-8");
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor was only used for this bounded snapshot.
    }
  }
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
        // The directory descriptor is no longer usable after the sync attempt.
      }
    }
  }
}

export function assignmentMarkerPath(artifactDir: string): string {
  return join(safeArtifactDir(artifactDir), WORKSPACE_ASSIGNMENT_MARKER);
}

export function writeWorkspaceAssignmentMarker(
  artifactDir: string,
  marker: WorkspaceAssignmentMarker,
): void {
  const directory = safeArtifactDir(artifactDir);
  const validated = validateMarker(marker);
  if (validated.root.length > MAX_WORKSPACE_PATH_BYTES)
    fail("invalid_input", "assignment root exceeds its byte cap");
  const file = join(directory, WORKSPACE_ASSIGNMENT_MARKER);
  const content = canonicalWorkspaceJson(validated);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  let fd: number | undefined;
  try {
    const existing = privateFileSnapshot(file, MAX_WORKSPACE_PROPOSAL_BYTES);
    if (existing !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        fail("malformed", "assignment marker JSON is malformed");
      }
      if (canonicalWorkspaceJson(validateMarker(parsed)) !== content) {
        fail(
          "invalid_input",
          "assignment marker identity cannot be overwritten",
        );
      }
    }
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    renamed = true;
    fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof WorkspaceReportError) throw error;
    fail("io", "assignment marker could not be written");
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch {
        // No temporary file may exist after a failed atomic write.
      }
    }
  }
}

export function readWorkspaceAssignmentMarker(
  artifactDir: string,
): WorkspaceAssignmentMarker | undefined {
  const file = assignmentMarkerPath(artifactDir);
  const content = privateFileSnapshot(file, MAX_WORKSPACE_PROPOSAL_BYTES);
  if (content === undefined) return undefined;
  try {
    return validateMarker(JSON.parse(content));
  } catch (error) {
    if (error instanceof WorkspaceReportError) throw error;
    fail("malformed", "assignment marker JSON is malformed");
  }
}

export function readWorkspaceActiveTurnId(
  artifactDir: string,
): string | undefined {
  const content = privateFileSnapshot(
    join(safeArtifactDir(artifactDir), "active-turn.json"),
    4_096,
  );
  if (content === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    fail("malformed", "active workspace turn is malformed");
  }
  const object = objectValue(value, "active workspace turn");
  const turnId = object.turnId;
  if (typeof turnId !== "string" || !SAFE_ID.test(turnId)) {
    fail("malformed", "active workspace turn id is invalid");
  }
  return turnId;
}

function appendPrivateLine(file: string, line: string, maximum: number): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW,
      0o600,
    );
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600
    )
      fail("unsafe_path", "workspace proposal ledger is not private");
    if (metadata.size + Buffer.byteLength(line, "utf8") > maximum)
      fail("capacity", "workspace proposal ledger exceeds capacity");
    writeFileSync(fd, line, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(dirname(file));
  } catch (error) {
    if (error instanceof WorkspaceReportError) throw error;
    fail("io", "workspace proposal could not be persisted");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The append descriptor is no longer usable.
      }
    }
  }
}

export function writeWorkspaceProposal(
  artifactDir: string,
  marker: WorkspaceAssignmentMarker,
  input: WorkspaceProposalInput,
): WorkspaceProposal {
  const directory = safeArtifactDir(artifactDir);
  const currentMarker = readWorkspaceAssignmentMarker(directory);
  if (
    !currentMarker ||
    currentMarker.childId !== marker.childId ||
    currentMarker.assignmentId !== marker.assignmentId ||
    currentMarker.assignmentEpoch !== marker.assignmentEpoch
  ) {
    fail(
      "invalid_input",
      "assignment marker does not match the requested proposal",
    );
  }
  const activeTurnId = readWorkspaceActiveTurnId(directory);
  if (activeTurnId !== undefined && activeTurnId !== input.turnId) {
    fail("invalid_input", "workspace proposal turn is stale");
  }
  const proposal = validateWorkspaceProposal({
    schemaVersion: 1,
    proposalId: input.proposalId,
    childId: marker.childId,
    assignmentId: marker.assignmentId,
    assignmentEpoch: marker.assignmentEpoch,
    turnId: input.turnId,
    kind: input.kind,
    facts: input.facts,
    reportedAt: input.reportedAt ?? Date.now(),
  });
  const file = join(directory, WORKSPACE_PROPOSALS_FILE);
  appendPrivateLine(
    file,
    `${canonicalWorkspaceJson(proposal)}\n`,
    MAX_WORKSPACE_PROPOSAL_FILE_BYTES,
  );
  return proposal;
}

export function reportWorkspaceProposal(
  artifactDir: string,
  input: WorkspaceProposalInput,
): WorkspaceProposal {
  const marker = readWorkspaceAssignmentMarker(artifactDir);
  if (!marker) fail("missing", "no workspace assignment marker is present");
  return writeWorkspaceProposal(artifactDir, marker, input);
}

export interface WorkspaceProposalReadIssue {
  line: number;
  reason: "malformed" | "oversized";
}

export function readWorkspaceProposals(artifactDir: string): {
  proposals: WorkspaceProposal[];
  issues: WorkspaceProposalReadIssue[];
} {
  const content = privateFileSnapshot(
    join(safeArtifactDir(artifactDir), WORKSPACE_PROPOSALS_FILE),
    MAX_WORKSPACE_PROPOSAL_FILE_BYTES,
  );
  if (content === undefined) return { proposals: [], issues: [] };
  const proposals: WorkspaceProposal[] = [];
  const issues: WorkspaceProposalReadIssue[] = [];
  const complete = content.endsWith("\n");
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!complete && content.length > 0) {
    issues.push({ line: lines.length, reason: "malformed" });
    lines.pop();
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (Buffer.byteLength(line, "utf8") > MAX_WORKSPACE_PROPOSAL_BYTES) {
      issues.push({ line: index + 1, reason: "oversized" });
      continue;
    }
    try {
      proposals.push(validateWorkspaceProposal(JSON.parse(line)));
    } catch (error) {
      issues.push({
        line: index + 1,
        reason:
          error instanceof WorkspaceReportError && error.code === "oversized"
            ? "oversized"
            : "malformed",
      });
    }
  }
  return { proposals, issues };
}

export function workspaceProposalHash(proposal: WorkspaceProposal): string {
  return workspacePayloadHash(proposal);
}

export function validateWorkspaceAssignmentMarker(
  marker: unknown,
): WorkspaceAssignmentMarker {
  return validateMarker(marker);
}

export const canonicalWorkspaceProposal = canonicalWorkspaceJson;
export const sha256WorkspacePayload = workspacePayloadHash;
