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
});
