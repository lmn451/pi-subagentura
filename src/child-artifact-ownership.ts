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
import { basename, dirname, join, resolve } from "node:path";

export const CHILD_ARTIFACT_BOOTSTRAP_ENV = "PI_SUBAGENTURA_ARTIFACT_BOOTSTRAP";

const CHILD_ARTIFACT_BOOTSTRAP_SCHEMA_VERSION = 1;
const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_ARTIFACT_PATH_BYTES = 4096;
const BOOTSTRAP_NAME = /^\.child-artifact-bootstrap-[a-f0-9]{16}\.json$/;
const CLAIM_NAME =
  /^\.child-artifact-bootstrap-[a-f0-9]{16}\.json\.claimed-(\d+)-[a-f0-9]{16}$/;
const OWNERS_KEY = "__piSubagenturaRuntimeChildArtifactOwners";
const ownershipBrand = Symbol("childArtifactOwnership.validated");

type BootstrapEnvelope = {
  schemaVersion: typeof CHILD_ARTIFACT_BOOTSTRAP_SCHEMA_VERSION;
  artifactDir: string;
};

export interface ChildArtifactOwnership {
  readonly artifactDir: string;
  readonly processId: number;
  readonly [ownershipBrand]: true;
}

interface RuntimeOwnersGlobal {
  __piSubagenturaRuntimeChildArtifactOwners?: Map<
    string,
    ChildArtifactOwnership
  >;
}

function runtimeOwners(): Map<string, ChildArtifactOwnership> {
  const state = globalThis as typeof globalThis & RuntimeOwnersGlobal;
  return (state[OWNERS_KEY] ??= new Map());
}

function readBoundedJson(descriptor: number): unknown {
  const buffer = Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1);
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
  if (offset > MAX_BOOTSTRAP_BYTES) {
    throw new Error("Child artifact bootstrap is too large");
  }
  return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
}

function validateEnvelope(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid child artifact bootstrap envelope");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== CHILD_ARTIFACT_BOOTSTRAP_SCHEMA_VERSION) {
    throw new Error("Unsupported child artifact bootstrap schema");
  }
  if (
    typeof raw.artifactDir !== "string" ||
    raw.artifactDir.length === 0 ||
    Buffer.byteLength(raw.artifactDir, "utf8") > MAX_ARTIFACT_PATH_BYTES
  ) {
    throw new Error("Invalid child artifact bootstrap target");
  }
  return resolve(raw.artifactDir);
}

function readClaimedBootstrap(path: string): string {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > MAX_BOOTSTRAP_BYTES) {
      throw new Error("Child artifact bootstrap must be a bounded file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Child artifact bootstrap permissions are too broad");
    }
    if (
      typeof process.getuid === "function" &&
      metadata.uid !== process.getuid()
    ) {
      throw new Error("Child artifact bootstrap has the wrong owner");
    }
    rmSync(path);
    return validateEnvelope(readBoundedJson(descriptor));
  } finally {
    closeSync(descriptor);
  }
}

function safeClaimName(path: string): string {
  const name = basename(path);
  if (!BOOTSTRAP_NAME.test(name)) {
    throw new Error("Invalid child artifact bootstrap filename");
  }
  return join(
    dirname(path),
    `${name}.claimed-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
}

function cleanupClaim(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A failed claim is already rejected; cleanup is best-effort.
  }
}

export function writeChildArtifactBootstrap(artifactDir: string): string {
  const targetDir = resolve(artifactDir);
  const suffix = randomBytes(8).toString("hex");
  const path = join(targetDir, `.child-artifact-bootstrap-${suffix}.json`);
  const temporaryPath = `${path}.tmp`;
  const envelope: BootstrapEnvelope = {
    schemaVersion: CHILD_ARTIFACT_BOOTSTRAP_SCHEMA_VERSION,
    artifactDir: targetDir,
  };
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
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

export function acquireRuntimeChildArtifactOwnership():
  | ChildArtifactOwnership
  | undefined {
  const artifactValue = process.env.ARTIFACT_DIR;
  const bootstrapValue = process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV];
  delete process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV];
  if (!artifactValue) return undefined;
  const artifactKey = resolve(artifactValue);
  if (!bootstrapValue) {
    try {
      return runtimeOwners().get(realpathSync(artifactKey));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  const bootstrapPath = resolve(bootstrapValue);
  let claimPath: string | undefined;
  try {
    const artifactRoot = realpathSync(artifactKey);
    const cached = runtimeOwners().get(artifactRoot);
    if (cached) return cached;
    if (realpathSync(dirname(bootstrapPath)) !== artifactRoot) {
      throw new Error("Child artifact bootstrap is outside its target");
    }
    claimPath = safeClaimName(bootstrapPath);
    renameSync(bootstrapPath, claimPath);
    if (existsSync(join(artifactRoot, ".cancelled"))) {
      throw new Error("Child artifact bootstrap belongs to a cancelled child");
    }
    const bootstrapArtifactDir = readClaimedBootstrap(claimPath);
    claimPath = undefined;
    if (realpathSync(bootstrapArtifactDir) !== artifactRoot) {
      throw new Error("Child artifact bootstrap targets another artifact");
    }
    const ownership = Object.freeze({
      artifactDir: artifactRoot,
      processId: process.pid,
      [ownershipBrand]: true as const,
    });
    runtimeOwners().set(artifactRoot, ownership);
    return ownership;
  } catch (error) {
    cleanupClaim(claimPath);
    throw error;
  }
}

export function isCurrentChildArtifactOwnership(
  value: unknown,
): value is ChildArtifactOwnership {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChildArtifactOwnership>;
  // Pi can claim ownership through a global package before the trust picker,
  // then register hooks through a different project copy. Only the exact object
  // in the process-wide cache is authoritative, not a copy's nominal brand.
  return (
    candidate.processId === process.pid &&
    typeof candidate.artifactDir === "string" &&
    runtimeOwners().get(candidate.artifactDir) === candidate
  );
}

function claimOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

export function retireChildArtifactBootstraps(artifactDir: string): void {
  let names: string[];
  try {
    names = readdirSync(artifactDir).filter(
      (name) => BOOTSTRAP_NAME.test(name) || CLAIM_NAME.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const claim = CLAIM_NAME.exec(name);
    if (claim) {
      const ownerPid = Number(claim[1]);
      if (
        !Number.isSafeInteger(ownerPid) ||
        ownerPid < 1 ||
        claimOwnerIsAlive(ownerPid)
      ) {
        continue;
      }
    }
    rmSync(join(artifactDir, name), { force: true });
  }
}

export function resetRuntimeChildArtifactOwnershipForTests(): void {
  runtimeOwners().clear();
}
