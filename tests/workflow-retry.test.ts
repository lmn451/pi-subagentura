import { describe, expect, it, vi } from "vitest";
import { runWorkflow } from "../src/workflow-worker";
import { zeroUsage } from "../src/usage";
import type { SubagentResult } from "../src/helpers";

const script = (body: string) =>
  `export const meta = { name: "retry", description: "test" }; ${body}`;

describe("explicit workflow retries", () => {
  it("retries null agent failures and gives each attempt a one-based index", async () => {
    const runAgent = vi.fn(
      async ({ prompt }: { prompt: string }): Promise<SubagentResult> => ({
        output: prompt,
        isError: prompt !== "3",
        usage: zeroUsage(),
        errorMessage: "retryable failure",
      }),
    );
    const run = await runWorkflow(
      script("return await retry(n => agent(String(n)), { attempts: 3 });"),
      { runAgent },
    );
    expect(run.result).toBe("3");
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  it("propagates the last thrown error and bounds attempts before calling work", async () => {
    const runAgent = vi.fn();
    await expect(
      runWorkflow(
        script(
          'return await retry(() => { throw new Error("no"); }, { attempts: 2 });',
        ),
        { runAgent },
      ),
    ).rejects.toThrow("no");
    for (const attempts of [0, -1, 1.5, 11, Infinity]) {
      await expect(
        runWorkflow(
          script(
            `return await retry(() => agent("work"), { attempts: ${attempts} });`,
          ),
          { runAgent },
        ),
      ).rejects.toThrow("1–10");
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("can opt out of null retries, and does not retry other falsey values", async () => {
    const run = await runWorkflow(
      script(`
      let calls = 0;
      const result = await retry(() => { calls++; return null; }, { retryOnNull: false });
      return [result, calls, await retry(() => 0), await retry(() => false)];
    `),
      { runAgent: vi.fn() },
    );
    expect(run.result).toEqual([null, 1, 0, false]);
  });

  it("does not retry cancellation", async () => {
    const abort = new AbortController();
    const runAgent = vi.fn(async () => {
      abort.abort();
      throw new Error("cancelled");
    });
    await expect(
      runWorkflow(script('return await retry(() => agent("work"));'), {
        runAgent,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
