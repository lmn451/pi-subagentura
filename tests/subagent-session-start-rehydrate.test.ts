/**
 * Tests for session_start integration with the rehydrate logic.
 * The session_start handler repopulates the in-memory registry
 * from the on-disk state file on specific reasons (startup, reload,
 * resume) and filters by parentSessionId.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as InteractiveTmuxModule from "../src/interactive-tmux";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { appendInteractiveState } from "../src/artifact";
import { sessionLedgerPath } from "../src/completion-ledger";
import { writeCompletionGroup } from "../src/completion-group-store";
import {
  ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE,
  createOrchestratorRoutingAuthorityEntry,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import { importFresh } from "./test-utils";
import { makeTmp } from "./subagent-rehydrate-helpers";

const { mockDebugLog } = vi.hoisted(() => ({ mockDebugLog: vi.fn() }));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, debugLog: mockDebugLog };
});

const ROUTED_CHILD = "0123456789abcdef";
function parentContext(
  cwd: string,
  records: readonly OrchestratorRoutingEntry[],
) {
  const branch = records.map((record) => ({
    type: "custom",
    customType: ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE,
    data: createOrchestratorRoutingAuthorityEntry(cwd, record),
  }));
  return {
    cwd,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => [],
      getSessionId: () => "rehydrate-parent",
    },
  };
}
const LEGACY_ROUTED_CHILD = "abc12345";

describe("session_start rehydrate integration", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    mockDebugLog.mockClear();
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../src/interactive-tmux");
  });

  async function setupExtension() {
    const api = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
    };
    const mod = (
      await importFresh<typeof import("../src/subagent")>("../src/subagent")
    ).default;
    mod(api as any);
    let startHandler:
      | ((event: any, ctx: any) => void | Promise<void>)
      | undefined;
    for (const [event, handler] of (api.on as any).mock.calls) {
      if (event === "session_start") startHandler = handler;
    }
    return { api, startHandler };
  }

  function registeredTool(api: any, name: string): any {
    return api.registerTool.mock.calls.find(([definition]: any[]) => {
      return definition.name === name;
    })?.[0];
  }

  it("session_start handler repopulates the registry from the on-disk state file", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "abc12345",
      paneId: "%42",
      windowName: "demo",
      mux: "tmux",
      artifactDir: join(cwd, "abc12345"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    expect(startHandler).toBeTypeOf("function");
    startHandler!(
      { type: "session_start", reason: "reload" },
      {
        cwd,
      },
    );

    expect(interactiveSubagentRegistry.has("abc12345")).toBe(true);
  });

  it("session_start handler survives a missing state file (empty registry)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const { startHandler } = await setupExtension();
    expect(() =>
      startHandler!(
        { type: "session_start", reason: "startup" },
        {
          cwd: "/nonexistent",
        },
      ),
    ).not.toThrow();
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start restores a pending durable group before sealing it", async () => {
    const groupDirectory =
      sessionLedgerPath(cwd, "rehydrate-parent", "subagentura-completion-groups") +
      ".groups";
    writeCompletionGroup(groupDirectory, {
      groupId: "durable-startup",
      members: ["workflow:wfd_a", "workflow:wfd_b"],
      sealed: true,
    });
    appendInteractiveState(cwd, {
      id: "wfd_c",
      paneId: "%42",
      windowName: "durable",
      mux: "tmux",
      artifactDir: join(cwd, "wfd_c"),
      sessionFile: "/tmp/session.jsonl",
      parentSessionId: "rehydrate-parent",
      completionPolicy: "group",
      completionGroupId: "durable-startup",
    });
    const { startHandler } = await setupExtension();
    await startHandler!({ type: "session_start", reason: "startup" }, {
      cwd,
      sessionManager: {
        getSessionId: () => "rehydrate-parent",
        getEntries: () => [],
        getBranch: () => [],
      },
    });
    const snapshot = readFileSync(
      join(
        groupDirectory,
        `${createHash("sha256").update("durable-startup").digest("hex")}.json`,
      ),
      "utf8",
    );
    expect(snapshot).toContain("workflow:wfd_b");
  });

  it.each(["startup", "reload", "resume"])(
    "keeps routing metadata visible as stale/unknown after a fresh %s lifecycle",
    async (reason) => {
      const saved = upsertOrchestratorRoutingEntry(cwd, {
        childId: ROUTED_CHILD,
        description: "Own the restart-sensitive API work",
        aliases: ["restart-api"],
        provenance: "user",
      }).records[0]!;
      const ctx = parentContext(cwd, [saved]);

      const { api, startHandler } = await setupExtension();
      await startHandler!({ type: "session_start", reason }, ctx);
      const result = await registeredTool(
        api,
        "list_orchestrator_agents",
      ).execute("list-after-lifecycle", {}, undefined, undefined, ctx);

      expect(interactiveSubagentRegistry.size).toBe(0);
      expect(result.details).toMatchObject({
        status: "ok",
        routingMetadataStatus: "loaded",
        agents: [
          {
            childId: ROUTED_CHILD,
            description: "Own the restart-sensitive API work",
            aliases: ["restart-api"],
            status: "unknown",
            liveness: "unknown",
            stale: true,
            actionable: false,
            reason: "runtime_missing",
          },
        ],
      });
    },
  );

  it("rehydrates an 8-hex child for routing list and follow-up send", async () => {
    const saved = upsertOrchestratorRoutingEntry(cwd, {
      childId: LEGACY_ROUTED_CHILD,
      description: "Own legacy interactive follow-ups",
      provenance: "user",
    }).records[0]!;
    const ctx = parentContext(cwd, [saved]);
    appendInteractiveState(cwd, {
      id: LEGACY_ROUTED_CHILD,
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, LEGACY_ROUTED_CHILD),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "rehydrate-parent",
    });

    const mockSendCommandToPane = vi.fn();
    vi.doMock("../src/interactive-tmux", async (importOriginal) => {
      const actual = await importOriginal<typeof InteractiveTmuxModule>();
      return {
        ...actual,
        isPaneAlive: vi.fn().mockReturnValue(true),
        getInteractivePaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
        sendCommandToPane: mockSendCommandToPane,
      };
    });
    const { api, startHandler } = await setupExtension();
    await startHandler!({ type: "session_start", reason: "reload" }, ctx);

    const listed = await registeredTool(
      api,
      "list_orchestrator_agents",
    ).execute("list-legacy-child", {}, undefined, undefined, ctx);
    expect(listed.details).toMatchObject({
      routingMetadataStatus: "loaded",
      agents: [
        {
          childId: LEGACY_ROUTED_CHILD,
          description: "Own legacy interactive follow-ups",
          provenance: "user",
          status: "running",
          liveness: "alive",
          actionable: true,
        },
      ],
    });

    const sent = await registeredTool(
      api,
      "send_interactive_subagent_message",
    ).execute(
      "send-legacy-child",
      { id: LEGACY_ROUTED_CHILD, message: "Continue the legacy task" },
      undefined,
      undefined,
      ctx,
    );
    expect(sent.details).toMatchObject({
      id: LEGACY_ROUTED_CHILD,
      status: "sent",
    });
    expect(mockSendCommandToPane).toHaveBeenCalledOnce();
  });

  it("fails routing metadata closed without blocking runtime rehydration", async () => {
    appendInteractiveState(cwd, {
      id: "runtime-survives",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "runtime-survives"),
      sessionFile: "/tmp/sess.jsonl",
    });
    writeFileSync(join(cwd, ".pi", "subagentura-routing.json"), "{");

    const { startHandler } = await setupExtension();
    await startHandler!({ type: "session_start", reason: "reload" }, { cwd });

    expect(interactiveSubagentRegistry.has("runtime-survives")).toBe(true);
    expect(mockDebugLog).toHaveBeenCalledWith(
      "error",
      "orchestrator_routing_recovery_failed",
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it("session_start does NOT rehydrate on startup when session ID doesn't match", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Entry from a different (old) session
    appendInteractiveState(cwd, {
      id: "from-old-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-old-session"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-old",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "startup" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-new" },
    });

    // Registry should be empty - different session, no match
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start DOES rehydrate on startup when session ID matches (--session / -r)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-same-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-same-session"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-mine",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "startup" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-mine" },
    });

    // Registry should have the entry - matching session after restart with --session
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-same-session")).toBe(true);
  });

  it("session_start filters by parentSessionId on reload", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    // Entry from a DIFFERENT session
    appendInteractiveState(cwd, {
      id: "other-session-agent",
      paneId: "%99",
      mux: "tmux",
      artifactDir: join(cwd, "other-session-agent"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-other",
    });
    // Entry from THIS session
    appendInteractiveState(cwd, {
      id: "this-session-agent",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "this-session-agent"),
      sessionFile: "/tmp/sess.jsonl",
      parentSessionId: "session-current",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "reload" } as any, {
      cwd,
      sessionManager: { getSessionId: () => "session-current" },
    });

    // Only the matching entry should be rehydrated
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("other-session-agent")).toBe(false);
    expect(interactiveSubagentRegistry.has("this-session-agent")).toBe(true);
  });

  it("session_start does NOT rehydrate on new (explicit new session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "new" }, { cwd });

    // Registry should be empty - new sessions don't rehydrate old subagents
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start does NOT rehydrate on fork (forked session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "fork" }, { cwd });

    // Registry should be empty - forked sessions don't rehydrate old subagents
    expect(interactiveSubagentRegistry.size).toBe(0);
  });

  it("session_start DOES rehydrate on resume (resumed session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "resume" }, { cwd });

    // Registry should have the rehydrated entry - resume preserves subagents
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(true);
  });

  it("session_start DOES rehydrate on reload (reloaded session)", async () => {
    await importFresh<typeof import("../src/subagent")>("../src/subagent");
    appendInteractiveState(cwd, {
      id: "from-previous-session",
      paneId: "%42",
      mux: "tmux",
      artifactDir: join(cwd, "from-previous-session"),
      sessionFile: "/tmp/sess.jsonl",
    });

    const { startHandler } = await setupExtension();
    startHandler!({ type: "session_start", reason: "reload" }, { cwd });

    // Registry should have the rehydrated entry - reload preserves subagents
    expect(interactiveSubagentRegistry.size).toBe(1);
    expect(interactiveSubagentRegistry.has("from-previous-session")).toBe(true);
  });
});
