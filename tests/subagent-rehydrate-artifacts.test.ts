/**
 * Tests protocol-v2 artifact-derived rehydration and owner-scoped delivery queues.
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { registerSessionHandlers as registerSessionHandlersType } from "../src/session-handlers";
import type * as SubagentModule from "../src/subagent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  appendInteractiveState,
  artifactPath,
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  loadInteractiveStates,
  stateFilePath,
} from "../src/artifact";
import {
  COMPLETION_CONSUMED_ENTRY_TYPE,
  COMPLETION_ENTRY_TYPE,
  COMPLETION_MANIFEST_TYPE,
  clearCompletionCoordinator,
  completionLatencyForIds,
  consumeCompletionSource,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionCoordinator,
  registerCompletionMember,
  restoreDurableCompletionGroupsSync,
  sealCompletionGroups,
} from "../src/completion-coordinator";
import { sessionLedgerPath } from "../src/completion-ledger";
import { flushDeliveries } from "../src/delivery";
import { createTestSessionScope } from "./session-scope-fixture";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { importFresh } from "./test-utils";
import { makeTmp } from "./subagent-rehydrate-helpers";

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;
  let scope: SessionScope;
  let completionScope: SessionScope | undefined;
  beforeEach(() => {
    cwd = makeTmp();
    // Install a tmux mock so isPaneAlive returns false for fake pane IDs.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string) => {
        throw new Error("mock: child_process unavailable");
      },
    }));
    clearSessionScopes();
    scope = createTestSessionScope({ cwd });
  });

  afterEach(() => {
    if (completionScope) {
      clearCompletionCoordinator(sessionOwner(completionScope));
      completionScope = undefined;
    }
    rmSync(cwd, { recursive: true, force: true });
    clearSessionScopes();
    vi.doUnmock("node:child_process");
  });

  it("recovers name from prompt file and startedAt from first event", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "recover-me";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });

    // Create a prompt file: the label before "-prompt.md" becomes the name
    writeFileSync(join(artDir, "my-agent-prompt.md"), "task content", {
      mode: 0o600,
    });

    // Persist state entry (name not in persisted state — recovered from prompt file)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      eventByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      lifecycle: { startedAt: 1000 },
    });

    // Event history remains available without being reparsed during rehydrate.
    const art = artifactPath(cwd, id);
    appendEvent(art, {
      version: 2,
      eventId: "recover-start",
      turnId: "recover-turn",
      ts: 1000,
      type: "turn_started",
      status: "running",
    });
    appendEvent(art, {
      version: 2,
      eventId: "recover-done",
      turnId: "recover-turn",
      ts: 2000,
      type: "completion",
      status: "done",
      outcome: "done",
      source: "agent_settled",
      exitCode: 0,
    });

    mod.rehydrateInteractiveSubagents(cwd, undefined, [], scope);

    const rehydrated = scope.interactiveStates.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe("my-agent"); // from prompt file label
    expect(rehydrated?.startedAt).toBe(1000);
  });

  it("falls back to id for name and 0 for startedAt when artifacts are missing", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "fallback-id";

    // Persist state with no artifact files (dir won't exist)
    appendInteractiveState(cwd, {
      id,
      paneId: "%99",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/sess.jsonl",
    });

    mod.rehydrateInteractiveSubagents(cwd, undefined, [], scope);

    const rehydrated = scope.interactiveStates.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe(id); // falls back to entry.id
    expect(rehydrated?.startedAt).toBe(0); // falls back to 0
  });

  it("recovers a legacy tombstone without a timestamp as expired", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "legacy-tombstoned-spawn";
    appendInteractiveState(cwd, {
      id,
      paneId: "%099",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/legacy-tombstoned.jsonl",
      parentSessionId: "reload-parent",
      completionTombstone: "failed",
    });
    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);
    expect(scope.interactiveStates.has(id)).toBe(true);
  });

  it("does not rehydrate a failed completion-registration tombstone", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "tombstoned-spawn";
    appendInteractiveState(cwd, {
      id,
      paneId: "%100",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/tombstoned.jsonl",
      parentSessionId: "reload-parent",
      completionPolicy: "group",
      completionGroupId: "failed-group",
      completionTombstone: "failed",
      completionTombstoneAt: Date.now(),
    });
    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);
    expect(scope.interactiveStates.has(id)).toBe(false);
  });

  it("allows an expired failed tombstone to be recovered", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "expired-tombstone";
    appendInteractiveState(cwd, {
      id,
      paneId: "%101",
      mux: "tmux",
      artifactDir: join(cwd, id),
      sessionFile: "/tmp/expired-tombstone.jsonl",
      parentSessionId: "reload-parent",
      completionTombstone: "failed",
      completionTombstoneAt: Date.now() - 6 * 60 * 1000,
    });
    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);
    expect(scope.interactiveStates.has(id)).toBe(true);
  });

  it("rehydrates same-session artifacts into the current scope generation", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "generation-owned";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    appendInteractiveState(cwd, {
      id,
      paneId: "%101",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child.jsonl"),
      parentSessionId: "reload-parent",
    });
    const scope = registerSessionScope({
      id: 710,
      generation: 9,
      lifecycle: "started",
      pi: {} as never,
      sessionManager: { getSessionId: () => "reload-parent" },
    });

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    const rehydrated = scope.interactiveStates.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.sessionOwner).toEqual({ id: 710, generation: 9 });
    expect(rehydrated?.artifactDir).toBe(artDir);
  });

  it("registers grouped pending deliveries even when the pane policy reset to each", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "pending-group-membership";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    const entries: SessionEntry[] = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        });
      }),
      sendMessage: vi.fn(),
    };
    completionScope = registerSessionScope({
      id: 715,
      generation: 1,
      lifecycle: "started",
      pi: pi as never,
      parentStreaming: false,
      sessionManager: {
        getSessionId: () => "reload-parent",
        getEntries: () => entries,
      },
    });
    registerCompletionCoordinator(pi as never, completionScope);
    appendInteractiveState(cwd, {
      id,
      paneId: "%101",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child-group.jsonl"),
      parentSessionId: "reload-parent",
      completionPolicy: "each",
      pendingDeliveries: [
        {
          deliveryId: "grouped-delivery",
          subagentId: id,
          turnId: "turn-grouped",
          eventId: "event-grouped",
          status: "done",
          artifactDir: artDir,
          completionPolicy: "group",
          completionGroupId: "reload-group",
          state: "queued",
        },
      ],
      deliveryReceipts: [],
    });

    mod.rehydrateInteractiveSubagents(
      cwd,
      "reload-parent",
      entries,
      completionScope,
    );
    sealCompletionGroups(sessionOwner(completionScope));
    flushDeliveries(pi as never, undefined, sessionOwner(completionScope));

    const completion = entries.find(
      (entry): entry is Extract<SessionEntry, { type: "custom" }> =>
        entry.type === "custom" &&
        entry.customType === "subagentura-completion",
    );
    expect(completion?.data).toMatchObject({
      source: "interactive",
      sourceId: id,
      policy: "group",
      groupId: "reload-group",
      completedAt: expect.any(Number),
    });
    expect(completion?.data).not.toHaveProperty("telemetryCompletedAt");
    expect(
      completionLatencyForIds(
        ["grouped-delivery"],
        sessionOwner(completionScope),
      ),
    ).toBeUndefined();
  });
  it("flushes both queued each-policy completion notices after dropping stale group metadata", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "pending-each-stale-group";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    const entries: SessionEntry[] = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        });
      }),
      sendMessage: vi.fn(),
    };
    const testScope = registerSessionScope({
      id: 722,
      generation: 1,
      lifecycle: "started",
      pi: pi as never,
      parentStreaming: false,
      sessionManager: {
        getSessionId: () => "reload-parent",
        getEntries: () => entries,
      },
    });
    completionScope = testScope;
    registerCompletionCoordinator(pi as never, testScope);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      stateFilePath(cwd),
      JSON.stringify({
        schemaVersion: 2,
        parent: "pi",
        states: {
          [id]: {
            id,
            paneId: "%106",
            mux: "tmux",
            artifactDir: artDir,
            sessionFile: join(cwd, "child-each-stale-group.jsonl"),
            parentSessionId: "reload-parent",
            eventByteCursor: 0,
            pendingDeliveries: [
              {
                deliveryId: "stale-each-delivery",
                subagentId: id,
                turnId: "stale-each-turn",
                eventId: "stale-each-event",
                mode: "notify",
                triggerTurn: true,
                status: "done",
                artifactDir: artDir,
                completionPolicy: "each",
                completionGroupId: "stale-each-group",
                state: "queued",
              },
              {
                deliveryId: "valid-each-delivery",
                subagentId: id,
                turnId: "valid-each-turn",
                eventId: "valid-each-event",
                status: "done",
                artifactDir: artDir,
                completionPolicy: "each",
                state: "queued",
              },
            ],
            deliveryReceipts: [],
          },
        },
      }),
      { mode: 0o600 },
    );

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", entries, testScope);
    expect(
      testScope.interactiveStates.get(id)?.pendingDeliveries?.[0],
    ).not.toHaveProperty("completionGroupId");

    sealCompletionGroups(sessionOwner(testScope));
    expect(() =>
      flushDeliveries(pi as never, undefined, sessionOwner(testScope)),
    ).not.toThrow();

    const completions = entries
      .filter(
        (
          entry,
        ): entry is Extract<SessionEntry, { type: "custom" }> & {
          data: unknown;
        } =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion" &&
          "data" in entry,
      )
      .map((entry) => entry.data);
    expect(completions).toHaveLength(2);
    expect(completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          completionId: "stale-each-delivery",
          policy: "each",
        }),
        expect.objectContaining({
          completionId: "valid-each-delivery",
          policy: "each",
        }),
      ]),
    );
    for (const completion of completions) {
      expect(completion).not.toHaveProperty("groupId");
    }
  });

  it("registers pending receipt expectations before scanning fallback history", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "rehydrated-receipt";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const entries: SessionEntry[] = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        });
      }),
      sendMessage: vi.fn(),
    };
    completionScope = registerSessionScope({
      id: 717,
      generation: 1,
      lifecycle: "started",
      pi: pi as never,
      cwd,
      parentStreaming: false,
      sessionManager: {
        getSessionId: () => "reload-parent",
        getSessionDir: () => cwd,
        getEntries: () => entries,
      },
    });
    registerCompletionCoordinator(pi as never, completionScope);
    appendInteractiveState(cwd, {
      id,
      paneId: "%105",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child-receipt.jsonl"),
      parentSessionId: "reload-parent",
      completionPolicy: "each",
      pendingDeliveries: [
        {
          deliveryId: id,
          subagentId: id,
          turnId: "receipt-turn",
          eventId: "receipt-event",
          status: "done",
          artifactDir: artDir,
          completionPolicy: "each",
          state: "queued",
        },
      ],
      deliveryReceipts: [],
    });
    const ledgerPath = sessionLedgerPath(
      cwd,
      "reload-parent",
      "subagentura-completion-consumed",
    );
    const receipt = JSON.stringify({
      schemaVersion: 1,
      source: "interactive",
      sourceId: id,
      turnId: "receipt-turn",
      consumedAt: 1,
      reason: "manual",
    });
    const filler = Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({
        schemaVersion: 1,
        source: "in-process",
        sourceId: `receipt-filler-${index}`,
        turnId: `receipt-filler-turn-${index}`,
        consumedAt: index + 2,
        reason: "manual",
      }),
    ).join("\n");
    writeFileSync(ledgerPath, `${receipt}\n${filler}\n`, { mode: 0o600 });

    mod.rehydrateInteractiveSubagents(
      cwd,
      "reload-parent",
      entries,
      completionScope,
    );
    flushDeliveries(pi as never, undefined, sessionOwner(completionScope));

    expect(
      entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion",
      ),
    ).toHaveLength(1);
    expect(
      prepareCompletionManifest(sessionOwner(completionScope)),
    ).toBeUndefined();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("reconciles fallback receipts through session-start recovery", async () => {
    const id = "rehydrated-receipt";
    const parentSessionId = "reload-parent";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    const entries: SessionEntry[] = [];
    const handlers = new Map<string, Function[]>();
    let failReceiptAppend = true;
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      }),
      appendEntry: vi.fn((customType: string, data: unknown) => {
        if (
          failReceiptAppend &&
          customType === COMPLETION_CONSUMED_ENTRY_TYPE
        ) {
          throw new Error("simulated Pi receipt append failure");
        }
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        });
      }),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
      getFlag: vi.fn(() => undefined),
    };
    const { registerSessionHandlers } = await importFresh<{
      registerSessionHandlers: typeof registerSessionHandlersType;
    }>("../src/session-handlers");
    clearSessionScopes();
    completionScope = registerSessionHandlers(
      pi as never,
      undefined,
      false,
      () => false,
    );
    const ui = {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    };
    const sessionManager = {
      getSessionId: () => parentSessionId,
      getSessionDir: () => cwd,
      getEntries: () => entries,
      getBranch: () => [],
    };
    const ctx = { cwd, ui, sessionManager };
    const sessionStart = handlers.get("session_start")![0];
    const sessionShutdown = handlers.get("session_shutdown")![0];

    try {
      appendInteractiveState(cwd, {
        id,
        paneId: "%105",
        mux: "tmux",
        artifactDir: artDir,
        sessionFile: join(cwd, "child-receipt.jsonl"),
        parentSessionId,
        completionPolicy: "each",
        pendingDeliveries: [
          {
            deliveryId: id,
            subagentId: id,
            turnId: "receipt-turn",
            eventId: "receipt-event",
            status: "done",
            artifactDir: artDir,
            completionPolicy: "each",
            state: "queued",
          },
        ],
        deliveryReceipts: [],
      });
      await sessionStart({ reason: "startup" }, ctx);

      const priorOwner = sessionOwner(completionScope);
      expect(
        consumeCompletionSource(
          pi as never,
          {
            source: "interactive",
            sourceId: id,
            turnId: "receipt-turn",
          },
          priorOwner,
        ),
      ).toBe(true);
      expect(pi.appendEntry).toHaveBeenCalledWith(
        COMPLETION_CONSUMED_ENTRY_TYPE,
        expect.objectContaining({
          source: "interactive",
          sourceId: id,
          turnId: "receipt-turn",
        }),
      );
      const ledgerPath = sessionLedgerPath(
        cwd,
        parentSessionId,
        "subagentura-completion-consumed",
      );
      expect(readFileSync(ledgerPath, "utf8")).toContain(
        '"turnId":"receipt-turn"',
      );
      expect(entries).toHaveLength(0);

      failReceiptAppend = false;
      await sessionStart({ reason: "reload" }, ctx);
      const owner = sessionOwner(completionScope);
      flushDeliveries(pi as never, ui, owner);
      const replayedManifest = prepareCompletionManifest(owner);

      const recovered = completionScope.interactiveStates.get(id);
      expect(recovered).toBeDefined();
      recovered!.pendingDeliveries!.push({
        deliveryId: "later-unconsumed-delivery",
        subagentId: id,
        turnId: "later-turn",
        eventId: "later-event",
        status: "done",
        artifactDir: artDir,
        completionPolicy: "each",
        state: "queued",
      });
      flushDeliveries(pi as never, ui, owner);
      const laterManifest = prepareCompletionManifest(owner);

      expect(replayedManifest).toBeUndefined();
      expect(laterManifest?.details.completionIds).toEqual([
        "later-unconsumed-delivery",
      ]);
    } finally {
      sessionShutdown({ reason: "quit" }, ctx);
    }
  });

  it("keeps a published interactive error terminal after group snapshot repair", async () => {
    const mod = await importFresh<typeof SubagentModule>("../src/subagent");
    clearSessionScopes();
    const id = "interactive-error-member";
    const deliveryId = "interactive-error-delivery";
    const workflowId = "wfd_mixed-peer";
    const groupId = "mixed-error-repair";
    const parentSessionId = "reload-parent";
    const artifactDir = join(cwd, id);
    mkdirSync(artifactDir, { recursive: true });
    const entries: SessionEntry[] = [];
    const pi = {
      appendEntry: vi.fn((customType: string, data: unknown) => {
        entries.push({
          type: "custom",
          id: `test-entry-${entries.length}`,
          parentId: entries.at(-1)?.id ?? null,
          timestamp: "1970-01-01T00:00:00.000Z",
          customType,
          data,
        });
      }),
      registerEntryRenderer: vi.fn(),
      sendMessage: vi.fn(),
    };
    const ownerScope = registerSessionScope({
      id: 719,
      generation: 1,
      lifecycle: "started",
      pi: pi as never,
      cwd,
      parentStreaming: true,
      sessionManager: {
        getSessionId: () => parentSessionId,
        getSessionDir: () => cwd,
        getEntries: () => entries,
      },
    });
    completionScope = ownerScope;
    registerCompletionCoordinator(pi as never, ownerScope);
    const owner = sessionOwner(ownerScope);

    appendInteractiveState(cwd, {
      id,
      paneId: "%119",
      mux: "tmux",
      artifactDir,
      sessionFile: join(cwd, "interactive-error.jsonl"),
      parentSessionId,
      completionPolicy: "group",
      completionGroupId: groupId,
      pendingDeliveries: [
        {
          deliveryId,
          subagentId: id,
          turnId: "error-turn",
          eventId: "error-event",
          status: "error",
          artifactDir,
          completionPolicy: "group",
          completionGroupId: groupId,
          state: "queued",
        },
      ],
      deliveryReceipts: [],
    });
    registerCompletionMember("interactive", id, "group", groupId, owner);
    registerCompletionMember("workflow", workflowId, "group", groupId, owner);
    sealCompletionGroups(owner);

    const groupDirectory = `${sessionLedgerPath(
      cwd,
      parentSessionId,
      "subagentura-completion-groups",
    )}.groups`;
    const groupFileName = readdirSync(groupDirectory).find((name) =>
      name.endsWith(".json"),
    );
    expect(groupFileName).toBeDefined();
    const groupPath = join(groupDirectory, groupFileName!);
    const validSnapshot = readFileSync(groupPath, "utf8");
    const invalidSnapshot = "corrupt completion group snapshot\n";
    clearCompletionCoordinator(owner);
    writeFileSync(groupPath, invalidSnapshot, { mode: 0o600 });
    expect(() => restoreDurableCompletionGroupsSync(owner)).toThrow();
    expect(readFileSync(groupPath, "utf8")).toBe(invalidSnapshot);

    try {
      mod.rehydrateInteractiveSubagents(
        cwd,
        parentSessionId,
        entries,
        ownerScope,
      );
      flushDeliveries(pi as never, undefined, owner);
      const errorManifest = prepareCompletionManifest(owner);
      expect(errorManifest?.details.completionIds).toEqual([deliveryId]);
      expect(errorManifest?.content).toContain('"status":"error"');
      entries.push({
        type: "custom",
        id: "interactive-error-manifest",
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "1970-01-01T00:00:00.000Z",
        customType: COMPLETION_MANIFEST_TYPE,
        data: errorManifest!.details,
      });
      const acknowledged = loadInteractiveStates(cwd)?.states[id];
      expect(acknowledged?.pendingDeliveries).toEqual([]);
      expect(acknowledged?.deliveryReceipts).toContain(deliveryId);
      expect(readFileSync(groupPath, "utf8")).toBe(invalidSnapshot);

      writeFileSync(groupPath, validSnapshot, { mode: 0o600 });
      clearCompletionCoordinator(owner);
      ownerScope.interactiveStates.clear();
      advanceSessionScopeGeneration(ownerScope.id);
      const reloadedOwner = sessionOwner(ownerScope);
      restoreDurableCompletionGroupsSync(reloadedOwner);
      mod.rehydrateInteractiveSubagents(
        cwd,
        parentSessionId,
        entries,
        ownerScope,
      );
      sealCompletionGroups(reloadedOwner);
      ownerScope.parentStreaming = false;
      expect(prepareCompletionManifest(reloadedOwner)).toBeUndefined();

      const workflowCompletionId = `workflow:${workflowId}`;
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: workflowCompletionId,
          source: "workflow",
          sourceId: workflowId,
          label: "Recovered workflow",
          status: "done",
          policy: "group",
          groupId,
          references: [{ label: "result", value: "workflow-result" }],
          completedAt: Date.now(),
        },
        reloadedOwner,
      );
      const workflowManifest = prepareCompletionManifest(reloadedOwner);
      expect(workflowManifest?.details.completionIds).toEqual([
        workflowCompletionId,
      ]);
      expect(workflowManifest?.details.groups).toEqual([groupId]);
      expect(workflowManifest?.details.completionIds).not.toContain(deliveryId);
      const workflowRecord = entries.find((entry) => {
        if (
          entry.type !== "custom" ||
          entry.customType !== COMPLETION_ENTRY_TYPE ||
          typeof entry.data !== "object" ||
          entry.data === null ||
          !("completionId" in entry.data)
        ) {
          return false;
        }
        return entry.data.completionId === workflowCompletionId;
      });
      expect(workflowRecord).toBeDefined();
      if (!workflowRecord || workflowRecord.type !== "custom") {
        throw new Error("Workflow completion record was not persisted.");
      }
      expect(workflowRecord.data).toMatchObject({
        groupId,
        groupComplete: true,
      });
    } finally {
      clearCompletionCoordinator(sessionOwner(ownerScope));
    }
  });

  it("downgrades only an over-capacity row and continues rehydrating later states", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    completionScope = registerSessionScope({
      id: 716,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      sessionManager: { getSessionId: () => "reload-parent" },
    });
    const groupId = "over-capacity-group";
    for (let index = 0; index < 33; index++) {
      const id = `group-member-${String(index).padStart(2, "0")}`;
      const artDir = join(cwd, id);
      mkdirSync(artDir, { recursive: true });
      appendInteractiveState(cwd, {
        id,
        paneId: `%${200 + index}`,
        mux: "tmux",
        artifactDir: artDir,
        sessionFile: join(cwd, `${id}.jsonl`),
        parentSessionId: "reload-parent",
        completionPolicy: "group",
        completionGroupId: groupId,
        ...(index === 32
          ? {
              pendingDeliveries: [
                {
                  deliveryId: "over-capacity-delivery",
                  subagentId: id,
                  turnId: "over-capacity-turn",
                  eventId: "over-capacity-event",
                  status: "done" as const,
                  artifactDir: artDir,
                  completionPolicy: "group" as const,
                  completionGroupId: groupId,
                  state: "queued" as const,
                },
              ],
            }
          : {}),
        deliveryReceipts: [],
      });
    }
    const laterId = "after-over-capacity";
    const laterArtifactDir = join(cwd, laterId);
    mkdirSync(laterArtifactDir, { recursive: true });
    appendInteractiveState(cwd, {
      id: laterId,
      paneId: "%299",
      mux: "tmux",
      artifactDir: laterArtifactDir,
      sessionFile: join(cwd, "later.jsonl"),
      parentSessionId: "reload-parent",
      completionPolicy: "group",
      completionGroupId: "unrelated-group",
      deliveryReceipts: [],
    });

    mod.rehydrateInteractiveSubagents(
      cwd,
      "reload-parent",
      [],
      completionScope,
    );

    const recoveredOverCapacity =
      completionScope.interactiveStates.get("group-member-32");
    expect(recoveredOverCapacity).toMatchObject({
      completionPolicy: "each",
    });
    expect(recoveredOverCapacity?.completionGroupId).toBeUndefined();
    expect(recoveredOverCapacity?.pendingDeliveries).toMatchObject([
      { completionPolicy: "each" },
    ]);
    expect(
      recoveredOverCapacity?.pendingDeliveries?.[0]?.completionGroupId,
    ).toBeUndefined();
    expect(completionScope.interactiveStates.has(laterId)).toBe(true);

    const persisted = loadInteractiveStates(cwd);
    expect(persisted?.states["group-member-32"]).toMatchObject({
      completionPolicy: "each",
    });
    expect(
      persisted?.states["group-member-32"]?.completionGroupId,
    ).toBeUndefined();
    expect(
      persisted?.states["group-member-32"]?.pendingDeliveries,
    ).toMatchObject([{ completionPolicy: "each" }]);
    expect(
      persisted?.states["group-member-32"]?.pendingDeliveries?.[0]
        ?.completionGroupId,
    ).toBeUndefined();
  });
  it("rehydrates a pending delivery using its owning scope state", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "rehydrated-delivery";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    appendInteractiveState(cwd, {
      id,
      paneId: "%102",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child-delivery.jsonl"),
      parentSessionId: "reload-parent",
      completionPolicy: "each",
      eventByteCursor: 0,
      pendingDeliveries: [
        {
          deliveryId: "delivery-a",
          subagentId: id,
          turnId: "turn-a",
          eventId: "event-a",
          status: "done",
          artifactDir: artDir,
          completionPolicy: "each",
          state: "queued",
        },
      ],
      deliveryReceipts: [],
    });
    const scope = registerSessionScope({
      id: 720,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      parentStreaming: false,
      sessionManager: { getSessionId: () => "reload-parent" },
    });
    const peer = registerSessionScope({
      id: 721,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      parentStreaming: true,
    });
    expect(peer.parentStreaming).toBe(true);

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    expect(scope.interactiveStates.get(id)?.pendingDeliveries?.[0]?.state).toBe(
      "queued",
    );
  });

  it("rehydrates into the exact scope despite a colliding peer id", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "colliding-state";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    appendInteractiveState(cwd, {
      id,
      paneId: "%103",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child-collision.jsonl"),
      parentSessionId: "reload-parent",
    });
    const scope = registerSessionScope({
      id: 730,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      sessionManager: { getSessionId: () => "reload-parent" },
    });
    const stale = {
      id,
      artifactDir: join(cwd, "stale", id),
    } as never;
    const peer = createTestSessionScope();
    peer.interactiveStates.set(id, stale);

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    expect(scope.interactiveStates.get(id)).toBeDefined();
    expect(scope.interactiveStates.get(id)).not.toBe(stale);
    expect(peer.interactiveStates.get(id)).toBe(stale);
  });
  it("rejects a persisted entry with a foreign artifact marker", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "abababababababab";
    const artDir = join(cwd, id);
    mkdirSync(artDir, { recursive: true });
    writeFileSync(join(artDir, INTERACTIVE_ARTIFACT_OWNER_FILE), "peer-parent");
    appendInteractiveState(cwd, {
      id,
      paneId: "%104",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: join(cwd, "child-foreign.jsonl"),
      parentSessionId: "reload-parent",
    });
    const scope = registerSessionScope({
      id: 740,
      generation: 1,
      lifecycle: "started",
      pi: {} as never,
      sessionManager: { getSessionId: () => "reload-parent" },
    });

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    expect(scope.interactiveStates.has(id)).toBe(false);
  });
});
