import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  clearCompletionCoordinator,
  completionLatencyForIds,
  MAX_COMPLETION_RECORDS,
  assertCompletionGroupOpen,
  consumeCompletionSource,
  flushCompletionManifests,
  markCompletionHumanInput,
  markCompletionTurnStarting,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionCoordinator,
  registerCompletionExpectations,
  registerCompletionMember,
  reserveCompletionGroup,
  retireSessionScopedCompletions,
  resolveCompletionPolicy,
  sealCompletionGroups,
  settleCompletionParentTurn,
  type CompletionRecord,
} from "../src/completion-coordinator";
import { sessionLedgerPath } from "../src/completion-ledger";
import { createTelemetrySession } from "../src/telemetry";
const coordinatorLedgerRoots: string[] = [];

function record(
  sourceId: string,
  overrides: Partial<CompletionRecord> = {},
): CompletionRecord {
  return {
    schemaVersion: 1,
    completionId: `completion-${sourceId}`,
    source: "interactive",
    sourceId,
    turnId: `turn-${sourceId}`,
    label: `Agent ${sourceId}`,
    status: "done",
    policy: "each",
    references: [
      {
        label: "output",
        value: `/tmp/artifacts/${sourceId}/outputs/event-${sourceId}.md`,
      },
      {
        label: "events",
        value: `/tmp/artifacts/${sourceId}/events.ndjson`,
      },
    ],
    completedAt: 1,
    ...overrides,
  };
}

function setup() {
  const entries: any[] = [];
  const handlers = new Map<string, Function[]>();
  const pi = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn((message: any) => {
      entries.push({ type: "custom_message", ...message });
    }),
    on: vi.fn((name: string, handler: Function) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    }),
  };
  const defaultLedgerRoot = mkdtempSync(
    join(tmpdir(), "completion-coordinator-ledger-"),
  );
  coordinatorLedgerRoots.push(defaultLedgerRoot);
  let registeredScope: SessionScope;
  registeredScope = registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi: pi as never,
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionDir: () => defaultLedgerRoot,
      getEntries: () => entries,
    },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  });
  registerCompletionCoordinator(pi as never, registeredScope);
  return {
    entries,
    handlers,
    pi,
    scope: registeredScope,
    ledgerRoot: defaultLedgerRoot,
  };
}

function manifests(pi: { sendMessage: ReturnType<typeof vi.fn> }) {
  return pi.sendMessage.mock.calls.filter(
    ([message]) => message.customType === "subagent-manifest",
  );
}

function userCompletions(entries: any[]) {
  return entries.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "subagentura-completion",
  );
}

describe("completion coordinator", () => {
  let scope: SessionScope;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (scope) clearCompletionCoordinator(sessionOwner(scope));
    clearSessionScopes();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const root of coordinatorLedgerRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hides technical IDs in collapsed completion entries", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const renderer = setupResult.pi.registerEntryRenderer.mock.calls.find(
      ([type]) => type === "subagentura-completion",
    )?.[1];
    expect(renderer).toBeTypeOf("function");
    const theme = { fg: (_color: string, text: string) => text };
    const entry = { data: record("worker", { label: "Reviewer" }) };
    const collapsed = renderer(entry, { expanded: false }, theme)
      .render(200)
      .join("\n")
      .trimEnd();
    expect(collapsed).toBe("from: Reviewer, ✓ done");
    expect(collapsed).not.toContain("worker");
    expect(collapsed).not.toContain("turn-worker");
    const expanded = renderer(entry, { expanded: true }, theme)
      .render(200)
      .join("\n");
    expect(expanded).toContain('("worker", turn "turn-worker")');
  });
  it("uses known interactive telemetry timestamps and omits legacy latency", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    vi.setSystemTime(10_000);

    publishCompletion(record("legacy-latency", { completedAt: 9_000 }), owner);
    expect(
      completionLatencyForIds(["completion-legacy-latency"], owner),
    ).toBeUndefined();

    publishCompletion(
      record("known-latency", {
        completedAt: 9_000,
        telemetryCompletedAt: 8_000,
      }),
      owner,
    );
    expect(completionLatencyForIds(["completion-known-latency"], owner)).toBe(
      2_000,
    );
  });

  it("defers completion manifests while a UI prompt is active", async () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.uiPromptActive = true;

    publishCompletion(record("ui-prompt"), sessionOwner(scope));
    await Promise.resolve();

    expect(manifests(setupResult.pi)).toHaveLength(0);
    scope.uiPromptActive = false;
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(1);
  });

  it("notifies the user once and sends one independent reference manifest", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    const [message, options] = manifests(setupResult.pi)[0];
    expect(message.content).toContain("outputs/event-a.md");
    expect(message.content).not.toContain("<untrusted-subagent-output>");
    expect(options).toMatchObject({
      deliverAs: "followUp",
      triggerTurn: true,
    });
  });

  it("does not duplicate a notice when append throws after writing", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    let throwAfterWrite = true;
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        setupResult.entries.push({ type: "custom", customType, data });
        if (customType === "subagentura-completion" && throwAfterWrite) {
          throwAfterWrite = false;
          throw new Error("late append failure");
        }
      },
    );

    expect(() =>
      publishCompletion(record("append-then-throw"), sessionOwner(scope)),
    ).not.toThrow();
    await vi.waitFor(() => expect(manifests(setupResult.pi)).toHaveLength(1));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
  });

  it("does not spin while durable notice storage remains unavailable", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    setupResult.pi.appendEntry.mockImplementation(() => {
      throw new Error("disk unavailable");
    });

    publishCompletion(record("persistent-failure"), sessionOwner(scope));
    await vi.waitFor(() =>
      expect(setupResult.pi.appendEntry).toHaveBeenCalledTimes(2),
    );
    const callsAfterInitialRetry = setupResult.pi.appendEntry.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setupResult.pi.appendEntry.mock.calls.length).toBeLessThanOrEqual(
      callsAfterInitialRetry + 1,
    );
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("recovers a transient completion notice append failure", async () => {
    vi.useRealTimers();
    const setupResult = setup();
    scope = setupResult.scope;
    let failed = true;
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        if (failed && customType === "subagentura-completion") {
          failed = false;
          throw new Error("transient storage failure");
        }
        setupResult.entries.push({ type: "custom", customType, data });
      },
    );
    publishCompletion(record("notice-retry"), sessionOwner(scope));
    await vi.waitFor(() => expect(manifests(setupResult.pi)).toHaveLength(1));
    expect(userCompletions(setupResult.entries)).toHaveLength(1);
  });

  it("preserves protocol-valid interactive turn IDs in retrieval selectors", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const turnId = "t".repeat(256);

    publishCompletion(record("long-turn", { turnId }), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)[0].data.turnId).toBe(turnId);
    expect(manifests(setupResult.pi)[0][0].content).toContain(
      JSON.stringify(turnId),
    );
  });

  it("coalesces independent completions that become ready while busy", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;

    publishCompletion(record("a"), sessionOwner(scope));
    publishCompletion(record("b"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(2);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    const content = manifests(setupResult.pi)[0][0].content;
    expect(content).toContain("Agent a");
    expect(content).toContain("Agent b");
  });

  it("waits for a sealed group and every member including errors and cancels", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = {
      policy: "group" as const,
      groupId: "review-group",
    };
    for (const id of ["a", "b", "c"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        sessionOwner(scope),
      );
    }

    publishCompletion(record("a", group), sessionOwner(scope));
    publishCompletion(
      record("b", { ...group, status: "error" }),
      sessionOwner(scope),
    );
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    settleCompletionParentTurn(sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));
    expect(manifests(setupResult.pi)).toHaveLength(0);

    publishCompletion(
      record("c", { ...group, status: "cancelled" }),
      sessionOwner(scope),
    );
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(3);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0][0].details.completionIds).toHaveLength(
      3,
    );
  });

  it("renders grouped progress for each terminal member before the final manifest", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const group = { policy: "group" as const, groupId: "progress-group" };
    for (const id of ["a", "b", "c"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        owner,
      );
    }
    const renderer = setupResult.pi.registerEntryRenderer.mock.calls.find(
      ([type]) => type === "subagentura-completion",
    )?.[1];
    const theme = { fg: (_color: string, text: string) => text };
    const render = (entry: any) =>
      renderer(entry, { expanded: false }, theme)
        .render(200)
        .join("\n")
        .trimEnd();
    scope.parentStreaming = true;

    publishCompletion(record("a", group), owner);
    const first = userCompletions(setupResult.entries)[0];
    expect(first.data.groupRemaining).toBe(2);
    expect(render(first)).toContain(
      "from: Agent a, ✓ done; waiting for 2 more",
    );

    publishCompletion(record("b", { ...group, status: "error" }), owner);
    const second = userCompletions(setupResult.entries)[1];
    expect(second.data.groupRemaining).toBe(1);
    expect(render(second)).toContain(
      "from: Agent b, ✕ error; waiting for 1 more",
    );

    sealCompletionGroups(owner);
    publishCompletion(record("c", { ...group, status: "cancelled" }), owner);
    const final = userCompletions(setupResult.entries)[2];
    expect(final.data.groupRemaining).toBeUndefined();
    expect(final.data.groupComplete).toBe(true);
    expect(render(final)).toBe("from: Agent c, ○ cancelled; group complete");

    scope.parentStreaming = false;
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0][0].details.groups).toEqual([
      "progress-group",
    ]);
  });

  it("preserves grouped progress across coordinator reload and ignores duplicate terminals", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const group = { policy: "group" as const, groupId: "reload-group" };
    for (const id of ["a", "b", "c"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        owner,
      );
    }
    publishCompletion(record("a", group), owner);
    const first = userCompletions(setupResult.entries)[0];
    expect(first.data.groupRemaining).toBe(2);

    publishCompletion(
      record("a", {
        ...group,
        completionId: "duplicate-a",
        turnId: "duplicate-a-turn",
      }),
      owner,
    );
    const duplicate = userCompletions(setupResult.entries)[1];
    expect(duplicate.data.policy).toBe("each");
    expect(duplicate.data.groupRemaining).toBeUndefined();
    expect(duplicate.data.groupComplete).toBeUndefined();

    clearCompletionCoordinator(owner);
    registerCompletionCoordinator(setupResult.pi as never, scope);
    registerCompletionMember("interactive", "b", "group", group.groupId, owner);
    registerCompletionMember("interactive", "c", "group", group.groupId, owner);
    expect(userCompletions(setupResult.entries)[0].data.groupRemaining).toBe(2);

    publishCompletion(record("b", { ...group, status: "error" }), owner);
    expect(
      userCompletions(setupResult.entries).at(-1).data.groupRemaining,
    ).toBe(1);
  });

  it("marks manually collected results consumed before later publication", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "a", turnId: "turn-a" },
      sessionOwner(scope),
    );
    publishCompletion(record("a"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(userCompletions(setupResult.entries)).toHaveLength(1);
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("persists one manual-consumption receipt per terminal turn", () => {
    const setupResult = setup();
    scope = setupResult.scope;

    const first = consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "a", turnId: "turn-a" },
      sessionOwner(scope),
    );
    const repeated = consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "a", turnId: "turn-a" },
      sessionOwner(scope),
    );

    expect(first).toBe(true);
    expect(repeated).toBe(false);
    expect(
      setupResult.entries.filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "subagentura-completion-consumed",
      ),
    ).toHaveLength(1);
  });

  it("preserves group terminality when every result was manually consumed", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = {
      policy: "group" as const,
      groupId: "consumed-group",
    };
    for (const id of ["a", "b"]) {
      registerCompletionMember(
        "interactive",
        id,
        "group",
        group.groupId,
        sessionOwner(scope),
      );
    }
    sealCompletionGroups(sessionOwner(scope));

    publishCompletion(record("a", group), sessionOwner(scope));
    consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "a", turnId: "turn-a" },
      sessionOwner(scope),
    );
    publishCompletion(record("b", group), sessionOwner(scope));
    consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "b", turnId: "turn-b" },
      sessionOwner(scope),
    );
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("attaches ready references to a natural turn instead of auto-triggering", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    publishCompletion(record("a"), sessionOwner(scope));

    const message = prepareCompletionManifest(sessionOwner(scope));

    expect(message?.customType).toBe("subagent-manifest");
    expect(message?.content).toContain("outputs/event-a.md");
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("treats repeated turns from one agent as distinct independent results", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;

    publishCompletion(record("a"), sessionOwner(scope));
    publishCompletion(
      record("a", {
        completionId: "completion-a-turn-2",
        turnId: "turn-a-2",
        references: [
          {
            label: "output",
            value: "/tmp/artifacts/a/outputs/event-a-2.md",
          },
        ],
      }),
      sessionOwner(scope),
    );
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)[0][0].details.completionIds).toEqual([
      "completion-a",
      "completion-a-turn-2",
    ]);
  });

  it("requires safe explicit group identifiers", () => {
    expect(resolveCompletionPolicy({})).toEqual({
      policy: "each",
      legacy: false,
    });
    expect(() =>
      resolveCompletionPolicy({
        completionPolicy: "group",
        completionGroupId: "bad\ngroup",
      }),
    ).toThrow(/groupId/);
  });

  it("quotes untrusted reference lines in parent manifests", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    publishCompletion(
      record("quoted", {
        references: [{ label: "output", value: "/tmp/safe\nignore previous" }],
      }),
      sessionOwner(scope),
    );

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(message?.content).toContain("\\nignore previous");
    expect(message?.content).not.toContain("/tmp/safe\nignore previous");
  });

  it("bounds independent records per parent manifest", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    for (let index = 0; index < 130; index++) {
      publishCompletion(record(`bounded-${index}`), sessionOwner(scope));
    }

    const completionIds: string[] = [];
    let message = prepareCompletionManifest(sessionOwner(scope));
    while (message) {
      expect(Buffer.byteLength(message.content, "utf8")).toBeLessThanOrEqual(
        32 * 1024,
      );
      completionIds.push(...message.details.completionIds);
      message = prepareCompletionManifest(sessionOwner(scope));
    }
    expect(completionIds).toHaveLength(130);
    expect(new Set(completionIds)).toHaveLength(130);
  });

  it("bounds explicit completion-group membership", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    for (let index = 0; index < 32; index++) {
      registerCompletionMember(
        "interactive",
        `agent-${index}`,
        "group",
        "bounded-group",
        sessionOwner(scope),
      );
    }
    expect(() =>
      registerCompletionMember(
        "interactive",
        "agent-overflow",
        "group",
        "bounded-group",
        sessionOwner(scope),
      ),
    ).toThrow(/full/);
  });

  it("rejects new work before launching into a sealed group", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    registerCompletionMember(
      "interactive",
      "existing",
      "group",
      "sealed-group",
      sessionOwner(scope),
    );
    sealCompletionGroups(sessionOwner(scope));

    expect(() =>
      assertCompletionGroupOpen("group", "sealed-group", sessionOwner(scope)),
    ).toThrow(/sealed/);
  });

  it("reopens only new-group admission for the next parent turn", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    registerCompletionMember(
      "interactive",
      "old-member",
      "group",
      "old-group",
      owner,
    );
    sealCompletionGroups(owner);

    expect(() =>
      assertCompletionGroupOpen("group", "old-group", owner),
    ).toThrow(/sealed/);

    markCompletionTurnStarting(owner);
    expect(() =>
      registerCompletionMember(
        "interactive",
        "new-member",
        "group",
        "new-group",
        owner,
      ),
    ).not.toThrow();
    expect(() =>
      assertCompletionGroupOpen("group", "old-group", owner),
    ).toThrow(/sealed/);
  });

  it("keeps every claimed manifest record inside the byte budget", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    for (let index = 0; index < 64; index++) {
      publishCompletion(
        record(`long-${index}`, {
          references: [
            {
              label: "output",
              value: `/tmp/${"x".repeat(1_000)}/event-${index}.md`,
            },
          ],
        }),
        sessionOwner(scope),
      );
    }

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(Buffer.byteLength(message!.content, "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(message!.content).toContain("</completion-manifest>");
    for (const completionId of message!.details.completionIds) {
      const sourceId = completionId.replace(/^completion-/, "");
      expect(message!.content).toContain(sourceId);
    }
  });

  it("preserves publication order instead of timestamp order", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.parentStreaming = true;
    publishCompletion(
      record("physical-first", { completedAt: 200 }),
      sessionOwner(scope),
    );
    publishCompletion(
      record("physical-second", { completedAt: 100 }),
      sessionOwner(scope),
    );

    const message = prepareCompletionManifest(sessionOwner(scope));
    expect(message?.details.completionIds).toEqual([
      "completion-physical-first",
      "completion-physical-second",
    ]);
  });

  it("keeps a human-turn fence until agent_start", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    publishCompletion(record("piggyback"), sessionOwner(scope));
    markCompletionHumanInput(sessionOwner(scope));
    expect(prepareCompletionManifest(sessionOwner(scope))).toBeDefined();

    publishCompletion(record("during-start"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)).toHaveLength(0);
  });

  it("holds a no-ready human turn through before-start and releases on settlement", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    markCompletionHumanInput(owner);
    markCompletionTurnStarting(owner);
    expect(prepareCompletionManifest(owner)).toBeUndefined();

    publishCompletion(record("arrived-during-start"), owner);
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)).toHaveLength(0);

    settleCompletionParentTurn(owner);
    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0][0].details.completionIds).toContain(
      "completion-arrived-during-start",
    );
  });

  it("downgrades repeated sealed-group turns to independent delivery", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const group = { policy: "group" as const, groupId: "one-shot" };
    registerCompletionMember(
      "interactive",
      "same-agent",
      "group",
      group.groupId,
      sessionOwner(scope),
    );
    sealCompletionGroups(sessionOwner(scope));
    publishCompletion(record("same-agent", group), sessionOwner(scope));
    prepareCompletionManifest(sessionOwner(scope));

    publishCompletion(
      record("same-agent", {
        ...group,
        completionId: "completion-same-agent-turn-2",
        turnId: "turn-same-agent-2",
      }),
      sessionOwner(scope),
    );

    const completionEntries = userCompletions(setupResult.entries);
    expect(completionEntries.at(-1)?.data.policy).toBe("each");
  });

  it("maps legacy completion controls and rejects mixed group options", () => {
    expect(resolveCompletionPolicy({ notifyOnComplete: "inject" })).toEqual({
      policy: "each",
      legacy: false,
    });
    expect(() =>
      resolveCompletionPolicy({
        notifyOnComplete: "notify",
        completionGroupId: "mixed",
      }),
    ).toThrow(/cannot be combined/i);
  });

  it("rejects unregistered grouped publication after sealing", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    sealCompletionGroups(owner);
    publishCompletion(
      record("late", { policy: "group", groupId: "late-group" }),
      owner,
    );
    expect(userCompletions(setupResult.entries)).toHaveLength(0);
  });

  it("downgrades repeated grouped turns after the first record is spilled", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-group-overflow-"));
    scope.parentStreaming = true;
    try {
      registerCompletionMember(
        "interactive",
        "group-source",
        "group",
        "g",
        owner,
      );
      publishCompletion(
        record("group-source", {
          completionId: "group-first",
          policy: "group",
          groupId: "g",
        }),
        owner,
      );
      for (let index = 0; index < MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`filler-${index}`), owner);
      }
      clearCompletionCoordinator(owner);
      registerCompletionCoordinator(setupResult.pi as never, scope);
      sealCompletionGroups(owner);
      publishCompletion(
        record("group-source", {
          completionId: "group-second",
          turnId: "turn-group-second",
          policy: "group",
          groupId: "g",
        }),
        owner,
      );
      expect(
        userCompletions(setupResult.entries).find(
          (entry) => entry.data.completionId === "group-second",
        )?.data.policy,
      ).toBe("each");
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("reserves group capacity across concurrent prepared spawns", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const reservations = Array.from({ length: 32 }, () =>
      reserveCompletionGroup("group", "reserved", owner),
    );
    expect(reservations).toHaveLength(32);
    expect(() => reserveCompletionGroup("group", "reserved", owner)).toThrow(
      /full/,
    );
  });

  it("clears consumed reservations before sealing a concurrent group", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const first = reserveCompletionGroup("group", "reserved", owner);
    const second = reserveCompletionGroup("group", "reserved", owner);
    registerCompletionMember(
      "interactive",
      "reserved-a",
      "group",
      "reserved",
      owner,
      first,
    );
    registerCompletionMember(
      "interactive",
      "reserved-b",
      "group",
      "reserved",
      owner,
      second,
    );
    sealCompletionGroups(owner);
    expect(() => assertCompletionGroupOpen("group", "reserved", owner)).toThrow(
      /sealed/,
    );
  });

  it("preflights the maximum number of completion groups", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    for (let index = 0; index < 512; index++) {
      registerCompletionMember(
        "in-process",
        `job-${index}`,
        "group",
        `group-${index}`,
        owner,
      );
    }
    expect(() =>
      assertCompletionGroupOpen("group", "group-overflow", owner),
    ).toThrow(/Too many completion groups/);
  });

  it("permits same-group reservations at the final distinct-group slot", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    for (let index = 0; index < 511; index++) {
      registerCompletionMember(
        "in-process",
        `existing-job-${index}`,
        "group",
        `existing-group-${index}`,
        owner,
      );
    }

    const first = reserveCompletionGroup("group", "last-group", owner);
    const second = reserveCompletionGroup("group", "last-group", owner);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(() =>
      registerCompletionMember(
        "in-process",
        "last-job-a",
        "group",
        "last-group",
        owner,
        first,
      ),
    ).not.toThrow();
    expect(() =>
      registerCompletionMember(
        "in-process",
        "last-job-b",
        "group",
        "last-group",
        owner,
        second,
      ),
    ).not.toThrow();
    expect(() =>
      assertCompletionGroupOpen("group", "distinct-overflow", owner),
    ).toThrow(/Too many completion groups/);
  });

  it("retries a failed manifest dispatch with backoff", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    let failed = true;
    setupResult.pi.sendMessage.mockImplementation((message: any) => {
      if (failed) {
        failed = false;
        throw new Error("stale context");
      }
      setupResult.entries.push({ type: "custom_message", ...message });
    });
    scope.parentStreaming = true;
    publishCompletion(record("retry"), sessionOwner(scope));
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));
    expect(
      setupResult.entries.filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(
      setupResult.entries.filter((entry) => entry.type === "custom_message"),
    ).toHaveLength(1);
  });

  it("stops manifest retry timers after bounded exhaustion", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    let permanent = true;
    setupResult.pi.sendMessage.mockImplementation((message: any) => {
      if (permanent) throw new Error("permanent dispatch failure");
      setupResult.entries.push({ type: "custom_message", ...message });
    });
    scope.parentStreaming = true;
    publishCompletion(record("permanent-retry"), sessionOwner(scope));
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));
    vi.runAllTimers();
    expect(setupResult.pi.sendMessage).toHaveBeenCalledTimes(9);
    expect(vi.getTimerCount()).toBe(0);
    permanent = false;
    flushCompletionManifests(sessionOwner(scope));
    expect(setupResult.pi.sendMessage).toHaveBeenCalledTimes(10);
    expect(
      setupResult.pi.sendMessage.mock.calls[9]?.[0].details.completionIds,
    ).toContain("completion-permanent-retry");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["notice_persistence", "manifest_dispatch"])(
    "reports bounded %s failures and retry exhaustion without content",
    async (failureStage) => {
      const setupResult = setup();
      scope = setupResult.scope;
      scope.telemetry = createTelemetrySession(true);
      const payloads: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url, init) => {
          payloads.push(JSON.parse(init.body));
          return Promise.resolve({ body: null });
        }),
      );
      const failedMethod =
        failureStage === "notice_persistence"
          ? setupResult.pi.appendEntry
          : setupResult.pi.sendMessage;
      failedMethod.mockImplementation(() => {
        throw new Error("private prompt /private/project customer-secret");
      });
      scope.parentStreaming = true;
      publishCompletion(record("private-agent"), sessionOwner(scope));
      scope.parentStreaming = false;
      flushCompletionManifests(sessionOwner(scope));
      await vi.runAllTimersAsync();
      for (let index = 0; index < 20; index++) {
        flushCompletionManifests(sessionOwner(scope));
      }
      await Promise.resolve();

      expect(
        payloads.map((payload) => payload.properties.failure_stage),
      ).toEqual([failureStage, "retry_exhausted"]);
      expect(
        payloads.map((payload) => payload.properties.retry_attempt),
      ).toEqual([0, 8]);
      expect(
        payloads.every(
          (payload) =>
            payload.event === "pi_subagentura_completion_delivery_failed",
        ),
      ).toBe(true);
      expect(JSON.stringify(payloads)).not.toMatch(/private|customer-secret/);
      expect(vi.getTimerCount()).toBe(0);
      expect(setupResult.entries).toHaveLength(
        failureStage === "notice_persistence" ? 0 : 1,
      );
    },
  );

  it.each(["automatic", "human"])(
    "reports a new failure after %s delivery recovers",
    (recovery) => {
      const setupResult = setup();
      scope = setupResult.scope;
      scope.telemetry = createTelemetrySession(true);
      const payloads: any[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url, init) => {
          payloads.push(JSON.parse(init.body));
          return Promise.resolve({ body: null });
        }),
      );
      const sendMessage = setupResult.pi.sendMessage.getMockImplementation()!;
      setupResult.pi.sendMessage.mockImplementationOnce(() => {
        throw new Error("dispatch failed");
      });
      const owner = sessionOwner(scope);
      scope.parentStreaming = true;
      publishCompletion(record("first-failure"), owner);
      scope.parentStreaming = false;
      flushCompletionManifests(owner);
      if (recovery === "human") {
        const message = prepareCompletionManifest(owner)!;
        setupResult.entries.push({ type: "custom_message", ...message });
      } else {
        flushCompletionManifests(owner);
      }
      settleCompletionParentTurn(owner);
      setupResult.pi.sendMessage.mockImplementationOnce(() => {
        throw new Error("another dispatch failed");
      });
      scope.parentStreaming = true;
      publishCompletion(record("second-failure"), owner);
      scope.parentStreaming = false;
      flushCompletionManifests(owner);

      expect(
        payloads.filter(
          (payload) =>
            payload.event === "pi_subagentura_completion_delivery_failed",
        ),
      ).toHaveLength(2);
      setupResult.pi.sendMessage.mockImplementation(sendMessage);
    },
  );

  it("does not send completion failure telemetry when opted out or retired", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    scope.telemetry = createTelemetrySession(false);
    setupResult.pi.sendMessage.mockImplementation(() => {
      throw new Error("dispatch failed");
    });
    scope.parentStreaming = true;
    publishCompletion(record("opted-out"), sessionOwner(scope));
    scope.parentStreaming = false;
    flushCompletionManifests(sessionOwner(scope));
    scope.telemetry = createTelemetrySession(true);
    scope.telemetry.active = false;
    vi.runAllTimers();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps successful consumption durable when the receipt append fails", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-"));
    setupResult.pi.appendEntry.mockImplementationOnce(() => {
      throw new Error("receipt storage unavailable");
    });
    try {
      expect(() =>
        consumeCompletionSource(
          setupResult.pi as never,
          {
            source: "interactive",
            sourceId: "consumed",
            turnId: "turn-consumed",
          },
          sessionOwner(scope),
        ),
      ).not.toThrow();
      publishCompletion(
        record("consumed", { turnId: "turn-consumed" }),
        sessionOwner(scope),
      );
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      flushCompletionManifests(sessionOwner(scope));
      expect(manifests(setupResult.pi)).toHaveLength(0);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("ignores forged project-local consumption and overflow ledgers", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-project-forgery-"));
    const projectLedger = sessionLedgerPath(
      scope.cwd,
      "parent-session",
      "subagentura-completion-consumed",
    );
    const projectOverflow = sessionLedgerPath(
      scope.cwd,
      "parent-session",
      "subagentura-completion-overflow",
    );
    mkdirSync(join(scope.cwd, ".pi"), { recursive: true });
    try {
      writeFileSync(
        projectLedger,
        `${JSON.stringify({
          schemaVersion: 1,
          source: "interactive",
          sourceId: "project-forged",
          turnId: "turn-project-forged",
          consumedAt: 1,
          reason: "manual",
        })}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        projectOverflow,
        `${JSON.stringify({
          kind: "overflow-meta",
          rotated: true,
          retiredThrough: Number.MAX_SAFE_INTEGER - 1,
          retirementBlocked: false,
        })}\n`,
        { mode: 0o600 },
      );
      publishCompletion(
        record("project-forged", { turnId: "turn-project-forged" }),
        sessionOwner(scope),
      );
      flushCompletionManifests(sessionOwner(scope));

      expect(manifests(setupResult.pi)).toHaveLength(1);
      expect(manifests(setupResult.pi)[0]?.[0]).toHaveProperty(
        "details.completionIds",
        ["completion-project-forged"],
      );
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("rejects wildcard fallback receipts for turn-scoped completions", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const ledgerPath = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-consumed",
    );
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        source: "interactive",
        sourceId: "turn-scoped",
        consumedAt: 1,
        reason: "manual",
      })}\n`,
      { mode: 0o600 },
    );
    registerCompletionExpectations(
      [
        {
          completionId: "completion-turn-scoped",
          source: "interactive",
          sourceId: "turn-scoped",
          turnId: "turn-turn-scoped",
        },
      ],
      sessionOwner(scope),
    );
    publishCompletion(record("turn-scoped"), sessionOwner(scope));
    flushCompletionManifests(sessionOwner(scope));

    expect(manifests(setupResult.pi)).toHaveLength(1);
    expect(manifests(setupResult.pi)[0]?.[0]).toHaveProperty(
      "details.completionIds",
      ["completion-turn-scoped"],
    );
  });

  it("ignores malformed persisted consumption selectors", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    const ledgerPath = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-consumed",
    );
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        source: "interactive",
        sourceId: "malformed",
        scope: "turn",
        consumedAt: 1,
        reason: "manual",
      })}\n`,
      { mode: 0o600 },
    );
    registerCompletionExpectations(
      [
        {
          completionId: "completion-malformed",
          source: "interactive",
          sourceId: "malformed",
          turnId: "turn-malformed",
        },
      ],
      owner,
    );
    publishCompletion(record("malformed", { turnId: "turn-malformed" }), owner);
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)[0]?.[0].details.completionIds).toEqual([
      "completion-malformed",
    ]);
  });

  it("does not let an explicit source receipt consume a turn-scoped completion", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "source-selector", scope: "source" },
      owner,
    );
    publishCompletion(
      record("source-selector", {
        completionId: "source-selector-unscoped",
        turnId: undefined,
      }),
      owner,
    );
    publishCompletion(
      record("source-selector", {
        completionId: "source-selector-turn",
        turnId: "turn-selector",
      }),
      owner,
    );
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)[0]?.[0].details.completionIds).toEqual([
      "source-selector-turn",
    ]);
  });

  it("records a specific turn after an earlier source-only consumption", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);

    consumeCompletionSource(
      setupResult.pi as never,
      { source: "interactive", sourceId: "reused-source", scope: "source" },
      owner,
    );
    consumeCompletionSource(
      setupResult.pi as never,
      {
        source: "interactive",
        sourceId: "reused-source",
        turnId: "later-turn",
      },
      owner,
    );

    const receipts = setupResult.entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "subagentura-completion-consumed",
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toHaveProperty("data.scope", "source");
    expect(receipts[1]).toHaveProperty("data.turnId", "later-turn");
  });

  it("fails open when fallback receipts exceed the bounded scan", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-many-"));
    setupResult.pi.appendEntry.mockImplementation(
      (customType: string, data: unknown) => {
        if (customType === "subagentura-completion-consumed") {
          throw new Error("receipt store unavailable");
        }
        setupResult.entries.push({ type: "custom", customType, data });
      },
    );
    try {
      for (let index = 0; index < 513; index++) {
        const sourceId = `receipt-${index}`;
        consumeCompletionSource(
          setupResult.pi as never,
          { source: "in-process", sourceId },
          sessionOwner(scope),
        );
        publishCompletion(
          record(sourceId, {
            source: "in-process",
            completionId: `receipt-completion-${index}`,
            turnId: undefined,
          }),
          sessionOwner(scope),
        );
      }
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      flushCompletionManifests(sessionOwner(scope));
      expect(manifests(setupResult.pi)).toHaveLength(1);
      expect(manifests(setupResult.pi)[0]?.[0]).toHaveProperty(
        "details.completionIds",
        expect.arrayContaining(["receipt-completion-0"]),
      );
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("shows failed overflow identities in the model-visible selector", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-failure-"));
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    const ledger = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-overflow",
    );
    symlinkSync(join(scope.cwd, "missing-target"), ledger);
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS + 8; index++) {
        publishCompletion(record(`failure-${index}`), sessionOwner(scope));
      }
      scope.parentStreaming = false;
      const message = prepareCompletionManifest(sessionOwner(scope));
      expect(message?.content).toContain("ledger_append_failed");
      expect(message?.content).toContain("completion-failure-0");
      expect(message?.content).toContain("retainedRecords");
      expect(message?.details.overflowFailedRetained).toBe(8);
      expect(message?.details.overflowFailedOmitted).toBeGreaterThan(0);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("offers one updated overflow notice for a later append failure", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-update-"));
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`initial-${index}`), owner);
      }
      scope.parentStreaming = false;
      flushCompletionManifests(owner);
      expect(manifests(setupResult.pi)).toHaveLength(1);
      expect(
        manifests(setupResult.pi)[0][0].details.overflowPath,
      ).toBeDefined();

      scope.parentStreaming = true;
      settleCompletionParentTurn(owner);
      const ledgerPath = sessionLedgerPath(
        setupResult.ledgerRoot,
        "parent-session",
        "subagentura-completion-overflow",
      );
      unlinkSync(ledgerPath);
      symlinkSync(join(scope.cwd, "missing-target"), ledgerPath);
      publishCompletion(record("later-failure"), owner);

      scope.parentStreaming = false;
      const updated = prepareCompletionManifest(owner);
      expect(updated?.details.overflowPath).toBe(ledgerPath);
      expect(updated?.details.overflowAppendFailures).toBeGreaterThan(0);

      const next = prepareCompletionManifest(owner);
      expect(next?.details.overflowPath).not.toBe(ledgerPath);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("does not resend the overflow selector for later successful spills", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-stable-"));
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`stable-${index}`), owner);
      }
      scope.parentStreaming = false;
      flushCompletionManifests(owner);
      expect(manifests(setupResult.pi)).toHaveLength(1);
      expect(
        manifests(setupResult.pi)[0][0].details.overflowPath,
      ).toBeDefined();

      scope.parentStreaming = true;
      settleCompletionParentTurn(owner);
      publishCompletion(record("stable-later"), owner);

      scope.parentStreaming = false;
      const next = prepareCompletionManifest(owner);
      expect(next?.details.overflowPath).toBeUndefined();
      expect(next?.details.completionIds.length).toBeGreaterThan(0);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("keeps a failed spill across later success and coordinator reload", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-mixed-overflow-"));
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    const ledgerPath = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-overflow",
    );
    symlinkSync(join(scope.cwd, "missing-target"), ledgerPath);
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`mixed-failure-${index}`), owner);
      }
      unlinkSync(ledgerPath);
      publishCompletion(record("mixed-success"), owner);
      scope.parentStreaming = false;
      clearCompletionCoordinator(owner);
      registerCompletionCoordinator(setupResult.pi as never, scope);
      const message = prepareCompletionManifest(owner);
      expect(message?.details.overflowRetirementBlocked).toBe(false);
      expect(readFileSync(ledgerPath, "utf8")).toContain(
        "completion-mixed-failure-0",
      );
      const recoveredLedger = readFileSync(ledgerPath, "utf8");
      clearCompletionCoordinator(owner);
      registerCompletionCoordinator(setupResult.pi as never, scope);
      prepareCompletionManifest(owner);
      expect(readFileSync(ledgerPath, "utf8")).toBe(recoveredLedger);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });
  it("reconciles old fallback receipts for completions expected after rehydrate", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-late-"));
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    const ledgerPath = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-consumed",
    );
    const lateReceipt = JSON.stringify({
      schemaVersion: 1,
      source: "interactive",
      sourceId: "late-old",
      turnId: "late-old-turn",
      consumedAt: 1,
      reason: "manual",
    });
    const filler = Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({
        schemaVersion: 1,
        source: "in-process",
        sourceId: `filler-${index}`,
        turnId: `filler-turn-${index}`,
        consumedAt: index + 2,
        reason: "manual",
      }),
    ).join("\n");
    try {
      scope.parentStreaming = true;
      writeFileSync(ledgerPath, `${lateReceipt}\n${filler}\n`, { mode: 0o600 });
      registerCompletionExpectations(
        [
          {
            completionId: "late-old-completion",
            source: "interactive",
            sourceId: "late-old",
            turnId: "late-old-turn",
          },
        ],
        owner,
      );
      publishCompletion(
        record("existing", {
          source: "in-process",
          completionId: "existing-completion",
        }),
        owner,
      );

      publishCompletion(
        record("late-old", {
          completionId: "late-old-completion",
          turnId: "late-old-turn",
        }),
        owner,
      );
      scope.parentStreaming = false;
      const message = prepareCompletionManifest(owner);
      expect(message?.details.completionIds ?? []).not.toContain(
        "late-old-completion",
      );
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("retries a failed fallback scan after the receipt ledger recovers", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-receipt-retry-"));
    mkdirSync(join(setupResult.ledgerRoot, ".pi"), { recursive: true });
    const ledgerPath = sessionLedgerPath(
      setupResult.ledgerRoot,
      "parent-session",
      "subagentura-completion-consumed",
    );
    symlinkSync(join(scope.cwd, "missing-target"), ledgerPath);
    try {
      markCompletionHumanInput(owner);
      registerCompletionExpectations(
        [
          {
            completionId: "recovered-completion",
            source: "in-process",
            sourceId: "recovered",
          },
        ],
        owner,
      );
      unlinkSync(ledgerPath);
      writeFileSync(
        ledgerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          source: "in-process",
          sourceId: "recovered",
          consumedAt: 1,
          reason: "manual",
        })}\n`,
        { mode: 0o600 },
      );

      publishCompletion(
        record("recovered", {
          source: "in-process",
          completionId: "recovered-completion",
          turnId: undefined,
        }),
        owner,
      );
      expect(prepareCompletionManifest(owner)).toBeUndefined();
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("uses a durable retirement floor after overflow-ledger rotation", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-floor-"));
    scope.parentStreaming = true;
    try {
      registerCompletionMember(
        "interactive",
        "floor-source",
        "group",
        "floor",
        owner,
      );
      publishCompletion(
        record("floor-source", {
          completionId: "floor-first",
          policy: "group",
          groupId: "floor",
        }),
        owner,
      );
      for (let index = 0; index < MAX_COMPLETION_RECORDS + 520; index++) {
        publishCompletion(record(`floor-filler-${index}`), owner);
      }
      scope.parentStreaming = false;
      const ledgerPath = sessionLedgerPath(
        setupResult.ledgerRoot,
        "parent-session",
        "subagentura-completion-overflow",
      );
      const ledgerBeforeRestart = readFileSync(ledgerPath, "utf8");
      clearCompletionCoordinator(owner);
      registerCompletionCoordinator(setupResult.pi as never, scope);
      flushCompletionManifests(owner);
      settleCompletionParentTurn(owner);
      const manifestContent = manifests(setupResult.pi)
        .map(([message]) => message.content)
        .join("\n");
      expect(manifestContent).not.toContain('"completionId":"floor-first"');
      expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBeforeRestart);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("moves unconsumed records past the bound to a durable overflow selector", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    scope.cwd = mkdtempSync(join(tmpdir(), "completion-overflow-"));
    scope.parentStreaming = true;
    try {
      for (let index = 0; index <= MAX_COMPLETION_RECORDS; index++) {
        publishCompletion(record(`overflow-${index}`), sessionOwner(scope));
      }
      scope.parentStreaming = false;
      const message = prepareCompletionManifest(sessionOwner(scope));
      expect(message?.content).toContain("Completion metadata exceeded");
      expect(message?.content).toContain("read(path:");
      expect(message?.details.overflowCount).toBe(1);
      const ledger = message!.details.overflowPath!;
      expect(readFileSync(ledger, "utf8")).toContain("overflow-0");
      expect(message?.details.completionIds).toEqual([]);
      clearCompletionCoordinator(sessionOwner(scope));
      registerCompletionCoordinator(setupResult.pi as never, scope);
      const rehydrated = prepareCompletionManifest(sessionOwner(scope));
      expect(rehydrated?.details.overflowPath).toBe(ledger);
    } finally {
      rmSync(scope.cwd, { recursive: true, force: true });
    }
  });

  it("chunks lifecycle retirement receipts to the validated selector bound", () => {
    const setupResult = setup();
    scope = setupResult.scope;
    const owner = sessionOwner(scope);
    scope.parentStreaming = true;
    for (let index = 0; index < 129; index++) {
      publishCompletion(
        record(`retired-${index}`, {
          completionId: `retired-completion-${index}`,
          source: "in-process",
        }),
        owner,
      );
    }

    retireSessionScopedCompletions(owner);

    const receipts = setupResult.entries.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "subagentura-completion-consumed" &&
        entry.data?.reason === "lifecycle",
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toHaveProperty("data.completionIds.length", 128);
    expect(receipts[1]).toHaveProperty("data.completionIds.length", 1);

    clearCompletionCoordinator(owner);
    registerCompletionCoordinator(setupResult.pi as never, scope);
    scope.parentStreaming = false;
    flushCompletionManifests(owner);
    expect(manifests(setupResult.pi)).toHaveLength(0);
  });
});
