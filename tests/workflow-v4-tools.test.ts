import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDurableWorkflowTools } from "../src/workflow-durable-tools";
import {
  registerSessionScope,
  sessionOwner,
  clearSessionScopes,
} from "../src/session-scope";
import {
  cleanupWorkflowJobsForOwner,
  MAX_WORKFLOW_JOBS,
  workflowJobRegistry,
} from "../src/workflow-jobs";
import {
  clearCompletionCoordinator,
  prepareCompletionManifest,
  publishCompletion,
  registerCompletionMember,
  registerCompletionCoordinator,
  restoreDurableCompletionGroupsSync,
  sealCompletionGroups,
} from "../src/completion-coordinator";
import { DurableWorkflow } from "../src/workflow-durable";
import { runWorkflow } from "../src/workflow-worker";
import { getLiveWorkflowV4Store } from "../src/workflow-v4-store";
import { encodeRunValue, WorkflowRunStore } from "../src/workflow-run-store";
import {
  completionIntentForOwner,
  restoreDurableWorkflowRuns,
} from "../src/workflow-durable-tools";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { registerWorkflowTool } from "../src/workflow-tool";

const durableProcessControl = vi.hoisted(() => ({
  stop: undefined as ((directory: string) => Promise<void>) | undefined,
}));

vi.mock("../src/workflow-durable-process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-durable-process")>();
  return {
    ...actual,
    stopDurableProcessAttempts: (directory: string) =>
      durableProcessControl.stop
        ? durableProcessControl.stop(directory)
        : actual.stopDurableProcessAttempts(directory),
  };
});

let root: string;
const owners: ReturnType<typeof sessionOwner>[] = [];
const WORKFLOW_WORKER_WAIT_MS = 10_000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-v4-tools-"));
});

afterEach(async () => {
  durableProcessControl.stop = undefined;
  for (const owner of owners.splice(0)) cleanupWorkflowJobsForOwner(owner);
  for (const job of workflowJobRegistry.values()) job.abort.abort();
  await Promise.allSettled(
    [...workflowJobRegistry.values()].map((job) => job.promise),
  );
  workflowJobRegistry.clear();
  clearSessionScopes();
  await rm(root, { recursive: true, force: true });
});

function definition(name: string, body: string) {
  return `import { defineWorkflow } from "pi-subagentura/workflow";
    export default defineWorkflow({ name: "${name}", version: 1,
      run: async (ctx, args) => { ${body} }
    });`;
}

function waitForWorkflowWorker(assertion: () => void) {
  return vi.waitFor(assertion, {
    timeout: WORKFLOW_WORKER_WAIT_MS,
    interval: 20,
  });
}

function setup(
  id: number,
  sessionId: string,
  ui: Record<string, unknown> = {},
) {
  const entries: any[] = [];
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn((_type: string, entry: unknown) => entries.push(entry)),
    sendMessage: vi.fn(),
  };
  const sessionManager = {
    getSessionId: () => sessionId,
    getSessionDir: () => root,
    getEntries: () => entries,
  };
  const scope = registerSessionScope({
    id,
    generation: 1,
    lifecycle: "started",
    pi,
    cwd: root,
    sessionManager,
  });
  const owner = sessionOwner(scope);
  owners.push(owner);
  registerCompletionCoordinator(pi, scope);
  const ctx = {
    cwd: root,
    sessionManager,
    hasUI: true,
    ui,
  };
  return { pi, scope, owner, ctx, tools, entries };
}

function successfulRunner(output: string): WorkflowAgentRunner {
  return vi.fn(async () => ({
    isError: false as const,
    output,
    usage: zeroUsage(),
  }));
}

function register(
  setupResult: ReturnType<typeof setup>,
  runner: WorkflowAgentRunner,
) {
  return registerDurableWorkflowTools(
    setupResult.pi,
    () => sessionOwner(setupResult.scope),
    () => runner,
    () => true,
    root,
  );
}

async function executeTool(
  tools: Map<string, any>,
  name: string,
  params: unknown,
  ctx: unknown,
) {
  const tool = tools.get(name);
  expect(tool, `registered ${name} tool`).toBeDefined();
  return tool.execute("test-call", params, undefined, undefined, ctx);
}

describe("v4 workflow public tools", () => {
  it("keeps cancellation retryable after marker persistence fails", async () => {
    const current = setup(1, "cancel-retry-owner");
    let agentStarted!: () => void;
    const started = new Promise<void>((resolve) => (agentStarted = resolve));
    const runner: WorkflowAgentRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        agentStarted();
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    const api = register(current, runner);
    const startedRun = await api.run(
      {
        script: definition(
          "cancel-retry",
          'await ctx.agent("wait", { prompt: "wait", id: "wait" }); return true;',
        ),
        async: true,
      },
      undefined,
      undefined,
      current.ctx,
    );
    const workflowId = startedRun.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    await started;
    const attemptsDirectory = join(job.durable!.store.directory, "attempts");
    await mkdir(attemptsDirectory, { recursive: true });
    const attemptManifest = join(attemptsDirectory, "1-1.json");
    await writeFile(attemptManifest, "{}");

    const resume = current.tools.get("resume_workflow");
    registerWorkflowTool(current.pi, current.scope);
    durableProcessControl.stop = async () => {
      throw new Error("marker persistence unavailable");
    };
    const failed = await executeTool(
      current.tools,
      "cancel_workflow",
      { workflowId },
      current.ctx,
    );
    expect(failed.isError).toBe(true);
    expect(job.status).toBe("running");
    expect(job.abort.signal.aborted).toBe(false);
    expect(
      job.durable?.store.events.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);

    try {
      durableProcessControl.stop = undefined;
      const retried = await executeTool(
        current.tools,
        "cancel_workflow",
        { workflowId },
        current.ctx,
      );
      expect(retried.details).toMatchObject({
        status: "cancelled",
        cancelled: true,
      });
      await access(`${attemptManifest}.cancel`);
      await expect(job.promise).rejects.toThrow();
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        workflowId,
      );
      expect(
        events?.filter((event) => event.kind === "cancelled"),
      ).toHaveLength(1);

      const rejected = await resume.execute(
        "resume",
        { workflowId, async: true },
        undefined,
        undefined,
        current.ctx,
      );
      expect(rejected.isError).toBe(true);
      expect(rejected.details.error).toMatch(/already terminal/i);
    } finally {
      durableProcessControl.stop = undefined;
    }
  });

  it("reports completion when a run finishes during marker persistence", async () => {
    const current = setup(1, "cancel-race-owner");
    let agentStarted!: () => void;
    let finishAgent!: () => void;
    const started = new Promise<void>((resolve) => (agentStarted = resolve));
    const waitForFinish = new Promise<void>(
      (resolve) => (finishAgent = resolve),
    );
    const runner: WorkflowAgentRunner = async () => {
      agentStarted();
      await waitForFinish;
      return {
        isError: false,
        output: "finished",
        usage: zeroUsage(),
      };
    };
    const api = register(current, runner);
    const startedRun = await api.run(
      {
        script: definition(
          "cancel-race",
          'await ctx.agent("wait", { prompt: "wait", id: "wait" }); return true;',
        ),
        async: true,
      },
      undefined,
      undefined,
      current.ctx,
    );
    const workflowId = startedRun.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    await started;

    registerWorkflowTool(current.pi, current.scope);
    let resolveMarkerStarted!: () => void;
    let releaseMarker!: () => void;
    const markerStarted = new Promise<void>((resolve) => {
      resolveMarkerStarted = resolve;
    });
    const markerRelease = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerCalls = 0;
    durableProcessControl.stop = async () => {
      markerCalls++;
      if (markerCalls === 1) {
        resolveMarkerStarted();
        await markerRelease;
      }
    };
    finishAgent();
    try {
      await markerStarted;
      const completion = job.completionNotification;
      const completionSpy = vi.fn((finishedJob) => completion?.(finishedJob));
      job.completionNotification = completionSpy;
      const cancelPromise = executeTool(
        current.tools,
        "cancel_workflow",
        { workflowId },
        current.ctx,
      );
      await Promise.resolve();
      expect(markerCalls).toBe(1);
      releaseMarker();
      await expect(job.promise).resolves.toMatchObject({ result: true });
      const response = await cancelPromise;
      expect(response.details).toMatchObject({
        status: "done",
        cancelled: false,
      });
      expect(job.abort.signal.aborted).toBe(false);
      expect(completionSpy).toHaveBeenCalledTimes(1);
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        workflowId,
      );
      expect(events?.filter((event) => event.kind === "terminal")).toHaveLength(
        1,
      );
      expect(events?.at(-1)?.data.status).toBe("done");
    } finally {
      finishAgent();
      releaseMarker();
      durableProcessControl.stop = undefined;
    }
  });

  it("commits cancellation before a queued success terminal", async () => {
    const current = setup(1, "cancel-wins-owner");
    let agentStarted!: () => void;
    let finishAgent!: () => void;
    const started = new Promise<void>((resolve) => (agentStarted = resolve));
    const waitForFinish = new Promise<void>(
      (resolve) => (finishAgent = resolve),
    );
    const runner: WorkflowAgentRunner = async () => {
      agentStarted();
      await waitForFinish;
      return {
        isError: false,
        output: "finished",
        usage: zeroUsage(),
      };
    };
    const api = register(current, runner);
    const startedRun = await api.run(
      {
        script: definition(
          "cancel-wins",
          'await ctx.agent("wait", { prompt: "wait", id: "wait" }); return true;',
        ),
        async: true,
      },
      undefined,
      undefined,
      current.ctx,
    );
    const workflowId = startedRun.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    await started;
    registerWorkflowTool(current.pi, current.scope);
    let markerStarted!: () => void;
    let releaseMarker!: () => void;
    const markerEntered = new Promise<void>((resolve) => {
      markerStarted = resolve;
    });
    const markerWait = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let markerCalls = 0;
    let settled = false;
    const completion = job.completionNotification;
    const completionSpy = vi.fn((finishedJob) => completion?.(finishedJob));
    job.completionNotification = completionSpy;
    durableProcessControl.stop = async () => {
      markerCalls++;
      markerStarted();
      await markerWait;
    };
    const cancelPromise = executeTool(
      current.tools,
      "cancel_workflow",
      { workflowId },
      current.ctx,
    );
    try {
      await markerEntered;
      void job.promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      finishAgent();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(markerCalls).toBe(1);
      releaseMarker();
      const response = await cancelPromise;
      expect(response.details).toMatchObject({
        status: "cancelled",
        cancelled: true,
      });
      await expect(job.promise).rejects.toThrow();
      expect(job.status).toBe("cancelled");
      expect(job.abort.signal.aborted).toBe(true);
      expect(completionSpy).toHaveBeenCalledTimes(1);
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        workflowId,
      );
      expect(
        events?.filter((event) =>
          ["cancelled", "terminal"].includes(event.kind),
        ),
      ).toHaveLength(1);
      expect(
        events?.findLast((event) =>
          ["cancelled", "terminal"].includes(event.kind),
        ),
      ).toMatchObject({
        kind: "cancelled",
        data: { status: "cancelled" },
      });
    } finally {
      finishAgent();
      releaseMarker();
      durableProcessControl.stop = undefined;
    }
  });

  it("recovers only project terminal notices owned by this parent once", async () => {
    const current = setup(1, "recovery-owner");
    const notify = vi.fn();
    current.ctx.ui.notify = notify;
    const runScope = { cwd: root, sessionId: "workflow-v4", root };
    const createTerminalRun = async (parentSessionId: string) => {
      const store = await WorkflowRunStore.create(runScope, {
        parentSessionId,
        script: definition(`terminal-${parentSessionId}`, "return true;"),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "each" },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      });
      await store.append("accepted", {});
      await store.append("delivery", {
        completion: { legacy: false, policy: "each" },
        parentSessionId,
      });
      await store.append("terminal", {
        status: "done",
        result: encodeRunValue({ errorCount: 0 }),
        completedAt: Date.now(),
      });
      await store.close();
      return store.id;
    };
    const eligibleId = await createTerminalRun("recovery-owner");
    const unrelatedId = await createTerminalRun("unrelated-parent");

    await restoreDurableWorkflowRuns(
      current.pi,
      current.owner,
      current.ctx,
      root,
    );
    await restoreDurableWorkflowRuns(
      current.pi,
      current.owner,
      current.ctx,
      root,
    );
    const notices = current.entries.filter((entry) =>
      entry.completionId?.startsWith("workflow:"),
    );
    expect(notify).not.toHaveBeenCalled();
    expect(
      notices.filter(
        (entry) => entry.completionId === `workflow:${eligibleId}`,
      ),
    ).toHaveLength(1);
    expect(
      notices.some((entry) => entry.completionId === `workflow:${unrelatedId}`),
    ).toBe(false);
  });

  it("releases the original group after a different parent resumes the run", async () => {
    const first = setup(1, "group-parent-a");
    const groupId = "parent-a-group";
    const script = definition("cross-parent-group", "return { done: true }; ");
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "group-parent-a",
        script,
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "group", groupId },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "group", groupId },
      parentSessionId: "group-parent-a",
    });
    registerCompletionMember(
      "workflow",
      workflowId,
      "group",
      groupId,
      first.owner,
    );
    sealCompletionGroups(first.owner);
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const second = setup(2, "group-parent-b");
    register(second, successfulRunner("completed in parent B"));
    const resumed = await executeTool(
      second.tools,
      "resume_workflow",
      { workflowId, async: true },
      second.ctx,
    );
    expect(resumed.details.status).toBe("started");
    await expect(
      workflowJobRegistry.get(workflowId)!.promise,
    ).resolves.toMatchObject({
      result: { done: true },
    });
    clearCompletionCoordinator(second.owner);
    clearSessionScopes();

    const restored = setup(3, "group-parent-a");
    const recoveryNotice = vi.fn();
    restored.ctx.ui.notify = recoveryNotice;
    await restoreDurableWorkflowRuns(
      restored.pi,
      restored.owner,
      restored.ctx,
      root,
    );
    expect(recoveryNotice).not.toHaveBeenCalled();
    await restoreDurableWorkflowRuns(
      restored.pi,
      restored.owner,
      restored.ctx,
      root,
    );
    const recoveredNotices = restored.entries.filter(
      (entry) => entry.completionId === `workflow:${workflowId}`,
    );
    expect(recoveredNotices).toHaveLength(1);
    expect(recoveredNotices[0]).toMatchObject({
      policy: "group",
      groupId,
      groupComplete: true,
    });
  });

  it("uses legacy created session ownership for delivery records", async () => {
    const legacy = await WorkflowRunStore.create(
      { cwd: root, sessionId: "legacy-owner-a", root },
      {
        script: definition("legacy-owner", "return true;"),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: {
          legacy: false,
          policy: "group",
          groupId: "legacy-group",
        },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    await legacy.append("accepted", {});
    await legacy.append("delivery", {
      completion: {
        legacy: false,
        policy: "group",
        groupId: "legacy-group",
      },
    });
    expect(completionIntentForOwner(legacy.events, "legacy-owner-a")).toEqual({
      legacy: false,
      policy: "group",
      groupId: "legacy-group",
    });
    expect(completionIntentForOwner(legacy.events, "legacy-owner-b")).toBe(
      undefined,
    );
    await legacy.close();
  });

  it("retains parent A's group intent after B and C interruptions", async () => {
    const groupId = "repeated-parent-group";
    const script = definition(
      "repeated-parent-switch",
      'await ctx.agent("wait", { prompt: "wait" }); return { done: true };',
    );
    const first = setup(1, "repeated-parent-a");
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "repeated-parent-a",
        script,
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "group", groupId },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "group", groupId },
      parentSessionId: "repeated-parent-a",
    });
    registerCompletionMember(
      "workflow",
      workflowId,
      "group",
      groupId,
      first.owner,
    );
    sealCompletionGroups(first.owner);
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    for (const [index, sessionId] of [
      "repeated-parent-b",
      "repeated-parent-c",
    ].entries()) {
      const middle = setup(index + 2, sessionId);
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const interruptedRunner: WorkflowAgentRunner = ({ signal }) =>
        new Promise((_resolve, reject) => {
          signalStarted();
          signal!.addEventListener(
            "abort",
            () => reject(new Error("parent replaced")),
            { once: true },
          );
        });
      register(middle, interruptedRunner);
      const resumed = await executeTool(
        middle.tools,
        "resume_workflow",
        { workflowId, async: true },
        middle.ctx,
      );
      expect(resumed.details.status).toBe("started");
      const job = workflowJobRegistry.get(workflowId)!;
      await started;
      expect(job.completionPolicy).toBe("each");
      cleanupWorkflowJobsForOwner(middle.owner);
      await expect(job.promise).rejects.toThrow("Workflow aborted.");
      clearCompletionCoordinator(middle.owner);
      clearSessionScopes();
    }

    const returning = setup(4, "repeated-parent-a");
    await restoreDurableWorkflowRuns(
      returning.pi,
      returning.owner,
      returning.ctx,
      root,
    );
    const returningApi = register(
      returning,
      successfulRunner("completed after returning to A"),
    );
    const resumed = await returningApi.run(
      { workflowId, async: true },
      undefined,
      undefined,
      returning.ctx,
    );
    expect(resumed.details.status).toBe("started");
    const returnedJob = workflowJobRegistry.get(workflowId)!;
    expect(returnedJob.completionPolicy).toBe("group");
    await expect(returnedJob.promise).resolves.toMatchObject({
      result: { done: true },
    });
    const events = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(
      events?.findLast((event) => event.kind === "delivery")?.data,
    ).toMatchObject({
      parentSessionId: "repeated-parent-a",
      completion: { policy: "group", groupId },
    });
    await restoreDurableWorkflowRuns(
      returning.pi,
      returning.owner,
      returning.ctx,
      root,
    );
    expect(
      returning.entries.find(
        (entry) => entry.completionId === `workflow:${workflowId}`,
      ),
    ).toMatchObject({ policy: "group", groupId, groupComplete: true });
  });

  it("commits cancellation intent before retrying durable process cleanup", async () => {
    const current = setup(1, "cancel-owner");
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "cancel-owner",
        script: definition("cancel-order", "return true;"),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "each" },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "each" },
      parentSessionId: "cancel-owner",
    });
    const attempts = join(store.directory, "attempts");
    await mkdir(attempts, { recursive: true });
    await writeFile(join(attempts, "1-1.json"), "{}");
    const workflowId = store.id;
    await store.close();

    const api = register(current, successfulRunner("unused"));
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    let cancellationIntentWrites = 0;
    append.mockImplementation(async function (
      this: WorkflowRunStore,
      kind: string,
      data: any,
    ) {
      if (kind === "cancelled") cancellationIntentWrites++;
      return originalAppend.call(this, kind, data);
    });
    try {
      durableProcessControl.stop = async () => {
        throw new Error("simulated marker write failure");
      };
      const failedCancel = await api.cancel(workflowId, current.ctx);
      expect(failedCancel.isError).toBe(true);
      const afterFailure = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        workflowId,
      );
      expect(
        afterFailure?.filter((event) => event.kind === "cancelled"),
      ).toHaveLength(1);
      await expect(
        access(join(attempts, "1-1.json.cancel")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(cancellationIntentWrites).toBe(1);
      durableProcessControl.stop = undefined;
      const cancelled = await api.cancel(workflowId, current.ctx);
      expect(cancelled.details.status).toBe("cancelled");
      await access(join(attempts, "1-1.json.cancel"));
    } finally {
      durableProcessControl.stop = undefined;
      append.mockRestore();
    }
    const afterRetry = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(
      afterRetry?.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);
    expect(cancellationIntentWrites).toBe(1);
  });

  it("keeps accepted peers completable when another acceptance append fails", async () => {
    const first = setup(1, "acceptance-crash");
    const api = register(first, successfulRunner("unused"));
    const groupId = "crashed-acceptance-group";
    registerCompletionMember(
      "interactive",
      "accepted-peer",
      "group",
      groupId,
      first.owner,
    );
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "completion-accepted-peer",
        source: "interactive",
        sourceId: "accepted-peer",
        label: "Accepted peer",
        status: "done",
        policy: "group",
        groupId,
        references: [{ label: "output", value: "peer-output" }],
        completedAt: Date.now(),
      },
      first.owner,
    );
    const originalAppend = WorkflowRunStore.prototype.append;
    const append = vi.spyOn(WorkflowRunStore.prototype, "append");
    append.mockImplementation(async function (
      this: WorkflowRunStore,
      kind: string,
      data: any,
    ) {
      if (kind === "accepted") throw new Error("simulated acceptance crash");
      return originalAppend.call(this, kind, data);
    });
    try {
      const failed = await api.run(
        {
          script: definition("crashed-acceptance", "return true;"),
          completionPolicy: "group",
          completionGroupId: groupId,
        },
        undefined,
        undefined,
        first.ctx,
      );
      expect(failed.isError).toBe(true);
    } finally {
      append.mockRestore();
    }

    sealCompletionGroups(first.owner);
    expect(
      prepareCompletionManifest(first.owner)?.details.completionIds,
    ).toContain("completion-accepted-peer");
  });

  it("restores accepted group membership missed by a crash after acceptance", async () => {
    const first = setup(1, "missed-registration-parent");
    const groupId = "missed-registration-group";
    registerCompletionMember(
      "interactive",
      "already-completed-peer",
      "group",
      groupId,
      first.owner,
    );
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "already-completed-peer:turn",
        source: "interactive",
        sourceId: "already-completed-peer",
        turnId: "turn",
        label: "peer",
        status: "done",
        policy: "group",
        groupId,
        references: [{ label: "output", value: "done" }],
        completedAt: Date.now(),
      },
      first.owner,
    );
    sealCompletionGroups(first.owner);
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "missed-registration-parent",
        script: definition(
          "missed-registration",
          "return { recovered: true };",
        ),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "group", groupId },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "group", groupId },
      parentSessionId: "missed-registration-parent",
    });
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const recovered = setup(2, "missed-registration-parent");
    restoreDurableCompletionGroupsSync(recovered.owner);
    register(recovered, successfulRunner("done"));
    await restoreDurableWorkflowRuns(
      recovered.pi,
      recovered.owner,
      recovered.ctx,
      root,
    );
    const resumed = await executeTool(
      recovered.tools,
      "resume_workflow",
      { workflowId, async: true },
      recovered.ctx,
    );
    expect(resumed.details.status).toBe("started");
    const job = workflowJobRegistry.get(workflowId)!;
    expect(job.completionPolicy).toBe("group");
    await expect(job.promise).resolves.toMatchObject({
      result: { recovered: true },
    });
    await restoreDurableWorkflowRuns(
      recovered.pi,
      recovered.owner,
      recovered.ctx,
      root,
    );
    expect(
      recovered.entries.find(
        (entry) => entry.completionId === `workflow:${workflowId}`,
      ),
    ).toMatchObject({ policy: "group", groupId });
    const saved = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(
      saved?.findLast((event) => event.kind === "delivery")?.data,
    ).toMatchObject({
      parentSessionId: "missed-registration-parent",
      completion: { policy: "group", groupId },
    });
  });

  it("holds group manifests while accepted membership discovery is in flight", async () => {
    const first = setup(1, "slow-membership-recovery");
    const groupId = "slow-recovery-group";
    registerCompletionMember(
      "workflow",
      "completed-peer",
      "group",
      groupId,
      first.owner,
    );
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "workflow:completed-peer",
        source: "workflow",
        sourceId: "completed-peer",
        label: "peer",
        status: "done",
        policy: "group",
        groupId,
        references: [{ label: "result", value: "done" }],
        completedAt: Date.now(),
      },
      first.owner,
    );
    sealCompletionGroups(first.owner);
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "slow-membership-recovery",
        script: definition("slow-recovery", "return true;"),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "group", groupId },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "group", groupId },
      parentSessionId: "slow-membership-recovery",
    });
    await store.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const current = setup(2, "slow-membership-recovery");
    restoreDurableCompletionGroupsSync(current.owner);
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: "workflow:completed-peer",
        source: "workflow",
        sourceId: "completed-peer",
        label: "peer",
        status: "done",
        policy: "group",
        groupId,
        references: [{ label: "result", value: "done" }],
        completedAt: Date.now(),
      },
      current.owner,
    );
    const originalInspect = WorkflowRunStore.inspect;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const inspect = vi
      .spyOn(WorkflowRunStore, "inspect")
      .mockImplementation(async (runScope, id) => {
        if (id === workflowId) {
          signalStarted();
          await hold;
        }
        return originalInspect.call(WorkflowRunStore, runScope, id);
      });
    try {
      const recovering = restoreDurableWorkflowRuns(
        current.pi,
        current.owner,
        current.ctx,
        root,
      );
      await started;
      publishCompletion(
        {
          schemaVersion: 1,
          completionId: "workflow:independent-during-recovery",
          source: "workflow",
          sourceId: "independent-during-recovery",
          label: "independent",
          status: "done",
          policy: "each",
          references: [{ label: "result", value: "done" }],
          completedAt: Date.now(),
        },
        current.owner,
      );
      expect(
        prepareCompletionManifest(current.owner)?.details.completionIds,
      ).toEqual(["workflow:independent-during-recovery"]);
      release();
      await recovering;
      expect(prepareCompletionManifest(current.owner)).toBeUndefined();
    } finally {
      release();
      inspect.mockRestore();
    }
  });

  it("terminally rejects a new workflow that cannot enter at capacity", async () => {
    const current = setup(1, "capacity-rejection");
    // Keep the error completion queued for the manifest assertion below.
    current.scope.parentStreaming = true;
    workflowJobRegistry.clear();
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      workflowJobRegistry.set(`occupied-${index}`, {
        id: `occupied-${index}`,
        status: "running",
        abort: new AbortController(),
        parentSessionOwner: current.owner,
      } as any);
    }
    const runner = successfulRunner("unused");
    const api = register(current, runner);
    const rejected = await api.run(
      {
        script: definition("capacity-rejected", "return true;"),
        completionPolicy: "group",
        completionGroupId: "capacity-group",
      },
      undefined,
      undefined,
      current.ctx,
    );
    expect(rejected.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    const ids = await WorkflowRunStore.list({
      cwd: root,
      sessionId: "workflow-v4",
      root,
    });
    const events = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      ids[0],
    );
    expect(events?.map((event) => event.kind)).toContain("accepted");
    expect(events?.at(-1)).toMatchObject({
      kind: "rejected",
      data: { status: "rejected", reason: "capacity" },
    });
    expect(workflowJobRegistry.has(ids[0])).toBe(false);
    sealCompletionGroups(current.owner);
    expect(
      prepareCompletionManifest(current.owner)?.details.completionIds,
    ).toContain(`workflow:${ids[0]}`);
    expect(workflowJobRegistry.size).toBe(MAX_WORKFLOW_JOBS);
  });

  it("keeps an accepted workflow resumable after capacity rejection", async () => {
    const current = setup(1, "resume-capacity-rejection");
    const groupId = "resume-capacity-group";
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "resume-capacity-rejection",
        script: definition("resume-capacity", "return true;"),
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "group", groupId },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 60_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("delivery", {
      completion: { legacy: false, policy: "group", groupId },
      parentSessionId: "resume-capacity-rejection",
    });
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    const runner = successfulRunner("resumed");
    register(current, runner);
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      workflowJobRegistry.set(`occupied-${index}`, {
        id: `occupied-${index}`,
        status: "running",
        abort: new AbortController(),
        parentSessionOwner: current.owner,
      } as any);
    }
    const rejected = await executeTool(
      current.tools,
      "resume_workflow",
      { workflowId, async: true },
      current.ctx,
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.details.error).toContain(
      "workflow jobs are retained or running",
    );
    expect(runner).not.toHaveBeenCalled();
    const events = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(events?.some((event) => event.kind === "accepted")).toBe(true);
    expect(events?.some((event) => event.kind === "rejected")).toBe(false);
    expect(workflowJobRegistry.has(workflowId)).toBe(false);
    expect(workflowJobRegistry.size).toBe(MAX_WORKFLOW_JOBS);
    workflowJobRegistry.clear();
    const resumed = await executeTool(
      current.tools,
      "resume_workflow",
      { workflowId, async: true },
      current.ctx,
    );
    expect(resumed.details.status).toBe("started");
    await expect(
      workflowJobRegistry.get(workflowId)!.promise,
    ).resolves.toMatchObject({
      result: true,
    });
  });

  it("answers a background gate through Pi UI and completes without model-supplied input", async () => {
    const confirm = vi.fn(async () => true);
    const current = setup(1, "gate-parent", { confirm });
    const api = register(current, successfulRunner("unused"));
    const response = await api.run(
      {
        script: definition(
          "background-gate",
          'await ctx.gate("approval", { title: "Approve deploy?", summary: "Deploy to prod" }); return { approved: true };',
        ),
      },
      undefined,
      undefined,
      current.ctx,
    );
    expect(response.details.status).toBe("started");
    const workflowId = response.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    await waitForWorkflowWorker(() =>
      expect(
        job.snapshot.steps?.some((step) => step.status === "waiting_for_input"),
      ).toBe(true),
    );
    const waiting = job.snapshot.steps!.find(
      (step) => step.status === "waiting_for_input",
    )!;

    const answerTool = current.tools.get("respond_workflow_input");
    expect(Object.keys(answerTool.parameters.properties)).toEqual([
      "workflowId",
      "path",
    ]);
    await executeTool(
      current.tools,
      "respond_workflow_input",
      { workflowId, path: waiting.path, answer: false },
      current.ctx,
    );
    await expect(job.promise).resolves.toMatchObject({
      result: { approved: true },
    });
    expect(confirm).toHaveBeenCalledWith("Approve deploy?", "Deploy to prod", {
      signal: undefined,
    });
    expect(job.status).toBe("done");
    const listed = await executeTool(
      current.tools,
      "list_workflow_runs",
      {},
      current.ctx,
    );
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({ workflowId, status: "done" }),
    );
  });

  it("lists and resumes project-scoped v4 work in a fresh parent session with its new runner", async () => {
    const first = setup(1, "first-parent");
    let signalStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const oldRunner: WorkflowAgentRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signalStarted();
        signal!.addEventListener(
          "abort",
          () => reject(new Error("parent replaced")),
          { once: true },
        );
      });
    const firstApi = register(first, oldRunner);
    const started = await firstApi.run(
      {
        script: definition(
          "project-resume",
          'const agent = await ctx.agent("answer", { prompt: "answer it" }); return { answer: agent };',
        ),
      },
      undefined,
      undefined,
      first.ctx,
    );
    const workflowId = started.details.workflowId;
    const interruptedJob = workflowJobRegistry.get(workflowId)!;
    await firstStarted;
    cleanupWorkflowJobsForOwner(first.owner);
    await expect(interruptedJob.promise).rejects.toThrow();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const second = setup(2, "second-parent");
    const newRunner = successfulRunner("new-parent-answer");
    register(second, newRunner);
    const listed = await executeTool(
      second.tools,
      "list_workflow_runs",
      {},
      second.ctx,
    );
    expect(listed.details.runs).toContainEqual(
      expect.objectContaining({ workflowId, durable: true }),
    );
    const resumed = await executeTool(
      second.tools,
      "resume_workflow",
      { workflowId, async: false },
      second.ctx,
    );
    expect(resumed.details.status).toBe("done");
    expect(newRunner).toHaveBeenCalledOnce();
    expect(resumed.content[0].text).toContain("new-parent-answer");
    const saved = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(saved?.some((event) => event.kind === "terminal")).toBe(true);
  });

  it.each(["resume_workflow", "respond_workflow_input"])(
    "preserves a gate across session shutdown before %s",
    async (toolName) => {
      const first = setup(1, "gate-before-shutdown");
      const firstApi = register(first, successfulRunner("unused"));
      const started = await firstApi.run(
        {
          script: definition(
            "interrupted-gate",
            'const approved = await ctx.gate("approval", { title: "Proceed?" }); return { approved };',
          ),
        },
        undefined,
        undefined,
        first.ctx,
      );
      const workflowId = started.details.workflowId;
      const interruptedJob = workflowJobRegistry.get(workflowId)!;
      await waitForWorkflowWorker(() =>
        expect(
          getLiveWorkflowV4Store(workflowId)?.getStep(["approval"])?.status,
        ).toBe("waiting_for_input"),
      );
      cleanupWorkflowJobsForOwner(first.owner);
      await expect(interruptedJob.promise).rejects.toThrow();
      clearCompletionCoordinator(first.owner);
      clearSessionScopes();

      const second = setup(2, "gate-after-shutdown", {
        confirm: vi.fn(async () => true),
      });
      register(second, successfulRunner("unused"));
      const resumed = await executeTool(
        second.tools,
        toolName,
        toolName === "resume_workflow"
          ? { workflowId, async: false }
          : { workflowId, path: ["approval"] },
        second.ctx,
      );
      expect(resumed.isError, resumed.content[0]?.text).not.toBe(true);
      if (toolName === "resume_workflow") {
        expect(resumed.details.status).toBe("done");
        expect(JSON.parse(resumed.content[0].text)).toEqual({ approved: true });
      } else {
        const job = workflowJobRegistry.get(workflowId)!;
        await expect(job.promise).resolves.toMatchObject({
          result: { approved: true },
        });
      }
      const events = await WorkflowRunStore.inspect(
        { cwd: root, sessionId: "workflow-v4", root },
        workflowId,
      );
      expect(
        events?.filter((event) => event.kind === "v4.step").at(-1)?.data,
      ).toMatchObject({ path: ["approval"], attempt: 1, status: "completed" });
    },
  );

  it("answers a persisted gate after reopening the project run and resumes it", async () => {
    const first = setup(1, "gate-before-reopen");
    const script = definition(
      "persisted-gate",
      'const accepted = await ctx.gate("approval", { title: "Resume deploy?", summary: "Continue after restart" }); return { accepted };',
    );
    const projectScope = { cwd: root, sessionId: "workflow-v4", root };
    const persisted = await WorkflowRunStore.create(projectScope, {
      parentSessionId: "gate-before-reopen",
      script,
      args: encodeRunValue({}),
      budgetTotal: 1000,
      completion: { legacy: false, policy: "each" },
      concurrency: 4,
      processConcurrency: 4,
      workflowTimeoutMs: 60_000,
    });
    const workflowId = persisted.id;
    await persisted.append("accepted", {});
    await persisted.append("delivery", {
      completion: { legacy: false, policy: "each" },
    });
    const durable = new DurableWorkflow(persisted);
    const interruptedRun = runWorkflow(script, {
      args: {},
      cwd: root,
      durable,
      budgetTotal: 1000,
      runAgent: successfulRunner("unused"),
    });
    await waitForWorkflowWorker(() =>
      expect(
        getLiveWorkflowV4Store(workflowId)
          ?.snapshot()
          .some((step) => step.status === "waiting_for_input"),
      ).toBe(true),
    );
    const waiting = getLiveWorkflowV4Store(workflowId)!
      .snapshot()
      .find((step) => step.status === "waiting_for_input")!;
    getLiveWorkflowV4Store(workflowId)!.close();
    await expect(interruptedRun).rejects.toThrow();
    durable.stop();
    await durable.drain();
    await persisted.close();
    clearCompletionCoordinator(first.owner);
    clearSessionScopes();

    const confirm = vi.fn(async () => true);
    const second = setup(2, "gate-after-reopen", { confirm });
    register(second, successfulRunner("unused"));
    const answer = await executeTool(
      second.tools,
      "respond_workflow_input",
      { workflowId, path: waiting.path },
      second.ctx,
    );
    expect(answer.details.status, answer.content[0]?.text).toBe("started");
    const reopenedEvents = await WorkflowRunStore.inspect(
      { cwd: root, sessionId: "workflow-v4", root },
      workflowId,
    );
    expect(
      reopenedEvents?.filter((event) => event.kind === "v4.step").at(-1)?.data,
    ).toMatchObject({ status: "running", answer: true });
    const resumedJob = workflowJobRegistry.get(workflowId)!;
    await waitForWorkflowWorker(() =>
      expect(resumedJob.status, JSON.stringify(resumedJob.snapshot.steps)).toBe(
        "done",
      ),
    );
    await expect(resumedJob.promise).resolves.toMatchObject({
      result: { accepted: true },
    });
    expect(confirm).toHaveBeenCalledWith(
      "Resume deploy?",
      "Continue after restart",
      { signal: undefined },
    );
  });

  it("restores the configured execution timeout when resuming after a long interruption", async () => {
    const current = setup(1, "after-long-pause");
    const script = definition("long-pause", "return { resumed: true };");
    const store = await WorkflowRunStore.create(
      { cwd: root, sessionId: "workflow-v4", root },
      {
        parentSessionId: "before-long-pause",
        script,
        args: encodeRunValue({}),
        budgetTotal: 1000,
        completion: { legacy: false, policy: "each" },
        concurrency: 4,
        processConcurrency: 4,
        workflowTimeoutMs: 5_000,
      },
    );
    const workflowId = store.id;
    await store.append("accepted", {});
    await store.append("interrupted", { status: "interrupted" });
    await store.close();
    const api = register(current, successfulRunner("unused"));
    const start = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(start + 60_000);
    try {
      const resumed = await api.run(
        { workflowId, async: false },
        undefined,
        undefined,
        current.ctx,
      );
      expect(resumed.details.status, resumed.content[0]?.text).toBe("done");
      expect(resumed.content[0].text).toContain('"resumed":true');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("routes a synchronous gate through the UI prompt callback", async () => {
    const confirm = vi.fn(async () => true);
    const current = setup(1, "sync-gate", { confirm });
    const api = register(current, successfulRunner("unused"));
    const execution = api.run(
      {
        script: definition(
          "sync-gate",
          'await ctx.gate("approval", { title: "Proceed?", summary: "Run sync step" }); return "complete";',
        ),
        async: false,
      },
      undefined,
      undefined,
      current.ctx,
    );
    await waitForWorkflowWorker(() => expect(confirm).toHaveBeenCalledOnce());
    const result = await execution;
    expect(result.content[0].text).toContain("complete");
    expect(confirm).toHaveBeenCalledWith("Proceed?", "Run sync step", {
      signal: expect.any(AbortSignal),
    });
  });

  it("supports human gates without durable storage in sync and async runs", async () => {
    const confirm = vi.fn(async () => true);
    const current = setup(1, "non-durable-gates", { confirm });
    registerWorkflowTool(current.pi, current.scope);
    const script = definition(
      "non-durable-gates",
      'const approved = await ctx.gate("approval", { title: "Proceed?", summary: "No journal" }); return { approved };',
    );
    const asyncRun = await executeTool(
      current.tools,
      "workflow",
      { script, async: true },
      current.ctx,
    );
    const workflowId = asyncRun.details.workflowId;
    const job = workflowJobRegistry.get(workflowId)!;
    expect(asyncRun.details.status).toBe("started");
    expect(asyncRun.details.durable).toBeUndefined();
    expect(job.durable).toBeUndefined();
    await waitForWorkflowWorker(() =>
      expect(
        job.snapshot.steps?.some((step) => step.status === "waiting_for_input"),
      ).toBe(true),
    );
    const waiting = job.snapshot.steps!.find(
      (step) => step.status === "waiting_for_input",
    )!;
    const answered = await executeTool(
      current.tools,
      "respond_workflow_input",
      { workflowId, path: waiting.path },
      current.ctx,
    );
    expect(answered.details.status).toBe("running");
    await expect(job.promise).resolves.toMatchObject({
      result: { approved: true },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    const sync = await executeTool(
      current.tools,
      "workflow",
      { script, durable: false, async: false },
      current.ctx,
    );
    expect(sync.details.status).toBe("done");
    expect(sync.content[0].text).toContain('"approved":true');
  });

  it("serializes parallel non-durable synchronous human prompts", async () => {
    let releaseFirst!: (value: boolean) => void;
    let releaseSecond!: (value: boolean) => void;
    const firstAnswer = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const secondAnswer = new Promise<boolean>((resolve) => {
      releaseSecond = resolve;
    });
    const confirm = vi
      .fn()
      .mockImplementationOnce(() => firstAnswer)
      .mockImplementationOnce(() => secondAnswer);
    const current = setup(1, "parallel-nondurable-gates", { confirm });
    registerWorkflowTool(current.pi, current.scope);
    const execution = executeTool(
      current.tools,
      "workflow",
      {
        durable: false,
        async: false,
        script: definition(
          "parallel-nondurable-gates",
          'const approvals = await Promise.all([ctx.gate("first", { title: "First?" }), ctx.gate("second", { title: "Second?" })]); return approvals;',
        ),
      },
      current.ctx,
    );
    try {
      await waitForWorkflowWorker(() => expect(confirm).toHaveBeenCalledOnce());
      expect(confirm).toHaveBeenCalledTimes(1);
      releaseFirst(true);
      await waitForWorkflowWorker(() =>
        expect(confirm).toHaveBeenCalledTimes(2),
      );
      releaseSecond(true);
      const result = await execution;
      expect(result.details.status).toBe("done");
      expect(confirm).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst(true);
      releaseSecond(true);
    }
  });
  it("shows every nested durable wait path in registered model-visible tools before and after reopening", async () => {
    vi.stubEnv("HOME", root);
    const current = setup(1, "durable-wait-path", {
      input: vi.fn(async () => "PRIVATE_ANSWER_VALUE"),
    });
    clearCompletionCoordinator(sessionOwner(current.scope));
    registerCompletionCoordinator(current.pi, current.scope);
    const expectedPaths = [
      ["review-bundle", "static-review"],
      ["review-bundle", "dynamic-customer-47"],
    ];
    const script = definition(
      "durable-wait-path",
      `await ctx.step("private-step", async () => "PRIVATE_STEP_VALUE");
       await ctx.group("review-bundle", async () => {
         await ctx.ask("answered-input", {
           type: "input",
           question: "Capture a private value",
         });
         await Promise.all([
          ctx.gate("static-review", {
            title: "Review the general changes",
            summary: "Wait for the first decision",
          }),
          ctx.gate("dynamic-customer-47", {
            title: "Review customer",
            summary: "Wait for the next decision",
          }),
         ]);
       });
       return "complete";`,
    );
    try {
      registerWorkflowTool(current.pi, current.scope);
      const started = await executeTool(
        current.tools,
        "workflow",
        { script, durable: true, async: true },
        current.ctx,
      );
      const workflowId = started.details.workflowId;
      const job = workflowJobRegistry.get(workflowId)!;
      await waitForWorkflowWorker(() =>
        expect(
          job.snapshot.steps?.some(
            (step) =>
              step.status === "waiting_for_input" &&
              JSON.stringify(step.path) ===
                JSON.stringify(["review-bundle", "answered-input"]),
          ),
        ).toBe(true),
      );
      const answered = await executeTool(
        current.tools,
        "respond_workflow_input",
        { workflowId, path: ["review-bundle", "answered-input"] },
        current.ctx,
      );
      expect(answered.details.status).toBe("running");
      await waitForWorkflowWorker(() =>
        expect(
          job.snapshot.steps
            ?.filter((step) => step.status === "waiting_for_input")
            .map((step) => step.path),
        ).toEqual(expect.arrayContaining(expectedPaths)),
      );

      const recordOf = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      const stringPath = (value: unknown): value is string[] =>
        Array.isArray(value) &&
        value.every((segment: unknown) => typeof segment === "string");
      const waitingSteps = (value: unknown): { path: string[] }[] =>
        Array.isArray(value)
          ? value.flatMap((step) => {
              const path = recordOf(step)?.path;
              return stringPath(path) ? [{ path }] : [];
            })
          : [];
      const statusWaiting = (details: unknown) =>
        waitingSteps(recordOf(details)?.waiting);
      const listWaiting = (details: unknown): { path: string[] }[] => {
        const runs = recordOf(details)?.runs;
        return Array.isArray(runs)
          ? runs.flatMap((run) => {
              const record = recordOf(run);
              if (!record || record.workflowId !== workflowId) return [];
              return waitingSteps(record.waiting);
            })
          : [];
      };
      const assertWaitingPathsAreModelVisible = (
        response: unknown,
        selectWaiting: (details: unknown) => { path: string[] }[],
      ) => {
        const result = recordOf(response);
        const content = Array.isArray(result?.content) ? result.content : [];
        const text = content
          .map((item) => {
            const record = recordOf(item);
            return typeof record?.text === "string" ? record.text : "";
          })
          .join("\n");
        const serialized = JSON.stringify(response) ?? "";
        const waiting = selectWaiting(result?.details);
        expect(text).toContain("respond_workflow_input");
        for (const step of waiting) {
          expect(text).toContain(JSON.stringify(step.path));
        }
        for (const path of expectedPaths) {
          expect(waiting.map((step) => step.path)).toContainEqual(path);
          expect(text).toContain(JSON.stringify(path));
        }
        expect(serialized).not.toContain("PRIVATE_ANSWER_VALUE");
        expect(serialized).not.toContain("PRIVATE_STEP_VALUE");
      };
      const liveStatus = await executeTool(
        current.tools,
        "get_workflow_status",
        { workflowId },
        current.ctx,
      );
      const liveList = await executeTool(
        current.tools,
        "list_workflow_runs",
        {},
        current.ctx,
      );
      assertWaitingPathsAreModelVisible(liveStatus, statusWaiting);
      assertWaitingPathsAreModelVisible(liveList, listWaiting);
      const oldOwner = sessionOwner(current.scope);
      cleanupWorkflowJobsForOwner(oldOwner);
      await expect(job.promise).rejects.toThrow();
      clearCompletionCoordinator(oldOwner);
      current.scope.generation++;
      registerCompletionCoordinator(current.pi, current.scope);
      registerWorkflowTool(current.pi, current.scope);

      const reopenedStatus = await executeTool(
        current.tools,
        "get_workflow_status",
        { workflowId },
        current.ctx,
      );
      const reopenedList = await executeTool(
        current.tools,
        "list_workflow_runs",
        {},
        current.ctx,
      );
      assertWaitingPathsAreModelVisible(reopenedStatus, statusWaiting);
      assertWaitingPathsAreModelVisible(reopenedList, listWaiting);
    } finally {
      clearCompletionCoordinator(sessionOwner(current.scope));
      vi.unstubAllEnvs();
    }
  });

  it("exposes waits beyond the 256-step presentation cap on live and reopened tools", async () => {
    vi.stubEnv("HOME", root);
    const current = setup(1, "wait-path-presentation-cap");
    const expectedPath = ["review-bundle", "dynamic-customer-47"];
    const holdPath = ["review-bundle", "shared-hold"];
    const expectedWaitPaths = [holdPath, expectedPath];
    try {
      registerWorkflowTool(current.pi, current.scope);
      const script = definition(
        "wait-path-presentation-cap",
        `await ctx.group("review-bundle", async () => {
       const hold = ctx.gate("shared-hold", {
         title: "Hold presentation groups",
         summary: "Wait for the test to inspect nested workflow paths",
       });
       const pending = [];
       for (let index = 0; index < 256; index++) {
         pending.push(ctx.group(\`presentation-\${index}\`, async () => {
           await hold;
           return "released";
         }));
       }
       const review = ctx.gate("dynamic-customer-47", {
         title: "Review the hidden nested wait",
         summary: "This gate follows more active steps than the display limit",
       });
       await Promise.all([hold, review, Promise.all(pending)]);
     });
     return "complete";`,
      );
      const started = await executeTool(
        current.tools,
        "workflow",
        { script, durable: true, async: true },
        current.ctx,
      );
      expect(started.details, JSON.stringify(started)).toMatchObject({
        status: "started",
        durable: true,
      });
      const workflowId = started.details.workflowId;
      expect(workflowId, JSON.stringify(started)).toEqual(expect.any(String));
      const job = workflowJobRegistry.get(workflowId);
      expect(
        job,
        JSON.stringify({
          started,
          workflowId,
          job: job && {
            id: job.id,
            status: job.status,
            error: job.error,
          },
        }),
      ).toBeDefined();
      if (!job) throw new Error("Workflow start did not publish its job.");
      expect(job.id).toBe(workflowId);
      expect(
        { status: job.status, error: job.error },
        JSON.stringify({
          started,
          workflowId,
          job: { id: job.id, status: job.status, error: job.error },
        }),
      ).toEqual({ status: "running", error: undefined });
      const liveStore = getLiveWorkflowV4Store(workflowId);
      expect(
        liveStore,
        JSON.stringify({
          started,
          workflowId,
          job: { id: job.id, status: job.status, error: job.error },
        }),
      ).toBeDefined();
      if (!liveStore)
        throw new Error("Workflow start did not publish its live V4 store.");
      await waitForWorkflowWorker(() => {
        for (let index = 0; index < 256; index++) {
          expect(
            liveStore.getStep(["review-bundle", `presentation-${index}`])
              ?.status,
          ).toBe("running");
        }
        for (const path of expectedWaitPaths) {
          expect(liveStore.getStep(path)?.status, JSON.stringify(path)).toBe(
            "waiting_for_input",
          );
        }
        expect(
          job.snapshot.steps?.some(
            (step) =>
              JSON.stringify(step.path) === JSON.stringify(expectedPath),
          ),
        ).toBe(false);
      });

      const asRecord = (value: unknown): Record<string, unknown> | undefined =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      const assertActionablePaths = (response: unknown) => {
        const result = asRecord(response);
        const content = Array.isArray(result?.content) ? result.content : [];
        const text = content
          .map((item) => {
            const record = asRecord(item);
            return typeof record?.text === "string" ? record.text : "";
          })
          .join("\n");
        const details = asRecord(result?.details);
        const summary = Array.isArray(details?.runs)
          ? details.runs
              .map(asRecord)
              .find((run) => run?.workflowId === workflowId)
          : details;
        expect(summary).toBeDefined();
        const structured = summary ?? {};
        const detailsPaths = Array.isArray(structured.waiting)
          ? structured.waiting.flatMap((step) => {
              const path = asRecord(step)?.path;
              return Array.isArray(path) &&
                path.every((segment) => typeof segment === "string")
                ? [path as string[]]
                : [];
            })
          : [];
        const remainderCount =
          typeof structured.waitingRemainderCount === "number"
            ? structured.waitingRemainderCount
            : 0;
        const actionArgs = text.split("\n").flatMap((line) => {
          const match = line.match(/respond_workflow_input\((\{.*?\})\)/);
          return match ? [JSON.parse(match[1]) as Record<string, unknown>] : [];
        });
        const actionPaths = actionArgs.map((action) => {
          expect(action.workflowId).toBe(workflowId);
          expect(Array.isArray(action.path)).toBe(true);
          return action.path as string[];
        });
        expect(
          actionPaths,
          JSON.stringify({
            text,
            summary: {
              status: structured.status,
              waiting: structured.waiting,
              waitingRemainderCount: structured.waitingRemainderCount,
            },
          }),
        ).toContainEqual(expectedPath);
        expect(actionPaths).toEqual(detailsPaths);
        expect(
          new Set(actionPaths.map((path) => JSON.stringify(path))).size,
        ).toBe(actionPaths.length);
        for (const path of actionPaths) {
          expect(expectedWaitPaths).toContainEqual(path);
        }
        expect(actionPaths.length + remainderCount).toBe(
          expectedWaitPaths.length,
        );
        const totalMatch = text.match(/Waiting for input at (\d+) step\(s\):/);
        expect(Number(totalMatch?.[1])).toBe(expectedWaitPaths.length);
        const remainderMatch = text.match(
          /(\d+) additional waiting path\(s\) not listed/,
        );
        expect(Number(remainderMatch?.[1] ?? 0)).toBe(remainderCount);
        expect(
          expectedWaitPaths.filter(
            (path) =>
              !actionPaths.some(
                (actionPath) =>
                  JSON.stringify(actionPath) === JSON.stringify(path),
              ),
          ),
        ).toHaveLength(remainderCount);
      };
      assertActionablePaths(
        await executeTool(
          current.tools,
          "get_workflow_status",
          { workflowId },
          current.ctx,
        ),
      );
      assertActionablePaths(
        await executeTool(current.tools, "list_workflow_runs", {}, current.ctx),
      );

      const oldOwner = sessionOwner(current.scope);

      job.suppressCompletionNotification = true;
      job.durableInterrupted = true;
      job.abort.abort(
        Object.assign(new Error("Workflow durably interrupted."), {
          source: "durable_interrupt",
        }),
      );
      await expect(job.promise).rejects.toThrow();
      workflowJobRegistry.delete(workflowId);
      clearCompletionCoordinator(oldOwner);
      current.scope.generation++;
      registerCompletionCoordinator(current.pi, current.scope);
      registerWorkflowTool(current.pi, current.scope);
      assertActionablePaths(
        await executeTool(
          current.tools,
          "get_workflow_status",
          { workflowId },
          current.ctx,
        ),
      );
      assertActionablePaths(
        await executeTool(current.tools, "list_workflow_runs", {}, current.ctx),
      );
    } finally {
      clearCompletionCoordinator(sessionOwner(current.scope));
      vi.unstubAllEnvs();
    }
  });

  it("bounds serialized waiting actions for deep paths across public tools", async () => {
    vi.stubEnv("HOME", root);
    const current = setup(1, "deep-bounded-wait-paths");
    const actionBudgetBytes = 16 * 1024;
    const longSegment = (prefix: string) =>
      `${prefix}${"x".repeat(128 - prefix.length)}`;
    const groupIds = Array.from({ length: 31 }, (_, index) =>
      longSegment(`group-${String(index).padStart(2, "0")}-`),
    );
    const gateIdsByRun = Array.from({ length: 2 }, (_, runIndex) =>
      Array.from({ length: 5 }, (_, gateIndex) =>
        longSegment(`gate-${runIndex}-${gateIndex}-`),
      ),
    );
    const pathsByRun = gateIdsByRun.map((gateIds) =>
      gateIds.map((gateId) => [...groupIds, gateId]),
    );
    const makeScript = (name: string, gateIds: string[]) => {
      const gateCalls = gateIds.map(
        (gateId) =>
          `ctx.gate(${JSON.stringify(gateId)}, { title: "Review", summary: "Waiting for review" })`,
      );
      let body = `await Promise.all([${gateCalls.join(",")}]);`;
      for (let index = groupIds.length - 1; index >= 0; index--) {
        body = `await ctx.group(${JSON.stringify(groupIds[index])}, async () => { ${body} });`;
      }
      return definition(name, `${body} return "complete";`);
    };
    const asRecord = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const contentText = (response: unknown) => {
      const result = asRecord(response);
      const content = Array.isArray(result?.content) ? result.content : [];
      return content
        .map((item) => {
          const record = asRecord(item);
          return typeof record?.text === "string" ? record.text : "";
        })
        .join("\n");
    };
    const toolCalls = (text: string, name: string) => {
      const pattern = new RegExp(`${name}\\(\\s*(\\{[^\\n]*?\\})\\s*\\)`, "g");
      return [...text.matchAll(pattern)].map((match) => ({
        raw: match[0],
        args: JSON.parse(match[1]) as Record<string, unknown>,
      }));
    };
    const recordPaths = (value: unknown): string[][] =>
      Array.isArray(value)
        ? value.flatMap((item) => {
            const path = asRecord(item)?.path;
            return Array.isArray(path) &&
              path.every((part) => typeof part === "string")
              ? [path as string[]]
              : [];
          })
        : [];
    const summariesFor = (response: unknown) => {
      const details = asRecord(asRecord(response)?.details);
      return Array.isArray(details?.runs)
        ? details.runs
            .map(asRecord)
            .filter(
              (summary): summary is Record<string, unknown> =>
                summary !== undefined,
            )
        : details
          ? [details]
          : [];
    };
    const jobs: { promise: Promise<unknown> }[] = [];
    const runInfos: { workflowId: string; paths: string[][] }[] = [];
    try {
      registerWorkflowTool(current.pi, current.scope);
      const durable = registerDurableWorkflowTools(
        current.pi,
        () => sessionOwner(current.scope),
        () => successfulRunner("unused"),
        () => true,
        root,
      );
      for (const [index, gateIds] of gateIdsByRun.entries()) {
        const started = await durable.run(
          {
            script: makeScript(`deep-bounded-wait-${index}`, gateIds),
            async: true,
          },
          undefined,
          undefined,
          current.ctx,
        );
        const workflowId = started.details.workflowId;
        runInfos.push({
          workflowId,
          paths: pathsByRun[index],
        });
        const job = workflowJobRegistry.get(workflowId);
        expect(job).toBeDefined();
        if (job) jobs.push(job);
      }

      for (const paths of pathsByRun) {
        for (const path of paths) {
          expect(path).toHaveLength(32);
          expect(path.every((part) => part.length === 128)).toBe(true);
        }
      }
      await waitForWorkflowWorker(() => {
        for (const run of runInfos) {
          const liveStore = getLiveWorkflowV4Store(run.workflowId);
          expect(liveStore).toBeDefined();
          for (const path of run.paths) {
            expect(liveStore?.getStep(path)?.status, JSON.stringify(path)).toBe(
              "waiting_for_input",
            );
          }
        }
      });

      const assertBoundedSurface = (
        response: unknown,
        targetRuns: typeof runInfos,
        maxActionBytes: number,
      ) => {
        const text = contentText(response);
        const actions = toolCalls(text, "respond_workflow_input");
        const actionBytes = Buffer.byteLength(
          actions.map((action) => action.raw).join("\n"),
          "utf8",
        );
        expect(actionBytes).toBeLessThanOrEqual(maxActionBytes);
        const summaries = summariesFor(response);
        let totalWaiting = 0;
        let totalOmitted = 0;
        const omittedRunIds: string[] = [];
        for (const run of targetRuns) {
          totalWaiting += run.paths.length;
          const visible = actions.filter(
            (action) => action.args.workflowId === run.workflowId,
          );
          const visiblePaths = visible.map(
            (action) => action.args.path as string[],
          );
          expect(visiblePaths.length).toBeLessThan(run.paths.length);
          expect(
            new Set(visiblePaths.map((path) => JSON.stringify(path))).size,
          ).toBe(visiblePaths.length);
          for (const path of visiblePaths) {
            expect(run.paths).toContainEqual(path);
          }
          const omitted = run.paths.length - visiblePaths.length;
          totalOmitted += omitted;
          if (omitted > 0) omittedRunIds.push(run.workflowId);
          const summary = summaries.find(
            (candidate) => candidate.workflowId === run.workflowId,
          );
          expect(summary?.waitingRemainderCount).toBe(omitted);
          expect(recordPaths(summary?.waiting)).toEqual(visiblePaths);
        }
        expect(actions.length).toBeGreaterThan(0);
        const totalMatches = [
          ...text.matchAll(/Waiting for input at (\d+) step\(s\):/g),
        ];
        expect(
          totalMatches.reduce((sum, match) => sum + Number(match[1]), 0),
        ).toBe(totalWaiting);
        const remainderMatches = [
          ...text.matchAll(/(\d+) additional waiting path\(s\) not listed/g),
        ];
        expect(
          remainderMatches.reduce((sum, match) => sum + Number(match[1]), 0),
        ).toBe(totalOmitted);
        const statusSelectors = toolCalls(text, "get_workflow_status").map(
          (call) => call.args.workflowId,
        );
        for (const workflowId of omittedRunIds) {
          expect(statusSelectors).toContain(workflowId);
        }
      };

      for (const run of runInfos) {
        const status = await executeTool(
          current.tools,
          "get_workflow_status",
          { workflowId: run.workflowId },
          current.ctx,
        );
        assertBoundedSurface(status, [run], actionBudgetBytes);
      }
      const listed = await executeTool(
        current.tools,
        "list_workflow_runs",
        {},
        current.ctx,
      );
      assertBoundedSurface(listed, runInfos, actionBudgetBytes);
    } finally {
      cleanupWorkflowJobsForOwner(sessionOwner(current.scope));
      await Promise.allSettled(jobs.map((job) => job?.promise));
      clearCompletionCoordinator(sessionOwner(current.scope));
      vi.unstubAllEnvs();
    }
  });
});
