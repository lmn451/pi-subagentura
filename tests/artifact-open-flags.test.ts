import { expect, it, vi } from "vitest";
import {
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  artifactPath,
  ensureArtifactDir,
  loadInteractiveStates,
  snapshotOutputForEvent,
  stateFilePath,
} from "../src/artifact";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});
it("opens state and staged output without waiting for a writer", () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-open-"));
  try {
    const art = artifactPath(root, "child");
    ensureArtifactDir(art);
    const state = stateFilePath(root);
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, "{}");
    writeFileSync(art.outputFile, "text");
    loadInteractiveStates(root);
    snapshotOutputForEvent(art, "event");
    for (const path of [state, art.outputFile]) {
      const flags = vi
        .mocked(openSync)
        .mock.calls.find(([file]) => file === path)?.[1];
      expect(typeof flags).toBe("number");
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
