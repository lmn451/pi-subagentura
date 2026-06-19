import { describe, expect, it } from "vitest";
import {
  parseWorkflow,
  runWorkflow,
  extractJson,
  validateSchema,
  MAX_ITEMS_PER_CALL,
  saveWorkflowScript,
  loadWorkflowScript,
  listSavedWorkflows,
  sanitizeWorkflowName,
  startWorkflowJob,
  workflowJobRegistry,
  awaitInteractiveResult,
  type WorkflowAgentRunner,
} from "./workflow";
import type { SubagentResult } from "./helpers";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock sub-agent runner ────────────────────────────────────────────
function ok(output: string, outTokens = 0): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 0,
      output: outTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
  };
}
function fail(msg = "boom"): SubagentResult {
  return {
    isError: true,
    output: "(no output)",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: undefined,
    errorMessage: msg,
  };
}

/** A runner that echoes the prompt, optionally tracking concurrency. */
function echoRunner(): WorkflowAgentRunner {
  return async ({ prompt }) => ok(prompt);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("parseWorkflow", () => {
  it("extracts a pure-literal meta and the body", () => {
    const { meta, body } = parseWorkflow(
      `export const meta = { name: "flow", description: "does things" };\nreturn 42;`,
    );
    expect(meta.name).toBe("flow");
    expect(meta.description).toBe("does things");
    expect(body).toContain("return 42;");
    expect(body).not.toContain("export const meta");
  });

  it("handles braces and semicolons inside meta string values", () => {
    const { meta, body } = parseWorkflow(
      `export const meta = { name: "f", description: "uses { and } and ; chars" };\nlog("hi");`,
    );
    expect(meta.description).toBe("uses { and } and ; chars");
    expect(body).toContain('log("hi");');
  });

  it("rejects a meta literal that references a helper (not pure)", () => {
    expect(() =>
      parseWorkflow(`export const meta = { name: agent, description: "x" };\n`),
    ).toThrow(/pure literal/i);
  });

  it("throws when meta is missing", () => {
    expect(() => parseWorkflow(`return 1;`)).toThrow(/export const meta/);
  });

  it("throws when name/description are absent", () => {
    expect(() => parseWorkflow(`export const meta = { name: "x" };\n`)).toThrow(
      /description/,
    );
  });
});

describe("determinism guards", () => {
  const meta = `export const meta = { name: "g", description: "d" };\n`;
  const run = (body: string) =>
    runWorkflow(meta + body, { runAgent: echoRunner() });

  it("throws on Date.now()", async () => {
    await expect(run(`return Date.now();`)).rejects.toThrow(/Date\.now/);
  });
  it("throws on argless new Date()", async () => {
    await expect(run(`return new Date();`)).rejects.toThrow(/new Date/);
  });
  it("throws on Math.random()", async () => {
    await expect(run(`return Math.random();`)).rejects.toThrow(/Math\.random/);
  });
  it("allows new Date(ts) and Math.floor()", async () => {
    const r = await run(`return new Date(0).getTime() + Math.floor(1.9);`);
    expect(r.result).toBe(1);
  });
  it("does not inject Node globals", async () => {
    const r = await run(`return typeof process + "," + typeof require;`);
    expect(r.result).toBe("undefined,undefined");
  });
});

describe("agent() + budget", () => {
  const meta = `export const meta = { name: "a", description: "d" };\n`;

  it("returns the sub-agent output text", async () => {
    const r = await runWorkflow(meta + `return await agent("hello");`, {
      runAgent: echoRunner(),
    });
    expect(r.result).toBe("hello");
    expect(r.agentsSpawned).toBe(1);
  });

  it("returns null and counts errors when the sub-agent errors", async () => {
    const r = await runWorkflow(meta + `return await agent("x");`, {
      runAgent: async () => fail(),
    });
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
  });

  it("accumulates token spend and throws once the budget is exhausted", async () => {
    const runAgent: WorkflowAgentRunner = async () => ok("done", 100);
    const r = await runWorkflow(
      meta + `await agent("a"); await agent("b"); return budget.remaining();`,
      { runAgent, budgetTotal: 150 },
    );
    // first agent spends 100 (remaining 50 > 0 ok), second spends 100 (now -50 -> 0 floor)
    expect(r.tokensSpent).toBe(200);
    expect(r.result).toBe(0);

    await expect(
      runWorkflow(
        meta + `await agent("a"); await agent("b"); await agent("c");`,
        {
          runAgent,
          budgetTotal: 150,
        },
      ),
    ).rejects.toThrow(/budget exhausted/i);
  });
});

describe("parallel()", () => {
  const meta = `export const meta = { name: "p", description: "d" };\n`;

  it("runs thunks concurrently and maps failures to null", async () => {
    const runAgent: WorkflowAgentRunner = async ({ prompt }) =>
      prompt === "bad" ? fail() : ok(prompt);
    const r = await runWorkflow(
      meta +
        `return await parallel([() => agent("a"), () => agent("bad"), () => agent("c")]);`,
      { runAgent },
    );
    expect(r.result).toEqual(["a", null, "c"]);
  });

  it("never exceeds the concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
      return ok(prompt);
    };
    const body = `return await parallel(Array.from({length: 10}, (_, i) => () => agent("t" + i)));`;
    const r = await runWorkflow(meta + body, { runAgent, concurrency: 2 });
    expect((r.result as unknown[]).length).toBe(10);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("throws when item count exceeds the cap", async () => {
    const body = `return await parallel(Array.from({length: ${MAX_ITEMS_PER_CALL + 1}}, () => () => agent("x")));`;
    await expect(
      runWorkflow(meta + body, { runAgent: echoRunner() }),
    ).rejects.toThrow(/exceeds the/);
  });
});

describe("pipeline()", () => {
  const meta = `export const meta = { name: "pl", description: "d" };\n`;

  it("threads each item through stages independently", async () => {
    const body = `
      return await pipeline(
        [1, 2, 3],
        (prev) => prev * 10,
        (prev, item, index) => ({ prev, item, index })
      );`;
    const r = await runWorkflow(meta + body, { runAgent: echoRunner() });
    expect(r.result).toEqual([
      { prev: 10, item: 1, index: 0 },
      { prev: 20, item: 2, index: 1 },
      { prev: 30, item: 3, index: 2 },
    ]);
  });

  it("drops an item to null when a stage throws", async () => {
    const body = `
      return await pipeline(
        [1, 2, 3],
        (prev) => { if (prev === 2) throw new Error("nope"); return prev; }
      );`;
    const r = await runWorkflow(meta + body, { runAgent: echoRunner() });
    expect(r.result).toEqual([1, null, 3]);
  });
});

describe("schema enforcement", () => {
  const meta = `export const meta = { name: "s", description: "d" };\n`;
  const schema = {
    type: "object",
    required: ["n"],
    properties: { n: { type: "number" } },
  };

  it("parses and validates structured output", async () => {
    const runAgent: WorkflowAgentRunner = async () =>
      ok('```json\n{"n": 7}\n```');
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toEqual({ n: 7 });
  });

  it("retries on invalid output then succeeds", async () => {
    let call = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      call++;
      return call === 1 ? ok('{"n": "not-a-number"}') : ok('{"n": 5}');
    };
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toEqual({ n: 5 });
    expect(call).toBe(2);
  });

  it("returns null and counts an error after exhausting retries", async () => {
    const runAgent: WorkflowAgentRunner = async () => ok("no json here");
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
    expect(r.agentsSpawned).toBe(3);
  });
});

describe("extractJson", () => {
  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("extracts the first balanced object from surrounding prose", () => {
    expect(extractJson('Sure! Here you go: {"a": {"b": 2}} done')).toBe(
      '{"a": {"b": 2}}',
    );
  });
  it("extracts arrays", () => {
    expect(extractJson("result: [1, 2, 3]")).toBe("[1, 2, 3]");
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("just words")).toBeNull();
  });
});

describe("validateSchema", () => {
  it("passes a conforming object", () => {
    const s = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    };
    expect(validateSchema({ x: "hi" }, s)).toEqual([]);
  });
  it("reports a missing required property", () => {
    const s = {
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    };
    expect(validateSchema({}, s).length).toBeGreaterThan(0);
  });
  it("enforces array minItems and item type", () => {
    const s = { type: "array", minItems: 2, items: { type: "number" } };
    expect(validateSchema([1], s).length).toBeGreaterThan(0);
    expect(validateSchema([1, "two"], s).length).toBeGreaterThan(0);
    expect(validateSchema([1, 2], s)).toEqual([]);
  });
  it("enforces enum", () => {
    const s = { enum: ["a", "b"] };
    expect(validateSchema("a", s)).toEqual([]);
    expect(validateSchema("c", s).length).toBeGreaterThan(0);
  });
});

describe("workflow() composition", () => {
  const meta = `export const meta = { name: "w", description: "d" };\n`;

  it("runs a saved workflow inline and shares the agent counter", async () => {
    const child = `export const meta = { name: "child", description: "c" };\nreturn await agent("from child");`;
    const loadWorkflow = (n: string) => (n === "child" ? child : null);
    const r = await runWorkflow(
      meta +
        `const c = await workflow("child"); const p = await agent("from parent"); return [c, p];`,
      { runAgent: echoRunner(), loadWorkflow },
    );
    expect(r.result).toEqual(["from child", "from parent"]);
    expect(r.agentsSpawned).toBe(2); // counters shared across parent + child
  });

  it("throws when the named workflow is not found", async () => {
    await expect(
      runWorkflow(meta + `return await workflow("missing");`, {
        runAgent: echoRunner(),
        loadWorkflow: () => null,
      }),
    ).rejects.toThrow(/no saved workflow named/);
  });

  it("rejects nesting beyond one level", async () => {
    const child = `export const meta = { name: "child", description: "c" };\nreturn await workflow("grand");`;
    const loadWorkflow = (n: string) =>
      n === "child"
        ? child
        : `export const meta = { name: "g", description: "g" };\nreturn 1;`;
    await expect(
      runWorkflow(meta + `return await workflow("child");`, {
        runAgent: echoRunner(),
        loadWorkflow,
      }),
    ).rejects.toThrow(/one level deep/);
  });
});

describe("saved workflows", () => {
  it("saves, loads, and lists a workflow by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-saved-"));
    const script = `export const meta = { name: "greet", description: "say hi" };\nreturn "hi";`;
    saveWorkflowScript("greet", script, dir);
    expect(loadWorkflowScript("greet", dir)).toBe(script);
    expect(loadWorkflowScript("nope", dir)).toBeNull();
    const list = listSavedWorkflows(dir);
    expect(list).toEqual([{ name: "greet", description: "say hi" }]);
  });

  it("rejects an invalid name and an unparseable script", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-saved-"));
    expect(() => sanitizeWorkflowName("Bad Name")).toThrow(
      /Invalid workflow name/,
    );
    expect(() => saveWorkflowScript("ok", `return 1;`, dir)).toThrow(
      /export const meta/,
    );
  });
});

describe("background workflow jobs", () => {
  it("runs in the background and exposes status + result", async () => {
    const script = `export const meta = { name: "bg", description: "d" };\nreturn await agent("done");`;
    const job = startWorkflowJob("bg", script, { runAgent: echoRunner() });
    expect(workflowJobRegistry.get(job.id)).toBe(job);
    const run = await job.promise;
    expect(run.result).toBe("done");
    expect(job.status).toBe("done");
    expect(job.snapshot.agentsSpawned).toBe(1);
  });

  it("marks the job cancelled when aborted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      await gate;
      return ok(prompt);
    };
    const script = `export const meta = { name: "bgc", description: "d" };\nreturn await agent("x");`;
    const job = startWorkflowJob("bgc", script, { runAgent });
    job.abort.abort();
    release();
    await expect(job.promise).rejects.toThrow(/aborted/);
    expect(job.status).toBe("cancelled");
  });
});

describe("awaitInteractiveResult", () => {
  function fakeState(dir: string) {
    return { id: "abcd1234", artifactDir: dir, model: "test/model" } as any;
  }

  it("resolves with output.md when a done event is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "final answer");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({ ts: 1, type: "started", status: "running" }) +
        "\n" +
        JSON.stringify({ ts: 2, type: "done", status: "done", exitCode: 0 }) +
        "\n",
    );
    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("final answer");
  });

  it("returns an error result on an error event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "partial");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        ts: 1,
        type: "error",
        status: "error",
        message: "kaboom",
      }) + "\n",
    );
    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);
    expect(res.isError).toBe(true);
    expect((res as any).errorMessage).toMatch(/kaboom/);
  });

  it("honors an already-aborted signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    mkdirSync(dir, { recursive: true });
    const ac = new AbortController();
    ac.abort();
    const res = await awaitInteractiveResult(fakeState(dir), ac.signal, 5);
    expect(res.isError).toBe(true);
    expect((res as any).errorMessage).toMatch(/aborted/);
  });
});

describe("abort signal propagation", () => {
  const meta = `export const meta = { name: "abort", description: "d" };\n`;

  // Helper: a runAgent that aborts mid-flight if `signal` has fired.
  function abortableRunAgent(delayMs = 10): WorkflowAgentRunner {
    return async ({ signal }) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (signal?.aborted) throw new Error("Workflow aborted.");
      return ok("done");
    };
  }

  it("parallel() re-throws when the signal aborts mid-flight", async () => {
    const ac = new AbortController();
    const p = runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      { runAgent: abortableRunAgent(10), signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 2);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("pipeline() re-throws when the signal aborts mid-flight", async () => {
    const ac = new AbortController();
    const p = runWorkflow(
      meta +
        `const stage = async (prev) => { await agent("s"); return prev; };
         const r = await pipeline([1, 2], stage); return r;`,
      { runAgent: abortableRunAgent(10), signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 2);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("parallel() pre-aborted (signal fires before invoke) re-throws without running agents", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      calls++;
      return ok("nope");
    };
    await expect(
      runWorkflow(
        meta + `return await parallel([() => agent("a"), () => agent("b")]);`,
        { runAgent, signal: ac.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(0); // agents never invoked — abort check fires first
  });

  it("non-abort failures in parallel() are still nulled (back-compat)", async () => {
    const runAgent: WorkflowAgentRunner = async () => fail("boom");
    const r = await runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      { runAgent },
    );
    expect(r.result).toEqual([null, null]);
    expect(r.errorCount).toBe(2);
  });

  it("pipeline() pre-aborted (signal fires before invoke) re-throws without running agents", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const runAgent: WorkflowAgentRunner = async () => {
      calls++;
      return ok("nope");
    };
    await expect(
      runWorkflow(
        meta +
          `const stage = async (prev) => { await agent("s"); return prev; };
         return await pipeline([1, 2, 3], stage);`,
        { runAgent, signal: ac.signal },
      ),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(0); // agents never invoked — abort check fires first between stages
  });

  it("non-abort failures in pipeline() are still nulled (back-compat)", async () => {
    // A stage that throws on a specific item should still null that item (and only that item),
    // matching v1 back-compat. Only the engine.signal.aborted path escalates to a re-throw.
    const body = `
return await pipeline(
[1, 2, 3],
(prev) => { if (prev === 2) throw new Error("nope"); return prev; }
);`;
    const r = await runWorkflow(meta + body, { runAgent: echoRunner() });
    expect(r.result).toEqual([1, null, 3]);
  });
});
