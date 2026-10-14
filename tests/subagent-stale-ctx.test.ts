/**
 * Regression test for the interactive-subagent poller stale-ctx crash.
 *
 * Background: `pollArtifactChanges` runs from a setInterval, capturing the
 * ExtensionAPI at registration time. When the parent session is reloaded
 * (model change, /reload, /ralplan, etc.), that captured ctx becomes stale
 * and the loader's `assertActive` check throws on sendUserMessage. Without
 * a try/catch, the uncaught exception bubbles out of the setInterval callback
 * and crashes the entire pi process.
 *
 * Fix verified here:
 *   1. The sendUserMessage call site has a try/catch (finally still runs
 *      decrementInjectCount).
 *   2. The whole `pollArtifactChanges` body is wrapped in a top-level
 *      try/catch so any future bad tick cannot take down the process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCompletionEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import { importFresh } from "./test-utils";
import {
  clearSessionScopes,
  createSessionScope,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";
import { registerInteractiveSubagentState } from "../src/interactive-tmux";

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

describe("pollArtifactChanges stale-ctx defenses", () => {
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

  it("keeps a custom-message delivery queued when stale Pi throws", async () => {
    // The exact assertion error message produced by the loader's assertActive.
    // If the loader ever changes the wording this test should be updated to
    // match — the regression we care about is the try/catch, not the message.
    const staleErr = new Error(
      "This extension ctx is stale after session replacement or reload.",
    );

    // A live owner can still hold a stale Pi API; delivery must remain queued.
    const brokenPi = {
      sendMessage: vi.fn(() => {
        throw staleErr;
      }),
    };

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.notifyOnComplete = "inject";
    const scope = registerSessionScope(createSessionScope(brokenPi as any));
    scope.lifecycle = "started";
    registerInteractiveSubagentState(state, scope);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    writeOutput(art, "the answer");
    appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "done",
      source: "agent_end",
    });

    // The call must NOT throw — that's the entire point of the fix.
    await expect(
      mod.pollArtifactChanges(brokenPi as any, sessionOwner(scope)),
    ).resolves.toBeUndefined();

    expect(brokenPi.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.pendingDeliveries?.[0].state).toBe("queued");
  });

  it("top-level try/catch absorbs unexpected throws from anywhere in the poller", async () => {
    // A more adversarial stub: sendMessage (used by the pointer notification
    // path) throws a generic Error at the very start of the for-loop body.
    // Without the top-level try/catch, this would propagate out of the
    // setInterval callback and crash the parent pi process.
    const boom = new Error("kaboom");
    const brokenPi = {
      sendMessage: vi.fn(() => {
        throw boom;
      }),
      sendUserMessage: vi.fn(),
    };

    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { state, artifactDir } = makeState();
    state.notifyOnComplete = "inject";
    const scope = registerSessionScope(createSessionScope(brokenPi as any));
    scope.lifecycle = "started";
    registerInteractiveSubagentState(state, scope);
    const art = artifactPath(join(artifactDir, ".."), state.id);
    appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "error",
      source: "agent_end",
      errorMessage: "boom",
    });

    // The call must NOT throw.
    await expect(
      mod.pollArtifactChanges(brokenPi as any, sessionOwner(scope)),
    ).resolves.toBeUndefined();

    // sendMessage was attempted (we know it threw).
    expect(brokenPi.sendMessage).toHaveBeenCalled();
  });
});
