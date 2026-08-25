import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEAGE_BOOTSTRAP_ENV,
  acquireRuntimeSpawnTreeContext,
  createDescendantSpawnTreeContext,
  createRootSpawnTreeContext,
  retireLineageBootstraps,
  resetRuntimeSpawnTreeContextForTests,
  parseSpawnTreeContext,
  writeLineageBootstrap,
} from "../src/spawn-tree-context";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-tree-context-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetRuntimeSpawnTreeContextForTests();
  delete process.env[LINEAGE_BOOTSTRAP_ENV];
  delete process.env.PI_SUBAGENTURA_AGENT_ID;
  delete process.env.PI_SUBAGENTURA_ROOT_ID;
  delete process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT;
  delete process.env.PI_SUBAGENTURA_DEPTH;
  delete process.env.PI_SUBAGENTURA_MAX_DEPTH;
  delete process.env.PI_SUBAGENTURA_MAX_NODES;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("explicit lineage context", () => {
  it("consumes a one-use bootstrap and retains context only in this process", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const parent = createRootSpawnTreeContext("root-session", root);
    const child = createDescendantSpawnTreeContext(
      parent,
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    const acquired = acquireRuntimeSpawnTreeContext(artifactDir);

    expect(acquired).toEqual(child);
    expect(existsSync(bootstrapPath)).toBe(false);
    expect(process.env[LINEAGE_BOOTSTRAP_ENV]).toBeUndefined();
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBe(acquired);
  });

  it("does not recover authority from a bootstrap path inherited after consumption", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toEqual(child);
    resetRuntimeSpawnTreeContextForTests();

    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
  });

  it("rejects a bootstrap aimed at another artifact without deleting it", () => {
    const root = tempDir();
    const sourceArtifact = join(root, "source-agent");
    const expectedArtifact = join(root, "expected-agent");
    mkdirSync(expectedArtifact, { recursive: true });
    const source = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "source-agent",
      sourceArtifact,
    );
    const bootstrapPath = writeLineageBootstrap(sourceArtifact, source);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    expect(acquireRuntimeSpawnTreeContext(expectedArtifact)).toBeUndefined();
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(process.env[LINEAGE_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("rejects and removes an over-permissive bootstrap", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    chmodSync(bootstrapPath, 0o644);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
    expect(existsSync(bootstrapPath)).toBe(false);
  });

  it("never claims or deletes an unrelated artifact file", () => {
    const artifactDir = join(tempDir(), "child-agent");
    mkdirSync(artifactDir, { recursive: true });
    const outputPath = join(artifactDir, "output.md");
    writeFileSync(outputPath, "keep me", { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = outputPath;

    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
    expect(readFileSync(outputPath, "utf8")).toBe("keep me");
  });

  it("rejects expired or cancelled bootstrap credentials", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const expiredPath = writeLineageBootstrap(artifactDir, child);
    const expired = JSON.parse(readFileSync(expiredPath, "utf8"));
    expired.issuedAt = 0;
    expired.expiresAt = 1;
    writeFileSync(expiredPath, JSON.stringify(expired), { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = expiredPath;
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
    expect(existsSync(expiredPath)).toBe(false);

    const cancelledPath = writeLineageBootstrap(artifactDir, child);
    writeFileSync(join(artifactDir, ".cancelled"), "", { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = cancelledPath;
    expect(acquireRuntimeSpawnTreeContext(artifactDir)).toBeUndefined();
    expect(existsSync(cancelledPath)).toBe(false);
  });

  it("retires only strict bootstrap files", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantSpawnTreeContext(
      createRootSpawnTreeContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    const outputPath = join(artifactDir, "output.md");
    writeFileSync(outputPath, "keep me", { mode: 0o600 });

    retireLineageBootstraps(artifactDir);

    expect(existsSync(bootstrapPath)).toBe(false);
    expect(readFileSync(outputPath, "utf8")).toBe("keep me");
  });

  it("enforces bounded identities and tree limits", () => {
    expect(() => createRootSpawnTreeContext("root id with spaces")).toThrow(
      /rootId/,
    );
    const root = createRootSpawnTreeContext("root-session", tempDir());
    expect(() => parseSpawnTreeContext({ ...root, maxNodes: 4097 })).toThrow(
      /maxNodes/,
    );
    expect(() => parseSpawnTreeContext({ ...root, maxDepth: 65 })).toThrow(
      /maxDepth/,
    );
  });

  it("ignores legacy ambient lineage variables", () => {
    process.env.PI_SUBAGENTURA_AGENT_ID = "live-agent";
    process.env.PI_SUBAGENTURA_ROOT_ID = "live-root";
    process.env.PI_SUBAGENTURA_LINEAGE_SESSION_ROOT = tempDir();
    process.env.PI_SUBAGENTURA_DEPTH = "2";
    process.env.PI_SUBAGENTURA_MAX_DEPTH = "8";
    process.env.PI_SUBAGENTURA_MAX_NODES = "256";

    expect(acquireRuntimeSpawnTreeContext(tempDir())).toBeUndefined();
  });
});
