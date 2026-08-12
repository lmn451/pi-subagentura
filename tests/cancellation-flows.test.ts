/**
 * Regression tests for cancellation flow improvements.
 *
 * Covers:
 * 1. get_subagent_result abort-aware wait (Escape cancels wait, not job)
 * 2. get_workflow_result abort-aware wait (Escape cancels wait, not workflow)
 * 3. cancelAllFlows helper (shared cancel-all logic)
 * 4. resultRetrieved NOT set when wait is aborted
 * 5. shortcut and command registration
 * 6. abortableWait shared helper
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockStartSubagentJob,
  mockDebugLog,
  mockFormatUsage,
  mockBuildLiveUpdate,
} = vi.hoisted(() => ({
  mockStartSubagentJob: vi.fn(),
  mockDebugLog: vi.fn(),
  mockFormatUsage: vi.fn().mockReturnValue("mock-usage"),
  mockBuildLiveUpdate: vi.fn().mockReturnValue({
    content: [{ type: "text", text: "" }],
    details: {},
  }),
}));

const { mockConvertToLlm, mockSerializeConversation } = vi.hoisted(() => ({
  mockConvertToLlm: vi.fn().mockReturnValue([]),
  mockSerializeConversation: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return {
    ...actual,
    startSubagentJob: mockStartSubagentJob,
    debugLog: mockDebugLog,
    formatUsage: mockFormatUsage,
    buildLiveUpdate: mockBuildLiveUpdate,
  };
});

vi.mock("../src/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications")>();
  return { ...actual, deliverNotification: vi.fn() };
});

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    interactiveSubagentRegistry: new Map(),
    isTmuxAvailable: () => false,
    cancelInteractiveSubagent: vi.fn().mockReturnValue(undefined),
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

// ── Imports ────────────────────────────────────────────────────────────

import type { JobState, SubagentResult } from "../src/helpers";
import {
  jobRegistry,
  registerInProcessJob,
  scheduleJobCleanup,
} from "../src/helpers";
import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { abortableWait } from "../src/abortable-wait";
import { deliverNotification } from "../src/notifications";
import {
  interactiveSubagentRegistry,
  cancelInteractiveSubagent,
} from "../src/interactive-tmux";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";

// ── Helpers ────────────────────────────────────────────────────────────

function mockCtx(overrides: Record<string, any> = {}) {
  return {
    cwd: "/tmp/test",
    model: undefined,
    modelRegistry: undefined,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "test-session",
    },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    ...overrides,
  };
}

function createJobState(
  overrides: Partial<JobState> & { id: string },
): JobState {
  return {
    status: "running",
    liveStatus: {
      turn: 1,
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
      output: "test output",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: false,
    } as SubagentResult),
    ...overrides,
  };
}

function setupExtension() {
  const registeredTools: Record<string, any> = {};
  const api = {
    registerTool: (tool: any) => {
      registeredTools[tool.name] = tool;
    },
  };
  registerInProcessSubagentTools(api as any);
  return { api, registeredTools };
}

function getToolDef(api: ReturnType<typeof setupExtension>, name: string) {
  return api.registeredTools[name];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("abortableWait shared helper", () => {
  it("returns value when promise resolves before signal", async () => {
    const result = await abortableWait(
      Promise.resolve("hello"),
      new AbortController().signal,
    );
    expect(result).toEqual({ aborted: false, value: "hello" });
  });

  it("returns aborted when signal fires before promise resolves", async () => {
    const ac = new AbortController();
    const never = new Promise<string>(() => {});
    const p = abortableWait(never, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const result = await p;
    expect(result.aborted).toBe(true);
  });

  it("returns aborted when signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await abortableWait(Promise.resolve("x"), ac.signal);
    expect(result.aborted).toBe(true);
  });

  it("passes through non-abort errors", async () => {
    const err = new Error("real error");
    await expect(
      abortableWait(Promise.reject(err), new AbortController().signal),
    ).rejects.toThrow("real error");
  });

  it("propagates an underlying AbortError rejection", async () => {
    const err = new DOMException("underlying failure", "AbortError");
    await expect(
      abortableWait(Promise.reject(err), new AbortController().signal),
    ).rejects.toBe(err);
  });

  it("cleans up abort listener after normal completion", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    await abortableWait(Promise.resolve("ok"), ac.signal);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("get_subagent_result abort-aware wait", () => {
  let api: ReturnType<typeof setupExtension>;
  let toolDef: ReturnType<typeof getToolDef>;

  beforeEach(() => {
    vi.clearAllMocks();
    jobRegistry.clear();
    api = setupExtension();
    toolDef = getToolDef(api, "get_subagent_result");
  });

  it("returns wait_cancelled when signal is already aborted", async () => {
    const jobId = "pre-aborted";
    const job = createJobState({
      id: jobId,
      promise: new Promise<SubagentResult>(() => {}), // never resolves
    });
    jobRegistry.set(jobId, job);

    const ac = new AbortController();
    ac.abort(); // pre-aborted

    const result = await toolDef.execute(
      "call-1",
      { jobId, wait: true },
      ac.signal,
      undefined,
      mockCtx(),
    );

    expect(result.content[0].text).toMatch(/cancelled/i);
    expect(result.details.status).toBe("wait_cancelled");
    // resultRetrieved should NOT be set when wait is aborted
    expect(job.resultRetrieved).toBeFalsy();
  });

  it("returns wait_cancelled when signal fires during wait", async () => {
    const jobId = "abort-during-wait";
    let resolveJob!: (value: SubagentResult) => void;
    const deferred = new Promise<SubagentResult>((resolve) => {
      resolveJob = resolve;
    });

    const job = createJobState({ id: jobId, promise: deferred });
    jobRegistry.set(jobId, job);

    const ac = new AbortController();

    // Start the tool call
    const toolPromise = toolDef.execute(
      "call-1",
      { jobId, wait: true },
      ac.signal,
      undefined,
      mockCtx(),
    );

    // Fire abort after a tick
    setTimeout(() => ac.abort(), 10);

    const result = await toolPromise;

    expect(result.content[0].text).toMatch(/cancelled/i);
    expect(result.details.status).toBe("wait_cancelled");

    // The job promise should still be pending — we did NOT cancel the job
    expect(job.status).toBe("running");

    // Resolve the deferred to avoid unhandled rejection
    resolveJob({
      output: "ignored",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: false,
    });
  });

  it("does NOT set resultRetrieved when wait is aborted", async () => {
    const jobId = "no-result-retrieved";
    const job = createJobState({
      id: jobId,
      promise: new Promise<SubagentResult>(() => {}),
    });
    jobRegistry.set(jobId, job);

    const ac = new AbortController();
    ac.abort();

    await toolDef.execute(
      "call-1",
      { jobId, wait: true },
      ac.signal,
      undefined,
      mockCtx(),
    );

    // Key invariant: resultRetrieved must be false when wait is aborted
    expect(job.resultRetrieved).toBeFalsy();
  });

  it("cleans up abort listener after normal completion", async () => {
    const jobId = "clean-listener";
    const job = createJobState({
      id: jobId,
      promise: Promise.resolve({
        output: "done",
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
    });
    jobRegistry.set(jobId, job);

    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    await toolDef.execute(
      "call-1",
      { jobId, wait: true },
      ac.signal,
      undefined,
      mockCtx(),
    );

    // After normal completion, the abort listener should be removed
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(job.resultRetrieved).toBe(true);
  });

  it("marks an active result wait before settlement notification", async () => {
    const jobId = "active-result-wait";
    let resolveJob!: (value: SubagentResult) => void;
    const jobPromise = new Promise<SubagentResult>((resolve) => {
      resolveJob = resolve;
    });
    mockStartSubagentJob.mockResolvedValue({
      jobId,
      jobPromise,
      session: { abort: vi.fn() },
      liveStatus: createJobState({ id: jobId }).liveStatus,
      modelLabel: "test/model",
    });
    const spawnTool = getToolDef(api, "subagent_isolated");
    await spawnTool.execute(
      "spawn-call",
      { task: "test", async: true, notifyOnComplete: "inject" },
      undefined,
      undefined,
      mockCtx(),
    );
    const wait = toolDef.execute(
      "result-call",
      { jobId, wait: true },
      new AbortController().signal,
      undefined,
      mockCtx(),
    );

    resolveJob({
      output: "done",
      usage: createJobState({ id: jobId }).liveStatus.usage,
      isError: false,
    });
    await wait;

    expect(deliverNotification).not.toHaveBeenCalled();
    expect(jobRegistry.get(jobId)?.resultRetrieved).toBe(true);
  });
});

describe("get_workflow_result abort-aware wait", () => {
  // These tests import workflow-tool lazily to avoid side effects

  it("returns wait_cancelled when signal is already aborted", async () => {
    const { workflowJobRegistry } = await import("../src/workflow-jobs");
    const { registerWorkflowTool } = await import("../src/workflow-tool");

    const registeredTools: Record<string, any> = {};
    const api = {
      registerTool: (tool: any) => {
        registeredTools[tool.name] = tool;
      },
    };
    registerWorkflowTool(api as any);
    const toolDef = registeredTools["get_workflow_result"];

    workflowJobRegistry.set("wf-test-1", {
      id: "wf-test-1",
      kind: "script",
      status: "running",
      promise: new Promise(() => {}), // never resolves
      abort: new AbortController(),
    } as any);

    const ac = new AbortController();
    ac.abort();

    const result = await toolDef.execute(
      "call-1",
      { workflowId: "wf-test-1" },
      ac.signal,
    );

    expect(result.content[0].text).toMatch(/cancelled/i);
    expect(result.details.status).toBe("wait_cancelled");

    workflowJobRegistry.delete("wf-test-1");
  });

  it("returns wait_cancelled when signal fires during wait", async () => {
    const { workflowJobRegistry } = await import("../src/workflow-jobs");
    const { registerWorkflowTool } = await import("../src/workflow-tool");

    const registeredTools: Record<string, any> = {};
    const api = {
      registerTool: (tool: any) => {
        registeredTools[tool.name] = tool;
      },
    };
    registerWorkflowTool(api as any);
    const toolDef = registeredTools["get_workflow_result"];

    let resolveWf!: (value: any) => void;
    const deferred = new Promise((resolve) => {
      resolveWf = resolve;
    });

    workflowJobRegistry.set("wf-test-2", {
      id: "wf-test-2",
      kind: "script",
      status: "running",
      promise: deferred,
      abort: new AbortController(),
    } as any);

    const ac = new AbortController();
    const toolPromise = toolDef.execute(
      "call-1",
      { workflowId: "wf-test-2" },
      ac.signal,
    );

    setTimeout(() => ac.abort(), 10);

    const result = await toolPromise;

    expect(result.content[0].text).toMatch(/cancelled/i);
    expect(result.details.status).toBe("wait_cancelled");

    // Resolve to avoid unhandled rejection
    resolveWf({
      result: "ignored",
      meta: { name: "test" },
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    });
    workflowJobRegistry.delete("wf-test-2");
  });

  it("returns structured error for non-abort promise rejection", async () => {
    const { workflowJobRegistry } = await import("../src/workflow-jobs");
    const { registerWorkflowTool } = await import("../src/workflow-tool");

    const registeredTools: Record<string, any> = {};
    const api = {
      registerTool: (tool: any) => {
        registeredTools[tool.name] = tool;
      },
    };
    registerWorkflowTool(api as any);
    const toolDef = registeredTools["get_workflow_result"];

    workflowJobRegistry.set("wf-test-3", {
      id: "wf-test-3",
      kind: "script",
      status: "error",
      promise: Promise.reject(new DOMException("worker crashed", "AbortError")),
      abort: new AbortController(),
    } as any);

    const result = await toolDef.execute("call-1", { workflowId: "wf-test-3" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/worker crashed/);
    expect(result.details.error).toBe("worker crashed");

    workflowJobRegistry.delete("wf-test-3");
  });
});

describe("cancelAllFlows helper", () => {
  beforeEach(() => {
    jobRegistry.clear();
    clearSessionScopes();
    vi.clearAllMocks();
  });

  it("aborts all running in-process jobs and sets status to cancelled", async () => {
    const { cancelAllFlows } = await import("../src/cancel-all-flows");

    const abort1 = vi.fn().mockResolvedValue(undefined);
    const abort2 = vi.fn().mockResolvedValue(undefined);

    jobRegistry.set("job-1", {
      id: "job-1",
      status: "running",
      session: { abort: abort1 },
    } as any);
    jobRegistry.set("job-2", {
      id: "job-2",
      status: "running",
      session: { abort: abort2 },
    } as any);
    jobRegistry.set("job-3", {
      id: "job-3",
      status: "done",
      session: { abort: vi.fn() },
    } as any);

    const result = await cancelAllFlows();

    expect(abort1).toHaveBeenCalledOnce();
    expect(abort2).toHaveBeenCalledOnce();
    expect(result.jobsAborted).toBe(2);

    // Verify status was set to cancelled (matching per-ID cancel semantics)
    expect(jobRegistry.get("job-1")!.status).toBe("cancelled");
    expect(jobRegistry.get("job-2")!.status).toBe("cancelled");
    // Done job should be untouched
    expect(jobRegistry.get("job-3")!.status).toBe("done");
  });

  it("aborts all running workflows and sets status to cancelled", async () => {
    const { cancelAllFlows } = await import("../src/cancel-all-flows");
    const { workflowJobRegistry } = await import("../src/workflow-jobs");

    const abortCtrl1 = new AbortController();
    const abortCtrl2 = new AbortController();

    workflowJobRegistry.set("wf-1", {
      id: "wf-1",
      kind: "script",
      status: "running",
      abort: abortCtrl1,
    } as any);
    workflowJobRegistry.set("wf-2", {
      id: "wf-2",
      kind: "script",
      status: "running",
      abort: abortCtrl2,
    } as any);
    workflowJobRegistry.set("wf-3", {
      id: "wf-3",
      kind: "script",
      status: "done",
      abort: new AbortController(),
    } as any);

    const result = await cancelAllFlows();

    expect(abortCtrl1.signal.aborted).toBe(true);
    expect(abortCtrl2.signal.aborted).toBe(true);
    expect(result.workflowsAborted).toBe(2);

    // Verify status was set to cancelled
    expect(workflowJobRegistry.get("wf-1")!.status).toBe("cancelled");
    expect(workflowJobRegistry.get("wf-2")!.status).toBe("cancelled");
    expect(workflowJobRegistry.get("wf-3")!.status).toBe("done");
    expect(
      workflowJobRegistry.get("wf-1")!.suppressCompletionNotification,
    ).toBe(true);
    expect(
      workflowJobRegistry.get("wf-2")!.suppressCompletionNotification,
    ).toBe(true);

    workflowJobRegistry.clear();
  });

  it("kills running and unknown interactive agents while preserving idle ones", async () => {
    const { cancelAllFlows } = await import("../src/cancel-all-flows");

    // Setup mock to return a state for running-1 (successful cancellation)
    vi.mocked(cancelInteractiveSubagent).mockImplementation((id: string) => {
      if (id === "running-1" || id === "unknown-1") {
        return { id, status: "cancelled" } as any;
      }
      return undefined;
    });

    // Add states directly to the real registry
    interactiveSubagentRegistry.set("running-1", {
      id: "running-1",
      status: "running",
      paneId: "pane-1",
      mux: "tmux",
      artifactDir: "/tmp/art1",
    } as any);
    interactiveSubagentRegistry.set("unknown-1", {
      id: "unknown-1",
      status: "unknown",
      paneId: "pane-unknown",
      mux: "tmux",
      artifactDir: "/tmp/art-unknown",
    } as any);
    interactiveSubagentRegistry.set("idle-1", {
      id: "idle-1",
      status: "idle",
      paneId: "pane-2",
      mux: "tmux",
      artifactDir: "/tmp/art2",
    } as any);

    const result = await cancelAllFlows();

    // Verify cancelInteractiveSubagent was called for running agent
    expect(cancelInteractiveSubagent).toHaveBeenCalledWith(
      "running-1",
      "cancel_all",
      expect.objectContaining({ id: "running-1" }),
    );
    expect(cancelInteractiveSubagent).toHaveBeenCalledWith(
      "unknown-1",
      "cancel_all",
      expect.objectContaining({ id: "unknown-1" }),
    );
    // Running and unknown can both be active; idle remains preserved.
    expect(result.interactiveKilled).toBe(2);
    expect(result.interactivePreserved).toBe(1);

    // Clean up
    interactiveSubagentRegistry.clear();
    vi.mocked(cancelInteractiveSubagent).mockReset();
  });

  it("returns zero counts when nothing is running", async () => {
    jobRegistry.clear();
    const { workflowJobRegistry } = await import("../src/workflow-jobs");
    workflowJobRegistry.clear();

    const { cancelAllFlows } = await import("../src/cancel-all-flows");
    const result = await cancelAllFlows();

    expect(result.jobsAborted).toBe(0);
    expect(result.workflowsAborted).toBe(0);
    expect(result.interactiveKilled).toBe(0);
  });

  it("cancels only in-process and interactive flows owned by the caller", async () => {
    const { cancelAllFlows } = await import("../src/cancel-all-flows");
    const ownerA = { id: 101, generation: 1 };
    const ownerB = { id: 202, generation: 1 };
    clearSessionScopes();
    const scopeA = registerSessionScope({
      ...ownerA,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-a" },
    });
    const scopeB = registerSessionScope({
      ...ownerB,
      pi: {} as any,
      sessionManager: { getSessionId: () => "session-b" },
    });
    const abortA = vi.fn();
    const abortB = vi.fn();
    const jobA = {
      id: "job-a",
      status: "running",
      session: { abort: abortA },
      deliveryOwner: {
        pi: {} as any,
        sessionScopeId: ownerA.id,
        sessionScopeGeneration: ownerA.generation,
      },
    } as any;
    registerInProcessJob(jobA, ownerA);
    const jobB = {
      id: "job-b",
      status: "running",
      session: { abort: abortB },
      deliveryOwner: {
        pi: {} as any,
        sessionScopeId: ownerB.id,
        sessionScopeGeneration: ownerB.generation,
      },
    } as any;
    registerInProcessJob(jobB, ownerB);
    interactiveSubagentRegistry.set("interactive-a", {
      id: "interactive-a",
      status: "running",
      parentSessionId: "session-a",
    } as any);
    interactiveSubagentRegistry.set("interactive-b", {
      id: "interactive-b",
      status: "running",
      parentSessionId: "session-b",
    } as any);
    scopeA.interactiveStates.set(
      "interactive-a",
      interactiveSubagentRegistry.get("interactive-a")!,
    );
    scopeB.interactiveStates.set(
      "interactive-b",
      interactiveSubagentRegistry.get("interactive-b")!,
    );
    vi.mocked(cancelInteractiveSubagent).mockImplementation((id: string) =>
      interactiveSubagentRegistry.get(id),
    );

    const result = await cancelAllFlows(ownerB);

    expect(abortA).not.toHaveBeenCalled();
    expect(abortB).toHaveBeenCalledOnce();
    expect(cancelInteractiveSubagent).toHaveBeenCalledWith(
      "interactive-b",
      "cancel_all",
      scopeB.interactiveStates.get("interactive-b"),
    );
    expect(
      vi.mocked(cancelInteractiveSubagent).mock.calls.map(([id]) => id),
    ).not.toContain("interactive-a");
    expect(result.jobsAborted).toBe(1);
    expect(result.interactiveKilled).toBe(1);
    clearSessionScopes();
  });
});

describe("shortcut and command registration", () => {
  it("registers ctrl+alt+x shortcut and /cancel-all-flows command", async () => {
    const { registerCancelAllFlows } =
      await import("../src/cancel-all-flows-registration");

    const shortcuts: Record<string, any> = {};
    const commands: Record<string, any> = {};
    const mockAbort = vi.fn();

    const api = {
      registerShortcut: (key: string, opts: any) => {
        shortcuts[key] = opts;
      },
      registerCommand: (name: string, opts: any) => {
        commands[name] = opts;
      },
    };

    registerCancelAllFlows(api as any);

    expect(shortcuts["ctrl+alt+x"]).toBeDefined();
    expect(commands["cancel-all-flows"]).toBeDefined();
    expect(shortcuts["ctrl+alt+x"].description).toMatch(/cancel/i);
    expect(commands["cancel-all-flows"].description).toMatch(/cancel/i);
  });

  it("calls ctx.abort() before awaiting child cancellation", async () => {
    const { registerCancelAllFlows } =
      await import("../src/cancel-all-flows-registration");
    const cancelAllFlowsModule = await import("../src/cancel-all-flows");
    const events: string[] = [];
    let shortcutHandler: any;
    let commandHandler: any;

    const api = {
      registerShortcut: (_key: string, opts: any) => {
        shortcutHandler = opts.handler;
      },
      registerCommand: (_name: string, opts: any) => {
        commandHandler = opts.handler;
      },
    };
    registerCancelAllFlows(api as any);

    const result = {
      jobsAborted: 1,
      workflowsAborted: 0,
      interactiveKilled: 0,
      interactivePreserved: 0,
    };
    const cancelSpy = vi.spyOn(cancelAllFlowsModule, "cancelAllFlows");
    const mockNotify = vi.fn();
    const mockAbort = vi.fn(() => events.push("abort"));
    const ctx = { ui: { notify: mockNotify }, abort: mockAbort };

    let resolveCancellation!: (value: typeof result) => void;
    const pendingCancellation = new Promise<typeof result>((resolve) => {
      resolveCancellation = resolve;
    });
    cancelSpy.mockImplementationOnce(() => {
      events.push("cancel-start");
      return pendingCancellation;
    });

    const shortcutPromise = shortcutHandler(ctx);
    expect(events).toEqual(["abort", "cancel-start"]);
    resolveCancellation(result);
    await shortcutPromise;

    events.length = 0;
    let resolveCommandCancellation!: (value: typeof result) => void;
    const pendingCommandCancellation = new Promise<typeof result>((resolve) => {
      resolveCommandCancellation = resolve;
    });
    cancelSpy.mockImplementationOnce(() => {
      events.push("cancel-start");
      return pendingCommandCancellation;
    });

    const commandPromise = commandHandler("", ctx);
    expect(events).toEqual(["abort", "cancel-start"]);
    resolveCommandCancellation(result);
    await commandPromise;
  });
});
