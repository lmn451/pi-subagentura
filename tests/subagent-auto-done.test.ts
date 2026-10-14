/** Protocol-v2 artifact events are authoritative for interactive completion. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendEvent, artifactPath, readEvents } from "../src/artifact";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { importFresh } from "./test-utils";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
} from "../src/session-scope";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "pi-subagentura-v2-completion-"));
}

describe("protocol-v2 interactive completion", () => {
  let root: string;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout?: string) => void,
      ) => callback(null, "%99\n"),
    }));
    root = makeTmp();
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    clearSessionScopes();
  });

  afterEach(() => {
    clearSessionScopes();
    rmSync(root, { recursive: true, force: true });
    vi.doUnmock("node:child_process");
  });

  it("polls and delivers an explicit protocol-v2 completion once", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "v2-child";
    const artifactDir = join(root, id);
    mkdirSync(artifactDir, { recursive: true });
    const state: InteractiveSubagentState = {
      id,
      name: "Test",
      task: "t",
      paneId: "%99",
      sessionFile: join(artifactDir, "session.jsonl"),
      cwd: root,
      startedAt: Date.now(),
      status: "running",
      mux: "tmux",
      attachCommand: "tmux attach -t sess",
      selectPaneCommand: "tmux select-pane -t '%99'",
      launchScriptFile: join(root, "launch.sh"),
      artifactDir,
    };
    mod.interactiveSubagentRegistry.set(id, state);
    const artifact = artifactPath(dirname(artifactDir), id);
    appendEvent(artifact, {
      version: 2,
      eventId: "completion-event",
      turnId: "turn-1",
      ts: Date.now(),
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    });

    const entries: Array<{ type: string; customType: string; data: unknown }> =
      [];
    const api = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({ type: "custom", customType, data });
      }),
    };
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: api as any,
      sessionManager: {
        getSessionId: () => "parent-session",
        getEntries: () => entries,
      },
    });
    state.parentSessionId = "parent-session";
    scope.interactiveStates.set(id, state);
    const owner = sessionOwner(scope);
    await mod.pollArtifactChanges(api as any, owner);

    expect(
      readEvents(artifact).filter((event) => event.type === "completion"),
    ).toHaveLength(1);
    expect(state.pendingDeliveries).toHaveLength(0);
    expect(api.appendEntry).toHaveBeenCalledOnce();
    expect(entries[0]).toMatchObject({
      customType: "subagentura-completion",
      data: { completionId: expect.any(String), source: "interactive" },
    });
    await mod.pollArtifactChanges(api as any, owner);
    expect(api.appendEntry).toHaveBeenCalledOnce();
  });
});
