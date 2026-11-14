import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkflowAgentOpts } from "../src/workflow-core";
import {
  isParentWorkerMessage,
  isWorkerParentMessage,
  type WorkerInit,
  type WorkerRpcResponse,
  type WorkerAgentOpts,
} from "../src/workflow-rpc";

const init = (body: string): WorkerInit => ({
  type: "init",
  script: `export const meta = { name: "rpc", description: "d" };\n${body}`,
  args: undefined,
  cwd: "",
  budgetTotal: 100,
  syncTimeoutMs: 1000,
  maxItemsPerCall: 10,
  maxWorkflowDepth: 1,
});

async function withWorker(body: (worker: Worker) => Promise<void>) {
  const worker = new Worker(
    new URL("../src/workflow-worker-thread.mjs", import.meta.url),
  );
  try {
    await body(worker);
  } finally {
    await worker.terminate();
  }
}

async function message(worker: Worker): Promise<unknown> {
  const [value] = await once(worker, "message");
  return value;
}

describe("workflow RPC narrowing", () => {
  it("keeps lightweight worker options aligned with workflow options", () => {
    expectTypeOf<WorkerAgentOpts>().toEqualTypeOf<WorkflowAgentOpts>();
  });
  it.each([
    null,
    [],
    {},
    { id: 1, method: "other" },
    { id: -1, method: "loadWorkflow", payload: "literal" },
    { id: 1, method: "agent", payload: null },
    { id: 1, method: "agent", payload: { prompt: 1 } },
    {
      id: 1,
      method: "agent",
      payload: { prompt: "literal", opts: { model: {} } },
    },
    { type: "progress", payload: { kind: "agent_start" } },
    { type: "result", value: { meta: { name: "literal" } } },
    { type: "error", error: {}, rpcId: 1 },
  ])("rejects malformed worker messages %#", (value) => {
    expect(isWorkerParentMessage(value)).toBe(false);
  });

  it.each([
    null,
    [],
    {},
    { type: "init", script: "literal" },
    { id: 1, ok: "true", tokensDelta: 0 },
    { id: 1, ok: false, error: 1, tokensDelta: 0 },
    { id: 1, ok: true, tokensDelta: Infinity },
    { id: 1, ok: true, tokensDelta: -1 },
  ])("rejects malformed parent messages %#", (value) => {
    expect(isParentWorkerMessage(value)).toBe(false);
  });

  it("accepts discriminated requests, replies, init and progress", () => {
    expect(isParentWorkerMessage(init("return true;"))).toBe(true);
    expect(isParentWorkerMessage({ type: "abort" })).toBe(true);
    expect(
      isParentWorkerMessage({ id: 1, ok: true, value: {}, tokensDelta: 0 }),
    ).toBe(true);
    expect(
      isWorkerParentMessage({
        id: 1,
        method: "loadWorkflow",
        payload: "literal",
      }),
    ).toBe(true);
    expect(
      isWorkerParentMessage({
        id: 1,
        method: "agent",
        payload: { prompt: "literal", opts: { schema: {} } },
      }),
    ).toBe(true);
    expect(
      isWorkerParentMessage({
        type: "progress",
        payload: { kind: "log", message: "literal" },
      }),
    ).toBe(true);
  });
});

describe("published raw workflow worker protocol", () => {
  it("ignores malformed responses and completes a typed RPC", async () => {
    await withWorker(async (worker) => {
      const requestPromise = message(worker);
      worker.postMessage({ type: "init", script: false });
      worker.postMessage(init("return await agent('literal');"));
      const request = await requestPromise;
      expect(isWorkerParentMessage(request)).toBe(true);
      if (!isWorkerParentMessage(request) || !("method" in request))
        throw new Error("Expected RPC request.");
      expect(request.method).toBe("agent");
      const resultPromise = message(worker);
      worker.postMessage({
        id: request.id,
        ok: true,
        value: "wrong",
        tokensDelta: "wrong",
      });
      worker.postMessage({
        id: request.id,
        ok: true,
        value: { literal: true },
        tokensDelta: 1,
      } satisfies WorkerRpcResponse);
      expect(await resultPromise).toEqual({
        type: "result",
        value: {
          meta: { name: "rpc", description: "d" },
          result: { literal: true },
        },
      });
    });
  });

  it("converts rejected RPC errors into realm-owned errors", async () => {
    await withWorker(async (worker) => {
      const requestPromise = message(worker);
      worker.postMessage(
        init(`try { await agent('literal'); } catch (error) {
        try { error.constructor.constructor('return typeof process')(); return false; }
        catch { return true; }
      }`),
      );
      const request = await requestPromise;
      if (!isWorkerParentMessage(request) || !("method" in request))
        throw new Error("Expected RPC request.");
      const resultPromise = message(worker);
      worker.postMessage({
        id: request.id,
        ok: false,
        error: "literal",
        tokensDelta: 0,
      } satisfies WorkerRpcResponse);
      const result = await resultPromise;
      expect(result).toMatchObject({ type: "result", value: { result: true } });
    });
  });

  it("preserves RPC failure identity after realm error wrapping", async () => {
    await withWorker(async (worker) => {
      const requestPromise = message(worker);
      worker.postMessage(init("return await agent('literal');"));
      const request = await requestPromise;
      if (!isWorkerParentMessage(request) || !("method" in request))
        throw new Error("Expected RPC request.");
      const resultPromise = message(worker);
      worker.postMessage({
        id: request.id,
        ok: false,
        error: "literal",
        tokensDelta: 1,
      } satisfies WorkerRpcResponse);
      expect(await resultPromise).toMatchObject({
        type: "error",
        rpcId: request.id,
      });
    });
  });
});
