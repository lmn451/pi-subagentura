import { describe, expect, it, vi } from "vitest";
import type { SubagentResult } from "../src/helpers";
import { WorkflowAgentDispatcher } from "../src/workflow-dispatcher";
import { runWorkflow } from "../src/workflow-worker";

function ok(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WorkflowAgentDispatcher", () => {
  it("enforces independent process and in-process caps", async () => {
    const gate = deferred();
    const initialLanesStarted = deferred();
    let activeProcess = 0;
    let activeInProcess = 0;
    let maxProcess = 0;
    let maxInProcess = 0;
    let maxCombined = 0;
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: 1,
      processConcurrency: 2,
      runAgent: async ({ isolation, prompt }) => {
        if (isolation === "in-process") {
          activeInProcess++;
          maxInProcess = Math.max(maxInProcess, activeInProcess);
        } else {
          activeProcess++;
          maxProcess = Math.max(maxProcess, activeProcess);
        }
        maxCombined = Math.max(maxCombined, activeProcess + activeInProcess);
        if (activeProcess === 2 && activeInProcess === 1) {
          initialLanesStarted.resolve();
        }
        await gate.promise;
        if (isolation === "in-process") activeInProcess--;
        else activeProcess--;
        return ok(prompt);
      },
    });

    const runs = [
      dispatcher.run({ prompt: "p1", isolation: "process" }),
      dispatcher.run({ prompt: "p2", isolation: "process" }),
      dispatcher.run({ prompt: "p3", isolation: "process" }),
      dispatcher.run({ prompt: "i1", isolation: "in-process" }),
      dispatcher.run({ prompt: "i2", isolation: "in-process" }),
    ];
    await initialLanesStarted.promise;

    expect(maxProcess).toBe(2);
    expect(maxInProcess).toBe(1);
    expect(maxCombined).toBe(3);
    expect(dispatcher.queuedCount).toBe(2);

    gate.resolve();
    await Promise.all(runs);
    dispatcher.close();
    await dispatcher.drain();
  });

  it("removes and rejects an aborted queued acquisition", async () => {
    const gate = deferred();
    const started = deferred();
    const runAgent = vi.fn(async ({ prompt }: { prompt: string }) => {
      started.resolve();
      await gate.promise;
      return ok(prompt);
    });
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: 1,
      processConcurrency: 1,
      runAgent,
    });
    const running = dispatcher.run({ prompt: "running", isolation: "process" });
    await started.promise;

    const controller = new AbortController();
    const reason = new Error("cancel queued task");
    const queued = dispatcher.run({
      prompt: "queued",
      isolation: "process",
      signal: controller.signal,
    });
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    expect(dispatcher.queuedCount).toBe(0);
    expect(runAgent).toHaveBeenCalledTimes(1);

    gate.resolve();
    await running;
    dispatcher.close();
    await dispatcher.drain();
  });

  it("runs the slot-start fence after acquisition and skips a rejected runner", async () => {
    const gate = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    const runAgent = vi.fn(async ({ prompt }: { prompt: string }) => {
      events.push(`runner:${prompt}`);
      if (prompt === "running") {
        firstStarted.resolve();
        await gate.promise;
      }
      return ok(prompt);
    });
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: 1,
      processConcurrency: 1,
      runAgent,
    });
    const running = dispatcher.run({
      prompt: "running",
      isolation: "in-process",
    });
    await firstStarted.promise;

    const reason = new Error("stale durable operation");
    let activeAtFence = 0;
    const fenced = dispatcher.run(
      { prompt: "fenced", isolation: "in-process" },
      {
        beforeStart: () => {
          activeAtFence = dispatcher.activeCount;
          events.push("beforeStart:fenced");
          throw reason;
        },
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["runner:running"]);
    expect(dispatcher.queuedCount).toBe(1);

    gate.resolve();
    await running;
    await expect(fenced).rejects.toBe(reason);
    expect(activeAtFence).toBe(1);
    expect(events).toEqual(["runner:running", "beforeStart:fenced"]);
    expect(runAgent).toHaveBeenCalledTimes(1);
    dispatcher.close();
    await dispatcher.drain();
  });

  it("close rejects queued and future work while drain waits for running work", async () => {
    const gate = deferred();
    const started = deferred();
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: 1,
      processConcurrency: 1,
      runAgent: async ({ prompt }) => {
        started.resolve();
        await gate.promise;
        return ok(prompt);
      },
    });
    const running = dispatcher.run({ prompt: "running", isolation: "process" });
    await started.promise;
    const queued = dispatcher.run({ prompt: "queued", isolation: "process" });

    const reason = new Error("dispatcher shutdown");
    dispatcher.close(reason);
    let drained = false;
    const drain = dispatcher.drain().then(() => {
      drained = true;
    });

    await expect(queued).rejects.toBe(reason);
    await expect(
      dispatcher.run({ prompt: "future", isolation: "process" }),
    ).rejects.toBe(reason);
    expect(drained).toBe(false);

    gate.resolve();
    await running;
    await drain;
    expect(drained).toBe(true);
  });

  it("routes legacy workflow agents through an injected dispatcher", async () => {
    const gate = deferred();
    const started = deferred();
    let active = 0;
    let maxActive = 0;
    const dispatcher = new WorkflowAgentDispatcher({
      concurrency: 1,
      processConcurrency: 1,
    });
    const runSpy = vi.spyOn(dispatcher, "run");
    const completion = runWorkflow(
      `export const meta = { name: "legacy", description: "dispatcher" };\n` +
        `return await parallel(Array.from({ length: 3 }, (_, i) => () => agent("t" + i, { isolation: "in-process" })));`,
      {
        dispatcher,
        concurrency: 10,
        runAgent: async ({ prompt }) => {
          active++;
          maxActive = Math.max(maxActive, active);
          started.resolve();
          await gate.promise;
          active--;
          return ok(prompt);
        },
      },
    );
    await started.promise;
    gate.resolve();

    const result = await completion;
    expect(result.result).toEqual(["t0", "t1", "t2"]);
    expect(maxActive).toBe(1);
    expect(runSpy).toHaveBeenCalledTimes(3);
    dispatcher.close();
    await dispatcher.drain();
  });
});
