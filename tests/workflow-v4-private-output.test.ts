import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableWorkflow } from "../src/workflow-durable";
import {
  WorkflowRunStore,
  decodeRunValue,
  encodeRunValue,
} from "../src/workflow-run-store";
import { runWorkflow } from "../src/workflow-worker";
import { zeroUsage } from "../src/usage";

const roots: string[] = [];
const stores: WorkflowRunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const privateOutput = "private-agent-output-that-must-not-be-journaled";
const ok = () => ({
  isError: false as const,
  output: privateOutput,
  usage: { ...zeroUsage(), output: 3 },
});

async function fixture(script: string) {
  const root = await mkdtemp(join(tmpdir(), "workflow-private-output-"));
  roots.push(root);
  const scope = { root, cwd: root, sessionId: "private-output" };
  const store = await WorkflowRunStore.create(scope, {
    script,
    args: encodeRunValue({}),
    budgetTotal: 1000,
  });
  stores.push(store);
  return { store, scope };
}

describe("private V4 agent results", () => {
  it("does not persist private output fragments in schema repair prompts", async () => {
    const script = `import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "private-schema", version: 1,
        async run(ctx) {
          const outcome = await ctx.agent("private", {
            prompt: "private work", isolation: "in-process",
            persist: false, failure: "collect",
            output: schema.object({ answer: schema.string() })
          });
          return outcome.ok;
        }
      });`;
    const { store, scope } = await fixture(script);
    const durable = new DurableWorkflow(store);
    await runWorkflow(script, {
      cwd: scope.cwd,
      budgetTotal: 1000,
      durable,
      runAgent: async () => ({
        ...ok(),
        output: '{"answer":PRIVATE_AGENT_OUTPUT}',
      }),
    });
    durable.stop();
    await durable.drain();
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const attempts = reopened.events.filter(
      (event) => event.kind === "attempt",
    );
    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) {
      expect(
        JSON.stringify(decodeRunValue(attempt.data.configuration)),
      ).not.toContain("PRIVATE_AG");
    }
  });

  it("keeps collected agent failure content out of persisted receipts", async () => {
    const script = `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "private-failure", version: 1,
        async run(ctx) {
          const outcome = await ctx.agent("private", {
            prompt: "private work", isolation: "in-process",
            persist: false, failure: "collect"
          });
          return outcome.ok;
        }
      });`;
    const { store, scope } = await fixture(script);
    const durable = new DurableWorkflow(store);
    const result = await runWorkflow(script, {
      cwd: scope.cwd,
      budgetTotal: 1000,
      durable,
      runAgent: async () => ({
        ...ok(),
        isError: true,
        errorMessage: privateOutput,
      }),
    });
    expect(result.result).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.usage.output).toBe(3);
    durable.stop();
    await durable.drain();
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const receipts = reopened.events.filter(
      (event) => event.kind === "outcome" || event.kind === "v4.step",
    );
    expect(JSON.stringify(receipts)).not.toContain(privateOutput);
    expect(
      receipts.find((event) => event.kind === "outcome")?.data.value,
    ).toBeUndefined();
    expect(
      receipts.findLast((event) => event.kind === "v4.step")?.data.error
        .message,
    ).toBe("Workflow step failed.");
  });

  it.each(["in-process", "process"])(
    "restarts a discarded %s result after an outcome/step crash without losing accounting",
    async (isolation) => {
      const { store, scope } = await fixture(`
        import { defineWorkflow } from "pi-subagentura/workflow";
        export default defineWorkflow({ name: "private", version: 1,
          async run() { return 1; }
        });`);
      const request = { prompt: "private work", isolation };
      const runner = vi.fn(async (req) => {
        await req.durableAttempt.recordDispatch();
        return ok();
      });
      const before = new DurableWorkflow(store);
      expect(
        await before.runAttempt("private", 0, request, runner, {
          persist: false,
        }),
      ).toEqual(ok());
      expect(
        await before.runAttempt("private", 0, request, runner, {
          persist: false,
        }),
      ).toEqual(ok());
      expect(runner).toHaveBeenCalledTimes(1);
      await store.close();
      const resumed = await WorkflowRunStore.resume(scope, store.id);
      stores.push(resumed);
      const after = new DurableWorkflow(resumed);
      expect(
        await after.runAttempt("private", 0, request, runner, {
          persist: false,
        }),
      ).toEqual(ok());
      expect(runner).toHaveBeenCalledTimes(2);
      expect(runner.mock.calls[0][0].durableAttempt.key).not.toBe(
        runner.mock.calls[1][0].durableAttempt.key,
      );
      expect(after.usage().output).toBe(6);
      expect(after.agentsSpawned).toBe(2);
      expect(
        resumed.events.filter((event) => event.kind === "dispatch"),
      ).toHaveLength(2);
      for (const event of resumed.events.filter(
        (event) => event.kind === "outcome",
      )) {
        expect(event.data.value).toBeUndefined();
        expect(JSON.stringify(event.data)).not.toContain(privateOutput);
      }
    },
  );

  it("retains usage but no thrown error text for private attempts", async () => {
    const { store, scope } = await fixture(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "private", version: 1,
        async run() { return 1; }
      });`);
    const durable = new DurableWorkflow(store);
    const error = Object.assign(new Error(privateOutput), {
      usage: ok().usage,
    });
    await expect(
      durable.runAttempt(
        "private",
        0,
        { prompt: "private work", isolation: "in-process" },
        async () => {
          throw error;
        },
        { persist: false },
      ),
    ).rejects.toBe(error);
    await store.close();
    const resumed = await WorkflowRunStore.resume(scope, store.id);
    stores.push(resumed);
    const outcome = resumed.events.find((event) => event.kind === "outcome")!;
    expect(outcome.data.error).toBeUndefined();
    expect(JSON.stringify(outcome.data)).not.toContain(privateOutput);
    expect(new DurableWorkflow(resumed).usage().output).toBe(3);
  });

  it.each(["persist: false", "policy: { persist: false }"])(
    "omits agent output from every durable outcome with %s",
    async (policy) => {
      const script = `import { defineWorkflow } from "pi-subagentura/workflow";
        export default defineWorkflow({ name: "private-output", version: 1,
          async run(ctx) {
            const value = await ctx.agent("private", {
              prompt: "produce a private value", isolation: "in-process", ${policy}
            });
            return value.length;
          }
        });`;
      const { store, scope } = await fixture(script);
      const runner = vi.fn(async () => ok());
      const execute = async (opened: WorkflowRunStore) => {
        const durable = new DurableWorkflow(opened);
        try {
          return await runWorkflow(script, {
            args: {},
            cwd: scope.cwd,
            budgetTotal: 1000,
            durable,
            runAgent: runner,
          });
        } finally {
          durable.stop();
          await durable.drain();
        }
      };
      const first = await execute(store);
      expect(first.result).toBe(privateOutput.length);
      expect(first.usage.output).toBe(3);
      const id = store.id;
      await store.close();
      const reopened = await WorkflowRunStore.resume(scope, id);
      stores.push(reopened);
      const outcomes = reopened.events.filter(
        (event) => event.kind === "outcome",
      );
      expect(outcomes).toHaveLength(1);
      for (const event of outcomes) {
        const data =
          event.data.value === undefined
            ? event.data
            : decodeRunValue(event.data.value);
        expect(JSON.stringify(data)).not.toContain(privateOutput);
      }
      const step = reopened.events
        .filter((event) => event.kind === "v4.step")
        .at(-1);
      expect(step?.data.output).toBeUndefined();
      const resumed = await execute(reopened);
      expect(resumed.result).toBe(privateOutput.length);
      expect(resumed.usage.output).toBe(6);
      expect(runner).toHaveBeenCalledTimes(2);
    },
  );
});
