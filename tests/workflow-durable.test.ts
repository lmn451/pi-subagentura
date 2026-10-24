import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  appendFile,
  readFile,
  writeFile,
  open,
  readdir,
} from "node:fs/promises";
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
import {
  WorkflowFailureError,
  workflowFailureClassification,
  type WorkflowAgentRunner,
} from "../src/workflow-core";

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
  it("does not expose a run before newly created store directories are synced", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-store-sync-"));
    roots.push(root);
    const scope = { root, cwd: root, sessionId: "fresh-parent" };
    const handle = await open(root, "r");
    const syncSpy = vi.spyOn(Object.getPrototypeOf(handle), "sync");
    syncSpy.mockRejectedValueOnce(new Error("injected directory sync failure"));
    try {
      await expect(
        WorkflowRunStore.create(scope, {
          script: script('return "unused";'),
          args: encodeRunValue(undefined),
          budgetTotal: 100,
        }),
      ).rejects.toThrow("directory sync failure");
      expect(await readdir(join(root, "v1"))).toHaveLength(0);
    } finally {
      syncSpy.mockRestore();
      await handle.close();
    }

    const retry = await WorkflowRunStore.create(scope, {
      script: script('return "unused";'),
      args: encodeRunValue(undefined),
      budgetTotal: 100,
    });
    stores.push(retry);
    expect(await WorkflowRunStore.list(scope)).toEqual([retry.id]);
    await retry.close();
  });

  it("retries a real append failure after confirming no bytes were written", async () => {
    const { scope, store } = await fixture("return 1;");
    const path = join(store.directory, "journal.ndjson");
    const before = await readFile(path);
    const file = (
      store as unknown as {
        file: import("node:fs/promises").FileHandle;
      }
    ).file;
    const write = file.writeFile.bind(file);
    let fail = true;
    vi.spyOn(file, "writeFile").mockImplementation(async (data) => {
      if (fail) {
        fail = false;
        throw new Error("injected write failure before bytes");
      }
      return write(data);
    });
    const data = { status: "cancelled", completedAt: 1 };
    await expect(store.append("cancelled", data)).rejects.toThrow(
      "injected write failure",
    );
    expect(await readFile(path)).toEqual(before);
    await expect(store.append("cancelled", data)).resolves.toBeUndefined();
    expect(
      store.events.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);
    expect(
      (await WorkflowRunStore.inspect(scope, store.id))?.at(-1)?.data,
    ).toEqual(data);
  });

  it("reconciles a complete real append after fsync fails without duplicating it", async () => {
    const { scope, store } = await fixture("return 1;");
    const file = (
      store as unknown as {
        file: import("node:fs/promises").FileHandle;
      }
    ).file;
    const sync = file.sync.bind(file);
    let fail = true;
    vi.spyOn(file, "sync").mockImplementation(async () => {
      if (fail) {
        fail = false;
        throw new Error("injected fsync failure");
      }
      return sync();
    });
    const data = { status: "cancelled", completedAt: 2 };
    await expect(store.append("cancelled", data)).rejects.toThrow("fsync");
    await expect(store.append("cancelled", data)).resolves.toBeUndefined();
    expect(
      store.events.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);
    expect(
      (await WorkflowRunStore.inspect(scope, store.id))?.filter(
        (event) => event.kind === "cancelled",
      ),
    ).toHaveLength(1);
  });

  it("resumes a complete append after failed fsync and confirms it is durable once", async () => {
    const { scope, store } = await fixture("return 1;");
    const file = (
      store as unknown as {
        file: import("node:fs/promises").FileHandle;
      }
    ).file;
    vi.spyOn(file, "sync").mockRejectedValueOnce(
      new Error("injected fsync failure"),
    );
    await expect(
      store.append("cancelled", { status: "cancelled" }),
    ).rejects.toThrow("fsync");
    const path = join(store.directory, "journal.ndjson");
    const committedBytes = await readFile(path);
    stores.splice(stores.indexOf(store), 1);
    await expect(store.close()).rejects.toThrow("fsync");

    const reopened = await WorkflowRunStore.resume(scope, store.id);
    expect(
      reopened.events.filter((event) => event.kind === "cancelled"),
    ).toHaveLength(1);
    await reopened.close();
    expect(await readFile(path)).toEqual(committedBytes);
    expect(
      (await WorkflowRunStore.inspect(scope, store.id))?.filter(
        (event) => event.kind === "cancelled",
      ),
    ).toHaveLength(1);
  });

  it("blocks a partial real append and preserves its bytes", async () => {
    const { scope, store } = await fixture("return 1;");
    const path = join(store.directory, "journal.ndjson");
    const before = await readFile(path);
    const file = (
      store as unknown as {
        file: import("node:fs/promises").FileHandle;
      }
    ).file;
    const write = file.writeFile.bind(file);
    vi.spyOn(file, "writeFile").mockImplementation(async (data) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
      await write(bytes.subarray(0, Math.floor(bytes.length / 2)));
      throw new Error("injected partial write");
    });
    await expect(
      store.append("cancelled", { status: "cancelled" }),
    ).rejects.toThrow("partial write");
    const partial = await readFile(path);
    await expect(
      store.append("cancelled", { status: "cancelled" }),
    ).rejects.toThrow(/recovery|journal/i);
    expect(await readFile(path)).toEqual(partial);
    expect(partial.subarray(0, before.length)).toEqual(before);
    stores.splice(stores.indexOf(store), 1);
    await expect(store.close()).rejects.toThrow(/recovery|journal/i);
    await expect(WorkflowRunStore.resume(scope, store.id)).rejects.toThrow(
      /incomplete final event/i,
    );
    expect(await readFile(path)).toEqual(partial);
  });

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
    const exit = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    try {
      const id = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Crash fixture did not reach its boundary.")),
          10_000,
        );
        child.once("message", (message: any) => {
          clearTimeout(timer);
          resolve(message.id);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(stderr || "Child exited before crash boundary."));
        });
        child.once("error", reject);
      });
      child.kill("SIGKILL");
      await exit;
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

  it("projects historical agent RPC failures without changing the journal", async () => {
    const diagnostic = "private provider endpoint and credential detail";
    const classification = {
      errorCategory: "provider" as const,
      errorStage: "provider" as const,
    };
    const { scope, store } = await fixture(
      'try { await agent("work", {id:"work"}); } catch (error) { return error.message; } return "unreachable";',
    );
    const first = await execute(store, async () => {
      throw new WorkflowFailureError(diagnostic, classification);
    });
    expect(first.result).toBe(diagnostic);
    await store.close();
    const path = join(store.directory, "journal.ndjson");
    const journalBeforeReplay = await readFile(path);
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);

    const runner = vi.fn(async () => {
      throw new Error("historical agent RPC was redispatched");
    });
    const replayed = await execute(reopened, runner);

    expect(replayed.result).toBe("Agent execution failed.");
    expect(replayed.result).not.toContain(diagnostic);
    expect(replayed.failure).toEqual(classification);
    expect(replayed.errorCount).toBe(first.errorCount);
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(journalBeforeReplay);
  });

  it("preserves non-agent RPC replay errors", async () => {
    const { scope, store } = await fixture(
      'try { await workflow("missing", undefined, {id:"nested"}); } catch (error) { return error.message; } return "unreachable";',
    );
    const loadWorkflow = () => null;
    const first = await execute(store, vi.fn(), { loadWorkflow });
    expect(typeof first.result).toBe("string");
    await store.close();
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const runner = vi.fn();
    const replayed = await execute(reopened, runner, { loadWorkflow });
    expect(replayed.result).toBe(first.result);
    expect(runner).not.toHaveBeenCalled();
  });

  it("projects an interrupted committed agent outcome without calling its runner again", async () => {
    const diagnostic = "private transport response body";
    const classification = {
      errorCategory: "transport" as const,
      errorStage: "turn" as const,
    };
    const { scope, store } = await fixture(
      'return await agent("work", {id:"work"});',
    );
    const request = { prompt: "work", isolation: "in-process" as const };
    const first = new DurableWorkflow(store);
    await expect(
      first.runAttempt(1, 1, request, async () => {
        throw new WorkflowFailureError(diagnostic, classification);
      }),
    ).rejects.toThrow(diagnostic);
    await store.close();
    const path = join(store.directory, "journal.ndjson");
    const journalBeforeReplay = await readFile(path);
    const reopened = await WorkflowRunStore.resume(scope, store.id);
    stores.push(reopened);
    const replay = new DurableWorkflow(reopened);
    const runner = vi.fn(async () => ok("must not run"));

    const replayedError = await replay
      .runAttempt(1, 1, request, runner)
      .catch((error) => error);
    expect(replayedError).toMatchObject({
      message: "Agent execution failed.",
      usage: undefined,
    });
    expect(workflowFailureClassification(replayedError)).toEqual(
      classification,
    );
    expect(runner).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(journalBeforeReplay);
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

  it("rejects torn final lines without rewriting them or accepting corrupt records", async () => {
    const { scope, store } = await fixture("return 1;");
    await store.close();
    const path = join(store.directory, "journal.ndjson");
    const complete = await readFile(path);
    await appendFile(path, '{"torn":');
    const torn = await readFile(path);
    await expect(WorkflowRunStore.resume(scope, store.id)).rejects.toThrow(
      /incomplete final event/i,
    );
    expect(await readFile(path)).toEqual(torn);
    await writeFile(
      path,
      Buffer.concat([complete, Buffer.from('{"corrupt":true}\n')]),
    );
    await expect(WorkflowRunStore.resume(scope, store.id)).rejects.toThrow(
      "corrupt",
    );
  });
});
