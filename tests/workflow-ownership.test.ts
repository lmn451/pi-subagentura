import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerWorkflowTool,
  MAX_WORKFLOW_JOBS,
  cleanupWorkflowJobsForOwner,
  getWorkflowJobForActiveSession,
  getWorkflowJobForOwner,
  getRunningWorkflowCount,
  retryPendingWorkflowNotifications,
  startWorkflowJob,
  workflowJobBelongsToOwner,
  workflowJobRegistry,
  workflowJobsForOwner,
  type WorkflowJobState,
} from "../src/workflow";
import {
  clearSessionScopes,
  registerSessionScope,
  getStartedSessionScopes,
  removeSessionScope,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
  type SessionScope,
} from "../src/session-scope";

function owner(id: number, generation: number): SessionOwnerToken {
  return { id, generation };
}

function context(id: number, generation: number): SessionScope {
  return {
    id,
    generation,
    lifecycle: "started",
    pi: {} as never,
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  };
}

function makeJob(
  id: string,
  status: WorkflowJobState["status"],
  ownerRef: SessionOwnerToken,
): WorkflowJobState {
  return {
    id,
    kind: "script",
    name: id,
    status,
    startedAt: Date.now(),
    promise: Promise.resolve({
      meta: { name: id, description: "test" },
      result: id,
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        turns: 0,
        totalTokens: 0,
      },
      phases: [],
    }),
    abort: new AbortController(),
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    },
    parentSessionOwner: ownerRef,
  };
}

describe("workflow parent session ownership", () => {
  beforeEach(() => {
    workflowJobRegistry.clear();
    setLegacyActiveSessionRefs(undefined);
    clearSessionScopes();
  });

  it("defaults a complete registration to the started lifecycle", () => {
    const scope = registerSessionScope({
      id: 6,
      generation: 1,
      pi: {} as never,
      parentStreaming: false,
      inProcessJobs: new Map(),
      pendingInProcessDeliveries: [],
      interactiveStates: new Map(),
    });

    expect(scope.lifecycle).toBe("started");
    expect(getStartedSessionScopes()).toEqual([scope]);
  });

  it("requires exact {id,generation}, treats wrong owners as missing, and cleans up only the owning lifecycle", () => {
    const sameIdGeneration1 = owner(7, 1);
    const sameIdGeneration2 = owner(7, 2);
    const otherIdGeneration1 = owner(8, 1);
    const owned = makeJob("owned", "running", sameIdGeneration1);
    const wrongGeneration = makeJob(
      "wrong-generation",
      "running",
      sameIdGeneration2,
    );
    const wrongId = makeJob("wrong-id", "running", otherIdGeneration1);
    workflowJobRegistry.set(owned.id, owned);
    workflowJobRegistry.set(wrongGeneration.id, wrongGeneration);
    workflowJobRegistry.set(wrongId.id, wrongId);

    setLegacyActiveSessionRefs(context(7, 1));

    expect(getWorkflowJobForActiveSession("owned")).toBe(owned);
    expect(getWorkflowJobForActiveSession("wrong-generation")).toBeUndefined();
    expect(getWorkflowJobForActiveSession("wrong-id")).toBeUndefined();
    expect(workflowJobBelongsToOwner(owned, sameIdGeneration1)).toBe(true);
    expect(workflowJobBelongsToOwner(wrongGeneration, sameIdGeneration1)).toBe(
      false,
    );
    expect(workflowJobBelongsToOwner(wrongId, sameIdGeneration1)).toBe(false);

    cleanupWorkflowJobsForOwner(sameIdGeneration1);

    expect(workflowJobRegistry.has("owned")).toBe(false);
    expect(workflowJobRegistry.get("wrong-generation")).toBe(wrongGeneration);
    expect(workflowJobRegistry.get("wrong-id")).toBe(wrongId);
  });

  it("keeps the registry cap global but evicts only terminal jobs owned by the active parent", () => {
    const activeOwner = owner(1, 1);
    const otherOwner = owner(2, 1);
    for (let i = 0; i < MAX_WORKFLOW_JOBS - 1; i++) {
      workflowJobRegistry.set(
        `running-${i}`,
        makeJob(`running-${i}`, "running", activeOwner),
      );
    }
    const otherTerminal = makeJob("other-terminal", "done", otherOwner);
    workflowJobRegistry.set(otherTerminal.id, otherTerminal);
    setLegacyActiveSessionRefs(context(1, 1));

    expect(() =>
      startWorkflowJob(
        "active",
        `export const meta = { name: "active", description: "d" };\nreturn "ok";`,
        { runAgent: async () => ({ isError: false, output: "ok" }) as any },
      ),
    ).toThrow(/100 workflow jobs already running/);
    expect(workflowJobRegistry.get("other-terminal")).toBe(otherTerminal);

    workflowJobRegistry.delete("running-0");
    const activeTerminal = makeJob("active-terminal", "done", activeOwner);
    workflowJobRegistry.set(activeTerminal.id, activeTerminal);

    const started = startWorkflowJob(
      "active",
      `export const meta = { name: "active", description: "d" };\nreturn "ok";`,
      { runAgent: async () => ({ isError: false, output: "ok" }) as any },
    );

    expect(workflowJobRegistry.has("active-terminal")).toBe(false);
    expect(workflowJobRegistry.get("other-terminal")).toBe(otherTerminal);
    expect(started.parentSessionOwner).toEqual(activeOwner);
  });

  it("suppresses late completion notifications after the parent generation changes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onComplete = vi.fn();
    setLegacyActiveSessionRefs(context(3, 1));
    const job = startWorkflowJob(
      "late-owner",
      `export const meta = { name: "late-owner", description: "d" };\nreturn await agent("x");`,
      {
        runAgent: async () => {
          await gate;
          return { isError: false, output: "ok" } as any;
        },
      },
      undefined,
      onComplete,
    );

    setLegacyActiveSessionRefs(context(3, 2));
    release();
    await job.promise;
    retryPendingWorkflowNotifications();

    expect(onComplete).not.toHaveBeenCalled();
    expect(job.completionNotificationDelivered).toBe(false);
  });

  it("lets captured A helpers access A while B is active, and blocks B from A", () => {
    const ownerA = owner(10, 1);
    const ownerB = owner(20, 1);
    const jobA = makeJob("job-a", "running", ownerA);
    const jobB = makeJob("job-b", "running", ownerB);
    workflowJobRegistry.set(jobA.id, jobA);
    workflowJobRegistry.set(jobB.id, jobB);

    setLegacyActiveSessionRefs(context(20, 1));

    expect(getWorkflowJobForActiveSession("job-a")).toBeUndefined();
    expect(getWorkflowJobForOwner("job-a", ownerA)).toBe(jobA);
    expect(getWorkflowJobForOwner("job-a", ownerB)).toBeUndefined();
    expect(workflowJobsForOwner(ownerA)).toEqual([jobA]);
    expect(workflowJobsForOwner(ownerB)).toEqual([jobB]);
    expect(getRunningWorkflowCount(ownerA)).toBe(1);
    expect(getRunningWorkflowCount(ownerB)).toBe(1);

    cleanupWorkflowJobsForOwner(ownerB);

    expect(workflowJobRegistry.get("job-a")).toBe(jobA);
    expect(workflowJobRegistry.has("job-b")).toBe(false);
  });

  it("captures explicit start owner instead of the mutable active owner", () => {
    const ownerA = owner(30, 1);
    const ownerB = owner(40, 1);
    setLegacyActiveSessionRefs(context(40, 1));

    const started = startWorkflowJob(
      "owned-by-a",
      `export const meta = { name: "owned-by-a", description: "d" };\nreturn "ok";`,
      { runAgent: async () => ({ isError: false, output: "ok" }) as any },
      undefined,
      undefined,
      ownerA,
    );

    expect(started.parentSessionOwner).toEqual(ownerA);
    expect(getWorkflowJobForActiveSession(started.id)).toBeUndefined();
    expect(getWorkflowJobForOwner(started.id, ownerA)).toBe(started);
    expect(getWorkflowJobForOwner(started.id, ownerB)).toBeUndefined();
  });

  it("delivers A completion through A while B is active", async () => {
    const tools: any[] = [];
    const sendA = vi.fn();
    const sendB = vi.fn();
    const piA = {
      registerTool: vi.fn((tool) => tools.push(tool)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: sendA,
    } as any;
    const piB = { sendMessage: sendB } as any;
    const contextA = { ...context(50, 1), pi: piA };
    const contextB = { ...context(60, 1), pi: piB };
    registerSessionScope(contextA);
    registerSessionScope(contextB);
    setLegacyActiveSessionRefs(contextB);
    registerWorkflowTool(piA, contextA);
    const workflow = tools.find((tool) => tool.name === "workflow");

    const started = await workflow.execute(
      "call-a",
      {
        script:
          'export const meta = { name: "owned-a", description: "d" };\nreturn "ok";',
        async: true,
      },
      undefined,
      vi.fn(),
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );
    await workflowJobRegistry.get(started.details.workflowId)!.promise;

    expect(sendA).toHaveBeenCalledOnce();
    expect(sendB).not.toHaveBeenCalled();
  });
  it("rejects a workflow call after its registered scope shuts down", async () => {
    const tools: any[] = [];
    const pi = {
      registerTool: vi.fn((tool) => tools.push(tool)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: vi.fn(),
    } as any;
    const scope = { ...context(70, 1), pi };
    registerSessionScope(scope);
    registerWorkflowTool(pi, scope);
    scope.lifecycle = "shutdown";
    removeSessionScope(scope.id);

    const workflow = tools.find((tool) => tool.name === "workflow");
    const result = await workflow.execute(
      "stale-call",
      {
        script:
          'export const meta = { name: "stale", description: "d" };\nreturn "ok";',
        async: false,
      },
      undefined,
      vi.fn(),
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );

    expect(result).toMatchObject({
      isError: true,
      details: { status: "session_unavailable" },
    });
    expect(workflowJobRegistry.size).toBe(0);
  });
});
