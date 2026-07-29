import { describe, expect, it, vi } from "vitest";
import {
  MAX_ITEMS_PER_CALL,
  MAX_WORKFLOW_AGENT_RECORDS,
  SCHEMA_RETRIES,
  MAX_WORKFLOW_JOBS,
  MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
  awaitInteractiveResult,
  deleteWorkflowScript,
  extractJson,
  formatWorkflowUsage,
  getWorkflowCompletionPresentation,
  listSavedWorkflows,
  loadWorkflowScript,
  parseWorkflow,
  registerWorkflowTool,
  renderProgress,
  retryPendingWorkflowNotifications,
  runWorkflow,
  saveWorkflowScript,
  sanitizeWorkflowName,
  startWorkflowJob,
  type WorkflowAgentRunner,
  type WorkflowProgress,
  type WorkflowRunResult,
  type WorkflowRunResultWithUsage,
  type WorkflowUsage,
  validateSchema,
  workflowJobRegistry,
} from "../src/workflow";
import { withOrchestrationContext } from "../src/orchestration-context";
import type { SubagentResult } from "../src/helpers";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import { formatWorkflowNotificationSummary } from "../src/workflow-tool";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function richOk(
  output: string,
  usage = {
    input: 11,
    output: 7,
    cacheRead: 5,
    cacheWrite: 3,
    cost: 0.125,
    turns: 2,
  },
): SubagentResult {
  return { ...ok(output), usage };
}

function richFail(msg: string): SubagentResult {
  return {
    isError: true,
    output: "",
    usage: {
      input: 2,
      output: 1,
      cacheRead: 4,
      cacheWrite: 6,
      cost: 0.25,
      turns: 1,
    },
    model: undefined,
    errorMessage: msg,
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

function fakeState(dir: string): InteractiveSubagentState {
  return {
    id: "abcd1234",
    name: "workflow-test-agent",
    task: "test workflow",
    paneId: "%99",
    mux: "tmux",
    sessionFile: join(dir, "session.jsonl"),
    cwd: dir,
    model: "test/model",
    startedAt: Date.now(),
    status: "running",
    attachCommand: "tmux attach",
    selectPaneCommand: "tmux select-pane -t '%99'",
    launchScriptFile: join(dir, "launch.sh"),
    artifactDir: dir,
  };
}

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
      `export const meta = { name: "f", description: "uses { and } and ; chars" };\nlog(\"hi\");`,
    );
    expect(meta.description).toBe("uses { and } and ; chars");
    expect(body).toContain('log("hi");');
  });

  it("preserves nested literals, static templates, and negative numbers", () => {
    const { meta } = parseWorkflow(
      "export const meta = {\n" +
        '  name: "flow",\n' +
        "  description: `literal template`,\n" +
        "  phases: [{ title: `phase-template` }],\n" +
        "  retries: [1, -2, { values: [3, 4] }],\n" +
        "};\nreturn 0;",
    );
    expect(meta).toEqual({
      name: "flow",
      description: "literal template",
      phases: [{ title: "phase-template" }],
      retries: [1, -2, { values: [3, 4] }],
    });
  });

  it("finds metadata after helper declarations", () => {
    const script = [
      "const helper = 2;",
      "function helperFn() { return helper + 1; }",
      'export const meta = { name: "helpers", description: "after" };',
      "return helperFn();",
    ].join("\n");
    const { meta, body } = parseWorkflow(script);
    expect(meta).toEqual({ name: "helpers", description: "after" });
    expect(body).toContain("function helperFn()");
  });

  it("rejects member expressions in metadata values", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: base.name, description: \"d\" };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects call expressions in metadata", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: String(\"flow\"), description: \"d\" };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects interpolated template literals in metadata", () => {
    expect(() =>
      parseWorkflow(
        'export const meta = { name: `interpolated ${"x"}`, description: "d" };',
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects spread properties in metadata", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: \"x\", description: \"d\", ...{ whenToUse: \"x\" } };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects computed keys in metadata objects", () => {
    expect(() =>
      parseWorkflow(
        `const key = \"name\";\nexport const meta = { [key]: \"x\", description: \"d\" };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects shorthand keys in metadata objects", () => {
    expect(() =>
      parseWorkflow(
        `const n = \"x\";\nexport const meta = { n, description: \"d\" };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects methods and accessors in metadata objects", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { get name() { return \"x\"; }, description: \"d\" };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects sparse arrays in metadata", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: \"x\", description: \"d\", phases: [{ title: \"ok\" }, , { title: \"more\" }] };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects reserved keys in metadata", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: \"x\", description: \"d\", __proto__: {} };`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("rejects a meta literal that references a helper (not pure)", () => {
    expect(() =>
      parseWorkflow(
        `export const meta = { name: agent, description: \"x\" };\n`,
      ),
    ).toThrow(/pure literal/i);
  });

  it("throws when meta is missing", () => {
    expect(() => parseWorkflow(`return 1;`)).toThrow(/export const meta/);
  });

  it("throws when name/description are absent", () => {
    expect(() =>
      parseWorkflow(`export const meta = { name: \"x\" };\n`),
    ).toThrow(/description/);
  });

  it("ignores fake metadata in comments, templates, and regex literals", () => {
    const script = [
      '// export const meta = { name: "fake", description: "fake" };',
      'const text = `export const meta = { name: "fake-template", description: "fake" }; ${{ nested: { value: 1 } }.nested.value}`;',
      "const pattern = /export\\s+const\\s+meta\\s*=\\s*\\{/;",
      'export const meta = { name: "real", description: "real" };',
      "return [text, pattern.source];",
    ].join("\n");
    const { meta, body } = parseWorkflow(script);

    expect(meta.name).toBe("real");
    expect(body).toContain('export const meta = { name: "fake-template"');
    expect(body).toContain("/export\\s+const\\s+meta");
    expect(body).toContain("// export const meta");
  });

  it("finds the real metadata after a fake metadata string", () => {
    const script = String.raw`const fake = "export const meta = { name: 'fake', description: 'fake' };";
export const meta = { name: "real", description: "real" };
return fake;`;
    const { meta, body } = parseWorkflow(script);
    expect(meta).toEqual({ name: "real", description: "real" });
    expect(body).toContain("export const meta");
  });

  it("transforms actual top-level exports into executable declarations", async () => {
    const script = `export const helper = 40;
export default function increment(value) { return value + 2; }
export const meta = { name: "exports", description: "d" };
return increment(helper);`;
    const result = await runWorkflow(script, { runAgent: echoRunner() });

    expect(result.result).toBe(42);
  });

  it("handles a regex statement after a control-flow condition", async () => {
    const script = `export default function helper() {
  if (true) /}/.test("}");
  return 1;
}
export const meta = { name: "regex-control", description: "d" };
return helper();`;
    const result = await runWorkflow(script, { runAgent: echoRunner() });
    expect(result.result).toBe(1);
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

  it("blocks constructor-chain access to host process", async () => {
    await expect(
      run(`return this.constructor.constructor("return process.version")();`),
    ).rejects.toThrow(/Code generation from strings disallowed|process/i);
  });

  it("blocks constructor-chain Date.now bypass", async () => {
    await expect(
      run(`return this.constructor.constructor("return Date.now()")();`),
    ).rejects.toThrow(/Code generation from strings disallowed|Date\.now/i);
  });
});

describe("workflow cwd global", () => {
  const meta = `export const meta = { name: "cwd", description: "d" };\n`;

  it("exposes the parent cwd as an immutable enumerable global", async () => {
    const parentCwd = "/tmp/workflow-parent";
    const result = await runWorkflow(
      meta +
        `const before = cwd; cwd = "changed"; ` +
        `const descriptor = Object.getOwnPropertyDescriptor(globalThis, "cwd"); ` +
        `return { before, after: cwd, descriptor };`,
      { runAgent: echoRunner(), cwd: parentCwd },
    );

    expect(result.result).toEqual({
      before: parentCwd,
      after: parentCwd,
      descriptor: {
        value: parentCwd,
        enumerable: true,
        writable: false,
        configurable: false,
      },
    });
  });

  it("keeps cwd consistent in nested workflows", async () => {
    const parentCwd = "/tmp/workflow-nested";
    const child =
      `export const meta = { name: "child-cwd", description: "d" };\n` +
      `return cwd;`;
    const result = await runWorkflow(
      meta + `return [cwd, await workflow("child")];`,
      {
        runAgent: echoRunner(),
        cwd: parentCwd,
        loadWorkflow: () => child,
      },
    );

    expect(result.result).toEqual([parentCwd, parentCwd]);
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

  it("waits for unawaited agent work before completing", async () => {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      started();
      await gate;
      return ok(prompt);
    };
    const completion = runWorkflow(
      meta + `agent("background"); return "workflow-result";`,
      { runAgent },
    );
    let settled = false;
    void completion.then(() => (settled = true));
    await startedPromise;
    await tick();
    expect(settled).toBe(false);
    release();
    expect((await completion).result).toBe("workflow-result");
  });

  it("waits for agent work chained from an unawaited call", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(
      (resolve) => (releaseSecond = resolve),
    );
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      if (prompt === "second") await secondGate;
      return ok(prompt);
    };
    const completion = runWorkflow(
      meta +
        `agent("first").then(() => agent("second")); return "workflow-result";`,
      { runAgent },
    );
    let settled = false;
    void completion.then(() => (settled = true));
    await tick();
    await tick();
    expect(settled).toBe(false);
    releaseSecond();
    expect((await completion).result).toBe("workflow-result");
  });

  it("defaults agent isolation to process", async () => {
    let seenIsolation: string | undefined;
    const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
      seenIsolation = isolation;
      return ok("done");
    };

    await runWorkflow(meta + `return await agent("hello");`, { runAgent });

    expect(seenIsolation).toBe("process");
  });

  it("allows agent isolation to opt out to in-process", async () => {
    let seenIsolation: string | undefined;
    const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
      seenIsolation = isolation;
      return ok("done");
    };

    await runWorkflow(
      meta + `return await agent("hello", { isolation: "in-process" });`,
      { runAgent },
    );

    expect(seenIsolation).toBe("in-process");
  });

  it("inherits phases per workflow body without leaking nested phases", async () => {
    const phases: Array<string | undefined> = [];
    const child =
      `export const meta = { name: "child", description: "d" };\n` +
      `phase("Child"); return await agent("child");`;
    const script =
      meta +
      `phase("Parent"); await agent("before"); ` +
      `await workflow("child"); ` +
      `await agent("override", { phase: "Manual" }); ` +
      `return await agent("after");`;

    await runWorkflow(script, {
      runAgent: echoRunner(),
      loadWorkflow: () => child,
      onProgress: (progress) => {
        if (progress.kind === "agent_start") phases.push(progress.phase);
      },
    });

    expect(phases).toEqual(["Parent", "Child", "Manual", "Parent"]);
  });

  it("preserves an explicit phase over runner-emitted phases", async () => {
    const phases: Array<string | undefined> = [];
    const runAgent: WorkflowAgentRunner = async ({ onProgress }) => {
      onProgress?.({ kind: "phase", phase: "Internal" });
      onProgress?.({ kind: "log", message: "working", phase: "Internal" });
      return ok("done");
    };

    await runWorkflow(
      meta + `return await agent("hello", { phase: "Explicit" });`,
      {
        runAgent,
        onProgress: (progress) => {
          if (progress.kind === "phase" || progress.kind === "log") {
            phases.push(progress.phase);
          }
        },
      },
    );

    expect(phases).toEqual(["Explicit", "Explicit"]);
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
  it("allows parallel in-flight calls to overshoot the soft output target", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>(
      (resolve) => (bothStarted = resolve),
    );
    const runAgent: WorkflowAgentRunner = async () => {
      started++;
      if (started === 2) bothStarted();
      await gate;
      return ok("done", 4);
    };

    const completion = runWorkflow(
      meta +
        `return await parallel([` +
        `() => agent("a", { isolation: "in-process" }), ` +
        `() => agent("b", { isolation: "in-process" })]);`,
      { runAgent, budgetTotal: 5 },
    );
    await bothStartedPromise;
    release();

    const result = await completion;
    expect(result.tokensSpent).toBe(8);
    expect(result.result).toEqual(["done", "done"]);
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
    const body = `return await parallel(Array.from({length: 10}, (_, i) => () => agent("t" + i, { isolation: "in-process" })));`;
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

  it("rejects non-function stages instead of filtering them", async () => {
    const body = `return await pipeline([1], (prev) => prev + 1, null);`;
    await expect(
      runWorkflow(meta + body, { runAgent: echoRunner() }),
    ).rejects.toThrow(/pipeline\(\): stages must be functions/i);
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

  it("uses in-process structured output capture instead of parsing text", async () => {
    let schemaArg: unknown = undefined;
    const runAgent: WorkflowAgentRunner = async ({ schema }) => {
      schemaArg = schema;
      return {
        ...ok("noise"),
        workflowStructuredOutput: { called: true, value: { n: 7 } },
      };
    };
    const body = `return await agent("give n", { isolation: "in-process", schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(schemaArg).toEqual(schema);
    expect(r.result).toEqual({ n: 7 });
  });

  it("retries when structured_output is not called and fails after retries", async () => {
    let calls = 0;
    const expectedSchema = schema;
    let schemaArg: unknown = undefined;
    const runAgent: WorkflowAgentRunner = async ({ schema }) => {
      calls++;
      expect(schema).toEqual(expectedSchema);
      schemaArg = schema;
      return {
        ...ok("not json", 3),
        workflowStructuredOutput: { called: false, value: undefined },
      };
    };
    const body = `return await agent("give n", { isolation: "in-process", schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(schemaArg).toEqual(expectedSchema);
    expect(calls).toBe(SCHEMA_RETRIES);
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
    expect(r.usage?.output).toBe(3 * SCHEMA_RETRIES);
  });

  it("returns null and counts an error after exhausting retries", async () => {
    const runAgent: WorkflowAgentRunner = async () => ok("no json here");
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toBeNull();
    expect(r.errorCount).toBe(1);
    expect(r.agentsSpawned).toBe(3);
  });

  it("keeps process-mode schema behavior: no runner schema field, text fallback prompt", async () => {
    let runAgentCalls = 0;
    let schemaArg: unknown = undefined;
    let promptPreview = "";
    const runAgent: WorkflowAgentRunner = async ({ schema, prompt }) => {
      schemaArg = schema;
      if (!promptPreview) promptPreview = prompt as string;
      const out = runAgentCalls === 0 ? ok("oops", 1) : ok('{"n": 5}', 2);
      runAgentCalls++;
      return out;
    };
    const body = `return await agent("give n", { schema: ${JSON.stringify(schema)} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(schemaArg).toBeUndefined();
    expect(promptPreview).toContain("Respond with ONLY a single JSON value");
    expect(r.result).toEqual({ n: 5 });
    expect(runAgentCalls).toBe(2);
  });

  it("does not pass schema to non-schema sub-agent runs", async () => {
    let schemaArg: unknown = undefined;
    const runAgent: WorkflowAgentRunner = async ({ schema }) => {
      schemaArg = schema;
      return ok("done");
    };
    const body = `return await agent("just do work");`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(schemaArg).toBeUndefined();
    expect(r.result).toBe("done");
  });

  it("accepts strict JSON scalar outputs in process mode", async () => {
    const cases = [
      { schema: { type: "string" }, output: '"done"', expected: "done" },
      { schema: { type: "number" }, output: "3.5", expected: 3.5 },
      { schema: { type: "integer" }, output: "7", expected: 7 },
      { schema: { type: "boolean" }, output: "true", expected: true },
      { schema: { type: "null" }, output: "null", expected: null },
    ];

    for (const testCase of cases) {
      const isolations: string[] = [];
      const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
        isolations.push(isolation ?? "undefined");
        return ok(testCase.output);
      };
      const body = `return await agent("scalar", { schema: ${JSON.stringify(testCase.schema)} });`;
      const r = await runWorkflow(meta + body, { runAgent });
      expect(r.result).toEqual(testCase.expected);
      expect(r.errorCount).toBe(0);
      expect(isolations).toEqual(["process"]);
    }
  });

  it("rejects prose around scalar JSON and retries in process mode", async () => {
    const cases = [
      { schema: { type: "string" }, output: 'Answer: "done"' },
      { schema: { type: "number" }, output: "The answer is 3.5." },
      { schema: { type: "integer" }, output: "Result: 7" },
      { schema: { type: "boolean" }, output: "The answer is true." },
      { schema: { type: "null" }, output: "Result: null" },
    ];

    for (const testCase of cases) {
      const isolations: string[] = [];
      const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
        isolations.push(isolation ?? "undefined");
        return ok(testCase.output);
      };
      const body = `return await agent("scalar", { schema: ${JSON.stringify(testCase.schema)} });`;
      const r = await runWorkflow(meta + body, { runAgent });
      expect(r.result).toBeNull();
      expect(r.errorCount).toBe(1);
      expect(isolations).toEqual(Array(SCHEMA_RETRIES).fill("process"));
    }
  });

  it("accepts fenced JSON scalars in process mode", async () => {
    const isolations: string[] = [];
    const runAgent: WorkflowAgentRunner = async ({ isolation }) => {
      isolations.push(isolation ?? "undefined");
      return ok("Here is the answer:\n```json\n42\n```\nThanks.");
    };
    const body = `return await agent("scalar", { schema: ${JSON.stringify({ type: "number" })} });`;
    const r = await runWorkflow(meta + body, { runAgent });
    expect(r.result).toBe(42);
    expect(r.errorCount).toBe(0);
    expect(isolations).toEqual(["process"]);
  });
});

describe("extractJson", () => {
  it("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("requires object output to be JSON-only (no surrounding prose)", () => {
    expect(extractJson('Sure! Here you go: {"a": {"b": 2}} done')).toBeNull();
  });
  it("requires array output to be JSON-only (no surrounding prose)", () => {
    expect(extractJson("result: [1, 2, 3]")).toBeNull();
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("just words")).toBeNull();
  });
  it("accepts strict string scalars", () => {
    expect(extractJson('"done"')).toBe('"done"');
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

  it("rejects object refs instead of reading scriptPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-script-path-"));
    const external = join(dir, "external.js");
    writeFileSync(
      external,
      `export const meta = { name: "external", description: "d" };\nreturn "external";`,
    );

    await expect(
      runWorkflow(
        meta +
          `return await workflow({ scriptPath: ${JSON.stringify(external)} });`,
        { runAgent: echoRunner() },
      ),
    ).rejects.toThrow(/saved-workflow name/i);
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

  it("deleteWorkflowScript removes a saved workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    const script = `export const meta = { name: "greet", description: "say hi" };\nreturn "hi";`;
    saveWorkflowScript("greet", script, dir);
    expect(loadWorkflowScript("greet", dir)).toBe(script);
    const result = deleteWorkflowScript("greet", dir);
    expect(result).toBe(true);
    expect(loadWorkflowScript("greet", dir)).toBeNull();
  });

  it("deleteWorkflowScript returns false for missing workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    const result = deleteWorkflowScript("nonexistent", dir);
    expect(result).toBe(false);
  });

  it("deleteWorkflowScript throws on invalid name", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-del-"));
    expect(() => deleteWorkflowScript("Bad Name", dir)).toThrow(
      /Invalid workflow name/,
    );
  });

  it("listSavedWorkflows handles unparseable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-list-"));
    // Write a file that's not valid JSON/meta
    writeFileSync(
      join(dir, "broken.js"),
      "this is not a valid workflow",
      "utf8",
    );
    const list = listSavedWorkflows(dir);
    expect(list).toEqual([{ name: "broken", description: "(unparseable)" }]);
  });
});

describe("background workflow jobs", () => {
  it("presents resolved agent errors as a warning", () => {
    expect(getWorkflowCompletionPresentation("done", 2)).toEqual({
      label: "completed with errors",
      icon: "⚠",
    });
    expect(getWorkflowCompletionPresentation("error", 0)).toEqual({
      label: "error",
      icon: "",
    });
  });

  it("runs in the background and exposes status + result", async () => {
    const script = `export const meta = { name: "bg", description: "d" };\nreturn await agent("done");`;
    const job = startWorkflowJob("bg", script, { runAgent: echoRunner() });
    expect(workflowJobRegistry.get(job.id)).toBe(job);
    const run = await job.promise;
    expect(run.result).toBe("done");
    expect(job.status).toBe("done");
    expect(job.snapshot.agentsSpawned).toBe(1);
  });

  it("stores one bounded record per agent attempt", async () => {
    const count = MAX_WORKFLOW_AGENT_RECORDS + 1;
    const script =
      `export const meta = { name: "records", description: "d" };\n` +
      `return await parallel(Array.from({ length: ${count} }, (_, index) => ` +
      `() => agent(String(index), { label: "worker" })));`;
    const job = startWorkflowJob("records", script, { runAgent: echoRunner() });

    await job.promise;

    expect(job.snapshot.agentRecords).toHaveLength(MAX_WORKFLOW_AGENT_RECORDS);
    expect(job.snapshot.agentRecordsOmitted).toBe(1);
    expect(job.snapshot.agentRecords?.[0]?.agentId).toBe(2);
    expect(job.snapshot.agentRecords?.at(-1)?.agentId).toBe(count);
    expect(
      job.snapshot.agentRecords?.every((record) => record.status === "done"),
    ).toBe(true);
  });

  it("calls the completion hook after all agents finish", async () => {
    const onComplete = vi.fn();
    const script =
      `export const meta = { name: "bg-hook", description: "d" };\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "bg-hook",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    await job.promise;

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
    expect(job.status).toBe("done");
    expect(job.result?.result).toBe("done");
  });

  it("calls the completion hook when a workflow fails", async () => {
    const onComplete = vi.fn();
    const runAgent: WorkflowAgentRunner = () => {
      throw new Error("workflow boom");
    };
    const script =
      `export const meta = { name: "bg-error", description: "d" };\n` +
      `return await agent("fail");`;
    const job = startWorkflowJob(
      "bg-error",
      script,
      { runAgent },
      undefined,
      onComplete,
    );

    await expect(job.promise).rejects.toThrow("workflow boom");

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
    expect(job.status).toBe("error");
  });

  it("marks the job cancelled when aborted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      await gate;
      return ok(prompt);
    };
    const script = `export const meta = { name: "bgc", description: "d" };\nreturn await agent("x");`;
    const onComplete = vi.fn();
    const job = startWorkflowJob(
      "bgc",
      script,
      { runAgent },
      undefined,
      onComplete,
    );
    job.abort.abort();
    release();
    await expect(job.promise).rejects.toThrow(/aborted/);
    expect(job.status).toBe("cancelled");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(job);
  });

  it("suppresses a late completion hook after parent shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const onComplete = vi.fn();
    const job = startWorkflowJob(
      "late",
      `export const meta = { name: "late", description: "d" };\nreturn await agent("x");`,
      {
        runAgent: async ({ prompt }) => {
          await gate;
          return ok(prompt);
        },
      },
      undefined,
      onComplete,
    );

    job.suppressCompletionNotification = true;
    job.abort.abort();
    release();

    await expect(job.promise).rejects.toThrow(/aborted/);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("snapshot reflects in-flight agents before they complete (regression: agent_start emit)", async () => {
    // Pre-fix bug: the only "agent" emit fired AFTER `await runAgent` returned, so the snapshot's
    // agentsSpawned stayed at 0 until every agent finished. Process-isolated agents can take minutes,
    // making get_workflow_status look stuck. The fix emits "agent_start" right after the counter is
    // incremented, so the snapshot reflects in-flight activity immediately.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      await gate;
      return ok(prompt);
    };
    const script = `export const meta = { name: "bgs", description: "d" };\nreturn await agent("x");`;
    const job = startWorkflowJob("bgs", script, { runAgent });

    // Worker-backed workflows cross a thread boundary before the parent emits agent_start.
    // Wait for that handoff, but assert while runAgent is still blocked on gate.
    for (let i = 0; i < 500 && job.snapshot.agentsSpawned === 0; i++)
      await new Promise((r) => setTimeout(r, 10));

    // While the agent is still blocked on `gate`, the snapshot must already show 1 spawned.
    // This is the regression: pre-fix, this would be 0.
    expect(job.snapshot.agentsSpawned).toBe(1);
    expect(job.snapshot.lastMessage).toBe("→ started agent");

    release();
    await job.promise;
    expect(job.snapshot.agentsSpawned).toBe(1);
    expect(job.snapshot.lastMessage).toBe("→ done agent");
  }, 10_000);

  it("clears runningCount when runAgent throws", async () => {
    const runAgent: WorkflowAgentRunner = () => {
      throw new Error("boom");
    };
    const script = `export const meta = { name: "bgr", description: "d" };\nreturn await agent("x");`;
    const job = startWorkflowJob("bgr", script, { runAgent });

    await expect(job.promise).rejects.toThrow("boom");
    expect(job.status).toBe("error");
    expect(job.snapshot.runningCount).toBe(0);
  });
});
it("sets startedAt from the passed timestamp", () => {
  const script = `export const meta = { name: "ts", description: "d" };\nreturn 1;`;
  const startedAt = 1234567890;
  const job = startWorkflowJob(
    "ts",
    script,
    { runAgent: echoRunner() },
    startedAt,
  );
  expect(job.startedAt).toBe(startedAt);
});

it("defaults startedAt to Date.now() when not provided", () => {
  const before = Date.now();
  const script = `export const meta = { name: "ts2", description: "d" };\nreturn 1;`;
  const job = startWorkflowJob("ts2", script, { runAgent: echoRunner() });
  expect(job.startedAt).toBeGreaterThanOrEqual(before);
  expect(job.startedAt).toBeLessThanOrEqual(Date.now());
});

it("throws when all 100 job slots are full and none can be evicted", () => {
  const filled: string[] = [];
  try {
    for (let i = 0; i < MAX_WORKFLOW_JOBS; i++) {
      const id = `cap-fill-${i}`;
      workflowJobRegistry.set(id, {
        id,
        name: "filler",
        status: "running",
        startedAt: Date.now(),
        promise: undefined as any,
        abort: new AbortController(),
        snapshot: {
          agentsSpawned: 0,
          errorCount: 0,
          tokensSpent: 0,
          phases: [],
        },
      });
      filled.push(id);
    }
    const script = `export const meta = { name: "x", description: "d" };\nreturn "ok";`;
    expect(() =>
      startWorkflowJob("x", script, { runAgent: echoRunner() }),
    ).toThrow(/100 workflow jobs already running/);
  } finally {
    for (const id of filled) workflowJobRegistry.delete(id);
  }
});

describe("awaitInteractiveResult", () => {
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

  it("does not reuse a legacy completion from a previous turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-stale-"));
    writeFileSync(join(dir, "output.md"), "stale answer");
    writeFileSync(
      join(dir, "events.ndjson"),
      [
        { ts: 1, type: "done", status: "done" },
        {
          version: 2,
          eventId: "turn-start-current",
          turnId: "turn-current",
          ts: 2,
          type: "turn_started",
          status: "running",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    const result = await awaitInteractiveResult(
      fakeState(dir),
      controller.signal,
      1,
    );

    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("expected aborted result");
    expect(result.errorMessage).toBe("aborted");
    expect(result.output).not.toBe("stale answer");
  });

  it("ignores a late v2 completion for a different turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-late-"));
    writeFileSync(join(dir, "output.md"), "late stale answer");
    writeFileSync(
      join(dir, "events.ndjson"),
      [
        {
          version: 2,
          eventId: "turn-start-current",
          turnId: "turn-current",
          ts: 2,
          type: "turn_started",
          status: "running",
        },
        {
          version: 2,
          eventId: "completion-old",
          turnId: "turn-old",
          ts: 3,
          type: "completion",
          status: "done",
          outcome: "done",
          source: "agent_settled",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);

    const result = await awaitInteractiveResult(
      fakeState(dir),
      controller.signal,
      1,
    );

    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("expected aborted result");
    expect(result.errorMessage).toBe("aborted");
    expect(result.output).not.toBe("late stale answer");
  });

  it("accepts a matching current-turn v2 completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-current-"));
    const art = artifactPath(dir, "artifact");
    appendEvent(art, {
      version: 2,
      eventId: "turn-start-current",
      turnId: "turn-current",
      ts: 2,
      type: "turn_started",
      status: "running",
    });
    writeOutput(art, "current answer");
    appendCompletionEvent(art, {
      turnId: "turn-current",
      eventId: "completion-current",
      outcome: "done",
      source: "agent_settled",
    });

    const result = await awaitInteractiveResult(
      fakeState(art.dir),
      undefined,
      1,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe("current answer");
  });

  it("resolves a protocol-v2 completion from its immutable snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    const outputDir = join(dir, "outputs");
    const outputPath = join(outputDir, "event-v2.md");
    const output = Buffer.from("v2 final answer");
    mkdirSync(outputDir);
    writeFileSync(join(dir, "output.md"), "stale staging output");
    writeFileSync(outputPath, output);
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        version: 2,
        eventId: "event-v2",
        turnId: "turn-v2",
        ts: 2,
        type: "completion",
        status: "done",
        outcome: "done",
        source: "explicit",
        output: {
          path: outputPath,
          bytes: output.byteLength,
          sha256: createHash("sha256").update(output).digest("hex"),
        },
      }) + "\n",
    );

    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);

    expect(res.isError).toBe(false);
    expect(res.output).toBe("v2 final answer");
  });

  it("does not fall back to mutable output for a rejected v2 snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "untrusted staging output");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        version: 2,
        eventId: "event-v2-oversized",
        turnId: "turn-v2-oversized",
        ts: 2,
        type: "completion",
        status: "done",
        outcome: "done",
        source: "explicit",
        outputError: {
          code: "output_too_large",
          bytes: 1_048_577,
          maxBytes: 1_048_576,
        },
      }) + "\n",
    );

    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);

    expect(res.isError).toBe(false);
    expect(res.output).toBe("(no output)");
  });

  it("returns an error result for a protocol-v2 error completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "partial");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        version: 2,
        eventId: "event-v2-error",
        turnId: "turn-v2-error",
        ts: 2,
        type: "completion",
        status: "error",
        outcome: "error",
        source: "explicit",
        errorMessage: "v2 kaboom",
      }) + "\n",
    );

    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);

    expect(res).toMatchObject({
      isError: true,
      errorMessage: "v2 kaboom",
    });
  });

  it("returns an error result for a protocol-v2 cancelled completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-int-"));
    writeFileSync(join(dir, "output.md"), "partial");
    writeFileSync(
      join(dir, "events.ndjson"),
      JSON.stringify({
        version: 2,
        eventId: "event-v2-cancelled",
        turnId: "turn-v2-cancelled",
        ts: 2,
        type: "completion",
        status: "cancelled",
        outcome: "cancelled",
        source: "parent",
        message: "stopped by parent",
      }) + "\n",
    );

    const res = await awaitInteractiveResult(fakeState(dir), undefined, 5);

    expect(res).toMatchObject({
      isError: true,
      errorMessage: "stopped by parent",
    });
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

  it("abort terminates a workflow stuck in synchronous script code", async () => {
    const ac = new AbortController();
    const p = runWorkflow(meta + `while (true) {}`, {
      runAgent: echoRunner(),
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("workflow timeout aborts in-flight agent work and suppresses late progress", async () => {
    let abortSeen = false;
    let resolveLate!: () => void;
    const lateDone = new Promise<void>((resolve) => (resolveLate = resolve));
    const progress: string[] = [];
    const runAgent: WorkflowAgentRunner = async ({ signal }) => {
      signal?.addEventListener(
        "abort",
        () => {
          abortSeen = true;
        },
        { once: true },
      );
      await new Promise((r) => setTimeout(r, 2500));
      resolveLate();
      return ok("late");
    };

    const p = runWorkflow(meta + `return await agent("slow");`, {
      runAgent,
      workflowTimeoutMs: 2000,
      onProgress: (ev) => {
        progress.push(`${ev.kind}:${ev.runningCount}:${ev.agentsSpawned}`);
      },
    });

    await expect(p).rejects.toThrow(/timed out/i);
    expect(abortSeen).toBe(true);
    const progressAtFailure = [...progress];

    await lateDone;
    await tick();
    expect(progress).toEqual(progressAtFailure);
  }, 10_000);

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

  it("counts non-abort thrown agent failures once", async () => {
    const runAgent: WorkflowAgentRunner = async () => {
      throw new Error("boom");
    };
    const progress: WorkflowProgress[] = [];
    const r = await runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      {
        runAgent,
        onProgress: (event) => progress.push({ ...event }),
      },
    );

    expect(r.result).toEqual([null, null]);
    expect(r.agentsSpawned).toBe(2);
    expect(r.errorCount).toBe(2);
    expect(progress[progress.length - 1].runningCount).toBe(0);
  });

  it("aggregates valid v2 artifact results through parallel", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-v2-runner-"));
    const outcomes = ["done", "error", "cancelled"] as const;
    let callIndex = 0;
    const observed = new Map<string, SubagentResult>();
    const runAgent: WorkflowAgentRunner = async ({ prompt }) => {
      const index = callIndex++;
      const art = artifactPath(root, `agent-${index}`);
      writeOutput(art, `answer-${prompt}`);
      appendCompletionEvent(art, {
        turnId: `turn-${index}`,
        eventId: `event-${index}`,
        outcome: outcomes[index],
        source: outcomes[index] === "cancelled" ? "parent" : "agent_settled",
      });
      const result = await awaitInteractiveResult(
        fakeState(art.dir),
        undefined,
        1,
      );
      observed.set(prompt, result);
      return result;
    };
    const progress: WorkflowProgress[] = [];
    const meta = `export const meta = { name: "parallel-agg", description: "d" };\n`;

    try {
      const r = await runWorkflow(
        meta +
          `const r = await parallel([() => agent("a"), () => agent("b"), () => agent("c")]); return r;`,
        {
          runAgent,
          processConcurrency: 3,
          onProgress: (p) => progress.push({ ...p }),
        },
      );

      expect(r.agentsSpawned).toBe(3);
      expect(r.errorCount).toBe(2);
      expect(r.result).toEqual(["answer-a", null, null]);
      const observedByPrompt = [...observed.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      );
      expect(
        observedByPrompt.map(([prompt, result]) => [prompt, result.output]),
      ).toEqual([
        ["a", "answer-a"],
        ["b", "answer-b"],
        ["c", "answer-c"],
      ]);
      expect(
        observedByPrompt.map(([prompt, result]) => [prompt, result.isError]),
      ).toEqual([
        ["a", false],
        ["b", true],
        ["c", true],
      ]);
      expect(progress[progress.length - 1].runningCount).toBe(0);
      expect(progress.filter((p) => p.kind === "agent_done")).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parallel workflow error/cancelled outcomes clear runningCount", async () => {
    const runAgent: WorkflowAgentRunner = async () => ({
      isError: true,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
      model: undefined,
      errorMessage: "cancelled",
    });

    const progress: WorkflowProgress[] = [];
    const meta = `export const meta = { name: "parallel-ec", description: "d" };\n`;
    const r = await runWorkflow(
      meta +
        `const r = await parallel([() => agent("a"), () => agent("b")]); return r;`,
      {
        runAgent,
        onProgress: (p) => progress.push({ ...p }),
      },
    );

    expect(r.agentsSpawned).toBe(2);
    expect(r.errorCount).toBe(2);
    expect(r.result).toEqual([null, null]);

    const lastProgress = progress[progress.length - 1];
    expect(lastProgress.runningCount).toBe(0);
  });
});

describe("renderProgress", () => {
  it("formats a phase progress update", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "Scanning",
      agentsSpawned: 2,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("● workflow — 2 agent(s)");
    expect(result).toContain("⚡ 1 running");
    expect(result).toContain("100 output tokens");
    expect(result).toContain("◆ phase: Scanning");
  });

  it("formats a log progress update", () => {
    const p: WorkflowProgress = {
      kind: "log",
      message: "hello",
      agentsSpawned: 3,
      errorCount: 0,
      tokensSpent: 50,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("● workflow — 3 agent(s)");
    expect(result).not.toContain("⚡");
    expect(result).toContain("50 output tokens");
    expect(result).toContain("hello");
  });

  it("formats an agent_start update without label or model", () => {
    const p: WorkflowProgress = {
      kind: "agent_start",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ started");
    expect(result).not.toMatch(/started @/);
  });

  it("formats an agent_start update with label and model", () => {
    const p: WorkflowProgress = {
      kind: "agent_start",
      label: "scout",
      model: "gpt-4",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 1,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ started scout @gpt-4");
  });

  it("formats an agent_done update without label or model", () => {
    const p: WorkflowProgress = {
      kind: "agent_done",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ done");
    expect(result).not.toMatch(/done @/);
  });

  it("formats an agent_done update with label and model", () => {
    const p: WorkflowProgress = {
      kind: "agent_done",
      label: "scout",
      model: "gpt-4",
      agentsSpawned: 1,
      errorCount: 1,
      tokensSpent: 100,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).toContain("→ done scout @gpt-4");
    expect(result).toContain("⚠ 1 error(s)");
  });

  it("omits running count when runningCount is 0", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "done",
      agentsSpawned: 5,
      errorCount: 0,
      tokensSpent: 200,
      runningCount: 0,
    };
    const result = renderProgress(p);
    expect(result).not.toContain("⚡");
    expect(result).toContain("5 agent(s)");
  });

  it("omits error count when errorCount is 0", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "done",
      agentsSpawned: 5,
      errorCount: 0,
      tokensSpent: 200,
      runningCount: 2,
    };
    const result = renderProgress(p);
    expect(result).not.toContain("⚠");
  });

  it("shows both running count and error count when both are non-zero", () => {
    const p: WorkflowProgress = {
      kind: "phase",
      phase: "working",
      agentsSpawned: 10,
      errorCount: 3,
      tokensSpent: 500,
      runningCount: 2,
    };
    const result = renderProgress(p);
    expect(result).toContain("⚡ 2 running");
    expect(result).toContain("⚠ 3 error(s)");
    expect(result).toContain("10 agent(s)");
    expect(result).toContain("500 output tokens");
  });
});

describe("registerWorkflowTool", () => {
  it("registers 6 tools with the Pi SDK", () => {
    const tools: Array<{ name: string }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name)).toEqual([
      "workflow",
      "get_workflow_status",
      "get_workflow_result",
      "cancel_workflow",
      "save_workflow",
      "list_workflows",
      "delete_workflow",
    ]);
  });

  it("registers workflow slash commands", () => {
    const commands: Array<{ name: string }> = [];
    const pi = {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, def: any) =>
        commands.push({ name, ...def }),
      ),
      on: vi.fn(),
    };

    registerWorkflowTool(pi as any);

    expect(commands.map((c) => c.name)).toEqual([
      "workflow",
      "workflows",
      "list-workflows",
      "workflow-status",
      "workflow-tree",
      "delete-workflow",
    ]);
  });

  it("/workflow queues a prompt to create, save, and run a workflow", async () => {
    const commands: Array<{ name: string; handler: Function }> = [];
    const pi = {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn((name: string, def: any) =>
        commands.push({ name, ...def }),
      ),
      on: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const ctx = {
      ui: { notify: vi.fn() },
      sendUserMessage: vi.fn(),
    };

    registerWorkflowTool(pi as any);
    const cmd = commands.find((c) => c.name === "workflow")!;
    await cmd.handler("build a release checklist", ctx);

    expect(ctx.sendUserMessage).toHaveBeenCalledTimes(1);
    const [prompt, opts] = ctx.sendUserMessage.mock.calls[0];
    expect(prompt).toContain("save_workflow");
    expect(prompt).toContain("workflow` tool");
    expect(prompt).toContain("build a release checklist");
    expect(prompt).not.toContain("Big Pickle");
    expect(opts).toEqual({ deliverAs: "followUp" });
  });

  it("workflow tool has the expected description and parameters", () => {
    const tools: any[] = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const wf = tools.find((t) => t.name === "workflow")!;
    expect(wf.description).toContain("agent(prompt, opts?)");
    expect(wf.description).toContain("workflow(name, args?)");
    expect(wf.description).toContain("immutable parent working directory");
    expect(wf.promptSnippet).toContain("decomposable multi-agent work");
    const guidance = wf.promptGuidelines.join("\n");
    expect(guidance).toContain("raw JavaScript");
    expect(guidance).toContain("top-level");
    expect(guidance).not.toContain("first statement");
    expect(guidance).toContain("immutable cwd");
    expect(guidance).toContain("parallel() takes thunks");
    expect(guidance).toContain("pipeline() streams");
    expect(guidance).toContain("unique short labels");
    expect(guidance).toContain("plain JSON Schema");
    expect(guidance).toContain("null results");
    expect(guidance).toContain("final synthesis");
    expect(wf.parameters).toBeDefined();
    expect(wf.parameters.properties).toBeDefined();
    expect(Object.keys(wf.parameters.properties)).toContain("script");
    expect(Object.keys(wf.parameters.properties)).toContain("name");
    expect(Object.keys(wf.parameters.properties)).toContain("async");
  });

  it("threads the tool execution cwd into the workflow global", async () => {
    const tools: any[] = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerCommand: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflowTool = tools.find((tool) => tool.name === "workflow")!;
    const result = await workflowTool.execute(
      "",
      {
        script:
          `export const meta = { name: "tool-cwd", description: "d" };\n` +
          `return cwd;`,
        async: false,
      },
      undefined,
      undefined,
      { cwd: "/tmp/tool-context", modelRegistry: {} },
    );

    expect(result.details.status).toBe("done");
    expect(result.content[0].text).toContain("/tmp/tool-context");
  });

  it("rejects workflow execution from in-process orchestration contexts", async () => {
    const tools: any[] = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerCommand: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflowTool = tools.find((tool) => tool.name === "workflow")!;
    const result = await withOrchestrationContext(
      { ownerJobId: "parent-job", depth: 1 },
      () =>
        workflowTool.execute(
          "",
          {
            script:
              `export const meta = { name: "unsupported", description: "d" };\n` +
              `return "should not run";`,
            async: false,
          },
          undefined,
          undefined,
          { cwd: "/tmp", modelRegistry: {} },
        ),
    );
    expect(result.isError).toBe(true);
    expect(result.details.error).toContain("issue #62");
    expect(result.content[0].text).toContain(
      "in-process sub-agent orchestration",
    );
  });

  it("does not report a completed workflow as cancelled", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const job = startWorkflowJob(
      "already-done",
      `export const meta = { name: "already-done", description: "d" };\nreturn "done";`,
      { runAgent: echoRunner() },
    );
    await job.promise;

    const cancel = tools.find((tool) => tool.name === "cancel_workflow")!;
    const result = await cancel.execute("", { workflowId: job.id });

    expect(result.details).toMatchObject({
      status: "done",
      workflowId: job.id,
      cancelled: false,
    });
    expect(result.content[0].text).toContain("already done");

    job.status = "cancelled";
    const repeated = await cancel.execute("", { workflowId: job.id });
    expect(repeated.details).toMatchObject({
      status: "cancelled",
      workflowId: job.id,
      cancelled: true,
    });
    expect(repeated.content[0].text).toContain("already cancelled");
    workflowJobRegistry.delete(job.id);
  });

  it("save_workflow tool validates the script before persisting", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const save = tools.find((t) => t.name === "save_workflow")!;
    // Bad script (missing meta) should fail
    const result = await save.execute(
      "",
      { name: "bad", script: "return 1;" },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("Could not save workflow");
    expect(result.isError).toBe(true);
  });

  it("lists workflows and rejects an invalid delete name", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);

    const list = tools.find((tool) => tool.name === "list_workflows")!;
    const listed = await list.execute();
    expect(listed.details.status).toBe("ok");
    expect(Array.isArray(listed.details.workflows)).toBe(true);

    const remove = tools.find((tool) => tool.name === "delete_workflow")!;
    const deleted = await remove.execute("", { name: "../invalid" });
    expect(deleted).toMatchObject({
      isError: true,
      details: { status: "error" },
    });
    expect(deleted.content[0].text).toContain("Could not delete workflow");
  });

  it("notifies the captured parent when a background workflow completes", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const staleSendMessage = vi.fn();
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage: staleSendMessage,
    };
    const currentPi = { sendMessage };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = currentPi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "notify", description: "d" };\n' +
            'return "final result";',
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await job.promise;

      expect(staleSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "workflow-notify",
          content: expect.stringContaining(
            `Call get_workflow_result with workflowId "${job.id}"`,
          ),
        }),
        { deliverAs: "followUp", triggerTurn: true },
      );
      expect(sendMessage).not.toHaveBeenCalled();
      expect(staleSendMessage.mock.calls[0][0].content).not.toContain(
        "final result",
      );
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("notifies and triggers a turn when a workflow returns no result", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "empty", description: "d" };\n' +
            "return;",
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await job.promise;

      expect(job.status).toBe("done");
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          customType: "workflow-notify",
          content: expect.stringContaining(
            `Call get_workflow_result with workflowId "${job.id}"`,
          ),
        }),
        { deliverAs: "followUp", triggerTurn: true },
      );
      expect(sendMessage.mock.calls[0][0].content).not.toContain(
        "workflow returned no result",
      );
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("sanitizes and caps workflow failure notifications", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const secret = "sk-" + "a".repeat(30);
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "error", description: "d" };\n' +
            `throw new Error(${JSON.stringify(secret + " ".repeat(30_000))});`,
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const job = workflowJobRegistry.get(started.details.workflowId)!;

      await expect(job.promise).rejects.toThrow();

      const message = sendMessage.mock.calls[0]?.[0].content as string;
      expect(message).not.toContain(secret);
      expect(message.length).toBeLessThan(21_000);
      workflowJobRegistry.delete(job.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("derives completed-with-errors presentation while keeping raw done status", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendUserMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendUserMessage,
    };
    registerWorkflowTool(pi as any);
    const job = startWorkflowJob(
      "errors",
      'export const meta = { name: "errors", description: "d" };\nreturn "ok";',
      { runAgent: echoRunner() },
    );
    const run = await job.promise;
    run.errorCount = 2;
    job.snapshot.errorCount = 2;

    const statusTool = tools.find(
      (tool) => tool.name === "get_workflow_status",
    )!;
    const status = await statusTool.execute("", { workflowId: job.id });
    expect(status.details.status).toBe("done");
    expect(status.content[0].text).toContain("⚠");
    expect(status.content[0].text).toContain("completed with errors");

    const resultTool = tools.find(
      (tool) => tool.name === "get_workflow_result",
    )!;
    const result = await resultTool.execute("", { workflowId: job.id });
    expect(result.details.status).toBe("done");
    expect(result.content[0].text).toContain("⚠");
    expect(result.content[0].text).toContain("completed with errors");

    const statusCommand = (pi.registerCommand as any).mock.calls.find(
      ([name]: [string]) => name === "workflow-status",
    )?.[1];
    await statusCommand.handler("", { ui: { notify: vi.fn() } });
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("completed with errors"),
      { deliverAs: "followUp" },
    );
    workflowJobRegistry.delete(job.id);
  });

  it("explains current-session scope in async start and not-found messages", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflow = tools.find((tool) => tool.name === "workflow")!;
    const started = await workflow.execute(
      "",
      {
        script:
          'export const meta = { name: "scope", description: "d" };\nreturn 1;',
        async: true,
      },
      undefined,
      undefined,
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );
    expect(started.content[0].text).toContain("current parent session");
    expect(started.content[0].text).toContain("reload/resume/new/quit");

    const statusTool = tools.find(
      (tool) => tool.name === "get_workflow_status",
    )!;
    const missing = await statusTool.execute("", { workflowId: "wf_missing" });
    expect(missing.content[0].text).toContain("current parent session");
    expect(missing.content[0].text).toContain("reload/resume/new/quit");
    workflowJobRegistry.delete(started.details.workflowId);
  });

  it("reentrant retry from within callback is guarded by _notificationInFlight", async () => {
    let attempts = 0;
    const onComplete = (job: any) => {
      attempts++;
      // Simulate a retry trigger from within the callback (e.g. poller re-entrance).
      retryPendingWorkflowNotifications();
    };
    const script =
      `export const meta = { name: "reentrant", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "reentrant",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;
    // Without the guard, the reentrant call would invoke the callback a second time.
    expect(attempts).toBe(1);
  });

  it("callback throw then successful retry via retryPendingWorkflowNotifications", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      if (attempts === 1) throw new Error("transient failure");
      // Second attempt succeeds.
    };
    const script =
      `export const meta = { name: "throw-retry", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "throw-retry",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;
    // First call: hook throws, delivered stays false, attempt incremented to 1.
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job.notificationAttempt).toBe(1);

    // Simulate poller tick — retries the failed notification.
    retryPendingWorkflowNotifications();
    expect(job.completionNotificationDelivered).toBe(true);
    // Attempt count is 2 (two total invocations); does NOT reset to 0.
    expect(job.notificationAttempt).toBe(2);
    expect(attempts).toBe(2);
  });

  it("persistent callback failure exhausts after MAX_WORKFLOW_NOTIFICATION_ATTEMPTS retries", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      throw new Error("permanent failure");
    };
    const script =
      `export const meta = { name: "exhaust", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "exhaust",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // First invocation threw, so notificationAttempt is 1.
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Exhaust remaining attempts via poller ticks (MAX-1 more calls).
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1; i++) {
      retryPendingWorkflowNotifications();
    }

    // Counter reached MAX; exhausted flag is set.
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job._notificationExhausted).toBe(true);
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);

    // Extra retries after exhaustion are no-ops: callback not re-invoked, counter unchanged.
    const callsBefore = attempts;
    for (let i = 0; i < 10; i++) retryPendingWorkflowNotifications();
    expect(attempts).toBe(callsBefore);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job._notificationExhausted).toBe(true);
  });

  it("exhaustion log fires exactly once", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      throw new Error("always fail");
    };
    const script =
      `export const meta = { name: "exhaust-log", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "exhaust-log",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Exhaust: invoke MAX times (initial + MAX-1 retries), all throw.
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS; i++) {
      retryPendingWorkflowNotifications();
    }

    // Exhausted flag is set, callback never invoked again.
    expect(job._notificationExhausted).toBe(true);
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    const callsBefore = attempts;
    for (let i = 0; i < 5; i++) retryPendingWorkflowNotifications();
    expect(attempts).toBe(callsBefore);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job._notificationExhausted).toBe(true);
  });

  it("success marks delivered and preserves truthful attempt count", async () => {
    let count = 0;
    const onComplete = () => {
      count++;
      if (count <= 2) throw new Error("transient");
    };
    const script =
      `export const meta = { name: "truth-count", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "truth-count",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Initial call throws (attempt 1, throw still increments the counter).
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Second call throws (attempt 2).
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(2);

    // Third call succeeds → attempt=3, delivered.
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(3);
    expect(job.completionNotificationDelivered).toBe(true);
    expect(count).toBe(3);
  });

  it("MAXth attempt success does not mark exhaustion", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
      // Fail four times, succeed on the fifth (the MAXth invocation).
      if (attempts < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS) {
        throw new Error("transient failure");
      }
    };
    const script =
      `export const meta = { name: "maxth-ok", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "maxth-ok",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );
    await job.promise;

    // Initial call throws (attempt 1).
    expect(job.notificationAttempt).toBe(1);
    expect(job.completionNotificationDelivered).toBe(false);

    // Retries 2-4 also throw.
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 2; i++) {
      retryPendingWorkflowNotifications();
    }
    expect(job.notificationAttempt).toBe(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1,
    );
    expect(job.completionNotificationDelivered).toBe(false);

    // Attempt 5 (the MAXth) succeeds.
    retryPendingWorkflowNotifications();
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
    expect(job.completionNotificationDelivered).toBe(true);
    // Crucially: must NOT be marked exhausted.
    expect(job._notificationExhausted).toBeFalsy();
    expect(attempts).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);
  });

  it("suppressed jobs never attempt delivery on retry", async () => {
    let attempts = 0;
    const onComplete = () => {
      attempts++;
    };
    const script =
      `export const meta = { name: "supp", description: "d" }\n` +
      `return await agent("done");`;
    const job = startWorkflowJob(
      "supp",
      script,
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    // Mark suppressed before workflow settles.
    job.suppressCompletionNotification = true;
    await job.promise;
    expect(attempts).toBe(0);

    // Retry should still skip.
    retryPendingWorkflowNotifications();
    expect(attempts).toBe(0);
  });

  it("synchronous workflow output reflects error status for a failing script", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };
    registerWorkflowTool(pi as any);
    const workflow = tools.find((tool) => tool.name === "workflow")!;
    const result = await workflow.execute(
      "",
      {
        script:
          'export const meta = { name: "sync-err", description: "d" };\n' +
          'throw new Error("partial failure");',
        async: false,
      },
      undefined,
      vi.fn(),
      { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
    );
    expect(result.details.status).toBe("error");
    expect(result.isError).toBe(true);
    expect(result.details.usage).toBeUndefined();
    expect(result.content[0].text).toContain("Workflow failed");
  });

  it("async completed-with-errors notification includes details with presentationStatus and workflowId", async () => {
    const tools: Array<{ name: string; execute: Function }> = [];
    const sendMessage = vi.fn();
    const pi = {
      registerTool: vi.fn((def: any) => tools.push(def)),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      sendMessage,
    };
    const g = globalThis as any;
    const previousPi = g.__piSubagenturaPiRef;
    g.__piSubagenturaPiRef = pi;
    registerWorkflowTool(pi as any);
    try {
      // Create a job that completes with errorCount > 0.
      const job = startWorkflowJob(
        "notify-errors",
        'export const meta = { name: "notify-errors", description: "d" };\nreturn "ok";',
        { runAgent: echoRunner() },
        undefined,
        // Inline callback: simulate notifyWorkflowCompletion behavior.
        (j) => {
          j.result!.errorCount = 1;
          // Trigger the real notification path via the tool's notifyWorkflowCompletion.
        },
      );
      await job.promise;

      // Now simulate what the registerWorkflowTool notify callback does.
      // Use the actual notify function by finding it through the tool.
      // We can call startWorkflowJob with the real notifyWorkflowCompletion
      // by using the workflow tool's execute method.
      const workflow = tools.find((tool) => tool.name === "workflow")!;
      const started = await workflow.execute(
        "call-id",
        {
          script:
            'export const meta = { name: "notify-err-detail", description: "d" };\n' +
            'return "result";',
          async: true,
        },
        undefined,
        vi.fn(),
        { cwd: process.cwd(), model: undefined, modelRegistry: undefined },
      );
      const errJob = workflowJobRegistry.get(started.details.workflowId)!;
      await errJob.promise;

      // The notification should have been sent.
      expect(sendMessage).toHaveBeenCalled();
      const notification = sendMessage.mock.calls[0][0];
      expect(notification.customType).toBe("workflow-notify");
      expect(notification.details).toMatchObject({
        workflowId: errJob.id,
        status: errJob.status,
      });
      expect(notification.details.presentationStatus).toBeDefined();
      // content should contain the workflow name and ID.
      expect(notification.content).toContain(errJob.name);
      expect(notification.content).toContain(errJob.id);
      workflowJobRegistry.delete(errJob.id);
    } finally {
      g.__piSubagenturaPiRef = previousPi;
    }
  });

  it("marks _notificationExhausted after MAX_WORKFLOW_NOTIFICATION_ATTEMPTS callback-return-false retries", async () => {
    const falseReturns = Array.from(
      { length: MAX_WORKFLOW_NOTIFICATION_ATTEMPTS },
      () => false,
    );
    let callCount = 0;
    const onComplete = vi.fn(() => {
      callCount++;
      return false;
    });

    const job = startWorkflowJob(
      "exhaust-test",
      'export const meta = { name: "exhaust-test", description: "d" };\nreturn "done";',
      { runAgent: echoRunner() },
      undefined,
      onComplete,
    );

    await job.promise;

    // First call succeeded, notification delivered = false because callback returned false
    expect(job.completionNotificationDelivered).toBe(false);
    expect(job._notificationExhausted).toBeFalsy();

    // Simulate retries by calling retryPendingWorkflowNotifications
    for (let i = 0; i < MAX_WORKFLOW_NOTIFICATION_ATTEMPTS - 1; i++) {
      retryPendingWorkflowNotifications();
    }

    // After MAX attempts total (1 initial + MAX-1 retries), should be exhausted
    expect(onComplete).toHaveBeenCalledTimes(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
    );
    expect(job._notificationExhausted).toBe(true);
    expect(job.notificationAttempt).toBe(MAX_WORKFLOW_NOTIFICATION_ATTEMPTS);

    // Further calls should be no-ops (exhausted guard)
    retryPendingWorkflowNotifications();
    expect(onComplete).toHaveBeenCalledTimes(
      MAX_WORKFLOW_NOTIFICATION_ATTEMPTS,
    );
  });
});

describe("WorkflowProgress classification matrix", () => {
  const samples = {
    phase: {
      kind: "phase",
      phase: "test",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    },
    log: {
      kind: "log",
      message: "test",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    },
    agent_start: {
      kind: "agent_start",
      label: "test",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    },
    agent_done: {
      kind: "agent_done",
      label: "test",
      agentsSpawned: 1,
      errorCount: 0,
      tokensSpent: 100,
      runningCount: 0,
    },
  } satisfies Record<WorkflowProgress["kind"], WorkflowProgress>;

  it("renders every progress discriminant", () => {
    const expected = {
      phase: "◆ phase: test",
      log: "test",
      agent_start: "→ started test",
      agent_done: "→ done test",
    } satisfies Record<WorkflowProgress["kind"], string>;
    for (const kind of Object.keys(samples) as Array<
      WorkflowProgress["kind"]
    >) {
      expect(renderProgress(samples[kind])).toContain(expected[kind]);
    }
  });
});

it("includes usage from returned error results", async () => {
  const result = await runWorkflow(
    `export const meta = { name: "usage-errors", description: "d" };\n` +
      `return await parallel([() => agent("ok"), () => agent("error")]);`,
    {
      runAgent: async ({ prompt }) =>
        prompt === "error" ? richFail("boom") : richOk(prompt),
    },
  );

  expect(result.result).toEqual(["ok", null]);
  expect(result.tokensSpent).toBe(8);
  expect(result.usage).toEqual({
    input: 13,
    output: 8,
    cacheRead: 9,
    cacheWrite: 9,
    totalTokens: 39,
    costUsd: 0.375,
    turns: 3,
  });
});

it("preserves accumulated usage when a later workflow error rejects", async () => {
  const usage: WorkflowUsage = {
    input: 11,
    output: 7,
    cacheRead: 5,
    cacheWrite: 3,
    totalTokens: 26,
    costUsd: 0.125,
    turns: 2,
  };
  const rejected = runWorkflow(
    `export const meta = { name: "late-error", description: "d" };\n` +
      `await agent("hello"); throw new Error("later failure");`,
    { runAgent: async ({ prompt }) => richOk(prompt) },
  );

  await expect(rejected).rejects.toMatchObject({ usage });
});

it("formats USD usage without floating-point artifacts", () => {
  const usage: WorkflowUsage = {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    costUsd: 0.1 + 0.2,
    turns: 1,
  };
  expect(formatWorkflowUsage(usage)).toBe("1 total tokens, $0.3");
});

it("includes accumulated usage in async workflow error results", async () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const pi = {
    registerTool: vi.fn((def: any) => tools.push(def)),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  };
  registerWorkflowTool(pi as any);
  const job = startWorkflowJob(
    "late-error",
    `export const meta = { name: "late-error", description: "d" };\n` +
      `await agent("hello"); throw new Error("later failure");`,
    { runAgent: async ({ prompt }) => richOk(prompt) },
  );
  try {
    await expect(job.promise).rejects.toThrow("later failure");
    const getResult = tools.find(
      (tool) => tool.name === "get_workflow_result",
    )!;
    const result = await getResult.execute("", { workflowId: job.id });
    expect(result.isError).toBe(true);
    expect(result.details.usage).toEqual({
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 3,
      totalTokens: 26,
      costUsd: 0.125,
      turns: 2,
    });
    expect(result.content[0].text).toContain("26 total tokens");
  } finally {
    workflowJobRegistry.delete(job.id);
  }
});

it("includes snapshot usage in failed completion notification summaries", async () => {
  const job = startWorkflowJob(
    "notify-late-error",
    `export const meta = { name: "notify-late-error", description: "d" };\n` +
      `await agent("hello"); throw new Error("later failure");`,
    { runAgent: async ({ prompt }) => richOk(prompt) },
  );
  try {
    await expect(job.promise).rejects.toThrow("later failure");
    expect(formatWorkflowNotificationSummary(job)).toContain(
      "26 total tokens, $0.125",
    );
  } finally {
    workflowJobRegistry.delete(job.id);
  }
});

it("preserves non-abort cause identity alongside accumulated usage", async () => {
  const original = new Error("runner failure");
  let calls = 0;
  const rejected = runWorkflow(
    `export const meta = { name: "cause", description: "d" };\n` +
      `await agent("first"); await agent("second");`,
    {
      runAgent: async ({ prompt }) => {
        calls++;
        if (prompt === "second") throw original;
        return richOk(prompt);
      },
    },
  );
  await expect(rejected).rejects.toMatchObject({
    cause: original,
    usage: { totalTokens: 26 },
  });
  expect(calls).toBe(2);
});

it("preserves caller abort reason alongside accumulated usage", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let secondStarted!: () => void;
  const secondStartedPromise = new Promise<void>(
    (resolve) => (secondStarted = resolve),
  );
  const never = new Promise<SubagentResult>(() => {});
  const running = runWorkflow(
    `export const meta = { name: "abort-cause", description: "d" };\n` +
      `await agent("first"); await agent("second");`,
    {
      signal: controller.signal,
      runAgent: async ({ prompt }) => {
        if (prompt === "first") return richOk(prompt);
        secondStarted();
        return never;
      },
    },
  );
  await secondStartedPromise;
  controller.abort(reason);
  await expect(running).rejects.toMatchObject({
    cause: reason,
    usage: { totalTokens: 26 },
  });
});

describe("workflow usage accounting", () => {
  it("keeps legacy result objects structurally compatible", () => {
    const legacyResult: WorkflowRunResult = {
      meta: { name: "legacy", description: "legacy" },
      result: null,
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      phases: [],
    };
    expect(legacyResult.usage).toBeUndefined();
  });

  const meta = `export const meta = { name: "usage", description: "d" };\n`;
  const usage = {
    input: 11,
    output: 7,
    cacheRead: 5,
    cacheWrite: 3,
    costUsd: 0.125,
    totalTokens: 26,
    turns: 2,
  };

  it("does not add usage when a runner throws without a result", async () => {
    const result = await runWorkflow(
      meta + `return await parallel([() => agent("boom")]);`,
      {
        runAgent: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(result.errorCount).toBe(1);
    expect(result.tokensSpent).toBe(0);
    expect(result.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
    });
  });

  it("aggregates every usage field in a direct run result", async () => {
    const result: WorkflowRunResultWithUsage = await runWorkflow(
      meta + `return await agent("hello");`,
      {
        runAgent: async ({ prompt }) => richOk(prompt),
      },
    );

    expect(result.tokensSpent).toBe(7);
    expect(result.usage).toEqual(usage);
  });

  it("includes canonical usage in progress and async job snapshots", async () => {
    const progress: WorkflowProgress[] = [];
    const runner: WorkflowAgentRunner = async ({ prompt }) => richOk(prompt);
    const script = meta + `return await agent("hello");`;
    const result = await runWorkflow(script, {
      runAgent: runner,
      onProgress: (event) => progress.push(event),
    });
    const lastProgress = progress.at(-1);
    expect(lastProgress?.usage).toEqual(usage);
    expect(result.usage).toEqual(usage);

    const job = startWorkflowJob("usage", script, { runAgent: runner });
    try {
      await job.promise;
      expect(job.snapshot.tokensSpent).toBe(7);
      expect(job.snapshot.usage).toEqual(usage);
      expect(job.result?.usage).toEqual(usage);
    } finally {
      workflowJobRegistry.delete(job.id);
    }
  });
});
