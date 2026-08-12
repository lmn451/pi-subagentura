import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "../src/workflow-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  type DurableWorkflowOwner,
} from "../src/workflow-run-types";

function success(
  output: string,
  input = 0,
  outputTokens = 0,
): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function sequentialPlan(isolation?: string): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "durable-preview",
    description: "sequential durable plan",
    phases: [
      {
        id: "phase-a",
        name: "Phase A",
        mode: "sequence",
        tasks: [
          {
            id: "task-a",
            content: "Task A",
            instruction: "run-a",
            ...(isolation === undefined ? {} : { agent: { isolation } }),
          },
          {
            id: "task-b",
            content: "Task B",
            instruction: "run-b",
          },
        ],
      },
    ],
  });
}

function parallelPlan(): WorkflowPlanDefinition {
  return validateWorkflowPlan({
    name: "parallel-durable",
    description: "parallel durable plan",
    phases: [
      {
        id: "parallel",
        name: "Parallel",
        mode: "parallel",
        tasks: [
          { id: "task-a", content: "Task A", instruction: "run-a" },
          { id: "task-b", content: "Task B", instruction: "run-b" },
          { id: "task-c", content: "Task C", instruction: "run-c" },
        ],
      },
    ],
  });
}

describe("DurableWorkflowPlanController", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let processNumber: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-durable-plan-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-session-a");
    processNumber = 100;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function store(
    sync?: ConstructorParameters<typeof WorkflowRunStore>[0]["sync"],
    io?: ConstructorParameters<typeof WorkflowRunStore>[0]["io"],
  ): WorkflowRunStore {
    processNumber++;
    return new WorkflowRunStore({
      homeDir: home,
      processIdentity: {
        pid: processNumber,
        processStartIdentity: `process-${processNumber}`,
      },
      sync,
      io,
    });
  }

  async function controller(
    runStore: WorkflowRunStore,
    runner: WorkflowAgentRunner,
    generation = 1,
  ): Promise<DurableWorkflowPlanController> {
    return DurableWorkflowPlanController.acquire({
      store: runStore,
      owner,
      scopeId: generation,
      generation,
      runAgentForRun: () => runner,
    });
  }

  it("syncs run creation before runner work and keeps terminal results queryable", async () => {
    const runStore = store();
    const runId = createDurableWorkflowRunId("created-before-runner");
    const observed: Array<{
      prompt: string;
      isolation: string | undefined;
      firstEvent: string | undefined;
    }> = [];
    const runner: WorkflowAgentRunner = async ({ prompt, isolation }) => {
      const events = await (await runStore.openRun(owner, runId)).readEvents();
      observed.push({ prompt, isolation, firstEvent: events[0]?.type });
      return success(`done:${prompt}`, 2, 1);
    };
    const durable = await controller(runStore, runner);

    const handle = await durable.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "trusted_resume",
    });
    const result = await handle.completion;

    expect(observed).toEqual([
      { prompt: "run-a", isolation: "in-process", firstEvent: "run_created" },
      { prompt: "run-b", isolation: "in-process", firstEvent: "run_created" },
    ]);
    expect(result.status).toBe("done");
    expect(result.result.map((task) => task.output)).toEqual([
      "done:run-a",
      "done:run-b",
    ]);
    expect(await durable.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
      accounting: {
        completeness: "exact",
        usage: { input: 4, output: 2 },
      },
    });
    expect(await durable.getResult(runId)).toMatchObject({
      status: "done",
      result: [
        { id: "task-a", output: "done:run-a" },
        { id: "task-b", output: "done:run-b" },
      ],
    });
    await expect(
      durable.trustedResume(runId, { trustedActorId: "human-a" }),
    ).rejects.toMatchObject({ code: "terminal_run" });
    await durable.release();

    const reopened = await controller(
      store(),
      async () => {
        throw new Error("terminal query must not run agents");
      },
      2,
    );
    const opened = await reopened.open("startup");
    expect(opened.completions).toEqual([]);
    expect(await reopened.getProjection(runId)).toMatchObject({
      status: "done",
    });
    expect(await reopened.getResult(runId)).toMatchObject({ status: "done" });
    await reopened.release();
  });

  it("dispatches explicit process isolation through the durable attempt protocol", async () => {
    const isolations: Array<string | undefined> = [];
    const durable = await controller(store(), async (request) => {
      isolations.push(request.isolation);
      const processAttempt = request.workflowProcessAttempt;
      if (processAttempt !== undefined) {
        const assignment = {
          backend: "tmux" as const,
          paneId: "%21",
          windowName: "wf-process-attempt",
          muxSession: "test-session",
          artifactDir: "/tmp/wf-process-attempt",
          sessionFile: "/tmp/wf-process-attempt/session.jsonl",
          launchScriptFile: "/tmp/wf-process-attempt/launch.sh",
        };
        await processAttempt.paneAssigned(assignment);
        await processAttempt.launchDispatched(assignment);
        await processAttempt.childStarted({
          schemaVersion: 1,
          identity: processAttempt.manifest.identity,
          launchMarker: processAttempt.manifest.launchMarker,
        });
        await processAttempt.terminal({
          identity: processAttempt.manifest.identity,
          status: "done",
          artifactEventId: "completion-1",
          exitCode: 0,
        });
      }
      return success(`done:${request.prompt}`);
    });

    const execution = await durable.startPlan({
      plan: sequentialPlan("process"),
    });
    await expect(execution.completion).resolves.toMatchObject({
      status: "done",
    });
    expect(isolations).toEqual(["process", "in-process"]);
    expect(
      (await durable.getProjection(execution.runId))?.operations[0]?.attempts[0]
        ?.process,
    ).toMatchObject({
      effectiveIsolation: "process",
      fallbackMode: "none",
    });
    await durable.release();
  });

  it("overlaps parallel tasks within the cap and preserves task authority and definition order", async () => {
    const releases = new Map<string, () => void>();
    const waits = new Map(
      ["run-a", "run-b", "run-c"].map((prompt) => [
        prompt,
        new Promise<void>((resolve) => releases.set(prompt, resolve)),
      ]),
    );
    let markInitialOverlap!: () => void;
    const initialOverlap = new Promise<void>((resolve) => {
      markInitialOverlap = resolve;
    });
    let markTaskCStarted!: () => void;
    const taskCStarted = new Promise<void>((resolve) => {
      markTaskCStarted = resolve;
    });
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const durable = await controller(store(), async ({ prompt }) => {
      started.push(prompt);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) markInitialOverlap();
      if (prompt === "run-c") markTaskCStarted();
      await waits.get(prompt);
      active--;
      return success(`done:${prompt}`, 2, 1);
    });

    const execution = await durable.startPlan({
      plan: parallelPlan(),
      concurrency: 2,
    });
    await initialOverlap;
    expect(started).toEqual(["run-a", "run-b"]);
    expect(maximumActive).toBe(2);

    releases.get("run-b")?.();
    await taskCStarted;
    expect(started).toEqual(["run-a", "run-b", "run-c"]);
    expect(active).toBe(2);
    releases.get("run-c")?.();
    releases.get("run-a")?.();

    const result = await execution.completion;
    expect(maximumActive).toBe(2);
    expect(result.result).toMatchObject([
      { id: "task-a", output: "done:run-a" },
      { id: "task-b", output: "done:run-b" },
      { id: "task-c", output: "done:run-c" },
    ]);
    expect(result.usage).toMatchObject({ input: 6, output: 3 });
    await durable.release();
  });

  it("persists trusted cancellation before abort and keeps one terminal cancelled result queryable", async () => {
    const runStore = store();
    const runId = createDurableWorkflowRunId("trusted-cancellation");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markObservedAbort!: (events: string[]) => void;
    const observedAbort = new Promise<string[]>((resolve) => {
      markObservedAbort = resolve;
    });
    const durable = await controller(runStore, async ({ signal }) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            void (async () => {
              const events = await (
                await runStore.openRun(owner, runId)
              ).readEvents();
              markObservedAbort(events.map((event) => event.type));
              resolve();
            })();
          },
          { once: true },
        );
      });
      return {
        ...success("cancelled", 4, 2),
        cancelled: true,
      };
    });
    const execution = await durable.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    await started;
    await expect(
      durable.trustedCancel(runId, {
        reason: "wrong owner",
        trustedActorId: "human-a",
        expectedOwner: { ...owner, piSessionKey: "other-session" },
      }),
    ).rejects.toMatchObject({ code: "wrong_owner" });
    await expect(
      durable.trustedCancel(runId, {
        reason: "invalid actor",
        trustedActorId: "",
      }),
    ).rejects.toMatchObject({ code: "invalid_cancellation" });

    const firstCancellation = durable.trustedCancel(runId, {
      reason: "user requested cancellation",
      trustedActorId: "human-a",
      expectedOwner: owner,
      expectedRunEpoch: 1,
    });
    const repeatedCancellation = durable.trustedCancel(runId, {
      reason: "duplicate request is idempotent",
      trustedActorId: "human-a",
      expectedOwner: owner,
      expectedRunEpoch: 1,
    });
    const [firstResult, repeatedResult] = await Promise.all([
      firstCancellation,
      repeatedCancellation,
    ]);
    expect(firstResult).toMatchObject({ status: "cancelled" });
    expect(repeatedResult).toEqual(firstResult);
    expect(await observedAbort).toContain("run_cancellation_requested");
    expect(await execution.completion).toEqual(firstResult);

    const events = await (await runStore.openRun(owner, runId)).readEvents();
    expect(
      events.filter((event) => event.type === "run_cancellation_requested"),
    ).toHaveLength(1);
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.indexOf("run_cancellation_requested")).toBeLessThan(
      eventTypes.indexOf("run_cancelled"),
    );
    expect(eventTypes.indexOf("run_cancelled")).toBeLessThan(
      eventTypes.indexOf("run_terminal"),
    );
    expect(await durable.getProjection(runId)).toMatchObject({
      status: "cancelled",
      terminal: { status: "cancelled" },
      accounting: {
        completeness: "exact",
        usage: { input: 4, output: 2 },
      },
    });
    expect(await durable.getResult(runId)).toMatchObject({
      status: "cancelled",
      usage: { input: 4, output: 2 },
    });
    expect(
      await durable.trustedCancel(runId, {
        reason: "terminal duplicate",
        trustedActorId: "human-a",
      }),
    ).toEqual(firstResult);
    await expect(
      durable.trustedCancel(
        createDurableWorkflowRunId("wrong-or-missing-run"),
        {
          reason: "not found",
          trustedActorId: "human-a",
        },
      ),
    ).rejects.toMatchObject({ code: "run_not_found" });
    await durable.release();
  });

  it("preserves active agent count when cancellation falls back after a write failure", async () => {
    const runId = createDurableWorkflowRunId("active-cancellation-fallback");
    let failNextOutputWrite = false;
    const runStore = store(undefined, {
      before: (boundary, purpose) => {
        if (
          failNextOutputWrite &&
          boundary === "temporary_write" &&
          purpose === "output"
        ) {
          failNextOutputWrite = false;
          throw new Error("injected post-cancellation output write failure");
        }
      },
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const durable = await controller(runStore, async ({ signal }) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      failNextOutputWrite = true;
      return { ...success("cancelled", 3, 1), cancelled: true };
    });
    const execution = await durable.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    const completion = execution.completion.catch((error) => error);
    await started;

    const cancelled = await durable.trustedCancel(runId, {
      reason: "cancel with one-shot write failure",
      trustedActorId: "human-a",
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      agentsSpawned: 1,
    });
    expect(await durable.getResult(runId)).toMatchObject({
      status: "cancelled",
      agentsSpawned: 1,
    });
    expect(await completion).toBeInstanceOf(Error);
    await durable.release();
  });

  it("reports zero agents for cold cancellation after durable attempt history", async () => {
    const runId = createDurableWorkflowRunId("cold-cancellation-accounting");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = await controller(store(), async ({ signal }) => {
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return success("historical-usage", 4, 2);
    });
    const execution = await first.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    await started;
    const interruption = first.interrupt("quit", runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;
    const historical = await first.getProjection(runId);
    expect(
      historical?.operations.reduce(
        (total, operation) => total + operation.attempts.length,
        0,
      ),
    ).toBe(1);
    expect(historical).toMatchObject({
      accounting: { usage: { input: 4, output: 2 } },
    });
    await first.release();

    let coldCalls = 0;
    const cold = await controller(
      store(),
      async () => {
        coldCalls++;
        throw new Error("cold cancellation must not dispatch");
      },
      2,
    );
    const opened = await cold.open("startup");
    expect(opened.completions).toEqual([]);

    const cancelled = await cold.trustedCancel(runId, {
      reason: "cancel without resuming",
      trustedActorId: "human-a",
    });
    expect(coldCalls).toBe(0);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 2,
      usage: { input: 4, output: 2 },
    });
    expect(await cold.getResult(runId)).toMatchObject({
      status: "cancelled",
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 2,
      usage: { input: 4, output: 2 },
    });
    await cold.release();
  });

  it("requires trusted startup resume, replays committed A, retries B, and does not double usage", async () => {
    let failNextEventSync = false;
    const firstStore = store({
      file: async (handle, purpose) => {
        await handle.sync();
        if (purpose === "events" && failNextEventSync) {
          failNextEventSync = false;
          throw new Error("injected event sync failure");
        }
      },
    });
    const runId = createDurableWorkflowRunId("resume-two-tasks");
    const firstCalls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      firstCalls.push(prompt);
      if (prompt === "run-b") failNextEventSync = true;
      return prompt === "run-a"
        ? success("committed-a", 5, 3)
        : success("uncommitted-b");
    });

    const initial = await first.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    expect(firstCalls).toEqual(["run-a", "run-b"]);
    await first.release();

    const resumedCalls: string[] = [];
    const second = await controller(
      store(),
      async ({ prompt }) => {
        resumedCalls.push(prompt);
        return success("retried-b", 2, 1);
      },
      2,
    );
    const startup = await second.open("startup");
    expect(startup.completions).toEqual([]);
    expect(startup.recovery.runs[0]).toMatchObject({
      interrupted: true,
      trustedResumeRequired: true,
      automaticResumeEligible: false,
    });
    expect(resumedCalls).toEqual([]);

    await expect(
      second.trustedResume(runId, { trustedActorId: "" }),
    ).rejects.toMatchObject({ code: "trusted_resume_required" });
    await expect(
      second.trustedResume(runId, {
        trustedActorId: "human-a",
        expectedOwner: { ...owner, piSessionKey: "another-session" },
      }),
    ).rejects.toMatchObject({ code: "wrong_owner" });
    const interrupted = await second.getProjection(runId);
    if (interrupted === undefined)
      throw new Error("missing recovered projection");
    await expect(
      second.trustedResume(runId, {
        trustedActorId: "human-a",
        expectedRunEpoch: interrupted.runEpoch + 1,
      }),
    ).rejects.toMatchObject({ code: "epoch_mismatch" });

    const resumed = await second.trustedResume(runId, {
      trustedActorId: "human-a",
      expectedOwner: owner,
      expectedRunEpoch: interrupted.runEpoch,
    });
    await resumed.completion;

    expect(resumedCalls).toEqual(["run-b"]);
    const projection = await second.getProjection(runId);
    expect(projection).toMatchObject({
      status: "done",
      accounting: {
        completeness: "lower_bound",
        usage: { input: 7, output: 4 },
      },
    });
    const operationA = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-a",
    );
    const operationB = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-b",
    );
    expect(operationA?.attempts).toHaveLength(1);
    expect(operationA?.replays).toHaveLength(1);
    expect(operationB?.attempts).toHaveLength(2);
    expect(
      operationB?.attempts.map((attempt) => attempt.attempt.attemptNumber),
    ).toEqual([1, 2]);
    await second.release();
  });

  it("reuses an attempt start that persisted before its acknowledgement failed", async () => {
    const runId = createDurableWorkflowRunId("persisted-attempt-start");
    let failPersistedStart = true;
    const firstStore = store({
      file: async (handle, purpose) => {
        await handle.sync();
        if (purpose !== "events" || !failPersistedStart) return;
        const eventsPath = join(
          home,
          ".pi-subagentura",
          "workflow-runs",
          "v1",
          owner.projectKey,
          owner.piSessionKey,
          "runs",
          runId,
          "events.ndjson",
        );
        const lastLine = readFileSync(eventsPath, "utf8")
          .trimEnd()
          .split("\n")
          .at(-1);
        if (!lastLine) return;
        const lastEvent: unknown = JSON.parse(lastLine);
        if (
          lastEvent !== null &&
          typeof lastEvent === "object" &&
          "type" in lastEvent &&
          lastEvent.type === "attempt_started"
        ) {
          failPersistedStart = false;
          throw new Error("injected attempt start acknowledgement failure");
        }
      },
    });
    const firstCalls: string[] = [];
    const first = await controller(firstStore, async ({ prompt }) => {
      firstCalls.push(prompt);
      return success(`unexpected:${prompt}`);
    });
    const initial = await first.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "trusted_resume",
    });
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    expect(firstCalls).toEqual([]);
    const interruptedAfterStart = await first.getProjection(runId);
    expect(interruptedAfterStart).toMatchObject({
      status: "interrupted",
      operations: [{ attempts: [{ status: "started" }] }],
    });
    expect(
      interruptedAfterStart?.operations[0]?.attempts[0]?.dispatchedEventId,
    ).toBeUndefined();
    await first.release();

    const resumedCalls: string[] = [];
    const second = await controller(
      store(),
      async ({ prompt }) => {
        resumedCalls.push(prompt);
        return success(`done:${prompt}`);
      },
      2,
    );
    await second.open("startup");
    const interrupted = await second.getProjection(runId);
    if (interrupted === undefined)
      throw new Error("missing interrupted projection");
    const resumed = await second.trustedResume(runId, {
      trustedActorId: "human-a",
      expectedOwner: owner,
      expectedRunEpoch: interrupted.runEpoch,
    });
    await resumed.completion;

    expect(resumedCalls).toEqual(["run-a", "run-b"]);
    const projection = await second.getProjection(runId);
    const operationA = projection?.operations.find(
      (operation) => operation.identity.operationId === "task-a",
    );
    expect(operationA?.attempts).toHaveLength(1);
    expect(operationA?.attempts[0]).toMatchObject({
      dispatchedEventId: expect.any(String),
      status: "settled",
      attempt: { attemptNumber: 1 },
    });
    await second.release();
  });

  it("automatically continues reload-eligible runs and exposes their completion", async () => {
    const runId = createDurableWorkflowRunId("automatic-reload");
    const firstStore = store();
    let markTaskBStarted!: () => void;
    const taskBStarted = new Promise<void>((resolve) => {
      markTaskBStarted = resolve;
    });
    const first = await controller(firstStore, async ({ prompt, signal }) => {
      if (prompt === "run-a") return success("committed-a", 3, 1);
      markTaskBStarted();
      return new Promise<SubagentResult>((resolve) => {
        const cancelled = () =>
          resolve({ ...success("interrupted-b"), cancelled: true });
        if (signal?.aborted) cancelled();
        else signal?.addEventListener("abort", cancelled, { once: true });
      });
    });
    const initial = await first.startPlan({
      runId,
      plan: sequentialPlan(),
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await taskBStarted;
    const interruption = first.interrupt("reload", runId);
    await expect(initial.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;
    await first.release();

    const reloadCalls: string[] = [];
    const second = await controller(
      store(),
      async ({ prompt }) => {
        reloadCalls.push(prompt);
        return success("fresh-b", 1, 1);
      },
      2,
    );
    const opened = await second.open("reload");
    expect(opened.completions).toHaveLength(1);
    expect(opened.completions[0]?.runId).toBe(runId);
    await opened.completions[0]?.completion;
    expect(reloadCalls).toEqual(["run-b"]);
    expect(await second.getProjection(runId)).toMatchObject({ status: "done" });
    await second.release();
  });

  it("recreates a missing result binding after terminal event commit", async () => {
    const runId = createDurableWorkflowRunId("terminal-binding-crash");
    let failResultPublish = true;
    const firstStore = store(undefined, {
      before: (boundary, purpose) => {
        if (
          failResultPublish &&
          boundary === "temporary_write" &&
          purpose === "result"
        ) {
          failResultPublish = false;
          throw new Error("crash before result binding publish");
        }
      },
    });
    const first = await controller(firstStore, async ({ prompt }) =>
      success(`done:${prompt}`, 1, 1),
    );
    const execution = await first.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    await expect(execution.completion).rejects.toThrow(
      "crash before result binding publish",
    );
    expect(await first.getProjection(runId)).toMatchObject({
      status: "done",
      terminal: { status: "done" },
    });
    expect(
      await (await firstStore.openRun(owner, runId)).readResult(),
    ).toBeUndefined();
    await first.release();

    const secondStore = store();
    const second = await controller(
      secondStore,
      async () => {
        throw new Error("terminal recovery must not dispatch");
      },
      2,
    );
    await second.open("startup");
    expect(
      await (await secondStore.openRun(owner, runId)).readResult(),
    ).toMatchObject({
      runId,
      terminalEventId: expect.any(String),
      result: expect.objectContaining({ sha256: expect.any(String) }),
    });
    expect(await second.getResult(runId)).toMatchObject({
      status: "done",
      usage: { input: 2, output: 2 },
    });
    await second.release();
  });

  it("aborts active model work and leaves the attempt retryable on interruption", async () => {
    const runId = createDurableWorkflowRunId("interrupt-active");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const active = await controller(store(), async ({ signal }) => {
      markStarted();
      return new Promise<SubagentResult>((resolve) => {
        const cancelled = () =>
          resolve({
            ...success("interrupted"),
            cancelled: true,
          });
        if (signal?.aborted) cancelled();
        else signal?.addEventListener("abort", cancelled, { once: true });
      });
    });
    const execution = await active.startPlan({
      runId,
      plan: sequentialPlan(),
    });
    await started;

    const interruption = active.interrupt("reload", runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;

    const projection = await active.getProjection(runId);
    expect(projection).toMatchObject({ status: "interrupted" });
    expect(projection?.operations[0]?.settlement).toBeUndefined();
    expect(projection?.operations[0]?.attempts[0]).toMatchObject({
      status: "interrupted",
    });
    await active.release();
  });
  it("journals returned usage before a winning interruption and replays it once", async () => {
    const runId = createDurableWorkflowRunId("interrupt-after-result");
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let calls = 0;
    const durable = await controller(store(), async ({ signal }) => {
      calls += 1;
      markStarted();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return success("late-terminal-result", 2, 7);
    });
    const execution = await durable.startPlan({
      runId,
      plan: validateWorkflowPlan({
        name: "interrupted-result",
        description: "persist returned usage before interruption",
        phases: [
          {
            id: "phase-a",
            name: "Phase A",
            mode: "sequence",
            tasks: [{ id: "task-a", content: "Task A", instruction: "run-a" }],
          },
        ],
      }),
      resumePolicy: "trusted_resume",
    });
    await started;
    const interruption = durable.interrupt("reload", runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await interruption;

    const interrupted = await durable.getProjection(runId);
    expect(interrupted).toMatchObject({
      status: "interrupted",
      accounting: { usage: { input: 2, output: 7 } },
    });
    if (interrupted === undefined) throw new Error("missing projection");
    const resumed = await durable.trustedResume(runId, {
      trustedActorId: "human-resume",
      expectedOwner: owner,
      expectedRunEpoch: interrupted.runEpoch,
    });
    await resumed.completion;
    expect(calls).toBe(1);
    expect(await durable.getResult(runId)).toMatchObject({
      status: "done",
      usage: { input: 2, output: 7 },
    });
    await durable.release();
  });
});
