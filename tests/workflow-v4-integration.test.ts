import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/workflow-worker";
import { DurableWorkflow } from "../src/workflow-durable";
import { getLiveWorkflowV4Store } from "../src/workflow-v4-store";
import {
  WorkflowRunStore,
  encodeRunValue,
  type RunScope,
} from "../src/workflow-run-store";
import { zeroUsage } from "../src/usage";
import {
  WorkflowFailureError,
  zeroWorkflowUsage,
  type WorkflowAgentRunner,
} from "../src/workflow-core";

const roots: string[] = [];
const stores: WorkflowRunStore[] = [];
function waitForWorkflowWorker(assertion: () => void) {
  return vi.waitFor(assertion, { timeout: 10_000 });
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function source(run: string, input = "") {
  return `import { defineWorkflow, schema } from "pi-subagentura/workflow";
    ${input}
    export default defineWorkflow({ name: "integration", version: 1,
      ${input ? "input: ArgsSchema," : ""}
      run: async function(ctx, args) { ${run} }
    });`;
}

function ok(output: string) {
  return {
    isError: false as const,
    output,
    usage: { ...zeroUsage(), output: 3 },
  };
}

async function fixture(script: string, args: unknown = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-v4-e2e-"));
  roots.push(root);
  const scope: RunScope = { root, cwd: root, sessionId: "integration-parent" };
  const store = await WorkflowRunStore.create(scope, {
    script,
    args: encodeRunValue(args),
    budgetTotal: 1000,
  });
  stores.push(store);
  return { root, scope, store };
}

async function execute(
  store: WorkflowRunStore,
  runAgent: WorkflowAgentRunner,
  extra: object = {},
) {
  const durable = new DurableWorkflow(store);
  try {
    return await runWorkflow(store.events[0].data.script, {
      args: {},
      cwd: store.events[0].data.cwd,
      budgetTotal: 1000,
      durable,
      runAgent,
      ...extra,
    });
  } finally {
    durable.stop();
    await durable.drain();
  }
}

describe("v4 workflow integration through worker and durable store", () => {
  it("nests child step paths under the parent workflow step", async () => {
    const parent = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-parent", version: 1,
        input: schema.object({ count: schema.number() }),
        async run(ctx, args) {
          return ctx.group("outer", () =>
            ctx.workflow("nested-child", { count: args.count }, { id: "child" }));
        } });`;
    const child = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-child", version: 1,
        input: schema.object({ count: schema.number() }),
        async run(ctx, args) {
          return ctx.step("value", { input: "stable-step-input" }, () => args.count);
        } });`;
    const { store } = await fixture(parent, { count: 1 });
    const runOptions = {
      loadWorkflow: (name: string) => (name === "nested-child" ? child : null),
    };

    const first = await execute(store, async () => ok(""), {
      ...runOptions,
      args: { count: 1 },
    });
    expect(first.result).toBe(1);
    const firstSteps = store.events
      .filter((event) => event.kind === "v4.step")
      .map((event) => event.data);
    const parentWorkflowStep = firstSteps.find((step) => step.id === "child");
    const nestedValueStep = firstSteps.find((step) => step.id === "value");
    expect(parentWorkflowStep?.path).toEqual(["outer", "child"]);
    expect(nestedValueStep?.path).toEqual(["outer", "child", "value"]);
  });

  it("invalidates nested child steps when the parent invocation changes and reuses stable resumes", async () => {
    const parent = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-parent", version: 1,
        input: schema.object({ count: schema.number() }),
        async run(ctx, args) {
          return ctx.workflow("nested-child", { count: args.count }, { id: "child" });
        } });`;
    const child = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-child", version: 1,
        input: schema.object({ count: schema.number() }),
        async run(ctx, args) {
          return ctx.step("value", { input: "stable-step-input" }, () => args.count);
        } });`;
    const { store } = await fixture(parent, { count: 1 });
    const runOptions = {
      loadWorkflow: (name: string) => (name === "nested-child" ? child : null),
    };

    await expect(
      execute(store, async () => ok(""), {
        ...runOptions,
        args: { count: 1 },
      }),
    ).resolves.toMatchObject({ result: 1 });
    const changed = await execute(store, async () => ok(""), {
      ...runOptions,
      args: { count: 2 },
    });
    expect(changed.result).toBe(2);
    const resumed = await execute(store, async () => ok(""), {
      ...runOptions,
      args: { count: 2 },
    });
    expect(resumed.result).toBe(2);
  });

  it("preserves legacy null handling inside a v4 nested workflow", async () => {
    const parent = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-parent", version: 1,
        async run(ctx) { return ctx.workflow("legacy-child", {}, { id: "child" }); }
      });`;
    const child = `export const meta = { name: "legacy-child", description: "Legacy child" };
      const result = await agent("return nothing");
      return result ?? "legacy-null";`;
    const { store } = await fixture(parent);
    const result = await execute(
      store,
      async () => ({
        isError: true,
        output: "",
        errorMessage: "provider failure",
        usage: { ...zeroUsage() },
      }),
      {
        loadWorkflow: (name: string) =>
          name === "legacy-child" ? child : null,
      },
    );
    expect(result.result).toBe("legacy-null");
  });

  it("runs typed SDK agents, step combinators, checkpoints and artifacts without leaking step outputs", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      const Result = schema.object({ answer: schema.string() });
      export default defineWorkflow({ name: "integration", version: 1,
        output: schema.object({ answer: schema.string(), digest: schema.string() }),
        async run(ctx, args: { question: string }) {
          const first = await ctx.step("first", async () => "private-step-output");
          const grouped = await ctx.group("group", "Group", () => ctx.parallel({
            left: () => ctx.step("left", async () => 2),
            right: () => ctx.step("right", async () => 3),
          }, { concurrency: 2 }));
          const mapped = await ctx.map([1, 2], (n: number) => n * 2,
            { stepId: "map", concurrency: 2 });
          const repeated = await ctx.repeat("repeat", { maxIterations: 3,
            until: ({ value }: { value: number }) => value >= 2 },
            ({ iteration }: { iteration: number }) => iteration);
          await ctx.checkpoint("checkpoint", { saved: true });
          const artifact = await ctx.artifact.write("result", { kept: true });
          const agent = await ctx.agent("answer-agent", { prompt: "answer the question", output: Result });
          return { answer: agent.answer, digest: [first, grouped.left, grouped.right, ...mapped, repeated.iterations, artifact.id].join(":" ) };
        } });`;
    const { store } = await fixture(script);
    const runner = vi.fn(async (req) => {
      expect(req.prompt).toContain("answer");
      return ok('{"answer":"structured"}');
    });
    const snapshots: any[] = [];
    const result = await execute(store, runner, {
      onStep: (steps: unknown) => snapshots.push(steps),
    });
    expect((result.result as { answer: string }).answer).toBe("structured");
    expect(runner).toHaveBeenCalledOnce();
    const kinds = store.events.map((event) => event.kind);
    expect(kinds).toContain("v4.step");
    expect(kinds).toContain("v4.artifact");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshots)).not.toContain("private-step-output");
    expect(
      JSON.stringify(store.events.filter((event) => event.kind === "v4.step")),
    ).not.toContain("private-step-output");
    const artifactRef = store.events.find(
      (event) => event.kind === "v4.artifact",
    )?.data.ref;
    expect(artifactRef).toBeDefined();
    await expect(
      readFile(join(store.directory, "v4-artifacts", artifactRef.id), "utf8"),
    ).resolves.toBe('{"kept":true}');
  });

  it("records an errored agent as a failed collected step, never a null success", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "agent-error", version: 1,
        async run(ctx) {
          return ctx.agent("provider", { prompt: "fail", failure: "collect" });
        } });`;
    const { store } = await fixture(script);
    const runner: WorkflowAgentRunner = async () => ({
      isError: true,
      errorMessage: "provider failed",
      output: "",
      usage: { ...zeroUsage() },
    });

    const result = await execute(store, runner);
    expect(result.result).toMatchObject({
      ok: false,
      error: { category: "unknown", stage: "completion" },
    });
    const agentStep = store.events
      .filter((event) => event.kind === "v4.step")
      .at(-1);
    expect(agentStep?.data.status).toBe("failed");
  });

  it("propagates cancelled agent outcomes through collect policy", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "agent-cancel", version: 1,
        async run(ctx) {
          return ctx.agent("cancelled", { prompt: "cancel", failure: "collect" });
        } });`;
    const { store } = await fixture(script);
    const runner: WorkflowAgentRunner = async () => ({
      isError: false,
      cancelled: true,
      output: "",
      usage: { ...zeroUsage() },
    });

    await expect(execute(store, runner)).rejects.toThrow(/cancel/i);
    const agentStep = store.events
      .filter((event) => event.kind === "v4.step")
      .at(-1);
    expect(agentStep?.data.status).toBe("cancelled");
  });

  it("turns structured-output exhaustion into a failed schema step", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "agent-schema-fail", version: 1,
        async run(ctx) {
          return ctx.agent("structured", {
            prompt: "invalid json", output: schema.object({ answer: schema.string() }),
            failure: "collect",
          });
        } });`;
    const { store } = await fixture(script);
    const runner = vi.fn<WorkflowAgentRunner>(async () => ok("not json"));

    const result = await execute(store, runner);
    expect(runner).toHaveBeenCalledTimes(3);
    expect(result.result).toMatchObject({
      ok: false,
      error: { category: "schema", stage: "schema_validation" },
    });
    expect(
      store.events.filter((event) => event.kind === "v4.step").at(-1)?.data
        .status,
    ).toBe("failed");
  });
  it("restores collected schema error counts after a gate interruption", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "schema-error-resume", version: 1,
        async run(ctx) {
          const failed = await ctx.agent("structured", {
            prompt: "invalid json",
            output: schema.object({ answer: schema.string() }),
            failure: "collect",
          });
          const answer = await ctx.ask("schema-gate", {
            prompt: "Continue?",
            choices: ["yes", "no"],
          });
          return { failed, answer };
        } });`;
    const { scope, store } = await fixture(script);
    const runner = vi.fn<WorkflowAgentRunner>(async () => ok("{}"));
    const abort = new AbortController();
    const firstDurable = new DurableWorkflow(store);
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "schema-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(3);
      abort.abort(
        Object.assign(new Error("durable_interrupt"), {
          source: "durable_interrupt",
        }),
      );
      await expect(interrupted).rejects.toThrow();
    } finally {
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumed = runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      durable: resumedDurable,
      runAgent: runner,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          resumedStore.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "schema-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(3);
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live).toBeDefined();
      await live!.answer(["schema-gate"], "yes");

      const result = await resumed;
      expect(result.errorCount).toBe(1);
      expect(result.result).toMatchObject({
        failed: {
          ok: false,
          error: { category: "schema", stage: "schema_validation" },
        },
        answer: "yes",
      });
      expect(runner).toHaveBeenCalledTimes(3);
    } finally {
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });

  it("counts schema exhaustion per outer retry without double-counting runner failures", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "schema-retry-error-count", version: 1,
        async run(ctx) {
          const schemaFailure = await ctx.agent("repeated-schema", {
            prompt: "invalid json",
            output: schema.object({ answer: schema.string() }),
            failure: "collect",
            retry: { attempts: 2 },
          });
          const runnerFailure = await ctx.agent("runner-error", {
            prompt: "runner-error",
            failure: "collect",
          });
          const arbitraryStepFailure = await ctx.step(
            "non-agent-step",
            { failure: "collect" },
            async () => ctx.step("invalid-step", {}, null),
          );
          const answer = await ctx.ask("resume-gate", {
            prompt: "Continue?",
            choices: ["yes", "no"],
          });
          return { schemaFailure, runnerFailure, arbitraryStepFailure, answer };
        } });`;
    const { scope, store } = await fixture(script);
    const runner = vi.fn<WorkflowAgentRunner>(async ({ prompt }) =>
      prompt === "runner-error"
        ? {
            isError: true,
            output: "runner failed",
            errorMessage: "runner failed",
            usage: { ...zeroUsage(), output: 1 },
          }
        : ok("{}"),
    );
    const abort = new AbortController();
    const firstDurable = new DurableWorkflow(store);
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "resume-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(7);
      abort.abort(
        Object.assign(new Error("durable_interrupt"), {
          source: "durable_interrupt",
        }),
      );
      await expect(interrupted).rejects.toThrow();
    } finally {
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumed = runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      durable: resumedDurable,
      runAgent: runner,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          resumedStore.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "resume-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(7);
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live).toBeDefined();
      await live!.answer(["resume-gate"], "yes");

      const result = await resumed;
      expect(result.errorCount).toBe(3);
      expect(result.result).toMatchObject({
        answer: "yes",
        arbitraryStepFailure: {
          ok: false,
          error: { category: "schema" },
        },
      });
      expect(
        resumedStore.events.some(
          (event) =>
            event.kind === "v4.step" &&
            event.data.kind !== "agent" &&
            event.data.error?.category === "schema",
        ),
      ).toBe(true);
      expect(runner).toHaveBeenCalledTimes(7);
    } finally {
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });

  it("journals ctx.log progress with its scoped step path", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "logged-step", version: 1,
        async run(ctx) {
          await ctx.step("logged", () => ctx.log("progress detail"));
          return "done";
        } });`;
    const { store } = await fixture(script);
    const progress = vi.fn();
    const result = await execute(store, async () => ok("unused"), {
      onProgress: progress,
    });

    expect(result.result).toBe("done");
    expect(store.events).toContainEqual(
      expect.objectContaining({
        kind: "v4.progress",
        data: { path: ["logged"], message: "progress detail" },
      }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "log", message: "progress detail" }),
    );
  });

  it("persists a human gate answer and resumes the live worker", async () => {
    const script =
      source(`const answer = await ctx.ask("approval", { prompt: "Continue?", choices: ["yes", "no"] });
      return { answer };`);
    const { store } = await fixture(script);
    const durable = new DurableWorkflow(store);
    const running = runWorkflow(script, {
      durable,
      runAgent: async () => ok(""),
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      const live = getLiveWorkflowV4Store(store.id);
      expect(live).toBeDefined();
      await live!.answer(["approval"], "yes");
      await expect(running).resolves.toMatchObject({
        result: { answer: "yes" },
      });
      expect(
        store.events.some(
          (event) => event.kind === "v4.step" && event.data.answer === "yes",
        ),
      ).toBe(true);
    } finally {
      durable.stop();
      await durable.drain();
    }
  });

  it("closes a gate wait when the caller aborts", async () => {
    const script = source(
      `await ctx.gate("approval", { prompt: "Approve?" }); return "done";`,
    );
    const { store } = await fixture(script);
    const abort = new AbortController();
    const durable = new DurableWorkflow(store);
    const running = runWorkflow(script, {
      durable,
      signal: abort.signal,
      runAgent: async () => ok(""),
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      abort.abort(new Error("cancel test"));
      await expect(running).rejects.toThrow();
    } finally {
      durable.stop();
      await durable.drain();
    }
  });

  it("reuses committed steps and stable agent IDs after interruption", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "integration", version: 1,
        async run(ctx, args) {
          if (args.shift) await ctx.step("shift-before-agent", async () => "new host RPCs");
          const value = await ctx.step("prepared", async () => "persisted");
          const first = await ctx.agent("stable-agent", { prompt: "first" });
          const second = await ctx.agent("pending-agent", { prompt: "second" });
          return { value, first, second };
        } });`;
    const { scope, store } = await fixture(script);
    const firstAbort = new AbortController();
    const attempts: Array<{ prompt: unknown; key: string }> = [];
    const firstRunner: WorkflowAgentRunner = async (request) => {
      attempts.push({
        prompt: request.prompt,
        key: request.durableAttempt!.key,
      });
      if (request.prompt === "second") {
        await new Promise<never>((_resolve, reject) => {
          request.signal!.addEventListener(
            "abort",
            () => reject(request.signal!.reason),
            { once: true },
          );
        });
      }
      return ok(request.prompt === "first" ? "first-result" : "late");
    };
    const firstDurable = new DurableWorkflow(store);
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: firstRunner,
      signal: firstAbort.signal,
      budgetTotal: 1000,
    });
    try {
      await waitForWorkflowWorker(() => expect(attempts).toHaveLength(2));
      firstAbort.abort(new Error("simulate interruption"));
      await expect(interrupted).rejects.toThrow();
    } finally {
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumeRunner: WorkflowAgentRunner = async (request) => {
      attempts.push({
        prompt: request.prompt,
        key: request.durableAttempt!.key,
      });
      return ok("resumed-result");
    };
    const result = await execute(resumedStore, resumeRunner, {
      args: { shift: true },
    });
    expect(result.result).toMatchObject({
      value: "persisted",
      first: "first-result",
      second: "resumed-result",
    });
    expect(attempts.filter((item) => item.prompt === "first")).toHaveLength(1);
    expect(attempts.filter((item) => item.prompt === "second")).toHaveLength(2);
    const durableAttemptKeys = resumedStore.events
      .filter((event) => event.kind === "attempt")
      .map((event) => event.data.key);
    expect(durableAttemptKeys).toHaveLength(2);
    expect(
      resumedStore.events.some(
        (event) =>
          event.kind === "v4.step" && event.data.status === "completed",
      ),
    ).toBe(true);
  });
  it("replays committed output once globally while retaining step budget attribution", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "replay-budget-accounting", version: 1,
        async run(ctx) {
          const first = await ctx.step("first-step", {
            budget: 2,
            failure: "collect",
          }, () => ctx.agent("first-agent", { prompt: "first" }));
          await ctx.gate("continue", { prompt: "Continue?" });
          const spentBeforeFollowing = ctx.budget.spent();
          const remainingBeforeFollowing = ctx.budget.remaining();
          const following = await ctx.agent("following-agent", {
            prompt: "following",
          });
          return {
            first,
            spentBeforeFollowing,
            remainingBeforeFollowing,
            following,
            spentAfterFollowing: ctx.budget.spent(),
          };
        } });`;
    const { scope, store } = await fixture(script);
    const abort = new AbortController();
    const runner = vi.fn<WorkflowAgentRunner>(async ({ prompt }) =>
      ok(prompt === "first" ? "first-result" : "following-result"),
    );
    const firstDurable = new DurableWorkflow(store);
    const originalAppend = store.append.bind(store);
    let committedOutcome = false;
    const appendSpy = vi
      .spyOn(store, "append")
      .mockImplementation(async (kind, data) => {
        await originalAppend(kind, data);
        if (kind === "outcome" && !committedOutcome) {
          committedOutcome = true;
          abort.abort(
            Object.assign(new Error("durable_interrupt"), {
              source: "durable_interrupt",
            }),
          );
        }
      });
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
      budgetTotal: 6,
    });
    try {
      await expect(interrupted).rejects.toThrow();
    } finally {
      appendSpy.mockRestore();
      firstDurable.stop();
      await firstDurable.drain();
    }
    expect(committedOutcome).toBe(true);
    expect(
      store.events.some(
        (event) => event.kind === "outcome" && event.data.ok === true,
      ),
    ).toBe(true);
    expect(
      store.events.some(
        (event) =>
          event.kind === "v4.step" &&
          event.data.path.join("/") === "first-step" &&
          event.data.status === "completed",
      ),
    ).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumed = runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      durable: resumedDurable,
      runAgent: runner,
      budgetTotal: 6,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          resumedStore.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "continue" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(resumedDurable.usage().output).toBe(3);
      expect(runner).toHaveBeenCalledTimes(1);
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live).toBeDefined();
      await live!.answer(["continue"], true);

      const result = await resumed;
      expect(result.result).toMatchObject({
        first: {
          ok: false,
          error: { category: "budget", stage: "budget" },
        },
        spentBeforeFollowing: 3,
        remainingBeforeFollowing: 3,
        following: "following-result",
        spentAfterFollowing: 6,
      });
      expect(result.usage?.output).toBe(6);
      expect(resumedDurable.usage().output).toBe(6);
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });

  it.each([
    { caseName: "missing terminal usage", terminalUsage: undefined },
    { caseName: "empty terminal usage", terminalUsage: zeroUsage() },
  ])(
    "charges normalized live output to the global budget after a durable runner failure ($caseName)",
    async ({ terminalUsage }) => {
      const script = source(`
        const failed = await ctx.agent("partial", {
          prompt: "partial",
          failure: "collect",
        });
        return { failed, spent: ctx.budget.spent() };`);
      const { store } = await fixture(script);
      const runner = vi.fn<WorkflowAgentRunner>(async (request) => {
        request.onProgress?.({
          kind: "phase",
          phase: "partial",
          liveUsage: {
            input: 0,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            costUsd: 0,
            turns: 0,
          },
        });
        const error = new Error("runner failed");
        if (terminalUsage !== undefined)
          Object.assign(error, { usage: terminalUsage });
        throw error;
      });

      const result = await execute(store, runner, { budgetTotal: 10 });
      expect(runner).toHaveBeenCalledOnce();
      expect(result.result).toMatchObject({ spent: 3 });
      expect(result.usage?.output).toBe(3);
    },
  );

  it("restores live usage from a committed failed runner outcome", async () => {
    const script = source(`
      const failed = await ctx.agent("partial", {
        prompt: "partial",
        failure: "collect",
      });
      return { failed, spent: ctx.budget.spent() };`);
    const { scope, store } = await fixture(script);
    const abort = new AbortController();
    const runner = vi.fn<WorkflowAgentRunner>(async (request) => {
      request.onProgress?.({
        kind: "phase",
        phase: "partial",
        liveUsage: {
          input: 0,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          costUsd: 0,
          turns: 0,
        },
      });
      throw new Error("runner failed");
    });
    const firstDurable = new DurableWorkflow(store);
    const originalAppend = store.append.bind(store);
    let committedOutcome = false;
    const appendSpy = vi
      .spyOn(store, "append")
      .mockImplementation(async (kind, data) => {
        await originalAppend(kind, data);
        if (kind === "outcome" && !committedOutcome) {
          committedOutcome = true;
          abort.abort(
            Object.assign(new Error("durable_interrupt"), {
              source: "durable_interrupt",
            }),
          );
        }
      });
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      budgetTotal: 10,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
    });
    try {
      await expect(interrupted).rejects.toThrow();
    } finally {
      appendSpy.mockRestore();
      firstDurable.stop();
      await firstDurable.drain();
    }
    expect(committedOutcome).toBe(true);
    expect(
      store.events.find((event) => event.kind === "outcome")?.data.usage
        ?.output,
    ).toBe(3);
    expect(runner).toHaveBeenCalledTimes(1);

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    expect(resumedDurable.usage().output).toBe(3);
    const result = await runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      budgetTotal: 10,
      durable: resumedDurable,
      runAgent: runner,
    });
    expect(result.result).toMatchObject({ spent: 3 });
    expect(result.usage?.output).toBe(3);
    expect(resumedDurable.usage().output).toBe(3);
    expect(runner).toHaveBeenCalledTimes(1);
    resumedDurable.stop();
    await resumedDurable.drain();
  });

  it.each([
    { caseName: "negative", output: -3 },
    { caseName: "non-finite", output: Number.POSITIVE_INFINITY },
  ])(
    "uses normalized usage for durable global budget deltas ($caseName)",
    async ({ output }) => {
      const script = source(`
        await ctx.agent("invalid-usage", { prompt: "invalid-usage" });
        return ctx.budget.spent();`);
      const { store } = await fixture(script);
      const runner: WorkflowAgentRunner = async () => ({
        isError: false,
        output: "done",
        usage: { ...zeroUsage(), output },
      });

      const result = await execute(store, runner, { budgetTotal: 10 });
      expect(result.result).toBe(0);
      expect(result.usage?.output).toBe(0);
    },
  );

  it("deduplicates runner schema errors from restored schema exhaustion", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "schema-error-dedup", version: 1,
        async run(ctx) {
          const budgetFailure = await ctx.step("runner-schema-budget", {
            budget: 0,
            failure: "collect",
          }, () => ctx.agent("runner-schema", {
            prompt: "runner-schema",
            failure: "collect",
          }));
          const ordinaryFailure = await ctx.agent("ordinary-runner", {
            prompt: "ordinary-runner",
            failure: "collect",
          });
          const schemaFailure = await ctx.agent("schema-exhaustion", {
            prompt: "invalid json",
            output: schema.object({ answer: schema.string() }),
            failure: "collect",
          });
          const answer = await ctx.ask("error-count-gate", {
            prompt: "Continue?",
            choices: ["yes", "no"],
          });
          return { budgetFailure, ordinaryFailure, schemaFailure, answer };
        } });`;
    const { scope, store } = await fixture(script);
    const runner = vi.fn<WorkflowAgentRunner>(async ({ prompt }) => {
      if (prompt === "runner-schema") {
        throw Object.assign(
          new WorkflowFailureError("runner schema failure", {
            errorCategory: "schema",
            errorStage: "schema_validation",
          }),
          { usage: { ...zeroUsage(), output: 3 } },
        );
      }
      if (prompt === "ordinary-runner") {
        return {
          isError: true,
          output: "runner failed",
          errorMessage: "runner failed",
          usage: { ...zeroUsage(), output: 1 },
        };
      }
      return ok("{}");
    });
    const abort = new AbortController();
    const firstDurable = new DurableWorkflow(store);
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "error-count-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(5);
      abort.abort(
        Object.assign(new Error("durable_interrupt"), {
          source: "durable_interrupt",
        }),
      );
      await expect(interrupted).rejects.toThrow();
    } finally {
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumed = runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      durable: resumedDurable,
      runAgent: runner,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          resumedStore.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "error-count-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(5);
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live).toBeDefined();
      await live!.answer(["error-count-gate"], "yes");

      const result = await resumed;
      expect(result.errorCount).toBe(3);
      expect(result.result).toMatchObject({ answer: "yes" });
      expect(runner).toHaveBeenCalledTimes(5);
    } finally {
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });

  it("reconstructs schema exhaustion from an unmarked prior journal", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "schema-error-old-journal", version: 1,
        async run(ctx) {
          const runnerFailure = await ctx.agent("runner-schema", {
            prompt: "runner-schema",
            failure: "collect",
          });
          const schemaFailure = await ctx.agent("schema-exhaustion", {
            prompt: "invalid json",
            output: schema.object({ answer: schema.string() }),
            failure: "collect",
          });
          const answer = await ctx.ask("legacy-gate", {
            prompt: "Continue?",
            choices: ["yes", "no"],
          });
          return { runnerFailure, schemaFailure, answer };
        } });`;
    const { scope, store } = await fixture(script);
    const runner = vi.fn<WorkflowAgentRunner>(async ({ prompt }) => {
      if (prompt === "runner-schema") {
        throw Object.assign(
          new WorkflowFailureError("runner schema failure", {
            errorCategory: "schema",
            errorStage: "schema_validation",
          }),
          { usage: { ...zeroUsage(), output: 3 } },
        );
      }
      return ok("{}");
    });
    const abort = new AbortController();
    const firstDurable = new DurableWorkflow(store);
    const originalAppend = store.append.bind(store);
    const appendSpy = vi
      .spyOn(store, "append")
      .mockImplementation(async (kind, data) => {
        if (
          kind === "v4.step" &&
          data !== null &&
          typeof data === "object" &&
          "error" in data &&
          data.error !== null &&
          typeof data.error === "object" &&
          "schemaRepairExhausted" in data.error &&
          data.error.schemaRepairExhausted === true
        ) {
          const { schemaRepairExhausted: _marker, ...error } = data.error;
          await originalAppend(kind, { ...data, error });
          return;
        }
        await originalAppend(kind, data);
      });
    const interrupted = runWorkflow(script, {
      args: {},
      cwd: store.events[0].data.cwd,
      durable: firstDurable,
      runAgent: runner,
      signal: abort.signal,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          store.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "legacy-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(
        runner.mock.calls.filter(
          ([request]) => request.prompt === "runner-schema",
        ),
      ).toHaveLength(1);
      expect(runner).toHaveBeenCalledTimes(4);
      abort.abort(
        Object.assign(new Error("durable_interrupt"), {
          source: "durable_interrupt",
        }),
      );
      await expect(interrupted).rejects.toThrow();
    } finally {
      appendSpy.mockRestore();
      firstDurable.stop();
      await firstDurable.drain();
    }

    await store.close();
    const resumedStore = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumedStore);
    const resumedDurable = new DurableWorkflow(resumedStore);
    const resumed = runWorkflow(script, {
      args: {},
      cwd: resumedStore.events[0].data.cwd,
      durable: resumedDurable,
      runAgent: runner,
    });
    try {
      await waitForWorkflowWorker(() =>
        expect(
          resumedStore.events.some(
            (event) =>
              event.kind === "v4.step" &&
              event.data.path.join("/") === "legacy-gate" &&
              event.data.status === "waiting_for_input",
          ),
        ).toBe(true),
      );
      expect(runner).toHaveBeenCalledTimes(4);
      const live = getLiveWorkflowV4Store(resumedStore.id);
      expect(live).toBeDefined();
      await live!.answer(["legacy-gate"], "yes");

      const result = await resumed;
      expect(result.errorCount).toBe(2);
      expect(result.result).toMatchObject({ answer: "yes" });
      expect(runner).toHaveBeenCalledTimes(4);
    } finally {
      resumedDurable.stop();
      await resumedDurable.drain();
    }
  });

  it("counts schema exhaustion in a baseline five-field attempt journal", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "legacy-attempt-identity", version: 1,
        async run() { return null; } });`;
    const { store } = await fixture(script);
    const path = ["legacy-agent"];
    const generation = 0;
    const stepAttempt = 1;
    const input = encodeRunValue({ prompt: "schema repair call" });
    const policy = encodeRunValue({ failure: "collect" });
    const sourceHash = createHash("sha256").update(script).digest("hex");
    const invocationHash = createHash("sha256")
      .update(JSON.stringify([script, null]))
      .digest("hex");
    const definitionHash = createHash("sha256")
      .update(sourceHash + invocationHash)
      .digest("hex");
    const stepIdempotencyKey = createHash("sha256")
      .update(JSON.stringify([path, definitionHash, input, policy, generation]))
      .digest("hex");
    const agentId = `${stepIdempotencyKey}:${stepAttempt}`;
    const requestId = createHash("sha256")
      .update(JSON.stringify([agentId]))
      .digest("hex");

    await store.append("v4.step", {
      path,
      id: "legacy-agent",
      kind: "agent",
      title: "legacy-agent",
      status: "failed",
      attempt: stepAttempt,
      generation,
      inputHash: createHash("sha256").update(input).digest("hex"),
      definitionHash,
      startedAt: 1,
      completedAt: 2,
      input,
      policy,
      error: {
        name: "WorkflowFailureError",
        message: "Schema validation failed.",
        category: "schema",
        stage: "schema_validation",
        path,
      },
    });
    expect(
      store.events.find((event) => event.kind === "v4.step")?.data,
    ).not.toHaveProperty("retryFrameHash");

    for (let repairAttempt = 0; repairAttempt < 3; repairAttempt++) {
      const key = `${requestId}-${repairAttempt}`;
      await store.append("attempt", {
        key,
        configuration: encodeRunValue({
          prompt: `schema repair ${repairAttempt}`,
        }),
        isolation: "process",
      });
      await store.append("outcome", {
        key,
        ok: true,
        value: encodeRunValue({
          isError: false,
          output: "{}",
          usage: zeroUsage(),
        }),
      });
    }

    const durable = new DurableWorkflow(store);
    const result = durable.result({
      meta: { name: "legacy-attempt-identity", description: "" },
      result: null,
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      usage: zeroWorkflowUsage(),
      phases: [],
    });
    expect(result.errorCount).toBe(1);
    durable.stop();
  });

  it("rejects a nested workflow cycle", async () => {
    const cycle = source(`return ctx.workflow("cycle", {});`);
    const { store } = await fixture(cycle);
    await expect(
      execute(store, async () => ok(""), {
        loadWorkflow: (name: string) => (name === "cycle" ? cycle : null),
      }),
    ).rejects.toThrow(/cycle|recursive|depth/i);
  });

  it("propagates cancellation across a nested workflow despite collect policy", async () => {
    const parent = source(
      `return ctx.workflow("nested-wait", {}, {
        id: "child",
        failure: "collect",
        retry: { attempts: 3 },
      }).then(async (value) => {
        await ctx.step("after-child", () => "must not run");
        return value;
      });`,
    );
    const child = source(
      `return ctx.agent("cancelled", { prompt: "cancel", failure: "collect" });`,
    );
    const { store } = await fixture(parent);
    const durable = new DurableWorkflow(store);
    const runner = vi.fn<WorkflowAgentRunner>(async () => ({
      isError: false,
      cancelled: true,
      output: "",
      usage: { ...zeroUsage() },
    }));
    const running = runWorkflow(parent, {
      durable,
      runAgent: runner,
      loadWorkflow: (name: string) => (name === "nested-wait" ? child : null),
    });
    try {
      await expect(running).rejects.toMatchObject({
        message: expect.stringMatching(/cancel/i),
        cancelled: true,
        cancelledCount: 1,
      });
      expect(runner).toHaveBeenCalledTimes(1);
      expect(
        store.events.some(
          (event) =>
            event.kind === "v4.step" &&
            event.data.path.at(-1) === "child" &&
            event.data.status === "cancelled",
        ),
      ).toBe(true);
      expect(
        store.events.some(
          (event) =>
            event.kind === "v4.step" &&
            event.data.path.at(-1) === "after-child",
        ),
      ).toBe(false);
    } finally {
      durable.stop();
      await durable.drain();
    }
  });

  it("enforces the nested definition depth limit through the worker", async () => {
    const chain = new Map<string, string>();
    for (let index = 0; index <= 9; index++) {
      const name = `depth-${index}`;
      const next =
        index < 9
          ? `return ctx.workflow("depth-${index + 1}", {}, { id: "child" });`
          : `return "leaf";`;
      chain.set(
        name,
        `import { defineWorkflow } from "pi-subagentura/workflow";
        export default defineWorkflow({ name: "${name}", version: 1,
          async run(ctx) { ${next} }
        });`,
      );
    }
    const root = chain.get("depth-0")!;
    const { store } = await fixture(root);
    await expect(
      execute(store, async () => ok(""), {
        loadWorkflow: (name: string) => chain.get(name) ?? null,
      }),
    ).rejects.toThrow(/depth|limit/i);
  });
});
