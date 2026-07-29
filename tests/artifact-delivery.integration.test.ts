import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  eventLogEndOffset,
  MAX_EVENT_BATCH_BYTES,
  MAX_DELIVERY_RECEIPTS,
  MAX_OUTPUT_SNAPSHOT_BYTES,
  listOutputHistory,
  readEventRecords,
  readOutput,
  readOutputForTurnId,
  writeOutput,
} from "../src/artifact";
import { writeCliScript } from "../src/subagent-artifact-cli";
import {
  deliveryIdFor,
  enqueueDelivery,
  flushDeliveries,
  MAX_ARTIFACT_OUTPUT_BYTES,
  MAX_DELIVERY_QUEUE_BYTES,
  MAX_DELIVERY_RECORDS,
  MAX_FLUSH_BYTES,
  reconcileDeliveryReceipts,
} from "../src/delivery";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { pollArtifactChanges } from "../src/artifact-poller";
import { renderSubagentNotify } from "../src/rendering";
import { appendDeterministicTurn } from "./helpers/deterministic-artifacts";
import {
  getSessionContextStack,
  registerSessionContext,
} from "../src/session-context";

const roots: string[] = [];

function makeArtifact() {
  const root = mkdtempSync(join(tmpdir(), "subagentura-v2-"));
  roots.push(root);
  return artifactPath(root, "abc12345");
}

function makeState(dir: string): InteractiveSubagentState {
  return {
    id: "abc12345",
    name: "child",
    task: "",
    paneId: "%1",
    mux: "tmux",
    sessionFile: "",
    cwd: dir,
    startedAt: 0,
    status: "idle",
    attachCommand: "",
    selectPaneCommand: "",
    launchScriptFile: "",
    artifactDir: dir,
    parentSessionId: "parent",
    pendingDeliveries: [],
    deliveryReceipts: [],
  };
}

function flushInjectedOutput(
  art: ReturnType<typeof makeArtifact>,
  output: { path: string; bytes: number; sha256: string },
): string {
  const state = makeState(art.dir);
  enqueueDelivery(state, {
    deliveryId: "forged-output",
    subagentId: state.id,
    turnId: "turn-forged",
    eventId: "event-forged",
    mode: "inject",
    triggerTurn: true,
    status: "done",
    artifactDir: art.dir,
    output,
    state: "queued",
  });
  (globalThis as any).__piSubagenturaInteractiveRegistry = new Map([
    [state.id, state],
  ]);
  const sendMessage = vi.fn();
  flushDeliveries({ sendMessage } as any, undefined);
  return sendMessage.mock.calls[0][0].content;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  (globalThis as any).__piSubagenturaInteractiveRegistry = undefined;
  (globalThis as any).__piSubagenturaParentStreaming = false;
  (globalThis as any).__piSubagenturaSessionManager = undefined;
  (globalThis as any).__piSubagenturaPiRef = undefined;
  interactiveSubagentRegistry.clear();
  getSessionContextStack().length = 0;
  __setTmuxMultiplexer(undefined);
});

describe("artifact protocol v2 delivery", () => {
  it("flushes only interactive deliveries owned by the supplied context", () => {
    const artA = makeArtifact();
    const artB = makeArtifact();
    const stateA = {
      ...makeState(artA.dir),
      id: "agent-a",
      parentSessionId: "session-a",
    };
    const stateB = {
      ...makeState(artB.dir),
      id: "agent-b",
      parentSessionId: "session-b",
    };
    const ownerA = { id: 301, generation: 1 };
    const ownerB = { id: 302, generation: 1 };
    registerSessionContext({
      ...ownerA,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-a", getEntries: () => [] },
    });
    registerSessionContext({
      ...ownerB,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-b", getEntries: () => [] },
    });
    enqueueDelivery(stateA, {
      deliveryId: "delivery-a",
      subagentId: stateA.id,
      turnId: "turn-a",
      eventId: "event-a",
      mode: "notify",
      triggerTurn: false,
      status: "done",
      artifactDir: artA.dir,
      message: "from-a",
      state: "queued",
    });
    enqueueDelivery(stateB, {
      deliveryId: "delivery-b",
      subagentId: stateB.id,
      turnId: "turn-b",
      eventId: "event-b",
      mode: "notify",
      triggerTurn: false,
      status: "done",
      artifactDir: artB.dir,
      message: "from-b",
      state: "queued",
    });
    interactiveSubagentRegistry.set(stateA.id, stateA);
    interactiveSubagentRegistry.set(stateB.id, stateB);
    const sendMessage = vi.fn();

    flushDeliveries({ sendMessage } as any, undefined, ownerB);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).toContain("from-b");
    expect(sendMessage.mock.calls[0][0].content).not.toContain("from-a");
    expect(stateA.pendingDeliveries?.[0]?.state).toBe("queued");
    expect(stateB.pendingDeliveries?.[0]?.deliveryId).toBe("delivery-b");
  });

  it("reads equal and decreasing timestamps in physical byte order", () => {
    const art = makeArtifact();
    appendEvent(art, { ts: 10, type: "started", status: "running" });
    appendEvent(art, { ts: 10, type: "tool_activity", status: "running" });
    appendEvent(art, { ts: 1, type: "done", status: "done" });

    const records = readEventRecords(art);
    expect(records.map(({ event }) => event.ts)).toEqual([10, 10, 1]);
    expect(records[1].startOffset).toBe(records[0].endOffset);
  });

  it("associates every completion with an immutable output snapshot", () => {
    const art = makeArtifact();
    writeOutput(art, "turn one");
    const first = appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "done",
      source: "agent_end",
    })!;
    writeOutput(art, "turn two");
    const second = appendCompletionEvent(art, {
      turnId: "turn-2",
      outcome: "done",
      source: "agent_end",
    })!;

    expect(readFileSync(first.output!.path, "utf8")).toBe("turn one");
    expect(readFileSync(second.output!.path, "utf8")).toBe("turn two");
    expect(readOutput(art)).toBe("turn two");
  });

  it("records oversized parent-side staging output without snapshotting it", () => {
    const art = makeArtifact();
    writeOutput(art, "");
    const bytes = MAX_OUTPUT_SNAPSHOT_BYTES + 1;
    writeFileSync(art.outputFile, Buffer.alloc(bytes, 120));

    const completion = appendCompletionEvent(art, {
      turnId: "oversized-parent-turn",
      outcome: "cancelled",
      source: "parent",
      eventId: "oversized-parent-event",
    })!;

    expect(completion.output).toBeUndefined();
    expect(completion.outputError).toEqual({
      code: "output_too_large",
      bytes,
      maxBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
    });
    expect(
      existsSync(join(art.dir, "outputs", "oversized-parent-event.md")),
    ).toBe(false);
  });

  it("makes generated CLI completion omit oversized staging output", () => {
    const art = makeArtifact();
    writeOutput(art, "");
    const bytes = MAX_OUTPUT_SNAPSHOT_BYTES + 1;
    writeFileSync(art.outputFile, Buffer.alloc(bytes, 120));
    const cli = join(art.dir, "cli.mjs");
    writeCliScript(cli);

    expect(
      spawnSync(process.execPath, [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);
    const completion = readEventRecords(art)
      .map(({ event }) => event)
      .find((event) => event.type === "completion") as any;

    expect(completion.output).toBeUndefined();
    expect(completion.outputError).toEqual({
      code: "output_too_large",
      bytes,
      maxBytes: MAX_OUTPUT_SNAPSHOT_BYTES,
    });
    expect(
      existsSync(join(art.dir, "outputs", `${completion.eventId}.md`)),
    ).toBe(false);
  });

  it("discovers and reads immutable protocol-v2 output by Pi turn id", () => {
    const art = makeArtifact();
    writeOutput(art, "turn one");
    const first = appendCompletionEvent(art, {
      turnId: "pi-user-entry-1",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-one",
    })!;
    writeOutput(art, "turn two");
    const second = appendCompletionEvent(art, {
      turnId: "pi-user-entry-2",
      outcome: "done",
      source: "agent_settled",
      eventId: "event-two",
    })!;

    expect(listOutputHistory(art)).toEqual([
      {
        turnId: "pi-user-entry-1",
        eventId: first.eventId,
        output: first.output,
      },
      {
        turnId: "pi-user-entry-2",
        eventId: second.eventId,
        output: second.output,
      },
    ]);
    expect(readOutputForTurnId(art, "pi-user-entry-1")).toBe("turn one");
    expect(readOutputForTurnId(art, "pi-user-entry-2")).toBe("turn two");
    expect(readOutputForTurnId(art, "missing-turn")).toBeNull();
  });

  it("refuses a protocol-v2 turn snapshot symlink outside the artifact", () => {
    const art = makeArtifact();
    const secret = join(dirname(art.dir), "outside-secret.txt");
    const content = "must not be exfiltrated";
    writeFileSync(secret, content);
    mkdirSync(join(art.dir, "outputs"), { recursive: true });
    const snapshot = join(art.dir, "outputs", "event-symlink.md");
    symlinkSync(secret, snapshot);
    appendEvent(art, {
      version: 2,
      eventId: "event-symlink",
      turnId: "turn-symlink",
      ts: 1,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "explicit",
      output: {
        path: snapshot,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    });

    expect(readOutputForTurnId(art, "turn-symlink")).toBeNull();
  });

  it("finds and deduplicates a completion beyond the first event batch", () => {
    const art = makeArtifact();
    let index = 0;
    while (eventLogEndOffset(art) <= MAX_EVENT_BATCH_BYTES + 4096) {
      appendEvent(art, {
        ts: index + 1,
        type: "tool_activity",
        status: "running",
        message: `filler-${index}-${"x".repeat(2_000)}`,
      });
      index++;
    }
    writeOutput(art, "late immutable output");
    const completion = appendCompletionEvent(art, {
      turnId: "pi-user-entry-after-first-batch",
      eventId: "completion-after-first-batch",
      outcome: "done",
      source: "agent_settled",
    });

    expect(readOutputForTurnId(art, completion!.turnId)).toBe(
      "late immutable output",
    );
    expect(listOutputHistory(art)).toContainEqual(
      expect.objectContaining({ eventId: completion!.eventId }),
    );
    expect(
      appendCompletionEvent(art, {
        turnId: completion!.turnId,
        outcome: "done",
        source: "explicit",
      }),
    ).toBeNull();
    expect(
      listOutputHistory(art).filter(
        ({ turnId }) => turnId === completion!.turnId,
      ),
    ).toHaveLength(1);
  });

  it("preserves and batches multiple immutable completions from one poll", async () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    state.notifyOnComplete = "inject";
    state.triggerTurnOnComplete = false;
    state.eventByteCursor = 0;
    interactiveSubagentRegistry.set(state.id, state);
    (globalThis as any).__piSubagenturaInteractiveRegistry =
      interactiveSubagentRegistry;
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      observePane: async () => ({ kind: "alive" }),
    } as any);
    const first = appendDeterministicTurn(art, 1, "first immutable result");
    const second = appendDeterministicTurn(art, 2, "second immutable result");
    const sendMessage = vi.fn();

    await pollArtifactChanges({ sendMessage } as any);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].details.deliveryIds).toHaveLength(2);
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "first immutable result",
    );
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "second immutable result",
    );
    expect(state.pendingDeliveries).toEqual([
      expect.objectContaining({ eventId: first.eventId }),
      expect.objectContaining({ eventId: second.eventId }),
    ]);
  });

  it("queues an explicit omission message for oversized completion output", async () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    state.notifyOnComplete = "inject";
    state.triggerTurnOnComplete = false;
    state.eventByteCursor = 0;
    interactiveSubagentRegistry.set(state.id, state);
    (globalThis as any).__piSubagenturaInteractiveRegistry =
      interactiveSubagentRegistry;
    __setTmuxMultiplexer({
      getPaneLiveness: () => "alive",
      observePane: async () => ({ kind: "alive" }),
    } as any);
    const bytes = MAX_OUTPUT_SNAPSHOT_BYTES + 1;
    writeOutput(art, "");
    writeFileSync(art.outputFile, Buffer.alloc(bytes, 120));
    const completion = appendCompletionEvent(art, {
      turnId: "oversized-poller-turn",
      outcome: "done",
      source: "agent_settled",
      eventId: "oversized-poller-event",
    })!;
    const sendMessage = vi.fn();

    await pollArtifactChanges({ sendMessage } as any);

    expect(completion.output).toBeUndefined();
    expect(state.pendingDeliveries).toContainEqual(
      expect.objectContaining({
        eventId: "oversized-poller-event",
        output: undefined,
        message: `Output omitted: ${bytes} bytes exceeds the ${MAX_OUTPUT_SNAPSHOT_BYTES}-byte snapshot limit.`,
      }),
    );
  });

  it("deduplicates late explicit completion for the same turn", () => {
    const art = makeArtifact();
    writeOutput(art, "answer");
    expect(
      appendCompletionEvent(art, {
        turnId: "turn-1",
        outcome: "done",
        source: "agent_end",
      }),
    ).not.toBeNull();
    expect(
      appendCompletionEvent(art, {
        turnId: "turn-1",
        outcome: "done",
        source: "explicit",
      }),
    ).toBeNull();
    expect(readEventRecords(art)).toHaveLength(1);
  });

  it("dispatches triggering delivery through native followUp while streaming", () => {
    const art = makeArtifact();
    writeOutput(art, "result");
    const event = appendCompletionEvent(art, {
      turnId: "turn-1",
      outcome: "done",
      source: "agent_end",
    })!;
    const state = makeState(art.dir);
    const deliveryId = deliveryIdFor({
      parentSessionId: "parent",
      subagentId: state.id,
      turnId: event.turnId,
      mode: "inject",
    });
    enqueueDelivery(state, {
      deliveryId,
      subagentId: state.id,
      turnId: event.turnId,
      eventId: event.eventId,
      mode: "inject",
      triggerTurn: true,
      status: "done",
      artifactDir: art.dir,
      output: event.output,
      state: "queued",
    });
    (globalThis as any).__piSubagenturaInteractiveRegistry = new Map([
      [state.id, state],
    ]);
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const ui = { notify } as any;
    (globalThis as any).__piSubagenturaParentStreaming = true;

    flushDeliveries({ sendMessage } as any, ui);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0].details.deliveryIds).toEqual([
      deliveryId,
    ]);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
    expect(sendMessage.mock.calls[0][0].content).toContain(
      "<untrusted-subagent-output>",
    );
    expect(sendMessage.mock.calls[0][0].content).toContain("result");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "A new parent turn will start automatically after the injection",
    );

    (globalThis as any).__piSubagenturaParentStreaming = false;
    flushDeliveries({ sendMessage } as any, ui);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("bounds the first envelope with huge identifiers and malformed message", () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    state.id = "s".repeat(100_000);
    enqueueDelivery(state, {
      deliveryId: "huge-identifiers",
      subagentId: state.id,
      turnId: "t".repeat(100_000),
      eventId: "event",
      mode: "inject",
      triggerTurn: true,
      status: "done",
      artifactDir: "a".repeat(100_000),
      message: { unsafe: true } as unknown as string,
      state: "queued",
    });
    const sendMessage = vi.fn();
    interactiveSubagentRegistry.set(state.id, state);
    (globalThis as any).__piSubagenturaInteractiveRegistry =
      interactiveSubagentRegistry;

    expect(() =>
      flushDeliveries({ sendMessage } as any, undefined),
    ).not.toThrow();
    expect(sendMessage).toHaveBeenCalledOnce();
    const content = sendMessage.mock.calls[0][0].content as string;
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(
      MAX_FLUSH_BYTES,
    );
    expect(content).not.toContain("s".repeat(200));
    expect(content).not.toContain("t".repeat(200));
  });

  it("notify-trigger sends status and pointers without immutable output", () => {
    const art = makeArtifact();
    writeOutput(art, "private immutable payload");
    const event = appendCompletionEvent(art, {
      turnId: "turn-notify",
      outcome: "done",
      source: "agent_end",
    })!;
    const state = makeState(art.dir);
    enqueueDelivery(state, {
      deliveryId: "notify-trigger",
      subagentId: state.id,
      turnId: event.turnId,
      eventId: event.eventId,
      mode: "notify",
      triggerTurn: true,
      status: "done",
      artifactDir: art.dir,
      output: event.output,
      state: "queued",
    });
    (globalThis as any).__piSubagenturaInteractiveRegistry = new Map([
      [state.id, state],
    ]);
    const sendMessage = vi.fn();
    const notify = vi.fn();
    const ui = { notify } as any;
    flushDeliveries({ sendMessage } as any, ui);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0].content).not.toContain(
      "private immutable payload",
    );
    expect(sendMessage.mock.calls[0][0].content).toContain("Output:");
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ triggerTurn: true });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was not injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "A new parent turn will start automatically after the pointer delivery",
    );
  });

  it("rejects traversal paths from output metadata", () => {
    const art = makeArtifact();
    const secret = "traversal secret";
    const path = join(art.dir, "secret.md");
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(path, secret);

    const content = flushInjectedOutput(art, {
      path: join(art.dir, "outputs", "..", "secret.md"),
      bytes: Buffer.byteLength(secret),
      sha256: createHash("sha256").update(secret).digest("hex"),
    });

    expect(content).not.toContain(secret);
    expect(content).toContain("no immutable output available");
  });

  it("rejects forged output paths outside the artifact", () => {
    const art = makeArtifact();
    const secret = "forged path secret";
    const path = join(art.dir, "..", "forged.md");
    writeFileSync(path, secret);

    const content = flushInjectedOutput(art, {
      path,
      bytes: Buffer.byteLength(secret),
      sha256: createHash("sha256").update(secret).digest("hex"),
    });

    expect(content).not.toContain(secret);
    expect(content).toContain("Output:");
  });

  it("rejects output snapshots with a hash mismatch", () => {
    const art = makeArtifact();
    const outputs = join(art.dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const path = join(outputs, "event-forged.md");
    writeFileSync(path, "authentic content");

    const content = flushInjectedOutput(art, {
      path,
      bytes: Buffer.byteLength("authentic content"),
      sha256: createHash("sha256").update("forged content").digest("hex"),
    });

    expect(content).not.toContain("authentic content");
  });

  it("rejects output snapshots above the artifact size limit", () => {
    const art = makeArtifact();
    const outputs = join(art.dir, "outputs");
    mkdirSync(outputs, { recursive: true });
    const path = join(outputs, "event-forged.md");
    const oversized = Buffer.alloc(MAX_ARTIFACT_OUTPUT_BYTES + 1, 120);
    writeFileSync(path, oversized);

    const content = flushInjectedOutput(art, {
      path,
      bytes: oversized.byteLength,
      sha256: createHash("sha256").update(oversized).digest("hex"),
    });

    expect(content).not.toContain("<untrusted-subagent-output>");
    expect(content).toContain("no immutable output available");
  });

  it("keeps synchronous send failures queued for retry", () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    enqueueDelivery(state, {
      deliveryId: "delivery",
      subagentId: state.id,
      turnId: "turn",
      eventId: "event",
      mode: "inject",
      triggerTurn: true,
      status: "error",
      artifactDir: art.dir,
      state: "queued",
    });
    (globalThis as any).__piSubagenturaInteractiveRegistry = new Map([
      [state.id, state],
    ]);
    flushDeliveries(
      {
        sendMessage: vi.fn(() => {
          throw new Error("stale");
        }),
      } as any,
      undefined,
    );
    expect(state.pendingDeliveries?.[0].state).toBe("queued");
  });

  it("bounds overflow and preserves collapsed completion identities on disk", () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    for (let index = 0; index < MAX_DELIVERY_RECORDS + 10; index++) {
      enqueueDelivery(state, {
        deliveryId: `delivery-${index}`,
        subagentId: state.id,
        turnId: `turn-${index}`,
        eventId: `event-${index}`,
        mode: "inject",
        triggerTurn: true,
        status: "done",
        artifactDir: art.dir,
        message: "x".repeat(10_000),
        state: "queued",
      });
    }

    expect(state.pendingDeliveries!.length).toBeLessThanOrEqual(
      MAX_DELIVERY_RECORDS,
    );
    expect(
      Buffer.byteLength(JSON.stringify(state.pendingDeliveries), "utf8"),
    ).toBeLessThanOrEqual(MAX_DELIVERY_QUEUE_BYTES);
    const overflow = readFileSync(
      join(art.dir, "delivery-overflow.ndjson"),
      "utf8",
    );
    expect(overflow).toContain('"deliveryId":"delivery-0"');
    expect(overflow).toContain('"mode":"inject"');
    expect(overflow).toContain('"triggerTurn":true');
    expect(state.pendingDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: "delivery-overflow",
          mode: "inject",
          triggerTurn: true,
        }),
      ]),
    );
  });

  it("reconciles dispatchAttempted intents from same-session custom entries", () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    enqueueDelivery(state, {
      deliveryId: "same-session",
      subagentId: state.id,
      turnId: "turn",
      eventId: "event",
      mode: "inject",
      triggerTurn: true,
      status: "done",
      artifactDir: art.dir,
      state: "queued",
    });
    (globalThis as any).__piSubagenturaInteractiveRegistry = new Map([
      [state.id, state],
    ]);
    const entries: unknown[] = [];
    (globalThis as any).__piSubagenturaSessionManager = {
      getEntries: () => entries,
    };
    flushDeliveries(
      {
        sendMessage: vi.fn((message) => {
          entries.push({ type: "custom_message", details: message.details });
        }),
      } as any,
      undefined,
    );

    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toContain("same-session");
  });

  it("deduplicates and bounds long-lived delivery receipts", () => {
    const art = makeArtifact();
    const state = makeState(art.dir);
    state.eventByteCursor = 10_000;
    state.deliveryReceipts = Array.from(
      { length: MAX_DELIVERY_RECEIPTS + 100 },
      (_, index) => `receipt-${index}`,
    ).flatMap((receipt) => [receipt, receipt]);
    state.pendingDeliveries = [
      {
        deliveryId: "current-receipt",
        subagentId: state.id,
        turnId: "turn-current",
        eventId: "event-current",
        mode: "inject",
        triggerTurn: true,
        status: "done",
        artifactDir: art.dir,
        state: "dispatchAttempted",
      },
    ];

    reconcileDeliveryReceipts(state, [
      {
        type: "custom_message",
        details: {
          deliveryIds: ["current-receipt", "current-receipt"],
        },
      },
    ]);

    expect(state.pendingDeliveries).toEqual([]);
    expect(state.deliveryReceipts).toContain("current-receipt");
    expect(state.deliveryReceipts!.length).toBeLessThanOrEqual(
      MAX_DELIVERY_RECEIPTS,
    );
    expect(new Set(state.deliveryReceipts).size).toBe(
      state.deliveryReceipts!.length,
    );
  });

  it("renders v2 status and error details without legacy result details", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as any;
    const rendered = renderSubagentNotify(
      {
        content: "provider failed",
        details: { mode: "inject", status: "error", error: true },
      },
      { expanded: true },
      theme,
    )
      .render(200)
      .join("\n");

    expect(rendered).toContain("Sub-agent Failed");
    expect(rendered).toContain("provider failed");
  });
});
