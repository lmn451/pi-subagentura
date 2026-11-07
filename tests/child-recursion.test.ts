import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINEAGE_SCHEMA_VERSION,
  hashLineageRoot,
  projectLineageStore,
  writeLineageManifestAtomic,
  type LineageManifest,
} from "../src/interactive-lineage";
import {
  cancelInteractiveDescendantByState,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";

import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
} from "../src/session-scope";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "child-recursion-"));
  tempDirs.push(dir);
  return dir;
}

function manifest(
  agentId: string,
  rootId: string,
  overrides: Partial<LineageManifest> = {},
): LineageManifest {
  return {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    agentId,
    rootId,
    rootHash: hashLineageRoot(rootId),
    ownerSessionId: `owner-${agentId}`,
    name: agentId,
    taskPreview: `task ${agentId}`,
    startedAt: "2026-07-25T10:00:00.000Z",
    cwd: `/work/${agentId}`,
    pane: {
      backend: "tmux",
      paneId: `%${agentId}`,
      muxSession: "recursive-test",
      windowName: agentId,
    },
    artifactDir: `/artifacts/${agentId}`,
    childSessionFile: `/sessions/${agentId}.jsonl`,
    ...overrides,
  };
}

afterEach(() => {
  clearSessionScopes();
  __resetMuxInstances();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recursive interactive children", () => {
  it("reconstructs a child and grandchild hierarchy across different cwd values", async () => {
    const nodesDir = join(tempDir(), "nodes");
    const rootId = "root-session";
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("child", rootId, { cwd: "/workspace/child" }),
    );
    await writeLineageManifestAtomic(
      nodesDir,
      manifest("grandchild", rootId, {
        parentAgentId: "child",
        cwd: "/other/workspace/grandchild",
      }),
    );

    const projection = await projectLineageStore(
      nodesDir,
      hashLineageRoot(rootId),
      () => false,
    );

    expect(projection.roots).toHaveLength(1);
    expect(projection.roots[0]?.manifest.agentId).toBe("child");
    expect(projection.roots[0]?.manifest.cwd).toBe("/workspace/child");
    expect(projection.roots[0]?.children[0]?.manifest.agentId).toBe(
      "grandchild",
    );
    expect(projection.roots[0]?.children[0]?.manifest.cwd).toBe(
      "/other/workspace/grandchild",
    );
  });

  it("leaves descendant delivery to its owner and kills on unknown liveness", () => {
    const artifactDir = join(tempDir(), "artifact");
    mkdirSync(artifactDir, { recursive: true });
    const killPane = vi.fn();
    __setTmuxMultiplexer({
      getPaneLiveness: vi.fn(() => "unknown"),
      killPane,
    } as never);
    const state: InteractiveSubagentState = {
      id: "grandchild",
      name: "grandchild",
      task: "nested work",
      paneId: "%42",
      mux: "tmux",
      muxSession: "recursive-test",
      sessionFile: "/sessions/grandchild.jsonl",
      cwd: "/workspace/grandchild",
      parentSessionId: "owner-grandchild",
      startedAt: Date.now(),
      status: "running",
      attachCommand: "attach",
      selectPaneCommand: "focus",
      launchScriptFile: "/launch/grandchild.sh",
      artifactDir,
    };

    const scope = registerSessionScope(createSessionScope({} as never));
    cancelInteractiveDescendantByState(state);

    expect(scope.interactiveStates.has(state.id)).toBe(false);
    expect(state.deliveryReceipts).toBeUndefined();
    expect(state.status).toBe("cancelled");
    expect(existsSync(join(artifactDir, ".cancelled"))).toBe(true);
    expect(readFileSync(join(artifactDir, "events.ndjson"), "utf8")).toContain(
      '"outcome":"cancelled"',
    );
    expect(killPane).toHaveBeenCalledWith("%42", "recursive-test");
  });
});
