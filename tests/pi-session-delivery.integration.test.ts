import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactPath,
  appendCompletionEvent,
  appendInteractiveState,
  eventLogEndOffset,
  listOutputHistory,
  readEventRecords,
  writeOutput,
} from "../src/artifact";
import { enqueueDelivery, flushDeliveries } from "../src/delivery";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import {
  deliverNotification,
  flushInProcessDeliveries,
} from "../src/notifications";
import { pollArtifactChanges } from "../src/artifact-poller";
import { rehydrateInteractiveSubagents } from "../src/rehydrate";
import { getSessionContextStack } from "../src/session-context";
import { writeCliScript } from "../src/subagent-artifact-cli";
import { createPiSessionHarness } from "./helpers/pi-session-harness";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendDeterministicTurn } from "./helpers/deterministic-artifacts";

const repoRoot = new URL("..", import.meta.url).pathname;
const harnesses: Awaited<ReturnType<typeof createPiSessionHarness>>[] = [];
const artifactRoots: string[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  for (const root of artifactRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  interactiveSubagentRegistry.clear();
  delete (globalThis as any).__piSubagenturaParentStreaming;
  delete (globalThis as any).__piSubagenturaPiRef;
  delete (globalThis as any).__piSubagenturaUi;
  delete (globalThis as any).__piSubagenturaSessionManager;
  delete (globalThis as any).__piSubagenturaPendingJobDeliveries;
  __setTmuxMultiplexer(undefined);
});

function childArtifact() {
  const root = mkdtempSync(join(tmpdir(), "pi-subagentura-child-session-"));
  artifactRoots.push(root);
  return artifactPath(root, "child0001");
}

async function setup(mode: "notify" | "inject", triggerTurn: boolean) {
  (globalThis as any).__piSubagenturaPendingJobDeliveries = [];
  const harness = await createPiSessionHarness(repoRoot);
  harnesses.push(harness);
  expect(harness.session.hasExtensionHandlers("agent_start")).toBe(true);
  const notify = vi.fn();
  const ui = { notify } as any;
  harness.session.extensionRunner.setUIContext(ui);
  const sessionContext = getSessionContextStack().at(-1);
  if (sessionContext) {
    sessionContext.ui = ui;
    sessionContext.lifecycle = "started";
    sessionContext.sessionManager = harness.sessionManager;
  }
  (globalThis as any).__piSubagenturaUi = ui;
  const pi = (globalThis as any).__piSubagenturaPiRef;
  const sendMessage = vi.fn(pi.sendMessage.bind(pi));
  pi.sendMessage = sendMessage;
  __setTmuxMultiplexer({
    getPaneLiveness: () => "alive",
    observePane: async () => ({ kind: "alive" }),
  } as any);
  const art = artifactPath(repoRoot, "session-harness");
  const state: any = {
    id: "session-harness",
    paneId: "none",
    mux: "tmux",
    cwd: repoRoot,
    artifactDir: art.dir,
    eventsFile: art.statusFile,
    outputFile: art.outputFile,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    status: "running",
    notifyOnComplete: mode,
    triggerTurnOnComplete: triggerTurn,
    parentSessionId: harness.sessionManager.getSessionId(),
    eventByteCursor: 0,
    pendingDeliveries: [],
    deliveryReceipts: [],
  };
  interactiveSubagentRegistry.set(state.id, state);
  enqueueDelivery(state, {
    deliveryId: `${mode}-${triggerTurn}-${harnesses.length}`,
    subagentId: state.id,
    turnId: "turn-1",
    eventId: "event-1",
    mode,
    triggerTurn,
    status: "done",
    artifactDir: art.dir,
    message: `${mode} completion`,
    state: "queued",
  });
  return { harness, notify, sendMessage, state };
}

describe("Pi session delivery integration", () => {
  it("idle notify persists a pointer without calling the provider", async () => {
    const { harness, notify, sendMessage } = await setup("notify", false);

    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was not injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "No new parent turn will start automatically",
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0][0] as any;
    expect(message.content).toContain("Output:");
    expect(message.content).not.toContain("<untrusted-subagent-output>");
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: false,
    });
    expect(
      harness.sessionManager
        .getEntries()
        .some((entry: any) => entry.type === "custom_message"),
    ).toBe(true);
    expect(harness.contexts).toHaveLength(0);
  });

  it("idle inject triggers one attributed provider turn by default", async () => {
    const { harness, notify } = await setup("inject", true);

    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "A new parent turn will start automatically after the injection",
    );

    expect(
      harness.sessionManager
        .getEntries()
        .some(
          (entry: any) =>
            entry.type === "custom_message" &&
            entry.customType === "subagent-notify",
        ),
    ).toBe(true);
    harness.completeNext();
    await vi.waitFor(() =>
      expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false),
    );
    expect(harness.contexts).toHaveLength(1);
  });

  it("dispatches idle inject despite a stale streaming flag", async () => {
    const { harness } = await setup("inject", true);
    (globalThis as any).__piSubagenturaParentStreaming = true;

    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );

    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it("queues one streaming inject before its provider turn", async () => {
    const { harness, sendMessage, state } = await setup("inject", true);
    const firstTurn = harness.session.prompt("parent turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    (globalThis as any).__piSubagenturaSessionManager = harness.sessionManager;

    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(state.pendingDeliveries).toHaveLength(1);
    expect(harness.contexts).toHaveLength(1);

    harness.completeNext("parent done");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    expect(harness.contexts[1].messages.at(-1)).toMatchObject({
      role: "user",
    });
    expect(
      harness.sessionManager
        .getEntries()
        .filter(
          (entry: any) =>
            entry.type === "custom_message" &&
            entry.customType === "subagent-notify",
        ),
    ).toHaveLength(1);
    harness.completeNext("follow-up done");
    await vi.waitFor(() =>
      expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false),
    );
    expect(harness.contexts).toHaveLength(2);
    await firstTurn;
  });

  it("streaming notify without trigger persists context after agent_settled", async () => {
    const { harness, notify, sendMessage } = await setup("notify", false);
    const firstTurn = harness.session.prompt("parent turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));

    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(notify).not.toHaveBeenCalled();
    harness.completeNext();
    await vi.waitFor(() =>
      expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false),
    );

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was not injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "No new parent turn will start automatically",
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(
      harness.sessionManager
        .getEntries()
        .filter((entry: any) => entry.type === "custom_message"),
    ).toHaveLength(1);
    expect(harness.contexts).toHaveLength(1);
    await firstTurn;
  });

  it("streaming notify with trigger schedules exactly one follow-up provider call", async () => {
    const { harness } = await setup("notify", true);
    const firstTurn = harness.session.prompt("parent turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));

    harness.completeNext();
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.completeNext();
    await vi.waitFor(() =>
      expect((globalThis as any).__piSubagenturaParentStreaming).toBe(false),
    );

    expect(harness.contexts).toHaveLength(2);
    await firstTurn;
  });

  it("idle notify with trigger schedules one provider call", async () => {
    const { harness } = await setup("notify", true);
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it("idle inject with trigger=false enters context without a provider call", async () => {
    const { harness, notify, sendMessage } = await setup("inject", false);
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(harness.contexts).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Completion output was injected into the parent LLM",
      ),
      "info",
    );
    expect(notify.mock.calls[0][0]).toContain(
      "No new parent turn will start automatically",
    );
  });

  it("streaming inject with trigger=false waits then does not continue", async () => {
    const { harness, state } = await setup("inject", false);
    const first = harness.session.prompt("parent turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(state.pendingDeliveries).toHaveLength(1);
    harness.completeNext();
    await first;
    await harness.session.waitForIdle();
    expect(harness.contexts).toHaveLength(1);
    expect(
      harness.sessionManager
        .getEntries()
        .filter((entry: any) => entry.type === "custom_message"),
    ).toHaveLength(1);
  });

  it("retries a synchronous sendMessage failure without losing the intent", async () => {
    const { harness, sendMessage, state } = await setup("inject", true);
    sendMessage.mockImplementationOnce(() => {
      throw new Error("synchronous dispatch failure");
    });
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    expect(state.pendingDeliveries).toEqual([
      expect.objectContaining({ state: "queued" }),
    ]);
    flushDeliveries(
      (globalThis as any).__piSubagenturaPiRef,
      (globalThis as any).__piSubagenturaUi,
    );
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it.each([
    ["error", "failure"],
    ["cancelled", "cancelled"],
    ["done", ""],
    ["done", undefined],
  ] as const)(
    "delivers one provider call for %s completion with output %s",
    async (status, message) => {
      const { harness, state } = await setup("inject", true);
      state.pendingDeliveries[0].status = status;
      state.pendingDeliveries[0].message = message;
      flushDeliveries(
        (globalThis as any).__piSubagenturaPiRef,
        (globalThis as any).__piSubagenturaUi,
      );
      await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
      harness.completeNext();
      await harness.session.waitForIdle();
      expect(harness.contexts).toHaveLength(1);
    },
  );

  it("batches a triggering burst despite a stale streaming flag", async () => {
    const harness = await createPiSessionHarness(repoRoot);
    harnesses.push(harness);
    const sessionContext = getSessionContextStack().at(-1);
    if (sessionContext) {
      sessionContext.lifecycle = "started";
      sessionContext.sessionManager = harness.sessionManager;
    }
    (globalThis as any).__piSubagenturaParentStreaming = true;
    const result: any = {
      isError: false,
      output: "result",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    };
    const first: any = {
      id: "burst-first",
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      notificationDelivered: false,
    };
    const second: any = {
      id: "burst-second",
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      notificationDelivered: false,
    };
    deliverNotification(first, result);
    deliverNotification(second, result);
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(
      harness.sessionManager
        .getEntries()
        .filter((entry: any) => entry.type === "custom_message"),
    ).toHaveLength(1);
    harness.completeNext();
    await harness.session.waitForIdle();
  });

  it("delivers artifact completion through poller and broker", async () => {
    const harness = await createPiSessionHarness(repoRoot);
    harnesses.push(harness);
    const art = childArtifact();
    const state: any = {
      id: art.id,
      paneId: "%artifact",
      mux: "tmux",
      cwd: repoRoot,
      artifactDir: art.dir,
      sessionFile: join(art.dir, "session.jsonl"),
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "running",
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      eventByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
    };
    interactiveSubagentRegistry.set(state.id, state);
    __setTmuxMultiplexer({
      observePane: async () => ({ kind: "alive" }),
      getPaneLiveness: () => "alive",
    } as any);
    writeOutput(art, "immutable artifact result");
    appendCompletionEvent(art, {
      turnId: "artifact-turn",
      outcome: "done",
      source: "explicit",
    });

    await pollArtifactChanges((globalThis as any).__piSubagenturaPiRef);
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(harness.contexts[0].messages.at(-1)).toMatchObject({ role: "user" });
    harness.completeNext();
    await harness.session.waitForIdle();
  });
});

describe("child protocol lifecycle integration", () => {
  it("uses persisted user entry ids for first and second turns", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);

    const first = harness.session.prompt("first turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext("first done");
    await first;
    await harness.session.waitForIdle();
    const second = harness.session.prompt("second turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.completeNext("second done");
    await second;
    await harness.session.waitForIdle();

    const userIds = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => entry.id);
    const events = readEventRecords(art).map(({ event }) => event);
    expect(
      events
        .filter((event) => event.type === "turn_started")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      events
        .filter((event) => event.type === "completion")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
  });

  it("gives a mid-run steering message its own completion snapshot", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);
    const cli = join(art.dir, "cli.mjs");

    const run = harness.session.prompt("initial turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    writeCliScript(cli);
    await harness.session.prompt("mid-run follow-up", {
      streamingBehavior: "steer",
    });
    writeOutput(art, "initial output");
    expect(
      spawnSync(process.execPath, [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);

    harness.completeNext("initial assistant response");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    writeOutput(art, "follow-up output");
    expect(
      spawnSync(process.execPath, [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);
    harness.completeNext("follow-up assistant response");
    await run;
    await harness.session.waitForIdle();

    const userIds = harness.sessionManager
      .getEntries()
      .filter(
        (entry: any) =>
          entry.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => entry.id);
    const events = readEventRecords(art).map(({ event }) => event);
    expect(
      events
        .filter((event) => event.type === "turn_started")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      events
        .filter((event) => event.type === "completion")
        .map((event: any) => event.turnId),
    ).toEqual(userIds);
    expect(
      listOutputHistory(art).map((entry) =>
        entry.output ? readFileSync(entry.output.path, "utf8") : null,
      ),
    ).toEqual(["initial output", "follow-up output"]);
  });

  it("retry success ignores the intermediate error completion", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
      retrySettings: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("retry then succeed");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.failNext();
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.completeNext("recovered");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({
        outcome: "done",
        source: "agent_settled",
      }),
    ]);
  });

  it("retry exhaustion records only the final error", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
      retrySettings: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("retry then fail");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.failNext("rate limit, please retry your request: first");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(2));
    harness.failNext("rate limit, please retry your request: final");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({
        outcome: "error",
        source: "agent_settled",
        errorMessage: expect.stringContaining("final"),
      }),
    ]);
  });

  it("deduplicates explicit CLI completion against agent_settled", async () => {
    const art = childArtifact();
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);
    const prompt = harness.session.prompt("explicit completion");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        JSON.parse(readFileSync(join(art.dir, "active-turn.json"), "utf8"))
          .started,
      ).toBe(true),
    );
    writeOutput(art, "explicit result");
    const cli = join(art.dir, "cli.mjs");
    writeCliScript(cli);
    expect(
      spawnSync("node", [cli, "done", "0"], {
        env: { ...process.env, ARTIFACT_DIR: art.dir },
      }).status,
    ).toBe(0);
    harness.completeNext("settled result");
    await prompt;
    await harness.session.waitForIdle();

    const completions = readEventRecords(art)
      .map(({ event }) => event)
      .filter((event) => event.type === "completion") as any[];
    expect(completions).toEqual([
      expect.objectContaining({ outcome: "done", source: "explicit" }),
    ]);
  });

  it("resets output.md at turn start so an empty turn cannot inherit stale output", async () => {
    const art = childArtifact();
    writeOutput(art, "stale output from the previous turn");
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: art.dir,
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("produce no artifact output");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(readFileSync(art.outputFile, "utf8")).toBe("");
    harness.completeNext("provider answer only");
    await prompt;
    await harness.session.waitForIdle();

    const completion = readEventRecords(art)
      .map(({ event }) => event)
      .find((event) => event.type === "completion") as any;
    expect(completion.output.bytes).toBe(0);
    expect(readFileSync(completion.output.path, "utf8")).toBe("");
  });
});

describe("persisted delivery Pi session integration", () => {
  async function persistedHarness(acknowledged: boolean) {
    const art = childArtifact();
    const cwd = join(art.dir, "..");
    const completion = appendDeterministicTurn(
      art,
      1,
      "persisted immutable result",
    );
    const deliveryId = "persisted-delivery";
    appendInteractiveState(cwd, {
      id: art.id,
      paneId: "%persisted",
      mux: "tmux",
      artifactDir: art.dir,
      sessionFile: join(art.dir, "session.jsonl"),
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      parentSessionId: "pi",
      eventByteCursor: eventLogEndOffset(art),
      sessionByteCursor: 0,
      pendingDeliveries: [
        {
          deliveryId,
          subagentId: art.id,
          turnId: completion.turnId,
          eventId: completion.eventId,
          mode: "inject",
          triggerTurn: true,
          status: "done",
          artifactDir: art.dir,
          output: completion.output,
          state: "dispatchAttempted",
        },
      ],
      deliveryReceipts: [],
      lifecycle: {
        currentTurnId: completion.turnId,
        completionTurnId: completion.turnId,
        completionOutcome: "done",
        completionSource: "explicit",
      },
    });
    const sessionManager = SessionManager.inMemory();
    if (acknowledged) {
      sessionManager.appendCustomMessageEntry(
        "subagent-notify",
        "acknowledged",
        true,
        { deliveryIds: [deliveryId] },
      );
    }
    const harness = await createPiSessionHarness(cwd, {
      extensionRoot: repoRoot,
      sessionManager,
    });
    harnesses.push(harness);
    rehydrateInteractiveSubagents(cwd, undefined, sessionManager.getEntries());
    return { art, harness, deliveryId };
  }

  it("does not replay an acknowledged persisted delivery", async () => {
    const { art, harness, deliveryId } = await persistedHarness(true);
    expect(interactiveSubagentRegistry.get(art.id)?.deliveryReceipts).toContain(
      deliveryId,
    );

    await pollArtifactChanges((globalThis as any).__piSubagenturaPiRef);

    expect(harness.contexts).toHaveLength(0);
    expect(interactiveSubagentRegistry.get(art.id)?.pendingDeliveries).toEqual(
      [],
    );
  });

  it("retries an unacknowledged persisted dispatchAttempted delivery", async () => {
    const { art, harness } = await persistedHarness(false);
    expect(interactiveSubagentRegistry.get(art.id)?.pendingDeliveries).toEqual([
      expect.objectContaining({ state: "queued" }),
    ]);

    await pollArtifactChanges((globalThis as any).__piSubagenturaPiRef);

    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    expect(harness.contexts[0].messages.at(-1)).toMatchObject({ role: "user" });
    harness.completeNext();
    await harness.session.waitForIdle();
  });
});
