import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withInteractiveStateLock } from "./artifact";
import {
  getInteractivePaneLivenessAsync,
  type InteractiveSubagentState,
  type InteractiveSubagentStatus,
} from "./interactive-tmux";
import type { PaneLiveness } from "./multiplexer";

export const ORCHESTRATOR_ROUTING_SCHEMA_VERSION = 1;
export const MAX_ORCHESTRATOR_ROUTING_RECORDS = 128;
export const MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_ORCHESTRATOR_ROUTING_ALIASES = 16;
export const MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES = 256;
export const MAX_ORCHESTRATOR_ROUTING_FILE_BYTES = 1024 * 1024;
export const MAX_ORCHESTRATOR_PROJECT_PATH_BYTES = 4 * 1024;
export const MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS = 128;
export const MAX_ORCHESTRATOR_AGENT_NAME_BYTES = 512;
export const MAX_ORCHESTRATOR_TASK_PREVIEW_BYTES = 512;

const CHILD_ID = /^[a-f0-9]{16}$/;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const MAX_UPDATED_AT_BYTES = 64;
const OVERLAY_KEYS = new Set(["schemaVersion", "projectId", "records"]);
const RECORD_KEYS = new Set([
  "childId",
  "description",
  "aliases",
  "provenance",
  "updatedAt",
]);

export type OrchestratorRoutingProvenance = "user" | "luna";

export interface OrchestratorRoutingEntry {
  childId: string;
  description: string;
  aliases?: string[];
  provenance?: OrchestratorRoutingProvenance;
  updatedAt?: string;
}

export type OrchestratorRoutingEntryInput = OrchestratorRoutingEntry;

export interface OrchestratorRoutingOverlay {
  schemaVersion: typeof ORCHESTRATOR_ROUTING_SCHEMA_VERSION;
  projectId: string;
  records: OrchestratorRoutingEntry[];
}

export type OrchestratorAgentReason =
  | "runtime_missing"
  | "pane_dead"
  | "pane_liveness_unknown"
  | "runtime_cancelled"
  | "runtime_exited"
  | "runtime_status_unknown";

export interface OrchestratorAgentView {
  childId: string;
  name?: string;
  description?: string;
  aliases?: string[];
  provenance?: OrchestratorRoutingProvenance;
  updatedAt?: string;
  taskPreview?: string;
  status: InteractiveSubagentStatus;
  liveness: PaneLiveness;
  stale: boolean;
  actionable: boolean;
  reason?: OrchestratorAgentReason;
  attachCommand?: string;
  focusCommand?: string;
  artifactDir?: string;
  sessionFile?: string;
}

export interface OrchestratorAgentProjection {
  agents: OrchestratorAgentView[];
  total: number;
  omitted: number;
}

export type OrchestratorRoutingMetadataStatus =
  | "missing"
  | "empty"
  | "loaded"
  | "malformed"
  | "unsupported"
  | "unreadable";

export interface OrchestratorRoutingMetadataView {
  status: "missing" | "empty" | "loaded";
  entries: OrchestratorRoutingEntry[];
}

export interface OrchestratorAgentRegistryView
  extends OrchestratorAgentProjection {
  routingMetadataStatus: OrchestratorRoutingMetadataStatus;
  routingMetadataError?: string;
}

export type OrchestratorRoutingLoadResult =
  | { status: "missing" }
  | { status: "empty"; overlay: OrchestratorRoutingOverlay }
  | { status: "loaded"; overlay: OrchestratorRoutingOverlay }
  | { status: "malformed"; error: string }
  | { status: "unsupported"; schemaVersion: number; error: string }
  | { status: "unreadable"; error: string };

type RoutingFileReadResult =
  | { status: "missing" }
  | { status: "content"; content: string }
  | { status: "too-large"; bytes: number }
  | { status: "unreadable"; error: string };

type JsonRecord = Record<string, unknown>;

export function orchestratorRoutingFilePath(cwd: string): string {
  return join(cwd, ".pi", "subagentura-routing.json");
}

export function routingProjectId(cwd: string): string {
  if (
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    Buffer.byteLength(cwd, "utf8") > MAX_ORCHESTRATOR_PROJECT_PATH_BYTES
  ) {
    throw new Error("project cwd must be a non-empty bounded path");
  }
  const canonicalCwd = realpathSync(cwd);
  return createHash("sha256")
    .update(`pi-subagentura-routing\0${canonicalCwd}`)
    .digest("hex");
}

export function loadOrchestratorRoutingOverlay(
  cwd: string,
): OrchestratorRoutingLoadResult {
  const file = orchestratorRoutingFilePath(cwd);
  const readResult = readRoutingFile(file);
  if (readResult.status === "missing") return { status: "missing" };
  if (readResult.status === "unreadable") return readResult;
  if (readResult.status === "too-large") {
    return {
      status: "malformed",
      error: `routing metadata exceeds byte limit: ${readResult.bytes} bytes`,
    };
  }

  const content = readResult.content;
  const expectedProjectId = routingProjectId(cwd);
  if (content.trim().length === 0) {
    return { status: "empty", overlay: emptyOverlay(expectedProjectId) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { status: "malformed", error: errorMessage(error) };
  }
  if (!isRecord(parsed)) {
    return {
      status: "malformed",
      error: "routing metadata must be an object",
    };
  }

  const schemaVersion = parsed.schemaVersion;
  if (
    typeof schemaVersion === "number" &&
    Number.isSafeInteger(schemaVersion) &&
    schemaVersion !== ORCHESTRATOR_ROUTING_SCHEMA_VERSION
  ) {
    return {
      status: "unsupported",
      schemaVersion,
      error: `unsupported routing metadata schemaVersion: ${schemaVersion}`,
    };
  }

  try {
    const overlay = validateOverlay(parsed, expectedProjectId);
    return {
      status: overlay.records.length === 0 ? "empty" : "loaded",
      overlay,
    };
  } catch (error) {
    return { status: "malformed", error: errorMessage(error) };
  }
}

export function saveOrchestratorRoutingEntries(
  cwd: string,
  entries: readonly OrchestratorRoutingEntryInput[],
): OrchestratorRoutingOverlay {
  const now = new Date().toISOString();
  const incoming = validateIncomingEntries(entries, now);
  return withInteractiveStateLock(cwd, () => {
    const current = overlayForWrite(cwd, loadOrchestratorRoutingOverlay(cwd));
    const records = new Map(
      current.records.map((record) => [record.childId, record]),
    );
    for (const record of incoming) records.set(record.childId, record);
    const boundedRecords = boundRoutingRecords(records, incoming);
    const overlay = validateOverlay(
      {
        schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
        projectId: current.projectId,
        records: boundedRecords,
      },
      current.projectId,
    );
    writeOverlayUnlocked(cwd, overlay);
    return overlay;
  });
}

export function upsertOrchestratorRoutingEntry(
  cwd: string,
  entry: OrchestratorRoutingEntryInput,
): OrchestratorRoutingOverlay {
  return saveOrchestratorRoutingEntries(cwd, [entry]);
}

export function listOrchestratorRoutingEntries(
  cwd: string,
): OrchestratorRoutingEntry[] {
  return loadOrchestratorRoutingMetadata(cwd).entries;
}

export function loadOrchestratorRoutingMetadata(
  cwd: string,
): OrchestratorRoutingMetadataView {
  const result = loadOrchestratorRoutingOverlay(cwd);
  if (result.status === "missing") {
    return { status: result.status, entries: [] };
  }
  if (result.status === "empty" || result.status === "loaded") {
    return {
      status: result.status,
      entries: result.overlay.records.map(cloneEntry),
    };
  }
  throw routingLoadError(result);
}

interface OrchestratorRoutingProjectionMetadata {
  status: OrchestratorRoutingMetadataStatus;
  entries: OrchestratorRoutingEntry[];
  error?: string;
}

function loadOrchestratorRoutingProjectionMetadata(
  cwd: string,
): OrchestratorRoutingProjectionMetadata {
  let result: OrchestratorRoutingLoadResult;
  try {
    result = loadOrchestratorRoutingOverlay(cwd);
  } catch (error) {
    return {
      status: "unreadable",
      entries: [],
      error: errorMessage(error),
    };
  }
  if (result.status === "missing") {
    return { status: result.status, entries: [] };
  }
  if (result.status === "empty" || result.status === "loaded") {
    return {
      status: result.status,
      entries: result.overlay.records.map(cloneEntry),
    };
  }
  return {
    status: result.status,
    entries: [],
    error: result.error,
  };
}

export async function loadOrchestratorAgentRegistryView(
  cwd: string,
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
): Promise<OrchestratorAgentRegistryView> {
  const metadata = loadOrchestratorRoutingProjectionMetadata(cwd);
  const projection = await buildOrchestratorAgentProjection(
    metadata.entries,
    interactiveStates,
  );
  return {
    routingMetadataStatus: metadata.status,
    ...(metadata.error === undefined
      ? {}
      : { routingMetadataError: metadata.error }),
    ...projection,
  };
}

export async function buildOrchestratorAgentProjection(
  entries: readonly OrchestratorRoutingEntry[],
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
): Promise<OrchestratorAgentProjection> {
  const metadata = new Map(entries.map((entry) => [entry.childId, entry]));
  const runtimeIds = [...interactiveStates.keys()].sort();
  const runtimeAgents = await Promise.all(
    runtimeIds.map((childId) => {
      return projectOrchestratorAgent(
        childId,
        metadata.get(childId),
        interactiveStates.get(childId),
      );
    }),
  );
  runtimeAgents.sort(compareOrchestratorRuntimeAgents);

  const staleMetadataIds = [...metadata.keys()]
    .filter((childId) => !interactiveStates.has(childId))
    .sort((leftId, rightId) => {
      return compareNewestRoutingEntries(
        metadata.get(leftId)!,
        metadata.get(rightId)!,
      );
    });
  const selectedRuntimeAgents = runtimeAgents.slice(
    0,
    MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS,
  );
  const staleSlots = Math.max(
    0,
    MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS - selectedRuntimeAgents.length,
  );
  const selectedStaleIds = staleMetadataIds.slice(0, staleSlots);
  const staleAgents = await Promise.all(
    selectedStaleIds.map((childId) => {
      return projectOrchestratorAgent(childId, metadata.get(childId), undefined);
    }),
  );
  const agents = [...selectedRuntimeAgents, ...staleAgents];
  const total = runtimeAgents.length + staleMetadataIds.length;
  return {
    agents,
    total,
    omitted: total - agents.length,
  };
}

function compareOrchestratorRuntimeAgents(
  left: OrchestratorAgentView,
  right: OrchestratorAgentView,
): number {
  if (left.actionable !== right.actionable) return left.actionable ? -1 : 1;
  return left.childId.localeCompare(right.childId);
}

async function projectOrchestratorAgent(
  childId: string,
  metadata: OrchestratorRoutingEntry | undefined,
  state: InteractiveSubagentState | undefined,
): Promise<OrchestratorAgentView> {
  const routingFields = metadata
    ? {
        description: metadata.description,
        ...(metadata.aliases === undefined
          ? {}
          : { aliases: [...metadata.aliases] }),
        ...(metadata.provenance === undefined
          ? {}
          : { provenance: metadata.provenance }),
        ...(metadata.updatedAt === undefined
          ? {}
          : { updatedAt: metadata.updatedAt }),
      }
    : {};
  if (!state) {
    return {
      childId,
      ...routingFields,
      status: "unknown",
      liveness: "unknown",
      stale: true,
      actionable: false,
      reason: "runtime_missing",
    };
  }

  const liveness = await probeInteractiveLiveness(state);
  const actionable = isRuntimeActionable(state.status, liveness);
  const reason = orchestratorAgentReason(state.status, liveness);
  return {
    childId,
    name: boundedPreview(state.name, MAX_ORCHESTRATOR_AGENT_NAME_BYTES),
    ...routingFields,
    taskPreview: boundedPreview(
      state.task.replace(/\s+/g, " ").trim(),
      MAX_ORCHESTRATOR_TASK_PREVIEW_BYTES,
    ),
    status: state.status,
    liveness,
    stale: false,
    actionable,
    ...(reason === undefined ? {} : { reason }),
    ...(actionable
      ? {
          attachCommand: state.attachCommand,
          focusCommand: state.selectPaneCommand,
        }
      : {}),
    artifactDir: state.artifactDir,
    sessionFile: state.sessionFile,
  };
}

async function probeInteractiveLiveness(
  state: InteractiveSubagentState,
): Promise<PaneLiveness> {
  try {
    return await getInteractivePaneLivenessAsync(state);
  } catch {
    /* A failed backend probe is represented explicitly as unknown liveness. */
    return "unknown";
  }
}

function isRuntimeActionable(
  status: InteractiveSubagentStatus,
  liveness: PaneLiveness,
): boolean {
  return (
    liveness !== "dead" &&
    (status === "running" || status === "idle" || status === "unknown")
  );
}

function orchestratorAgentReason(
  status: InteractiveSubagentStatus,
  liveness: PaneLiveness,
): OrchestratorAgentReason | undefined {
  if (liveness === "dead") return "pane_dead";
  if (status === "cancelled") return "runtime_cancelled";
  if (status === "exited") return "runtime_exited";
  if (liveness === "unknown") return "pane_liveness_unknown";
  if (status === "unknown") return "runtime_status_unknown";
  return undefined;
}

function boundedPreview(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const suffix = Buffer.from("…", "utf8");
  let end = maxBytes - suffix.length;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8").trimEnd()}…`;
}

function boundRoutingRecords(
  records: Map<string, OrchestratorRoutingEntry>,
  incoming: readonly OrchestratorRoutingEntry[],
): OrchestratorRoutingEntry[] {
  if (records.size <= MAX_ORCHESTRATOR_ROUTING_RECORDS) {
    return [...records.values()];
  }

  const protectedIds = new Set(incoming.map((record) => record.childId));
  const evictionCandidates = [...records.values()]
    .filter((record) => !protectedIds.has(record.childId))
    .sort(compareOldestRoutingEntries);
  for (const candidate of evictionCandidates) {
    if (records.size <= MAX_ORCHESTRATOR_ROUTING_RECORDS) break;
    records.delete(candidate.childId);
  }
  if (records.size > MAX_ORCHESTRATOR_ROUTING_RECORDS) {
    throw new Error(
      `routing record count exceeds ${MAX_ORCHESTRATOR_ROUTING_RECORDS}`,
    );
  }
  return [...records.values()];
}

function compareOldestRoutingEntries(
  left: OrchestratorRoutingEntry,
  right: OrchestratorRoutingEntry,
): number {
  const timeDifference =
    routingEntryTimestamp(left) - routingEntryTimestamp(right);
  if (timeDifference !== 0) return timeDifference;
  return left.childId.localeCompare(right.childId);
}

function compareNewestRoutingEntries(
  left: OrchestratorRoutingEntry,
  right: OrchestratorRoutingEntry,
): number {
  return compareOldestRoutingEntries(right, left);
}

function routingEntryTimestamp(entry: OrchestratorRoutingEntry): number {
  return entry.updatedAt === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(entry.updatedAt);
}

function readRoutingFile(file: string): RoutingFileReadResult {
  let pathStat;
  try {
    pathStat = lstatSync(file);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { status: "missing" };
    return { status: "unreadable", error: errorMessage(error) };
  }
  if (!pathStat.isFile()) {
    return {
      status: "unreadable",
      error: "routing metadata path is not a regular file",
    };
  }
  if (pathStat.size > MAX_ORCHESTRATOR_ROUTING_FILE_BYTES) {
    return { status: "too-large", bytes: pathStat.size };
  }

  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    return { status: "unreadable", error: errorMessage(error) };
  }
  try {
    const openedStat = fstatSync(fd);
    if (!openedStat.isFile()) {
      return {
        status: "unreadable",
        error: "routing metadata path is not a regular file",
      };
    }
    if (openedStat.size > MAX_ORCHESTRATOR_ROUTING_FILE_BYTES) {
      return { status: "too-large", bytes: openedStat.size };
    }
    return { status: "content", content: readOpenedFile(fd, openedStat.size) };
  } catch (error) {
    return { status: "unreadable", error: errorMessage(error) };
  } finally {
    closeSync(fd);
  }
}

function readOpenedFile(fd: number, size: number): string {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, data, offset, size - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    data.subarray(0, offset),
  );
}

function validateIncomingEntries(
  entries: readonly OrchestratorRoutingEntryInput[],
  now: string,
): OrchestratorRoutingEntry[] {
  if (!Array.isArray(entries)) {
    throw new Error("routing entries must be an array");
  }
  if (entries.length > MAX_ORCHESTRATOR_ROUTING_RECORDS) {
    throw new Error(
      `routing record count exceeds ${MAX_ORCHESTRATOR_ROUTING_RECORDS}`,
    );
  }
  const childIds = new Set<string>();
  const validated = entries.map((entry) => {
    const withTimestamp =
      isRecord(entry) && entry.updatedAt === undefined
        ? { ...entry, updatedAt: now }
        : entry;
    const record = validateEntry(withTimestamp);
    if (childIds.has(record.childId)) {
      throw new Error(`duplicate childId: ${record.childId}`);
    }
    childIds.add(record.childId);
    return record;
  });
  return validated;
}

function validateOverlay(
  value: unknown,
  expectedProjectId: string,
): OrchestratorRoutingOverlay {
  if (!isRecord(value)) throw new Error("routing metadata must be an object");
  rejectUnknownKeys(value, OVERLAY_KEYS, "routing metadata");
  if (value.schemaVersion !== ORCHESTRATOR_ROUTING_SCHEMA_VERSION) {
    throw new Error("routing metadata schemaVersion is missing or malformed");
  }
  const projectId = validateProjectId(value.projectId, expectedProjectId);
  if (!Array.isArray(value.records)) {
    throw new Error("routing metadata records must be an array");
  }
  if (value.records.length > MAX_ORCHESTRATOR_ROUTING_RECORDS) {
    throw new Error(
      `routing record count exceeds ${MAX_ORCHESTRATOR_ROUTING_RECORDS}`,
    );
  }

  const childIds = new Set<string>();
  const records = value.records.map((record) => {
    const validated = validateEntry(record);
    if (childIds.has(validated.childId)) {
      throw new Error(`duplicate childId: ${validated.childId}`);
    }
    childIds.add(validated.childId);
    return validated;
  });
  records.sort((left, right) => left.childId.localeCompare(right.childId));
  return {
    schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
    projectId,
    records,
  };
}

function validateEntry(value: unknown): OrchestratorRoutingEntry {
  if (!isRecord(value)) throw new Error("routing record must be an object");
  rejectUnknownKeys(value, RECORD_KEYS, "routing record");
  const childId = expectChildId(value.childId);
  const description = expectBoundedText(
    value.description,
    "description",
    MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  );
  const aliases = validateAliases(value.aliases);
  const provenance = validateProvenance(value.provenance);
  const updatedAt = validateUpdatedAt(value.updatedAt);
  return {
    childId,
    description,
    ...(aliases === undefined ? {} : { aliases }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function validateAliases(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("aliases must be an array");
  if (value.length > MAX_ORCHESTRATOR_ROUTING_ALIASES) {
    throw new Error(
      `aliases exceeds ${MAX_ORCHESTRATOR_ROUTING_ALIASES} entries`,
    );
  }
  const seen = new Set<string>();
  return value.map((alias) => {
    const validated = expectBoundedText(
      alias,
      "alias",
      MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES,
    );
    if (seen.has(validated)) {
      throw new Error(`duplicate alias: ${validated}`);
    }
    seen.add(validated);
    return validated;
  });
}

function validateProvenance(
  value: unknown,
): OrchestratorRoutingProvenance | undefined {
  if (value === undefined) return undefined;
  if (value !== "user" && value !== "luna") {
    throw new Error('provenance must be "user" or "luna"');
  }
  return value;
}

function validateUpdatedAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_UPDATED_AT_BYTES ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error("updatedAt must be a bounded ISO date string");
  }
  return value;
}

function validateProjectId(value: unknown, expected: string): string {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    throw new Error("projectId must be a sha256 hex digest");
  }
  if (value !== expected) {
    throw new Error("routing metadata projectId does not match this project");
  }
  return value;
}

function expectChildId(value: unknown): string {
  if (typeof value !== "string" || !CHILD_ID.test(value)) {
    throw new Error("childId must be 16 lowercase hexadecimal characters");
  }
  return value;
}

function expectBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function overlayForWrite(
  cwd: string,
  result: OrchestratorRoutingLoadResult,
): OrchestratorRoutingOverlay {
  if (result.status === "missing") return emptyOverlay(routingProjectId(cwd));
  if (result.status === "empty" || result.status === "loaded") {
    return result.overlay;
  }
  throw routingLoadError(result);
}

function routingLoadError(
  result: Extract<
    OrchestratorRoutingLoadResult,
    { status: "malformed" | "unsupported" | "unreadable" }
  >,
): Error {
  if (result.status === "unsupported") {
    return new Error(result.error);
  }
  return new Error(`${result.status} routing metadata: ${result.error}`);
}

function writeOverlayUnlocked(
  cwd: string,
  overlay: OrchestratorRoutingOverlay,
): void {
  const file = orchestratorRoutingFilePath(cwd);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const content = JSON.stringify(overlay, null, 2);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ORCHESTRATOR_ROUTING_FILE_BYTES) {
    throw new Error(`routing metadata exceeds byte limit: ${bytes} bytes`);
  }
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* Preserve the original persistence error if cleanup also fails. */
    }
    throw error;
  }
}

function emptyOverlay(projectId: string): OrchestratorRoutingOverlay {
  return {
    schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
    projectId,
    records: [],
  };
}

function cloneEntry(entry: OrchestratorRoutingEntry): OrchestratorRoutingEntry {
  return {
    ...entry,
    ...(entry.aliases === undefined ? {} : { aliases: [...entry.aliases] }),
  };
}

function rejectUnknownKeys(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label} has unknown field: ${key}`);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}