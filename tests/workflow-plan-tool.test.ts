import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import {
  clearSessionScopes,
  registerSessionScope,
  setLegacyActiveSessionRefs,
  type SessionOwnerToken,
} from "../src/session-scope";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";
import type { WorkflowPlanRunResult } from "../src/workflow-plan-runner";
import type { WorkflowRunResultWithUsage } from "../src/workflow-core";
import {
  prepareDurableWorkflowScript,
  type DurableWorkflowScriptStartOptions,
} from "../src/workflow-durable-script";

const {
  mockAwaitInteractiveResult,
  mockGetDurableWorkflowPlanController,
  mockLaunchInteractiveSubagent,
  mockLoadWorkflowScript,
  mockRegisterDurableWorkflowRunAgentFactory,
} = vi.hoisted(() => ({
  mockAwaitInteractiveResult: vi.fn(),
  mockGetDurableWorkflowPlanController: vi.fn(),
  mockLaunchInteractiveSubagent: vi.fn(),
  mockLoadWorkflowScript: vi.fn(),
  mockRegisterDurableWorkflowRunAgentFactory: vi.fn(),
}));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
  };
});

vi.mock("../src/workflow-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-worker")>();
  return { ...actual, awaitInteractiveResult: mockAwaitInteractiveResult };
});

vi.mock("../src/workflow-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/workflow-core")>();
  return { ...actual, loadWorkflowScript: mockLoadWorkflowScript };
});

vi.mock("../src/workflow-durable-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-durable-runtime")>();
  return {
    ...actual,
    getDurableWorkflowPlanController: mockGetDurableWorkflowPlanController,
    registerDurableWorkflowRunAgentFactory:
      mockRegisterDurableWorkflowRunAgentFactory,
  };
});

import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import {
  MAX_WORKFLOW_JOBS,
  cleanupWorkflowJobsForOwner,
  getWorkflowJobForOwner,
  startWorkflowPlanJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { registerWorkflowTool } from "../src/workflow-tool";
import {
  applyPlanEvent,
  createPlanProjection,
  type WorkflowPlanEvent,
} from "../src/workflow-plan-state";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
};

const PLAN_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  costUsd: 0,
  turns: 0,
};

const BASE_PLAN: WorkflowPlanDefinition = {
  name: "preview",
  description: "Two-phase declarative preview",
  phases: [
    {
      id: "discover",
      name: "Discover",
      mode: "sequence",
      tasks: [
        {
          id: "inspect",
          content: "Inspect inputs",
          instruction: "inspect the inputs",
        },
      ],
    },
    {
      id: "review",
      name: "Review",
      mode: "sequence",
      tasks: [
        {
          id: "review-result",
          content: "Review result",
          instruction: "review the result",
        },
      ],
    },
  ],
};

const LEGACY_SCRIPT = (name: string) =>
  `export const meta = { name: "${name}", description: "legacy" };\n` +
  'return await agent("legacy task", { label: "legacy" });';

const DURABLE_SCRIPT = (name: string) =>
  `export const meta = { name: "${name}", description: "durable" };\n` +
  'return await agent("durable task", { id: "durable-agent", label: "durable" });';

function successfulResult(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: { ...ZERO_USAGE, input: 2, output: 3, turns: 1 },
    model: "test/model",
  };
}

function failedResult(message: string): SubagentResult {
  return {
    isError: true,
    output: "",
    errorMessage: message,
    usage: { ...ZERO_USAGE, input: 1, output: 1, turns: 1 },
  };
}

function cancelledResult(): SubagentResult {
  return {
    isError: false,
    output: "",
    cancelled: true,
    usage: { ...ZERO_USAGE },
  };
}

function makePi() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendMessage: vi.fn(),
  };
  registerWorkflowTool(pi as never);
  return { pi, tools };
}

function makeScopedPi(controller: any) {
  const tools = new Map<string, any>();
  const pi = {
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    sendMessage: vi.fn(),
  };
  const scope = registerSessionScope({
    id: 1,
    generation: 1,
    lifecycle: "started",
    pi: pi as never,
  });
  mockGetDurableWorkflowPlanController.mockReturnValue(controller);
  registerWorkflowTool(pi as never, scope);
  return { pi, scope, tools };
}

function durableControllerHarness(settleImmediately = false) {
  const projections = new Map<string, any>();
  const results = new Map<
    string,
    WorkflowPlanRunResult | WorkflowRunResultWithUsage
  >();
  const active = new Map<
    string,
    {
      plan: WorkflowPlanDefinition;
      projection: ReturnType<typeof createPlanProjection>;
      options: any;
      resolve: (result: WorkflowPlanRunResult) => void;
    }
  >();

  const durableProjection = (
    runId: string,
    run: WorkflowPlanRunResult,
    terminal: boolean,
  ) => ({
    runId,
    executionKind: "plan",
    status: terminal ? run.status : "running",
    runEpoch: 1,
    accounting: { completeness: "exact", usage: { ...PLAN_USAGE } },
    tasks: run.projection.phases.flatMap((phase) =>
      phase.tasks.map((task) => ({
        definitionPath: "root",
        taskId: task.definition.id,
        planRevision: 1,
        status: task.status,
        transitionEventIds: [],
      })),
    ),
    taskStates: Object.fromEntries(
      run.projection.phases.flatMap((phase) =>
        phase.tasks.map((task) => [
          task.definition.id,
          {
            definitionPath: "root",
            taskId: task.definition.id,
            planRevision: 1,
            status: task.status,
            transitionEventIds: [],
          },
        ]),
      ),
    ),
    ...(terminal
      ? {
          terminal: {
            eventId: "terminal",
            status: run.status,
            accounting: { completeness: "exact", usage: { ...PLAN_USAGE } },
            resultEventId: "result",
          },
        }
      : {}),
  });

  const settle = (runId: string, status: "done" | "cancelled") => {
    const execution = active.get(runId);
    if (!execution) throw new Error(`missing durable execution ${runId}`);
    const emit = (event: WorkflowPlanEvent) => {
      execution.options.onPlanEvent?.(event);
      execution.projection = applyPlanEvent(execution.projection, event);
    };
    if (status === "cancelled") {
      emit({ type: "run_cancelled", reason: "cancelled by test" });
    } else {
      for (const phase of execution.projection.phases) {
        for (const task of phase.tasks) {
          if (task.status === "pending") {
            emit({ type: "task_started", taskId: task.definition.id });
          }
          emit({
            type: "task_succeeded",
            taskId: task.definition.id,
            result: `done:${task.definition.id}`,
          });
        }
      }
    }
    const run: WorkflowPlanRunResult = {
      meta: {
        name: execution.plan.name,
        description: execution.plan.description,
        phases: execution.plan.phases.map((phase) => ({
          title: phase.name,
          detail: phase.id,
        })),
      },
      status,
      result: execution.projection.phases.flatMap((phase) =>
        phase.tasks.map((task) => ({
          id: task.definition.id,
          phaseId: task.phaseId,
          content: task.definition.content,
          status: task.status,
          ...(task.status === "succeeded"
            ? { output: `done:${task.definition.id}` }
            : {}),
        })),
      ),
      projection: execution.projection,
      agentsSpawned: status === "done" ? 2 : 1,
      errorCount: 0,
      tokensSpent: 0,
      usage: { ...PLAN_USAGE },
      phases: execution.plan.phases.map((phase) => phase.id),
    };
    results.set(runId, run);
    projections.set(runId, durableProjection(runId, run, true));
    active.delete(runId);
    execution.resolve(run);
    return run;
  };

  const controller = {
    owner: { projectKey: "a".repeat(64), piSessionKey: "test-session" },
    startPlan: vi.fn(async (options: any) => {
      let projection = createPlanProjection(options.plan);
      const firstTask = projection.phases[0]!.tasks[0]!;
      const startedEvent: WorkflowPlanEvent = {
        type: "task_started",
        taskId: firstTask.definition.id,
      };
      options.onPlanEvent?.(startedEvent);
      projection = applyPlanEvent(projection, startedEvent);
      options.onProgress?.({
        kind: "agent_start",
        phase: firstTask.phaseId,
        label: firstTask.definition.content,
        agentId: 1,
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 0,
        budgetTotal: null,
        usage: { ...PLAN_USAGE },
        runningCount: 1,
      });
      let resolve!: (result: WorkflowPlanRunResult) => void;
      const completion = new Promise<WorkflowPlanRunResult>((next) => {
        resolve = next;
      });
      const running: WorkflowPlanRunResult = {
        meta: {
          name: options.plan.name,
          description: options.plan.description,
        },
        status: "running",
        result: [],
        projection,
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 0,
        usage: { ...PLAN_USAGE },
        phases: [projection.phases[0]!.definition.id],
      };
      active.set(options.runId, {
        plan: options.plan,
        projection,
        options,
        resolve,
      });
      projections.set(
        options.runId,
        durableProjection(options.runId, running, false),
      );
      if (settleImmediately) settle(options.runId, "done");
      return { runId: options.runId, completion };
    }),
    startScript: vi.fn(async (options: DurableWorkflowScriptStartOptions) => {
      if (options.runId === undefined) {
        throw new Error("durable script test requires a run ID");
      }
      const runId = options.runId;
      prepareDurableWorkflowScript(options.script, options);
      const result: WorkflowRunResultWithUsage = {
        meta: { name: "durable-script", description: "durable" },
        result: "durable script result",
        agentsSpawned: 1,
        errorCount: 0,
        tokensSpent: 3,
        usage: { ...PLAN_USAGE, input: 2, output: 3, totalTokens: 5 },
        phases: [],
      };
      results.set(runId, result);
      projections.set(runId, {
        runId,
        executionKind: "script",
        status: "done",
        runEpoch: 1,
        accounting: {
          completeness: "exact",
          usage: { ...PLAN_USAGE, input: 2, output: 3, totalTokens: 5 },
        },
        tasks: [],
        taskStates: {},
        terminal: {
          eventId: "script-terminal",
          status: "done",
          accounting: {
            completeness: "exact",
            usage: { ...PLAN_USAGE, input: 2, output: 3, totalTokens: 5 },
          },
          resultEventId: "script-result",
        },
      });
      return { runId, completion: Promise.resolve(result) };
    }),
    getProjection: vi.fn(async (runId: string) => projections.get(runId)),
    getResult: vi.fn(async (runId: string) => results.get(runId)),
    trustedCancel: vi.fn(async (runId: string) => {
      const existing = results.get(runId);
      return existing ?? settle(runId, "cancelled");
    }),
  };
  return { controller, projections, results, settle };
}

function toolContext() {
  return { cwd: "/tmp", model: "test/model", modelRegistry: {} };
}

function runningScriptJob(
  id: string,
  owner: SessionOwnerToken,
): WorkflowJobState {
  return {
    id,
    kind: "script",
    name: id,
    status: "running",
    startedAt: Date.now(),
    promise: new Promise<never>(() => {}),
    abort: new AbortController(),
    parentSessionOwner: owner,
    snapshot: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    },
  };
}

describe("declarative workflow tool preview", () => {
  beforeEach(() => {
    clearSessionScopes();
    setLegacyActiveSessionRefs(undefined);
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
    mockGetDurableWorkflowPlanController.mockReset();
    mockGetDurableWorkflowPlanController.mockReturnValue(undefined);
    mockRegisterDurableWorkflowRunAgentFactory.mockReset();
    mockLoadWorkflowScript.mockReset();
    mockLoadWorkflowScript.mockReturnValue(null);
    mockAwaitInteractiveResult.mockReset();
    mockAwaitInteractiveResult.mockImplementation(async (state: any) =>
      successfulResult(`completed: ${state.task}`),
    );
    let childId = 0;
    mockLaunchInteractiveSubagent.mockReset();
    mockLaunchInteractiveSubagent.mockImplementation((params: any) => ({
      id: `plan-child-${++childId}`,
      name: params.name,
      task: params.task,
      paneId: `%${childId}`,
      mux: "tmux",
      sessionFile: `/tmp/plan-child-${childId}.jsonl`,
      cwd: "/tmp",
      startedAt: Date.now(),
      status: "running",
      attachCommand: "attach",
      selectPaneCommand: "select",
      launchScriptFile: `/tmp/plan-child-${childId}.sh`,
      artifactDir: `/tmp/plan-child-${childId}`,
      supervisorOwner: params.supervisorOwner,
      workflowId: params.workflowId,
      completionOwner: params.completionOwner,
    }));
  });

  afterEach(() => {
    for (const job of workflowJobRegistry.values()) job.abort.abort();
    workflowJobRegistry.clear();
    interactiveSubagentRegistry.clear();
  });

  it("publishes an exact nested plan schema with no unknown object fields", () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const parameters = workflow.parameters as any;
    const plan = parameters.properties.plan;
    const phase = plan.properties.phases.items;
    const task = phase.properties.tasks.items;

    expect(parameters.additionalProperties).toBe(false);
    expect(plan.additionalProperties).toBe(false);
    expect(phase.additionalProperties).toBe(false);
    expect(task.additionalProperties).toBe(false);
    expect(task.properties.agent.additionalProperties).toBe(false);
    expect(parameters.properties.durable.type).toBe("boolean");
  });

  it("builds a restart runner from the current session context before any tool call", () => {
    const harness = durableControllerHarness();
    makeScopedPi(harness.controller);
    const factory =
      mockRegisterDurableWorkflowRunAgentFactory.mock.calls[0]?.[1];

    expect(typeof factory).toBe("function");
    expect(factory("wfr-v1-recovery-run", toolContext())).toBeTypeOf(
      "function",
    );
  });

  it("requires exactly one of script, name, and plan before loading or dispatching", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const script = LEGACY_SCRIPT("conflict");

    for (const params of [
      {},
      { script, name: "saved" },
      { script, plan: BASE_PLAN },
      { name: "saved", plan: BASE_PLAN },
    ]) {
      const result = await workflow.execute(
        "invalid-input",
        params,
        undefined,
        vi.fn(),
        toolContext(),
      );
      expect(result.isError).toBe(true);
      expect(result.details.error).toContain("exactly one");
    }

    expect(mockLoadWorkflowScript).not.toHaveBeenCalled();
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("rejects invalid, unknown, and runtime plan fields before runner work", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const duplicateTaskPlan = {
      ...BASE_PLAN,
      phases: BASE_PLAN.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => ({ ...task, id: "duplicate" })),
      })),
    };
    const runtimePlan = {
      ...BASE_PLAN,
      phases: [
        {
          ...BASE_PLAN.phases[0]!,
          tasks: [
            {
              ...BASE_PLAN.phases[0]!.tasks[0],
              runtime: { retries: 3 },
            },
          ],
        },
      ],
    };

    for (const params of [
      { plan: duplicateTaskPlan },
      { plan: { ...BASE_PLAN, unknown: true } },
      { plan: runtimePlan },
    ]) {
      const result = await workflow.execute(
        "invalid-plan",
        params,
        undefined,
        vi.fn(),
        toolContext(),
      );
      expect(result.isError).toBe(true);
    }

    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("rejects unstable durable scripts and unsupported plans before run creation", async () => {
    const harness = durableControllerHarness();
    const { tools } = makeScopedPi(harness.controller);
    const workflow = tools.get("workflow");
    mockLoadWorkflowScript.mockReturnValue(LEGACY_SCRIPT("saved"));
    const invalidPlan = {
      ...BASE_PLAN,
      phases: BASE_PLAN.phases.map((phase) => ({
        ...phase,
        tasks: phase.tasks.map((task) => ({ ...task, id: "duplicate" })),
      })),
    };

    for (const params of [
      { script: LEGACY_SCRIPT("durable-script"), durable: true },
      { name: "saved", durable: true },
      { plan: invalidPlan, durable: true },
    ]) {
      const response = await workflow.execute(
        "durable-rejection",
        params,
        undefined,
        vi.fn(),
        toolContext(),
      );
      expect(response.isError).toBe(true);
    }

    expect(mockLoadWorkflowScript).toHaveBeenCalledTimes(1);
    expect(harness.controller.startScript).toHaveBeenCalledTimes(2);
    expect(harness.controller.startPlan).not.toHaveBeenCalled();
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();
    expect(workflowJobRegistry.size).toBe(0);
  });

  it("runs explicit durable scripts and queries them without a live adapter", async () => {
    const harness = durableControllerHarness();
    const { tools } = makeScopedPi(harness.controller);
    const workflow = tools.get("workflow");
    const started = await workflow.execute(
      "durable-script-async",
      { script: DURABLE_SCRIPT("direct-durable"), durable: true },
      undefined,
      vi.fn(),
      toolContext(),
    );

    expect(started.details).toMatchObject({
      status: "started",
      durable: true,
      name: "direct-durable",
    });
    expect(started.details.workflowId).toMatch(/^wfr-v1-script-/);
    const asyncJob = workflowJobRegistry.get(started.details.workflowId);
    expect(asyncJob?.durable).toBe(true);
    await asyncJob?.promise;
    workflowJobRegistry.delete(started.details.workflowId);

    const status = await tools.get("get_workflow_status").execute("status", {
      workflowId: started.details.workflowId,
    });
    expect(status.details).toMatchObject({
      status: "done",
      kind: "script",
      durable: true,
      accountingCompleteness: "exact",
    });
    expect(status.details).not.toHaveProperty("planProjection");
    const queried = await tools.get("get_workflow_result").execute("result", {
      workflowId: started.details.workflowId,
    });
    expect(queried.details).toMatchObject({
      status: "done",
      kind: "script",
      durable: true,
      name: "durable-script",
    });
    expect(queried.content[0].text).toContain("durable script result");

    mockLoadWorkflowScript.mockReturnValue(DURABLE_SCRIPT("saved-durable"));
    const sync = await workflow.execute(
      "durable-script-sync",
      { name: "saved", durable: true, async: false },
      undefined,
      vi.fn(),
      toolContext(),
    );
    expect(sync.details).toMatchObject({ status: "done", durable: true });
    expect(harness.controller.startScript).toHaveBeenCalledTimes(2);
    expect(harness.controller.startScript.mock.calls[1]![0].script).toContain(
      'id: "durable-agent"',
    );
  });

  it("starts plans asynchronously by default and exposes bounded status/result projections", async () => {
    const secretOutput = `SECRET-${"x".repeat(1_000)}`;
    let release!: (result: SubagentResult) => void;
    mockAwaitInteractiveResult.mockImplementationOnce(
      () =>
        new Promise<SubagentResult>((resolve) => {
          release = resolve;
        }),
    );
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const started = await workflow.execute(
      "async-plan",
      { plan: BASE_PLAN },
      undefined,
      vi.fn(),
      toolContext(),
    );

    expect(started.details).toMatchObject({
      status: "started",
      kind: "plan",
      name: "preview",
    });
    expect(started.details.workflowId).toMatch(/^wf_[0-9a-f]{10}$/);
    const job = workflowJobRegistry.get(started.details.workflowId)!;
    expect(job.kind).toBe("plan");
    expect(job.planProjection).toBeDefined();

    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1),
    );
    const running = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId: job.id });
    expect(running.details).toMatchObject({
      status: "running",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "running" }),
        ]),
      },
    });

    release(successfulResult(secretOutput));
    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2),
    );
    const result = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: job.id });
    expect(result.details).toMatchObject({
      status: "done",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "succeeded" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "succeeded",
          }),
        ]),
      },
    });
    expect(JSON.stringify(result.details.planProjection)).not.toContain(
      "SECRET",
    );
    expect(result.content[0].text).toContain(secretOutput);
  });

  it("starts explicit durable plans, reports live/terminal status, and queries results after adapter removal", async () => {
    const harness = durableControllerHarness();
    const { pi, tools } = makeScopedPi(harness.controller);
    const workflow = tools.get("workflow");
    const started = await workflow.execute(
      "durable-async",
      { plan: BASE_PLAN, durable: true },
      undefined,
      vi.fn(),
      toolContext(),
    );

    expect(started.details).toMatchObject({
      status: "started",
      kind: "plan",
      durable: true,
      name: "preview",
    });
    expect(started.details.workflowId).toMatch(/^wfr-v1-plan-/);
    expect(harness.controller.startPlan).toHaveBeenCalledTimes(1);
    expect(
      harness.controller.startPlan.mock.calls[0]![0].plan.phases[0].tasks[0]
        .agent.isolation,
    ).toBe("in-process");

    const running = await tools.get("get_workflow_status").execute("status", {
      workflowId: started.details.workflowId,
    });
    expect(running.details).toMatchObject({
      status: "running",
      kind: "plan",
      durable: true,
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "running" }),
        ]),
      },
    });
    const incompleteResult = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: started.details.workflowId });
    expect(incompleteResult.details).toMatchObject({
      status: "running",
      durable: true,
    });
    expect(incompleteResult.isError).toBe(true);

    harness.settle(started.details.workflowId, "done");
    const job = workflowJobRegistry.get(started.details.workflowId)!;
    await job.promise;
    // A stale live adapter cannot mask the authoritative terminal projection.
    job.status = "running";
    const completed = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId: started.details.workflowId });
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(completed.details).toMatchObject({
      status: "done",
      durable: true,
    });
    job.promise = new Promise<WorkflowPlanRunResult>(() => undefined);
    const durableResultWithStaleLiveRow = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: started.details.workflowId });
    expect(durableResultWithStaleLiveRow.details).toMatchObject({
      status: "done",
      durable: true,
    });

    workflowJobRegistry.delete(started.details.workflowId);
    const recoveredStatus = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId: started.details.workflowId });
    expect(recoveredStatus.details).toMatchObject({
      status: "done",
      kind: "plan",
      durable: true,
      accountingCompleteness: "exact",
    });
    const recoveredResult = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: started.details.workflowId });
    expect(recoveredResult.details).toMatchObject({
      status: "done",
      kind: "plan",
      durable: true,
      name: "preview",
    });
    expect(recoveredResult.content[0].text).toContain("done:inspect");

    for (const workflowId of ["wf_missing", "wfr-v1-plan-does-not-exist"]) {
      for (const toolName of [
        "get_workflow_status",
        "get_workflow_result",
        "cancel_workflow",
      ]) {
        const missing = await tools
          .get(toolName)
          .execute("missing", { workflowId });
        expect(missing.details).toEqual({ status: "not_found", workflowId });
        expect(missing.isError).toBe(true);
      }
    }
  });

  it("returns the synchronous durable plan shape and removes only its live adapter", async () => {
    const harness = durableControllerHarness(true);
    const { tools } = makeScopedPi(harness.controller);
    const result = await tools
      .get("workflow")
      .execute(
        "durable-sync",
        { plan: BASE_PLAN, durable: true, async: false },
        undefined,
        vi.fn(),
        toolContext(),
      );

    expect(result.details).toMatchObject({
      status: "done",
      kind: "plan",
      durable: true,
      name: "preview",
    });
    expect(workflowJobRegistry.size).toBe(0);
    const runId = harness.controller.startPlan.mock.calls[0]![0].runId;
    const queried = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId: runId });
    expect(queried.details).toMatchObject({
      status: "done",
      durable: true,
    });
  });

  it("terminal-cancels durable jobs and keeps cancelled results queryable", async () => {
    const harness = durableControllerHarness();
    const { tools } = makeScopedPi(harness.controller);
    const started = await tools
      .get("workflow")
      .execute(
        "durable-cancel",
        { plan: BASE_PLAN, durable: true },
        undefined,
        vi.fn(),
        toolContext(),
      );
    const workflowId = started.details.workflowId;

    const cancelled = await tools
      .get("cancel_workflow")
      .execute("cancel", { workflowId });
    expect(cancelled.details).toMatchObject({
      status: "cancelled",
      durable: true,
      cancelled: true,
    });
    expect(harness.controller.trustedCancel).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        trustedActorId: "workflow-tool",
        expectedOwner: harness.controller.owner,
      }),
    );
    await workflowJobRegistry.get(workflowId)!.promise;
    workflowJobRegistry.delete(workflowId);

    const result = await tools
      .get("get_workflow_result")
      .execute("result", { workflowId });
    expect(result.details).toMatchObject({
      status: "cancelled",
      durable: true,
    });
    expect(result.isError).toBe(true);
    const repeated = await tools
      .get("cancel_workflow")
      .execute("cancel-again", { workflowId });
    expect(repeated.details).toMatchObject({
      status: "cancelled",
      durable: true,
      cancelled: true,
    });
    expect(harness.controller.trustedCancel).toHaveBeenCalledTimes(1);
  });

  it("applies the live job cap before creating a durable run", async () => {
    const harness = durableControllerHarness();
    const { tools } = makeScopedPi(harness.controller);
    const owner = { id: 1, generation: 1 };
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      const job = runningScriptJob(`occupied-${index}`, owner);
      workflowJobRegistry.set(job.id, job);
    }

    const response = await tools
      .get("workflow")
      .execute(
        "durable-cap",
        { plan: BASE_PLAN, durable: true },
        undefined,
        vi.fn(),
        toolContext(),
      );
    expect(response.isError).toBe(true);
    expect(response.details.error).toContain(
      `${MAX_WORKFLOW_JOBS} workflow jobs already running`,
    );
    expect(harness.controller.startPlan).not.toHaveBeenCalled();
  });

  it("treats durable live-adapter cleanup as interruption rather than terminal cancellation", async () => {
    const harness = durableControllerHarness();
    const { tools } = makeScopedPi(harness.controller);
    const started = await tools
      .get("workflow")
      .execute(
        "durable-cleanup",
        { plan: BASE_PLAN, durable: true },
        undefined,
        vi.fn(),
        toolContext(),
      );
    const startOptions = harness.controller.startPlan.mock.calls[0]![0];
    expect(startOptions.signal.aborted).toBe(false);

    cleanupWorkflowJobsForOwner({ id: 1, generation: 1 });

    expect(startOptions.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has(started.details.workflowId)).toBe(false);
    expect(harness.controller.trustedCancel).not.toHaveBeenCalled();
  });

  it("streams synchronous plan progress and returns the final task results", async () => {
    const onUpdate = vi.fn();
    const { tools } = makePi();
    const result = await tools
      .get("workflow")
      .execute(
        "sync-plan",
        { plan: BASE_PLAN, async: false },
        undefined,
        onUpdate,
        toolContext(),
      );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      status: "done",
      kind: "plan",
      agentsSpawned: 2,
      errorCount: 0,
      phases: ["discover", "review"],
    });
    expect(result.content[0].text).toContain("completed: inspect the inputs");
    expect(onUpdate).toHaveBeenCalled();
    expect(
      onUpdate.mock.calls.some(
        ([update]) =>
          update.details.kind === "plan" && update.details.status === "running",
      ),
    ).toBe(true);
    expect(
      [...workflowJobRegistry.values()].some((job) => job.name === "preview"),
    ).toBe(false);
  });

  it("projects coordinator-owned agent failure and stops later phases", async () => {
    mockAwaitInteractiveResult.mockResolvedValueOnce(
      failedResult("agent boom"),
    );
    const { tools } = makePi();
    const result = await tools
      .get("workflow")
      .execute(
        "failed-plan",
        { plan: BASE_PLAN, async: false },
        undefined,
        vi.fn(),
        toolContext(),
      );

    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      status: "error",
      kind: "plan",
      errorCount: 1,
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "failed" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "cancelled",
          }),
        ]),
      },
    });
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
  });

  it("uses the shared cancellation lifecycle for a running plan", async () => {
    mockAwaitInteractiveResult.mockImplementation(
      (_state: unknown, signal: AbortSignal) =>
        new Promise<SubagentResult>((resolve) => {
          if (signal.aborted) resolve(cancelledResult());
          else
            signal.addEventListener("abort", () => resolve(cancelledResult()), {
              once: true,
            });
        }),
    );
    const { tools } = makePi();
    const started = await tools
      .get("workflow")
      .execute(
        "cancel-plan",
        { plan: BASE_PLAN },
        undefined,
        vi.fn(),
        toolContext(),
      );
    const workflowId = started.details.workflowId;
    await vi.waitFor(() =>
      expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1),
    );

    const cancelled = await tools
      .get("cancel_workflow")
      .execute("cancel", { workflowId });
    expect(cancelled.details).toMatchObject({
      status: "cancelled",
      workflowId,
      cancelled: true,
    });
    await workflowJobRegistry.get(workflowId)!.promise;
    const status = await tools
      .get("get_workflow_status")
      .execute("status", { workflowId });
    expect(status.details).toMatchObject({
      status: "cancelled",
      kind: "plan",
      planProjection: {
        rows: expect.arrayContaining([
          expect.objectContaining({ taskId: "inspect", status: "cancelled" }),
          expect.objectContaining({
            taskId: "review-result",
            status: "cancelled",
          }),
        ]),
      },
    });
  });

  it("shares the script job cap and owner fences", async () => {
    const ownerA = { id: 41, generation: 1 };
    const ownerB = { id: 42, generation: 1 };
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      const job = runningScriptJob(`script-${index}`, ownerA);
      workflowJobRegistry.set(job.id, job);
    }
    const runner = vi.fn(async () => successfulResult("never"));

    expect(() =>
      startWorkflowPlanJob(
        BASE_PLAN,
        { runAgent: runner },
        undefined,
        undefined,
        ownerA,
      ),
    ).toThrow(/workflow jobs already running/);
    expect(runner).not.toHaveBeenCalled();

    workflowJobRegistry.clear();
    const job = startWorkflowPlanJob(
      BASE_PLAN,
      { runAgent: runner },
      undefined,
      undefined,
      ownerA,
    );
    expect(getWorkflowJobForOwner(job.id, ownerA)).toBe(job);
    expect(getWorkflowJobForOwner(job.id, ownerB)).toBeUndefined();
    await job.promise;
  });

  it("keeps legacy script and saved-name call results unchanged", async () => {
    const { tools } = makePi();
    const workflow = tools.get("workflow");
    const scriptResult = await workflow.execute(
      "legacy-script",
      { script: LEGACY_SCRIPT("legacy-script"), async: false },
      undefined,
      vi.fn(),
      toolContext(),
    );
    expect(scriptResult.details).toMatchObject({
      status: "done",
      name: "legacy-script",
      agentsSpawned: 1,
    });
    expect(scriptResult.details).not.toHaveProperty("kind");

    mockLoadWorkflowScript.mockReturnValue(LEGACY_SCRIPT("legacy-name"));
    const nameResult = await workflow.execute(
      "legacy-name",
      { name: "saved", async: false },
      undefined,
      vi.fn(),
      toolContext(),
    );
    expect(mockLoadWorkflowScript).toHaveBeenCalledWith("saved");
    expect(nameResult.details).toMatchObject({
      status: "done",
      name: "legacy-name",
      agentsSpawned: 1,
    });
    expect(nameResult.details).not.toHaveProperty("kind");
  });
});
