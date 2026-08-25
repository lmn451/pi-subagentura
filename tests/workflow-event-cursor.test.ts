import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifactReads = vi.hoisted(() => ({
  fullReads: 0,
  batchOffsets: [] as number[],
}));

vi.mock("../src/artifact", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/artifact")>();
  return {
    ...actual,
    readEvents: (...args: Parameters<typeof actual.readEvents>) => {
      artifactReads.fullReads++;
      return actual.readEvents(...args);
    },
    readEventBatch: (...args: Parameters<typeof actual.readEventBatch>) => {
      artifactReads.batchOffsets.push(args[1] ?? 0);
      return actual.readEventBatch(...args);
    },
  };
});

import { appendEvent, artifactPath } from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { awaitInteractiveResult } from "../src/workflow-worker";

let temporaryDirectory: string | undefined;

afterEach(() => {
  __setTmuxMultiplexer(undefined);
  artifactReads.fullReads = 0;
  artifactReads.batchOffsets.length = 0;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

it("continues workflow artifact reads from the previous byte offset", async () => {
  temporaryDirectory = mkdtempSync(
    join(tmpdir(), "subagentura-workflow-cursor-"),
  );
  const id = "cursor-agent";
  const art = artifactPath(temporaryDirectory, id);
  mkdirSync(art.dir, { recursive: true });
  writeFileSync(art.statusFile, "");
  appendEvent(art, { ts: 1, type: "started", status: "running" });
  const state = {
    id,
    name: id,
    task: "cursor regression",
    paneId: "%1",
    mux: "tmux",
    sessionFile: join(temporaryDirectory, "session.jsonl"),
    cwd: temporaryDirectory,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "tmux attach -t test",
    selectPaneCommand: "tmux select-pane -t test",
    launchScriptFile: join(temporaryDirectory, "launch.sh"),
    artifactDir: art.dir,
  } as InteractiveSubagentState;
  let probeCount = 0;
  __setTmuxMultiplexer({
    getPaneLiveness: vi.fn(() => "alive"),
    getPaneLivenessAsync: vi.fn(async () => {
      probeCount++;
      if (probeCount === 1) {
        appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });
      }
      return "alive";
    }),
  } as never);

  await awaitInteractiveResult(state, undefined, 1);

  expect(artifactReads.fullReads).toBe(0);
  expect(artifactReads.batchOffsets[0]).toBe(0);
  expect(artifactReads.batchOffsets.some((offset) => offset > 0)).toBe(true);
  expect(
    artifactReads.batchOffsets.filter((offset) => offset === 0),
  ).toHaveLength(1);
});
