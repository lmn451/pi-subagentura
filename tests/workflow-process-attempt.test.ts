import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowProcessAttemptManifest,
  persistWorkflowProcessChildStartedFromEnvironment,
  readWorkflowProcessChildStarted,
  recoverWorkflowProcessAttempt,
  workflowProcessAttemptIdentityMatches,
  workflowProcessManifestPath,
  writeWorkflowProcessAttemptManifest,
  WORKFLOW_PROCESS_MANIFEST_ENV,
  WORKFLOW_PROCESS_MARKER_ENV,
  WORKFLOW_PROCESS_NONCE_ENV,
  type WorkflowProcessAttemptInspector,
  type WorkflowProcessPaneAssignment,
  type WorkflowProcessRecoveryState,
  type WorkflowProcessTerminalEvidence,
} from "../src/workflow-process-attempt";
import {
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  type WorkflowOperationAttempt,
} from "../src/workflow-run-types";
import {
  createInteractiveSubagentPaths,
  recoverWorkflowProcessPaneAssignment,
} from "../src/interactive-tmux";
import {
  __setTmuxMultiplexer,
  __setZellijMultiplexer,
} from "../src/multiplexer";
import type { Multiplexer, MuxName, PaneRef } from "../src/multiplexer";

const RUN_ID = createDurableWorkflowRunId("process-attempt");
const DEFINITION_PATH = createWorkflowDefinitionPath("root");

function operationAttempt(
  attemptId = "attempt-1",
  attemptNumber = 1,
): WorkflowOperationAttempt {
  return {
    operation: createWorkflowOperationIdentity(
      RUN_ID,
      DEFINITION_PATH,
      "task-a",
    ),
    requestDigest: createWorkflowRequestDigest("1".repeat(64)),
    definitionDigest: createWorkflowDefinitionDigest("2".repeat(64)),
    dispatchOrdinal: createWorkflowDispatchOrdinal(1),
    attemptId: createWorkflowAttemptId(attemptId),
    attemptNumber: createWorkflowAttemptNumber(attemptNumber),
  };
}

function pane(
  paneId = "%7",
  windowName = "wf-window",
): WorkflowProcessPaneAssignment {
  return {
    backend: "tmux",
    paneId,
    windowName,
    muxSession: "session-a",
    artifactDir: `/tmp/process-attempt/${paneId.slice(1)}`,
    sessionFile: `/tmp/process-attempt/${paneId.slice(1)}.jsonl`,
    launchScriptFile: `/tmp/process-attempt/${paneId.slice(1)}.sh`,
  };
}

function recoveryState(
  overrides: Partial<WorkflowProcessRecoveryState> = {},
): WorkflowProcessRecoveryState {
  return {
    manifest: createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_1234567890abcdef",
      "process",
    ),
    assignment: pane(),
    launchDispatched: true,
    childStarted: true,
    terminal: false,
    adopted: false,
    fenced: false,
    ...overrides,
  };
}

function inspector(
  overrides: {
    readonly matches?: readonly WorkflowProcessPaneAssignment[];
    readonly liveness?: readonly ("alive" | "dead" | "unknown")[];
    readonly terminal?: readonly WorkflowProcessTerminalEvidence[];
  } = {},
) {
  const liveness = [...(overrides.liveness ?? ["alive"])] as Array<
    "alive" | "dead" | "unknown"
  >;
  const implementation: WorkflowProcessAttemptInspector = {
    findByMarker: vi.fn(async () => overrides.matches ?? []),
    paneLiveness: vi.fn(async () => liveness.shift() ?? "unknown"),
    terminalEvidence: vi.fn(async () => overrides.terminal ?? []),
    fence: vi.fn(async () => undefined),
    waitBeforeProbe: vi.fn(async () => undefined),
  };
  return implementation;
}
interface PaneLookupHarness {
  readonly mux: Multiplexer;
  readonly live: Set<string>;
  readonly isAvailable: () => boolean;
  readonly findPanesByWindowName: (windowName: string) => readonly PaneRef[];
  readonly killPane: (paneId: string, session?: string) => void;
}

function paneLookupHarness(
  name: MuxName,
  matches: readonly PaneRef[],
  options: {
    readonly available?: boolean;
    readonly lookupError?: Error;
  } = {},
): PaneLookupHarness {
  const keyFor = (paneId: string, session?: string) =>
    `${session ?? ""}\0${paneId}`;
  const live = new Set(
    matches.map((match) => keyFor(match.paneId, match.session)),
  );
  const isAvailable = vi.fn(() => options.available ?? true);
  const findPanesByWindowName = vi.fn(() => {
    if (!(options.available ?? true)) {
      throw new Error(`${name} is unavailable`);
    }
    if (options.lookupError !== undefined) throw options.lookupError;
    return matches;
  });
  const killPane = vi.fn((paneId: string, session?: string) => {
    live.delete(keyFor(paneId, session));
  });
  const mux = {
    name,
    isAvailable,
    findPanesByWindowName,
    killPane,
    getPaneLiveness: (paneId: string, session?: string) =>
      live.has(keyFor(paneId, session)) ? "alive" : "dead",
  } as unknown as Multiplexer;
  return { mux, live, isAvailable, findPanesByWindowName, killPane };
}

describe("workflow process attempt protocol", () => {
  it("derives immutable searchable launch identity from the full attempt fence", () => {
    const first = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_1234567890abcdef",
      "process",
    );
    const same = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_1234567890abcdef",
      "process",
    );
    const nextEpoch = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      4,
      "nonce_1234567890abcdef",
      "process",
    );
    const nextNonce = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_fedcba0987654321",
      "process",
    );

    expect(first).toEqual(same);
    expect(first.launchMarker).toMatch(/^wfpa-[a-f0-9]{32}$/);
    expect(first.agentId).toMatch(/^wfpa[a-f0-9]{16}$/);
    expect(first.launchMarker).not.toBe(nextEpoch.launchMarker);
    expect(first.launchMarker).not.toBe(nextNonce.launchMarker);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.identity)).toBe(true);
  });
  it("does not follow a hostile symlink at the former predictable temp path", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-process-publish-"));
    const victim = join(root, "victim.json");
    const manifest = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_1234567890abcdef",
      "process",
    );
    const manifestPath = workflowProcessManifestPath(root);
    const anticipatedTemp = `${manifestPath}.${process.pid}.tmp`;
    try {
      writeFileSync(victim, "do-not-touch", "utf8");
      symlinkSync(victim, anticipatedTemp);

      expect(writeWorkflowProcessAttemptManifest(root, manifest)).toBe(
        manifestPath,
      );
      expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
      expect(lstatSync(anticipatedTemp).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires the child to validate persisted identity before started evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-process-handshake-"));
    const manifest = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_1234567890abcdef",
      "process",
    );
    const priorManifest = process.env[WORKFLOW_PROCESS_MANIFEST_ENV];
    const priorMarker = process.env[WORKFLOW_PROCESS_MARKER_ENV];
    const priorNonce = process.env[WORKFLOW_PROCESS_NONCE_ENV];
    try {
      const path = writeWorkflowProcessAttemptManifest(root, manifest);
      process.env[WORKFLOW_PROCESS_MANIFEST_ENV] = path;
      process.env[WORKFLOW_PROCESS_MARKER_ENV] = manifest.launchMarker;
      process.env[WORKFLOW_PROCESS_NONCE_ENV] = "nonce_fedcba0987654321";
      expect(() => persistWorkflowProcessChildStartedFromEnvironment()).toThrow(
        "stale or mismatched",
      );
      expect(readWorkflowProcessChildStarted(root, manifest)).toBeUndefined();

      process.env[WORKFLOW_PROCESS_NONCE_ENV] = manifest.identity.nonce;
      expect(persistWorkflowProcessChildStartedFromEnvironment()).toMatchObject(
        {
          identity: manifest.identity,
          launchMarker: manifest.launchMarker,
        },
      );
      expect(readWorkflowProcessChildStarted(root, manifest)).toMatchObject({
        identity: manifest.identity,
      });
      expect(workflowProcessManifestPath(root)).toBe(path);
    } finally {
      if (priorManifest === undefined) {
        delete process.env[WORKFLOW_PROCESS_MANIFEST_ENV];
      } else {
        process.env[WORKFLOW_PROCESS_MANIFEST_ENV] = priorManifest;
      }
      if (priorMarker === undefined) {
        delete process.env[WORKFLOW_PROCESS_MARKER_ENV];
      } else {
        process.env[WORKFLOW_PROCESS_MARKER_ENV] = priorMarker;
      }
      if (priorNonce === undefined) {
        delete process.env[WORKFLOW_PROCESS_NONCE_ENV];
      } else {
        process.env[WORKFLOW_PROCESS_NONCE_ENV] = priorNonce;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts matching terminal evidence once and ignores stale nonce, attempt, and epoch evidence", async () => {
    const state = recoveryState();
    const staleNonce = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      3,
      "nonce_fedcba0987654321",
      "process",
    ).identity;
    const staleAttempt = createWorkflowProcessAttemptManifest(
      operationAttempt("attempt-2", 2),
      3,
      "nonce_1234567890abcdef",
      "process",
    ).identity;
    const staleEpoch = createWorkflowProcessAttemptManifest(
      operationAttempt(),
      2,
      "nonce_1234567890abcdef",
      "process",
    ).identity;
    const matching: WorkflowProcessTerminalEvidence = {
      identity: state.manifest.identity,
      status: "done",
      artifactEventId: "completion-1",
      exitCode: 0,
    };
    const probe = inspector({
      terminal: [
        { ...matching, identity: staleNonce },
        { ...matching, identity: staleAttempt },
        { ...matching, identity: staleEpoch },
        matching,
      ],
    });

    const resolution = await recoverWorkflowProcessAttempt(state, probe);
    expect(resolution).toMatchObject({
      kind: "adopt_terminal",
      evidence: matching,
      staleEvidenceIgnored: 3,
    });
    expect(probe.paneLiveness).not.toHaveBeenCalled();

    const second = await recoverWorkflowProcessAttempt(
      { ...state, terminal: true, adopted: true },
      probe,
    );
    expect(second).toMatchObject({
      kind: "adopt_terminal",
      evidence: matching,
      staleEvidenceIgnored: 3,
    });
    expect(probe.terminalEvidence).toHaveBeenCalledTimes(2);
  });

  it("adopts one matching live child without creating or dispatching anything", async () => {
    const state = recoveryState();
    const probe = inspector({ liveness: ["alive"] });

    await expect(recoverWorkflowProcessAttempt(state, probe)).resolves.toEqual({
      kind: "adopt_live",
      assignment: state.assignment,
      probeCount: 1,
      staleEvidenceIgnored: 0,
    });
    expect(probe.paneLiveness).toHaveBeenCalledTimes(1);
    expect(probe.fence).not.toHaveBeenCalled();
  });

  it("detects a crash before pane creation without inventing a pane", async () => {
    const state = recoveryState({ assignment: undefined });
    const probe = inspector({ matches: [] });

    await expect(recoverWorkflowProcessAttempt(state, probe)).resolves.toEqual({
      kind: "retry",
      probeCount: 0,
      staleEvidenceIgnored: 0,
    });
    expect(probe.findByMarker).toHaveBeenCalledWith(
      state.manifest.launchMarker,
    );
    expect(probe.fence).not.toHaveBeenCalled();
  });

  it("fences an orphan found after pane creation but before durable assignment or dispatch", async () => {
    const orphan = pane("%8", "wf-orphan");
    const state = recoveryState({
      assignment: undefined,
      launchDispatched: false,
      childStarted: false,
    });
    const probe = inspector({ matches: [orphan] });

    await expect(recoverWorkflowProcessAttempt(state, probe)).resolves.toEqual({
      kind: "fenced",
      reason: "orphan_before_assignment",
      assignments: [orphan],
      probeCount: 0,
      staleEvidenceIgnored: 0,
    });
    expect(probe.fence).toHaveBeenCalledTimes(1);
    expect(probe.paneLiveness).not.toHaveBeenCalled();
  });

  it("fences an assigned pane rather than sending after the pre-dispatch crash window", async () => {
    const state = recoveryState({
      launchDispatched: false,
      childStarted: false,
    });
    const probe = inspector();

    const resolution = await recoverWorkflowProcessAttempt(state, probe);
    expect(resolution).toMatchObject({
      kind: "fenced",
      reason: "orphan_before_assignment",
      probeCount: 0,
    });
    expect(probe.fence).toHaveBeenCalledWith(state.assignment);
    expect(probe.paneLiveness).not.toHaveBeenCalled();
  });

  it("never permits retry when the orphan pane cannot be fenced", async () => {
    const state = recoveryState({
      launchDispatched: false,
      childStarted: false,
    });
    const probe = inspector();
    vi.mocked(probe.fence).mockRejectedValue(
      new Error("multiplexer unavailable"),
    );

    await expect(recoverWorkflowProcessAttempt(state, probe)).rejects.toThrow(
      "multiplexer unavailable",
    );
    expect(probe.fence).toHaveBeenCalledWith(state.assignment);
  });

  it("bounds ambiguous dispatched probes and fences before allowing a retry", async () => {
    const state = recoveryState({ childStarted: false });
    const probe = inspector({
      liveness: ["unknown", "unknown", "unknown", "alive"],
    });

    const resolution = await recoverWorkflowProcessAttempt(state, probe, {
      maxAmbiguousProbes: 3,
    });
    expect(resolution).toMatchObject({
      kind: "fenced",
      reason: "ambiguous_dispatch",
      probeCount: 3,
    });
    expect(probe.paneLiveness).toHaveBeenCalledTimes(3);
    expect(probe.waitBeforeProbe).toHaveBeenCalledTimes(2);
    expect(probe.fence).toHaveBeenCalledWith(state.assignment);
  });

  it("fences every duplicate deterministic marker match", async () => {
    const first = pane("%10", "wf-duplicate");
    const second = pane("%11", "wf-duplicate");
    const state = recoveryState({ assignment: undefined });
    const probe = inspector({ matches: [first, second] });

    const resolution = await recoverWorkflowProcessAttempt(state, probe);
    expect(resolution).toMatchObject({
      kind: "fenced",
      reason: "multiple_marker_matches",
      assignments: [first, second],
    });
    expect(probe.fence).toHaveBeenCalledTimes(2);
  });

  it("compares all seven persisted identity fields", () => {
    const state = recoveryState();
    const differentNonce = {
      ...state.manifest.identity,
      nonce: "nonce_fedcba0987654321",
    };
    expect(
      workflowProcessAttemptIdentityMatches(
        state.manifest.identity,
        state.manifest.identity,
      ),
    ).toBe(true);
    expect(
      workflowProcessAttemptIdentityMatches(
        state.manifest.identity,
        differentNonce,
      ),
    ).toBe(false);
  });
  describe("multiplexer pre-state crash recovery", () => {
    let temporaryRoot: string;
    let previousSessionRoot: string | undefined;

    beforeEach(() => {
      temporaryRoot = mkdtempSync(join(tmpdir(), "pi-process-pane-recovery-"));
      previousSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR;
      process.env.PI_CODING_AGENT_SESSION_DIR = join(temporaryRoot, "sessions");
    });

    afterEach(() => {
      __setTmuxMultiplexer(undefined);
      __setZellijMultiplexer(undefined);
      if (previousSessionRoot === undefined) {
        delete process.env.PI_CODING_AGENT_SESSION_DIR;
      } else {
        process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionRoot;
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    });

    it("adopts a unique tmux pane when zellij is unavailable", () => {
      const manifest = createWorkflowProcessAttemptManifest(
        operationAttempt(),
        3,
        "nonce_1234567890abcdef",
        "process",
      );
      const ownerCwd = join(temporaryRoot, "owner");
      const paths = createInteractiveSubagentPaths({
        id: manifest.agentId,
        name: manifest.paneName,
        cwd: ownerCwd,
        deterministicSessionFile: true,
      });
      writeWorkflowProcessAttemptManifest(paths.artifactDir, manifest);
      const tmux = paneLookupHarness("tmux", [
        {
          paneId: "%17",
          windowName: manifest.paneName,
          session: "tmux-owner",
        },
      ]);
      const zellij = paneLookupHarness("zellij", [], { available: false });
      __setTmuxMultiplexer(tmux.mux);
      __setZellijMultiplexer(zellij.mux);

      const recovered = recoverWorkflowProcessPaneAssignment(
        manifest,
        ownerCwd,
      );

      expect(recovered).toEqual({
        backend: "tmux",
        paneId: "%17",
        windowName: manifest.paneName,
        muxSession: "tmux-owner",
        artifactDir: paths.artifactDir,
        sessionFile: paths.sessionFile,
        launchScriptFile: paths.launchScriptFile,
      });
      expect(tmux.isAvailable).toHaveBeenCalledOnce();
      expect(zellij.isAvailable).toHaveBeenCalledOnce();
      expect(zellij.findPanesByWindowName).not.toHaveBeenCalled();
      expect(tmux.killPane).not.toHaveBeenCalled();
    });

    it("fails conservatively when an available backend pane lookup errors", () => {
      const manifest = createWorkflowProcessAttemptManifest(
        operationAttempt(),
        3,
        "nonce_1234567890abcdef",
        "process",
      );
      const ownerCwd = join(temporaryRoot, "owner");
      const tmux = paneLookupHarness("tmux", [], {
        available: true,
        lookupError: new Error("tmux server lookup failed"),
      });
      const zellij = paneLookupHarness("zellij", [], { available: false });
      __setTmuxMultiplexer(tmux.mux);
      __setZellijMultiplexer(zellij.mux);

      expect(() =>
        recoverWorkflowProcessPaneAssignment(manifest, ownerCwd),
      ).toThrow("Workflow tmux pane lookup was unavailable during recovery.");
      expect(tmux.findPanesByWindowName).toHaveBeenCalledWith(
        manifest.paneName,
      );
    });

    it("adopts the existing zellij pane after a crash before interactive state append", () => {
      const manifest = createWorkflowProcessAttemptManifest(
        operationAttempt(),
        3,
        "nonce_1234567890abcdef",
        "process",
      );
      const ownerCwd = join(temporaryRoot, "owner");
      const paths = createInteractiveSubagentPaths({
        id: manifest.agentId,
        name: manifest.paneName,
        cwd: ownerCwd,
        deterministicSessionFile: true,
      });
      writeWorkflowProcessAttemptManifest(paths.artifactDir, manifest);
      const tmux = paneLookupHarness("tmux", []);
      const zellij = paneLookupHarness("zellij", [
        {
          paneId: "17",
          windowName: manifest.paneName,
          session: "zellij-owner",
        },
      ]);
      __setTmuxMultiplexer(tmux.mux);
      __setZellijMultiplexer(zellij.mux);

      const recovered = recoverWorkflowProcessPaneAssignment(
        manifest,
        ownerCwd,
      );

      expect(recovered).toEqual({
        backend: "zellij",
        paneId: "17",
        windowName: manifest.paneName,
        muxSession: "zellij-owner",
        artifactDir: paths.artifactDir,
        sessionFile: paths.sessionFile,
        launchScriptFile: paths.launchScriptFile,
      });
      expect(zellij.live.size).toBe(1);
      expect(zellij.killPane).not.toHaveBeenCalled();
      expect(tmux.findPanesByWindowName).toHaveBeenCalledWith(
        manifest.paneName,
      );
      expect(zellij.findPanesByWindowName).toHaveBeenCalledWith(
        manifest.paneName,
      );
    });

    it("re-derives owner-contained paths instead of trusting journal assignment paths", () => {
      const manifest = createWorkflowProcessAttemptManifest(
        operationAttempt(),
        3,
        "nonce_1234567890abcdef",
        "process",
      );
      const ownerCwd = join(temporaryRoot, "owner");
      const paths = createInteractiveSubagentPaths({
        id: manifest.agentId,
        name: manifest.paneName,
        cwd: ownerCwd,
        deterministicSessionFile: true,
      });
      writeWorkflowProcessAttemptManifest(paths.artifactDir, manifest);
      const tmux = paneLookupHarness("tmux", []);
      const zellij = paneLookupHarness("zellij", [
        {
          paneId: "17",
          windowName: manifest.paneName,
          session: "zellij-owner",
        },
      ]);
      __setTmuxMultiplexer(tmux.mux);
      __setZellijMultiplexer(zellij.mux);

      const recovered = recoverWorkflowProcessPaneAssignment(
        manifest,
        ownerCwd,
        {
          backend: "zellij",
          paneId: "17",
          windowName: manifest.paneName,
          muxSession: "zellij-owner",
          artifactDir: join(temporaryRoot, "hostile", "artifacts"),
          sessionFile: join(temporaryRoot, "hostile", "session.jsonl"),
          launchScriptFile: join(temporaryRoot, "hostile", "launch.sh"),
        },
      );

      expect(recovered?.artifactDir).toBe(paths.artifactDir);
      expect(recovered?.sessionFile).toBe(paths.sessionFile);
      expect(recovered?.launchScriptFile).toBe(paths.launchScriptFile);
    });

    it("fences a discovered pane when journal backend identity does not match", () => {
      const manifest = createWorkflowProcessAttemptManifest(
        operationAttempt(),
        3,
        "nonce_1234567890abcdef",
        "process",
      );
      const ownerCwd = join(temporaryRoot, "owner");
      const paths = createInteractiveSubagentPaths({
        id: manifest.agentId,
        name: manifest.paneName,
        cwd: ownerCwd,
        deterministicSessionFile: true,
      });
      writeWorkflowProcessAttemptManifest(paths.artifactDir, manifest);
      const tmux = paneLookupHarness("tmux", []);
      const zellij = paneLookupHarness("zellij", [
        {
          paneId: "17",
          windowName: manifest.paneName,
          session: "zellij-owner",
        },
      ]);
      __setTmuxMultiplexer(tmux.mux);
      __setZellijMultiplexer(zellij.mux);

      const recovered = recoverWorkflowProcessPaneAssignment(
        manifest,
        ownerCwd,
        {
          backend: "zellij",
          paneId: "99",
          windowName: manifest.paneName,
          muxSession: "zellij-owner",
          artifactDir: paths.artifactDir,
          sessionFile: paths.sessionFile,
          launchScriptFile: paths.launchScriptFile,
        },
      );

      expect(recovered).toBeUndefined();
      expect(zellij.live.size).toBe(0);
      expect(zellij.killPane).toHaveBeenCalledWith("17", "zellij-owner");
    });
  });
});
