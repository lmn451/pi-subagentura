/**
 * Tests for the in-process sub-agent tools (in-process.ts).
 *
 * Covers parameter validation, edge cases, and list_available_models
 * filtering for every exported tool.
 *
 * Uses vi.hoisted + vi.mock to swap module-level dependencies while
 * keeping the real jobRegistry Map so tests can seed and verify state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock variables (available before vi.mock runs) ───────────

const {
  mockStartSubagentJob,
  mockDebugLog,
  mockFormatUsage,
  mockBuildLiveUpdate,
  mockScheduleJobCleanup,
  mockDeliverNotification,
} = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
  mockDebugLog: vi.fn(),
  mockFormatUsage: vi.fn(),
  mockBuildLiveUpdate: vi.fn(),
  mockScheduleJobCleanup: vi.fn(),
  mockDeliverNotification: vi.fn(),
}));

// We need a separate hoisted mock for `convertToLlm` / `serializeConversation`
// so subagent_with_context does not try to serialize real messages.
const { mockConvertToLlm, mockSerializeConversation } = vi.hoisted(() => ({
  mockConvertToLlm: vi.fn(),
  mockSerializeConversation: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return {
    ...actual,
    startSubagentJob: mockStartSubagentJob,
    debugLog: mockDebugLog,
    formatUsage: mockFormatUsage,
    buildLiveUpdate: mockBuildLiveUpdate,
    scheduleJobCleanup: mockScheduleJobCleanup,
  };
});

vi.mock("../src/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications")>();
  return {
    ...actual,
    deliverNotification: mockDeliverNotification,
  };
});

// interactive-tmux.ts has a TypeScript syntax that esbuild (vitest's transformer)
// cannot parse (line 613). We mock it so vitest never loads the source.
vi.mock("../src/interactive-tmux", () => {
  const fakeRegistry = new Map<string, any>();
  return {
    interactiveSubagentRegistry: fakeRegistry,
    isTmuxAvailable: () => false,
    default: {},
    // The specific shape doesn't matter — only the import needs to resolve.
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    convertToLlm: mockConvertToLlm,
    serializeConversation: mockSerializeConversation,
  };
});

// ── Imports (after mocks, vitest resolves to mocked modules) ─────────

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type JobState,
  type SubagentResult,
  inProcessJobsForOwner,
  jobRegistry,
  pruneCompletedJobs,
  registerInProcessJob,
} from "../src/helpers";
import {
  registerInProcessMaintenanceTools,
  registerInProcessSubagentTools,
} from "../src/tools/in-process";
import {
  DEFAULT_MAX_ORCHESTRATION_DEPTH,
  withOrchestrationContext,
} from "../src/orchestration-context";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  setLegacyActiveSessionRefs,
  type SessionScope,
} from "../src/session-scope";

const savedValidationFlag = process.env.PI_SUBAGENTURA_WITH_VALIDATION;

function setValidationFlag(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.PI_SUBAGENTURA_WITH_VALIDATION;
  } else {
    process.env.PI_SUBAGENTURA_WITH_VALIDATION = value;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** A minimal context object that satisfies the tools' `ctx` parameter. */
function mockCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/tmp",
    ui: { setStatus: vi.fn() },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("test-session"),
    },
    model: undefined,
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      find: vi.fn(),
    },
    ...overrides,
  };
}

/** A minimal JobState for test seeding. */
function createJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "test-job",
    status: "running",
    liveStatus: {
      turn: 0,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    },
    session: { abort: vi.fn().mockResolvedValue(undefined) } as any,
    startedAt: Date.now(),
    promise: Promise.resolve({
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: false,
    }),
    modelLabel: "test/model",
    ...overrides,
  };
}

function createExtensionApi() {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
}

/** Build a mock ExtensionAPI, register the tools, and return the API handle. */
function setupExtension(scope?: SessionScope) {
  const api = createExtensionApi();
  const extensionApi = api as unknown as ExtensionAPI;
  registerInProcessSubagentTools(extensionApi, scope);
  registerInProcessMaintenanceTools(extensionApi, scope);
  return api;
}

function setupScopedExtension(id: number) {
  const api = createExtensionApi();
  const extensionApi = api as unknown as ExtensionAPI;
  const scope = registerSessionScope({
    id,
    generation: 1,
    lifecycle: "started",
    pi: extensionApi,
  });
  registerInProcessSubagentTools(extensionApi, scope);
  registerInProcessMaintenanceTools(extensionApi, scope);
  return { api, scope };
}

/** Find a tool definition by name from the registered tools. */
function getToolDef(
  api: { registerTool: ReturnType<typeof vi.fn> },
  name: string,
) {
  return api.registerTool.mock.calls.find(([t]: any[]) => t.name === name)?.[0];
}

/** A default success SubagentResult for mockStartSubagentJob. */
const defaultSuccessResult: SubagentResult = {
  output: "task completed",
  usage: {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0.001,
    turns: 1,
  },
  model: "test/model",
  isError: false,
};

/** Default return value for mockStartSubagentJob (sync tool path). */
const defaultStartSubagentJobResult = {
  jobId: "default-job",
  jobPromise: Promise.resolve(defaultSuccessResult),
  session: { abort: vi.fn().mockResolvedValue(undefined) } as any,
  liveStatus: {
    turn: 1,
    output: "task completed",
    usage: {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.001,
      turns: 1,
    },
  },
  modelLabel: "test/model",
};

// ── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionScopes();
  jobRegistry.clear();
  mockStartSubagentJob.mockReset();
  mockStartSubagentJob.mockResolvedValue(defaultStartSubagentJobResult);
  mockFormatUsage.mockReturnValue("mock usage 1 turn");
  mockBuildLiveUpdate.mockReturnValue({
    content: [{ type: "text", text: "running..." }],
    details: { status: "running", subagentStatus: {} },
  });
});

afterEach(() => {
  jobRegistry.clear();
  clearSessionScopes();
  setValidationFlag(savedValidationFlag);
});
describe("peer session scope isolation", () => {
  it("keeps an A spawn owned by A after B becomes the legacy active session", async () => {
    const a = setupScopedExtension(801);
    const b = setupScopedExtension(802);
    setLegacyActiveSessionRefs(b.scope);
    const ownerA = sessionOwner(a.scope);
    const start = vi.fn();
    const pending = new Promise<SubagentResult>(() => {});
    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobId: "job-a",
      jobPromise: pending,
      start,
      disposeBeforeStart: vi.fn(),
    });

    const spawnA = getToolDef(a.api, "subagent_isolated");
    const result = await spawnA.execute(
      "spawn-a",
      { task: "owned by A" },
      undefined,
      undefined,
      mockCtx({
        sessionManager: {
          getSessionId: () => "session-a",
          getBranch: () => [],
        },
      }),
    );

    expect(result.details).toMatchObject({ status: "started", jobId: "job-a" });
    expect(a.scope.inProcessJobs.has("job-a")).toBe(true);
    expect(b.scope.inProcessJobs.has("job-a")).toBe(false);
    expect(jobRegistry.get("job-a")?.deliveryOwner).toMatchObject({
      sessionScopeId: ownerA.id,
      sessionScopeGeneration: ownerA.generation,
    });
    expect(mockStartSubagentJob).toHaveBeenCalledWith(
      expect.objectContaining({ owner: ownerA }),
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not expose scoped jobs through ownerless helper operations", () => {
    const a = setupScopedExtension(805);
    setupScopedExtension(806);
    const doneA = createJobState({
      id: "done-a",
      status: "done",
      result: defaultSuccessResult,
      deliveryOwner: {
        pi: a.scope.pi,
        sessionScopeId: a.scope.id,
        sessionScopeGeneration: a.scope.generation,
      },
    });
    registerInProcessJob(doneA, sessionOwner(a.scope));

    expect([...inProcessJobsForOwner().keys()]).toEqual([]);
    expect(pruneCompletedJobs()).toBe(0);
    expect(a.scope.inProcessJobs.get(doneA.id)).toBe(doneA);
    expect(jobRegistry.get(doneA.id)).toBe(doneA);
  });

  it("isolates status, result, cancel, and prune management paths", async () => {
    const a = setupScopedExtension(811);
    const b = setupScopedExtension(812);
    const ownerA = sessionOwner(a.scope);
    const ownerB = sessionOwner(b.scope);
    const abortB = vi.fn().mockResolvedValue(undefined);
    const runningB = createJobState({
      id: "running-b",
      session: { abort: abortB } as unknown as JobState["session"],
      deliveryOwner: {
        pi: b.scope.pi,
        sessionScopeId: ownerB.id,
        sessionScopeGeneration: ownerB.generation,
      },
    });
    const doneA = createJobState({
      id: "done-a",
      status: "done",
      result: defaultSuccessResult,
      deliveryOwner: {
        pi: a.scope.pi,
        sessionScopeId: ownerA.id,
        sessionScopeGeneration: ownerA.generation,
      },
    });
    const doneB = createJobState({
      id: "done-b",
      status: "done",
      result: defaultSuccessResult,
      deliveryOwner: {
        pi: b.scope.pi,
        sessionScopeId: ownerB.id,
        sessionScopeGeneration: ownerB.generation,
      },
    });
    expect(registerInProcessJob(runningB, ownerB)).toBe(true);
    expect(registerInProcessJob(doneA, ownerA)).toBe(true);
    expect(registerInProcessJob(doneB, ownerB)).toBe(true);

    const statusA = getToolDef(a.api, "get_subagent_status");
    const resultA = getToolDef(a.api, "get_subagent_result");
    const cancelA = getToolDef(a.api, "cancel_subagent");
    const pruneA = getToolDef(a.api, "prune_subagent_jobs");
    const statusB = getToolDef(b.api, "get_subagent_status");

    expect(
      (await statusA.execute("status", { jobId: "running-b" })).details.status,
    ).toBe("not_found");
    expect((await resultA.execute("result", { jobId: "done-b" })).isError).toBe(
      true,
    );
    expect(
      (
        await cancelA.execute(
          "cancel",
          { jobId: "running-b" },
          undefined,
          undefined,
          mockCtx(),
        )
      ).isError,
    ).toBe(true);
    expect(abortB).not.toHaveBeenCalled();
    expect(
      (await statusB.execute("status", { jobId: "running-b" })).details.status,
    ).toBe("running");

    const pruned = await pruneA.execute();
    expect(pruned.details).toMatchObject({ removed: 1, before: 1, after: 0 });
    expect(a.scope.inProcessJobs.has("done-a")).toBe(false);
    expect(b.scope.inProcessJobs.has("done-b")).toBe(true);
    expect(jobRegistry.has("done-a")).toBe(false);
    expect(jobRegistry.has("done-b")).toBe(true);
  });
  it("fails a dead supplied tool token closed instead of falling back", async () => {
    const a = setupScopedExtension(821);
    const b = setupScopedExtension(822);
    const ownerB = sessionOwner(b.scope);
    const jobB = createJobState({
      id: "fallback-target-b",
      deliveryOwner: {
        pi: b.scope.pi,
        sessionScopeId: ownerB.id,
        sessionScopeGeneration: ownerB.generation,
      },
    });
    registerInProcessJob(jobB, ownerB);
    a.scope.lifecycle = "shutdown";

    const statusA = getToolDef(a.api, "get_subagent_status");
    const response = await statusA.execute("status", {
      jobId: "fallback-target-b",
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/no longer active/i);
    expect(b.scope.inProcessJobs.has(jobB.id)).toBe(true);
  });
});

// ── subagent_with_context ────────────────────────────────────────────

describe("subagent_with_context tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "subagent_with_context");
  });

  it("returns 'No conversation history to inherit' when branch is empty (sync path)", async () => {
    // sessionManager.getBranch returns [] — the tool immediately bails.
    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-1",
      { task: "do something" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toBe("No conversation history to inherit.");
    expect(result.details).toEqual({});
    // No calls beyond the early return
    expect(mockStartSubagentJob).not.toHaveBeenCalled();
    expect(mockConvertToLlm).not.toHaveBeenCalled();
  });

  it("registers with BaseParams schema", () => {
    const params = toolDef.parameters;
    const props = (params as any).properties;
    // Required field
    expect(props.task).toBeDefined();
    expect(props.task.type).toBe("string");
    // Optional fields from BaseParams
    expect(props.persona).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.async).toBeDefined();
    expect(props.notifyOnComplete).toBeDefined();
    expect(props.maxAge).toBeDefined();
  });
});

// ── subagent_isolated ────────────────────────────────────────────────

describe("subagent_isolated tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "subagent_isolated");
  });

  it("rejects invalid params before creating an in-process job", async () => {
    setValidationFlag("on");

    const result = await toolDef.execute(
      "call-invalid",
      { task: 42 },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        status: "error",
        code: "invalid_params",
        tool: "subagent_isolated",
      },
    });
    expect(mockStartSubagentJob).not.toHaveBeenCalled();
    expect(jobRegistry.size).toBe(0);
  });

  it("continues through the existing path for valid params when enabled", async () => {
    setValidationFlag("yes");

    const result = await toolDef.execute(
      "call-valid",
      { task: "analyze code", async: false },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.details.status).toBe("done");
    expect(mockStartSubagentJob).toHaveBeenCalledOnce();
  });

  it("preserves existing behavior when validation is disabled", async () => {
    setValidationFlag("off");

    const result = await toolDef.execute(
      "call-bypassed",
      { task: 42, async: false },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.details.status).toBe("done");
    expect(mockStartSubagentJob).toHaveBeenCalledOnce();
  });

  it("passes null context to startSubagentJob (sync path)", async () => {
    const ctx = mockCtx();
    // isolated tool doesn't consult getBranch at all, so no messages needed.
    // async now defaults to true, so pass async: false to exercise the sync path.
    const result = await toolDef.execute(
      "call-1",
      { task: "analyze code", async: false },
      undefined,
      undefined,
      ctx,
    );

    // startSubagentJob should have been called with contextText: null
    expect(mockStartSubagentJob).toHaveBeenCalledWith(
      expect.objectContaining({ contextText: null }),
    );
    // Result should come from the mocked runSubagent path
    expect(result.content[0].text).toBe("task completed");
    expect(result.details.status).toBe("done");
  });

  it("defaults to async (background) when the flag is omitted", async () => {
    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-async-default",
      { task: "analyze code" },
      undefined,
      undefined,
      ctx,
    );

    // Async path returns immediately with a started job, not inline output.
    expect(result.details.status).toBe("started");
    expect(result.content[0].text).toMatch(/^Job .* started/);
    // The owning controller must be wired so ancestor aborts can cascade.
    expect(mockStartSubagentJob).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), depth: 1 }),
    );
  });

  it("refuses to spawn once the orchestration depth cap is reached", async () => {
    const ctx = mockCtx();
    const result = await withOrchestrationContext(
      { ownerJobId: "deep-parent", depth: DEFAULT_MAX_ORCHESTRATION_DEPTH },
      () =>
        toolDef.execute(
          "call-too-deep",
          { task: "spawn yet another reviewer" },
          undefined,
          undefined,
          ctx,
        ),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/depth limit reached/i);
    // No job should have been spawned.
    expect(mockStartSubagentJob).not.toHaveBeenCalled();
  });

  it("registers with BaseParams schema", () => {
    const params = toolDef.parameters;
    const props = (params as any).properties;
    expect(props.task).toBeDefined();
    expect(props.task.type).toBe("string");
    expect(props.persona).toBeDefined();
    expect(props.model).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.async).toBeDefined();
    expect(props.notifyOnComplete).toBeDefined();
    expect(props.maxAge).toBeDefined();
  });
});

// ── get_subagent_status ──────────────────────────────────────────────

describe("get_subagent_status tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "get_subagent_status");
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "nonexistent" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      "Job nonexistent not found. It may have been cancelled.",
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("not_found");
    expect(result.details.jobId).toBe("nonexistent");
  });

  it("returns cancelled response when job status is cancelled", async () => {
    const jobId = "cancelled-job";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(`Job ${jobId} was cancelled.`);
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });

  it("returns done response with usage summary when status is done", async () => {
    const jobId = "done-job";
    const doneResult: SubagentResult = {
      output: "analysis complete",
      usage: {
        input: 200,
        output: 150,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 0.002,
        turns: 2,
      },
      model: "anthropic/claude-3-5-sonnet",
      isError: false,
    };
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "done",
        result: doneResult,
        promise: Promise.resolve(doneResult),
      }),
    );

    mockFormatUsage.mockReturnValue("2 turns ↑200 ↓150 $0.0020");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("analysis complete");
    expect(result.details.status).toBe("done");
    expect(result.details.usageSummary).toBe("2 turns ↑200 ↓150 $0.0020");
    expect(result.details.usage).toEqual(doneResult.usage);
    expect(result.details.model).toBe("anthropic/claude-3-5-sonnet");
    expect(result.isError).toBeFalsy();
  });

  it("returns error response with usage summary when status is error", async () => {
    const jobId = "error-job";
    const errorResult: SubagentResult = {
      output: "Something went wrong",
      usage: {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.0005,
        turns: 1,
      },
      model: undefined,
      isError: true,
      errorMessage: "LLM returned an error",
    };
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "error",
        result: errorResult,
        promise: Promise.resolve(errorResult),
      }),
    );

    mockFormatUsage.mockReturnValue("1 turn ↑50 ↓10 $0.0005");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    // get_subagent_status returns result.output directly (unlike
    // get_subagent_result which wraps it with "Sub-agent failed:")
    expect(result.content[0].text).toBe("Something went wrong");
    expect(result.details.status).toBe("error");
    expect(result.details.usageSummary).toBe("1 turn ↑50 ↓10 $0.0005");
    expect(result.isError).toBe(true);
  });

  it("returns running update for running job", async () => {
    const jobId = "running-job";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "running" }));

    mockBuildLiveUpdate.mockReturnValue({
      content: [{ type: "text", text: "still working..." }],
      details: {
        status: "running",
        subagentStatus: { turn: 2, output: "still working...", usage: {} },
        model: "test/model",
      },
    });

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.details.status).toBe("running");
    expect(result.content[0].text).toBe("still working...");
  });
});

// ── get_subagent_result ──────────────────────────────────────────────

describe("get_subagent_result tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "get_subagent_result");
  });

  it("warns agents to wait only when explicitly requested", () => {
    expect(toolDef.description).toContain(
      "ONLY call this tool when the user explicitly asks you to wait",
    );
    expect(toolDef.description).toContain(
      "Do not call it immediately after spawning async sub-agents",
    );
  });

  it("describes immediate retrieval and optional bounded waiting", () => {
    expect(toolDef.description).toContain(
      "returns immediately with live status",
    );
    expect(toolDef.description).toContain("Pass wait: true");
    expect(toolDef.description).not.toContain(
      "Block until an async subagent job completes",
    );
  });

  it("returns immediately for a running job unless waiting is explicit", async () => {
    const jobId = "running-without-wait";
    let resolveJob!: (value: SubagentResult) => void;
    const jobPromise = new Promise<SubagentResult>((resolve) => {
      resolveJob = resolve;
    });
    const job = createJobState({ id: jobId, promise: jobPromise });
    jobRegistry.set(jobId, job);

    const executePromise = toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );
    const raced = await Promise.race([
      executePromise.then((result: any) => ({
        kind: "result" as const,
        result,
      })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 20),
      ),
    ]);

    resolveJob(defaultSuccessResult);
    await executePromise;
    expect(raced.kind).toBe("result");
    if (raced.kind !== "result") return;
    expect(raced.result.details.status).toBe("running");
    expect(raced.result.content[0].text).toContain(
      "continues in the background",
    );
    expect(job.resultRetrieved).toBeFalsy();
  });

  it("bounds an explicit wait and leaves the job running after timeout", async () => {
    const jobId = "bounded-explicit-wait";
    let resolveJob!: (value: SubagentResult) => void;
    const jobPromise = new Promise<SubagentResult>((resolve) => {
      resolveJob = resolve;
    });
    const job = createJobState({ id: jobId, promise: jobPromise });
    jobRegistry.set(jobId, job);

    const executePromise = toolDef.execute(
      "call-1",
      { jobId, wait: true, timeoutMs: 10 },
      undefined,
      undefined,
      mockCtx(),
    );
    const raced = await Promise.race([
      executePromise.then((result: any) => ({
        kind: "result" as const,
        result,
      })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 30),
      ),
    ]);

    resolveJob(defaultSuccessResult);
    await executePromise;
    expect(raced.kind).toBe("result");
    if (raced.kind !== "result") return;
    expect(raced.result.details).toMatchObject({
      jobId,
      status: "wait_timeout",
      timeoutMs: 10,
    });
    expect(job.status).toBe("running");
    expect(job.resultRetrieved).toBeFalsy();
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "missing" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      "Job missing not found. It may have been cancelled.",
    );
    expect(result.isError).toBe(true);
    expect(result.details.jobId).toBe("missing");
  });

  it("returns cancelled when job status is already cancelled", async () => {
    const jobId = "cancelled-result";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} was cancelled before completion.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });

  it("returns done result for completed job", async () => {
    const jobId = "done-result";
    const doneResult: SubagentResult = {
      output: "final analysis",
      usage: {
        input: 300,
        output: 200,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.003,
        turns: 3,
      },
      model: "anthropic/claude-sonnet",
      isError: false,
    };
    const job: JobState = createJobState({
      id: jobId,
      status: "done",
      result: doneResult,
      promise: Promise.resolve(doneResult),
    });
    jobRegistry.set(jobId, job);

    mockFormatUsage.mockReturnValue("3 turns ↑300 ↓200 $0.0030");

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("final analysis");
    expect(result.details.status).toBe("done");
    expect(result.details.usageSummary).toBe("3 turns ↑300 ↓200 $0.0030");
    expect(result.isError).toBeFalsy();
    // resultRetrieved should have been set
    expect(job.resultRetrieved).toBe(true);
  });

  it("handles cancellation race (status changes to cancelled after await)", async () => {
    const jobId = "race-job";
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });

    const job: JobState = createJobState({
      id: jobId,
      status: "running",
      promise: deferredPromise,
    });
    jobRegistry.set(jobId, job);

    // Start execute and wait for completion so cancellation race can be observed.
    const executePromise = toolDef.execute(
      "call-1",
      { jobId, wait: true },
      undefined,
      undefined,
      mockCtx(),
    );

    // Resolve the promise (schedules microtask)
    resolvePromise({
      output: "should be ignored",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: true,
      errorMessage: "aborted",
    });

    // Simulate the race: another code path cancels the job synchronously
    // BEFORE the microtask that resumes the tool executes.
    job.status = "cancelled";

    const result = await executePromise;

    expect(result.content[0].text).toBe(
      `Job ${jobId} was cancelled before completion.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("cancelled");
  });
});

// ── cancel_subagent ──────────────────────────────────────────────────

describe("cancel_subagent tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "cancel_subagent");
  });

  it("returns not_found for unknown jobId", async () => {
    const result = await toolDef.execute(
      "call-1",
      { jobId: "unknown" },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe("Job unknown not found.");
    expect(result.isError).toBe(true);
    expect(result.details.jobId).toBe("unknown");
  });

  it("returns already cancelled when job status is already cancelled", async () => {
    const jobId = "already-cancelled";
    jobRegistry.set(jobId, createJobState({ id: jobId, status: "cancelled" }));

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(`Job ${jobId} was already cancelled.`);
    // Already-cancelled is NOT considered an error by the tool
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("cancelled");
  });

  it("returns already completed when job is done", async () => {
    const jobId = "done-cancel";
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "done",
        result: defaultSuccessResult,
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} already completed — cannot cancel.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("done");
  });

  it("returns already completed when job is in error state", async () => {
    const jobId = "error-cancel";
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "error",
        result: {
          isError: true,
          output: defaultSuccessResult.output,
          usage: defaultSuccessResult.usage,
          errorMessage: "previous error",
        },
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toBe(
      `Job ${jobId} already completed — cannot cancel.`,
    );
    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("error");
  });

  it("cancels a running job and calls session.abort", async () => {
    const jobId = "running-cancel";
    const abortFn = vi.fn().mockResolvedValue(undefined);
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "running",
        session: { abort: abortFn } as any,
      }),
    );

    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toBe(`Job ${jobId} cancelled.`);
    expect(result.details.status).toBe("cancelled");
    // session.abort was called
    expect(abortFn).toHaveBeenCalledTimes(1);
    // scheduleJobCleanup was called for immediate cleanup
    expect(mockScheduleJobCleanup).toHaveBeenCalledWith(
      jobId,
      true,
      undefined,
      undefined,
    );
    // Footer was updated
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  it("handles abort rejection gracefully", async () => {
    const jobId = "abort-throws";
    const abortFn = vi.fn().mockRejectedValue(new Error("session gone"));
    jobRegistry.set(
      jobId,
      createJobState({
        id: jobId,
        status: "running",
        session: { abort: abortFn } as any,
      }),
    );

    const result = await toolDef.execute(
      "call-1",
      { jobId },
      undefined,
      undefined,
      mockCtx(),
    );

    // Even though abort threw, the tool should still report cancellation
    expect(result.content[0].text).toBe(`Job ${jobId} cancelled.`);
    expect(result.details.status).toBe("cancelled");
  });
});

// ── list_available_models ────────────────────────────────────────────

describe("list_available_models tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "list_available_models");
  });

  const baseModels = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    { provider: "anthropic", id: "claude-haiku-4", name: "Claude Haiku 4" },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { provider: "google", id: "gemini-2.5-flash", name: undefined },
  ];

  it("validates its inline schema before reading the model registry", async () => {
    setValidationFlag("true");
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-invalid-inline",
      { authOnly: "yes" },
      undefined,
      undefined,
      ctx,
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        status: "error",
        code: "invalid_params",
        tool: "list_available_models",
      },
    });
    expect(getAvailable).not.toHaveBeenCalled();
    expect(getAll).not.toHaveBeenCalled();
  });

  it("uses modelRegistry.getAvailable() when authOnly is true (default)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels.slice(0, 3));
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: true },
      undefined,
      undefined,
      ctx,
    );

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("3 models with auth configured");
  });

  it("uses modelRegistry.getAll() when authOnly is false", async () => {
    const getAvailable = vi.fn().mockReturnValue([]);
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: false },
      undefined,
      undefined,
      ctx,
    );

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAvailable).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("6 models total");
  });

  it("authOnly defaults to true when omitted", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels.slice(0, 2));
    const getAll = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll, find: vi.fn() },
    });

    await toolDef.execute("call-1", {}, undefined, undefined, ctx);

    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(getAll).not.toHaveBeenCalled();
  });

  it("filters by filter param on provider name (case-insensitive)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "ANTHROPIC" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("anthropic/claude-sonnet-4-5");
    expect(text).toContain("anthropic/claude-haiku-4");
    expect(text).not.toContain("openai");
    expect(text).not.toContain("minimax");
    expect(text).not.toContain("google");
  });

  it("filters by filter param on model id (case-insensitive)", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "gpt" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("gpt-4o");
    expect(text).toContain("gpt-4o-mini");
    expect(text).not.toContain("anthropic");
    expect(text).not.toContain("minimax");
  });

  it("filters by filter param on model name", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "MiniMax" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("MiniMax-M2.7");
    expect(text).not.toContain("claude");
    expect(text).not.toContain("gpt");
    expect(text).toContain("MiniMax M2.7"); // name appended
  });

  it("returns correct count and formatted text", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { authOnly: true },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.count).toBe(6);
    expect(result.details.models).toHaveLength(6);
    expect(result.details.models[0].provider).toBe("anthropic");
    expect(result.details.models[0].id).toBe("claude-sonnet-4-5");
    expect(result.details.models[0].name).toBe("Claude Sonnet 4.5");
    // Name-less model does not have a name prop (it's undefined)
    expect(result.details.models[5].name).toBeUndefined();
  });

  it("shows models with name appended in parentheses", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "gpt-4o" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("gpt-4o  (GPT-4o)");
    expect(text).toContain("gpt-4o-mini  (GPT-4o Mini)");
  });

  it("shows '(no models match)' when filter matches nothing", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "nonexistent" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("0 models with auth configured");
    expect(text).toContain("(no models match)");
  });

  it("shows the search pattern when a filter is provided", async () => {
    const getAvailable = vi.fn().mockReturnValue(baseModels);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      { filter: "big-pickle" },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Search pattern: big-pickle");
  });

  it("handles empty model registry gracefully", async () => {
    const getAvailable = vi.fn().mockReturnValue([]);
    const ctx = mockCtx({
      modelRegistry: { getAvailable, getAll: vi.fn(), find: vi.fn() },
    });

    const result = await toolDef.execute(
      "call-1",
      {},
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("0 models with auth configured");
    expect(result.details.count).toBe(0);
  });
});

// ── Render method tests ─────────────────────────────────────────

const mockTheme = {
  fg: vi
    .fn<(...args: string[]) => string>()
    .mockImplementation((_style: string, text: string) => text),
  bold: vi
    .fn<(text: string) => string>()
    .mockImplementation((text: string) => text),
};

describe("tool renderCall methods", () => {
  let api: ReturnType<typeof setupExtension>;

  beforeEach(() => {
    api = setupExtension();
  });

  it("subagent_with_context renderCall returns a Text", () => {
    const t = getToolDef(api, "subagent_with_context");
    const result = t.renderCall({ task: "hello world" }, mockTheme);
    expect(result).toBeInstanceOf(Text);
  });

  it("subagent_isolated renderCall returns a Text", () => {
    const t = getToolDef(api, "subagent_isolated");
    const result = t.renderCall({ task: "analyze code" }, mockTheme);
    expect(result).toBeInstanceOf(Text);
  });

  it("get_subagent_status renderCall includes jobId", () => {
    const t = getToolDef(api, "get_subagent_status");
    const result = t.renderCall({ jobId: "abc123" }, mockTheme);
    expect(result).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("accent", "abc123");
  });

  it("get_subagent_result renderCall includes jobId", () => {
    const t = getToolDef(api, "get_subagent_result");
    const result = t.renderCall({ jobId: "def456" }, mockTheme);
    expect(result).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("accent", "def456");
  });

  it("cancel_subagent renderCall includes jobId in error color", () => {
    const t = getToolDef(api, "cancel_subagent");
    const result = t.renderCall({ jobId: "xyz789" }, mockTheme);
    expect(result).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("error", "xyz789");
  });

  it("prune_subagent_jobs renderCall returns a Text", () => {
    const t = getToolDef(api, "prune_subagent_jobs");
    const result = t.renderCall({}, mockTheme);
    expect(result).toBeInstanceOf(Text);
    expect(mockTheme.bold).toHaveBeenCalledWith("prune_subagent_jobs");
  });

  it("cleanup_subagent_artifacts renderCall returns a Text", () => {
    const t = getToolDef(api, "cleanup_subagent_artifacts");
    const result = t.renderCall({}, mockTheme);
    expect(result).toBeInstanceOf(Text);
    expect(mockTheme.bold).toHaveBeenCalledWith("cleanup_subagent_artifacts");
  });
});

describe("tool renderResult methods", () => {
  let api: ReturnType<typeof setupExtension>;

  beforeEach(() => {
    api = setupExtension();
  });

  const mockOpts = { expanded: false, isPartial: false };

  it("subagent_with_context renderResult returns Text for done result", () => {
    const t = getToolDef(api, "subagent_with_context");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "complete" }],
        details: { status: "done" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("subagent_with_context renderResult returns Text for error result", () => {
    const t = getToolDef(api, "subagent_with_context");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "failed" }],
        isError: true,
        details: { status: "error" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("subagent_isolated renderResult returns Text for done result", () => {
    const t = getToolDef(api, "subagent_isolated");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "analysis complete" }],
        details: { status: "done" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("get_subagent_status renderResult passes isPartial for running", () => {
    const t = getToolDef(api, "get_subagent_status");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "working" }],
        details: { status: "running" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("get_subagent_status renderResult returns Text for done status", () => {
    const t = getToolDef(api, "get_subagent_status");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "output" }],
        details: { status: "done" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("get_subagent_result renderResult returns Text for done result", () => {
    const t = getToolDef(api, "get_subagent_result");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "result" }],
        details: { status: "done" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
  });

  it("cancel_subagent renderResult shows cancelled icon when cancelled", () => {
    const t = getToolDef(api, "cancel_subagent");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "Job abc cancelled." }],
        details: { status: "cancelled", jobId: "abc" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("error", "✕ Job abc cancelled");
  });

  it("cancel_subagent renderResult shows message when not cancelled", () => {
    const t = getToolDef(api, "cancel_subagent");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "Job xyz not found." }],
        details: { status: "not_found", jobId: "xyz" },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("error", "Job xyz not found.");
  });

  it("prune_subagent_jobs renderResult shows success when jobs removed", () => {
    const t = getToolDef(api, "prune_subagent_jobs");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "Removed 3 jobs." }],
        details: { removed: 3 },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith(
      "success",
      expect.stringContaining("Pruned"),
    );
  });

  it("prune_subagent_jobs renderResult shows dim when no jobs removed", () => {
    const t = getToolDef(api, "prune_subagent_jobs");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "No completed jobs to prune" }],
        details: { removed: 0 },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith(
      "dim",
      "No completed jobs to prune",
    );
  });

  it("cleanup_subagent_artifacts renderResult warns on dry-run with items", () => {
    const t = getToolDef(api, "cleanup_subagent_artifacts");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: { removed: 2, skipped: 1, errors: [], dryRun: true },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("warning", expect.any(String));
  });

  it("cleanup_subagent_artifacts renderResult dim on dry-run with nothing", () => {
    const t = getToolDef(api, "cleanup_subagent_artifacts");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: { removed: 0, skipped: 0, errors: [], dryRun: true },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("dim", expect.any(String));
  });

  it("cleanup_subagent_artifacts renderResult success on live cleanup with items", () => {
    const t = getToolDef(api, "cleanup_subagent_artifacts");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: { removed: 3, skipped: 2, errors: [], dryRun: false },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("success", expect.any(String));
  });

  it("cleanup_subagent_artifacts renderResult dim on live cleanup with nothing", () => {
    const t = getToolDef(api, "cleanup_subagent_artifacts");
    const r = t.renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: { removed: 0, skipped: 3, errors: [], dryRun: false },
      },
      mockOpts,
      mockTheme,
      {},
    );
    expect(r).toBeInstanceOf(Text);
    expect(mockTheme.fg).toHaveBeenCalledWith("dim", expect.any(String));
  });
});

// ── prune_subagent_jobs tool ────────────────────────────────────

describe("prune_subagent_jobs tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "prune_subagent_jobs");
  });

  it("returns 0 removed when registry is empty", async () => {
    const result = await toolDef.execute();
    expect(result.content[0].text).toContain("Removed 0");
    expect(result.details.removed).toBe(0);
  });

  it("accepts undefined params when runtime validation is enabled", async () => {
    setValidationFlag("on");

    const result = await toolDef.execute();

    expect(result.details).toMatchObject({ removed: 0 });
    expect(result.details.code).toBeUndefined();
  });

  it("returns correct count when done/error jobs exist", async () => {
    jobRegistry.set("j1", createJobState({ id: "j1", status: "done" }));
    jobRegistry.set("j2", createJobState({ id: "j2", status: "error" }));
    jobRegistry.set("j3", createJobState({ id: "j3", status: "running" }));

    const result = await toolDef.execute();
    expect(result.content[0].text).toContain("Removed 2");
    expect(result.details.removed).toBe(2);
    expect(result.details.before).toBe(3);
    expect(result.details.after).toBe(1);
  });

  it("preserves running and cancelled jobs, removes done", async () => {
    jobRegistry.set("r1", createJobState({ id: "r1", status: "running" }));
    jobRegistry.set("c1", createJobState({ id: "c1", status: "cancelled" }));
    jobRegistry.set("d1", createJobState({ id: "d1", status: "done" }));

    await toolDef.execute();
    expect(jobRegistry.has("r1")).toBe(true);
    expect(jobRegistry.has("c1")).toBe(true);
    expect(jobRegistry.has("d1")).toBe(false);
  });
});

// ── cleanup_subagent_artifacts tool ─────────────────────────────

describe("cleanup_subagent_artifacts tool", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "cleanup_subagent_artifacts");
  });

  const nonexistentRoot = "/tmp/nonexistent-subagentura-test-dir";

  it("returns 0 removed for dry-run on nonexistent rootDir", async () => {
    const result = await toolDef.execute("call-1", {
      ttlMs: 60000,
      rootDir: nonexistentRoot,
      dryRun: true,
    });
    expect(result.details.removed).toBe(0);
    expect(result.details.errors).toEqual([]);
    expect(result.details.dryRun).toBe(true);
    expect(result.content[0].text).toContain("(dry run)");
  });

  it("returns 0 removed for non-dry-run on nonexistent rootDir", async () => {
    const result = await toolDef.execute("call-1", {
      ttlMs: 60000,
      rootDir: nonexistentRoot + "-2",
      dryRun: false,
    });
    expect(result.details.removed).toBe(0);
    expect(result.details.dryRun).toBe(false);
    expect(result.content[0].text).not.toContain("(dry run)");
  });

  it("dryRun defaults to true when omitted", async () => {
    const result = await toolDef.execute("call-1", {
      ttlMs: 60000,
      rootDir: nonexistentRoot + "-3",
    });
    expect(result.details.dryRun).toBe(true);
    expect(result.content[0].text).toContain("(dry run)");
  });
});

// ── subagent_with_context async path ────────────────────────────

describe("subagent_with_context async path", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    api = setupExtension();
    toolDef = getToolDef(api, "subagent_with_context");
  });

  it("returns 'No conversation history' when branch empty with async:true", async () => {
    const ctx = mockCtx();
    const result = await toolDef.execute(
      "call-1",
      { task: "do async", async: true },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("No conversation history to inherit.");
    expect(mockStartSubagentJob).not.toHaveBeenCalled();
  });

  it("starts async job with serialized context when branch has messages", async () => {
    const branchMessages = [
      { type: "message", message: { role: "user", content: "Hello" } },
      {
        type: "message",
        message: { role: "assistant", content: "Hi there" },
      },
    ];

    mockConvertToLlm.mockReturnValue([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    mockSerializeConversation.mockReturnValue(
      "User: Hello\nAssistant: Hi there",
    );

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi.fn().mockReturnValue(branchMessages),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    const result = await toolDef.execute(
      "call-1",
      { task: "summarize", async: true },
      undefined,
      undefined,
      ctx,
    );

    expect(result.details.status).toBe("started");
    expect(result.details.jobId).toBe("default-job");
    expect(result.details.contextMessages).toBe(2);

    expect(mockConvertToLlm).toHaveBeenCalledWith([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ]);
    expect(mockSerializeConversation).toHaveBeenCalled();

    expect(mockStartSubagentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "summarize",
        contextText: "User: Hello\nAssistant: Hi there",
      }),
    );

    expect(jobRegistry.has("default-job")).toBe(true);
    expect(jobRegistry.get("default-job")!.notifyOnComplete).toBe("inject");
  });

  it("uses notify mode when notifyOnComplete is 'notify'", async () => {
    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      { task: "test", async: true, notifyOnComplete: "notify" },
      undefined,
      undefined,
      ctx,
    );

    expect(jobRegistry.get("default-job")!.notifyOnComplete).toBe("notify");
  });

  it("includes modelWarning in async response when present", async () => {
    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");

    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      modelWarning: "Model not found, using default",
    });

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    const result = await toolDef.execute(
      "call-1",
      { task: "test", async: true },
      undefined,
      undefined,
      ctx,
    );

    expect(result.content[0].text).toContain("Model not found");
  });

  it("delivers notification when async job completes successfully", async () => {
    let resolveJob!: (v: SubagentResult) => void;
    const deferred = new Promise<SubagentResult>((r) => {
      resolveJob = r;
    });

    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");

    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      { task: "test", async: true },
      undefined,
      undefined,
      ctx,
    );

    resolveJob(defaultSuccessResult);
    // Flush microtask queue so the .then handler runs
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const job = jobRegistry.get("default-job")!;
    expect(job.status).toBe("done");
    expect(mockDeliverNotification).toHaveBeenCalled();
  });

  it("does not deliver notification when job is cancelled before completion", async () => {
    let resolveJob!: (v: SubagentResult) => void;
    const deferred = new Promise<SubagentResult>((r) => {
      resolveJob = r;
    });

    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");

    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      { task: "test", async: true },
      undefined,
      undefined,
      ctx,
    );

    // Cancel the job before the promise resolves
    const job = jobRegistry.get("default-job")!;
    job.status = "cancelled";

    resolveJob(defaultSuccessResult);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockDeliverNotification).not.toHaveBeenCalled();
  });

  it("delivers notification on job promise rejection", async () => {
    let rejectJob!: (err: Error) => void;
    const deferred = new Promise<SubagentResult>((_, reject) => {
      rejectJob = reject;
    });
    // Suppress unhandled rejection warning
    deferred.catch(() => {});

    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");

    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });

    await toolDef.execute(
      "call-1",
      { task: "test", async: true },
      undefined,
      undefined,
      ctx,
    );

    rejectJob(new Error("LLM crash"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(mockDeliverNotification).toHaveBeenCalled();
  });
});

describe("async rejection settlement", () => {
  async function flushPromiseHandlers(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  it("settles rejected subagent_with_context jobs for status and result tools", async () => {
    let rejectJob!: (error: Error) => void;
    const deferred = new Promise<SubagentResult>((_, reject) => {
      rejectJob = reject;
    });
    deferred.catch(() => {});
    mockConvertToLlm.mockReturnValue([{ role: "user", content: "Hi" }]);
    mockSerializeConversation.mockReturnValue("Hi");
    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const api = setupExtension();
    const ctx = mockCtx({
      sessionManager: {
        getBranch: vi
          .fn()
          .mockReturnValue([
            { type: "message", message: { role: "user", content: "Hi" } },
          ]),
        getSessionId: vi.fn().mockReturnValue("test-session"),
      },
    });
    const startTool = getToolDef(api, "subagent_with_context");
    await startTool.execute(
      "call-1",
      { task: "test", async: true, notifyOnComplete: "inject" },
      undefined,
      undefined,
      ctx,
    );

    rejectJob(new Error("context crash"));
    await flushPromiseHandlers();

    const job = jobRegistry.get("default-job")!;
    expect(job.status).toBe("error");
    expect(job.result).toEqual(
      expect.objectContaining({
        isError: true,
        output: "Sub-agent crashed: context crash",
        errorMessage: "context crash",
      }),
    );
    expect(mockScheduleJobCleanup).toHaveBeenCalledWith(
      "default-job",
      false,
      undefined,
      undefined,
    );
    expect(mockDeliverNotification).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "subagentura-running",
      undefined,
    );

    const status = await getToolDef(api, "get_subagent_status").execute(
      "status-call",
      { jobId: "default-job" },
      undefined,
      undefined,
      ctx,
    );
    expect(status.details.status).toBe("error");
    expect(status.isError).toBe(true);

    const result = await getToolDef(api, "get_subagent_result").execute(
      "result-call",
      { jobId: "default-job" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Sub-agent failed: context crash");
    expect(result.details.status).toBe("error");
    expect(result.isError).toBe(true);
  });

  it("settles rejected subagent_isolated jobs as structured errors", async () => {
    let rejectJob!: (error: Error) => void;
    const deferred = new Promise<SubagentResult>((_, reject) => {
      rejectJob = reject;
    });
    deferred.catch(() => {});
    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const api = setupExtension();
    const ctx = mockCtx();
    await getToolDef(api, "subagent_isolated").execute(
      "call-1",
      { task: "test", async: true, notifyOnComplete: "notify" },
      undefined,
      undefined,
      ctx,
    );

    rejectJob(new Error("isolated crash"));
    await flushPromiseHandlers();

    const job = jobRegistry.get("default-job")!;
    expect(job.status).toBe("error");
    expect(job.result).toEqual(
      expect.objectContaining({
        isError: true,
        output: "Sub-agent crashed: isolated crash",
        errorMessage: "isolated crash",
      }),
    );
    expect(mockScheduleJobCleanup).toHaveBeenCalledWith(
      "default-job",
      false,
      undefined,
      undefined,
    );
    expect(mockDeliverNotification).toHaveBeenCalledTimes(1);

    const result = await getToolDef(api, "get_subagent_result").execute(
      "result-call",
      { jobId: "default-job" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toBe("Sub-agent failed: isolated crash");
    expect(result.details.status).toBe("error");
    expect(result.isError).toBe(true);
  });

  it("keeps a cancelled job cancelled when its promise rejects", async () => {
    let rejectJob!: (error: Error) => void;
    const deferred = new Promise<SubagentResult>((_, reject) => {
      rejectJob = reject;
    });
    deferred.catch(() => {});
    mockStartSubagentJob.mockResolvedValue({
      ...defaultStartSubagentJobResult,
      jobPromise: deferred,
    });

    const api = setupExtension();
    const ctx = mockCtx();
    await getToolDef(api, "subagent_isolated").execute(
      "call-1",
      { task: "test", async: true, notifyOnComplete: "inject" },
      undefined,
      undefined,
      ctx,
    );
    jobRegistry.get("default-job")!.status = "cancelled";

    rejectJob(new Error("cancelled crash"));
    await flushPromiseHandlers();

    const job = jobRegistry.get("default-job")!;
    expect(job.status).toBe("cancelled");
    expect(job.result).toBeUndefined();
    expect(mockDeliverNotification).not.toHaveBeenCalled();
  });
});
