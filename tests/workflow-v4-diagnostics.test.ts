import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  appendCompletionEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import type { SubagentResult } from "../src/helpers";
import {
  MAX_WORKFLOW_JOBS,
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { awaitInteractiveResult } from "../src/workflow-worker";
import { pollArtifactChanges } from "../src/artifact-poller";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  type WorkflowAgentRunner,
  type WorkflowProgress,
  INTERACTIVE_DEAD_GRACE_TICKS,
  workflowFailureClassification,
} from "../src/workflow-core";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import type {
  Multiplexer,
  PaneLivenessDiagnostic,
} from "../src/multiplexer-contracts";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionOwnerToken,
} from "../src/session-scope";
import {
  createTelemetrySession,
  type TelemetrySession,
} from "../src/telemetry";
import { createTestSessionScope } from "./session-scope-fixture";

const SCRIPT =
  'export const meta = { name: "cancelled-child", description: "d" };\n' +
  'return await agent("cancelled");';

type TelemetryPayload = {
  event: string;
  properties: Record<string, unknown>;
};

function successfulResult(): SubagentResult {
  return {
    isError: false,
    output: "ok",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: undefined,
  };
}

function telemetryScope(id: number): {
  owner: SessionOwnerToken;
  payloads: TelemetryPayload[];
  telemetry: TelemetrySession;
} {
  const payloads: TelemetryPayload[] = [];
  const telemetry = createTelemetrySession(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      payloads.push(JSON.parse(String(init?.body)) as TelemetryPayload);
      return new Response(null, { status: 200 });
    }),
  );
  const scope = registerSessionScope({
    id,
    generation: 1,
    lifecycle: "started",
    pi: {} as ExtensionAPI,
    telemetry,
  });
  return { owner: sessionOwner(scope), payloads, telemetry };
}
const jobs: Array<{ id: string }> = [];

afterEach(() => {
  for (const job of jobs) workflowJobRegistry.delete(job.id);
  jobs.length = 0;
  clearSessionScopes();
  __resetMuxInstances();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workflow v4 cancellation diagnostics", () => {
  it("does not count a cancelled legacy-error result as a workflow error", async () => {
    const progress: WorkflowProgress[] = [];
    const runAgent = vi.fn(
      async (): Promise<SubagentResult> =>
        ({
          // Older runners can report both flags for cancellation.
          isError: true,
          cancelled: true,
          output: "",
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: undefined,
          errorMessage: "aborted",
        }) as unknown as SubagentResult,
    );
    const scope = createTestSessionScope();
    const job = startWorkflowJob(
      "cancelled-child",
      SCRIPT,
      {
        runAgent,
        onProgress: (event) => progress.push(event),
      },
      undefined,
      undefined,
      sessionOwner(scope),
    );
    jobs.push(job);

    const result = await job.promise;

    expect(runAgent).toHaveBeenCalledOnce();
    expect(result.result).toBeNull();
    expect(result.errorCount).toBe(0);
    expect(job.snapshot.errorCount).toBe(0);
    expect(job.snapshot.agentRecords?.[0]?.status).toBe("cancelled");
    expect(
      progress.filter((event) => event.kind === "agent_done").at(-1),
    ).toMatchObject({ status: "cancelled" });
  });
});
describe("workflow v4 aggregate classifications", () => {
  it("carries schema validation evidence to one workflow lifecycle pair", async () => {
    const { owner, payloads } = telemetryScope(401);
    const runAgent = vi.fn(async () => successfulResult());
    const job = startWorkflowJob(
      "schema-failure",
      'export const meta = { name: "schema-failure", description: "d" };\n' +
        'return await agent("schema", { schema: { type: "not-a-schema" } });',
      { runAgent },
      undefined,
      undefined,
      owner,
    );
    jobs.push(job);

    await expect(job.promise).rejects.toBeInstanceOf(Error);

    const lifecycle = payloads.filter((payload) =>
      /workflow_(started|completed)$/.test(payload.event),
    );
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.map((payload) => payload.event)).toEqual([
      "pi_subagentura_workflow_started",
      "pi_subagentura_workflow_completed",
    ]);
    expect(payloads.at(-1)?.properties).toMatchObject({
      status: "error",
      error_category: "schema",
      error_stage: "schema_validation",
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("carries wall timeout evidence to one workflow lifecycle pair", async () => {
    const { owner, payloads } = telemetryScope(402);
    const runAgent: WorkflowAgentRunner = async ({ signal }) =>
      new Promise<SubagentResult>((resolve) => {
        if (signal?.aborted) {
          resolve(successfulResult());
          return;
        }
        signal?.addEventListener("abort", () => resolve(successfulResult()), {
          once: true,
        });
      });
    const job = startWorkflowJob(
      "timeout-failure",
      'export const meta = { name: "timeout-failure", description: "d" };\n' +
        'return await agent("timeout");',
      { runAgent, workflowTimeoutMs: 15 },
      undefined,
      undefined,
      owner,
    );
    jobs.push(job);

    await expect(job.promise).rejects.toBeInstanceOf(Error);

    const lifecycle = payloads.filter((payload) =>
      /workflow_(started|completed)$/.test(payload.event),
    );
    expect(lifecycle).toHaveLength(2);
    expect(payloads.at(-1)?.properties).toMatchObject({
      status: "error",
      error_category: "timeout",
      error_stage: "workflow",
    });
  });

  it("reports pre-admission workflow capacity without lifecycle aggregates", () => {
    const { owner, payloads } = telemetryScope(403);
    const fillerIds: string[] = [];
    try {
      for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
        const id = `v4-capacity-${index}`;
        workflowJobRegistry.set(id, {
          id,
          name: "capacity-filler",
          status: "running",
          startedAt: Date.now(),
          promise: undefined as unknown as WorkflowJobState["promise"],
          abort: new AbortController(),
          snapshot: {
            agentsSpawned: 0,
            errorCount: 0,
            tokensSpent: 0,
            phases: [],
          },
          parentSessionOwner: owner,
        });
        fillerIds.push(id);
      }

      expect(() =>
        startWorkflowJob(
          "capacity-failure",
          'export const meta = { name: "capacity-failure", description: "d" };\nreturn "ok";',
          { runAgent: async () => successfulResult() },
          undefined,
          undefined,
          owner,
        ),
      ).toThrow();

      const failures = payloads.filter(
        (payload) => payload.event === "pi_subagentura_runtime_failure",
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.properties).toMatchObject({
        error_category: "capacity",
        error_stage: "workflow",
        failure_kind: "workflow_capacity",
        reporter: "workflow_runner",
        impact: "blocked",
      });
      expect(
        payloads.filter((payload) =>
          /workflow_(started|completed)$/.test(payload.event),
        ),
      ).toHaveLength(0);
    } finally {
      for (const id of fillerIds) workflowJobRegistry.delete(id);
    }
  });
});

describe("workflow mux probe diagnostics", () => {
  it("delivers terminal artifact output without an unknown-liveness failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-mux-probe-"));
    const { payloads, telemetry } = telemetryScope(906);
    const art = artifactPath(root, "mux-probe");
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(art.statusFile, "");
    const getPaneLivenessAsync = vi.fn(async () => "unknown" as const);
    const probeMux = {
      name: "tmux",
      capabilities: {
        structuredFocus: true,
        boundedCapture: true,
        nativeOverlay: true,
      },
      isAvailable: () => true,
      createPane: () => ({ paneId: "pane" }),
      getPaneLiveness: () => "unknown",
      getPaneLivenessAsync,
      getPaneActivityAsync: async () => "unknown",
      sendKeys: () => undefined,
      sendEnter: () => undefined,
      killPane: () => undefined,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({ attachCommand: "", focusCommand: "" }),
    } as unknown as Multiplexer;
    __setTmuxMultiplexer(probeMux);
    const state = {
      id: "mux-probe",
      artifactDir: art.dir,
      sessionFile: join(root, "session.jsonl"),
      paneId: "pane",
      mux: "tmux",
      muxSession: "session",
      model: "test/model",
      telemetryEligible: true,
      telemetryCorrelationId: telemetry.correlationId,
    } as unknown as InteractiveSubagentState;

    const controller = new AbortController();
    try {
      const pending = awaitInteractiveResult(
        state,
        controller.signal,
        1000,
        undefined,
        undefined,
        telemetry,
      );
      await vi.waitFor(() => {
        expect(getPaneLivenessAsync.mock.calls.length).toBeGreaterThan(0);
      });
      writeOutput(art, "artifact answer survives unknown liveness");
      appendCompletionEvent(art, {
        turnId: "turn-mux-probe",
        outcome: "done",
        source: "agent_settled",
      });

      const result = await pending;

      expect(result.isError).toBe(false);
      expect(result.output).toBe("artifact answer survives unknown liveness");
      expect(getPaneLivenessAsync.mock.calls.length).toBe(1);
      expect(
        payloads.filter(
          (payload) => payload.event === "pi_subagentura_runtime_failure",
        ),
      ).toHaveLength(0);
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves transient unknown probes local until the waiter reports a blocked outage", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-mux-shared-"));
    const telemetry = createTelemetrySession(true, "orchestrator_v2");
    const disabledObserver: TelemetrySession = {
      ...telemetry,
      enabled: false,
    };
    const payloads: TelemetryPayload[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        payloads.push(JSON.parse(String(init?.body)) as TelemetryPayload);
        return new Response(null, { status: 200 });
      }),
    );
    const scope = registerSessionScope({
      id: 904,
      generation: 1,
      lifecycle: "started",
      pi: { sendMessage: vi.fn() } as unknown as ExtensionAPI,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn(),
      } as unknown as ExtensionUIContext,
      sessionManager: { getSessionId: () => "pi" },
      telemetry,
    });
    const owner = sessionOwner(scope);
    const firstArtifact = artifactPath(root, "pane-one");
    const secondArtifact = artifactPath(root, "pane-two");
    for (const art of [firstArtifact, secondArtifact]) {
      mkdirSync(art.dir, { recursive: true });
      writeFileSync(art.statusFile, "");
    }
    const makeState = (
      id: string,
      artifactDir: string,
    ): InteractiveSubagentState =>
      ({
        id,
        name: id,
        task: "task",
        paneId: id,
        artifactDir,
        sessionFile: join(root, `${id}.jsonl`),
        cwd: root,
        startedAt: Date.now(),
        mux: "tmux",
        muxSession: "session",
        model: "test/model",
        status: "running",
        telemetryEligible: true,
        telemetryCorrelationId: telemetry.correlationId,
        sessionOwner: owner,
      }) as unknown as InteractiveSubagentState;
    const firstState = makeState("pane-one", firstArtifact.dir);
    const secondState = makeState("pane-two", secondArtifact.dir);
    scope.interactiveStates.set(firstState.id, firstState);
    scope.interactiveStates.set(secondState.id, secondState);
    const livenessDiagnostic: PaneLivenessDiagnostic = {
      liveness: "unknown",
      failureReason: "timeout",
    };
    let releaseFirstProbe!: () => void;
    const firstProbeGate = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const firstProbe = vi.fn(async () => {
      if (firstProbe.mock.calls.length === 1) await firstProbeGate;
      return livenessDiagnostic.liveness;
    });
    const secondProbe = vi.fn(async () => "alive" as const);
    const getPaneLivenessAsync = vi.fn(async (paneId: string) =>
      paneId === "pane-one" ? firstProbe() : secondProbe(),
    );
    __setTmuxMultiplexer({
      name: "tmux",
      capabilities: {
        structuredFocus: true,
        boundedCapture: true,
        nativeOverlay: true,
      },
      isAvailable: () => true,
      createPane: () => ({ paneId: "pane" }),
      getPaneLiveness: () => "unknown",
      getPaneLivenessAsync,
      getPaneLivenessDiagnosticAsync: async (paneId: string) =>
        paneId === "pane-one"
          ? livenessDiagnostic
          : { liveness: "alive" as const },
      getPaneActivityAsync: async () => "unknown",
      sendKeys: () => undefined,
      sendEnter: () => undefined,
      killPane: () => undefined,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({ attachCommand: "", focusCommand: "" }),
    } as unknown as Multiplexer);

    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const firstWaiting = awaitInteractiveResult(
        firstState,
        firstController.signal,
        1,
        undefined,
        undefined,
        telemetry,
      );
      const secondWaiting = awaitInteractiveResult(
        secondState,
        secondController.signal,
        1,
        undefined,
        undefined,
        disabledObserver,
      );
      await vi.waitFor(() => {
        expect(firstProbe.mock.calls.length).toBeGreaterThan(0);
        expect(secondProbe.mock.calls.length).toBeGreaterThan(0);
      });
      const runtimeFailures = () =>
        payloads.filter(
          (payload) => payload.event === "pi_subagentura_runtime_failure",
        );

      await pollArtifactChanges({} as unknown as ExtensionAPI, owner);
      expect(firstState.status).toBe("unknown");
      expect(runtimeFailures()).toHaveLength(0);

      writeOutput(secondArtifact, "disabled observer does not block output");
      appendCompletionEvent(secondArtifact, {
        turnId: "turn-pane-two",
        outcome: "done",
        source: "agent_settled",
      });
      const secondResult = await secondWaiting;
      expect(secondResult.isError).toBe(false);
      expect(secondResult.output).toBe(
        "disabled observer does not block output",
      );
      expect(runtimeFailures()).toHaveLength(0);

      releaseFirstProbe();
      const firstResult = await firstWaiting;
      if (!firstResult.isError) {
        throw new Error("expected a mux-probe failure");
      }
      expect(firstResult.errorMessage).toBe(
        "interactive sub-agent pane liveness unavailable",
      );
      expect(runtimeFailures()).toHaveLength(1);
      expect(runtimeFailures()[0]?.properties).toMatchObject({
        error_category: "mux",
        error_stage: "polling",
        failure_kind: "mux_probe",
        execution: "interactive",
        mux: "tmux",
        reporter: "workflow_waiter",
        impact: "blocked",
      });
    } finally {
      releaseFirstProbe();
      firstController.abort();
      secondController.abort();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("returns a typed sustained-unknown failure without settlement duplication", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-mux-sustained-"));
    const { owner, payloads, telemetry } = telemetryScope(905);
    const art = artifactPath(root, "mux-sustained");
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(art.statusFile, "");
    const getPaneLivenessAsync = vi.fn(async () => "unknown" as const);
    __setTmuxMultiplexer({
      name: "tmux",
      capabilities: {
        structuredFocus: true,
        boundedCapture: true,
        nativeOverlay: true,
      },
      isAvailable: () => true,
      createPane: () => ({ paneId: "pane" }),
      getPaneLiveness: () => "unknown",
      getPaneLivenessAsync,
      getPaneActivityAsync: async () => "unknown",
      sendKeys: () => undefined,
      sendEnter: () => undefined,
      killPane: () => undefined,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({ attachCommand: "", focusCommand: "" }),
    } as unknown as Multiplexer);
    const state = {
      id: "mux-sustained",
      artifactDir: art.dir,
      sessionFile: join(root, "session.jsonl"),
      paneId: "pane",
      mux: "tmux",
      muxSession: "session",
      model: "test/model",
      status: "running",
      telemetryEligible: true,
      telemetryCorrelationId: telemetry.correlationId,
      sessionOwner: owner,
    } as unknown as InteractiveSubagentState;

    try {
      const result = await awaitInteractiveResult(
        state,
        undefined,
        1,
        undefined,
        undefined,
        telemetry,
      );

      expect(getPaneLivenessAsync).toHaveBeenCalledTimes(
        INTERACTIVE_DEAD_GRACE_TICKS,
      );
      if (!result.isError) throw new Error("expected a mux-probe failure");
      expect(result.output).toBe("(no output)");
      expect(result.errorMessage).toBe(
        "interactive sub-agent pane liveness unavailable",
      );
      expect(workflowFailureClassification(result)).toEqual({
        errorCategory: "mux",
        errorStage: "polling",
        runtimeFailureKind: "mux_probe",
      });
      expect(state.status).toBe("running");

      const runtimeFailures = () =>
        payloads.filter(
          (payload) => payload.event === "pi_subagentura_runtime_failure",
        );
      expect(runtimeFailures()).toHaveLength(1);
      expect(runtimeFailures()[0]?.properties).toMatchObject({
        error_category: "mux",
        error_stage: "polling",
        failure_kind: "mux_probe",
        execution: "interactive",
        mux: "tmux",
        reporter: "workflow_waiter",
        impact: "blocked",
      });

      const job = startWorkflowJob(
        "mux-sustained-settlement",
        SCRIPT,
        { runAgent: async () => result },
        undefined,
        undefined,
        owner,
      );
      jobs.push(job);
      await job.promise;
      expect(runtimeFailures()).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does not report a sustained probe failure after cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-mux-cancelled-probe-"));
    const { owner, payloads, telemetry } = telemetryScope(907);
    const art = artifactPath(root, "mux-cancelled-probe");
    mkdirSync(art.dir, { recursive: true });
    writeFileSync(art.statusFile, "");
    const controller = new AbortController();
    let probeCount = 0;
    const getPaneLivenessAsync = vi.fn(async () => {
      probeCount++;
      if (probeCount === INTERACTIVE_DEAD_GRACE_TICKS) {
        controller.abort();
      }
      return "unknown" as const;
    });
    __setTmuxMultiplexer({
      name: "tmux",
      capabilities: {
        structuredFocus: true,
        boundedCapture: true,
        nativeOverlay: true,
      },
      isAvailable: () => true,
      createPane: () => ({ paneId: "pane" }),
      getPaneLiveness: () => "unknown",
      getPaneLivenessAsync,
      getPaneActivityAsync: async () => "unknown",
      sendKeys: () => undefined,
      sendEnter: () => undefined,
      killPane: () => undefined,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({ attachCommand: "", focusCommand: "" }),
    } as unknown as Multiplexer);
    const state = {
      id: "mux-cancelled-probe",
      artifactDir: art.dir,
      sessionFile: join(root, "session.jsonl"),
      paneId: "pane",
      mux: "tmux",
      muxSession: "session",
      model: "test/model",
      status: "running",
      telemetryEligible: true,
      telemetryCorrelationId: telemetry.correlationId,
      sessionOwner: owner,
    } as unknown as InteractiveSubagentState;

    try {
      const result = await awaitInteractiveResult(
        state,
        controller.signal,
        1,
        undefined,
        undefined,
        telemetry,
      );

      expect(getPaneLivenessAsync).toHaveBeenCalledTimes(
        INTERACTIVE_DEAD_GRACE_TICKS,
      );
      if (!result.isError) throw new Error("expected an aborted result");
      expect(result.errorMessage).toBe("aborted");
      expect(
        payloads.filter(
          (payload) => payload.event === "pi_subagentura_runtime_failure",
        ),
      ).toHaveLength(0);
    } finally {
      controller.abort();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
