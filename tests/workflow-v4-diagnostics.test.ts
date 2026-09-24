import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentResult } from "../src/helpers";
import {
  MAX_WORKFLOW_JOBS,
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { awaitInteractiveResult } from "../src/workflow-worker";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  workflowFailureClassification,
  type WorkflowAgentRunner,
  type WorkflowProgress,
} from "../src/workflow-core";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import type { Multiplexer } from "../src/multiplexer-contracts";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionOwnerToken,
} from "../src/session-scope";
import { createTelemetrySession } from "../src/telemetry";

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
} {
  const payloads: TelemetryPayload[] = [];
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
    telemetry: createTelemetrySession(true),
  });
  return { owner: sessionOwner(scope), payloads };
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
    const job = startWorkflowJob("cancelled-child", SCRIPT, {
      runAgent,
      onProgress: (event) => progress.push(event),
    });
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
describe("workflow v5 aggregate classifications", () => {
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
      failure_code: "workflow_schema_invalid",
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
      failure_code: "workflow_timeout",
    });
  });

  it("reports pre-admission workflow capacity without lifecycle aggregates", () => {
    const { owner, payloads } = telemetryScope(403);
    const fillerIds: string[] = [];
    try {
      for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
        const id = `v5-capacity-${index}`;
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

describe("workflow result diagnostic guidance", () => {
  it("adds structured schema guidance to local result text", async () => {
    const tools = new Map<string, any>();
    const { registerWorkflowTool } = await import("../src/workflow-tool");
    registerWorkflowTool({
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
    const job = startWorkflowJob(
      "schema-result-guidance",
      'export const meta = { name: "schema-result-guidance", description: "d" };\n' +
        'return await agent("schema", { schema: { type: "not-a-schema" } });',
      { runAgent: vi.fn(async () => successfulResult()) },
    );
    jobs.push(job);
    await expect(job.promise).rejects.toBeInstanceOf(Error);

    const result = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: job.id });
    expect(result.details.failureCode).toBe("workflow_schema_invalid");
    expect(result.content[0].text).toContain(
      "Diagnostic [workflow_schema_invalid]: Workflow schema validation failed.",
    );
    expect(result.content[0].text).toContain(
      "Review the schema and the expected output shape",
    );
  });
});

describe("workflow mux probe diagnostics", () => {
  it("bounds unknown liveness without claiming a confirmed pane exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-mux-probe-"));
    const artifactDir = join(root, "artifact");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "events.ndjson"), "");
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
      getPaneLivenessAsync: vi.fn(async () => {
        throw new Error("probe unavailable");
      }),
      getPaneActivityAsync: async () => "unknown",
      sendKeys: () => {},
      sendEnter: () => {},
      killPane: () => {},
      focusPane: async () => {},
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({ attachCommand: "", focusCommand: "" }),
    } as unknown as Multiplexer;
    __setTmuxMultiplexer(probeMux);
    const state = {
      id: "mux-probe",
      artifactDir,
      sessionFile: join(root, "session.jsonl"),
      paneId: "pane",
      mux: "tmux",
      muxSession: "session",
      model: "test/model",
    } as unknown as InteractiveSubagentState;

    try {
      const result = await awaitInteractiveResult(state, undefined, 1);

      expect(result).toMatchObject({
        isError: true,
        errorMessage: "interactive sub-agent pane liveness unavailable",
      });
      expect(workflowFailureClassification(result)).toMatchObject({
        errorCategory: "mux",
        errorStage: "polling",
        runtimeFailureKind: "mux_probe",
      });
      if (!result.isError) throw new Error("expected mux probe error");
      expect(result.errorMessage).not.toContain("pane exited");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
