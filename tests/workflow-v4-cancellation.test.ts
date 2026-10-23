import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/workflow-worker";
import { DurableWorkflow } from "../src/workflow-durable";
import {
  WorkflowRunStore,
  encodeRunValue,
  type RunScope,
} from "../src/workflow-run-store";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";

const roots: string[] = [];
const stores: WorkflowRunStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("v4 workflow step cancellation", () => {
  it("cancels a timed out human wait before continuing", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "cancel-wait", version: 1,
        async run(ctx) {
          let timedOut = false;
          try {
            await ctx.step("timed", { timeout: 150 }, () =>
              ctx.ask("approval", { prompt: "Continue?" }));
          } catch (error) {
            timedOut = error?.category === "timeout";
          }
          const after = await ctx.step("after-timeout", () => "continued");
          return { timedOut, after };
        } });`;
    const root = await mkdtemp(join(tmpdir(), "workflow-v4-cancel-"));
    roots.push(root);
    const store = await WorkflowRunStore.create(
      { root, cwd: root, sessionId: "cancel-wait-parent" } satisfies RunScope,
      { script, args: encodeRunValue({}), budgetTotal: 100 },
    );
    stores.push(store);
    const durable = new DurableWorkflow(store);
    const runner: WorkflowAgentRunner = async () => ({
      isError: false,
      output: "unused",
      usage: { ...zeroUsage() },
    });
    let inputSignal: AbortSignal | undefined;
    const running = runWorkflow(script, {
      durable,
      runAgent: runner,
      requestInput: (_request, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          inputSignal = signal;
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    await vi.waitFor(() => expect(inputSignal).toBeInstanceOf(AbortSignal));
    await expect(running).resolves.toMatchObject({
      result: { timedOut: true, after: "continued" },
    });
    expect(inputSignal?.aborted).toBe(true);
    const approvalStates = store.events.filter(
      (event) =>
        event.kind === "v4.step" &&
        event.data.path.join("/") === "timed/approval",
    );
    expect(
      approvalStates.some((event) => event.data.status === "waiting_for_input"),
    ).toBe(true);
    expect(approvalStates.at(-1)?.data.status).not.toBe("waiting_for_input");
    durable.stop();
    await durable.drain();
  });

  it("collects a timed out agent step after its cancelled runner settles", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "collect-late-timeout", version: 1,
        async run(ctx) {
          return await ctx.agent("slow-agent", {
            prompt: "wait for cancellation",
            timeout: 50,
            failure: "collect",
          });
        } });`;
    let agentSignal: AbortSignal | undefined;
    let settledAfterCancellation = false;
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      if (!signal) throw new Error("Expected an agent abort signal.");
      agentSignal = signal;
      if (!signal.aborted) {
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      }
      // The timeout runs in a worker thread, outside Vitest's fake clock.
      const { promise: settled, resolve: resolveSettled } =
        Promise.withResolvers<void>();
      setTimeout(resolveSettled, 150);
      await settled;
      settledAfterCancellation = true;
      return {
        isError: false,
        cancelled: true,
        output: "",
        usage: { ...zeroUsage() },
      };
    };
    const running = runWorkflow(script, { runAgent: runner });

    await vi.waitFor(() => expect(agentSignal).toBeInstanceOf(AbortSignal));
    await expect(running).resolves.toMatchObject({
      result: {
        ok: false,
        error: {
          category: "timeout",
          stage: "workflow",
          path: ["slow-agent"],
        },
      },
      cancelledCount: 1,
    });
    expect(agentSignal?.aborted).toBe(true);
    expect(settledAfterCancellation).toBe(true);
  });

  it("allows an ordinary try/catch to recover a rejected agent call", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "recover-agent-error", version: 1,
        async run(ctx) {
          try {
            await ctx.agent("caught-agent", { prompt: "fail" });
          } catch {
            return { recovered: true };
          }
          return { recovered: false };
        } });`;

    await expect(
      runWorkflow(script, {
        runAgent: async () => {
          throw new Error("handled agent failure");
        },
      }),
    ).resolves.toMatchObject({ result: { recovered: true } });
  });

  it("still rejects a genuinely unhandled agent failure", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "unhandled-agent-error", version: 1,
        async run(ctx) {
          return await ctx.agent("unhandled-agent", { prompt: "fail" });
        } });`;

    await expect(
      runWorkflow(script, {
        runAgent: async () => {
          throw new Error("unhandled agent failure");
        },
      }),
    ).rejects.toThrow("unhandled agent failure");
  });

  it("still rejects an unawaited legacy agent failure during final drain", async () => {
    const script =
      `export const meta = { name: "unawaited-agent-error", description: "d" };\n` +
      `agent("background"); return "workflow-result";`;

    await expect(
      runWorkflow(script, {
        runAgent: async () => {
          throw new Error("unhandled background agent failure");
        },
      }),
    ).rejects.toThrow("unhandled background agent failure");
  });

  it("collects a nested workflow timeout after descendant cancellation settles", async () => {
    const parentScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-timeout-parent", version: 1,
        async run(ctx) {
          return await ctx.workflow("child", {}, {
            timeout: 50,
            failure: "collect",
          });
        } });`;
    const childScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-timeout-child", version: 1,
        async run(ctx) {
          return await ctx.agent("slow-agent", {
            prompt: "wait for nested cancellation",
          });
        } });`;
    const root = await mkdtemp(join(tmpdir(), "workflow-v4-nested-cancel-"));
    roots.push(root);
    const store = await WorkflowRunStore.create(
      {
        root,
        cwd: root,
        sessionId: "nested-timeout-parent",
      } satisfies RunScope,
      {
        script: parentScript,
        args: encodeRunValue({}),
        budgetTotal: 100,
      },
    );
    stores.push(store);
    const durable = new DurableWorkflow(store);
    let agentSignal: AbortSignal | undefined;
    let settledAfterCancellation = false;
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      if (!signal) throw new Error("Expected an agent abort signal.");
      agentSignal = signal;
      if (!signal.aborted) {
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      }
      // The timeout runs in a worker thread, outside Vitest's fake clock.
      const { promise: settled, resolve: resolveSettled } =
        Promise.withResolvers<void>();
      setTimeout(resolveSettled, 150);
      await settled;
      settledAfterCancellation = true;
      return {
        isError: false,
        cancelled: true,
        output: "",
        usage: { ...zeroUsage() },
      };
    };
    const running = runWorkflow(parentScript, {
      durable,
      loadWorkflow: (name) => (name === "child" ? childScript : null),
      runAgent: runner,
    });

    try {
      await vi.waitFor(() => expect(agentSignal).toBeInstanceOf(AbortSignal));
      await expect(running).resolves.toMatchObject({
        result: {
          ok: false,
          error: {
            category: "timeout",
            stage: "workflow",
            path: ["child"],
          },
        },
      });
      expect(agentSignal?.aborted).toBe(true);
      expect(settledAfterCancellation).toBe(true);
      const childStates = store.events.filter(
        (event) =>
          event.kind === "v4.step" &&
          event.data.path.join("/") === "child/slow-agent",
      );
      expect(childStates.at(-1)?.data.status).toBe("cancelled");
    } finally {
      durable.stop();
      await durable.drain();
    }
  });

  it("collects a workflow timeout after an awaited legacy child agent settles", async () => {
    const parentScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "legacy-descendant-timeout", version: 1,
        async run(ctx) {
          return await ctx.workflow("legacy-child", {}, {
            timeout: 50,
            failure: "collect",
          });
        } });`;
    const legacyChild =
      `export const meta = { name: "legacy-child", description: "d" };\n` +
      `return await agent("slow");`;
    let agentSignal: AbortSignal | undefined;
    let settledAfterCancellation = false;
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      if (!signal) throw new Error("Expected an agent abort signal.");
      agentSignal = signal;
      if (!signal.aborted) {
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      }
      // The timeout runs in a worker thread, outside Vitest's fake clock.
      const { promise: settled, resolve: resolveSettled } =
        Promise.withResolvers<void>();
      setTimeout(resolveSettled, 150);
      await settled;
      settledAfterCancellation = true;
      return {
        isError: false,
        cancelled: true,
        output: "",
        usage: { ...zeroUsage() },
      };
    };
    const running = runWorkflow(parentScript, {
      loadWorkflow: (name) => (name === "legacy-child" ? legacyChild : null),
      runAgent: runner,
    });

    await vi.waitFor(() => expect(agentSignal).toBeInstanceOf(AbortSignal));
    await expect(running).resolves.toMatchObject({
      result: {
        ok: false,
        error: {
          category: "timeout",
          stage: "workflow",
          path: ["legacy-child"],
        },
      },
      cancelledCount: 1,
    });
    expect(agentSignal?.aborted).toBe(true);
    expect(settledAfterCancellation).toBe(true);
  });

  it("preserves a nested budget failure without retrying or double spending", async () => {
    const parentScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-budget-parent", version: 1,
        async run(ctx) {
          return await ctx.workflow("child", {}, {
            retry: { attempts: 2 },
            failure: "collect",
          });
        } });`;
    const childScript = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "nested-budget-child", version: 1,
        async run(ctx) {
          return await ctx.agent("limited-agent", {
            prompt: "produce one output token",
            budget: 0,
          });
        } });`;
    let runnerCalls = 0;
    const runner: WorkflowAgentRunner = async () => {
      runnerCalls++;
      return {
        isError: false,
        output: "one token",
        usage: { ...zeroUsage(), output: 1 },
      };
    };

    const result = await runWorkflow(parentScript, {
      budgetTotal: 100,
      loadWorkflow: (name) => (name === "child" ? childScript : null),
      runAgent: runner,
    });

    expect(result.result).toMatchObject({
      ok: false,
      error: {
        category: "budget",
        stage: "budget",
        path: expect.arrayContaining(["limited-agent"]),
      },
    });
    expect(runnerCalls).toBe(1);
    expect(result.usage.output).toBe(1);
  });
});
