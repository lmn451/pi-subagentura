import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobState, SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import {
  getDurableWorkflowPlanController,
  flushDurableWorkflowDeliveries,
  registerDurableWorkflowRunAgentFactory,
  startDurableWorkflowSession,
  stopDurableWorkflowSession,
} from "../src/workflow-durable-runtime";
import {
  getWorkflowJobForOwner,
  workflowJobsForOwner,
  workflowJobRegistry,
} from "../src/workflow-jobs";
import { validateWorkflowPlan } from "../src/workflow-plan";
import { registerSessionHandlers } from "../src/session-handlers";
import {
  clearSessionScopes,
  createSessionScope,
  type SessionScope,
} from "../src/session-scope";

function success(output: string): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

const plan = validateWorkflowPlan({
  name: "runtime-recovery",
  description: "durable runtime lifecycle coverage",
  phases: [
    {
      id: "phase-a",
      name: "Phase A",
      mode: "sequence",
      tasks: [
        { id: "task-a", content: "Task A", instruction: "run-a" },
        { id: "task-b", content: "Task B", instruction: "run-b" },
      ],
    },
  ],
});

type TestIsolation = "in-process" | "process";

function isolatedPlan(
  name: string,
  instructions: readonly string[],
  isolation: TestIsolation,
) {
  return validateWorkflowPlan({
    name,
    description: `${name} durable concurrency coverage`,
    phases: [
      {
        id: "phase",
        name: "Phase",
        mode: "sequence",
        tasks: instructions.map((instruction, index) => ({
          id: `task-${index}`,
          content: `Task ${index}`,
          instruction,
          agent: { isolation },
        })),
      },
    ],
  });
}

interface TestSessionContext {
  readonly cwd: string;
  readonly ui?: {
    setStatus: (...args: unknown[]) => unknown;
    setWidget: (...args: unknown[]) => unknown;
    notify: (...args: unknown[]) => unknown;
  };
  readonly sessionManager?: {
    getSessionId?: () => string;
    getEntries?: () => unknown[];
  };
}

type CapturedHandler = (...args: unknown[]) => unknown;

function createLifecycleHarness(): {
  readonly handlers: Map<string, CapturedHandler[]>;
  readonly scope: SessionScope;
} {
  const handlers = new Map<string, CapturedHandler[]>();
  const pi = {
    on: (name: string, handler: CapturedHandler) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { handlers, scope: registerSessionHandlers(pi) };
}

function manualScope(): SessionScope {
  const scope = createSessionScope({} as unknown as ExtensionAPI);
  scope.generation = 1;
  return scope;
}

function context(cwd: string, sessionId?: string): TestSessionContext {
  return {
    cwd,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    sessionManager:
      sessionId === undefined
        ? {}
        : { getSessionId: () => sessionId, getEntries: () => [] },
  };
}

describe("durable workflow session runtime", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), "workflow-durable-runtime-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    clearSessionScopes();
    const globalState = globalThis as typeof globalThis & {
      __piSubagenturaInteractivePollerHandle?: NodeJS.Timeout;
    };
    globalState.__piSubagenturaInteractivePollerHandle = undefined;
    workflowJobRegistry.clear();
  });

  afterEach(() => {
    const globalState = globalThis as typeof globalThis & {
      __piSubagenturaInteractivePollerHandle?: NodeJS.Timeout;
    };
    clearInterval(globalState.__piSubagenturaInteractivePollerHandle);
    clearSessionScopes();
    workflowJobRegistry.clear();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it("opens same-owner reload recovery and automatically resumes eligible work", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-session-a");
    let markTaskBStarted!: () => void;
    const taskBStarted = new Promise<void>((resolve) => {
      markTaskBStarted = resolve;
    });
    const firstRunner: WorkflowAgentRunner = async ({ prompt, signal }) => {
      if (prompt === "run-a") return success("committed-a");
      markTaskBStarted();
      return new Promise<SubagentResult>((resolve) => {
        const interrupted = () =>
          resolve({ ...success("interrupted-b"), cancelled: true });
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    };
    registerDurableWorkflowRunAgentFactory(scope, () => firstRunner, {
      homeDir: home,
    });

    await startDurableWorkflowSession(scope, "startup", ctx);
    const first = getDurableWorkflowPlanController(scope);
    expect(first).toBeDefined();
    const execution = await first!.startPlan({
      plan,
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await taskBStarted;

    const stopping = stopDurableWorkflowSession(scope, "reload");
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await stopping;

    const reloadCalls: string[] = [];
    const reloadRunner: WorkflowAgentRunner = async ({ prompt }) => {
      reloadCalls.push(prompt);
      return success("recovered-b");
    };
    scope.generation++;
    registerDurableWorkflowRunAgentFactory(scope, () => reloadRunner, {
      homeDir: home,
    });
    const opened = await startDurableWorkflowSession(scope, "reload", ctx);

    expect(opened?.recovery.runs.map((run) => run.runId)).toContain(
      execution.runId,
    );
    expect(opened?.completions).toHaveLength(1);
    expect(opened?.completions[0]?.runId).toBe(execution.runId);
    await opened?.completions[0]?.completion;
    expect(reloadCalls).toEqual(["run-b"]);
    expect(
      await getDurableWorkflowPlanController(scope)?.getProjection(
        execution.runId,
      ),
    ).toMatchObject({ status: "done" });
    await stopDurableWorkflowSession(scope, "quit");
  });

  it.each(["in-process", "process"] as const)(
    "shares the namespace %s dispatcher across concurrent plans and scripts",
    async (isolation) => {
      const scope = manualScope();
      const ctx = context(cwd, `pi-shared-${isolation}`);
      const started: string[] = [];
      const releases = new Map<string, () => void>();
      let active = 0;
      let maximumActive = 0;
      const runner: WorkflowAgentRunner = async (request) => {
        const { prompt } = request;
        const processAttempt = request.workflowProcessAttempt;
        const assignment = {
          backend: "tmux" as const,
          paneId: `%${prompt}`,
          windowName: `shared-${prompt}`,
          muxSession: "shared-dispatcher-test",
          artifactDir: `/tmp/${prompt}`,
          sessionFile: `/tmp/${prompt}/session.jsonl`,
          launchScriptFile: `/tmp/${prompt}/launch.sh`,
        };
        if (processAttempt !== undefined) {
          await processAttempt.paneAssigned(assignment);
          await processAttempt.launchDispatched(assignment);
          await processAttempt.childStarted({
            schemaVersion: 1,
            identity: processAttempt.manifest.identity,
            launchMarker: processAttempt.manifest.launchMarker,
          });
        }
        started.push(prompt);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => releases.set(prompt, resolve));
        active -= 1;
        if (processAttempt !== undefined) {
          await processAttempt.terminal({
            identity: processAttempt.manifest.identity,
            status: "done",
            artifactEventId: `completion-${prompt}`,
            exitCode: 0,
          });
        }
        return success(`done:${prompt}`);
      };
      registerDurableWorkflowRunAgentFactory(scope, () => runner, {
        homeDir: home,
        concurrency: 1,
        processConcurrency: 1,
      });
      await startDurableWorkflowSession(scope, "startup", ctx);
      const controller = getDurableWorkflowPlanController(scope)!;

      const planExecution = await controller.startPlan({
        plan: isolatedPlan(
          `shared-plan-${isolation}`,
          [`plan-${isolation}`],
          isolation,
        ),
      });
      await vi.waitFor(() => expect(started).toEqual([`plan-${isolation}`]));
      const scriptExecution = await controller.startScript({
        cwd,
        script:
          `export const meta = { name: "shared-script-${isolation}", description: "test" };\n` +
          `return await agent("script-${isolation}", { id: "script-agent", isolation: "${isolation}" });`,
      });
      await vi.waitFor(
        async () => {
          const projection = await controller.getProjection(
            scriptExecution.runId,
          );
          expect(projection?.operations[0]?.attempts.at(-1)?.status).toBe(
            "started",
          );
        },
        { timeout: 5_000 },
      );
      expect(started).toEqual([`plan-${isolation}`]);

      releases.get(`plan-${isolation}`)?.();
      await vi.waitFor(() =>
        expect(started).toEqual([`plan-${isolation}`, `script-${isolation}`]),
      );
      releases.get(`script-${isolation}`)?.();
      await Promise.all([planExecution.completion, scriptExecution.completion]);

      expect(maximumActive).toBe(1);
      await stopDurableWorkflowSession(scope, "quit");
    },
  );

  it("replays a committed operation while the shared namespace dispatcher is full", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-replay-with-full-dispatcher");
    let markRetryTaskStarted!: () => void;
    const retryTaskStarted = new Promise<void>((resolve) => {
      markRetryTaskStarted = resolve;
    });
    const initialRunner: WorkflowAgentRunner = async ({ prompt, signal }) => {
      if (prompt === "replay-a") return success("committed-a");
      markRetryTaskStarted();
      return new Promise<SubagentResult>((resolve) => {
        const interrupted = () =>
          resolve({ ...success("interrupted-b"), cancelled: true });
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    };
    registerDurableWorkflowRunAgentFactory(scope, () => initialRunner, {
      homeDir: home,
      concurrency: 1,
      processConcurrency: 1,
    });
    await startDurableWorkflowSession(scope, "startup", ctx);
    const initialController = getDurableWorkflowPlanController(scope)!;
    const interrupted = await initialController.startPlan({
      plan: isolatedPlan(
        "replay-source",
        ["replay-a", "replay-b"],
        "in-process",
      ),
      resumePolicy: "trusted_resume",
    });
    await retryTaskStarted;
    const stopping = stopDurableWorkflowSession(scope, "reload");
    await expect(interrupted.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await stopping;

    scope.generation += 1;
    const resumedCalls: string[] = [];
    let markBlockerStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const resumedRunner: WorkflowAgentRunner = async ({ prompt }) => {
      resumedCalls.push(prompt);
      if (prompt === "blocker") {
        markBlockerStarted();
        await blocker;
      }
      return success(`done:${prompt}`);
    };
    registerDurableWorkflowRunAgentFactory(scope, () => resumedRunner, {
      homeDir: home,
      concurrency: 1,
      processConcurrency: 1,
    });
    await startDurableWorkflowSession(scope, "startup", ctx);
    const resumedController = getDurableWorkflowPlanController(scope)!;
    const blockerExecution = await resumedController.startPlan({
      plan: isolatedPlan("dispatcher-blocker", ["blocker"], "in-process"),
    });
    await blockerStarted;

    const resumed = await resumedController.trustedResume(interrupted.runId, {
      trustedActorId: "human-a",
    });
    await vi.waitFor(async () => {
      const projection = await resumedController.getProjection(
        interrupted.runId,
      );
      const operationA = projection?.operations.find(
        (operation) => operation.identity.operationId === "task-0",
      );
      const operationB = projection?.operations.find(
        (operation) => operation.identity.operationId === "task-1",
      );
      expect(operationA?.replays).toHaveLength(1);
      expect(operationB?.attempts).toHaveLength(2);
      expect(operationB?.attempts.at(-1)?.status).toBe("started");
    });
    expect(resumedCalls).toEqual(["blocker"]);

    releaseBlocker();
    await Promise.all([blockerExecution.completion, resumed.completion]);
    expect(resumedCalls).toEqual(["blocker", "replay-b"]);
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("restores non-approval durable runs into owner-scoped job listings", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-listing-session");
    const runner: WorkflowAgentRunner = async ({ prompt }) => success(prompt);
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await startDurableWorkflowSession(scope, "startup", ctx);
    const execution = await getDurableWorkflowPlanController(scope)!.startPlan({
      plan,
    });
    await execution.completion;
    await stopDurableWorkflowSession(scope, "reload");

    scope.generation += 1;
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    const opened = await startDurableWorkflowSession(scope, "reload", ctx);

    expect(opened?.recovery.runs).toHaveLength(1);
    const listingOwner = {
      id: scope.id,
      generation: scope.generation,
    };
    expect(getWorkflowJobForOwner(execution.runId, listingOwner)).toMatchObject(
      {
        id: execution.runId,
        kind: "plan",
        durable: true,
        status: "done",
        durableStatus: "done",
      },
    );
    expect(workflowJobsForOwner(listingOwner).map((job) => job.id)).toContain(
      execution.runId,
    );
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("surfaces malformed recovered runs as durable error jobs", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-corrupt-session");
    const runner: WorkflowAgentRunner = async ({ prompt }) => success(prompt);
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await startDurableWorkflowSession(scope, "startup", ctx);
    const controller = getDurableWorkflowPlanController(scope)!;
    const execution = await controller.startPlan({ plan });
    await execution.completion;
    const durableOwner = controller.owner;
    await stopDurableWorkflowSession(scope, "reload");
    appendFileSync(
      join(
        home,
        ".pi-subagentura",
        "workflow-runs",
        "v1",
        durableOwner.projectKey,
        durableOwner.piSessionKey,
        "runs",
        execution.runId,
        "events.ndjson",
      ),
      "{}\n",
    );

    scope.generation += 1;
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    const opened = await startDurableWorkflowSession(scope, "reload", ctx);
    const recovered = opened?.recovery.runs[0];
    const restored = getWorkflowJobForOwner(execution.runId, {
      id: scope.id,
      generation: scope.generation,
    });

    expect(recovered).toMatchObject({
      kind: "recovery_failed",
      failure: { code: "malformed_complete_line" },
    });
    expect(restored).toMatchObject({
      durable: true,
      status: "error",
      durableStatus: "error",
      recoveryFailure: { code: "malformed_complete_line" },
    });
    await expect(restored?.promise).rejects.toThrow(/malformed_complete_line/);
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("repairs a durable script result committed before its terminal event", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-script-terminal-gap");
    let resultOutputPublished = false;
    let eventAppendsAfterResult = 0;
    let injected = false;
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      {
        homeDir: home,
        storeOptions: {
          io: {
            before: (boundary, purpose) => {
              if (purpose === "output" && boundary === "publish") {
                resultOutputPublished = true;
              }
              if (
                resultOutputPublished &&
                purpose === "events" &&
                boundary === "append"
              ) {
                eventAppendsAfterResult += 1;
                if (eventAppendsAfterResult === 2 && !injected) {
                  injected = true;
                  throw new Error("injected script terminal append crash");
                }
              }
            },
          },
        },
      },
    );
    await startDurableWorkflowSession(scope, "startup", ctx);
    const first = getDurableWorkflowPlanController(scope)!;
    const execution = await first.startScript({
      cwd,
      script:
        'export const meta = { name: "terminal-gap", description: "test" };\n' +
        'return "committed-script-result";',
    });

    await expect(execution.completion).rejects.toThrow(
      "injected script terminal append crash",
    );
    const gapProjection = await first.getProjection(execution.runId);
    expect(gapProjection).toMatchObject({
      status: "running",
      result: {},
    });
    expect(gapProjection?.terminal).toBeUndefined();
    await stopDurableWorkflowSession(scope, "reload");

    scope.generation += 1;
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      { homeDir: home },
    );
    const opened = await startDurableWorkflowSession(scope, "reload", ctx);
    expect(opened?.completions).toHaveLength(0);
    const reopened = getDurableWorkflowPlanController(scope)!;
    expect(await reopened.getProjection(execution.runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
    });
    expect(await reopened.getResult(execution.runId)).toMatchObject({
      result: "committed-script-result",
    });
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("fences terminal delivery callbacks from an old session generation", async () => {
    const scope = manualScope();
    const dispatch = vi.fn(() => {
      throw new Error("injected crash after dispatch");
    });
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      {
        homeDir: home,
        delivery: { dispatch },
      },
    );
    await startDurableWorkflowSession(
      scope,
      "startup",
      context(cwd, "pi-session-a"),
    );
    const controller = getDurableWorkflowPlanController(scope)!;
    const execution = await controller.startPlan({ plan });
    await execution.completion;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      (await controller.getProjection(execution.runId))?.deliveries[0],
    ).toMatchObject({ state: "pending" });

    scope.generation += 1;
    await flushDurableWorkflowDeliveries(scope);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await stopDurableWorkflowSession(scope, "owner_replaced");
  });

  it("keeps delivery pending until a parent custom entry proves durability", async () => {
    const scope = manualScope();
    const entries: unknown[] = [];
    const ctx: TestSessionContext = {
      ...context(cwd, "pi-evidence-session"),
      sessionManager: {
        getSessionId: () => "pi-evidence-session",
        getEntries: () => entries,
      },
    };
    const dispatch = vi.fn();
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      {
        homeDir: home,
        delivery: { dispatch },
      },
    );
    await startDurableWorkflowSession(scope, "startup", ctx);
    const controller = getDurableWorkflowPlanController(scope)!;
    const execution = await controller.startPlan({ plan });
    await execution.completion;

    const pending = (await controller.getProjection(execution.runId))!
      .deliveries[0]!;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pending.state).toBe("pending");

    await flushDurableWorkflowDeliveries(scope);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      (await controller.getProjection(execution.runId))?.deliveries[0]?.state,
    ).toBe("pending");

    entries.push({
      type: "custom",
      details: { deliveryIds: [pending.deliveryId] },
    });
    await flushDurableWorkflowDeliveries(scope);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      (await controller.getProjection(execution.runId))?.deliveries[0],
    ).toMatchObject({
      state: "delivered",
      deliveredBy: "pi-session-entry",
    });
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("queues a rescan when delivery becomes dirty during an in-flight flush", async () => {
    const scope = manualScope();
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      { homeDir: home },
    );
    await startDurableWorkflowSession(
      scope,
      "startup",
      context(cwd, "pi-rescan-session"),
    );
    const controller = getDurableWorkflowPlanController(scope)!;
    let releaseFirst!: (result: {
      intentsRecorded: number;
      receiptsRecorded: number;
    }) => void;
    const firstPass = new Promise<{
      intentsRecorded: number;
      receiptsRecorded: number;
    }>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcile = vi
      .spyOn(controller, "reconcileDeliveries")
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue({ intentsRecorded: 0, receiptsRecorded: 0 });

    const first = flushDurableWorkflowDeliveries(scope);
    const overlapping = flushDurableWorkflowDeliveries(scope);
    releaseFirst({ intentsRecorded: 0, receiptsRecorded: 0 });
    await Promise.all([first, overlapping]);

    expect(reconcile).toHaveBeenCalledTimes(2);
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("does not recover on new or fork and never crosses a wrong or missing identity", async () => {
    const scope = manualScope();
    const ownerContext = context(cwd, "pi-session-a");
    const runner: WorkflowAgentRunner = async ({ prompt }) => success(prompt);
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await startDurableWorkflowSession(scope, "startup", ownerContext);
    const initial = getDurableWorkflowPlanController(scope);
    const initialOwner = initial!.owner;
    const completed = await initial!.startPlan({ plan });
    await completed.completion;
    await stopDurableWorkflowSession(scope, "quit");

    for (const reason of ["new", "fork"] as const) {
      scope.generation++;
      const opened = await startDurableWorkflowSession(
        scope,
        reason,
        ownerContext,
      );
      expect(opened).toBeUndefined();
      expect(
        await getDurableWorkflowPlanController(scope)?.getProjection(
          completed.runId,
        ),
      ).toBeUndefined();
      await stopDurableWorkflowSession(scope, "owner_replaced");
    }

    scope.generation++;
    const wrongIdentity = context(cwd, "pi-session-b");
    const wrongOpened = await startDurableWorkflowSession(
      scope,
      "reload",
      wrongIdentity,
    );
    expect(wrongOpened?.recovery.runs).toEqual([]);
    expect(getDurableWorkflowPlanController(scope)?.owner).not.toEqual(
      initialOwner,
    );
    expect(
      await getDurableWorkflowPlanController(scope)?.getProjection(
        completed.runId,
      ),
    ).toBeUndefined();
    await stopDurableWorkflowSession(scope, "quit");

    scope.generation++;
    expect(
      await startDurableWorkflowSession(scope, "reload", context(cwd)),
    ).toBeUndefined();
    expect(getDurableWorkflowPlanController(scope)).toBeUndefined();
  });

  it("runs configured retention before maxRuns can dead-end new work", async () => {
    const scope = manualScope();
    const ctx = context(cwd, "pi-session-retention");
    const entries: unknown[] = [];
    const dispatch = vi.fn((message: { details: unknown }) => {
      entries.push({ type: "custom", details: message.details });
    });
    const runtimeOptions = {
      homeDir: home,
      delivery: { dispatch, existingEntries: () => entries },
      storeOptions: {
        now: () => Date.now() + 60_000,
        quotas: { maxRunsPerOwner: 1 },
        retention: {
          minimumAgeMs: 0,
          minimumRunsPerOwner: 0,
          maxPrunesPerPass: 10,
        },
      },
    };
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      runtimeOptions,
    );
    await startDurableWorkflowSession(scope, "startup", ctx);
    const controller = getDurableWorkflowPlanController(scope)!;

    const first = await controller.startPlan({ plan });
    await first.completion;
    await flushDurableWorkflowDeliveries(scope);
    expect(
      (await controller.getProjection(first.runId))?.deliveries[0],
    ).toMatchObject({ state: "delivered" });

    await stopDurableWorkflowSession(scope, "reload");
    scope.generation += 1;
    registerDurableWorkflowRunAgentFactory(
      scope,
      () =>
        async ({ prompt }) =>
          success(prompt),
      runtimeOptions,
    );
    await startDurableWorkflowSession(scope, "reload", ctx);
    const reopened = getDurableWorkflowPlanController(scope)!;

    const second = await reopened.startPlan({ plan });
    await second.completion;
    expect(second.runId).not.toBe(first.runId);
    await stopDurableWorkflowSession(scope, "quit");
  });

  it("session shutdown interrupts and releases durable work before ordinary cleanup", async () => {
    const { handlers, scope } = createLifecycleHarness();
    const ctx = context(cwd, "pi-session-a");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let sawOrdinaryStateAtInterruption = false;
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        const interrupted = () => {
          sawOrdinaryStateAtInterruption = scope.inProcessJobs.has("sentinel");
          resolve({ ...success("interrupted"), cancelled: true });
        };
        if (signal?.aborted) interrupted();
        else signal?.addEventListener("abort", interrupted, { once: true });
      });
    };
    registerDurableWorkflowRunAgentFactory(scope, () => runner, {
      homeDir: home,
    });
    await handlers.get("session_start")![0]({ reason: "new" }, ctx);

    const controller = getDurableWorkflowPlanController(scope)!;
    const interrupt = vi.spyOn(controller, "interrupt");
    const release = vi.spyOn(controller, "release");
    // The fixture only needs an owned row whose removal is observable.
    scope.inProcessJobs.set("sentinel", {
      id: "sentinel",
      status: "done",
    } as unknown as JobState);
    const execution = await controller.startPlan({ plan });
    await started;
    const completion = expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });

    await handlers.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    await completion;

    expect(sawOrdinaryStateAtInterruption).toBe(true);
    expect(scope.inProcessJobs.size).toBe(0);
    expect(interrupt).toHaveBeenCalledWith("quit");
    expect(interrupt.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
    expect(getDurableWorkflowPlanController(scope)).toBeUndefined();
    expect(scope.lifecycle).toBe("shutdown");
  });
});
