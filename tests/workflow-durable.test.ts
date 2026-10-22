import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, appendFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DurableWorkflow } from "../src/workflow-durable";
import {
  WorkflowRunStore,
  encodeRunValue,
  decodeRunValue,
  runValueMatches,
  type RunScope,
} from "../src/workflow-run-store";
import { runWorkflow } from "../src/workflow-worker";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { prepareDurableProcess } from "../src/workflow-durable-process";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

const roots: string[] = [];
const stores: WorkflowRunStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const script = (body: string) =>
  `export const meta = {name:"durable",description:"test"}; ${body}`;
const ok = (output: string) => ({
  isError: false as const,
  output,
  usage: { ...zeroUsage(), output: 7 },
});

async function fixture(body: string, budgetTotal = 1000) {
  const root = await mkdtemp(join(tmpdir(), "workflow-durable-"));
  roots.push(root);
  const scope: RunScope = { root, cwd: root, sessionId: "parent" };
  const source = script(body);
  const store = await WorkflowRunStore.create(scope, {
    script: source,
    args: encodeRunValue({ input: 1 }),
    budgetTotal,
  });
  stores.push(store);
  return { scope, source, store };
}

async function execute(
  store: WorkflowRunStore,
  runAgent: WorkflowAgentRunner,
  extra: object = {},
) {
  const durable = new DurableWorkflow(store);
  try {
    return await runWorkflow(store.events[0].data.script, {
      args: decodeRunValue(store.events[0].data.args),
      cwd: store.events[0].data.cwd,
      budgetTotal: store.events[0].data.budgetTotal,
      durable,
      runAgent,
      ...extra,
    });
  } finally {
    durable.stop();
    await durable.drain();
  }
}

describe("durable workflow journal", () => {
  it("compares replay values independently of V8's numeric encoding while retaining iteration order", () => {
    const integer = encodeRunValue({ n: 1 });
    const floating = Buffer.from(
      Buffer.from(integer, "base64")
        .toString("hex")
        .replace("4902", "4e000000000000f03f"),
      "hex",
    ).toString("base64");
    expect(decodeRunValue(floating)).toEqual({ n: 1 });
    expect(runValueMatches(floating, { n: 1 })).toBe(true);
    expect(
      runValueMatches(encodeRunValue({ a: 1, b: 2 }), { b: 2, a: 1 }),
    ).toBe(false);
    expect(
      runValueMatches(
        encodeRunValue(
          new Map([
            ["a", 1],
            ["b", 2],
          ]),
        ),
        new Map([
          ["b", 2],
          ["a", 1],
        ]),
      ),
    ).toBe(false);
    const shared = {};
    expect(runValueMatches(encodeRunValue([shared, shared]), [{}, {}])).toBe(
      false,
    );
  });
  it("checks the lifetime budget before redispatching interrupted in-process work", async () => {
    const { store } = await fixture('return "ok";', 7);
    const durable = new DurableWorkflow(store);
    const abort = new AbortController();
    const request = { prompt: "work", isolation: "in-process" };
    await expect(
      durable.runAttempt(
        1,
        1,
        { ...request, signal: abort.signal },
        async () => {
          abort.abort();
          return ok("unknown outcome");
        },
      ),
    ).rejects.toThrow("interrupted");
    await durable.runAttempt(2, 1, request, async () => ok("spent"));
    const runner = vi.fn(async () => ok("must not launch"));
    await expect(durable.runAttempt(1, 1, request, runner)).rejects.toThrow(
      "budget exhausted",
    );
    expect(runner).not.toHaveBeenCalled();
  });
  it("binds durable attempts to read-only mode without splitting default identity", async () => {
    const { store } = await fixture('return "ok";');
    const durable = new DurableWorkflow(store);
    const restricted = vi.fn(
      async (request: Parameters<WorkflowAgentRunner>[0]) => {
        expect(request.durableAttempt?.readOnly).toBe(true);
        return ok("restricted");
      },
    );
    const request = {
      prompt: "same request",
      isolation: "in-process",
      readOnly: true,
    };
    await expect(
      durable.runAttempt("capability", 0, request, restricted),
    ).resolves.toEqual(ok("restricted"));
    expect(restricted).toHaveBeenCalledTimes(1);

    const forbiddenReuse = vi.fn(async () => ok("unrestricted"));
    await expect(
      durable.runAttempt(
        "capability",
        0,
        { ...request, readOnly: false },
        forbiddenReuse,
      ),
    ).rejects.toThrow("configuration changed");
    expect(forbiddenReuse).not.toHaveBeenCalled();

    const defaults = { prompt: "default", isolation: "in-process" };
    await durable.runAttempt("default", 0, defaults, async () => ok("default"));
    const defaultReuse = vi.fn(async () => ok("must not run"));
    await expect(
      durable.runAttempt(
        "default",
        0,
        { ...defaults, readOnly: false },
        defaultReuse,
      ),
    ).resolves.toEqual(ok("default"));
    expect(defaultReuse).not.toHaveBeenCalled();
  });
  it("replays durable request identity with false and omitted read-only canonicalized", async () => {
    const { store } = await fixture('return "ok";');
    const exchange = (
      durable: DurableWorkflow,
      readOnly: boolean | undefined,
      execute: () => Promise<{
        id: number;
        ok: boolean;
        value: string;
        tokensDelta: number;
      }>,
    ) =>
      new Promise<unknown>((resolve, reject) => {
        durable.bind((value) => {
          if (
            value &&
            typeof value === "object" &&
            "type" in value &&
            value.type === "response_offer" &&
            "id" in value &&
            typeof value.id === "number"
          ) {
            durable.acceptResponse(value.id, 1);
            return;
          }
          resolve(value);
        }, reject);
        durable.dispatch(
          {
            id: 1,
            method: "agent",
            payload: {
              operationPath: ["review"],
              opts: {
                prompt: "Review",
                ...(readOnly === undefined ? {} : { readOnly }),
              },
            },
          },
          execute,
        );
      });
    const first = new DurableWorkflow(store);
    const execute = vi.fn(async () => ({
      id: 1,
      ok: true,
      value: "recorded result",
      tokensDelta: 0,
    }));
    await expect(exchange(first, false, execute)).resolves.toEqual({
      id: 1,
      ok: true,
      value: "recorded result",
      tokensDelta: 0,
    });
    const recordedRequest = store.events.find(
      (event) => event.kind === "request",
    );
    expect(
      recordedRequest?.kind === "request"
        ? decodeRunValue(recordedRequest.data.payload)
        : undefined,
    ).toEqual({
      operationPath: ["review"],
      opts: { prompt: "Review" },
    });
    first.stop();
    await first.drain();

    const recovered = new DurableWorkflow(store);
    const forbiddenRedispatch = vi.fn(async () => ({
      id: 1,
      ok: true,
      value: "must not execute",
      tokensDelta: 0,
    }));
    await expect(
      exchange(recovered, undefined, forbiddenRedispatch),
    ).resolves.toEqual({
      id: 1,
      ok: true,
      value: "recorded result",
      tokensDelta: 0,
    });
    expect(forbiddenRedispatch).not.toHaveBeenCalled();
    recovered.stop();
    await recovered.drain();
  });
  it("runs a durable V4 read-only agent through its hashed process attempt path", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-v4-process-"));
    roots.push(root);
    const source = `
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "durable-read-only",
        version: 1,
        async run(ctx) {
          return await ctx.agent("review", {
            prompt: "Review source",
            readOnly: true,
          });
        },
      });
    `;
    const scope: RunScope = { root, cwd: root, sessionId: "durable-v4" };
    const store = await WorkflowRunStore.create(scope, {
      script: source,
      args: encodeRunValue(undefined),
      budgetTotal: 1000,
    });
    stores.push(store);

    const runAgent: WorkflowAgentRunner = async (request) => {
      const attemptContext = request.durableAttempt;
      if (!attemptContext)
        throw new Error("V4 process agent has no durable attempt identity.");
      expect(request.readOnly).toBe(true);
      expect(attemptContext.readOnly).toBe(true);
      const attempt = await prepareDurableProcess(attemptContext);
      await attemptContext.recordDispatch?.();
      attempt.beforeDispatch({
        id: "durable-v4-review",
        artifactDir: root,
        paneId: "durable-v4-pane",
        mux: "tmux",
        sessionFile: join(root, "session.jsonl"),
        task: request.prompt,
      } as InteractiveSubagentState);
      const child = spawn("bash", ["-c", attempt.wrapCommand("true")], {
        stdio: "ignore",
      });
      const exitCode = await new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      if (exitCode !== 0)
        throw new Error(`Durable process exited with ${exitCode}.`);
      return ok("reviewed");
    };
    const result = await execute(store, runAgent);
    expect(result.result).toBe("reviewed");
    expect(result.agentsSpawned).toBe(1);
  });

  it("recovers after SIGKILL of a separate controller without rerunning committed work", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-crash-"));
    roots.push(root);
    const scope = { root, cwd: root, sessionId: "crash-parent" };
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const source = script(
      'const next = await agent("first", {id:"first",isolation:"in-process"}); return await agent(next, {id:"second",isolation:"in-process"});',
    );
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const sdkRequire = createRequire(
      join(repo, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    );
    const child = spawn(
      process.execPath,
      [
        "--eval",
        `(async () => {
      const {createJiti} = require(${JSON.stringify(sdkRequire.resolve("jiti"))});
      const jiti = createJiti(${JSON.stringify(join(repo, "crash-test.cjs"))});
      const {WorkflowRunStore,encodeRunValue} = await jiti.import(${JSON.stringify(join(src, "workflow-run-store.ts"))});
      const {DurableWorkflow} = await jiti.import(${JSON.stringify(join(src, "workflow-durable.ts"))});
      const {runWorkflow} = await jiti.import(${JSON.stringify(join(src, "workflow-worker.ts"))});
      const store = await WorkflowRunStore.create(${JSON.stringify(scope)}, {script:${JSON.stringify(source)},args:encodeRunValue(undefined),budgetTotal:1000});
      await runWorkflow(${JSON.stringify(source)}, {cwd:${JSON.stringify(root)},budgetTotal:1000,durable:new DurableWorkflow(store),runAgent:async ({prompt}) => {
        if (prompt === "first") return {isError:false,output:"second",usage:{input:0,output:7,cacheRead:0,cacheWrite:0,cost:0,turns:1}};
        process.send({id:store.id});
        return new Promise(() => {});
      }});
    })().catch(error => {process.stderr.write(String(error.stack));process.exit(1);});
    `,
      ],
      { cwd: repo, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr!.on("data", (data) => {
      stderr += data.toString();
    });
    const exit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const childDiagnostic = (message: string) =>
      `${message}${stderr.trim() ? `\nChild stderr:\n${stderr.trim()}` : ""}`;
    try {
      const id = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
        // This child crosses a real process/IPC boundary, so fake timers cannot
        // bound startup; keep the wall-clock deadline explicit and fail loudly.
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                childDiagnostic(
                  "Crash fixture did not reach its IPC boundary within 10 seconds.",
                ),
              ),
            ),
          10_000,
        );
        child.once("message", (message: unknown) => {
          if (
            !message ||
            typeof message !== "object" ||
            !("id" in message) ||
            typeof message.id !== "string"
          ) {
            fail(
              new Error(
                childDiagnostic("Crash fixture sent an invalid IPC boundary."),
              ),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(message.id);
        });
        child.once("close", (code, signal) => {
          fail(
            new Error(
              childDiagnostic(
                `Child closed before crash boundary (code ${code}, signal ${signal}).`,
              ),
            ),
          );
        });
        child.once("error", (error) => {
          fail(
            new Error(
              childDiagnostic(
                `Crash fixture failed to start: ${error.message}`,
              ),
            ),
          );
        });
      });
      expect(child.kill("SIGKILL")).toBe(true);
      const termination = await exit;
      expect(termination.signal).toBe("SIGKILL");
      const reopened = await WorkflowRunStore.resume(scope, id);
      stores.push(reopened);
      const runner = vi.fn(async ({ prompt }) => ok(prompt + " resumed"));
      const result = await execute(reopened, runner);
      expect(result.result).toBe("second resumed");
      expect(result.usage.output).toBe(14);
      expect(result.agentsSpawned).toBe(3);
      expect(runner).toHaveBeenCalledTimes(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exit;
    }
  });

  it("preserves failed-call accounting when replaying a partial result", async () => {
    const { scope, store } = await fixture(
      'return await parallel([() => agent("fail", {id:"fail"})]);',
    );
    const first = await execute(store, async () => ({
      isError: true,
      output: "",
      errorMessage: "failed",
      usage: zeroUsage(),
    }));
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    expect(await execute(reopened, vi.fn())).toEqual(first);
  });

  it("drains an unawaited nested workflow before completing the root", async () => {
    const { store } = await fixture(
      'workflow("child", undefined, {id:"nested"}); return "root";',
    );
    const runner = vi.fn(async () => ok("child"));
    const result = await execute(store, runner, {
      loadWorkflow: () =>
        script('await agent("child", {id:"one"}); return "child";'),
    });
    expect(result.result).toBe("root");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("replays completed calls without another agent invocation or double billing", async () => {
    const { scope, store } = await fixture(
      'return await agent("one", {id:"one", isolation:"in-process"});',
    );
    const runAgent = vi.fn(async () => ok("result"));
    const first = await execute(store, runAgent);
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const second = await execute(reopened, runAgent);
    expect(second).toEqual(first);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("resumes a sequential pipeline from its interrupted boundary", async () => {
    const { scope, store } = await fixture(
      'const a = await agent("one", {id:"one"}); return await agent(a, {id:"two"});',
    );
    const abort = new AbortController();
    let calls = 0;
    await expect(
      execute(
        store,
        async () => {
          if (++calls === 2) {
            abort.abort();
            throw new Error("interrupted");
          }
          return ok("first");
        },
        { signal: abort.signal },
      ),
    ).rejects.toThrow();
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const next = vi.fn(async ({ prompt }) => ok(prompt + " second"));
    expect((await execute(reopened, next)).result).toBe("first second");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("replays out-of-order fan-out, Promise.race, pipelines, and budget observations", async () => {
    const { scope, store } = await fixture(`
      const work = args.items.map(id => agent(id, {id}));
      const first = await Promise.race(work);
      const spent = budget.spent();
      const all = await Promise.all(work);
      const next = await pipeline(all, (x, _, i) => agent(x, {id:"stage/"+i}));
      return {first, spent, all, next};
    `);
    const args = { items: ["slow", "fast"] };
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const runAgent = vi.fn(async ({ prompt }) => {
      if (prompt === "slow") await slow;
      else setImmediate(releaseSlow);
      return ok(prompt);
    });
    const first = await execute(store, runAgent, { args });
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const second = await execute(reopened, vi.fn(), { args });
    expect(second).toEqual(first);
    expect(first.result).toMatchObject({ first: "fast", spent: 7 });
  });

  it("snapshots computed nested names and keeps a single response stream", async () => {
    const { scope, store } = await fixture(
      'return await workflow("child-"+args.input, {x:1}, {id:"nested"});',
    );
    const loadWorkflow = vi.fn(() =>
      script('return await agent("nested", {id:"child-agent"});'),
    );
    const first = await execute(store, async () => ok("nested result"), {
      loadWorkflow,
    });
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    expect(
      await execute(reopened, vi.fn(), {
        loadWorkflow: () => {
          throw new Error("definition edited");
        },
      }),
    ).toEqual(first);
    expect(loadWorkflow).toHaveBeenCalledTimes(1);
  });

  it("fails closed outside script catches and parallel's null conversion", async () => {
    const { store } = await fixture(
      'return await parallel([() => agent("missing id")]);',
    );
    const runAgent = vi.fn();
    await expect(execute(store, runAgent)).rejects.toThrow("stable");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects duplicate ids and changed requests before launching new work", async () => {
    const { store } = await fixture(
      'try { await agent("a", {id:"same"}); return await agent("b", {id:"same"}); } catch { return "hidden"; }',
    );
    const runAgent = vi.fn(async () => ok("ok"));
    await expect(execute(store, runAgent)).rejects.toThrow("duplicate");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("locks out concurrent controllers and isolates parent sessions", async () => {
    const { scope, store } = await fixture("return 1;");
    await expect(WorkflowRunStore.resume(scope, store.id)).rejects.toThrow(
      "live controller",
    );
    expect(
      await WorkflowRunStore.inspect(
        { ...scope, sessionId: "other" },
        store.id,
      ),
    ).toBeUndefined();
    expect(await WorkflowRunStore.inspect(scope, "../outside")).toBeUndefined();
  });

  it("repairs only torn final lines, never complete corrupt records", async () => {
    const { scope, store } = await fixture("return 1;");
    await store.close();
    const path = join(store.directory, "journal.ndjson");
    await appendFile(path, '{"torn":');
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    await reopened.close();
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    await appendFile(path, '{"corrupt":true}\n');
    await expect(WorkflowRunStore.resume(scope, store.id)).rejects.toThrow(
      "corrupt",
    );
  });
});
