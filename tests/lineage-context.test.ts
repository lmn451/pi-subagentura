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
  acquireRuntimeLineageContext,
  createDescendantLineageContext,
  createRootLineageContext,
  retireLineageBootstraps,
  resetRuntimeLineageContextForTests,
  validateLineageContext,
  writeLineageBootstrap,
} from "../src/lineage-context";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lineage-context-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetRuntimeLineageContextForTests();
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
    const parent = createRootLineageContext("root-session", root);
    const child = createDescendantLineageContext(
      parent,
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    const acquired = acquireRuntimeLineageContext(artifactDir);

    expect(acquired).toEqual(child);
    expect(existsSync(bootstrapPath)).toBe(false);
    expect(process.env[LINEAGE_BOOTSTRAP_ENV]).toBeUndefined();
    expect(acquireRuntimeLineageContext(artifactDir)).toBe(acquired);
  });

  it("does not recover authority from a bootstrap path inherited after consumption", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantLineageContext(
      createRootLineageContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;
    expect(acquireRuntimeLineageContext(artifactDir)).toEqual(child);
    resetRuntimeLineageContextForTests();

    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;
    expect(acquireRuntimeLineageContext(artifactDir)).toBeUndefined();
  });

  it("rejects a bootstrap aimed at another artifact without deleting it", () => {
    const root = tempDir();
    const sourceArtifact = join(root, "source-agent");
    const expectedArtifact = join(root, "expected-agent");
    mkdirSync(expectedArtifact, { recursive: true });
    const source = createDescendantLineageContext(
      createRootLineageContext("root-session", root),
      "source-agent",
      sourceArtifact,
    );
    const bootstrapPath = writeLineageBootstrap(sourceArtifact, source);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    expect(acquireRuntimeLineageContext(expectedArtifact)).toBeUndefined();
    expect(existsSync(bootstrapPath)).toBe(true);
    expect(process.env[LINEAGE_BOOTSTRAP_ENV]).toBeUndefined();
  });

  it("rejects and removes an over-permissive bootstrap", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantLineageContext(
      createRootLineageContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const bootstrapPath = writeLineageBootstrap(artifactDir, child);
    chmodSync(bootstrapPath, 0o644);
    process.env[LINEAGE_BOOTSTRAP_ENV] = bootstrapPath;

    expect(acquireRuntimeLineageContext(artifactDir)).toBeUndefined();
    expect(existsSync(bootstrapPath)).toBe(false);
  });

  it("never claims or deletes an unrelated artifact file", () => {
    const artifactDir = join(tempDir(), "child-agent");
    mkdirSync(artifactDir, { recursive: true });
    const outputPath = join(artifactDir, "output.md");
    writeFileSync(outputPath, "keep me", { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = outputPath;

    expect(acquireRuntimeLineageContext(artifactDir)).toBeUndefined();
    expect(readFileSync(outputPath, "utf8")).toBe("keep me");
  });

  it("rejects expired or cancelled bootstrap credentials", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantLineageContext(
      createRootLineageContext("root-session", root),
      "child-agent",
      artifactDir,
    );
    const expiredPath = writeLineageBootstrap(artifactDir, child);
    const expired = JSON.parse(readFileSync(expiredPath, "utf8"));
    expired.issuedAt = 0;
    expired.expiresAt = 1;
    writeFileSync(expiredPath, JSON.stringify(expired), { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = expiredPath;
    expect(acquireRuntimeLineageContext(artifactDir)).toBeUndefined();
    expect(existsSync(expiredPath)).toBe(false);

    const cancelledPath = writeLineageBootstrap(artifactDir, child);
    writeFileSync(join(artifactDir, ".cancelled"), "", { mode: 0o600 });
    process.env[LINEAGE_BOOTSTRAP_ENV] = cancelledPath;
    expect(acquireRuntimeLineageContext(artifactDir)).toBeUndefined();
    expect(existsSync(cancelledPath)).toBe(false);
  });

  it("retires only strict bootstrap files", () => {
    const root = tempDir();
    const artifactDir = join(root, "child-agent");
    const child = createDescendantLineageContext(
      createRootLineageContext("root-session", root),
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
    expect(() => createRootLineageContext("root id with spaces")).toThrow(
      /rootId/,
    );
    const root = createRootLineageContext("root-session", tempDir());
    expect(() => validateLineageContext({ ...root, maxNodes: 4097 })).toThrow(
      /maxNodes/,
    );
    expect(() => validateLineageContext({ ...root, maxDepth: 65 })).toThrow(
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

    expect(acquireRuntimeLineageContext(tempDir())).toBeUndefined();
  });
});
