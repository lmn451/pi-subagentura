import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockCancelInteractiveSubagent } = vi.hoisted(() => ({
  mockCancelInteractiveSubagent: vi.fn(),
}));

const usageIo = vi.hoisted(() => ({
  afterStat: undefined as (() => void) | undefined,
  beforeRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const originalHandle = await actual.open(...args);
      const stat = originalHandle.stat.bind(originalHandle);
      return {
        stat: async (...statArgs: Parameters<typeof originalHandle.stat>) => {
          const result = await stat(...statArgs);
          usageIo.afterStat?.();
          return result;
        },
        read: async (...readArgs: Parameters<typeof originalHandle.read>) => {
          await usageIo.beforeRead?.();
          return originalHandle.read(...readArgs);
        },
        close: originalHandle.close.bind(originalHandle),
      } as unknown as Awaited<ReturnType<typeof actual.open>>;
    },
  };
});

vi.mock("../src/interactive-tmux", () => ({
  cancelInteractiveSubagent: mockCancelInteractiveSubagent,
  isPaneAliveAsync: vi.fn().mockResolvedValue(true),
}));

import { appendEvent, artifactPath } from "../src/artifact";
import {
  awaitInteractiveResult,
  parseUsageFromSessionFile,
  SESSION_USAGE_MAX_RECORD_BYTES,
} from "../src/workflow-worker";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import type { CancellationSnapshotReceipt } from "../src/cancellation-snapshots";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function interactiveState(cwd: string): InteractiveSubagentState {
  const artifactDir = join(cwd, "agent");
  mkdirSync(artifactDir, { recursive: true });
  return {
    id: "agent",
    name: "agent",
    task: "usage test",
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
  usageIo.afterStat = undefined;
  usageIo.beforeRead = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockCancelInteractiveSubagent.mockReset();
});

describe("workflow session usage parsing", () => {
  it("skips malformed records and aggregates a final non-newline record", async () => {
    const cwd = temporaryDirectory("subagentura-usage-records-");
    const sessionFile = join(cwd, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        "not-json",
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 2,
              output: 3,
              cacheRead: 4,
              cacheWrite: 5,
              cost: { total: 0.01 },
              costSource: "provider",
            },
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 7,
              output: 11,
              cacheRead: 13,
              cacheWrite: 17,
              cost: { total: 0.02 },
            },
          },
        }),
      ].join("\n"),
    );

    await expect(parseUsageFromSessionFile(sessionFile)).resolves.toEqual({
      input: 9,
      output: 14,
      cacheRead: 17,
      cacheWrite: 22,
      cost: 0.03,
      costSource: "mixed",
      turns: 2,
    });
  });

  it("skips an oversized record and aggregates a later assistant usage record", async () => {
    const cwd = temporaryDirectory("subagentura-usage-oversized-");
    const sessionFile = join(cwd, "session.jsonl");
    const oversizedRecord = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: "x".repeat(SESSION_USAGE_MAX_RECORD_BYTES),
        usage: { input: 100, output: 200, cost: { total: 1 } },
      },
    });
    const laterRecord = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 3, output: 5, cost: { total: 0.02 } },
      },
    });
    expect(Buffer.byteLength(oversizedRecord)).toBeGreaterThan(
      SESSION_USAGE_MAX_RECORD_BYTES,
    );
    writeFileSync(sessionFile, `${oversizedRecord}\n${laterRecord}\n`);

    await expect(parseUsageFromSessionFile(sessionFile)).resolves.toEqual({
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.02,
      costSource: "estimated",
      turns: 1,
    });
  });

  it("skips an oversized final record without a trailing newline", async () => {
    const cwd = temporaryDirectory("subagentura-usage-oversized-final-");
    const sessionFile = join(cwd, "session.jsonl");
    const oversizedRecord = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: "x".repeat(SESSION_USAGE_MAX_RECORD_BYTES),
        usage: { input: 100, output: 200, cost: { total: 1 } },
      },
    });
    expect(Buffer.byteLength(oversizedRecord)).toBeGreaterThan(
      SESSION_USAGE_MAX_RECORD_BYTES,
    );
    writeFileSync(sessionFile, oversizedRecord);

    await expect(parseUsageFromSessionFile(sessionFile)).resolves.toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    });
  });

  it("preserves a large assistant record when UTF-8 crosses a read chunk", async () => {
    const cwd = temporaryDirectory("subagentura-usage-utf8-");
    const sessionFile = join(cwd, "session.jsonl");
    const linePrefix =
      '{"type":"message","message":{"role":"assistant","content":"';
    const contentPrefix = "x".repeat(
      64 * 1024 - Buffer.byteLength(linePrefix) - 1,
    );
    const assistantLine =
      `${linePrefix}${contentPrefix}😀` +
      `","usage":{"input":1,"output":2,"cost":{"total":0.01}}}}`;
    expect(Buffer.byteLength(`${linePrefix}${contentPrefix}`)).toBe(
      64 * 1024 - 1,
    );
    writeFileSync(sessionFile, `${assistantLine}\n`);

    await expect(parseUsageFromSessionFile(sessionFile)).resolves.toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01,
      costSource: "estimated",
      turns: 1,
    });
  });

  it("does not chase records appended after the scan size is captured", async () => {
    const cwd = temporaryDirectory("subagentura-usage-boundary-");
    const sessionFile = join(cwd, "session.jsonl");
    const initialRecord = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 3, cost: { total: 0.01 } },
      },
    });
    const appendedRecord = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { output: 100, cost: { total: 1 } },
      },
    });
    writeFileSync(sessionFile, `${initialRecord}\n`);
    usageIo.afterStat = () =>
      appendFileSync(sessionFile, `${appendedRecord}\n`);

    await expect(parseUsageFromSessionFile(sessionFile)).resolves.toMatchObject(
      {
        output: 3,
        cost: 0.01,
        turns: 1,
      },
    );
  });

  it("returns cancellation when the signal fires during usage scanning", async () => {
    const cwd = temporaryDirectory("subagentura-usage-cancel-");
    const state = interactiveState(cwd);
    const art = artifactPath(cwd, state.id);
    appendEvent(art, {
      ts: 1,
      type: "done",
      status: "done",
      exitCode: 0,
    });
    const sessionLine = `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 8, output: 5, cost: { total: 0.02 } },
      },
    })}\n`;
    writeFileSync(state.sessionFile, sessionLine.repeat(100_000));
    const controller = new AbortController();
    usageIo.afterStat = () => controller.abort();

    const result = await awaitInteractiveResult(state, controller.signal, 1);
    expect(result).toMatchObject({
      isError: true,
      errorMessage: "aborted",
      usage: {
        input: 800_000,
        output: 500_000,
        turns: 100_000,
      },
    });
    expect(result.usage.cost).toBeCloseTo(2_000, 8);
  });

  it("cancels and delivers its receipt before a usage read is released", async () => {
    const cwd = temporaryDirectory("subagentura-usage-cancel-prompt-");
    const state = interactiveState(cwd);
    const art = artifactPath(cwd, state.id);
    appendEvent(art, {
      ts: 1,
      type: "done",
      status: "done",
      exitCode: 0,
    });
    const sessionLine = `${JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 8, output: 5, cost: { total: 0.02 } },
      },
    })}\n`;
    const recordCount = 4_096;
    writeFileSync(state.sessionFile, sessionLine.repeat(recordCount));

    const receipt: CancellationSnapshotReceipt = {
      schemaVersion: 1,
      kind: "interactive",
      status: "written",
      enabled: true,
      source: "workflow",
      key: "usage-cancel-prompt",
      path: join(cwd, "snapshot.json"),
    };
    const events: string[] = [];
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    usageIo.beforeRead = async () => {
      events.push("read-start");
      markReadStarted();
      await readGate;
    };
    mockCancelInteractiveSubagent.mockImplementation(
      (_id: string, _source: string, ownedState?: InteractiveSubagentState) => {
        events.push("cancel");
        if (!ownedState) return undefined;
        ownedState.status = "cancelled";
        ownedState.cancellationSnapshot = receipt;
        return ownedState;
      },
    );

    const controller = new AbortController();
    const addAbortListener = vi.spyOn(controller.signal, "addEventListener");
    const removeAbortListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    const deliveredReceipts: CancellationSnapshotReceipt[] = [];
    const pending = awaitInteractiveResult(
      state,
      controller.signal,
      1,
      (snapshot) => {
        events.push("receipt");
        deliveredReceipts.push(snapshot);
      },
    );

    await readStarted;
    let result!: Awaited<ReturnType<typeof awaitInteractiveResult>>;
    try {
      controller.abort();
      expect(events).toEqual(["read-start", "cancel", "receipt"]);
      expect(mockCancelInteractiveSubagent).toHaveBeenCalledTimes(1);
      expect(deliveredReceipts).toEqual([receipt]);
    } finally {
      releaseRead();
      result = await pending;
    }
    expect(result).toMatchObject({
      isError: true,
      errorMessage: "aborted",
      usage: {
        input: 8 * recordCount,
        output: 5 * recordCount,
        turns: recordCount,
      },
    });
    expect(result.usage.cost).toBeCloseTo(0.02 * recordCount, 8);
    expect(addAbortListener).toHaveBeenCalledTimes(1);
    expect(removeAbortListener).toHaveBeenCalledTimes(1);
    expect(mockCancelInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(deliveredReceipts).toEqual([receipt]);
  });
});
