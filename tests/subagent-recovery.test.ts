import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendInteractiveState,
  INTERACTIVE_ARTIFACT_OWNER_FILE,
  loadInteractiveStates,
  updateInteractiveState,
} from "../src/artifact";
import {
  inspectDirectInteractiveRecovery,
  recoverDirectInteractiveSubagent,
} from "../src/interactive-recovery";
import {
  LINEAGE_SCHEMA_VERSION,
  hashLineageRoot,
  nodeManifestPath,
  readLineageManifest,
  resolveLineageStorePathsSync,
  writeLineageManifestAtomicSync,
} from "../src/interactive-lineage";
import {
  deriveInteractiveSubagentStatusFromLifecycle,
  foldInteractiveLifecycle,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import {
  __resetMuxInstances,
  __setTmuxMultiplexer,
  __setZellijMultiplexer,
} from "../src/multiplexer";
import type { SessionScope } from "../src/session-scope";
import { createRootSpawnTreeContext } from "../src/spawn-tree-context";

const CHILD_ID = "a1b2c3d4e5f60718";
const PARENT_SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PI_SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pendingDelivery = {
  deliveryId: "delivery-1",
  subagentId: CHILD_ID,
  turnId: "turn-1",
  eventId: "event-1",
  mode: "notify" as const,
  triggerTurn: true,
  status: "done" as const,
  artifactDir: "",
  state: "queued" as const,
  completionPolicy: "each" as const,
};

interface Fixture {
  root: string;
  cwd: string;
  childCwd: string;
  artifactDir: string;
  sessionFile: string;
  sessionRoot: string;
  systemPromptFile: string;
  state: InteractiveSubagentState;
  scope: SessionScope;
  mux: ReturnType<typeof makeMux>;
  lineagePath: string;
}

const roots: string[] = [];

function makeMux(name: "tmux" | "zellij" = "tmux") {
  return {
    name,
    capabilities: {
      structuredFocus: true,
      boundedCapture: true,
      nativeOverlay: true,
    },
    isAvailable: vi.fn(() => true),
    createPane: vi.fn(() => ({
      paneId: "%new",
      windowName: "recovered-child",
      session: "mux-session",
    })),
    getPaneLiveness: vi.fn(() => "dead" as const),
    getPaneLivenessAsync: vi.fn(async () => "dead" as const),
    sendKeys: vi.fn(),
    sendEnter: vi.fn(),
    killPane: vi.fn(),
    focusPane: vi.fn(async () => {}),
    capturePane: vi.fn(async () => ({ output: "", truncated: false })),
    showNativeViewer: vi.fn(async () => true),
    buildAttachCommands: vi.fn(() => ({
      attachCommand: "tmux attach -t mux-session",
      focusCommand: "tmux select-pane -t %new",
    })),
  };
}

function fixture(muxName: "tmux" | "zellij" = "tmux"): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-recovery-")));
  roots.push(root);
  const cwd = join(root, "project");
  const childCwd = join(root, "child-worktree");
  const artifactDir = join(root, "sessions", "artifacts", CHILD_ID);
  const sessionFile = join(root, "sessions", "child.jsonl");
  const sessionRoot = join(root, "lineage-root");
  const systemPromptFile = join(artifactDir, "child-system.md");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(childCwd, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: PI_SESSION_ID,
      timestamp: new Date(0).toISOString(),
      cwd: childCwd,
    })}\n`,
  );
  writeFileSync(systemPromptFile, "# Child protocol\n");
  writeFileSync(
    join(artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
    PARENT_SESSION_ID,
  );

  appendInteractiveState(cwd, {
    id: CHILD_ID,
    paneId: "%dead",
    windowName: "old-child",
    mux: muxName,
    muxSession: "old-session",
    artifactDir,
    sessionFile,
    completionPolicy: "each",
    parentSessionId: PARENT_SESSION_ID,
  });
  updateInteractiveState(cwd, CHILD_ID, (entry) => {
    entry.eventByteCursor = 123;
    entry.sessionByteCursor = 456;
    entry.sessionPartialLineStart = 450;
    entry.activeTurnId = "turn-1";
    entry.pendingDeliveries = [
      { ...pendingDelivery, artifactDir: entry.artifactDir },
    ];
    entry.deliveryReceipts = ["receipt-1"];
    entry.lifecycle = {
      startedAt: 1,
      currentTurnId: "turn-1",
      completionTurnId: "turn-1",
      completionOutcome: "done",
      processStatus: "done",
      processExitCode: 0,
    };
  });

  const spawnTreeContext = createRootSpawnTreeContext(
    PARENT_SESSION_ID,
    sessionRoot,
  );
  const lineage = resolveLineageStorePathsSync(sessionRoot, PARENT_SESSION_ID);
  const lineagePath = writeLineageManifestAtomicSync(lineage.nodesDir, {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    agentId: CHILD_ID,
    rootId: PARENT_SESSION_ID,
    rootHash: hashLineageRoot(PARENT_SESSION_ID),
    ownerSessionId: PARENT_SESSION_ID,
    name: "recoverable-child",
    taskPreview: "Continue the interrupted implementation",
    startedAt: new Date(0).toISOString(),
    cwd: childCwd,
    pane: {
      backend: muxName,
      paneId: "%dead",
      muxSession: "old-session",
      windowName: "old-child",
    },
    artifactDir,
    childSessionFile: sessionFile,
  });

  const state: InteractiveSubagentState = {
    id: CHILD_ID,
    name: "recoverable-child",
    task: "Continue the interrupted implementation",
    paneId: "%dead",
    windowName: "old-child",
    mux: muxName,
    muxSession: "old-session",
    sessionFile,
    cwd,
    parentSessionId: PARENT_SESSION_ID,
    sessionOwner: { id: 7, generation: 1 },
    startedAt: 1,
    status: "exited",
    attachCommand: "old attach",
    selectPaneCommand: "old focus",
    launchScriptFile: join(artifactDir, "old-launch.sh"),
    artifactDir,
    completionPolicy: "each",
    eventByteCursor: 123,
    lastDeliveredSessionByte: 450,
    sessionPartialLineStart: 450,
    sessionObservedByteCursor: 456,
    activeTurnId: "turn-1",
    pendingDeliveries: [{ ...pendingDelivery, artifactDir }],
    deliveryReceipts: ["receipt-1"],
    lifecycle: {
      startedAt: 1,
      currentTurnId: "turn-1",
      completionTurnId: "turn-1",
      completionOutcome: "done",
      processStatus: "done",
      processExitCode: 0,
    },
  };
  const scope: SessionScope = {
    id: 7,
    generation: 1,
    lifecycle: "started",
    pi: {} as never,
    cwd,
    sessionManager: {
      getSessionId: () => PARENT_SESSION_ID,
      getEntries: () => [],
    },
    spawnTreeContext,
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map([[state.id, state]]),
  };
  const mux = makeMux(muxName);
  if (muxName === "tmux") __setTmuxMultiplexer(mux as never);
  else __setZellijMultiplexer(mux as never);
  return {
    root,
    cwd,
    childCwd,
    artifactDir,
    sessionFile,
    sessionRoot,
    systemPromptFile,
    state,
    scope,
    mux,
    lineagePath,
  };
}

beforeEach(() => {
  __resetMuxInstances();
});

afterEach(() => {
  __resetMuxInstances();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("direct interactive dead-pane recovery", () => {
  it("reopens the recorded Pi session and preserves delivery state", async () => {
    const f = fixture();
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });

    expect(plan).toMatchObject({
      childId: CHILD_ID,
      piSessionId: PI_SESSION_ID,
      parentSessionId: PARENT_SESSION_ID,
      oldPaneId: "%dead",
      sessionFile: f.sessionFile,
      artifactDir: f.artifactDir,
    });
    expect(plan.piSessionId).not.toBe(plan.childId);

    const recovered = await recoverDirectInteractiveSubagent({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
      expectedFingerprint: plan.fingerprint,
    });

    expect(recovered).toBe(f.state);
    expect(recovered).toMatchObject({
      id: CHILD_ID,
      paneId: "%new",
      windowName: "recovered-child",
      muxSession: "mux-session",
      status: "unknown",
      eventByteCursor: 123,
      lastDeliveredSessionByte: 450,
      sessionObservedByteCursor: 456,
      activeTurnId: "turn-1",
      deliveryReceipts: ["receipt-1"],
    });
    expect(recovered.pendingDeliveries).toEqual([
      { ...pendingDelivery, artifactDir: f.artifactDir },
    ]);
    expect(recovered.lifecycle).toMatchObject({
      completionTurnId: "turn-1",
      completionOutcome: "done",
    });
    expect(recovered.lifecycle).not.toHaveProperty("processStatus");
    expect(recovered.lifecycle).not.toHaveProperty("processExitCode");

    const persisted = loadInteractiveStates(f.cwd)!.states[CHILD_ID]!;
    expect(persisted).toMatchObject({
      paneId: "%new",
      windowName: "recovered-child",
      muxSession: "mux-session",
      eventByteCursor: 123,
      sessionByteCursor: 456,
      sessionPartialLineStart: 450,
      activeTurnId: "turn-1",
      deliveryReceipts: ["receipt-1"],
    });
    expect(persisted.pendingDeliveries).toEqual([
      { ...pendingDelivery, artifactDir: f.artifactDir },
    ]);
    expect(persisted.lifecycle).not.toHaveProperty("processStatus");

    const lineage = await readLineageManifest(f.lineagePath);
    expect(lineage).toMatchObject({
      agentId: CHILD_ID,
      rootId: PARENT_SESSION_ID,
      ownerSessionId: PARENT_SESSION_ID,
      pane: {
        backend: "tmux",
        paneId: "%new",
        muxSession: "mux-session",
        windowName: "recovered-child",
      },
    });
    const launchScript = readFileSync(recovered.launchScriptFile, "utf8");
    expect(launchScript).toContain(`--session '${f.sessionFile}'`);
    expect(launchScript).toContain(
      `--append-system-prompt '${f.systemPromptFile}'`,
    );
    expect(launchScript).toContain("export PI_SUBAGENTURA_LINEAGE_BOOTSTRAP=");
    expect(launchScript).not.toMatch(/'@[^']+'/);
    expect(f.mux.sendKeys).toHaveBeenCalledOnce();
    expect(f.mux.sendEnter).toHaveBeenCalledOnce();
  });

  it("uses the same validated rebind flow for Zellij", async () => {
    const f = fixture("zellij");
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });

    expect(plan.mux).toBe("zellij");
    await recoverDirectInteractiveSubagent({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
      expectedFingerprint: plan.fingerprint,
    });

    expect(f.state).toMatchObject({
      id: CHILD_ID,
      mux: "zellij",
      paneId: "%new",
      muxSession: "mux-session",
      eventByteCursor: 123,
    });
    expect(await readLineageManifest(f.lineagePath)).toMatchObject({
      pane: { backend: "zellij", paneId: "%new" },
    });
  });

  it("rejects a live or unknown pane without launching a duplicate", async () => {
    for (const liveness of ["alive", "unknown"] as const) {
      const f = fixture();
      f.mux.getPaneLivenessAsync.mockResolvedValueOnce(liveness as never);

      await expect(
        inspectDirectInteractiveRecovery({
          state: f.state,
          scope: f.scope,
          parentCwd: f.cwd,
        }),
      ).rejects.toThrow(
        liveness === "alive" ? "still alive" : "liveness is unknown",
      );
      expect(f.mux.createPane).not.toHaveBeenCalled();
    }
  });

  it.each(["sessionFile", "artifactDir"] as const)(
    "rejects a persisted %s mismatch",
    async (field) => {
      const f = fixture();
      const mismatch =
        field === "artifactDir"
          ? join(f.root, "wrong-artifact", CHILD_ID)
          : join(f.root, "wrong-session.jsonl");
      if (field === "artifactDir") mkdirSync(mismatch, { recursive: true });
      updateInteractiveState(f.cwd, CHILD_ID, (entry) => {
        entry[field] = mismatch;
      });

      await expect(
        inspectDirectInteractiveRecovery({
          state: f.state,
          scope: f.scope,
          parentCwd: f.cwd,
        }),
      ).rejects.toThrow(`${field} does not match`);
      expect(f.mux.createPane).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate runtime pointers to the same session or artifact", async () => {
    const f = fixture();
    f.scope.interactiveStates.set("duplicate", {
      ...f.state,
      id: "duplicate",
      sessionFile: f.sessionFile,
    });

    await expect(
      inspectDirectInteractiveRecovery({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
      }),
    ).rejects.toThrow("duplicate runtime");
    expect(f.mux.createPane).not.toHaveBeenCalled();
  });

  it("rejects parent and artifact ownership mismatches", async () => {
    const f = fixture();
    writeFileSync(
      join(f.artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
      "different-parent",
    );

    await expect(
      inspectDirectInteractiveRecovery({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
      }),
    ).rejects.toThrow("artifact owner does not match");
    expect(f.mux.createPane).not.toHaveBeenCalled();
  });

  it("rejects lineage ownership and pointer mismatches", async () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(f.lineagePath, "utf8"));
    manifest.ownerSessionId = "different-parent";
    writeFileSync(f.lineagePath, `${JSON.stringify(manifest)}\n`);

    await expect(
      inspectDirectInteractiveRecovery({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
      }),
    ).rejects.toThrow("lineage owner does not match");
    expect(f.mux.createPane).not.toHaveBeenCalled();
  });

  it("rejects workflow-origin children", async () => {
    const f = fixture();
    f.state.workflowOriginId = "workflow-1";
    f.state.workflowResultConsumed = true;

    await expect(
      inspectDirectInteractiveRecovery({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
      }),
    ).rejects.toThrow("workflow-origin children are not recoverable");
    expect(f.mux.createPane).not.toHaveBeenCalled();
  });

  it("rolls back durable pane pointers when launch fails", async () => {
    const f = fixture();
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });
    f.mux.sendKeys.mockImplementationOnce(() => {
      throw new Error("send failed");
    });

    await expect(
      recoverDirectInteractiveSubagent({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow("send failed");

    expect(f.mux.killPane).toHaveBeenCalledWith("%new", "mux-session");
    expect(f.state.paneId).toBe("%dead");
    expect(loadInteractiveStates(f.cwd)!.states[CHILD_ID]).toMatchObject({
      paneId: "%dead",
      muxSession: "old-session",
      eventByteCursor: 123,
      sessionByteCursor: 456,
    });
    expect(await readLineageManifest(f.lineagePath)).toMatchObject({
      pane: { paneId: "%dead", muxSession: "old-session" },
    });
  });

  it("kills the replacement pane when persisted state cannot commit", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });
    const stateDir = join(f.cwd, ".pi");
    const originalMode = statSync(stateDir).mode & 0o777;
    chmodSync(stateDir, 0o500);
    try {
      await expect(
        recoverDirectInteractiveSubagent({
          state: f.state,
          scope: f.scope,
          parentCwd: f.cwd,
          expectedFingerprint: plan.fingerprint,
        }),
      ).rejects.toThrow();
    } finally {
      chmodSync(stateDir, originalMode);
    }

    expect(f.mux.killPane).toHaveBeenCalledWith("%new", "mux-session");
    expect(f.state.paneId).toBe("%dead");
    expect(loadInteractiveStates(f.cwd)!.states[CHILD_ID].paneId).toBe("%dead");
  });

  it("restores persisted state when lineage rebinding cannot commit", async () => {
    if (process.platform === "win32") return;
    const f = fixture();
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });
    const nodesDir = dirname(f.lineagePath);
    const originalMode = statSync(nodesDir).mode & 0o777;
    chmodSync(nodesDir, 0o500);
    try {
      await expect(
        recoverDirectInteractiveSubagent({
          state: f.state,
          scope: f.scope,
          parentCwd: f.cwd,
          expectedFingerprint: plan.fingerprint,
        }),
      ).rejects.toThrow();
    } finally {
      chmodSync(nodesDir, originalMode);
    }

    expect(f.mux.killPane).toHaveBeenCalledWith("%new", "mux-session");
    expect(f.state.paneId).toBe("%dead");
    expect(loadInteractiveStates(f.cwd)!.states[CHILD_ID]).toMatchObject({
      paneId: "%dead",
      eventByteCursor: 123,
      sessionByteCursor: 456,
    });
    expect(await readLineageManifest(f.lineagePath)).toMatchObject({
      pane: { paneId: "%dead" },
    });
  });

  it("folds the recovered process start back to idle without losing completion", () => {
    const lifecycle = {
      currentTurnId: "turn-1",
      completionTurnId: "turn-1",
      completionOutcome: "done" as const,
      processStatus: "error" as const,
      processExitCode: 1,
    };

    foldInteractiveLifecycle(lifecycle, {
      type: "started",
      ts: 2,
      status: "running",
    });

    expect(lifecycle.processStatus).toBeUndefined();
    expect(lifecycle.processExitCode).toBeUndefined();
    expect(
      deriveInteractiveSubagentStatusFromLifecycle(lifecycle, "alive"),
    ).toBe("idle");
  });

  it("rejects a stale confirmation fingerprint before creating a pane", async () => {
    const f = fixture();
    const plan = await inspectDirectInteractiveRecovery({
      state: f.state,
      scope: f.scope,
      parentCwd: f.cwd,
    });
    updateInteractiveState(f.cwd, CHILD_ID, (entry) => {
      entry.eventByteCursor++;
    });
    f.state.eventByteCursor = (f.state.eventByteCursor ?? 0) + 1;

    await expect(
      recoverDirectInteractiveSubagent({
        state: f.state,
        scope: f.scope,
        parentCwd: f.cwd,
        expectedFingerprint: plan.fingerprint,
      }),
    ).rejects.toThrow("recovery state changed after confirmation");
    expect(f.mux.createPane).not.toHaveBeenCalled();
  });
});
