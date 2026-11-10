import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/workflow-worker";
import {
  runWorkflowDefinition,
  WorkflowCancelledError,
} from "../src/workflow-v4-runtime.mjs";
import {
  getLiveWorkflowV4Store,
  WorkflowV4Store,
} from "../src/workflow-v4-store";
import { DurableWorkflow } from "../src/workflow-durable";
import {
  decodeRunValue,
  encodeRunValue,
  WorkflowRunStore,
} from "../src/workflow-run-store";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import type { WorkflowContext } from "../types/workflow-v4";

const script =
  'export const meta={name:"policy-recovery",description:"d"}; return 1;';
const workflowSource = "policy-recovery-workflow";

type ErrorSummary = { name: string; message: string; category?: string };
type AgentRunner = (
  prompt: string,
  options: Record<string, unknown>,
) => Promise<unknown>;
type TestWorkflow = {
  name: string;
  version: number;
  run: (ctx: WorkflowContext, args: unknown) => unknown;
};

let root: string;
const stores: WorkflowRunStore[] = [];
const stepStores: WorkflowV4Store[] = [];
type RunSettlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: unknown };
type TrackedRun = {
  state: WorkflowV4Store;
  controller: AbortController;
  settled: Promise<RunSettlement>;
};
const runningWorkflows: TrackedRun[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-v4-policy-recovery-"));
});
afterEach(async () => {
  const running = runningWorkflows.splice(0);
  for (const run of running) {
    if (!run.controller.signal.aborted) {
      run.controller.abort(
        Object.assign(new Error("Workflow durably interrupted."), {
          source: "durable_interrupt",
        }),
      );
    }
    await run.state.close();
  }
  await Promise.all(running.map((run) => run.settled));
  for (const state of stepStores.splice(0)) await state.close();
  for (const store of stores.splice(0)) await store.close();
  await rm(root, { recursive: true, force: true });
});

function definition(run: TestWorkflow["run"]): TestWorkflow {
  return { name: "policy-recovery", version: 1, run };
}

async function createState() {
  const scope = {
    cwd: root,
    sessionId: "workflow-v4-policy-recovery",
    root,
  };
  const store = await WorkflowRunStore.create(scope, { script });
  stores.push(store);
  const state = new WorkflowV4Store(workflowSource, store);
  stepStores.push(state);
  return { scope, store, state };
}

function makeBridge(
  state: WorkflowV4Store,
  agent: AgentRunner,
  signal?: AbortSignal,
) {
  return {
    signal,
    budget: { total: 100, spent: () => 0, remaining: () => 100 },
    validate: async () => [],
    request(action: string, payload: unknown, requestSignal?: AbortSignal) {
      return state.request(action, payload, requestSignal);
    },
    agent,
    async workflow(name: string, args: unknown) {
      return { name, args };
    },
  };
}

function startRun(
  workflow: TestWorkflow,
  state: WorkflowV4Store,
  agent: AgentRunner,
  controller: AbortController,
) {
  const promise = runWorkflowDefinition(
    workflow,
    {},
    makeBridge(state, agent, controller.signal),
  );
  const settled = promise.then(
    (value): RunSettlement => ({ status: "fulfilled", value }),
    (reason): RunSettlement => ({ status: "rejected", reason }),
  );
  runningWorkflows.push({ state, controller, settled });
  return promise;
}

function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error))
    return { name: "Error", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...("category" in error && typeof error.category === "string"
      ? { category: error.category }
      : {}),
  };
}

async function durablyInterrupt(
  controller: AbortController,
  state: WorkflowV4Store,
  store: WorkflowRunStore,
  running: Promise<unknown>,
) {
  controller.abort(
    Object.assign(new Error("Workflow durably interrupted."), {
      source: "durable_interrupt",
    }),
  );
  await state.close();
  try {
    await running;
  } finally {
    await store.append("interrupted", {
      status: "interrupted",
      reason: "durable_interrupt",
    });
    await store.close();
  }
}

function waitForWorkflowTransition<T>(
  transition: Promise<T>,
  running: Promise<unknown>,
  description: string,
): Promise<T> {
  return Promise.race([
    transition,
    running.then(
      () => {
        throw new Error(`Workflow completed before ${description}.`);
      },
      (error) => {
        throw error;
      },
    ),
  ]);
}

describe("v4 durable policy recovery", () => {
  it("preserves native TypeError fields after durable interruption and resume", async () => {
    const vmScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "error-recovery", version: 1,
        async run(ctx) {
          let caught;
          try {
            await ctx.step("bad-step", { input: "stable" }, () => {
              const failure = new TypeError("bad");
              failure.category = "provider";
              throw failure;
            });
          } catch (error) {
            caught = {
              name: error.name,
              message: error.message,
              category: error.category,
            };
          }
          await ctx.checkpoint("captured-error", caught);
          await ctx.gate("approval", { title: "Continue?" });
          return caught;
        } });`;
    const scope = {
      cwd: root,
      sessionId: "workflow-v4-native-error-recovery",
      root,
    };
    const store = await WorkflowRunStore.create(scope, {
      script: vmScript,
      args: encodeRunValue({}),
      budgetTotal: 100,
    });
    stores.push(store);
    const expected = {
      name: "TypeError",
      message: "bad",
      category: "provider",
    };
    const runAgent: WorkflowAgentRunner = async () => ({
      isError: false,
      output: "",
      usage: zeroUsage(),
    });
    const gateWaitingCount = (events: WorkflowRunStore["events"]) =>
      events.filter(
        (event) =>
          event.kind === "v4.step" &&
          event.data.path.join("/") === "approval" &&
          event.data.status === "waiting_for_input",
      ).length;
    const checkpointValue = (events: WorkflowRunStore["events"]) => {
      const checkpoint = events.findLast(
        (event) =>
          event.kind === "v4.step" &&
          event.data.path.join("/") === "captured-error",
      );
      return checkpoint
        ? decodeRunValue<ErrorSummary>(checkpoint.data.output)
        : undefined;
    };

    const firstDurable = new DurableWorkflow(store);
    const firstController = new AbortController();
    const firstGateWaiting = Promise.withResolvers<void>();
    const firstRun = runWorkflow(vmScript, {
      args: {},
      cwd: root,
      budgetTotal: 100,
      durable: firstDurable,
      runAgent,
      signal: firstController.signal,
      onStep: (steps) => {
        if (
          steps.some(
            (step) =>
              step.path.join("/") === "approval" &&
              step.status === "waiting_for_input",
          )
        )
          firstGateWaiting.resolve();
      },
    });
    const firstSettled = firstRun.then(
      () => undefined,
      () => undefined,
    );
    let firstCapture: ErrorSummary | undefined;
    try {
      await waitForWorkflowTransition(
        firstGateWaiting.promise,
        firstRun,
        "the initial approval gate",
      );
      firstCapture = checkpointValue(store.events);
      expect(firstCapture).toBeDefined();
      firstController.abort(
        Object.assign(new Error("durable_interrupt"), {
          source: "durable_interrupt",
        }),
      );
      await expect(firstRun).rejects.toThrow();
    } finally {
      if (!firstController.signal.aborted) {
        firstController.abort(
          Object.assign(new Error("durable_interrupt"), {
            source: "durable_interrupt",
          }),
        );
      }
      await firstSettled;
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumedController = new AbortController();
    const resumedGateWaiting = Promise.withResolvers<void>();
    const resumedRun = runWorkflow(vmScript, {
      args: {},
      cwd: root,
      budgetTotal: 100,
      durable: resumedDurable,
      runAgent,
      signal: resumedController.signal,
      onStep: (steps) => {
        if (
          gateWaitingCount(resumedStore.events) > 1 &&
          steps.some(
            (step) =>
              step.path.join("/") === "approval" &&
              step.status === "waiting_for_input",
          )
        )
          resumedGateWaiting.resolve();
      },
    });
    const resumedSettled = resumedRun.then(
      () => undefined,
      () => undefined,
    );
    try {
      await waitForWorkflowTransition(
        resumedGateWaiting.promise,
        resumedRun,
        "the resumed approval gate",
      );
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live?.getStep(["approval"])).toMatchObject({
        status: "waiting_for_input",
        attempt: 1,
      });
      await live!.answer(["approval"], true);
      const result = await resumedRun;

      expect(firstCapture).toEqual(expected);
      expect(result.result).toEqual(expected);
      expect(result.result).toEqual(firstCapture);
    } finally {
      if (!resumedController.signal.aborted) {
        resumedController.abort(
          Object.assign(new Error("durable_interrupt"), {
            source: "durable_interrupt",
          }),
        );
      }
      await resumedSettled;
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });
  it("replays a caught default agent failure after interruption without losing the waiting attempt", async () => {
    const { scope, store, state } = await createState();
    const failures: ErrorSummary[] = [];
    const expectedFailure: ErrorSummary = {
      name: "Error",
      message: "Agent provider unavailable.",
      category: "unknown",
    };
    const expectedFailures = [expectedFailure, expectedFailure];
    const agent = vi.fn(async () => {
      throw Object.assign(new Error("Agent provider unavailable."), {
        category: "unknown",
      });
    });
    const workflow = definition(async (ctx) => {
      try {
        await ctx.agent("handled", { prompt: "Call the failing agent" });
      } catch (error) {
        failures.push(summarizeError(error));
      }
      await ctx.gate("approval", { title: "Continue?" });
      return "complete";
    });
    const firstController = new AbortController();
    const firstRun = startRun(workflow, state, agent, firstController);

    await vi.waitFor(() =>
      expect(state.getStep(["approval"])?.status).toBe("waiting_for_input"),
    );
    expect(agent).toHaveBeenCalledTimes(1);
    await expect(
      durablyInterrupt(firstController, state, store, firstRun),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);

    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedState = new WorkflowV4Store(workflowSource, resumedStore);
    stepStores.push(resumedState);
    expect(resumedState.getStep(["approval"])).toMatchObject({
      status: "waiting_for_input",
      attempt: 1,
    });

    const resumedController = new AbortController();
    const resumedRun = startRun(
      workflow,
      resumedState,
      agent,
      resumedController,
    );
    await vi.waitFor(() => expect(failures).toEqual(expectedFailures));
    expect(resumedState.getStep(["approval"])?.status).toBe(
      "waiting_for_input",
    );

    expect(failures).toEqual(expectedFailures);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(resumedState.getStep(["handled"])?.error).toMatchObject({
      message: "Agent provider unavailable.",
      category: "unknown",
    });
    expect(resumedState.getStep(["approval"])).toMatchObject({
      status: "waiting_for_input",
      attempt: 1,
    });

    await expect(
      durablyInterrupt(
        resumedController,
        resumedState,
        resumedStore,
        resumedRun,
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
  });

  it("reruns a private persona router and invalidates the downstream agent after gate recovery", async () => {
    const { scope, store, state } = await createState();
    const personas = ["persona-a", "persona-b"];
    const agent = vi.fn(
      async (prompt: string, options: Record<string, unknown>) => {
        if (prompt === "Select a persona") return personas.shift();
        return `review-${String(options.persona)}`;
      },
    );
    const workflow = definition(async (ctx) => {
      const persona = await ctx.agent("router", {
        prompt: "Select a persona",
        persist: false,
      });
      const review = await ctx.agent("review", {
        prompt: "Review the same source",
        model: "review-model",
        persona,
        isolation: "process",
        thinkingLevel: "high",
        readOnly: false,
        output: { type: "string" },
      });
      const approved = await ctx.gate("approval", {
        title: "Approve the review?",
      });
      return { persona, review, approved };
    });
    const firstController = new AbortController();
    const firstRun = startRun(workflow, state, agent, firstController);

    await vi.waitFor(() =>
      expect(state.getStep(["approval"])?.status).toBe("waiting_for_input"),
    );
    expect(
      agent.mock.calls.filter(
        ([prompt]) => prompt === "Review the same source",
      ),
    ).toHaveLength(1);
    await expect(
      durablyInterrupt(firstController, state, store, firstRun),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);

    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedState = new WorkflowV4Store(workflowSource, resumedStore);
    stepStores.push(resumedState);
    expect(resumedState.getStep(["approval"])).toMatchObject({
      status: "waiting_for_input",
      attempt: 1,
    });
    await resumedState.answer(["approval"], true);

    const resumedRun = startRun(
      workflow,
      resumedState,
      agent,
      new AbortController(),
    );
    await expect(resumedRun).resolves.toEqual({
      persona: "persona-b",
      review: "review-persona-b",
      approved: true,
    });
    expect(
      agent.mock.calls.filter(
        ([prompt]) => prompt === "Review the same source",
      ),
    ).toHaveLength(2);
    expect(
      agent.mock.calls.filter(([prompt]) => prompt === "Select a persona"),
    ).toHaveLength(2);
    expect(resumedState.getStep(["approval"])?.attempt).toBe(1);

    await resumedStore.close();
  });
});
