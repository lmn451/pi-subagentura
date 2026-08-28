import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  promises as fs,
} from "node:fs";
import path from "node:path";

export const LINEAGE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_MANIFEST_BYTES = 16 * 1024;
export const DEFAULT_MAX_STRING_BYTES = 2048;
export const DEFAULT_MAX_TASK_PREVIEW_BYTES = 4096;
export const DEFAULT_MAX_NODES = 256;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_PROJECTION_BYTES = 512 * 1024;

/**
 * How many liveness probes may be in flight at once while projecting.
 *
 * Each probe is a mux subprocess. Awaiting them sequentially made a single
 * overlay refresh cost O(nodes) round-trips, which at 1 Hz meant the overlay
 * permanently ran behind while continuously spawning processes.
 */
export const DEFAULT_STALENESS_CONCURRENCY = 8;

/**
 * Headroom multiplier for how many manifests may be read before the node cap
 * is applied. Reading is cheap (local JSON, bounded by maxProjectionBytes);
 * the headroom lets a live-but-older node displace a newer dead one instead of
 * the read window silently deciding the cap for us.
 */
const MANIFEST_READ_HEADROOM = 2;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_HEX = /^[a-f0-9]{64}$/;

type JsonRecord = Record<string, unknown>;

export interface LineagePaneRef {
  backend: string;
  paneId: string;
  muxSession?: string;
  windowName?: string;
}

export interface LineageManifest {
  schemaVersion: typeof LINEAGE_SCHEMA_VERSION;
  agentId: string;
  parentAgentId?: string;
  rootId: string;
  rootHash: string;
  ownerSessionId: string;
  name: string;
  /** Runtime origin classification; absent legacy manifests degrade to direct. */
  runtimeKind?: "direct" | "workflow";
  taskPreview: string;
  startedAt: string;
  cwd: string;
  pane: LineagePaneRef;
  artifactDir?: string;
  childSessionFile?: string;
}

export interface LineageBounds {
  maxManifestBytes: number;
  maxStringBytes: number;
  maxTaskPreviewBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxProjectionBytes: number;
}

export interface LineageStorePaths {
  treeDir: string;
  rootPath: string;
  nodesDir: string;
}

export type ProjectionIssueKind =
  "cycle" | "malformed" | "orphan" | "stale" | "truncated";

export interface ProjectionIssue {
  kind: ProjectionIssueKind;
  agentId?: string;
  path?: string;
  reason: string;
}

export type ProjectedNodeState = "actionable" | "non-actionable";

export interface ProjectedLineageNode {
  manifest: LineageManifest;
  depth: number;
  state: ProjectedNodeState;
  reasons: ProjectionIssueKind[];
  children: ProjectedLineageNode[];
}

export interface LineageProjection {
  rootHash: string;
  roots: ProjectedLineageNode[];
  nonActionable: ProjectedLineageNode[];
  issues: ProjectionIssue[];
  truncated: boolean;
  /**
   * Every manifest that was read for this projection, including the ones the
   * node cap or the depth cap dropped from the tree. Subtree cancellation walks
   * this set so a descendant beyond a cap is still reachable.
   */
  manifests: LineageManifest[];
}

export interface LineagePruneResult {
  pruned: string[];
  /** Physical manifests left on disk, including dead retained ancestors. */
  retained: number;
  /** Manifests not confirmed dead; this is the spawn-admission count. */
  active: number;
}

/**
 * Why a node was skipped. `stale` used to absorb orphan/cycle/truncated too,
 * which reported "N stale" for what was really a cycle or the depth cap.
 */
export type CancelLineageNodeStatus =
  | "cancelled"
  | "already-terminal"
  | "stale"
  | "orphan"
  | "cycle"
  | "truncated"
  | "malformed"
  | "failed";

export interface CancelLineageNodeResult {
  agentId: string;
  status: CancelLineageNodeStatus;
  error?: string;
}

export interface CancelSubtreeResult {
  attempted: CancelLineageNodeResult[];
  cancelled: string[];
  alreadyTerminal: string[];
  stale: string[];
  orphan: string[];
  cycle: string[];
  truncated: string[];
  malformed: string[];
  failed: CancelLineageNodeResult[];
  /**
   * Descendants that the projection omitted (depth cap, node cap) and that were
   * recovered from the raw manifest set. Non-empty means the tree the user saw
   * was incomplete.
   */
  recovered: string[];
  /** The projection this subtree came from was truncated and cannot be trusted. */
  projectionTruncated: boolean;
}

export interface CancelSubtreeCallbacks {
  isTerminal(node: ProjectedLineageNode): boolean | Promise<boolean>;
  isStale(node: ProjectedLineageNode): boolean | Promise<boolean>;
  cancel(node: ProjectedLineageNode): void | Promise<void>;
  /**
   * Raw manifests for the whole tree. When supplied, the subtree is derived
   * from parent links instead of the depth-capped projection, so descendants
   * past `maxDepth` or the node cap are cancelled instead of silently left
   * running with a dead parent.
   */
  allManifests?: LineageManifest[];
  /** Whether the projection the root came from was truncated. */
  projectionTruncated?: boolean;
}

export function lineageBounds(
  overrides: Partial<LineageBounds> = {},
): LineageBounds {
  return {
    maxManifestBytes: DEFAULT_MAX_MANIFEST_BYTES,
    maxStringBytes: DEFAULT_MAX_STRING_BYTES,
    maxTaskPreviewBytes: DEFAULT_MAX_TASK_PREVIEW_BYTES,
    maxNodes: DEFAULT_MAX_NODES,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxProjectionBytes: DEFAULT_MAX_PROJECTION_BYTES,
    ...overrides,
  };
}

export function hashLineageRoot(rootId: string): string {
  assertBoundedString(rootId, "rootId", DEFAULT_MAX_STRING_BYTES);
  return createHash("sha256").update(rootId).digest("hex");
}

export async function resolveLineageStorePaths(
  sessionRoot: string,
  rootId: string,
): Promise<LineageStorePaths> {
  // Match sync twin: create the session root before realpath so a fresh
  // install does not reject with ENOENT (swallowed by the supervisor load
  // path into a silent direct-children-only degrade).
  await fs.mkdir(sessionRoot, { recursive: true });
  const safeSessionRoot = await resolveContainedRealPath(
    sessionRoot,
    sessionRoot,
  );
  const rootHash = hashLineageRoot(rootId);
  const treeDir = path.join(safeSessionRoot, "subagentura", "trees", rootHash);
  await assertPathHasNoSymlinkEscape(safeSessionRoot, treeDir);
  return {
    treeDir,
    rootPath: path.join(treeDir, "root.json"),
    nodesDir: path.join(treeDir, "nodes"),
  };
}

export function resolveLineageStorePathsSync(
  sessionRoot: string,
  rootId: string,
): LineageStorePaths {
  mkdirSync(sessionRoot, { recursive: true });
  const safeSessionRoot = realpathSync(sessionRoot);
  const rootHash = hashLineageRoot(rootId);
  const treeDir = path.join(safeSessionRoot, "subagentura", "trees", rootHash);
  assertPathHasNoSymlinkEscapeSync(safeSessionRoot, treeDir);
  return {
    treeDir,
    rootPath: path.join(treeDir, "root.json"),
    nodesDir: path.join(treeDir, "nodes"),
  };
}

export async function safeContainedPath(
  root: string,
  candidate: string,
): Promise<string> {
  // Return the root's real-path form so callers get the same value whether the
  // input used a platform alias such as macOS /var or its /private/var target.
  return resolveContainedRealPath(root, candidate);
}

export function nodeManifestPath(nodesDir: string, agentId: string): string {
  assertSafeId(agentId, "agentId");
  return path.join(nodesDir, `${agentId}.json`);
}

export async function writeLineageManifestAtomic(
  nodesDir: string,
  manifest: LineageManifest,
  bounds: Partial<LineageBounds> = {},
): Promise<string> {
  const effectiveBounds = lineageBounds(bounds);
  const validated = validateLineageManifest(manifest, effectiveBounds);
  const filePath = nodeManifestPath(nodesDir, validated.agentId);
  await fs.mkdir(nodesDir, { recursive: true });
  const data = `${JSON.stringify(validated, stableJsonReplacer, 2)}\n`;
  if (Buffer.byteLength(data) > effectiveBounds.maxManifestBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  const tmpPath = path.join(
    nodesDir,
    `.${validated.agentId}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, data, { mode: 0o600 });
  try {
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

export function writeLineageManifestAtomicSync(
  nodesDir: string,
  manifest: LineageManifest,
  bounds: Partial<LineageBounds> = {},
): string {
  const effectiveBounds = lineageBounds(bounds);
  const validated = validateLineageManifest(manifest, effectiveBounds);
  const filePath = nodeManifestPath(nodesDir, validated.agentId);
  mkdirSync(nodesDir, { recursive: true });
  const data = `${JSON.stringify(validated, stableJsonReplacer, 2)}\n`;
  if (Buffer.byteLength(data) > effectiveBounds.maxManifestBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  const tmpPath = path.join(
    nodesDir,
    `.${validated.agentId}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  writeFileSync(tmpPath, data, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return filePath;
}

export function validateLineageManifest(
  value: unknown,
  bounds: Partial<LineageBounds> = {},
): LineageManifest {
  const effectiveBounds = lineageBounds(bounds);
  if (!isRecord(value)) {
    throw new Error("lineage manifest must be an object");
  }
  const allowed = new Set([
    "schemaVersion",
    "agentId",
    "parentAgentId",
    "rootId",
    "rootHash",
    "ownerSessionId",
    "name",
    "runtimeKind",
    "taskPreview",
    "startedAt",
    "cwd",
    "pane",
    "artifactDir",
    "childSessionFile",
  ]);
  rejectUnknownKeys(value, allowed, "lineage manifest");
  const schemaVersion = expectNumber(value.schemaVersion, "schemaVersion");
  if (schemaVersion !== LINEAGE_SCHEMA_VERSION) {
    throw new Error("unsupported lineage manifest schemaVersion");
  }
  const agentId = expectSafeId(value.agentId, "agentId");
  const parentAgentId = optionalSafeId(value.parentAgentId, "parentAgentId");
  const rootId = expectBoundedString(
    value.rootId,
    "rootId",
    effectiveBounds.maxStringBytes,
  );
  const rootHash = expectBoundedString(value.rootHash, "rootHash", 64);
  if (!HASH_HEX.test(rootHash) || rootHash !== hashLineageRoot(rootId)) {
    throw new Error("lineage manifest rootHash does not match rootId");
  }
  const ownerSessionId = expectBoundedString(
    value.ownerSessionId,
    "ownerSessionId",
    effectiveBounds.maxStringBytes,
  );
  const name = expectBoundedString(
    value.name,
    "name",
    effectiveBounds.maxStringBytes,
  );
  const runtimeKind =
    value.runtimeKind === undefined
      ? undefined
      : value.runtimeKind === "direct" || value.runtimeKind === "workflow"
        ? value.runtimeKind
        : (() => {
            throw new Error(
              'lineage manifest runtimeKind must be "direct" or "workflow"',
            );
          })();
  const taskPreview = expectBoundedString(
    value.taskPreview,
    "taskPreview",
    effectiveBounds.maxTaskPreviewBytes,
  );
  const startedAt = expectBoundedString(
    value.startedAt,
    "startedAt",
    effectiveBounds.maxStringBytes,
  );
  if (Number.isNaN(Date.parse(startedAt))) {
    throw new Error("lineage manifest startedAt must be an ISO date string");
  }
  const cwd = expectBoundedString(
    value.cwd,
    "cwd",
    effectiveBounds.maxStringBytes,
  );
  const artifactDir = optionalBoundedString(
    value.artifactDir,
    "artifactDir",
    effectiveBounds.maxStringBytes,
  );
  const childSessionFile = optionalBoundedString(
    value.childSessionFile,
    "childSessionFile",
    effectiveBounds.maxStringBytes,
  );
  const pane = validatePaneRef(value.pane, effectiveBounds);
  return {
    schemaVersion,
    agentId,
    ...(parentAgentId === undefined ? {} : { parentAgentId }),
    rootId,
    rootHash,
    ownerSessionId,
    name,
    ...(runtimeKind === undefined ? {} : { runtimeKind }),
    taskPreview,
    startedAt,
    cwd,
    pane,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(childSessionFile === undefined ? {} : { childSessionFile }),
  };
}

export async function readLineageManifest(
  filePath: string,
  bounds: Partial<LineageBounds> = {},
): Promise<LineageManifest> {
  const effectiveBounds = lineageBounds(bounds);
  const data = await readBoundedFile(
    filePath,
    effectiveBounds.maxManifestBytes,
  );
  const parsed = JSON.parse(data) as unknown;
  return validateLineageManifest(parsed, effectiveBounds);
}

export async function projectLineageStore(
  nodesDir: string,
  rootHash: string,
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean>,
  bounds: Partial<LineageBounds> = {},
): Promise<LineageProjection> {
  const effectiveBounds = lineageBounds(bounds);
  if (!HASH_HEX.test(rootHash)) {
    throw new Error("rootHash must be a sha256 hex digest");
  }
  const issues: ProjectionIssue[] = [];
  const manifests = new Map<string, LineageManifest>();
  // Newest first: when a cap has to drop something it must not be the manifest
  // a running agent just wrote. Filename order is random (agentId is random
  // hex), so sorting by name made the retained subset random too.
  const paths = await listManifestPaths(nodesDir, effectiveBounds);
  let consumedBytes = 0;
  for (const manifestPath of paths) {
    if (manifests.size >= effectiveBounds.maxNodes * MANIFEST_READ_HEADROOM) {
      issues.push({
        kind: "truncated",
        path: manifestPath,
        reason: "node cap reached",
      });
      break;
    }
    try {
      const data = await readBoundedFile(
        manifestPath,
        effectiveBounds.maxManifestBytes,
      );
      consumedBytes += Buffer.byteLength(data);
      if (consumedBytes > effectiveBounds.maxProjectionBytes) {
        issues.push({
          kind: "truncated",
          path: manifestPath,
          reason: "projection byte cap reached",
        });
        break;
      }
      const manifest = validateLineageManifest(
        JSON.parse(data),
        effectiveBounds,
      );
      if (manifest.rootHash !== rootHash) {
        continue;
      }
      if (manifests.has(manifest.agentId)) {
        issues.push({
          kind: "malformed",
          agentId: manifest.agentId,
          path: manifestPath,
          reason: "duplicate agentId",
        });
        continue;
      }
      manifests.set(manifest.agentId, manifest);
    } catch (error) {
      // A manifest pruned by a concurrent sweep between readdir and read is
      // gone, not malformed. Reporting it would put a permanent phantom
      // warning in the overlay footer.
      if (isNodeError(error, "ENOENT")) continue;
      issues.push({
        kind: "malformed",
        path: manifestPath,
        reason: errorMessage(error),
      });
    }
  }
  // A newest-first read window can include a live child while its older parent
  // falls outside the window. Pull missing ancestors by canonical filename so
  // cap selection can retain complete chains rather than creating cap-induced
  // orphans. The active-node budget may require one dead closure chain per
  // admitted node, while depth and byte bounds still cap physical reads.
  const ancestorQueue = [...manifests.values()].map((manifest) => ({
    manifest,
    depth: 0,
  }));
  const attemptedAncestors = new Set(manifests.keys());
  const ancestorReadLimit = effectiveBounds.maxNodes * effectiveBounds.maxDepth;
  let ancestorReads = 0;
  let ancestorCursor = 0;
  while (ancestorCursor < ancestorQueue.length) {
    const { manifest: child, depth } = ancestorQueue[ancestorCursor++]!;
    const parentId = child.parentAgentId;
    if (!parentId || attemptedAncestors.has(parentId)) continue;
    if (depth >= effectiveBounds.maxDepth) {
      issues.push({
        kind: "truncated",
        agentId: child.agentId,
        reason: "ancestor depth cap reached",
      });
      continue;
    }
    attemptedAncestors.add(parentId);
    if (ancestorReads >= ancestorReadLimit) {
      issues.push({
        kind: "truncated",
        agentId: child.agentId,
        reason: "ancestor read cap reached",
      });
      break;
    }
    ancestorReads++;
    const parentPath = nodeManifestPath(nodesDir, parentId);
    try {
      const data = await readBoundedFile(
        parentPath,
        effectiveBounds.maxManifestBytes,
      );
      consumedBytes += Buffer.byteLength(data);
      if (consumedBytes > effectiveBounds.maxProjectionBytes) {
        issues.push({
          kind: "truncated",
          path: parentPath,
          reason: "projection byte cap reached",
        });
        break;
      }
      const parent = validateLineageManifest(JSON.parse(data), effectiveBounds);
      if (parent.agentId !== parentId || parent.rootHash !== rootHash) {
        issues.push({
          kind: "malformed",
          agentId: parentId,
          path: parentPath,
          reason: "ancestor manifest identity mismatch",
        });
        continue;
      }
      manifests.set(parent.agentId, parent);
      ancestorQueue.push({ manifest: parent, depth: depth + 1 });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      issues.push({
        kind: "malformed",
        agentId: parentId,
        path: parentPath,
        reason: errorMessage(error),
      });
    }
  }
  return await projectManifests(
    [...manifests.values()],
    rootHash,
    isNodeStale,
    {
      ...effectiveBounds,
      issues,
    },
  );
}

/**
 * Delete the manifests of nodes that are no longer live.
 *
 * Nothing else ever unlinks a node manifest, so without this sweep the store
 * grows by one file per spawn forever and the spawn gate — which counts files —
 * permanently refuses new agents once the all-time total reaches `maxNodes`.
 *
 * A stale node is only removed when no retained manifest still names it as a
 * parent: unlinking a dead intermediate node would orphan its live children and
 * hide them from the overlay. Removal is a single `unlink`, so a concurrent
 * reader either sees the whole file or ENOENT, which the projection skips.
 */
export async function pruneTerminalLineageNodes(
  nodesDir: string,
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean>,
  bounds: Partial<LineageBounds> & { concurrency?: number } = {},
): Promise<LineagePruneResult> {
  const effectiveBounds = lineageBounds(bounds);
  const entries: { path: string; manifest: LineageManifest }[] = [];
  const manifestPaths = await listManifestPaths(nodesDir, effectiveBounds, {
    limit: Number.POSITIVE_INFINITY,
  });
  let missing = 0;
  for (const manifestPath of manifestPaths) {
    try {
      const manifest = validateLineageManifest(
        JSON.parse(
          await readBoundedFile(manifestPath, effectiveBounds.maxManifestBytes),
        ),
        effectiveBounds,
      );
      entries.push({ path: manifestPath, manifest });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        missing++;
        continue;
      }
      /* An unreadable manifest is left alone; the projection reports it. */
    }
  }
  const stale = await staleFlagsFor(
    entries.map((entry) => entry.manifest),
    isNodeStale,
    bounds.concurrency,
  );
  const parents = new Set(
    entries
      .map((entry) => entry.manifest.parentAgentId)
      .filter((id): id is string => id !== undefined),
  );
  const pruned: string[] = [];
  for (const entry of entries) {
    const agentId = entry.manifest.agentId;
    if (!stale.get(agentId)) continue;
    if (parents.has(agentId)) continue;
    try {
      await fs.rm(entry.path, { force: true });
      pruned.push(agentId);
    } catch {
      /* Best effort: a manifest we cannot remove is retried next sweep. */
    }
  }
  const unreadable = manifestPaths.length - missing - entries.length;
  const active =
    unreadable +
    entries.filter((entry) => !stale.get(entry.manifest.agentId)).length;
  return {
    pruned,
    retained: manifestPaths.length - missing - pruned.length,
    active,
  };
}

/** Count node manifests without reading them. Used by the sync spawn gate. */
export function countLineageManifestsSync(nodesDir: string): number {
  try {
    return readdirSync(nodesDir).filter((entry) => entry.endsWith(".json"))
      .length;
  } catch {
    return 0;
  }
}

/** Synchronous twin of `pruneTerminalLineageNodes` for the spawn gate. */
export function pruneTerminalLineageNodesSync(
  nodesDir: string,
  isNodeStale: (manifest: LineageManifest) => boolean,
  bounds: Partial<LineageBounds> = {},
): LineagePruneResult {
  const effectiveBounds = lineageBounds(bounds);
  const entries: { path: string; manifest: LineageManifest }[] = [];
  let names: string[];
  try {
    names = readdirSync(nodesDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return { pruned: [], retained: 0, active: 0 };
  }
  let missing = 0;
  for (const name of names) {
    const manifestPath = path.join(nodesDir, name);
    try {
      if (statSync(manifestPath).size > effectiveBounds.maxManifestBytes)
        continue;
      entries.push({
        path: manifestPath,
        manifest: validateLineageManifest(
          JSON.parse(readFileSync(manifestPath, "utf8")),
          effectiveBounds,
        ),
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        missing++;
        continue;
      }
      /* An unreadable manifest is left alone; the projection reports it. */
    }
  }
  const stale = new Map(
    entries.map((entry) => [entry.path, isNodeStale(entry.manifest)]),
  );
  const parents = new Set(
    entries
      .map((entry) => entry.manifest.parentAgentId)
      .filter((id): id is string => id !== undefined),
  );
  const pruned: string[] = [];
  for (const entry of entries) {
    const agentId = entry.manifest.agentId;
    if (parents.has(agentId)) continue;
    if (!stale.get(entry.path)) continue;
    try {
      rmSync(entry.path, { force: true });
      pruned.push(agentId);
    } catch {
      /* Best effort: a manifest we cannot remove is retried next sweep. */
    }
  }
  const unreadable = names.length - missing - entries.length;
  const active =
    unreadable + entries.filter((entry) => !stale.get(entry.path)).length;
  return {
    pruned,
    retained: names.length - missing - pruned.length,
    active,
  };
}

export async function projectManifests(
  manifests: LineageManifest[],
  rootHash: string,
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean> = () =>
    false,
  options: Partial<LineageBounds> & {
    issues?: ProjectionIssue[];
    concurrency?: number;
  } = {},
): Promise<LineageProjection> {
  const effectiveBounds = lineageBounds(options);
  const issues = [...(options.issues ?? [])];
  const byId = new Map<string, LineageManifest>();
  const nonActionableIds = new Map<string, Set<ProjectionIssueKind>>();
  const addReason = (agentId: string, reason: ProjectionIssueKind): void => {
    const reasons =
      nonActionableIds.get(agentId) ?? new Set<ProjectionIssueKind>();
    reasons.add(reason);
    nonActionableIds.set(agentId, reasons);
  };

  const candidates = manifests.filter(
    (manifest) => manifest.rootHash === rootHash,
  );
  // One batched staleness pass for the whole set. It feeds cap selection, the
  // reason buckets, and the caller's liveness view, so no manifest is probed
  // more than once per projection.
  const stale = await staleFlagsFor(
    candidates,
    isNodeStale,
    options.concurrency,
  );

  const candidatesById = new Map<string, LineageManifest>();
  for (const manifest of candidates) {
    if (candidatesById.has(manifest.agentId)) {
      issues.push({
        kind: "malformed",
        agentId: manifest.agentId,
        reason: "duplicate agentId",
      });
      addReason(manifest.agentId, "malformed");
      continue;
    }
    if (
      manifest.pane.backend !== "tmux" &&
      manifest.pane.backend !== "zellij"
    ) {
      issues.push({
        kind: "malformed",
        agentId: manifest.agentId,
        reason: `unsupported pane backend ${manifest.pane.backend}`,
      });
      addReason(manifest.agentId, "malformed");
    }
    candidatesById.set(manifest.agentId, manifest);
  }

  // Select complete parent chains. A live child without its retained ancestor
  // would be rendered as a non-actionable orphan, so a chain either fits as a
  // unit or is omitted. Non-dead endpoints are considered before dead-only
  // candidates, then deterministic recency decides cap pressure.
  const capOrdered = [...candidatesById.values()].sort((left, right) => {
    const leftStale = stale.get(left.agentId) ?? false;
    const rightStale = stale.get(right.agentId) ?? false;
    if (leftStale !== rightStale) return leftStale ? 1 : -1;
    const recency = right.startedAt.localeCompare(left.startedAt);
    return recency === 0 ? left.agentId.localeCompare(right.agentId) : recency;
  });
  let activeSelected = 0;
  let optionalDeadSelected = 0;
  for (const manifest of capOrdered) {
    if (byId.has(manifest.agentId)) continue;
    const chain: LineageManifest[] = [];
    const visited = new Set<string>();
    let current: LineageManifest | undefined = manifest;
    while (current && !byId.has(current.agentId)) {
      if (visited.has(current.agentId)) break;
      visited.add(current.agentId);
      chain.push(current);
      current = current.parentAgentId
        ? candidatesById.get(current.parentAgentId)
        : undefined;
    }
    const additionalActive = chain.filter(
      (member) => !(stale.get(member.agentId) ?? false),
    ).length;
    if (activeSelected + additionalActive > effectiveBounds.maxNodes) continue;
    const endpointIsDead = stale.get(manifest.agentId) ?? false;
    const additionalOptionalDead = endpointIsDead
      ? chain.length - additionalActive
      : 0;
    if (
      endpointIsDead &&
      activeSelected +
        optionalDeadSelected +
        additionalActive +
        additionalOptionalDead >
        effectiveBounds.maxNodes
    ) {
      continue;
    }
    activeSelected += additionalActive;
    if (endpointIsDead) optionalDeadSelected += additionalOptionalDead;
    for (const member of chain.reverse()) {
      byId.set(member.agentId, member);
    }
  }
  for (const manifest of candidatesById.values()) {
    if (byId.has(manifest.agentId)) continue;
    issues.push({
      kind: "truncated",
      agentId: manifest.agentId,
      reason: "node cap reached",
    });
  }

  for (const manifest of byId.values()) {
    if (manifest.parentAgentId && !byId.has(manifest.parentAgentId)) {
      issues.push({
        kind: "orphan",
        agentId: manifest.agentId,
        reason: "parent manifest missing",
      });
      addReason(manifest.agentId, "orphan");
    }
    if (stale.get(manifest.agentId)) {
      issues.push({
        kind: "stale",
        agentId: manifest.agentId,
        reason: "node is stale",
      });
      addReason(manifest.agentId, "stale");
    }
  }

  const children = new Map<string, LineageManifest[]>();
  const roots: LineageManifest[] = [];
  for (const manifest of byId.values()) {
    if (!manifest.parentAgentId || !byId.has(manifest.parentAgentId)) {
      roots.push(manifest);
      continue;
    }
    const siblings = children.get(manifest.parentAgentId) ?? [];
    siblings.push(manifest);
    children.set(manifest.parentAgentId, siblings);
  }
  roots.sort((left, right) => {
    const leftOrphan =
      nonActionableIds.get(left.agentId)?.has("orphan") ?? false;
    const rightOrphan =
      nonActionableIds.get(right.agentId)?.has("orphan") ?? false;
    if (leftOrphan !== rightOrphan) {
      return leftOrphan ? 1 : -1;
    }
    return compareManifest(left, right);
  });
  for (const siblings of children.values()) {
    siblings.sort(compareManifest);
  }

  const built = new Map<string, ProjectedLineageNode>();
  const build = (
    manifest: LineageManifest,
    depth: number,
    stack: Set<string>,
  ): ProjectedLineageNode => {
    const reasonSet = new Set(nonActionableIds.get(manifest.agentId) ?? []);
    if (stack.has(manifest.agentId)) {
      reasonSet.add("cycle");
      issues.push({
        kind: "cycle",
        agentId: manifest.agentId,
        reason: "cycle detected",
      });
      return makeNode(manifest, depth, reasonSet, []);
    }
    const childStack = new Set(stack);
    childStack.add(manifest.agentId);
    const directChildren = children.get(manifest.agentId) ?? [];
    if (depth >= effectiveBounds.maxDepth && directChildren.length > 0) {
      reasonSet.add("truncated");
      issues.push({
        kind: "truncated",
        agentId: manifest.agentId,
        reason: "depth cap reached",
      });
    }
    const projectedChildren =
      depth >= effectiveBounds.maxDepth
        ? []
        : directChildren.map((child) => build(child, depth + 1, childStack));
    const node = makeNode(manifest, depth, reasonSet, projectedChildren);
    built.set(manifest.agentId, node);
    return node;
  };

  const projectedRoots = roots.map((root) => build(root, 0, new Set()));
  for (const manifest of byId.values()) {
    if (!built.has(manifest.agentId)) {
      const reasonSet = new Set(nonActionableIds.get(manifest.agentId) ?? []);
      reasonSet.add("cycle");
      issues.push({
        kind: "cycle",
        agentId: manifest.agentId,
        reason: "unreachable cycle",
      });
      built.set(manifest.agentId, makeNode(manifest, 0, reasonSet, []));
    }
  }
  const nonActionable = [...built.values()]
    .filter((node) => node.state === "non-actionable")
    .sort(compareProjectedNode);
  return {
    rootHash,
    roots: projectedRoots,
    nonActionable,
    issues: issues.sort(compareIssue),
    truncated: issues.some((issue) => issue.kind === "truncated"),
    manifests: candidates,
  };
}

export function flattenLineageTree(
  nodes: ProjectedLineageNode[],
): ProjectedLineageNode[] {
  const flattened: ProjectedLineageNode[] = [];
  const visit = (node: ProjectedLineageNode): void => {
    flattened.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  return flattened;
}

export async function cancelLineageSubtreeBestEffort(
  root: ProjectedLineageNode,
  callbacks: CancelSubtreeCallbacks,
): Promise<CancelSubtreeResult> {
  const projected = flattenLineageTree([root]);
  const projectedIds = new Set(projected.map((node) => node.manifest.agentId));
  // Walk the RAW manifest set when it is available. The projection is capped by
  // maxDepth and by the node cap, and cancelling only what it contains left
  // deeper descendants running with a dead parent while the banner reported a
  // clean "N cancelled, 0 failed".
  const nodes = callbacks.allManifests
    ? rawSubtreeNodes(root, callbacks.allManifests, projected)
    : projected;
  const recovered = nodes
    .map((node) => node.manifest.agentId)
    .filter((agentId) => !projectedIds.has(agentId));
  const ordered = [...nodes].sort((left, right) => {
    const depthDelta = right.depth - left.depth;
    return depthDelta === 0 ? compareProjectedNode(left, right) : depthDelta;
  });
  const attempted: CancelLineageNodeResult[] = [];
  for (const node of ordered) {
    const agentId = node.manifest.agentId;
    try {
      if (node.state !== "actionable") {
        attempted.push({ agentId, status: skipStatusForNode(node) });
        continue;
      }
      if (await callbacks.isStale(node)) {
        attempted.push({ agentId, status: "stale" });
        continue;
      }
      if (await callbacks.isTerminal(node)) {
        attempted.push({ agentId, status: "already-terminal" });
        continue;
      }
      await callbacks.cancel(node);
      attempted.push({ agentId, status: "cancelled" });
    } catch (error) {
      attempted.push({ agentId, status: "failed", error: errorMessage(error) });
    }
  }
  const idsWithStatus = (status: CancelLineageNodeStatus): string[] =>
    attempted
      .filter((result) => result.status === status)
      .map((result) => result.agentId);
  return {
    attempted,
    cancelled: idsWithStatus("cancelled"),
    alreadyTerminal: idsWithStatus("already-terminal"),
    stale: idsWithStatus("stale"),
    orphan: idsWithStatus("orphan"),
    cycle: idsWithStatus("cycle"),
    truncated: idsWithStatus("truncated"),
    malformed: idsWithStatus("malformed"),
    failed: attempted.filter((result) => result.status === "failed"),
    recovered,
    projectionTruncated: callbacks.projectionTruncated === true,
  };
}

/**
 * Derive the full subtree from raw parent links, reusing the projected node
 * (and its reasons) wherever the projection already covered it. Cycle-safe: a
 * manifest is visited at most once.
 */
function rawSubtreeNodes(
  root: ProjectedLineageNode,
  allManifests: LineageManifest[],
  projected: ProjectedLineageNode[],
): ProjectedLineageNode[] {
  const projectedById = new Map(
    projected.map((node) => [node.manifest.agentId, node]),
  );
  const childrenByParent = new Map<string, LineageManifest[]>();
  for (const manifest of allManifests) {
    if (!manifest.parentAgentId) continue;
    const siblings = childrenByParent.get(manifest.parentAgentId) ?? [];
    siblings.push(manifest);
    childrenByParent.set(manifest.parentAgentId, siblings);
  }
  const collected: ProjectedLineageNode[] = [];
  const visited = new Set<string>();
  const visit = (manifest: LineageManifest, depth: number): void => {
    const agentId = manifest.agentId;
    if (visited.has(agentId)) return;
    visited.add(agentId);
    const existing = projectedById.get(agentId);
    collected.push(
      existing
        ? withoutTruncationReason(existing)
        : {
            manifest,
            depth,
            state: "actionable",
            reasons: [],
            children: [],
          },
    );
    for (const child of [...(childrenByParent.get(agentId) ?? [])].sort(
      compareManifest,
    )) {
      visit(child, depth + 1);
    }
  };
  visit(root.manifest, root.depth);
  return collected;
}

/**
 * A node at the depth cap is marked "truncated" only because its own children
 * were dropped from the tree — the node itself is fine. The raw walk covers
 * those children now, so the reason no longer disqualifies it from being
 * cancelled.
 */
function withoutTruncationReason(
  node: ProjectedLineageNode,
): ProjectedLineageNode {
  if (!node.reasons.includes("truncated")) return node;
  const reasons = node.reasons.filter((reason) => reason !== "truncated");
  return {
    ...node,
    reasons,
    state: reasons.length === 0 ? "actionable" : "non-actionable",
  };
}

/** Report the real reason a non-actionable node was skipped, most specific first. */
function skipStatusForNode(
  node: ProjectedLineageNode,
): CancelLineageNodeStatus {
  const reasons = new Set(node.reasons);
  if (reasons.has("cycle")) return "cycle";
  if (reasons.has("malformed")) return "malformed";
  if (reasons.has("orphan")) return "orphan";
  if (reasons.has("truncated")) return "truncated";
  return "stale";
}

/**
 * Resolve staleness for a manifest set with bounded concurrency.
 *
 * Each probe is a mux subprocess; the previous sequential await made one
 * overlay refresh cost O(nodes) round-trips.
 */
async function staleFlagsFor(
  manifests: LineageManifest[],
  isNodeStale: (manifest: LineageManifest) => boolean | Promise<boolean>,
  concurrency = DEFAULT_STALENESS_CONCURRENCY,
): Promise<Map<string, boolean>> {
  const unique = new Map<string, LineageManifest>();
  for (const manifest of manifests) {
    if (!unique.has(manifest.agentId)) unique.set(manifest.agentId, manifest);
  }
  const pending = [...unique.values()];
  const stale = new Map<string, boolean>();
  const limit = Math.max(1, Math.min(concurrency, pending.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < pending.length) {
        const manifest = pending[cursor++]!;
        try {
          stale.set(manifest.agentId, Boolean(await isNodeStale(manifest)));
        } catch {
          // Failure cannot confirm death. Keep the node visible and retained
          // until a later probe returns an explicit dead result.
          stale.set(manifest.agentId, false);
        }
      }
    }),
  );
  return stale;
}

async function resolveContainedRealPath(
  root: string,
  candidate: string,
): Promise<string> {
  const rootAbsolute = path.resolve(root);
  const rootReal = await fs.realpath(root);
  const candidateAbsolute = path.resolve(rootAbsolute, candidate);
  let relative = containedRelativePath(
    rootAbsolute,
    rootReal,
    candidateAbsolute,
  );
  if (relative === undefined) {
    try {
      const candidateReal = await fs.realpath(candidateAbsolute);
      relative = containedRelativePath(rootReal, rootReal, candidateReal);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
  if (relative === undefined) throw new Error("path escapes lineage root");
  const resolved = path.resolve(rootReal, relative);
  await assertPathHasNoSymlinkEscape(rootReal, resolved);
  return resolved;
}

function containedRelativePath(
  rootAbsolute: string,
  rootReal: string,
  candidateAbsolute: string,
): string | undefined {
  for (const base of new Set([rootAbsolute, rootReal])) {
    const relative = path.relative(base, candidateAbsolute);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      return relative;
    }
  }
  return undefined;
}

async function assertPathHasNoSymlinkEscape(
  rootReal: string,
  candidate: string,
): Promise<void> {
  const relative = path.relative(rootReal, path.resolve(candidate));
  if (relative === "") {
    return;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes lineage root");
  }
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("lineage path contains a symlink");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
}

function assertPathHasNoSymlinkEscapeSync(
  rootReal: string,
  candidate: string,
): void {
  const relative = path.relative(rootReal, path.resolve(candidate));
  if (relative === "") return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes lineage root");
  }
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("lineage path contains a symlink");
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
  }
}

/**
 * List node manifests newest-first.
 *
 * `agentId` is random hex, so the previous lexicographic sort made the retained
 * window random with respect to which nodes are still running. Ordering by
 * mtime descending keeps the window on the manifests a live tree just wrote.
 */
async function listManifestPaths(
  nodesDir: string,
  bounds: LineageBounds,
  options: { limit?: number } = {},
): Promise<string[]> {
  const entries = await fs
    .readdir(nodesDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(nodesDir, entry.name));
  const stamped = await Promise.all(
    files.map(async (filePath) => ({
      filePath,
      modifiedAt: await fs
        .stat(filePath)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0),
    })),
  );
  const limit = options.limit ?? bounds.maxNodes * MANIFEST_READ_HEADROOM + 1;
  return stamped
    .sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        left.filePath.localeCompare(right.filePath),
    )
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error("lineage manifest exceeds byte limit");
  }
  return await fs.readFile(filePath, "utf8");
}

function validatePaneRef(
  value: unknown,
  bounds: LineageBounds,
): LineagePaneRef {
  if (!isRecord(value)) {
    throw new Error("pane must be an object");
  }
  rejectUnknownKeys(
    value,
    new Set(["backend", "paneId", "muxSession", "windowName"]),
    "pane",
  );
  return {
    backend: expectBoundedString(
      value.backend,
      "pane.backend",
      bounds.maxStringBytes,
    ),
    paneId: expectBoundedString(
      value.paneId,
      "pane.paneId",
      bounds.maxStringBytes,
    ),
    ...optionalObjectString(value, "muxSession", "pane.muxSession", bounds),
    ...optionalObjectString(value, "windowName", "pane.windowName", bounds),
  };
}

function optionalObjectString(
  object: JsonRecord,
  key: string,
  label: string,
  bounds: LineageBounds,
): Record<string, string> {
  const value = optionalBoundedString(
    object[key],
    label,
    bounds.maxStringBytes,
  );
  return value === undefined ? {} : { [key]: value };
}

function makeNode(
  manifest: LineageManifest,
  depth: number,
  reasons: Set<ProjectionIssueKind>,
  children: ProjectedLineageNode[],
): ProjectedLineageNode {
  const sortedReasons = [...reasons].sort();
  return {
    manifest,
    depth,
    state: sortedReasons.length === 0 ? "actionable" : "non-actionable",
    reasons: sortedReasons,
    children,
  };
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function expectSafeId(value: unknown, label: string): string {
  const stringValue = expectBoundedString(
    value,
    label,
    DEFAULT_MAX_STRING_BYTES,
  );
  assertSafeId(stringValue, label);
  return stringValue;
}

function optionalSafeId(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectSafeId(value, label);
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains unsafe characters`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is string {
  expectBoundedString(value, label, maxBytes);
}

function expectBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${label} exceeds byte limit`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectBoundedString(value, label, maxBytes);
}

function rejectUnknownKeys(
  record: JsonRecord,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown key ${key}`);
    }
  }
}

function compareManifest(
  left: LineageManifest,
  right: LineageManifest,
): number {
  const startedDelta = left.startedAt.localeCompare(right.startedAt);
  return startedDelta === 0
    ? left.agentId.localeCompare(right.agentId)
    : startedDelta;
}

function compareProjectedNode(
  left: ProjectedLineageNode,
  right: ProjectedLineageNode,
): number {
  return compareManifest(left.manifest, right.manifest);
}

function compareIssue(left: ProjectionIssue, right: ProjectionIssue): number {
  return `${left.kind}:${left.agentId ?? ""}:${left.path ?? ""}:${left.reason}`.localeCompare(
    `${right.kind}:${right.agentId ?? ""}:${right.path ?? ""}:${right.reason}`,
  );
}

function stableJsonReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
