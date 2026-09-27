import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  runWorkflowDefinition,
  WorkflowCancelledError,
  WorkflowTimeoutError,
} from "../src/workflow-v4-runtime.mjs";

type StepEvent = { action: string; payload: any };

function makeBridge(overrides: Record<string, any> = {}) {
  const events: StepEvent[] = [];
  const values = new Map<string, unknown>();
  const attempts = new Map<string, number>();
  const bridge: any = {
    signal: new AbortController().signal,
    budget: { total: 100, spent: () => 0, remaining: () => 100 },
    events,
    values,
    validate: vi.fn(async () => {
      return [];
    }),
    async request(action: string, payload: any) {
      events.push({ action, payload });
      const key = payload.path?.join("/") ?? "";
      if (action === "step.enter") {
        const existing = values.get(key) as { done?: boolean; value?: unknown };
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        return existing?.done
          ? {
              reuse: true,
              value: existing.value,
              attempt,
              idempotencyKey: digest(key),
            }
          : { reuse: false, attempt, idempotencyKey: digest(key) };
      }
      if (action === "step.complete") {
        values.set(key, { done: true, value: payload.value });
        return;
      }
      if (action === "step.fail") return;
      if (action === "gate.wait")
        return payload.request.type === "confirm" ? true : "chosen";
      if (action === "checkpoint") return payload.value;
      if (action === "artifact.write")
        return { id: payload.id, type: payload.type, bytes: 1 };
      if (action === "artifact.read") return { id: payload.ref };
      if (action === "step.progress") return;
      if (action === "validate") return [];
      throw new Error(`Unexpected bridge request ${action}`);
    },
    async agent(_prompt: string, _options: unknown, _signal?: AbortSignal) {
      return "agent output";
    },
    async workflow(name: string, args: unknown) {
      return { name, args };
    },
    ...overrides,
  };
  return bridge;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function definition(run: (ctx: any, args: any) => unknown) {
  return { name: "runtime-test", version: 1, run };
}

describe("v4 workflow runtime", () => {
  it("persists scoped steps and collects named parallel failures", async () => {
    const bridge = makeBridge();
    const result = await runWorkflowDefinition(
      definition(async (ctx) =>
        ctx.group("review", "Review", () =>
          ctx.parallel(
            {
              good: () => ctx.step("scan", { title: "Scan" }, async () => 7),
              bad: () =>
                ctx.step("check", async () => {
                  throw Object.assign(new Error("transient"), {
                    category: "provider",
                  });
                }),
            },
            { concurrency: 2, failure: "collect" },
          ),
        ),
      ),
      {},
      bridge,
    );

    expect(result).toEqual({
      good: { ok: true, value: 7 },
      bad: {
        ok: false,
        error: expect.objectContaining({
          message: "transient",
          category: "provider",
        }),
      },
    });
    expect(
      bridge.events.map(({ action, payload }: StepEvent) => [
        action,
        payload.path,
      ]),
    ).toContainEqual([
      "step.complete",
      ["review", "parallel-1", "good", "scan"],
    ]);
    expect(
      bridge.events.find(
        ({ action, payload }: StepEvent) =>
          action === "step.fail" && payload.path.at(-1) === "check",
      )?.payload.error.message,
    ).toBe("transient");
  });

  it("supports synchronous step and parallel branch callbacks", async () => {
    const bridge = makeBridge();
    const result = await runWorkflowDefinition(
      definition((ctx) =>
        ctx.group("sync", () =>
          ctx.parallel({
            left: () => ctx.step("value", () => 2),
            right: () => 3,
          }),
        ),
      ),
      {},
      bridge,
    );

    expect(result).toEqual({ left: 2, right: 3 });
  });

  it("bounds map concurrency and gives item callbacks stable item identity", async () => {
    let active = 0;
    let maximum = 0;
    const bridge = makeBridge();
    const result = await runWorkflowDefinition(
      definition(async (ctx) =>
        ctx.map(
          [
            { id: "a", value: 1 },
            { id: "b", value: 2 },
            { id: "c", value: 3 },
          ],
          async (item: any, identity: any) => {
            expect(identity.id).toBe(item.id);
            active++;
            maximum = Math.max(active, maximum);
            await new Promise((resolve) => setTimeout(resolve, 8));
            active--;
            return item.value * 2;
          },
          {
            stepId: "map-values",
            concurrency: 2,
            key: (item: any) => item.id,
          },
        ),
      ),
      {},
      bridge,
    );

    expect(maximum).toBe(2);
    expect(result).toEqual([2, 4, 6]);
    expect(
      bridge.events
        .filter(({ action }: StepEvent) => action === "step.enter")
        .map(({ payload }: StepEvent) => payload.path),
    ).toContainEqual(["map-values", "a"]);
    expect(
      bridge.events.find(
        ({ action, payload }: StepEvent) =>
          action === "step.enter" && payload.path[0] === "map-values",
      )?.payload.policy,
    ).toBeUndefined();
  });

  it("streams pipeline stages per item and returns results in input order", async () => {
    const order: string[] = [];
    const bridge = makeBridge();
    const result = await runWorkflowDefinition(
      definition(async (ctx) =>
        ctx.pipeline(
          [2, 1],
          async (value: number, info: any) => {
            expect(info.itemId).toBeDefined();
            order.push(`a${value}`);
            return value * 2;
          },
          async (value: number, info: any) => {
            expect(info.stage).toBe(2);
            order.push(`b${value}`);
            return value + 1;
          },
        ),
      ),
      {},
      bridge,
    );

    expect(order.slice(0, 2)).toEqual(["a2", "a1"]);
    expect(order.indexOf("b4")).toBeLessThan(order.indexOf("b2"));
    expect(result).toEqual([5, 3]);
    expect(
      bridge.events.some(({ payload }: StepEvent) =>
        payload.path?.includes("stage-2"),
      ),
    ).toBe(true);
  });

  it("retries failed steps and returns a bounded repeat termination", async () => {
    const bridge = makeBridge();
    let retries = 0;
    const result = await runWorkflowDefinition(
      definition(async (ctx) => {
        const retried = await ctx.step(
          "fetch",
          {
            policy: { retry: { attempts: 2, backoff: "fixed" } },
          },
          async () => {
            retries++;
            if (retries === 1) throw new Error("try again");
            return 4;
          },
        );
        const cycle = await ctx.repeat(
          "cycle",
          {
            maxIterations: 3,
            until: ({ value }: any) => value >= 2,
          },
          async ({ iteration }: any) => iteration,
        );
        return { retried, cycle };
      }),
      {},
      bridge,
    );

    expect(retries).toBe(2);
    expect(result).toEqual({
      retried: 4,
      cycle: { value: 2, iterations: 2, termination: "condition_met" },
    });
    expect(
      bridge.events.filter(
        ({ action, payload }: StepEvent) =>
          action === "step.enter" &&
          payload.path[0] === "cycle" &&
          payload.path[1] === "iteration-2",
      ),
    ).toHaveLength(1);
  });

  it("reuses a compatible completed step without rerunning its callback", async () => {
    const bridge = makeBridge();
    let calls = 0;
    const run = () =>
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.step("once", async () => {
            calls++;
            return { saved: true };
          }),
        ),
        {},
        bridge,
      );

    await expect(run()).resolves.toEqual({ saved: true });
    await expect(run()).resolves.toEqual({ saved: true });
    expect(calls).toBe(1);
    expect(bridge.events.at(-1)).toMatchObject({
      action: "step.enter",
      payload: { path: ["once"] },
    });
  });

  it("honors cache=false and rejects an exhausted persisted attempt", async () => {
    const bridge = makeBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = async (action: string, payload: any) => {
      const result = await request(action, payload);
      return action === "step.enter" ? { ...result, attempt: 1 } : result;
    };
    let calls = 0;
    const run = () =>
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.step("uncached", { cache: false }, () => ++calls),
        ),
        {},
        bridge,
      );

    await expect(run()).resolves.toBe(1);
    await expect(run()).resolves.toBe(2);
    expect(
      bridge.events.find(
        ({ action, payload }: StepEvent) =>
          action === "step.enter" && payload.path[0] === "uncached",
      )?.payload.policy,
    ).toEqual({ cache: false });

    const exhaustedEvents: StepEvent[] = [];
    const exhaustedBridge = makeBridge({
      async request(action: string, payload: any) {
        exhaustedEvents.push({ action, payload });
        if (action === "step.enter") {
          return {
            reuse: false,
            attempt: 3,
            idempotencyKey: digest(payload.path.join("/")),
          };
        }
        if (action === "step.fail") return;
        throw new Error(`Unexpected bridge request ${action}`);
      },
    });
    await expect(
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.step("exhausted", { retry: { attempts: 2 } }, () => 1),
        ),
        {},
        exhaustedBridge,
      ),
    ).rejects.toThrow(/retry limit 2 was exhausted/);
    expect(
      exhaustedEvents.find(({ action }) => action === "step.fail")?.payload
        .attempt,
    ).toBe(3);
  });

  it("allows child paths to be reused only across an explicit group retry", async () => {
    const bridge = makeBridge();
    let groupRuns = 0;
    let childRuns = 0;
    const result = await runWorkflowDefinition(
      definition((ctx) =>
        ctx.step(
          "retry-group",
          { kind: "group", retry: { attempts: 2 } },
          async () => {
            groupRuns++;
            const child = await ctx.step("child", () => {
              childRuns++;
              return "done";
            });
            if (groupRuns === 1) throw new Error("group retry");
            return child;
          },
        ),
      ),
      {},
      bridge,
    );

    expect(result).toBe("done");
    expect(groupRuns).toBe(2);
    expect(childRuns).toBe(1);
  });

  it("rejects duplicate step IDs within one execution", async () => {
    const bridge = makeBridge();
    await expect(
      runWorkflowDefinition(
        definition(async (ctx) => {
          await ctx.step("same", () => 1);
          return ctx.step("same", () => 2);
        }),
        {},
        bridge,
      ),
    ).rejects.toThrow(/Duplicate workflow step id/);
  });

  it("never collects cancellation as an ordinary parallel failure", async () => {
    const bridge = makeBridge();
    await expect(
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.parallel(
            {
              cancelled: () => {
                throw new WorkflowCancelledError(["cancelled"]);
              },
              healthy: () => 1,
            },
            { failure: "collect" },
          ),
        ),
        {},
        bridge,
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
  });

  it("persists a waiting human gate and exposes checkpoint/artifact APIs", async () => {
    const bridge = makeBridge();
    const result = await runWorkflowDefinition(
      definition(async (ctx) => {
        const answer = await ctx.ask("choose", {
          type: "select",
          question: "Pick?",
        });
        await ctx.gate("approve", { title: "Continue?" });
        await ctx.checkpoint("approved", answer);
        const artifact = await ctx.artifact.write("answer", answer, {
          type: "json",
        });
        return {
          answer,
          approved: true,
          artifact,
          loaded: await ctx.artifact.read(artifact),
        };
      }),
      {},
      bridge,
    );

    expect(result).toEqual({
      answer: "chosen",
      approved: true,
      artifact: { id: "answer", type: "json", bytes: 1 },
      loaded: { id: { id: "answer", type: "json", bytes: 1 } },
    });
    expect(
      bridge.events.filter(({ action }: StepEvent) => action === "gate.wait"),
    ).toHaveLength(2);
    expect(
      bridge.events.some(({ action }: StepEvent) => action === "checkpoint"),
    ).toBe(true);
  });

  it("passes stable per-attempt identity and cancellation signal to agents", async () => {
    const controller = new AbortController();
    const agent = vi.fn(
      async (_prompt: string, options: any, signal: AbortSignal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return { agentId: options.id };
      },
    );
    const bridge = makeBridge({ agent, signal: controller.signal });
    const result = await runWorkflowDefinition(
      definition((ctx) =>
        ctx.agent("review", {
          prompt: "Review the change",
          output: { type: "object" },
        }),
      ),
      {},
      bridge,
    );

    expect(result).toEqual({
      agentId: expect.stringMatching(/^[a-f0-9]{64}:1$/),
    });
    expect(agent).toHaveBeenCalledWith(
      "Review the change",
      expect.objectContaining({
        id: expect.stringMatching(/^[a-f0-9]{64}:1$/),
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(bridge.validate).toHaveBeenCalledWith(result, { type: "object" });
  });

  it("records timeout/cancellation outcomes and does not retry cancellation", async () => {
    const bridge = makeBridge();
    let calls = 0;
    await expect(
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.step(
            "slow",
            {
              policy: { timeout: "0.005 seconds" },
            },
            async () => {
              calls++;
              return new Promise(() => {});
            },
          ),
        ),
        {},
        bridge,
      ),
    ).rejects.toBeInstanceOf(WorkflowTimeoutError);
    expect(calls).toBe(1);
    expect(
      bridge.events.find(({ action }: StepEvent) => action === "step.fail")
        ?.payload.error.category,
    ).toBe("timeout");

    const abort = new AbortController();
    const cancelledBridge = makeBridge({ signal: abort.signal });
    await expect(
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.step(
            "cancel",
            { policy: { retry: { attempts: 3 } } },
            async (signal: AbortSignal) => {
              abort.abort();
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (signal.aborted) throw new WorkflowCancelledError(["cancel"]);
              return 1;
            },
          ),
        ),
        {},
        cancelledBridge,
      ),
    ).rejects.toBeInstanceOf(WorkflowCancelledError);
    expect(
      cancelledBridge.events.find(
        ({ action }: StepEvent) => action === "step.fail",
      )?.payload.status,
    ).toBe("cancelled");
  });

  it("asserts total budget and rejects a step over its budget cap", async () => {
    const insufficient = makeBridge({
      budget: { total: 3, spent: () => 0, remaining: () => 3 },
    });
    await expect(
      runWorkflowDefinition(
        definition((ctx) => {
          ctx.budget.assertAvailable(4);
          return 1;
        }),
        {},
        insufficient,
      ),
    ).rejects.toThrow(/budget is insufficient/i);

    const bounded = makeBridge({
      budget: {
        total: 100,
        spent: () => 0,
        remaining: () => 100,
      },
      async agent(
        _prompt: string,
        _options: unknown,
        _signal: AbortSignal,
        onUsage?: (tokens: number) => void,
      ) {
        onUsage?.(3);
        return "too much";
      },
    });
    await expect(
      runWorkflowDefinition(
        definition((ctx) =>
          ctx.agent("bounded", { prompt: "bounded", budget: 2 }),
        ),
        {},
        bounded,
      ),
    ).rejects.toThrow(/exceeded its budget of 2/);
    expect(
      bounded.events.find(({ action }: StepEvent) => action === "step.fail")
        ?.payload.error.category,
    ).toBe("budget");
  });

  it("charges concurrent step budgets only for that step's agent usage", async () => {
    const bridge = makeBridge({
      async agent(
        prompt: string,
        _options: unknown,
        _signal: AbortSignal,
        onUsage?: (tokens: number) => void,
      ) {
        onUsage?.(prompt === "expensive" ? 6 : 1);
        return prompt;
      },
    });
    const result = await runWorkflowDefinition(
      definition((ctx) =>
        ctx.parallel(
          {
            expensive: () =>
              ctx.agent("expensive", { prompt: "expensive", budget: 5 }),
            affordable: () =>
              ctx.agent("affordable", { prompt: "affordable", budget: 5 }),
          },
          { concurrency: 2, failure: "collect" },
        ),
      ),
      {},
      bridge,
    );

    expect(result).toMatchObject({
      expensive: { ok: false, error: { category: "budget" } },
      affordable: { ok: true, value: "affordable" },
    });
  });
});
