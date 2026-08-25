import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { debugLog } from "./helpers";
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES } from "./interactive-lineage";

export const LINEAGE_BOOTSTRAP_SCHEMA_VERSION = 1;
export const LINEAGE_BOOTSTRAP_ENV = "PI_SUBAGENTURA_LINEAGE_BOOTSTRAP";
export const LINEAGE_BOOTSTRAP_TTL_MS = 60_000;
const MAX_LINEAGE_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_CONTEXT_STRING_BYTES = 2048;
const MAX_CONTEXT_DEPTH = 64;
const MAX_CONTEXT_NODES = 4096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BOOTSTRAP_NAME = /^\.lineage-bootstrap-[a-f0-9]{16}\.json$/;
const RUNTIME_CONTEXTS_KEY = "__piSubagenturaRuntimeSpawnTreeContexts";

export interface SpawnTreeContext {
  schemaVersion: typeof LINEAGE_BOOTSTRAP_SCHEMA_VERSION;
  role: "root" | "descendant";
  rootId: string;
  sessionRoot: string;
  artifactDir?: string;
  currentAgentId?: string;
  parentAgentId?: string;
  depth: number;
  maxDepth: number;
  maxNodes: number;
}

// Parse-don't-validate: only values that came out of `parseSpawnTreeContext`
// (directly or via the constructors below) carry this brand, so trust-boundary
// consumers can require `ParsedSpawnTreeContext` and skip re-validation.
const parsedBrand = Symbol("spawnTreeContext.parsed");
export type ParsedSpawnTreeContext = SpawnTreeContext & {
  readonly [parsedBrand]: true;
};

interface LineageBootstrapEnvelope {
  schemaVersion: typeof LINEAGE_BOOTSTRAP_SCHEMA_VERSION;
  issuedAt: number;
  expiresAt: number;
  context: ParsedSpawnTreeContext;
}

interface RuntimeContextGlobal {
  __piSubagenturaRuntimeSpawnTreeContexts?: Map<string, ParsedSpawnTreeContext>;
}

function runtimeContexts(): Map<string, ParsedSpawnTreeContext> {
  const state = globalThis as typeof globalThis & RuntimeContextGlobal;
  return (state[RUNTIME_CONTEXTS_KEY] ??= new Map());
}

function boundedString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid lineage bootstrap ${name}`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CONTEXT_STRING_BYTES) {
    throw new Error(`Lineage bootstrap ${name} is too large`);
  }
  return value;
}

function safeId(value: unknown, name: string): string {
  const id = boundedString(value, name);
  if (!SAFE_ID.test(id)) throw new Error(`Invalid lineage bootstrap ${name}`);
  return id;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`Invalid lineage bootstrap ${name}`);
  }
  return value as number;
}

function assertRoleIdentity(
  role: SpawnTreeContext["role"],
  depth: number,
  currentAgentId: string | undefined,
  parentAgentId: string | undefined,
  artifactDir: string | undefined,
): void {
  if (role === "root" && (depth !== 0 || currentAgentId || parentAgentId)) {
    throw new Error("Invalid root lineage bootstrap identity");
  }
  if (role === "root" && artifactDir) {
    throw new Error("Root lineage bootstrap cannot target an artifact");
  }
  if (role === "descendant" && (!currentAgentId || !artifactDir || depth < 1)) {
    throw new Error("Descendant lineage bootstrap requires target identity");
  }
  if (artifactDir && basename(artifactDir) !== currentAgentId) {
    throw new Error("Lineage bootstrap target does not match currentAgentId");
  }
}

export function parseSpawnTreeContext(value: unknown): ParsedSpawnTreeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid lineage bootstrap payload");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== LINEAGE_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error("Unsupported lineage bootstrap schema");
  }
  if (raw.role !== "root" && raw.role !== "descendant") {
    throw new Error("Invalid lineage bootstrap role");
  }
  const role = raw.role;
  const rootId = safeId(raw.rootId, "rootId");
  const sessionRoot = resolve(boundedString(raw.sessionRoot, "sessionRoot"));
  const currentAgentId =
    raw.currentAgentId === undefined
      ? undefined
      : safeId(raw.currentAgentId, "currentAgentId");
  const parentAgentId =
    raw.parentAgentId === undefined
      ? undefined
      : safeId(raw.parentAgentId, "parentAgentId");
  const artifactDir =
    raw.artifactDir === undefined
      ? undefined
      : resolve(boundedString(raw.artifactDir, "artifactDir"));
  const depth = boundedInteger(raw.depth, "depth", 0, MAX_CONTEXT_DEPTH);
  const maxDepth = boundedInteger(
    raw.maxDepth,
    "maxDepth",
    0,
    MAX_CONTEXT_DEPTH,
  );
  if (depth > maxDepth) {
    throw new Error("Lineage bootstrap depth exceeds maxDepth");
  }
  assertRoleIdentity(role, depth, currentAgentId, parentAgentId, artifactDir);
  return {
    schemaVersion: LINEAGE_BOOTSTRAP_SCHEMA_VERSION,
    role,
    rootId,
    sessionRoot,
    ...(artifactDir ? { artifactDir } : {}),
    ...(currentAgentId ? { currentAgentId } : {}),
    ...(parentAgentId ? { parentAgentId } : {}),
    depth,
    maxDepth,
    maxNodes: boundedInteger(raw.maxNodes, "maxNodes", 1, MAX_CONTEXT_NODES),
    [parsedBrand]: true,
  };
}

export function defaultSpawnTreeSessionRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR
    ? resolve(process.env.PI_CODING_AGENT_SESSION_DIR)
    : join(homedir(), ".pi", "agent", "sessions");
}

export function createRootSpawnTreeContext(
  rootId: string,
  sessionRoot = defaultSpawnTreeSessionRoot(),
): ParsedSpawnTreeContext {
  return parseSpawnTreeContext({
    schemaVersion: LINEAGE_BOOTSTRAP_SCHEMA_VERSION,
    role: "root",
    rootId,
    sessionRoot,
    depth: 0,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxNodes: DEFAULT_MAX_NODES,
  });
}

export function createDescendantSpawnTreeContext(
  parent: ParsedSpawnTreeContext,
  currentAgentId: string,
  artifactDir: string,
): ParsedSpawnTreeContext {
  return parseSpawnTreeContext({
    ...parent,
    role: "descendant",
    artifactDir,
    currentAgentId,
    parentAgentId: parent.currentAgentId,
    depth: parent.depth + 1,
  });
}

export function writeLineageBootstrap(
  artifactDir: string,
  context: ParsedSpawnTreeContext,
): string {
  const targetDir = resolve(artifactDir);
  if (context.role !== "descendant" || context.artifactDir !== targetDir) {
    throw new Error(
      "Lineage bootstrap target does not match artifact directory",
    );
  }
  const suffix = randomBytes(8).toString("hex");
  const path = join(targetDir, `.lineage-bootstrap-${suffix}.json`);
  const temporaryPath = `${path}.tmp`;
  const issuedAt = Date.now();
  const envelope: LineageBootstrapEnvelope = {
    schemaVersion: LINEAGE_BOOTSTRAP_SCHEMA_VERSION,
    issuedAt,
    expiresAt: issuedAt + LINEAGE_BOOTSTRAP_TTL_MS,
    context,
  };
  mkdirSync(targetDir, { recursive: true });
  try {
    writeFileSync(temporaryPath, JSON.stringify(envelope), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    return path;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function validateEnvelope(value: unknown, now: number): ParsedSpawnTreeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid lineage bootstrap envelope");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== LINEAGE_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error("Unsupported lineage bootstrap envelope schema");
  }
  const issuedAt = boundedInteger(raw.issuedAt, "issuedAt", 0, now + 5_000);
  const expiresAt = boundedInteger(
    raw.expiresAt,
    "expiresAt",
    issuedAt,
    issuedAt + LINEAGE_BOOTSTRAP_TTL_MS,
  );
  if (now > expiresAt) throw new Error("Lineage bootstrap expired");
  return parseSpawnTreeContext(raw.context);
}

function readBoundedJson(descriptor: number): unknown {
  const buffer = Buffer.alloc(MAX_LINEAGE_BOOTSTRAP_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_LINEAGE_BOOTSTRAP_BYTES) {
    throw new Error("Lineage bootstrap is too large");
  }
  return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
}

function readClaimedBootstrap(path: string): ParsedSpawnTreeContext {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("Lineage bootstrap must be a file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Lineage bootstrap permissions are too broad");
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error("Lineage bootstrap has the wrong owner");
    }
    rmSync(path);
    return validateEnvelope(readBoundedJson(descriptor), Date.now());
  } finally {
    closeSync(descriptor);
  }
}

function safeClaimName(bootstrapPath: string): string {
  const name = basename(bootstrapPath);
  if (!BOOTSTRAP_NAME.test(name)) {
    throw new Error("Invalid lineage bootstrap filename");
  }
  return join(
    dirname(bootstrapPath),
    `${name}.claimed-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
}

function cleanupClaim(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch (error) {
    debugLog("warn", "lineage_bootstrap_cleanup_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function acquireRuntimeSpawnTreeContext(
  artifactDir: string,
): ParsedSpawnTreeContext | undefined {
  const artifactKey = resolve(artifactDir);
  const bootstrapValue = process.env[LINEAGE_BOOTSTRAP_ENV];
  delete process.env[LINEAGE_BOOTSTRAP_ENV];
  const cached = runtimeContexts().get(artifactKey);
  if (cached) return cached;
  if (!bootstrapValue) return undefined;
  const bootstrapPath = resolve(bootstrapValue);
  let claimPath: string | undefined;
  try {
    const artifactRoot = realpathSync(artifactKey);
    if (realpathSync(dirname(bootstrapPath)) !== artifactRoot) {
      throw new Error(
        "Lineage bootstrap is outside the child artifact directory",
      );
    }
    claimPath = safeClaimName(bootstrapPath);
    renameSync(bootstrapPath, claimPath);
    if (existsSync(join(artifactRoot, ".cancelled"))) {
      throw new Error("Lineage bootstrap belongs to a cancelled child");
    }
    const context = readClaimedBootstrap(claimPath);
    claimPath = undefined;
    if (realpathSync(context.artifactDir!) !== artifactRoot) {
      throw new Error("Lineage bootstrap targets another artifact directory");
    }
    runtimeContexts().set(artifactKey, context);
    return context;
  } catch (error) {
    cleanupClaim(claimPath);
    debugLog("warn", "lineage_bootstrap_rejected", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function retireLineageBootstraps(artifactDir: string): void {
  let names: string[];
  try {
    names = readdirSync(artifactDir).filter((name) =>
      BOOTSTRAP_NAME.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    debugLog("warn", "lineage_bootstrap_retire_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const name of names) {
    try {
      rmSync(join(artifactDir, name), { force: true });
    } catch (error) {
      debugLog("warn", "lineage_bootstrap_retire_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function releaseRuntimeSpawnTreeContext(
  context: SpawnTreeContext,
): void {
  if (context.role !== "descendant" || !context.artifactDir) return;
  runtimeContexts().delete(resolve(context.artifactDir));
}

export function resetRuntimeSpawnTreeContextForTests(): void {
  runtimeContexts().clear();
}
