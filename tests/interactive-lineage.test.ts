import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LINEAGE_SCHEMA_VERSION,
  cancelLineageSubtreeBestEffort,
  countLineageManifestsSync,
  hashLineageRoot,
  projectLineageStore,
  projectManifests,
  pruneTerminalLineageNodes,
  pruneTerminalLineageNodesSync,
  readLineageManifest,
  resolveLineageStorePaths,
  resolveLineageStorePathsSync,
  safeContainedPath,
  validateLineageManifest,
  writeLineageManifestAtomic,
  writeLineageManifestAtomicSync,
  type LineageManifest,
} from "../src/interactive-lineage";

const tempDirs: string[] = [];
const rootId = "root-session-1";
const rootHash = hashLineageRoot(rootId);

function manifest(
  agentId: string,
  overrides: Partial<LineageManifest> = {},
): LineageManifest {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    agentId,
    rootId,
    rootHash,
    ownerSessionId: `owner-${agentId}`,
    name: `agent ${agentId}`,
    taskPreview: `task ${agentId}`,
    startedAt: `2026-07-25T10:00:${agentId.replace(/\D/g, "").padStart(2, "0")}Z`,
    cwd: `/work/${agentId}`,
    pane: {
      backend: "zellij",
      paneId: `pane-${agentId}`,
      muxSession: "mux-session",
      windowName: "tab-a",
    },
    artifactDir: `/artifacts/${agentId}`,
    childSessionFile: `/sessions/${agentId}.jsonl`,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("interactive lineage manifests", () => {
  it("validates bounded manifests and rejects unsafe IDs, unknown keys, and invalid root hashes", () => {
    const valid = validateLineageManifest(manifest("agent-1"));

    expect(valid.agentId).toBe("agent-1");
    expect(valid.pane.muxSession).toBe("mux-session");

    expect(() => validateLineageManifest({ ...manifest("../escape") })).toThrow(
      /unsafe characters/,
    );
    expect(() =>
      validateLineageManifest({ ...manifest("agent-2"), extra: true }),
    ).toThrow(/unknown key extra/);
    expect(() =>
      validateLineageManifest({
        ...manifest("agent-2"),
        rootHash: "0".repeat(64),
      }),
    ).toThrow(/rootHash does not match/);
    expect(() =>
      validateLineageManifest(
        manifest("agent-2", { taskPreview: "x".repeat(20) }),
        {
          maxTaskPreviewBytes: 8,
        },
      ),
    ).toThrow(/taskPreview exceeds byte limit/);
  });

  it("writes atomically and leaves no manifest or temp file when validation fails", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");

    const filePath = await writeLineageManifestAtomic(
      nodesDir,
      manifest("agent-1"),
    );
    await expect(readLineageManifest(filePath)).resolves.toMatchObject({
      agentId: "agent-1",
    });

    await expect(
      writeLineageManifestAtomic(
        nodesDir,
        manifest("agent-2", { taskPreview: "x".repeat(64) }),
        {
          maxManifestBytes: 80,
        },
      ),
    ).rejects.toThrow(/exceeds byte limit/);

    const entries = await fs.readdir(nodesDir);
    expect(entries).toEqual(["agent-1.json"]);
  });

  it("removes the temp file when the atomic rename fails", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.mkdir(nodesDir, { recursive: true });
    // A directory at the target path makes rename() reject.
    await fs.mkdir(path.join(nodesDir, "agent-1.json"));

    await expect(
      writeLineageManifestAtomic(nodesDir, manifest("agent-1")),
    ).rejects.toThrow();

    expect(
      (await fs.readdir(nodesDir)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("removes the temp file when the sync atomic rename fails", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.mkdir(nodesDir, { recursive: true });
    await fs.mkdir(path.join(nodesDir, "agent-1.json"));

    expect(() =>
      writeLineageManifestAtomicSync(nodesDir, manifest("agent-1")),
    ).toThrow();

    expect(
      (await fs.readdir(nodesDir)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });
});

describe("interactive lineage path safety", () => {
  it("hashes root IDs deterministically and stores by hash-safe path", async () => {
    const dir = await tempDir();
    const paths = await resolveLineageStorePaths(dir, "root/with/slashes");
    const expectedHash = hashLineageRoot("root/with/slashes");
    const canonicalDir = await fs.realpath(dir);

    expect(hashLineageRoot("root/with/slashes")).toBe(expectedHash);
    expect(path.basename(paths.treeDir)).toBe(expectedHash);
    expect(paths.treeDir).toBe(
      path.join(canonicalDir, "subagentura", "trees", expectedHash),
    );
    expect(paths.nodesDir).toBe(path.join(paths.treeDir, "nodes"));
  });

  it("creates a missing session root before resolving paths", async () => {
    const parent = await tempDir();
    const missing = path.join(parent, "fresh-session-root");
    expect(await fs.stat(missing).catch(() => undefined)).toBeUndefined();

    const asyncPaths = await resolveLineageStorePaths(missing, "root-a");
    const syncPaths = resolveLineageStorePathsSync(missing, "root-a");

    expect((await fs.stat(missing)).isDirectory()).toBe(true);
    expect(asyncPaths).toEqual(syncPaths);
  });

  it("rejects traversal and symlink components when resolving contained paths", async () => {
    const dir = await tempDir();
    const inside = path.join(dir, "inside");
    await fs.mkdir(inside);
    await fs.writeFile(path.join(inside, "file.txt"), "ok");
    const canonicalInside = await fs.realpath(inside);

    await expect(
      safeContainedPath(dir, path.join(inside, "file.txt")),
    ).resolves.toBe(path.join(canonicalInside, "file.txt"));
    await expect(
      safeContainedPath(dir, path.join(dir, "..", "outside")),
    ).rejects.toThrow(/escapes lineage root/);

    const outside = await tempDir();
    const link = path.join(dir, "link");
    await fs.symlink(outside, link);
    await expect(
      safeContainedPath(dir, path.join(link, "file.txt")),
    ).rejects.toThrow(/symlink/);
  });

  it("accepts paths expressed through either a root alias or its real path", async () => {
    const dir = await tempDir();
    const alias = path.join(await tempDir(), "root-alias");
    const inside = path.join(dir, "inside");
    await fs.mkdir(inside);
    await fs.symlink(dir, alias);
    const canonicalInside = await fs.realpath(inside);

    await expect(
      safeContainedPath(alias, path.join(alias, "inside")),
    ).resolves.toBe(canonicalInside);
    await expect(safeContainedPath(alias, inside)).resolves.toBe(
      canonicalInside,
    );
  });
});

describe("interactive lineage projection", () => {
  it("projects deterministically while marking orphan and stale nodes non-actionable", async () => {
    const projection = await projectManifests(
      [
        manifest("child-2", { parentAgentId: "root" }),
        manifest("root"),
        manifest("orphan", { parentAgentId: "missing" }),
        manifest("child-1", { parentAgentId: "root" }),
      ],
      rootHash,
      (candidate) => candidate.agentId === "child-2",
    );

    expect(projection.roots.map((node) => node.manifest.agentId)).toEqual([
      "root",
      "orphan",
    ]);
    expect(
      projection.roots[0]?.children.map((node) => node.manifest.agentId),
    ).toEqual(["child-1", "child-2"]);
    expect(
      projection.nonActionable.map((node) => [
        node.manifest.agentId,
        node.reasons,
      ]),
    ).toEqual([
      ["orphan", ["orphan"]],
      ["child-2", ["stale"]],
    ]);
    expect(projection.issues.map((issue) => issue.kind)).toEqual([
      "orphan",
      "stale",
    ]);
  });

  it("does not hang on cycles and places cyclic nodes in a non-actionable bucket", async () => {
    const projection = await projectManifests(
      [
        manifest("a", { parentAgentId: "c" }),
        manifest("b", { parentAgentId: "a" }),
        manifest("c", { parentAgentId: "b" }),
      ],
      rootHash,
    );

    expect(projection.roots).toEqual([]);
    expect(
      projection.nonActionable.map((node) => node.manifest.agentId),
    ).toEqual(["a", "b", "c"]);
    expect(projection.issues.every((issue) => issue.kind === "cycle")).toBe(
      true,
    );
  });

  it("reports malformed files and enforces node, depth, and projection byte caps", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.mkdir(nodesDir);
    await writeLineageManifestAtomic(nodesDir, manifest("root"));
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-1", { parentAgentId: "root" }),
    );
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-2", { parentAgentId: "child-1" }),
    );
    await fs.writeFile(path.join(nodesDir, "z-bad.json"), "not json");

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      () => false,
      {
        maxDepth: 1,
        maxNodes: 4,
        maxProjectionBytes: 10_000,
      },
    );

    expect(projection.truncated).toBe(true);
    expect(projection.issues.map((issue) => issue.kind)).toContain("malformed");
    expect(projection.issues.map((issue) => issue.kind)).toContain("truncated");
  });

  it("enforces the projection byte cap", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("root"));
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child-1", { parentAgentId: "root" }),
    );

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      () => false,
      {
        maxProjectionBytes: 100,
      },
    );

    expect(projection.truncated).toBe(true);
    expect(
      projection.issues.some(
        (issue) => issue.reason === "projection byte cap reached",
      ),
    ).toBe(true);
  });
});

describe("interactive lineage node cap", () => {
  it("keeps live and recent nodes when the cap drops manifests", async () => {
    // Ids are deliberately anti-correlated with liveness so a filename sort
    // would keep the wrong subset.
    const all = [
      manifest("a01", { startedAt: "2026-07-25T10:00:01Z" }),
      manifest("a02", { startedAt: "2026-07-25T10:00:02Z" }),
      manifest("z98", { startedAt: "2026-07-25T10:00:58Z" }),
      manifest("z99", { startedAt: "2026-07-25T10:00:59Z" }),
    ];
    const live = new Set(["z99", "a01"]);

    const projection = await projectManifests(
      all,
      rootHash,
      (candidate) => !live.has(candidate.agentId),
      { maxNodes: 2 },
    );

    const retained = new Set(
      [...projection.roots, ...projection.nonActionable].map(
        (node) => node.manifest.agentId,
      ),
    );
    expect([...retained].sort()).toEqual(["a01", "z99"]);
    expect(projection.truncated).toBe(true);
    expect(
      projection.issues.filter((issue) => issue.kind === "truncated").length,
    ).toBe(2);
    // The raw set is still complete so cancellation can reach dropped nodes.
    expect(projection.manifests).toHaveLength(4);
  });

  it("budgets live nodes while retaining their dead ancestor closure", async () => {
    const live = new Set(["older-child", "newer-child"]);
    const projection = await projectManifests(
      [
        manifest("older-parent", {
          startedAt: "2026-07-25T10:00:01Z",
        }),
        manifest("older-child", {
          parentAgentId: "older-parent",
          startedAt: "2026-07-25T10:00:50Z",
        }),
        manifest("newer-parent", {
          startedAt: "2026-07-25T10:00:02Z",
        }),
        manifest("newer-child", {
          parentAgentId: "newer-parent",
          startedAt: "2026-07-25T10:00:59Z",
        }),
      ],
      rootHash,
      (candidate) => !live.has(candidate.agentId),
      { maxNodes: 2 },
    );

    expect(projection.roots).toHaveLength(2);
    const retainedChildren = projection.roots.map((root) => ({
      parent: root.manifest.agentId,
      child: root.children[0]?.manifest.agentId,
      state: root.children[0]?.state,
      reasons: root.children[0]?.reasons,
    }));
    expect(retainedChildren).toEqual([
      {
        parent: "older-parent",
        child: "older-child",
        state: "actionable",
        reasons: [],
      },
      {
        parent: "newer-parent",
        child: "newer-child",
        state: "actionable",
        reasons: [],
      },
    ]);
  });

  it("keeps a probe failure visible instead of treating it as stale", async () => {
    const projection = await projectManifests(
      [manifest("unknown-pane")],
      rootHash,
      () => {
        throw new Error("mux unavailable");
      },
      { maxNodes: 1 },
    );

    expect(projection.roots[0]?.manifest.agentId).toBe("unknown-pane");
    expect(projection.roots[0]?.state).toBe("actionable");
    expect(projection.issues).not.toContainEqual(
      expect.objectContaining({ kind: "stale" }),
    );
  });

  it("retains unsupported pane backends as explicitly non-actionable", async () => {
    const unsupported = manifest("unsupported", {
      pane: { backend: "remote", paneId: "remote-pane" },
    });

    const projection = await projectManifests(
      [unsupported],
      rootHash,
      () => false,
      { maxNodes: 1 },
    );
    expect(projection.roots).toHaveLength(1);
    expect(projection.roots[0]?.manifest).toBe(unsupported);
    expect(projection.roots[0]?.state).toBe("non-actionable");
    expect(projection.nonActionable).toHaveLength(1);
    expect(projection.nonActionable[0]?.manifest).toBe(unsupported);
    expect(projection.nonActionable[0]?.reasons).toContain("malformed");
    expect(projection.manifests).toEqual([unsupported]);
  });

  it("keeps Herdr lineage nodes actionable", async () => {
    const herdr = manifest("herdr-agent", {
      pane: {
        backend: "herdr",
        paneId: "w1:p2",
        muxSession: "/tmp/herdr.sock",
      },
    });

    const projection = await projectManifests([herdr], rootHash, () => false, {
      maxNodes: 1,
    });
    expect(projection.roots[0]?.state).toBe("actionable");
    expect(projection.roots[0]?.manifest).toBe(herdr);
  });

  it("reads manifests newest-first so the read window follows a live tree", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("aaa1"));
    await writeLineageManifestAtomic(nodesDir, manifest("bbb2"));
    // Make the lexicographically-first file the OLDEST on disk.
    await fs.utimes(path.join(nodesDir, "aaa1.json"), new Date(0), new Date(0));

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      () => false,
      { maxNodes: 1 },
    );

    const retained = [...projection.roots, ...projection.nonActionable].map(
      (node) => node.manifest.agentId,
    );
    expect(retained).toEqual(["bbb2"]);
  });

  it("retains stale closure without charging the active-node cap", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("stale-parent"));
    await fs.utimes(
      path.join(nodesDir, "stale-parent.json"),
      new Date(0),
      new Date(0),
    );
    for (let index = 0; index < 4; index++) {
      const id = `dead-filler-${index}`;
      await writeLineageManifestAtomic(nodesDir, manifest(id));
      const time = new Date((index + 1) * 1000);
      await fs.utimes(path.join(nodesDir, `${id}.json`), time, time);
    }
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("live-child", {
        parentAgentId: "stale-parent",
        startedAt: "2026-07-25T10:00:59Z",
      }),
    );
    await fs.utimes(
      path.join(nodesDir, "live-child.json"),
      new Date(10_000),
      new Date(10_000),
    );
    await writeLineageManifestAtomic(nodesDir, manifest("live-peer"));
    await fs.utimes(
      path.join(nodesDir, "live-peer.json"),
      new Date(9_000),
      new Date(9_000),
    );

    const projection = await projectLineageStore(
      nodesDir,
      rootHash,
      (candidate) =>
        candidate.agentId !== "live-child" && candidate.agentId !== "live-peer",
      { maxNodes: 2 },
    );

    const rootById = new Map(
      projection.roots.map((root) => [root.manifest.agentId, root]),
    );
    expect(rootById.size).toBe(2);
    expect(rootById.get("stale-parent")?.children[0]?.manifest.agentId).toBe(
      "live-child",
    );
    expect(rootById.get("stale-parent")?.children[0]?.state).toBe("actionable");
    expect(rootById.get("live-peer")?.state).toBe("actionable");
  });

  it("probes staleness with bounded concurrency instead of one at a time", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      manifest(`n${String(index).padStart(2, "0")}`),
    );
    let inFlight = 0;
    let peakInFlight = 0;

    await projectManifests(
      many,
      rootHash,
      async () => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return false;
      },
      { concurrency: 4 },
    );

    expect(peakInFlight).toBeGreaterThan(1);
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });

  it("probes each manifest at most once per projection", async () => {
    const probed: string[] = [];

    await projectManifests(
      [manifest("root"), manifest("child", { parentAgentId: "root" })],
      rootHash,
      (candidate) => {
        probed.push(candidate.agentId);
        return false;
      },
    );

    expect(probed.sort()).toEqual(["child", "root"]);
  });
});

describe("interactive lineage pruning", () => {
  it("removes dead leaf manifests and keeps a dead parent with live children", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("dead-parent"));
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("live-child", { parentAgentId: "dead-parent" }),
    );
    await writeLineageManifestAtomic(nodesDir, manifest("dead-leaf"));

    const result = await pruneTerminalLineageNodes(
      nodesDir,
      (candidate) => candidate.agentId !== "live-child",
    );

    // Unlinking the dead parent would orphan its live child and hide it.
    expect(result.pruned).toEqual(["dead-leaf"]);
    expect(result.retained).toBe(2);
    expect(result.active).toBe(1);
    expect((await fs.readdir(nodesDir)).sort()).toEqual([
      "dead-parent.json",
      "live-child.json",
    ]);
  });

  it("leaves an unreadable manifest in place for the projection to report", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.mkdir(nodesDir, { recursive: true });
    await fs.writeFile(path.join(nodesDir, "broken.json"), "not json");

    const result = await pruneTerminalLineageNodes(nodesDir, () => true);

    expect(result.pruned).toEqual([]);
    expect(result.active).toBe(1);
    expect(await fs.readdir(nodesDir)).toEqual(["broken.json"]);
  });

  it("treats a missing nodes directory as empty for synchronous admission helpers", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "missing-nodes");

    expect(countLineageManifestsSync(nodesDir)).toBe(0);
    expect(pruneTerminalLineageNodesSync(nodesDir, () => true)).toEqual({
      pruned: [],
      retained: 0,
      active: 0,
    });
  });

  it("propagates non-ENOENT nodes directory listing failures", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await fs.writeFile(nodesDir, "not a directory");

    expect(() => countLineageManifestsSync(nodesDir)).toThrow(
      /ENOTDIR|not a directory/i,
    );
    expect(() => pruneTerminalLineageNodesSync(nodesDir, () => true)).toThrow(
      /ENOTDIR|not a directory/i,
    );
  });

  it("prunes synchronously for the spawn gate", async () => {
    const dir = await tempDir();
    const nodesDir = path.join(dir, "nodes");
    await writeLineageManifestAtomic(nodesDir, manifest("gone"));
    await writeLineageManifestAtomic(nodesDir, manifest("here"));

    const result = pruneTerminalLineageNodesSync(
      nodesDir,
      (candidate) => candidate.agentId === "gone",
    );

    expect(result.pruned).toEqual(["gone"]);
    expect(result.retained).toBe(1);
    expect(result.active).toBe(1);
    expect(countLineageManifestsSync(nodesDir)).toBe(1);
  });
});

describe("interactive lineage cancellation", () => {
  it("cancels deepest-first and continues after failures", async () => {
    const projection = await projectManifests(
      [
        manifest("root"),
        manifest("child-1", { parentAgentId: "root" }),
        manifest("child-2", { parentAgentId: "root" }),
        manifest("grandchild", { parentAgentId: "child-1" }),
      ],
      rootHash,
      (candidate) => candidate.agentId === "child-2",
    );
    const root = projection.roots[0];
    expect(root).toBeDefined();
    const calls: string[] = [];

    const result = await cancelLineageSubtreeBestEffort(root!, {
      isStale: (node) => {
        calls.push(`stale:${node.manifest.agentId}`);
        return node.manifest.agentId === "child-2";
      },
      isTerminal: (node) => {
        calls.push(`terminal:${node.manifest.agentId}`);
        return node.manifest.agentId === "child-1";
      },
      cancel: (node) => {
        calls.push(`cancel:${node.manifest.agentId}`);
        if (node.manifest.agentId === "grandchild") {
          throw new Error("close failed");
        }
      },
    });

    expect(result.attempted.map((item) => [item.agentId, item.status])).toEqual(
      [
        ["grandchild", "failed"],
        ["child-1", "already-terminal"],
        ["child-2", "stale"],
        ["root", "cancelled"],
      ],
    );
    expect(calls).toEqual([
      "stale:grandchild",
      "terminal:grandchild",
      "cancel:grandchild",
      "stale:child-1",
      "terminal:child-1",
      "stale:root",
      "terminal:root",
      "cancel:root",
    ]);
    expect(result.failed).toMatchObject([
      { agentId: "grandchild", status: "failed" },
    ]);
    expect(result.cancelled).toEqual(["root"]);
  });

  it("cancels descendants deeper than maxDepth and reports the truncation", async () => {
    // A chain root → d1 … → d5 with maxDepth 2: the projection stops at d2.
    const chain = [manifest("d0")];
    for (let depth = 1; depth <= 5; depth++) {
      chain.push(manifest(`d${depth}`, { parentAgentId: `d${depth - 1}` }));
    }
    const projection = await projectManifests(chain, rootHash, () => false, {
      maxDepth: 2,
    });
    const root = projection.roots[0];
    expect(root).toBeDefined();
    expect(flattenAgentIds(projection.roots).sort()).toEqual([
      "d0",
      "d1",
      "d2",
    ]);

    const cancelled: string[] = [];
    const result = await cancelLineageSubtreeBestEffort(root!, {
      allManifests: projection.manifests,
      projectionTruncated: projection.truncated,
      isStale: () => false,
      isTerminal: () => false,
      cancel: (node) => {
        cancelled.push(node.manifest.agentId);
      },
    });

    // Every descendant, not just the ones the depth cap left in the tree.
    expect([...cancelled].sort()).toEqual(["d0", "d1", "d2", "d3", "d4", "d5"]);
    expect([...result.recovered].sort()).toEqual(["d3", "d4", "d5"]);
    expect(result.projectionTruncated).toBe(true);
    expect(result.failed).toEqual([]);
    // Deepest-first ordering is preserved for the recovered nodes too.
    expect(cancelled[0]).toBe("d5");
    expect(cancelled.at(-1)).toBe("d0");
  });

  it("cancels nodes the node cap dropped from the projection", async () => {
    const manifests = [
      manifest("root", { startedAt: "2026-07-25T10:00:09Z" }),
      manifest("kept", {
        parentAgentId: "root",
        startedAt: "2026-07-25T10:00:08Z",
      }),
      manifest("dropped", {
        parentAgentId: "root",
        startedAt: "2026-07-25T10:00:01Z",
      }),
    ];
    const projection = await projectManifests(
      manifests,
      rootHash,
      () => false,
      { maxNodes: 2 },
    );
    const root = projection.roots[0];
    expect(root).toBeDefined();
    expect(flattenAgentIds(projection.roots).sort()).toEqual(["kept", "root"]);

    const cancelled: string[] = [];
    const result = await cancelLineageSubtreeBestEffort(root!, {
      allManifests: manifests,
      projectionTruncated: projection.truncated,
      isStale: () => false,
      isTerminal: () => false,
      cancel: (node) => {
        cancelled.push(node.manifest.agentId);
      },
    });

    expect(cancelled.sort()).toEqual(["dropped", "kept", "root"]);
    expect(result.recovered).toEqual(["dropped"]);
  });

  it("reports orphan, cycle and cap skips in their own buckets", async () => {
    const projection = await projectManifests(
      [
        manifest("root"),
        manifest("orphaned", { parentAgentId: "root" }),
        manifest("stale-child", { parentAgentId: "root" }),
      ],
      rootHash,
      (candidate) => candidate.agentId === "stale-child",
    );
    const root = projection.roots[0]!;
    // Force distinct non-actionable reasons onto the two children.
    const children = root.children;
    const orphaned = children.find(
      (node) => node.manifest.agentId === "orphaned",
    )!;
    (orphaned as { reasons: string[] }).reasons = ["orphan"];
    (orphaned as { state: string }).state = "non-actionable";

    const result = await cancelLineageSubtreeBestEffort(root, {
      isStale: () => false,
      isTerminal: () => false,
      cancel: () => {},
    });

    expect(result.orphan).toEqual(["orphaned"]);
    expect(result.stale).toEqual(["stale-child"]);
    expect(result.cancelled).toEqual(["root"]);
    expect(result.cycle).toEqual([]);
  });
});

function flattenAgentIds(
  nodes: { manifest: LineageManifest; children: any[] }[],
): string[] {
  const ids: string[] = [];
  const visit = (node: { manifest: LineageManifest; children: any[] }) => {
    ids.push(node.manifest.agentId);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}
