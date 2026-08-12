/**
 * Tests for artifact-derived rehydrate behavior:
 * inject/notify cursor handling, name recovery from prompt file,
 * startedAt recovery from first event, fallback name/startedAt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendCompletionEvent,
  appendEvent,
  appendInteractiveState,
  artifactPath,
  INTERACTIVE_ARTIFACT_OWNER_FILE,
} from "../src/artifact";
import {
  dispatchPreparedInteractiveSubagent,
  interactiveSubagentRegistry,
  launchInteractiveSubagent,
} from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import { pollArtifactChanges } from "../src/artifact-poller";
import { rehydrateInteractiveSubagents } from "../src/rehydrate";
import {
  clearSessionScopes,
  registerSessionScope,
  setLegacyActiveSessionRefs,
} from "../src/session-scope";
import type { WorkflowProcessAttemptManifest } from "../src/workflow-process-attempt";
import {
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionPath,
} from "../src/workflow-run-types";
import { importFresh } from "./test-utils";
import { makeTmp } from "./subagent-rehydrate-helpers";

describe("rehydrateInteractiveSubagents", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTmp();
    // Install a tmux mock so isPaneAlive returns false for fake pane IDs.
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFileSync: (_file: string) => {
        throw new Error("mock: child_process unavailable");
      },
    }));
    const g = globalThis as any;
    g.__piSubagenturaInteractiveRegistry?.clear?.();
    clearSessionScopes();
    g.__piSubagenturaPiRef = undefined;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    clearSessionScopes();
    vi.doUnmock("node:child_process");
  });

  it("inject-mode orphans DO re-inject their existing terminal event on the first poll after rehydrate", async () => {
    // Behavior change: we no longer suppress re-injection here. The inject-mode path
    // fires on every NEW `done` event. On rehydrate, lastInjectedEventTs starts as
    // undefined, so the first poll will re-inject the latest terminal event. This means
    // exactly one extra inject per sub-agent on parent reload, which is acceptable —
    // it's better than silently dropping a result that completed during the reload downtime.
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "inject-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%77",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "inject",
    });
    // Add a done event to the artifact (what an orphan-with-completed-work looks like).
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1, type: "started", status: "running" });
    appendEvent(art, { ts: 2, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    // lastInjectedEventTs should remain undefined — we no longer suppress re-injection.
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
  });

  it("notify-mode orphans leave lastInjectedEventTs undefined (inject path is irrelevant)", async () => {
    const mod =
      await importFresh<typeof import("../src/subagent")>("../src/subagent");
    const id = "notify-orphan";
    const artDir = join(cwd, id);
    appendInteractiveState(cwd, {
      id,
      paneId: "%88",
      mux: "tmux",
      artifactDir: artDir,
      sessionFile: "/tmp/sess.jsonl",
      notifyOnComplete: "notify",
    });
    mod.rehydrateInteractiveSubagents(cwd);
    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated?.lastInjectedEventTs).toBeUndefined();
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
      sessionByteCursor: 0,
      pendingDeliveries: [],
      deliveryReceipts: [],
      lifecycle: { startedAt: 1000 },
    });

    // Event history remains available without being reparsed during rehydrate.
    const art = artifactPath(cwd, id);
    appendEvent(art, { ts: 1000, type: "started", status: "running" });
    appendEvent(art, { ts: 2000, type: "done", status: "done", exitCode: 0 });

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
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

    mod.rehydrateInteractiveSubagents(cwd);

    const rehydrated = interactiveSubagentRegistry.get(id);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.name).toBe(id); // falls back to entry.id
    expect(rehydrated?.startedAt).toBe(0); // falls back to 0
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
    expect(rehydrated).toBe(interactiveSubagentRegistry.get(id));
    expect(rehydrated?.sessionOwner).toEqual({ id: 710, generation: 9 });
    expect(rehydrated?.artifactDir).toBe(artDir);
  });
  it("requeues a rehydrated delivery using its own streaming state", async () => {
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
      eventByteCursor: 0,
      sessionByteCursor: 0,
      pendingDeliveries: [
        {
          deliveryId: "delivery-a",
          subagentId: id,
          turnId: "turn-a",
          eventId: "event-a",
          mode: "notify",
          triggerTurn: false,
          status: "done",
          artifactDir: artDir,
          state: "dispatchAttempted",
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
    setLegacyActiveSessionRefs(peer);

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    expect(scope.interactiveStates.get(id)?.pendingDeliveries?.[0]?.state).toBe(
      "queued",
    );
  });

  it("round-trips workflow process ownership and identity without standalone completion delivery", async () => {
    const previousSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = cwd;
    // Use the statically imported production modules so the injected backend and
    // the launch, rehydrate, and poll paths share one module graph.
    const identity = {
      runId: createDurableWorkflowRunId("ownership-round-trip"),
      definitionPath: createWorkflowDefinitionPath("root"),
      operationId: "task-a",
      attemptId: createWorkflowAttemptId("attempt-1"),
      attemptNumber: createWorkflowAttemptNumber(1),
      runEpoch: 7,
      nonce: "nonce_1234567890abcdef",
    };
    const manifest: WorkflowProcessAttemptManifest = {
      schemaVersion: 1,
      identity,
      launchMarker: `wfpa-${"a".repeat(32)}`,
      agentId: "wfpa0123456789abcdef",
      paneName: "wf-ownership-round-trip",
      requestedIsolation: "process",
      effectiveIsolation: "process",
      fallbackMode: "none",
    };
    const sendMessage = vi.fn();

    __setTmuxMultiplexer({
      name: "tmux",
      isAvailable: () => true,
      createPane: () => ({
        paneId: "%workflow-owned",
        windowName: manifest.paneName,
        session: "workflow-session",
      }),
      findPanesByWindowName: () => [],
      buildAttachCommands: () => ({
        attachCommand: "tmux attach",
        focusCommand: "tmux select-pane",
      }),
      sendKeys: vi.fn(),
      sendEnter: vi.fn(),
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
    } as never);

    try {
      const launched = launchInteractiveSubagent({
        name: "Workflow child",
        task: "complete durably",
        cwd,
        parentCwd: cwd,
        parentSessionId: "workflow-parent",
        workflowId: "workflow-job-owner",
        completionOwner: "workflow",
        notifyOnComplete: "inject",
        triggerTurnOnComplete: true,
        workflowProcessAttempt: manifest,
        deferDispatch: true,
      });
      dispatchPreparedInteractiveSubagent(launched);

      interactiveSubagentRegistry.clear();
      rehydrateInteractiveSubagents(cwd, "workflow-parent");
      const rehydrated = interactiveSubagentRegistry.get(manifest.agentId);
      expect(rehydrated).toBeDefined();

      expect(
        appendCompletionEvent(
          artifactPath(dirname(launched.artifactDir), launched.id),
          {
            turnId: "workflow-operation-turn",
            eventId: "workflow-operation-completion",
            outcome: "done",
            source: "agent_settled",
          },
        ),
      ).not.toBeNull();
      await pollArtifactChanges({ sendMessage } as never);

      expect.soft(rehydrated).toMatchObject({
        completionOwner: "workflow",
        workflowId: "workflow-job-owner",
        workflowProcessIdentity: identity,
      });
      expect.soft(sendMessage).not.toHaveBeenCalled();
      expect.soft(rehydrated?.pendingDeliveries).toEqual([]);
      expect(rehydrated?.eventByteCursor).toBeGreaterThan(0);
    } finally {
      __setTmuxMultiplexer(undefined);
      if (previousSessionRoot === undefined) {
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
      } else {
        process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionRoot;
      }
    }
  });

  it("rehydrates into the exact scope despite a stale aggregate id", async () => {
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
    interactiveSubagentRegistry.set(id, stale);

    mod.rehydrateInteractiveSubagents(cwd, "reload-parent", [], scope);

    expect(scope.interactiveStates.get(id)).toBeDefined();
    expect(scope.interactiveStates.get(id)).not.toBe(stale);
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
