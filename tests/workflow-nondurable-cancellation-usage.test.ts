import { afterEach, describe, expect, it, vi } from "vitest";
import type * as NodeFs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import type { Multiplexer } from "../src/multiplexer-contracts";
import type { CancellationSnapshotReceipt } from "../src/cancellation-snapshots";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { awaitInteractiveResult } from "../src/workflow-worker";

const artifactAppendFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  failures: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
      if (args[0] === artifactAppendFault.path) {
        artifactAppendFault.path = undefined;
        artifactAppendFault.failures++;
        throw Object.assign(new Error(), { code: "EIO" });
      }
      return actual.appendFileSync(...args);
    },
  };
});

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "subagentura-nondurable-cancel-usage-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function interactiveState(cwd: string): InteractiveSubagentState {
  const artifactDir = join(cwd, "agent");
  mkdirSync(artifactDir, { recursive: true });
  return {
    id: "agent",
    name: "agent",
    task: "cancellation usage regression",
    paneId: "%1",
    mux: "tmux",
    sessionFile: join(cwd, "session.jsonl"),
    cwd,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "tmux attach -t test",
    selectPaneCommand: "tmux select-pane -t test",
    launchScriptFile: join(artifactDir, "launch.sh"),
    artifactDir,
  };
}

afterEach(() => {
  artifactAppendFault.path = undefined;
  artifactAppendFault.failures = 0;
  __setTmuxMultiplexer(undefined);
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("non-durable interactive cancellation usage", () => {
  it("keeps persisted usage when cancellation artifact append fails and forwards its snapshot", async () => {
    vi.stubEnv("SUBAGENT_CANCEL_SNAPSHOT", "full");
    vi.stubEnv("SUBAGENT_CANCEL_SNAPSHOT_DIR", "");

    const cwd = temporaryDirectory();
    const state = interactiveState(cwd);
    const eventFile = join(state.artifactDir, "events.ndjson");
    writeFileSync(eventFile, "");
    writeFileSync(
      state.sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 13,
            output: 17,
            cacheRead: 19,
            cacheWrite: 23,
            cost: { total: 0.42 },
            costSource: "provider",
          },
        },
      }),
    );

    const killPane = vi.fn();
    const mux: Multiplexer = {
      name: "tmux",
      capabilities: {
        structuredFocus: false,
        boundedCapture: false,
        nativeOverlay: false,
      },
      isAvailable: () => true,
      createPane: () => ({
        paneId: "%1",
        windowName: "agent",
        session: "test",
      }),
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
      getPaneActivityAsync: async () => "inactive",
      sendKeys: vi.fn(),
      sendEnter: vi.fn(),
      killPane,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({
        attachCommand: "attach",
        focusCommand: "focus",
      }),
    };
    __setTmuxMultiplexer(mux);
    artifactAppendFault.path = eventFile;

    const controller = new AbortController();
    controller.abort();
    const receipts: CancellationSnapshotReceipt[] = [];
    const settled = await Promise.allSettled([
      awaitInteractiveResult(state, controller.signal, 1, (receipt) => {
        receipts.push(receipt);
      }),
    ]);

    expect(artifactAppendFault.failures).toBe(1);
    expect(state.status).toBe("cancelled");
    expect(killPane).toHaveBeenCalledTimes(1);
    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt).toMatchObject({
      kind: "interactive",
      source: "workflow",
      status: "written",
    });
    if (typeof receipt.path !== "string") {
      throw new Error(
        "Cancellation snapshot receipt did not include its path.",
      );
    }
    const snapshot = JSON.parse(readFileSync(receipt.path, "utf8"));
    expect(snapshot).toMatchObject({
      kind: "interactive",
      cancellation: { source: "workflow", id: state.id },
      files: { sessionFile: { exists: true } },
    });

    expect(settled[0]?.status).toBe("fulfilled");
    if (settled[0]?.status !== "fulfilled") return;
    expect(settled[0].value).toMatchObject({
      isError: true,
      usage: {
        input: 13,
        output: 17,
        cacheRead: 19,
        cacheWrite: 23,
        cost: 0.42,
        turns: 1,
      },
    });
  });
});
