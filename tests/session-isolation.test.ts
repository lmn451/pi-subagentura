/**
 * Session isolation regression tests.
 *
 * Verifies that in multi-session processes (e.g. pi-web):
 * - Tools filter by owner
 * - Delivery is owner-routed
 * - Shutdown only cleans the shutting-down session
 * - Streaming is per-context
 * - Registration order does not affect delivery routing
 * - ExtensionAPI reuse across lifecycle generations
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSessionContextStack,
  type ActiveSessionContextToken,
  type SessionContextRef,
} from "../src/session-context";
import { jobRegistry, inProcessJobBelongsToOwner } from "../src/helpers";
import {
  deliverNotification,
  flushInProcessDeliveries,
} from "../src/notifications";
import { registerSessionHandlers } from "../src/session-handlers";
import {
  registerInProcessSubagentTools,
  registerInProcessMaintenanceTools,
} from "../src/tools/in-process";

const SUCCESS_RESULT = {
  output: "ok",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 1,
  },
  model: "test/model",
  isError: false as false,
};

describe("session isolation", () => {
  let root: string;

  function cleanGlobals() {
    const g = globalThis as any;
    g.__piSubagenturaRegistry = new Map();
    g.__piSubagenturaInteractiveRegistry = new Map();
    g.__piSubagenturaWorkflowJobs = new Map();
    g.__piSubagenturaPendingJobDeliveries = [];
    g.__piSubagenturaParentStreaming = false;
    g.__piSubagenturaPiRef = undefined;
    g.__piSubagenturaUi = undefined;
    g.__piSubagenturaSessionManager = undefined;
    g.__piSubagenturaActiveSessionContextId = undefined;
    g.__piSubagenturaActiveSessionContextGeneration = undefined;
    g.__piSubagenturaSessionContextStack = [];
    g.__piSubagenturaSessionContextIdCounter = 0;
    g.__piSubagenturaInteractivePollerHandle = undefined;
    g.__piSubagenturaInProcessFlushScheduled = false;
  }

  function createMockPi(name: string) {
    return {
      name,
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn().mockReturnValue(false),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn(),
      notify: vi.fn(),
      registerShortcut: vi.fn(),
      registerCommand: vi.fn(),
    };
  }

  function mockCtx() {
    return {
      cwd: root,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionId: () => "test-session",
        getEntries: () => [],
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanGlobals();
    root = mkdtempSync(join(tmpdir(), "pi-sub-isolation-"));
  });

  afterEach(() => {
    cleanGlobals();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  /** Directly test ownership: create contexts, spawn jobs, verify isolation. */
  function registerTwoSessions() {
    const piA = createMockPi("A");
    const piB = createMockPi("B");

    // Register session handlers (creates contexts)
    const ctxA = registerSessionHandlers(piA as any);
    const ctxB = registerSessionHandlers(piB as any);

    // Register tools per session
    registerInProcessSubagentTools(piA as any, ctxA);
    registerInProcessMaintenanceTools(piA as any, ctxA);
    registerInProcessSubagentTools(piB as any, ctxB);
    registerInProcessMaintenanceTools(piB as any, ctxB);

    // Fire session_start for both
    const startA = piA.on.mock.calls.find(
      ([e]: any[]) => e === "session_start",
    )?.[1];
    startA?.(
      { reason: "startup" },
      {
        ...mockCtx(),
        sessionManager: { getSessionId: () => "sess-A", getEntries: () => [] },
      },
    );
    const startB = piB.on.mock.calls.find(
      ([e]: any[]) => e === "session_start",
    )?.[1];
    startB?.(
      { reason: "startup" },
      {
        ...mockCtx(),
        sessionManager: { getSessionId: () => "sess-B", getEntries: () => [] },
      },
    );

    return { piA, piB, ctxA, ctxB };
  }

  // ── Core ownership test (no tool dependency) ─────────────────────────

  it("inProcessJobBelongsToOwner correctly isolates jobs by context", () => {
    const { ctxA, ctxB } = registerTwoSessions();

    const jobA = {
      id: "job-A",
      status: "running",
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: undefined,
        sessionId: "sess-A",
      },
    } as any;
    const jobB = {
      ...jobA,
      id: "job-B",
      deliveryOwner: {
        sessionContextId: ctxB.id,
        sessionContextGeneration: ctxB.generation,
        pi: undefined,
        sessionId: "sess-B",
      },
    } as any;
    jobRegistry.set("job-A", jobA);
    jobRegistry.set("job-B", jobB);

    // A's owner token resolves from A's context
    const ownerA: ActiveSessionContextToken = {
      id: ctxA.id,
      generation: ctxA.generation,
    };
    const ownerB: ActiveSessionContextToken = {
      id: ctxB.id,
      generation: ctxB.generation,
    };

    expect(inProcessJobBelongsToOwner(jobA, ownerA)).toBe(true);
    expect(inProcessJobBelongsToOwner(jobA, ownerB)).toBe(false);
    expect(inProcessJobBelongsToOwner(jobB, ownerB)).toBe(true);
    expect(inProcessJobBelongsToOwner(jobB, ownerA)).toBe(false);
  });

  // ── Tool-level owner filtering ──────────────────────────────────────

  it("get_subagent_status from session B returns not_found for session A's job", async () => {
    const { piA, piB, ctxA } = registerTwoSessions();

    // Find tool defs from mock registrations
    const statusDefA = piA.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "get_subagent_status",
    )?.[0];
    const statusDefB = piB.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "get_subagent_status",
    )?.[0];

    expect(statusDefA).toBeDefined();
    expect(statusDefB).toBeDefined();

    const jobA = {
      id: "tool-job-A",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
    } as any;
    jobRegistry.set("tool-job-A", jobA);

    const ctx = {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "sess-B", getEntries: () => [] },
    };

    // B's tool should NOT see A's job
    const fromB = await statusDefB.execute(
      "b-lookup",
      { jobId: "tool-job-A" },
      undefined,
      undefined,
      ctx,
    );
    expect(fromB.details.status).toBe("not_found");

    // A's tool SHOULD see its own job
    const fromA = await statusDefA.execute(
      "a-lookup",
      { jobId: "tool-job-A" },
      undefined,
      undefined,
      {
        ...ctx,
        sessionManager: { getSessionId: () => "sess-A", getEntries: () => [] },
      },
    );
    expect(fromA.details.status).toBe("done");
  });

  it("prune_subagent_jobs only removes visible jobs", async () => {
    const { piA, piB, ctxA, ctxB } = registerTwoSessions();

    const pruneDefB = piB.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "prune_subagent_jobs",
    )?.[0];
    expect(pruneDefB).toBeDefined();

    const jobA = {
      id: "prune-A",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
    } as any;
    const jobB = {
      id: "prune-B",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxB.id,
        sessionContextGeneration: ctxB.generation,
        pi: piB,
        sessionId: "sess-B",
      },
    } as any;
    jobRegistry.set("prune-A", jobA);
    jobRegistry.set("prune-B", jobB);

    await pruneDefB.execute();

    expect(jobRegistry.has("prune-A")).toBe(true); // A's job survives
    expect(jobRegistry.has("prune-B")).toBe(false); // B's own job pruned
  });

  // ── Delivery routing ─────────────────────────────────────────────────

  it("completion notification routed to owning session, not last-registered", () => {
    const { piA, piB, ctxA } = registerTwoSessions();

    const jobA = {
      id: "delivery-job",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      notificationDelivered: false,
    } as any;
    jobRegistry.set("delivery-job", jobA);

    deliverNotification(jobA, SUCCESS_RESULT);
    flushInProcessDeliveries();

    expect(piA.sendMessage).toHaveBeenCalled();
    expect(piB.sendMessage).not.toHaveBeenCalled();
  });

  // ── Shutdown isolation (both orders) ────────────────────────────────

  it("root shutdown clears all jobs", () => {
    const { piA, piB, ctxA, ctxB } = registerTwoSessions();

    const jobA = {
      id: "sd-A",
      status: "running",
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: new Promise(() => {}),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
      abort: new AbortController(),
    } as any;
    const jobB = {
      id: "sd-B",
      status: "running",
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: new Promise(() => {}),
      deliveryOwner: {
        sessionContextId: ctxB.id,
        sessionContextGeneration: ctxB.generation,
        pi: piA,
        sessionId: "sess-B",
      },
      abort: new AbortController(),
    } as any;
    jobRegistry.set("sd-A", jobA);
    jobRegistry.set("sd-B", jobB);

    // A is root (registered first). When root shuts down, all contexts die.
    const shutdownA = [...piA.on.mock.calls]
      .reverse()
      .find(([e]: any[]) => e === "session_shutdown")?.[1];
    shutdownA?.(
      { reason: "new" },
      { cwd: root, sessionManager: { getSessionId: () => "sess-A" } },
    );

    // Root shutdown clears all jobs
    expect(jobRegistry.has("sd-A")).toBe(false);
    expect(jobRegistry.has("sd-B")).toBe(false);
  });

  it("nested shutdown does not evict root's running jobs", () => {
    const { piB, ctxA, ctxB } = registerTwoSessions();

    const jobA = {
      id: "sd2-A",
      status: "running",
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: new Promise(() => {}),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piB,
        sessionId: "sess-A",
      },
      abort: new AbortController(),
    } as any;
    const jobB = {
      id: "sd2-B",
      status: "running",
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: new Promise(() => {}),
      deliveryOwner: {
        sessionContextId: ctxB.id,
        sessionContextGeneration: ctxB.generation,
        pi: piB,
        sessionId: "sess-B",
      },
      abort: new AbortController(),
    } as any;
    jobRegistry.set("sd2-A", jobA);
    jobRegistry.set("sd2-B", jobB);

    // B is a nested descendant. Shutdown of B must NOT evict A's job.
    const shutdownB = [...piB.on.mock.calls]
      .reverse()
      .find(([e]: any[]) => e === "session_shutdown")?.[1];
    shutdownB?.(
      { reason: "new" },
      { cwd: root, sessionManager: { getSessionId: () => "sess-B" } },
    );

    expect(jobRegistry.has("sd2-A")).toBe(true);
    expect(jobRegistry.has("sd2-B")).toBe(false);
  });

  // ── Per-context streaming ────────────────────────────────────────────

  it("B streaming does not suppress A's notify-mode delivery", () => {
    const { piA, piB, ctxA } = registerTwoSessions();

    // Fire agent_start for B (B is streaming)
    const agentStartB = piB.on.mock.calls.find(
      ([e]: any[]) => e === "agent_start",
    )?.[1];
    agentStartB?.();

    const jobA = {
      id: "stream-job",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
      notifyOnComplete: "notify",
      triggerTurnOnComplete: false,
      notificationDelivered: false,
    } as any;
    jobRegistry.set("stream-job", jobA);

    deliverNotification(jobA, SUCCESS_RESULT);
    flushInProcessDeliveries();

    // A's notify MUST NOT reach B
    expect(piB.sendMessage).not.toHaveBeenCalled();
  });

  // ── Registration order independence ──────────────────────────────────

  it("session A spawns after B registered last and gets its own delivery", () => {
    const piB = createMockPi("B");
    const piA = createMockPi("A");

    // B registers first, A last
    const ctxB = registerSessionHandlers(piB as any);
    const ctxA = registerSessionHandlers(piA as any);
    registerInProcessSubagentTools(piA as any, ctxA);

    const startB = piB.on.mock.calls.find(
      ([e]: any[]) => e === "session_start",
    )?.[1];
    startB?.(
      { reason: "startup" },
      {
        ...mockCtx(),
        sessionManager: { getSessionId: () => "sess-B", getEntries: () => [] },
      },
    );
    const startA = piA.on.mock.calls.find(
      ([e]: any[]) => e === "session_start",
    )?.[1];
    startA?.(
      { reason: "startup" },
      {
        ...mockCtx(),
        sessionManager: { getSessionId: () => "sess-A", getEntries: () => [] },
      },
    );

    const jobA = {
      id: "order-job",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctxA.id,
        sessionContextGeneration: ctxA.generation,
        pi: piA,
        sessionId: "sess-A",
      },
      notifyOnComplete: "inject",
      triggerTurnOnComplete: true,
      notificationDelivered: false,
    } as any;
    jobRegistry.set("order-job", jobA);

    deliverNotification(jobA, SUCCESS_RESULT);
    flushInProcessDeliveries();

    expect(piA.sendMessage).toHaveBeenCalled();
    expect(piB.sendMessage).not.toHaveBeenCalled();
  });

  // ── ExtensionAPI reuse across lifecycle generations ──────────────────

  it("tool captured at registration resolves to live generation after session reload", () => {
    // Simulate: session A registers tools at gen 0, session_start advances to gen 1,
    // then a reload/resume advances to gen 2. The tool captured at gen 0 should
    // resolve through resolveOwnerToken to the current live generation.
    const piA = createMockPi("A");
    const ctx = registerSessionHandlers(piA as any);
    registerInProcessSubagentTools(piA as any, ctx);

    const startA = piA.on.mock.calls.find(
      ([e]: any[]) => e === "session_start",
    )?.[1];
    startA?.(
      { reason: "startup" },
      {
        ...mockCtx(),
        sessionManager: { getSessionId: () => "sess-A", getEntries: () => [] },
      },
    );

    const statusDef = piA.registerTool.mock.calls.find(
      ([t]: any[]) => t.name === "get_subagent_status",
    )?.[0];
    expect(statusDef).toBeDefined();

    // Simulate reload: advance context generation
    const ctxStack = getSessionContextStack();
    const activeCtx = ctxStack.find((c) => c.id === ctx.id)!;
    activeCtx.generation++;
    (globalThis as any).__piSubagenturaActiveSessionContextGeneration =
      activeCtx.generation;

    // Spawn a job in the new generation
    const job = {
      id: "gen-job",
      status: "done",
      result: { ...SUCCESS_RESULT },
      liveStatus: { turn: 0, output: "" },
      session: { abort: vi.fn() },
      startedAt: Date.now(),
      cwd: process.cwd(),
      promise: Promise.resolve(SUCCESS_RESULT),
      deliveryOwner: {
        sessionContextId: ctx.id,
        sessionContextGeneration: activeCtx.generation,
        pi: piA,
        sessionId: "sess-A",
      },
    } as any;
    jobRegistry.set("gen-job", job);

    // Tool (captured at gen 0) should still access the job (resolveOwnerToken
    // resolves the LIVE generation)
    const ctx2 = {
      ...mockCtx(),
      sessionManager: { getSessionId: () => "sess-A", getEntries: () => [] },
    };
    return statusDef
      .execute("gen-lookup", { jobId: "gen-job" }, undefined, undefined, ctx2)
      .then((r: any) => {
        expect(r.details.status).toBe("done");
      });
  });
});
