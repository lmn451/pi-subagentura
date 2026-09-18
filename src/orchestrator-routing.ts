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
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { withInteractiveStateLock } from "./artifact";
import {
  getInteractivePaneLivenessAsync,
  type InteractiveSubagentState,
  type InteractiveSubagentStatus,
} from "./interactive-tmux";
import type { PaneLiveness } from "./multiplexer";

export const ORCHESTRATOR_ROUTING_SCHEMA_VERSION = 1;
export const ORCHESTRATOR_ROUTING_AUTHORITY_SCHEMA_VERSION = 1;
export const ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE =
  "orchestratorv2-routing-authority";
export const MAX_ORCHESTRATOR_ROUTING_RECORDS = 128;
export const MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_ORCHESTRATOR_ROUTING_ALIASES = 16;
export const MAX_ORCHESTRATOR_ROUTING_ALIAS_BYTES = 256;
export const MAX_ORCHESTRATOR_ROUTING_FILE_BYTES = 1024 * 1024;
export const MAX_ORCHESTRATOR_PROJECT_PATH_BYTES = 4 * 1024;
export const MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS = 128;
export const MAX_ORCHESTRATOR_LIVENESS_CONCURRENCY = 8;
export const MAX_ORCHESTRATOR_LIVENESS_DEADLINE_MS = 5_000;
export const MAX_ORCHESTRATOR_AGENT_NAME_BYTES = 512;
export const MAX_ORCHESTRATOR_TASK_PREVIEW_BYTES = 512;

const CHILD_ID = /^[a-f0-9]{8}(?:[a-f0-9]{8})?$/;
const PROJECT_ID = /^[a-f0-9]{64}$/;
const MAX_UPDATED_AT_BYTES = 64;

// Single parse boundary for untrusted routing records. Structure comes from
// the schema; byte bounds stay here because they are not expressible in the
// schema keywords Pi's TypeBox build projects.
const RoutingRecordSchema = Type.Object({
  childId: Type.String({ pattern: CHILD_ID.source }),
  description: Type.String(),
  aliases: Type.Optional(Type.Array(Type.String())),
  provenance: Type.Union([
    Type.Literal("user"),
    Type.Literal("orchestratorv2"),
  ]),
  updatedAt: Type.String(),
});

type RoutingRecord = Static<typeof RoutingRecordSchema>;

interface TypeBoxParseError {
  instancePath?: string;
  message?: string;
}

const RECORD_FIELD_PARSE_ERRORS: Record<string, string> = {
  "/childId": "childId must be 8 or 16 lowercase hexadecimal characters",
  "/provenance": 'provenance must be "user" or "orchestratorv2"',
};

function firstParseError(errors: readonly unknown[]): string | undefined {
  const error = errors[0] as TypeBoxParseError | undefined;
  if (!error) return undefined;
  const fieldMessage = error.instancePath
    ? RECORD_FIELD_PARSE_ERRORS[error.instancePath]
    : undefined;
  return (
    fieldMessage ?? `${error.instancePath ?? ""} ${error.message ?? ""}`.trim()
  );
}

export function isValidOrchestratorChildId(value: unknown): value is string {
  return typeof value === "string" && CHILD_ID.test(value);
}

const OVERLAY_KEYS = new Set(["schemaVersion", "projectId", "records"]);
const RECORD_KEYS = new Set([
  "childId",
  "description",
  "aliases",
  "provenance",
  "updatedAt",
]);
const ROUTING_AUTHORITY_KEYS = new Set([
  "schemaVersion",
  "projectId",
  "record",
]);

export type OrchestratorRoutingProvenance = "user" | "orchestratorv2";

export interface OrchestratorRoutingEntry {
  childId: string;
  description: string;
  aliases?: string[];
  provenance: OrchestratorRoutingProvenance;
  updatedAt: string;
}

export interface OrchestratorRoutingEntryInput {
  childId: string;
  description: string;
  aliases?: string[];
  provenance: OrchestratorRoutingProvenance;
  updatedAt?: string;
}

/**
 * Parent-session authority is an append-only custom session entry. The
 * project-local JSON file is only an advisory cache; the latest valid
 * authority record for each child is the complete trusted routing state.
 */
export interface OrchestratorRoutingAuthorityEntry {
  schemaVersion: typeof ORCHESTRATOR_ROUTING_AUTHORITY_SCHEMA_VERSION;
  projectId: string;
  record: OrchestratorRoutingEntry;
}

export interface OrchestratorRoutingUpsertOptions {
  expectedEntry?: OrchestratorRoutingEntry;
  authorityEntries?: readonly unknown[];
}

export interface OrchestratorRoutingSaveOptions {
  authorityEntries?: readonly unknown[];
}

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
  | "runtime_status_unknown"
  | "workflow_owned"
  | "routing_metadata_missing"
  | "routing_metadata_untrusted";

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
  attachable: boolean;
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
  "missing" | "empty" | "loaded" | "malformed" | "unsupported" | "unreadable";

export interface OrchestratorRoutingMetadataView {
  status: "missing" | "empty" | "loaded";
  entries: OrchestratorRoutingEntry[];
}

export interface OrchestratorAgentRegistryView extends OrchestratorAgentProjection {
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

/** Delete the project-local routing cache for an intentional fresh session. */
export function deleteOrchestratorRoutingFile(cwd: string): void {
  withInteractiveStateLock(cwd, () => {
    try {
      rmSync(orchestratorRoutingFilePath(cwd), { force: true });
    } catch {
      /* Best effort, matching interactive state cleanup semantics. */
    }
  });
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
type RoutingAuthorityAppender = {
  appendEntry?: (customType: string, data: unknown) => unknown;
};

export function createOrchestratorRoutingAuthorityEntry(
  cwd: string,
  record: OrchestratorRoutingEntry,
): OrchestratorRoutingAuthorityEntry {
  const validated = validateEntry(record);
  return {
    schemaVersion: ORCHESTRATOR_ROUTING_AUTHORITY_SCHEMA_VERSION,
    projectId: routingProjectId(cwd),
    record: cloneEntry(validated),
  };
}

/**
 * Append a durable parent-session authority record after its project-file
 * cache write succeeds. Older Pi mocks may not expose appendEntry; those
 * callers retain the legacy non-v2 behavior.
 */
export function appendOrchestratorRoutingAuthorityEntry(
  pi: RoutingAuthorityAppender,
  cwd: string,
  record: OrchestratorRoutingEntry,
): void {
  if (typeof pi.appendEntry !== "function") return;
  pi.appendEntry(
    ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE,
    createOrchestratorRoutingAuthorityEntry(cwd, record),
  );
}

/**
 * Parse one raw Pi custom entry. A custom entry with this type is never
 * accepted partially: the version, canonical project identity, and complete
 * routing record must all validate.
 */
export function parseOrchestratorRoutingAuthorityEntry(
  value: unknown,
  expectedProjectId: string,
): OrchestratorRoutingEntry | undefined {
  if (!isRecord(value) || value.type !== "custom") return undefined;
  if (value.customType !== ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE) {
    return undefined;
  }
  const data = value.data;
  if (!isRecord(data))
    throw new Error("routing authority data must be an object");
  rejectUnknownKeys(data, ROUTING_AUTHORITY_KEYS, "routing authority");
  if (data.schemaVersion !== ORCHESTRATOR_ROUTING_AUTHORITY_SCHEMA_VERSION) {
    throw new Error("routing authority schemaVersion is missing or malformed");
  }
  validateProjectId(data.projectId, expectedProjectId);
  return cloneEntry(validateEntry(data.record));
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
  options?: OrchestratorRoutingSaveOptions,
): OrchestratorRoutingOverlay {
  const now = new Date().toISOString();
  const incoming = validateIncomingEntries(entries, now);
  return withInteractiveStateLock(cwd, () => {
    const current = overlayForWrite(
      cwd,
      loadOrchestratorRoutingOverlay(cwd),
      options?.authorityEntries,
    );
    assertRoutingRecordCapacity(current.records, incoming);
    const records = new Map(
      current.records.map((record) => [record.childId, record]),
    );
    for (const record of incoming) records.set(record.childId, record);
    const overlay = validateOverlay(
      {
        schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
        projectId: current.projectId,
        records: [...records.values()],
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
  options?: OrchestratorRoutingUpsertOptions,
): OrchestratorRoutingOverlay {
  const now = new Date().toISOString();
  const incoming = validateIncomingEntries([entry], now);
  return withInteractiveStateLock(cwd, () => {
    const current = overlayForWrite(
      cwd,
      loadOrchestratorRoutingOverlay(cwd),
      options?.authorityEntries,
    );
    if (options?.expectedEntry !== undefined || options !== undefined) {
      const currentEntry = current.records.find(
        (record) => record.childId === incoming[0]!.childId,
      );
      if (!sameRoutingEntry(currentEntry, options?.expectedEntry)) {
        throw new Error(
          "routing metadata changed after confirmation was requested",
        );
      }
    }
    assertRoutingRecordCapacity(current.records, incoming);
    const records = new Map(
      current.records.map((record) => [record.childId, record]),
    );
    records.set(incoming[0]!.childId, incoming[0]!);
    const overlay = validateOverlay(
      {
        schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
        projectId: current.projectId,
        records: [...records.values()],
      },
      current.projectId,
    );
    writeOverlayUnlocked(cwd, overlay);
    return overlay;
  });
}

function sameRoutingEntry(
  left: OrchestratorRoutingEntry | undefined,
  right: OrchestratorRoutingEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.childId === right.childId &&
    left.description === right.description &&
    left.provenance === right.provenance &&
    left.updatedAt === right.updatedAt &&
    JSON.stringify(left.aliases) === JSON.stringify(right.aliases)
  );
}
interface TrustedAndUntrustedRoutingRecords {
  trusted: OrchestratorRoutingEntry[];
  untrusted: OrchestratorRoutingEntry[];
}

function latestAuthorityByChild(
  cwd: string,
  authorityEntries: readonly unknown[],
): Map<string, OrchestratorRoutingEntry | undefined> {
  const expectedProjectId = routingProjectId(cwd);
  const latest = new Map<string, OrchestratorRoutingEntry | undefined>();
  for (const value of authorityEntries) {
    if (!isRecord(value) || value.type !== "custom") continue;
    if (value.customType !== ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE) {
      continue;
    }
    const childId = authorityChildId(value);
    try {
      const record = parseOrchestratorRoutingAuthorityEntry(
        value,
        expectedProjectId,
      );
      if (record !== undefined) latest.set(record.childId, record);
      else if (childId !== undefined) latest.set(childId, undefined);
    } catch {
      // A malformed authority entry is not evidence of authority. If its
      // child id is recoverable, it also supersedes an older valid entry.
      if (childId !== undefined) latest.set(childId, undefined);
    }
  }
  return latest;
}
function authoritativeRecords(
  cwd: string,
  authorityEntries: readonly unknown[],
): OrchestratorRoutingEntry[] {
  return [...latestAuthorityByChild(cwd, authorityEntries).values()]
    .filter(
      (record): record is OrchestratorRoutingEntry => record !== undefined,
    )
    .map(cloneEntry);
}

function authorityChildId(value: JsonRecord): string | undefined {
  const data = value.data;
  if (!isRecord(data)) return undefined;
  const record = data.record;
  if (isRecord(record) && isValidOrchestratorChildId(record.childId)) {
    return record.childId;
  }
  return isValidOrchestratorChildId(data.childId) ? data.childId : undefined;
}

function trustedAndUntrustedRecords(
  cwd: string,
  records: readonly OrchestratorRoutingEntry[],
  authorityEntries: readonly unknown[] | undefined,
): TrustedAndUntrustedRoutingRecords {
  const resolvedAuthorities = authorityEntries;
  if (resolvedAuthorities === undefined) {
    return {
      trusted: records.map(cloneEntry),
      untrusted: [],
    };
  }
  const authorities = latestAuthorityByChild(cwd, resolvedAuthorities);
  const trusted = [...authorities.values()]
    .filter(
      (record): record is OrchestratorRoutingEntry => record !== undefined,
    )
    .map(cloneEntry);
  const authorityIds = new Set(authorities.keys());
  const untrusted = records
    .filter((record) => !authorityIds.has(record.childId))
    .map(cloneEntry);
  return { trusted, untrusted };
}
export function validateOrchestratorRoutingEntryInput(
  entry: OrchestratorRoutingEntryInput,
): void {
  validateIncomingEntries([entry], new Date().toISOString());
}

export function loadOrchestratorRoutingMetadata(
  cwd: string,
  authorityEntries?: readonly unknown[],
): OrchestratorRoutingMetadataView {
  const result = loadOrchestratorRoutingOverlay(cwd);
  const resolvedAuthorities = authorityEntries;
  if (resolvedAuthorities !== undefined) {
    const records = authoritativeRecords(cwd, resolvedAuthorities);
    return {
      status:
        records.length === 0
          ? result.status === "missing"
            ? "missing"
            : "empty"
          : "loaded",
      entries: records,
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
  throw routingLoadError(result);
}

export function listOrchestratorRoutingEntries(
  cwd: string,
  authorityEntries?: readonly unknown[],
): OrchestratorRoutingEntry[] {
  return loadOrchestratorRoutingMetadata(cwd, authorityEntries).entries;
}

interface OrchestratorRoutingProjectionMetadata {
  status: OrchestratorRoutingMetadataStatus;
  entries: OrchestratorRoutingEntry[];
  untrustedEntries: OrchestratorRoutingEntry[];
  error?: string;
}

function loadOrchestratorRoutingProjectionMetadata(
  cwd: string,
  authorityEntries?: readonly unknown[],
): OrchestratorRoutingProjectionMetadata {
  let result: OrchestratorRoutingLoadResult;
  try {
    result = loadOrchestratorRoutingOverlay(cwd);
  } catch (error) {
    return {
      status: "unreadable",
      entries: [],
      untrustedEntries: [],
      error: errorMessage(error),
    };
  }
  const resolvedAuthorities = authorityEntries;
  if (resolvedAuthorities !== undefined) {
    const records = authoritativeRecords(cwd, resolvedAuthorities);
    const cacheRecords =
      result.status === "empty" || result.status === "loaded"
        ? result.overlay.records
        : [];
    const diagnostics = trustedAndUntrustedRecords(
      cwd,
      cacheRecords,
      resolvedAuthorities,
    );
    return {
      status: result.status,
      entries: records,
      untrustedEntries: diagnostics.untrusted,
      ...(result.status === "malformed" ||
      result.status === "unsupported" ||
      result.status === "unreadable"
        ? { error: result.error }
        : {}),
    };
  }
  if (result.status === "missing") {
    return { status: result.status, entries: [], untrustedEntries: [] };
  }
  if (result.status === "empty" || result.status === "loaded") {
    return {
      status: result.status,
      entries: result.overlay.records.map(cloneEntry),
      untrustedEntries: [],
    };
  }
  return {
    status: result.status,
    entries: [],
    untrustedEntries: [],
    error: result.error,
  };
}

export async function loadOrchestratorAgentRegistryView(
  cwd: string,
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
  options: {
    signal?: AbortSignal;
    livenessDeadlineMs?: number;
    authorityEntries?: readonly unknown[];
  } = {},
): Promise<OrchestratorAgentRegistryView> {
  const metadata = loadOrchestratorRoutingProjectionMetadata(
    cwd,
    options.authorityEntries,
  );
  const projection = await buildOrchestratorAgentProjection(
    metadata.entries,
    interactiveStates,
    {
      ...options,
      untrustedEntries: metadata.untrustedEntries,
    },
  );
  return {
    routingMetadataStatus: metadata.status,
    ...(metadata.error === undefined
      ? {}
      : { routingMetadataError: metadata.error }),
    ...projection,
  };
}

export interface OrchestratorAgentProjectionOptions {
  signal?: AbortSignal;
  livenessDeadlineMs?: number;
  untrustedEntries?: readonly OrchestratorRoutingEntry[];
}

export async function buildOrchestratorAgentProjection(
  entries: readonly OrchestratorRoutingEntry[],
  interactiveStates: ReadonlyMap<string, InteractiveSubagentState>,
  options: OrchestratorAgentProjectionOptions = {},
): Promise<OrchestratorAgentProjection> {
  const metadata = new Map(entries.map((entry) => [entry.childId, entry]));
  const untrustedMetadata = new Map(
    (options.untrustedEntries ?? []).map((entry) => [entry.childId, entry]),
  );
  const runtimeIds = [...interactiveStates.keys()].sort();
  const deadlineAt =
    Date.now() +
    Math.max(
      0,
      options.livenessDeadlineMs ?? MAX_ORCHESTRATOR_LIVENESS_DEADLINE_MS,
    );
  const runtimeAgents = await mapWithConcurrency(
    runtimeIds,
    MAX_ORCHESTRATOR_LIVENESS_CONCURRENCY,
    (childId) => {
      const trusted = metadata.get(childId);
      const untrusted = untrustedMetadata.get(childId);
      return projectOrchestratorAgent(
        childId,
        trusted ?? untrusted,
        interactiveStates.get(childId),
        options.signal,
        deadlineAt,
        trusted !== undefined || untrusted === undefined,
      );
    },
  );
  runtimeAgents.sort(compareOrchestratorRuntimeAgents);

  const trustedStaleIds = [...metadata.keys()]
    .filter((childId) => !interactiveStates.has(childId))
    .sort((leftId, rightId) => {
      return compareNewestRoutingEntries(
        metadata.get(leftId)!,
        metadata.get(rightId)!,
      );
    });
  const untrustedStaleIds = [...untrustedMetadata.keys()]
    .filter(
      (childId) => !interactiveStates.has(childId) && !metadata.has(childId),
    )
    .sort((leftId, rightId) => {
      return compareNewestRoutingEntries(
        untrustedMetadata.get(leftId)!,
        untrustedMetadata.get(rightId)!,
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
  const selectedStaleIds = [...trustedStaleIds, ...untrustedStaleIds].slice(
    0,
    staleSlots,
  );
  const staleAgents = await Promise.all(
    selectedStaleIds.map((childId) => {
      const trusted = metadata.get(childId);
      const untrusted = untrustedMetadata.get(childId);
      return projectOrchestratorAgent(
        childId,
        trusted ?? untrusted,
        undefined,
        undefined,
        Number.POSITIVE_INFINITY,
        trusted !== undefined || untrusted === undefined,
      );
    }),
  );
  const agents = [...selectedRuntimeAgents, ...staleAgents];
  const total =
    runtimeAgents.length + trustedStaleIds.length + untrustedStaleIds.length;
  return {
    agents,
    total,
    omitted: total - agents.length,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  const workerCount = Math.min(values.length, Math.max(1, concurrency));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await project(values[index]!);
      }
    }),
  );
  return results;
}

function compareOrchestratorRuntimeAgents(
  left: OrchestratorAgentView,
  right: OrchestratorAgentView,
): number {
  if (left.attachable !== right.attachable) return left.attachable ? -1 : 1;
  if (left.actionable !== right.actionable) return left.actionable ? -1 : 1;
  return left.childId.localeCompare(right.childId);
}

async function projectOrchestratorAgent(
  childId: string,
  metadata: OrchestratorRoutingEntry | undefined,
  state: InteractiveSubagentState | undefined,
  signal?: AbortSignal,
  deadlineAt = Number.POSITIVE_INFINITY,
  metadataTrusted = true,
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
      attachable: false,
      actionable: false,
      reason:
        metadata !== undefined && !metadataTrusted
          ? "routing_metadata_untrusted"
          : "runtime_missing",
    };
  }

  const liveness = await probeInteractiveLiveness(state, signal, deadlineAt);
  const attachable =
    isValidOrchestratorChildId(childId) && isRuntimeActionable(state, liveness);
  const actionable = attachable && metadata !== undefined && metadataTrusted;
  const reason =
    metadata !== undefined && !metadataTrusted
      ? "routing_metadata_untrusted"
      : (orchestratorAgentReason(state, liveness) ??
        (metadata === undefined ? "routing_metadata_missing" : undefined));
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
    attachable,
    actionable,
    ...(reason === undefined ? {} : { reason }),
    ...(attachable
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
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<PaneLiveness> {
  if (signal?.aborted || Date.now() >= deadlineAt) return "unknown";
  return await new Promise<PaneLiveness>((resolve) => {
    let settled = false;
    const finish = (liveness: PaneLiveness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(liveness);
    };
    const abort = () => finish("unknown");
    const timer = setTimeout(
      () => finish("unknown"),
      Math.max(0, deadlineAt - Date.now()),
    );
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    void getInteractivePaneLivenessAsync(state).then(
      (liveness) => finish(liveness),
      () => finish("unknown"),
    );
  });
}

function isRuntimeActionable(
  state: InteractiveSubagentState,
  liveness: PaneLiveness,
): boolean {
  return (
    liveness === "alive" &&
    (state.status === "running" || state.status === "idle") &&
    !isWorkflowOwnedRuntimeBlocked(state)
  );
}

function orchestratorAgentReason(
  state: InteractiveSubagentState,
  liveness: PaneLiveness,
): OrchestratorAgentReason | undefined {
  if (liveness === "dead") return "pane_dead";
  if (state.status === "cancelled") return "runtime_cancelled";
  if (state.status === "exited") return "runtime_exited";
  if (liveness === "unknown") return "pane_liveness_unknown";
  if (state.status === "unknown") return "runtime_status_unknown";
  if (isWorkflowOwnedRuntimeBlocked(state)) return "workflow_owned";
  return undefined;
}

function isWorkflowOwnedRuntimeBlocked(
  state: InteractiveSubagentState,
): boolean {
  return (
    state.completionOwner === "workflow" &&
    (!state.workflowResultConsumed || state.status !== "idle")
  );
}

function boundedPreview(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const suffix = Buffer.from("…", "utf8");
  let end = maxBytes - suffix.length;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8").trimEnd()}…`;
}

function assertRoutingRecordCapacity(
  current: readonly OrchestratorRoutingEntry[],
  incoming: readonly OrchestratorRoutingEntry[],
): void {
  const existingIds = new Set(current.map((record) => record.childId));
  const addedRecords = incoming.filter(
    (record) => !existingIds.has(record.childId),
  ).length;
  if (current.length + addedRecords > MAX_ORCHESTRATOR_ROUTING_RECORDS) {
    throw new Error(
      `routing record count exceeds ${MAX_ORCHESTRATOR_ROUTING_RECORDS}`,
    );
  }
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
  return Date.parse(entry.updatedAt);
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

function validateProjectId(value: unknown, expected: string): string {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) {
    throw new Error("projectId must be a sha256 hex digest");
  }
  if (value !== expected) {
    throw new Error("routing metadata projectId does not match this project");
  }
  return value;
}

function validateEntry(value: unknown): OrchestratorRoutingEntry {
  // Parse untrusted input once into a typed record; refinements below only
  // enforce byte bounds the JSON Schema keywords cannot express.
  if (!isRecord(value)) throw new Error("routing record must be an object");
  rejectUnknownKeys(value, RECORD_KEYS, "routing record");
  if (!Value.Check(RoutingRecordSchema, value)) {
    throw new Error(
      firstParseError(Value.Errors(RoutingRecordSchema, value)) ??
        "routing record is malformed",
    );
  }
  const parsed = value as RoutingRecord;
  const description = boundedText(
    parsed.description,
    "description",
    MAX_ORCHESTRATOR_ROUTING_DESCRIPTION_BYTES,
  );
  let aliases: string[] | undefined;
  if (parsed.aliases !== undefined) {
    if (parsed.aliases.length > MAX_ORCHESTRATOR_ROUTING_ALIASES) {
      throw new Error(
        `aliases exceeds ${MAX_ORCHESTRATOR_ROUTING_ALIASES} entries`,
      );
    }
    const seen = new Set<string>();
    aliases = parsed.aliases.map((alias) => {
      const validated = boundedText(
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
  if (
    Buffer.byteLength(parsed.updatedAt, "utf8") > MAX_UPDATED_AT_BYTES ||
    Number.isNaN(Date.parse(parsed.updatedAt))
  ) {
    throw new Error("updatedAt must be a bounded ISO date string");
  }
  return {
    childId: parsed.childId,
    description,
    ...(aliases === undefined ? {} : { aliases }),
    provenance: parsed.provenance,
    updatedAt: parsed.updatedAt,
  };
}

function boundedText(value: string, label: string, maxBytes: number): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function overlayForWrite(
  cwd: string,
  result: OrchestratorRoutingLoadResult,
  authorityEntries?: readonly unknown[],
): OrchestratorRoutingOverlay {
  const resolvedAuthorities = authorityEntries;
  if (resolvedAuthorities !== undefined) {
    return {
      schemaVersion: ORCHESTRATOR_ROUTING_SCHEMA_VERSION,
      projectId: routingProjectId(cwd),
      records: authoritativeRecords(cwd, resolvedAuthorities),
    };
  }
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
