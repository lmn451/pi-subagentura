/**
 * Regression coverage for polling protocol-v2 artifact completion events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompletionEvent, artifactPath } from "../src/artifact";
import { importFresh } from "./test-utils";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import { registerInteractiveSubagentState } from "../src/interactive-tmux";
import { createTestSessionScope } from "./session-scope-fixture";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-stale-ctx-"));
}

function makeState(): {
  id: string;
  artifactDir: string;
  state: InteractiveSubagentState;
} {
  const id = "id-" + Math.random().toString(36).slice(2, 8);
  const artifactDir = join(makeTmp(), id);
  const state: InteractiveSubagentState = {
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
    clearSessionScopes();
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
    clearSessionScopes();
  });

  it("advances the artifact cursor for v2 error completions", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    const scope = createTestSessionScope();
    registerInteractiveSubagentState(state, scope);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "error",
      source: "agent_end",
      errorMessage: "boom",
    });

    await expect(
      mod.pollArtifactChanges(scope.pi, sessionOwner(scope)),
    ).resolves.toBeUndefined();
    expect(state.eventByteCursor).toBeGreaterThan(0);
  });

  it("does not poll another session through a stale owner", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const staleScope = createTestSessionScope();
    const staleOwner = sessionOwner(staleScope);
    staleScope.lifecycle = "shutdown";
    const peerScope = createTestSessionScope();
    const { state, artifactDir } = makeState();
    registerInteractiveSubagentState(state, peerScope);
    appendCompletionEvent(artifactPath(join(artifactDir, ".."), state.id), {
      turnId: "turn-1",
      outcome: "error",
      source: "agent_end",
    });

    await expect(
      mod.pollArtifactChanges(peerScope.pi, staleOwner),
    ).resolves.toBeUndefined();

    expect(state.eventByteCursor).toBeUndefined();
    expect(peerScope.interactiveStates.get(state.id)).toBe(state);
  });
});
