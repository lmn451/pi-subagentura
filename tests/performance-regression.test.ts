import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { appendInteractiveState } from "../src/artifact";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { pollArtifactChanges } from "../src/artifact-poller";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { awaitInteractiveResult } from "../src/workflow-worker";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
function interactiveState(
  id: string,
  cwd: string,
  parentSessionId?: string,
): InteractiveSubagentState {
  const artifactDir = join(cwd, id);
  mkdirSync(artifactDir, { recursive: true });
  return {
    id,
    name: id,
    task: "performance regression",
    paneId: `%${id.replace(/\D/g, "") || "1"}`,
    mux: "tmux",
    sessionFile: join(artifactDir, "session.jsonl"),
    cwd,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "tmux attach -t test",
    selectPaneCommand: "tmux select-pane -t test",
    launchScriptFile: join(artifactDir, "launch.sh"),
    artifactDir,
    parentSessionId,
  };
}

afterEach(() => {
  __setTmuxMultiplexer(undefined);
  interactiveSubagentRegistry.clear();
  clearSessionScopes();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("high-concurrency input latency regressions", () => {
  it("does not block the parent event loop on workflow pane liveness", async () => {
    const cwd = temporaryDirectory("subagentura-workflow-latency-");
    const state = interactiveState("agent-1", cwd);
    const eventsFile = join(state.artifactDir, "events.ndjson");
    writeFileSync(
      eventsFile,
      `${JSON.stringify({ ts: 1, type: "started", status: "running" })}\n`,
    );
    const synchronousProbe = vi.fn(() => {
      const deadline = performance.now() + 250;
      while (performance.now() < deadline) {
        // Model a slow synchronous tmux/zellij subprocess on Pi's main thread.
      }
      return "alive" as const;
    });
    const asynchronousProbe = vi.fn(async () => "alive" as const);
    __setTmuxMultiplexer({
      getPaneLiveness: synchronousProbe,
      getPaneLivenessAsync: asynchronousProbe,
    } as never);

    const startedAt = performance.now();
    let inputDelayMs = Number.POSITIVE_INFINITY;
    setTimeout(() => {
      inputDelayMs = performance.now() - startedAt;
      appendFileSync(
        eventsFile,
        `${JSON.stringify({ ts: 2, type: "done", status: "done", exitCode: 0 })}\n`,
      );
    }, 0);

    await awaitInteractiveResult(state, undefined, 1);

    expect(inputDelayMs).toBeLessThan(125);
    expect(synchronousProbe).not.toHaveBeenCalled();
    expect(asynchronousProbe).toHaveBeenCalled();
  });

  it("persists a 200-subagent poll without quadratic input delay", async () => {
    const cwd = temporaryDirectory("subagentura-poller-latency-");
    const owner = { id: 901, generation: 1 };
    const pi = { sendMessage: vi.fn() };
    const scope = registerSessionScope({ ...owner, pi: pi as never });
    const parentSessionId = "performance-parent";
    const count = 200;

    for (let index = 0; index < count; index++) {
      const state = interactiveState(
        `agent-${index + 1}`,
        cwd,
        parentSessionId,
      );
      appendInteractiveState(cwd, {
        id: state.id,
        paneId: state.paneId,
        mux: state.mux,
        artifactDir: state.artifactDir,
        sessionFile: state.sessionFile,
        parentSessionId,
      });
      interactiveSubagentRegistry.set(state.id, state);
      scope.interactiveStates.set(state.id, state);
    }
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async () => "alive",
    } as never);

    const startedAt = performance.now();
    await pollArtifactChanges(pi as never, owner);
    const pollDurationMs = performance.now() - startedAt;

    expect(pollDurationMs).toBeLessThan(100);
  });
});
