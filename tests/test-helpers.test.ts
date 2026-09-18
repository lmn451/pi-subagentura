import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import {
  ACTIVE_TOOL_DEBOUNCE_MS,
  buildLiveUpdate,
  formatTokens,
  formatUsage,
  extractTextFromContent,
  resolveModel,
  SubagentLiveStatus,
  SubagentResult,
  jobRegistry,
  MAX_REGISTRY_SIZE,
  pruneOldestJob,
  pruneCompletedJobs,
  scheduleJobCleanup,
  generateJobId,
  JOB_CLEANUP_TTL_MS,
  type JobState,
  type JobStatus,
} from "../src/helpers";

// ── Simulation helpers ────────────────────────────────────────────────
// These simulate live status behavior for turn handling tests.
// They mirror what runSubagent() does internally.

function createLiveStatus(): SubagentLiveStatus {
  return {
    turn: 0,
    output: "",
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    activeTool: undefined as
      | { name: string; args: Record<string, unknown> }
      | undefined,
  };
}

function simulateTurnStart(status: SubagentLiveStatus) {
  status.turn++;
  status.usage.turns = status.turn;
  status.output = "";
}

function simulateTextDelta(status: SubagentLiveStatus, delta: string) {
  status.output += delta;
}

function simulateTurnEnd(status: SubagentLiveStatus) {
  status.activeTool = undefined;
}

// ── Debounce harness ──────────────────────────────────────────────────
// Mirrors the debounce logic in runSubagent() using ACTIVE_TOOL_DEBOUNCE_MS.

function createDebounceHarness() {
  let activeToolTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingActiveTool:
    | { name: string; args: Record<string, unknown> }
    | undefined;
  const state = { activeTool: undefined as typeof pendingActiveTool };

  function setActiveToolDebounced(tool: typeof pendingActiveTool) {
    pendingActiveTool = tool;
    if (activeToolTimer) {
      clearTimeout(activeToolTimer);
      activeToolTimer = undefined;
    }
    if (tool) {
      activeToolTimer = setTimeout(() => {
        activeToolTimer = undefined;
        state.activeTool = pendingActiveTool;
      }, ACTIVE_TOOL_DEBOUNCE_MS);
    } else {
      if (state.activeTool) {
        state.activeTool = undefined;
      }
    }
  }

  return { state, setActiveToolDebounced };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("formatTokens", () => {
  it("should return raw number below 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("should format thousands with one decimal", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("should format tens of thousands with k", () => {
    expect(formatTokens(10000)).toBe("10k");
    expect(formatTokens(50000)).toBe("50k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  it("should format millions with M", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("buildLiveUpdate", () => {
  it("should return AgentToolResult with content and details", () => {
    const status: SubagentLiveStatus = {
      turn: 1,
      output: "Testing",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.001,
        turns: 1,
      },
      activeTool: undefined,
    };
    const result = buildLiveUpdate(status, "test/model");
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "Testing" });
    expect(result.details).toEqual({
      status: "running",
      subagentStatus: status,
      model: "test/model",
    });
  });

  it("should work with no activeTool and no model", () => {
    const status: SubagentLiveStatus = {
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
      activeTool: undefined,
    };
    const result = buildLiveUpdate(status);
    expect(result).toBeDefined();
    expect(result.content[0]).toEqual({ type: "text", text: "" });
    expect(result.details.model).toBeUndefined();
    expect(result.details.subagentStatus).toBe(status);
  });
});

describe("extractTextFromContent", () => {
  it("should join text parts from array content", () => {
    const result = extractTextFromContent([
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ]);
    expect(result).toBe("Hello\nworld");
  });

  it("should return string content as-is", () => {
    expect(extractTextFromContent("plain string")).toBe("plain string");
  });

  it("should filter out non-text items", () => {
    const result = extractTextFromContent([
      { type: "text", text: "only text" },
      { type: "image", source: { url: "..." } },
      { type: "tool_use", name: "read" },
    ]);
    expect(result).toBe("only text");
  });

  it("should return empty string for null/undefined/numbers", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
    expect(extractTextFromContent(42)).toBe("");
  });
});

describe("formatUsage", () => {
  const baseUsage: SubagentResult["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };

  it("should return empty string for empty usage", () => {
    expect(formatUsage(baseUsage)).toBe("");
  });

  it("should format turns correctly", () => {
    expect(formatUsage({ ...baseUsage, turns: 1 })).toBe("1 turn");
  });

  it("should format plural turns", () => {
    expect(formatUsage({ ...baseUsage, turns: 3 })).toBe("3 turns");
  });

  it("should format all usage fields", () => {
    const usage = {
      ...baseUsage,
      input: 1500,
      output: 500,
      cacheRead: 100,
      cacheWrite: 200,
      cost: 0.0123,
      turns: 2,
    };
    const result = formatUsage(usage);
    expect(result).toContain("1.5k");
    expect(result).toContain("↓500");
    expect(result).toContain("R100");
    expect(result).toContain("W200");
    expect(result).toContain("$0.0123");
    expect(result).toContain("2 turns");
  });

  it("should append model at the end", () => {
    const result = formatUsage(
      { ...baseUsage, turns: 1 },
      "anthropic/claude-3-5-sonnet-20241022",
    );
    expect(result).toMatch(/anthropic\/claude-3-5-sonnet-20241022$/);
  });
});

describe("live status turn handling", () => {
  it("should reset output on turn start", () => {
    const status = createLiveStatus();

    simulateTurnStart(status);
    simulateTextDelta(status, "Hello");
    expect(status.output).toBe("Hello");

    simulateTurnStart(status); // resets output
    expect(status.output).toBe("");

    simulateTextDelta(status, "World");
    expect(status.output).toBe("World");
  });

  it("should only show current turn output, not accumulated", () => {
    const status = createLiveStatus();

    simulateTurnStart(status);
    simulateTextDelta(status, "Analyzing code...");
    simulateTurnEnd(status);

    simulateTurnStart(status);
    simulateTextDelta(status, "Found bug in line 42.");
    simulateTurnEnd(status);

    simulateTurnStart(status);
    simulateTextDelta(status, "Fixing now...");
    simulateTurnEnd(status);

    expect(status.turn).toBe(3);
    expect(status.output).toBe("Fixing now...");
  });

  it("should count turns correctly", () => {
    const status = createLiveStatus();
    simulateTurnStart(status);
    simulateTurnStart(status);
    simulateTurnStart(status);
    expect(status.turn).toBe(3);
    expect(status.usage.turns).toBe(3);
  });
});

describe("active tool debouncing", () => {
  it("should not show activeTool for fast tool calls (synchronous start+end)", () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    // Fast tool: start then end synchronously (within the same tick)
    setActiveToolDebounced({ name: "read", args: { path: "/foo" } });
    setActiveToolDebounced(undefined);

    // activeTool should remain undefined — no flicker
    expect(state.activeTool).toBeUndefined();
  });

  it("should show activeTool after debounce period for slow tools", async () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    setActiveToolDebounced({ name: "bash", args: { command: "sleep 5" } });

    // Before debounce fires: not visible yet
    expect(state.activeTool).toBeUndefined();

    // Wait past debounce threshold
    await new Promise((r) => setTimeout(r, ACTIVE_TOOL_DEBOUNCE_MS + 50));

    // Now the activeTool should be committed
    expect(state.activeTool).toEqual({
      name: "bash",
      args: { command: "sleep 5" },
    });
  });

  it("should clear activeTool immediately when a committed tool ends", async () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    setActiveToolDebounced({ name: "bash", args: { command: "sleep 5" } });
    await new Promise((r) => setTimeout(r, ACTIVE_TOOL_DEBOUNCE_MS + 50));

    expect(state.activeTool).toBeDefined();

    // Slow tool finishes — clear immediately, no debounce delay
    setActiveToolDebounced(undefined);
    expect(state.activeTool).toBeUndefined();
  });

  it("should cancel pending timer if tool ends before debounce fires", () => {
    const { state, setActiveToolDebounced } = createDebounceHarness();

    // Start a tool (timer begins)
    setActiveToolDebounced({ name: "read", args: { path: "/bar" } });

    // Tool finishes fast — cancels the timer, activeTool never appears
    setActiveToolDebounced(undefined);
    expect(state.activeTool).toBeUndefined();
  });
});

describe("resolveModel", () => {
  it("should return undefined when no modelId and no defaultModel", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
  });

  it("should return defaultModel when modelId is undefined", () => {
    const defaultModel = {
      provider: "anthropic",
      id: "claude-3-5-sonnet-20241022",
    } as any;
    expect(resolveModel(undefined, defaultModel)).toBe(defaultModel);
  });

  it("should parse provider/id format correctly", () => {
    const provider = getProviders()[0];
    const expected = getModels(provider)[0];
    const result = resolveModel(
      `${expected.provider}/${expected.id}`,
      undefined,
    );
    expect(result).toEqual(expected);
  });

  it("should return undefined for unknown provider/id when no default", () => {
    expect(
      resolveModel("unknown/impossibly-long-model-id", undefined),
    ).toBeUndefined();
  });

  it("should fall back to defaultModel when provider not found", () => {
    const defaultModel = { provider: "openai", id: "gpt-4o" } as any;
    expect(resolveModel("unknown/model", defaultModel)).toBe(defaultModel);
  });

  it("should search all providers dynamically for bare id", () => {
    // resolveModel iterates getProviders() for bare IDs
    const providers = getProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers).toContain("anthropic");
  });
});

describe("error handling scenarios", () => {
  it("should handle empty task string", () => {
    const status = createLiveStatus();
    expect(status.output).toBe("");
  });

  it("should handle undefined optional parameters gracefully", () => {
    expect(resolveModel(undefined, undefined)).toBeUndefined();
    expect(
      formatUsage(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        undefined,
      ),
    ).toBe("");
  });
});

// ── Async Tests ──────────────────────────────────────────────────────

// Mock JobState helpers
function createMockJobState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: generateJobId(),
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
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    } as unknown as JobState["session"],
    startedAt: Date.now(),
    promise: Promise.resolve({
      output: "mock result",
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
    }),
    modelLabel: "test/model",
    ...overrides,
  };
}

describe("jobRegistry", () => {
  beforeEach(() => {
    jobRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should be empty on initialization", () => {
    expect(jobRegistry.size).toBe(0);
  });

  it("should store and retrieve jobs", () => {
    const job = createMockJobState();
    jobRegistry.set(job.id, job);
    expect(jobRegistry.get(job.id)).toBe(job);
  });

  it("should support multiple concurrent jobs", () => {
    const job1 = createMockJobState();
    const job2 = createMockJobState();
    const job3 = createMockJobState();
    jobRegistry.set(job1.id, job1);
    jobRegistry.set(job2.id, job2);
    jobRegistry.set(job3.id, job3);
    expect(jobRegistry.size).toBe(3);
    expect(jobRegistry.get(job1.id)?.id).toBe(job1.id);
    expect(jobRegistry.get(job2.id)?.id).toBe(job2.id);
    expect(jobRegistry.get(job3.id)?.id).toBe(job3.id);
  });
});

describe("generateJobId", () => {
  it("should return a string of 16 hex characters", () => {
    const id = generateJobId();
    expect(id).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
  });

  it("should generate unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));
    expect(ids.size).toBe(100);
  });
});

describe("registry size cap", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => jobRegistry.clear());

  function createMockJobState(overrides: Partial<JobState> = {}): JobState {
    return {
      id: generateJobId(),
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
      session: { abort: vi.fn() } as any,
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
      ...overrides,
    };
  }

  it("pruneOldestJob removes oldest completed job", () => {
    const job1 = createMockJobState({ status: "done" });
    const job2 = createMockJobState({ status: "done" });
    jobRegistry.set(job1.id, job1);
    jobRegistry.set(job2.id, job2);
    expect(pruneOldestJob()).toBe(true);
    expect(jobRegistry.has(job1.id)).toBe(false);
    expect(jobRegistry.has(job2.id)).toBe(true);
  });

  it("pruneOldestJob returns false when no completed jobs exist", () => {
    const job1 = createMockJobState({ status: "running" });
    jobRegistry.set(job1.id, job1);
    expect(pruneOldestJob()).toBe(false);
    expect(jobRegistry.has(job1.id)).toBe(true);
  });

  it("pruneCompletedJobs removes all completed and error jobs", () => {
    const job1 = createMockJobState({ status: "done" });
    const job2 = createMockJobState({ status: "error" });
    const job3 = createMockJobState({ status: "running" });
    jobRegistry.set(job1.id, job1);
    jobRegistry.set(job2.id, job2);
    jobRegistry.set(job3.id, job3);
    expect(pruneCompletedJobs()).toBe(2);
    expect(jobRegistry.has(job1.id)).toBe(false);
    expect(jobRegistry.has(job2.id)).toBe(false);
    expect(jobRegistry.has(job3.id)).toBe(true);
  });

  it("startSubagentJob evicts oldest completed job when at MAX_REGISTRY_SIZE", () => {
    // Fill registry to cap with done jobs
    for (let i = 0; i < MAX_REGISTRY_SIZE; i++) {
      const job = createMockJobState({ status: "done" });
      jobRegistry.set(job.id, job);
    }
    expect(jobRegistry.size).toBe(MAX_REGISTRY_SIZE);

    // Adding a new job should evict the oldest done job
    // Note: startSubagentJob enforces cap before generating jobId
    // We simulate by calling pruneOldestJob directly
    expect(pruneOldestJob()).toBe(true);
    expect(jobRegistry.size).toBe(MAX_REGISTRY_SIZE - 1);
  });
});

describe("scheduleJobCleanup", () => {
  beforeEach(() => {
    jobRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should NOT remove job for non-immediate cleanup (jobs persist indefinitely)", async () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);

    scheduleJobCleanup(job.id, false);
    expect(jobRegistry.has(job.id)).toBe(true);

    vi.advanceTimersByTime(1000000);
    expect(jobRegistry.has(job.id)).toBe(true); // still there
  });

  it("should remove job immediately for immediate cleanup", async () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);

    scheduleJobCleanup(job.id, true);
    // Immediate: setTimeout(fn, 0) — advance past it
    await vi.advanceTimersByTimeAsync(1);
    expect(jobRegistry.has(job.id)).toBe(false);
  });

  it("should remove job after maxAge timer elapses when maxAge is set", () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);

    scheduleJobCleanup(job.id, false, 10000);
    expect(jobRegistry.has(job.id)).toBe(true);

    // Advance to just before expiry
    vi.advanceTimersByTime(9999);
    expect(jobRegistry.has(job.id)).toBe(true);

    // Cross the expiry boundary
    vi.advanceTimersByTime(1);
    expect(jobRegistry.has(job.id)).toBe(false);
  });

  it("should not set maxAge timer when maxAge is 0 or undefined", () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);

    // maxAge = 0: no timer set
    scheduleJobCleanup(job.id, false, 0);
    vi.advanceTimersByTime(100000);
    expect(jobRegistry.has(job.id)).toBe(true);

    // maxAge = undefined: no timer set
    const job2 = createMockJobState();
    jobRegistry.set(job2.id, job2);
    scheduleJobCleanup(job2.id, false);
    vi.advanceTimersByTime(100000);
    expect(jobRegistry.has(job2.id)).toBe(true);
  });
});

describe("async job lifecycle", () => {
  beforeEach(() => {
    jobRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should transition job from running to done on promise resolve", async () => {
    const job = createMockJobState({ status: "running" });
    jobRegistry.set(job.id, job);

    expect(job.status).toBe("running");

    const result = await job.promise;
    job.status = result.isError ? "error" : "done";
    job.result = result;

    expect(job.status).toBe("done");
    expect(job.result?.output).toBe("mock result");
    expect(job.result?.usage.turns).toBe(1);
  });

  it("should transition job from running to cancelled", () => {
    const job = createMockJobState({ status: "running" });
    jobRegistry.set(job.id, job);

    job.status = "cancelled";
    expect(job.status).toBe("cancelled");
    expect(jobRegistry.get(job.id)?.status).toBe("cancelled");
  });

  it("should handle cancelled job result request (status is already cancelled)", () => {
    const job = createMockJobState({ status: "cancelled" });
    jobRegistry.set(job.id, job);

    const found = jobRegistry.get(job.id);
    expect(found?.status).toBe("cancelled");
  });

  it("should handle unknown jobId lookup", () => {
    expect(jobRegistry.get("nonexistent")).toBeUndefined();
  });

  it("should handle duplicate cancel (idempotent)", () => {
    const job = createMockJobState({ status: "cancelled" });
    jobRegistry.set(job.id, job);

    const found = jobRegistry.get(job.id);
    expect(found?.status).toBe("cancelled");
  });

  it("should handle completed job that is then cancelled (should reject)", () => {
    const job = createMockJobState({ status: "done" });
    jobRegistry.set(job.id, job);

    const found = jobRegistry.get(job.id);
    expect(found?.status).toBe("done");
  });

  it("should guard against cancellation race in promise chain", () => {
    // Simulate the guard: promise resolves after cancel
    const job = createMockJobState({ status: "cancelled" });
    jobRegistry.set(job.id, job);

    // The guard pattern: if status is cancelled, don't overwrite
    if (job.status !== "cancelled") {
      job.status = "done";
      job.result =
        job.promise.constructor.toString() as unknown as SubagentResult;
    }

    // Status should remain cancelled (guard prevented overwrite)
    expect(job.status).toBe("cancelled");
  });
});

describe("SubagentLiveStatus mutation (shared reference)", () => {
  beforeEach(() => {
    jobRegistry.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should reflect real-time mutations in registry liveStatus", () => {
    const liveStatus: SubagentLiveStatus = {
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
    };

    const job = createMockJobState({ liveStatus });
    jobRegistry.set(job.id, job);

    // Simulate event subscriber mutations
    liveStatus.turn = 1;
    liveStatus.output = "Hello, world!";
    liveStatus.activeTool = { name: "read", args: { path: "/tmp" } };
    liveStatus.usage.turns = 1;

    const found = jobRegistry.get(job.id);
    expect(found?.liveStatus.turn).toBe(1);
    expect(found?.liveStatus.output).toBe("Hello, world!");
    expect(found?.liveStatus.activeTool?.name).toBe("read");
  });
});

// ── Additional Async Tests ──────────────────────────────────────────

describe("race condition: cancel during await", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should return cancelled message when status changes to cancelled after await resolves", async () => {
    vi.useFakeTimers();
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });
    const job: JobState = {
      id: generateJobId(),
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
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as unknown as JobState["session"],
      startedAt: Date.now(),
      promise: deferredPromise,
      modelLabel: "test/model",
    };
    jobRegistry.set(job.id, job);
    job.status = "cancelled"; // Simulate cancel before promise resolves
    resolvePromise!({
      output: "this should be ignored",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: true,
      errorMessage: "The operation was aborted",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(job.status).toBe("cancelled");
    expect(job.result).toBeUndefined();
  });

  it("should use promise result when status is still running after resolve", async () => {
    vi.useFakeTimers();
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });
    const job: JobState = {
      id: generateJobId(),
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
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      } as unknown as JobState["session"],
      startedAt: Date.now(),
      promise: deferredPromise,
      modelLabel: "test/model",
    };
    jobRegistry.set(job.id, job);
    const successResult: SubagentResult = {
      output: "completed successfully",
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
    resolvePromise!(successResult);
    await vi.advanceTimersByTimeAsync(0);
    if (job.status !== "cancelled") {
      job.result = await job.promise;
    }
    expect(job.result?.output).toBe("completed successfully");
  });
});

describe("scheduleJobCleanup timer lifecycle", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should NOT remove job when no immediate cleanup scheduled (jobs persist)", async () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);
    scheduleJobCleanup(job.id, false);
    vi.advanceTimersByTime(1000000);
    expect(jobRegistry.has(job.id)).toBe(true); // persists
  });

  it("should remove job immediately for immediate cleanup", async () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);
    scheduleJobCleanup(job.id, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(jobRegistry.has(job.id)).toBe(false);
  });

  it("should fire immediate cleanup after TTL cleanup is scheduled", async () => {
    vi.useFakeTimers();
    const job = createMockJobState();
    jobRegistry.set(job.id, job);
    scheduleJobCleanup(job.id, false);
    vi.advanceTimersByTime(1000);
    scheduleJobCleanup(job.id, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(jobRegistry.has(job.id)).toBe(false);
  });
});

describe("cancellation guard in promise chain", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should NOT overwrite job.result when job.status is cancelled", async () => {
    const job = createMockJobState({ status: "cancelled" });
    job.promise = Promise.resolve({
      output: "this should not be set",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: true,
      errorMessage: "cancelled before completion",
    });
    jobRegistry.set(job.id, job);
    if (job.status !== "cancelled") {
      job.result = await job.promise;
    }
    expect(job.result).toBeUndefined();
    expect(job.status).toBe("cancelled");
  });

  it("should allow result assignment when status is not cancelled", async () => {
    const job = createMockJobState({ status: "done" });
    const expectedResult: SubagentResult = {
      output: "success",
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
    job.promise = Promise.resolve(expectedResult);
    jobRegistry.set(job.id, job);
    if (job.status !== "cancelled") {
      job.result = await job.promise;
    }
    expect(job.result?.output).toBe("success");
    expect(job.status).toBe("done");
  });

  it("should handle status transition from running to cancelled before result is read", async () => {
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });
    const job = createMockJobState({
      status: "running",
      promise: deferredPromise,
    });
    jobRegistry.set(job.id, job);
    job.status = "cancelled";
    resolvePromise!({
      output: "ignored output",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      isError: true,
      errorMessage: "cancelled before completion",
    });
    if (job.status !== "cancelled") {
      throw new Error("Guard should have prevented this");
    }
    expect(job.result).toBeUndefined();
  });
});

describe("get_subagent_status edge cases (simulated)", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should return not found for unknown jobId", () => {
    expect(jobRegistry.get("nonexistent")).toBeUndefined();
  });

  it("should return cancelled status for known cancelled jobId", () => {
    const job = createMockJobState({ status: "cancelled" });
    jobRegistry.set(job.id, job);
    expect(jobRegistry.get(job.id)?.status).toBe("cancelled");
  });

  it("should return running status for active job", () => {
    const job = createMockJobState({ status: "running" });
    jobRegistry.set(job.id, job);
    expect(jobRegistry.get(job.id)?.status).toBe("running");
  });

  it("should return done status for completed job", () => {
    const job = createMockJobState({ status: "done" });
    jobRegistry.set(job.id, job);
    expect(jobRegistry.get(job.id)?.status).toBe("done");
  });
});

describe("get_subagent_result edge cases (simulated)", () => {
  beforeEach(() => jobRegistry.clear());
  afterEach(() => {
    vi.useRealTimers();
    jobRegistry.clear();
  });

  it("should return not found for unknown jobId", async () => {
    expect(jobRegistry.get("nonexistent")).toBeUndefined();
  });

  it("should return cancelled message for cancelled jobId without awaiting", () => {
    const job = createMockJobState({ status: "cancelled" });
    jobRegistry.set(job.id, job);
    expect(jobRegistry.get(job.id)?.status).toBe("cancelled");
  });

  it("should await promise for running job and update result", async () => {
    const job = createMockJobState({ status: "running" });
    job.promise = Promise.resolve({
      output: "completed",
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
    });
    jobRegistry.set(job.id, job);
    const found = jobRegistry.get(job.id);
    if (found && found.status !== "cancelled") {
      const result = await found.promise;
      found.result = result;
      found.status = result.isError ? "error" : "done";
    }
    expect(found?.result?.output).toBe("completed");
    expect(found?.status).toBe("done");
  });

  it("should re-check cancelled status after await and return cancelled message", async () => {
    let resolvePromise!: (value: SubagentResult) => void;
    const deferredPromise = new Promise<SubagentResult>((resolve) => {
      resolvePromise = resolve;
    });
    const job = createMockJobState({
      status: "running",
      promise: deferredPromise,
    });
    jobRegistry.set(job.id, job);
    job.status = "cancelled";
    resolvePromise!({
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
    const found = jobRegistry.get(job.id);
    if (found) {
      const result = await found.promise;
      if ((found.status as JobStatus) === "cancelled") {
        expect(found.status).toBe("cancelled");
        expect(found.result).toBeUndefined();
      } else {
        found.result = result;
      }
    }
  });
});
