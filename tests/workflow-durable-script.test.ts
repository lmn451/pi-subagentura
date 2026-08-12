import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import {
  DurableWorkflowScriptControllerAdapter,
  prepareDurableWorkflowScript,
} from "../src/workflow-durable-script";
import { WorkflowAgentDispatcher } from "../src/workflow-dispatcher";
import {
  WorkflowRunBlobResolver,
  WorkflowRunOperationJournal,
} from "../src/workflow-operation-journal";
import {
  foldWorkflowRunEvents,
  InMemoryWorkflowProjectionRepository,
} from "../src/workflow-projection-repository";
import { WorkflowRecoveryService } from "../src/workflow-recovery";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
  type WorkflowRunLease,
} from "../src/workflow-run-store";
import type { DurableWorkflowOwner } from "../src/workflow-run-types";
import { runWorkflow } from "../src/workflow-worker";

function success(output: string): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function returnedError(
  message: string,
): Extract<SubagentResult, { isError: true }> {
  return {
    isError: true,
    output: "",
    errorMessage: message,
    usage: {
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

const META =
  'export const meta = { name: "durable-script", description: "test" };\n';

function store(home: string, processNumber: number): WorkflowRunStore {
  return new WorkflowRunStore({
    homeDir: home,
    processIdentity: {
      pid: processNumber,
      processStartIdentity: `durable-script-${processNumber}`,
    },
  });
}

describe("durable legacy workflow scripts", () => {
  let home: string;
  let cwd: string;
  let owner: DurableWorkflowOwner;
  let lease: WorkflowRunLease | undefined;
  let dispatcher: WorkflowAgentDispatcher;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "workflow-durable-script-"));
    cwd = join(home, "project");
    mkdirSync(cwd);
    owner = await deriveDurableWorkflowOwner(cwd, "pi-durable-script");
    dispatcher = new WorkflowAgentDispatcher({
      concurrency: 8,
      processConcurrency: 8,
    });
  });

  afterEach(async () => {
    if (lease !== undefined) {
      try {
        await lease.release();
      } catch {
        // A cold-replay test may already have released the first lease.
      }
    }
    dispatcher.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("keeps legacy non-durable calls without ids compatible", async () => {
    const result = await runWorkflow(
      `${META}return await agent("legacy prompt");`,
      {
        cwd,
        runAgent: async () => success("legacy result"),
      },
    );

    expect(result.result).toBe("legacy result");
  });

  it("rejects missing and non-unique loop identities during preflight", () => {
    expect(() =>
      prepareDurableWorkflowScript(`${META}return await agent("missing");`, {
        cwd,
      }),
    ).toThrow(/explicit static.*id/i);

    expect(() =>
      prepareDurableWorkflowScript(
        `${META}
for (const item of args.items) {
  await agent(item.prompt, { id: "reused" });
}
return null;`,
        { cwd },
      ),
    ).toThrow(/caller-authored unique runtime id/i);
  });

  it("commits sequential, concurrent, null, and schema-retry results", async () => {
    const runStore = store(home, 101);
    lease = await runStore.acquireLease(owner, { scopeId: 1, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let schemaAttempts = 0;
    const runner: WorkflowAgentRunner = async ({ prompt }) => {
      if (prompt.includes("slow")) {
        await slow;
        return success("slow-result");
      }
      if (prompt.includes("fast")) {
        releaseSlow();
        return success("fast-result");
      }
      if (prompt.includes("nullable")) return returnedError("expected null");
      if (prompt.includes("schema")) {
        schemaAttempts += 1;
        return success(schemaAttempts === 1 ? "not json" : '{"ok":true}');
      }
      return success("sequential-result");
    };
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun: () => runner,
      dispatcher,
    });
    const script = `${META}
const sequential = await agent("sequential", { id: "sequential", isolation: "in-process" });
const concurrent = await Promise.all([
  agent("slow", { id: "slow", isolation: "in-process" }),
  agent("fast", { id: "fast", isolation: "in-process" }),
]);
const nullable = await agent("nullable", { id: "nullable", isolation: "in-process" });
const structured = await agent("schema", {
  id: "schema",
  isolation: "process",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
});
return { sequential, concurrent, nullable, structured };`;

    const execution = await durable.startScript({ script, cwd });
    const result = await execution.completion;

    expect(result.result).toEqual({
      sequential: "sequential-result",
      concurrent: ["slow-result", "fast-result"],
      nullable: null,
      structured: { ok: true },
    });
    expect(schemaAttempts).toBe(2);
    expect(
      (await repository.get(owner, execution.runId))?.responses,
    ).toHaveLength(5);
  });

  it("uses immutable nested saved-definition snapshots", async () => {
    const runStore = store(home, 201);
    lease = await runStore.acquireLease(owner, { scopeId: 2, generation: 1 });
    let child = `${META}return await agent("old child", { id: "child-agent", isolation: "in-process" });`;
    const prompts: string[] = [];
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository: new InMemoryWorkflowProjectionRepository(),
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          prompts.push(prompt);
          return success(prompt);
        },
      dispatcher,
    });
    const root = `${META}return await workflow("child", null, { id: "nested" });`;

    const execution = await durable.startScript({
      script: root,
      cwd,
      loadWorkflow: (name) => (name === "child" ? child : null),
    });
    child = `${META}return await agent("changed child", { id: "child-agent", isolation: "in-process" });`;
    const result = await execution.completion;

    expect(result.result).toBe("old child");
    expect(prompts).toEqual(["old child"]);
  });

  it("cold-replays committed operations without invoking the model again", async () => {
    const runStore = store(home, 301);
    lease = await runStore.acquireLease(owner, { scopeId: 3, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    let secondStarted!: () => void;
    const waitingForSecond = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const firstProcessPrompts: string[] = [];
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt, signal }) => {
          firstProcessPrompts.push(prompt);
          if (prompt === "first") return success("first-result");
          secondStarted();
          return new Promise<SubagentResult>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("simulated process crash")),
              { once: true },
            );
          });
        },
      dispatcher,
    });
    const script = `${META}
const first = await agent("first", { id: "first", isolation: "in-process" });
const second = await agent("second", { id: "second", isolation: "in-process" });
return [first, second];`;
    const execution = await durable.startScript({
      script,
      cwd,
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await waitingForSecond;
    await durable.interrupt("process_crash", execution.runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    await lease.release();
    lease = undefined;

    const reopenedStore = store(home, 302);
    lease = await reopenedStore.acquireLease(owner, {
      scopeId: 4,
      generation: 2,
    });
    const reopenedRepository = new InMemoryWorkflowProjectionRepository();
    const recovery = await new WorkflowRecoveryService(
      reopenedStore,
      reopenedRepository,
      new WorkflowRunBlobResolver(reopenedStore),
    ).recoverOwner(owner, "resume");
    const recovered = recovery.runs.find(
      (candidate) => candidate.runId === execution.runId,
    )?.projection;
    expect(recovered?.status).toBe("interrupted");
    const replayPrompts: string[] = [];
    const reopened = new DurableWorkflowScriptControllerAdapter({
      store: reopenedStore,
      lease,
      owner,
      repository: reopenedRepository,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          replayPrompts.push(prompt);
          return success(`${prompt}-result`);
        },
      dispatcher,
    });

    const resumed = await reopened.resumeRecovered(recovered!, "resume");
    const result = await resumed.completion;

    expect(firstProcessPrompts).toEqual(["first", "second"]);
    expect(replayPrompts).toEqual(["second"]);
    expect(result.result).toEqual(["first-result", "second-result"]);
  });

  it("allocates contiguous ordinals only for runtime calls and supports unique loop ids", async () => {
    const runStore = store(home, 401);
    lease = await runStore.acquireLease(owner, { scopeId: 5, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt }) =>
          success(prompt),
      dispatcher,
    });
    const script = `${META}
const values = [];
if (args.includeSkipped) {
  values.push(await agent("skipped", { id: "skipped", isolation: "in-process" }));
}
for (const item of args.items) {
  values.push(await agent(item.prompt, { id: \`review-\${item.id}\`, isolation: "in-process" }));
}
return values;`;

    const execution = await durable.startScript({
      script,
      cwd,
      args: {
        includeSkipped: false,
        items: [
          { id: "a", prompt: "first" },
          { id: "b", prompt: "second" },
        ],
      },
    });
    const result = await execution.completion;
    const projection = await repository.get(owner, execution.runId);

    expect(result.result).toEqual(["first", "second"]);
    expect(
      projection?.operations.map((operation) => ({
        id: operation.identity.operationId,
        ordinal: operation.request.dispatchOrdinal,
      })),
    ).toEqual([
      { id: "review-a", ordinal: 1 },
      { id: "review-b", ordinal: 2 },
    ]);
  });

  it("captures caller-authored nested workflow ids inside loops", async () => {
    const runStore = store(home, 451);
    lease = await runStore.acquireLease(owner, { scopeId: 10, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt }) =>
          success(prompt),
      dispatcher,
    });
    const child =
      `export const meta = { name: "child", description: "nested" };\n` +
      `return args.value;`;
    const script = `${META}
const values = [];
for (const item of args.items) {
  values.push(await workflow("child", { value: item.value }, { id: \`child-\${item.id}\` }));
}
return values;`;

    const execution = await durable.startScript({
      script,
      cwd,
      args: {
        items: [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ],
      },
      loadWorkflow: (name) => (name === "child" ? child : null),
    });
    const result = await execution.completion;
    const projection = await repository.get(owner, execution.runId);

    expect(result.result).toEqual([1, 2]);
    expect(
      projection?.operations.map((operation) => operation.identity.operationId),
    ).toEqual(["child-a", "child-b"]);
    expect(
      projection?.definitions
        .map((definition) => definition.parentOperation?.operationId)
        .filter((id) => id?.startsWith("child-")),
    ).toEqual(["child-a", "child-b"]);
  });

  it("routes process attempt authority and resolved model through the actual dispatcher", async () => {
    const runStore = store(home, 501);
    lease = await runStore.acquireLease(owner, { scopeId: 6, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const requests: Parameters<WorkflowAgentRunner>[0][] = [];
    const runner: WorkflowAgentRunner = Object.assign(
      async (request: Parameters<WorkflowAgentRunner>[0]) => {
        requests.push(request);
        await request.workflowProcessAttempt?.fallback(
          "test environment intentionally uses in-process execution",
        );
        return success("process-result");
      },
      {
        resolveModel: () => "provider/effective-model",
      },
    );
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun: () => runner,
      dispatcher,
    });

    const execution = await durable.startScript({
      script: `${META}return await agent("process", { id: "process" });`,
      cwd,
    });
    const result = await execution.completion;
    const projection = await repository.get(owner, execution.runId);

    expect(result.result).toBe("process-result");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      isolation: "process",
      model: "provider/effective-model",
      workflowProcessAttempt: { mode: "launch" },
    });
    expect(projection?.operations[0]?.attempts[0]?.process).toMatchObject({
      stage: "fallback",
      effectiveIsolation: "in-process",
    });
    expect(projection?.accounting.usage).toMatchObject({
      input: 1,
      output: 1,
      turns: 1,
    });
  });

  it("preserves partial operation usage when interruption aborts workers", async () => {
    const runStore = store(home, 551);
    lease = await runStore.acquireLease(owner, { scopeId: 13, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const liveUsage = {
      input: 3,
      output: 5,
      cacheRead: 7,
      cacheWrite: 11,
      totalTokens: 26,
      costUsd: 0.13,
      turns: 1,
    };
    const terminalUsage = {
      input: 17,
      output: 19,
      cacheRead: 23,
      cacheWrite: 29,
      cost: 0.31,
      turns: 1,
    };
    let started = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt, signal, onProgress }) => {
          if (prompt === "live") {
            onProgress?.({
              kind: "log",
              message: "partial usage",
              liveUsage,
            });
          }
          started += 1;
          if (started === 2) markBothStarted();
          if (signal === undefined) {
            throw new Error("durable runner omitted its abort signal");
          }
          await once(signal, "abort");
          if (prompt === "terminal") {
            throw Object.assign(new Error("terminal failure"), {
              usage: terminalUsage,
            });
          }
          throw new Error("live progress failure");
        },
      dispatcher,
    });
    const execution = await durable.startScript({
      script: `${META}
return await Promise.all([
  agent("live", { id: "live", isolation: "in-process" }),
  agent("terminal", { id: "terminal", isolation: "in-process" }),
]);`,
      cwd,
    });
    await bothStarted;

    await durable.interrupt("process_crash", execution.runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    const projection = foldWorkflowRunEvents(
      await (await lease.openRun(execution.runId)).readEvents(),
    );

    expect(
      projection.operations.find(
        (operation) => operation.identity.operationId === "live",
      )?.attempts[0]?.usageObserved,
    ).toMatchObject(liveUsage);
    expect(
      projection.operations.find(
        (operation) => operation.identity.operationId === "terminal",
      )?.attempts[0]?.usageObserved,
    ).toMatchObject({
      input: terminalUsage.input,
      output: terminalUsage.output,
      cacheRead: terminalUsage.cacheRead,
      cacheWrite: terminalUsage.cacheWrite,
      turns: terminalUsage.turns,
      totalTokens:
        terminalUsage.input +
        terminalUsage.output +
        terminalUsage.cacheRead +
        terminalUsage.cacheWrite,
      costUsd: terminalUsage.cost,
    });
  });

  it("rejects a duplicate runtime id when its resolved effective model changes", async () => {
    const runStore = store(home, 601);
    lease = await runStore.acquireLease(owner, { scopeId: 7, generation: 1 });
    let resolutions = 0;
    let calls = 0;
    const runner: WorkflowAgentRunner = Object.assign(
      async () => {
        calls += 1;
        return success("once");
      },
      {
        resolveModel: () =>
          ++resolutions === 1 ? "provider/model-a" : "provider/model-b",
      },
    );
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository: new InMemoryWorkflowProjectionRepository(),
      runAgentForRun: () => runner,
      dispatcher,
    });
    const script = `${META}
const values = [];
for (const item of [{ id: "same" }, { id: "same" }]) {
  values.push(await agent("same prompt", { id: \`operation-\${item.id}\`, isolation: "in-process" }));
}
return values;`;

    const execution = await durable.startScript({ script, cwd });

    await expect(execution.completion).rejects.toThrow(
      /reused with another request|immutable conflict/i,
    );
    expect(calls).toBe(1);
  });

  it("self-heals an inactive cancellation after the request was committed", async () => {
    const runStore = store(home, 701);
    lease = await runStore.acquireLease(owner, { scopeId: 8, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const lifecycle = new EventEmitter();
    const waitingForStart = once(lifecycle, "started");
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ signal }) => {
          lifecycle.emit("started");
          if (signal === undefined) {
            throw new Error("durable runner omitted its abort signal");
          }
          await once(signal, "abort");
          throw new Error("simulated cancellation crash gap");
        },
      dispatcher,
    });
    const execution = await durable.startScript({
      script: `${META}return await agent("wait", { id: "wait", isolation: "in-process" });`,
      cwd,
    });
    await waitingForStart;
    await durable.interrupt("process_crash", execution.runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });
    const journal = await lease.openRun(execution.runId);
    await new WorkflowRunOperationJournal(journal).appendEvent(journal.fence!, {
      type: "run_cancellation_requested",
      payload: {
        reason: "cancel after crash",
        trustedActorId: "trusted-actor",
      },
    });
    const requested = foldWorkflowRunEvents(await journal.readEvents());

    const resumed = await durable.resumeRecovered(requested, "resume");
    const cancelled = await resumed.completion;
    const terminalProjection = foldWorkflowRunEvents(
      await journal.readEvents(),
    );
    const repeated = await durable.trustedCancel(
      terminalProjection,
      "repeated cancellation",
      "trusted-actor",
    );

    expect(cancelled).toEqual(repeated);
    expect(terminalProjection.terminal?.status).toBe("cancelled");
    expect(
      (await journal.readEvents()).filter(
        (event) => event.type === "run_cancellation_requested",
      ),
    ).toHaveLength(1);
  });

  it("preserves completion order for Promise.race and shared post-await mutation", async () => {
    const runStore = store(home, 801);
    lease = await runStore.acquireLease(owner, { scopeId: 9, generation: 1 });
    const slowGate = new EventEmitter();
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository: new InMemoryWorkflowProjectionRepository(),
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          if (prompt === "slow") {
            await once(slowGate, "release");
          } else {
            setImmediate(() => slowGate.emit("release"));
          }
          return success(prompt);
        },
      dispatcher,
    });
    const script = `${META}
const order = [];
const slow = agent("slow", { id: "slow", isolation: "in-process" });
const fast = agent("fast", { id: "fast", isolation: "in-process" });
const winner = await Promise.race([slow, fast]);
await Promise.all([
  slow.then((value) => order.push(value)),
  fast.then((value) => order.push(value)),
]);
return { winner, order };`;

    const execution = await durable.startScript({ script, cwd });
    const result = await execution.completion;

    expect(result.result).toEqual({
      winner: "fast",
      order: ["fast", "slow"],
    });
  });

  it("cold-replays nested workflow completion in its recorded parent response order", async () => {
    const runStore = store(home, 851);
    lease = await runStore.acquireLease(owner, {
      scopeId: 11,
      generation: 1,
    });
    const repository = new InMemoryWorkflowProjectionRepository();
    let markNestedStarted!: () => void;
    const nestedStarted = new Promise<void>((resolve) => {
      markNestedStarted = resolve;
    });
    let releaseNested!: () => void;
    const nestedWait = new Promise<void>((resolve) => {
      releaseNested = resolve;
    });
    let markBlockStarted!: () => void;
    const blockStarted = new Promise<void>((resolve) => {
      markBlockStarted = resolve;
    });
    const firstPrompts: string[] = [];
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt, signal }) => {
          firstPrompts.push(prompt);
          if (prompt === "nested-slow") {
            markNestedStarted();
            await nestedWait;
            return success("nested-result");
          }
          if (prompt === "parent-fast") {
            await nestedStarted;
            return success("parent-result");
          }
          if (prompt === "release-nested") {
            releaseNested();
            return success("released");
          }
          if (prompt === "block") {
            markBlockStarted();
            if (signal === undefined) {
              throw new Error("durable runner omitted its abort signal");
            }
            await once(signal, "abort");
            throw new Error("simulated process crash");
          }
          throw new Error(`unexpected prompt: ${prompt}`);
        },
      dispatcher,
    });
    const child =
      `export const meta = { name: "child", description: "nested" };\n` +
      `return await agent("nested-slow", { id: "nested-agent", isolation: "in-process" });`;
    const script = `${META}
const order = [];
const nested = workflow("child", null, { id: "nested" });
const parent = agent("parent-fast", { id: "parent-fast", isolation: "in-process" });
const release = parent.then(() =>
  agent("release-nested", { id: "release-nested", isolation: "in-process" }),
);
const winner = await Promise.race([nested, parent]);
await Promise.all([
  nested.then((value) => order.push(value)),
  parent.then((value) => order.push(value)),
  release,
]);
await agent("block", { id: "block", isolation: "in-process" });
return { winner, order };`;

    const execution = await durable.startScript({
      script,
      cwd,
      loadWorkflow: (name) => (name === "child" ? child : null),
      resumePolicy: "automatic_on_reload_or_resume",
    });
    await blockStarted;
    await durable.interrupt("process_crash", execution.runId);
    await expect(execution.completion).rejects.toMatchObject({
      code: "interrupted",
    });

    const journal = await lease.openRun(execution.runId);
    const interruptedProjection = foldWorkflowRunEvents(
      await journal.readEvents(),
    );
    expect(
      interruptedProjection.responses
        .filter((response) => response.operation.definitionPath === "root")
        .map((response) => response.operation.operationId),
    ).toEqual(["parent-fast", "release-nested", "nested"]);
    const nestedOutcome = interruptedProjection.operations.find(
      (operation) =>
        operation.identity.definitionPath === "root" &&
        operation.identity.operationId === "nested",
    )?.settlement?.outcome;
    if (nestedOutcome?.status !== "succeeded") {
      throw new Error("nested workflow completion was not committed");
    }
    expect(await journal.readOutput(nestedOutcome.value)).toMatchObject({
      durableScriptResponse: {
        value: "nested-result",
      },
    });
    await lease.release();
    lease = undefined;

    const reopenedStore = store(home, 852);
    lease = await reopenedStore.acquireLease(owner, {
      scopeId: 12,
      generation: 2,
    });
    const reopenedRepository = new InMemoryWorkflowProjectionRepository();
    const recovery = await new WorkflowRecoveryService(
      reopenedStore,
      reopenedRepository,
      new WorkflowRunBlobResolver(reopenedStore),
    ).recoverOwner(owner, "resume");
    const recovered = recovery.runs.find(
      (candidate) => candidate.runId === execution.runId,
    )?.projection;
    const replayPrompts: string[] = [];
    const reopened = new DurableWorkflowScriptControllerAdapter({
      store: reopenedStore,
      lease,
      owner,
      repository: reopenedRepository,
      runAgentForRun:
        () =>
        async ({ prompt }) => {
          replayPrompts.push(prompt);
          return success(`${prompt}-result`);
        },
      dispatcher,
    });

    const resumed = await reopened.resumeRecovered(recovered!, "resume");
    const result = await resumed.completion;

    expect(firstPrompts).toContain("nested-slow");
    expect(firstPrompts).toContain("parent-fast");
    expect(replayPrompts).toEqual(["block"]);
    expect(result.result).toEqual({
      winner: "parent-result",
      order: ["parent-result", "nested-result"],
    });
  });

  it("captures recursive immutable nested definitions on canonical paths", async () => {
    const runStore = store(home, 901);
    lease = await runStore.acquireLease(owner, { scopeId: 10, generation: 1 });
    const repository = new InMemoryWorkflowProjectionRepository();
    const saved = new Map([
      [
        "child",
        `${META}return await workflow("grandchild", null, { id: "grand" });`,
      ],
      [
        "grandchild",
        `${META}return await agent("deep", { id: "deep-agent", isolation: "in-process" });`,
      ],
    ]);
    const durable = new DurableWorkflowScriptControllerAdapter({
      store: runStore,
      lease,
      owner,
      repository,
      runAgentForRun:
        () =>
        async ({ prompt }) =>
          success(prompt),
      dispatcher,
    });

    const execution = await durable.startScript({
      script: `${META}return await workflow("child", null, { id: "child" });`,
      cwd,
      loadWorkflow: (name) => saved.get(name) ?? null,
    });
    const result = await execution.completion;
    const projection = await repository.get(owner, execution.runId);

    expect(result.result).toBe("deep");
    expect(
      projection?.definitions.map((definition) => definition.definitionPath),
    ).toEqual(["root", "root/child", "root/child/grand"]);
  });
});
