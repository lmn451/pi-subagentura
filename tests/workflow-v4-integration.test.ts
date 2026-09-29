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
import type { WorkflowAgentRunner } from "../src/workflow-core";

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
