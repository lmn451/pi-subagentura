/**
 * Regression coverage for polling protocol-v2 artifact completion events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompletionEvent, artifactPath } from "../src/artifact";
import { importFresh } from "./test-utils";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-stale-ctx-"));
}

function makeState(): {
  id: string;
  artifactDir: string;
  state: import("../src/interactive-tmux").InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const artifactDir = join(makeTmp(), id);
  const state: import("../src/interactive-tmux").InteractiveSubagentState = {
    id,
    name: "Test",
    task: "t",
    paneId: "%99",
    sessionFile: "/tmp/sess.jsonl",
    cwd: "/tmp",
    startedAt: Date.now(),
    mux: "tmux",
    status: "running",
    attachCommand: "tmux attach -t sess",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: "/tmp/launch.sh",
    artifactDir,
  };
  return { id, artifactDir, state };
}

describe("pollArtifactChanges v2 lifecycle", () => {
  beforeEach(() => {
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    // The poller calls isPaneAlive → child_process.execFileSync. Default the
    // tmux mock so the pane is reported alive and the status-update branch
    // doesn't trip on a missing tmux.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string, args: string[]) => {
        if (args[0] === "display-message") return Buffer.from("#99");
        return "";
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("node:child_process");
    const g = globalThis as any;
    g.__piSubagenturaPiRef = undefined;
  });

  it("advances the artifact cursor for v2 error completions", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    mod.interactiveSubagentRegistry.set(state.id, state);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "error",
      source: "agent_end",
      errorMessage: "boom",
    });

    await expect(mod.pollArtifactChanges({} as any)).resolves.toBeUndefined();
    expect(state.eventByteCursor).toBeGreaterThan(0);
  });
});
