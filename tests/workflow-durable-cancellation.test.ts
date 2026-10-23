import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as NodeFs from "node:fs";
import {
  mkdtemp,
  mkdir,
  appendFile,
  readFile,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelAllFlows } from "../src/cancel-all-flows";
import { registerCancelAllFlows } from "../src/cancel-all-flows-registration";
import {
  registerCompletionCoordinator,
  clearCompletionCoordinator,
} from "../src/completion-coordinator";
import { __setTmuxMultiplexer } from "../src/multiplexer";
import type { Multiplexer } from "../src/multiplexer-contracts";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { prepareDurableProcess } from "../src/workflow-durable-process";
import { registerDurableWorkflowTools } from "../src/workflow-durable-tools";
import { WorkflowRunStore, encodeRunValue } from "../src/workflow-run-store";
import type { RunScope } from "../src/workflow-run-store";
import type { RunEvent } from "../src/workflow-run-store";
import { registerWorkflowTool } from "../src/workflow-tool";
import { workflowJobRegistry } from "../src/workflow-jobs";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import type { SessionScope } from "../src/session-scope";
import { createTestSessionScope } from "./session-scope-fixture";
import { zeroUsage } from "../src/usage";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { registerInProcessJob, type JobState } from "../src/helpers";

const fsFault = vi.hoisted(() => ({
  failOpenPath: undefined as string | undefined,
  failures: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    openSync: (...args: unknown[]) => {
      const path = args[0];
      if (fsFault.failOpenPath === path) {
        fsFault.failOpenPath = undefined;
        fsFault.failures++;
        throw Object.assign(
          new Error("injected attempt cancellation write failure"),
          {
            code: "EACCES",
          },
        );
      }
      return actual.openSync(
        path as Parameters<typeof actual.openSync>[0],
        args[1] as Parameters<typeof actual.openSync>[1],
        args[2] as Parameters<typeof actual.openSync>[2],
      );
    },
  };
});

const DURABLE_SCRIPT =
  'export const meta={name:"durable-cancel",description:"d"}; return await agent("work", {id:"work"});';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

interface ToolResult {
  isError?: boolean;
  details: Record<string, unknown>;
  content?: Array<{ text: string }>;
}

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ToolResult>;
}

interface DurableToolsApi {
  run(
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<unknown>;
}

interface Harness {
  tools: Map<string, unknown>;
  pi: ExtensionAPI;
  scope: SessionScope;
  ctx: Record<string, unknown>;
  runScope: RunScope;
}

interface InteractiveSnapshotReceipt {
  kind: "interactive";
  source: string;
  status: string;
  path: string;
}

interface InteractiveSnapshotPayload {
  kind: string;
  cancellation: Record<string, unknown>;
  files: {
    sessionFile: { exists: boolean; bytes?: number; sha256?: string };
    events: { exists: boolean; sha256?: string };
    output: { exists: boolean; sha256?: string };
  };
}

let root: string;
let harness: Harness;
const releases = new Set<() => void>();

function createHarness(directory: string): Harness {
  const tools = new Map<string, unknown>();
  const pi = {
    registerTool: (tool: unknown) => {
      if (
        tool &&
        typeof tool === "object" &&
        "name" in tool &&
        typeof tool.name === "string"
      )
        tools.set(tool.name, tool);
    },
    registerCommand: vi.fn(),
    on: vi.fn(),
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const sessionManager = {
    getSessionId: () => "durable-cancellation-parent",
    getEntries: () => [],
  };
  const scope = createTestSessionScope({
    pi,
    cwd: directory,
    generation: 1,
    lifecycle: "started",
    sessionManager,
  });
  registerCompletionCoordinator(pi, scope);
  return {
    tools,
    pi,
    scope,
    ctx: {
      cwd: directory,
      sessionManager,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    },
    runScope: {
      cwd: directory,
      sessionId: sessionManager.getSessionId(),
      root: directory,
    },
  };
}

function getTool(name: string): RegisteredTool {
  const tool = harness.tools.get(name);
  if (
    !tool ||
    typeof tool !== "object" ||
    !("execute" in tool) ||
    typeof tool.execute !== "function"
  )
    throw new Error(`Missing registered tool: ${name}`);
  return tool as unknown as RegisteredTool;
}

function isInteractiveSnapshotReceipt(
  value: unknown,
): value is InteractiveSnapshotReceipt {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "interactive" &&
    "source" in value &&
    typeof value.source === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function durableTools(
  runner: WorkflowAgentRunner,
  storeRoot = root,
): DurableToolsApi {
  return registerDurableWorkflowTools(
    harness.pi,
    () => sessionOwner(harness.scope),
    () => runner,
    () => true,
    storeRoot,
  ) as unknown as DurableToolsApi;
}

async function startDurableRun(api: DurableToolsApi): Promise<string> {
  const started = (await api.run(
    { script: DURABLE_SCRIPT, async: true },
    undefined,
    undefined,
    harness.ctx,
  )) as ToolResult;
  expect(started.details.status).toBe("started");
  const id = started.details.workflowId;
  if (typeof id !== "string")
    throw new Error("Durable workflow returned no id.");
  return id;
}

function fakeAttemptState(directory: string): InteractiveSubagentState {
  return {
    id: "durable-child",
    artifactDir: join(directory, "child-artifacts"),
    task: "test task",
    paneId: "%recycled-pane",
    mux: "tmux",
    sessionFile: join(directory, "child-session.jsonl"),
  } as InteractiveSubagentState;
}

async function persistedRunWithAttempt() {
  const runScope = {
    cwd: root,
    sessionId: harness.runScope.sessionId,
  };
  const store = await WorkflowRunStore.create(runScope, {
    script: DURABLE_SCRIPT,
    args: encodeRunValue(undefined),
    budgetTotal: 100,
  });
  await store.append("accepted", {});
  await store.append("delivery", { completion: { policy: "each" } });
  const attempt = await prepareDurableProcess({
    directory: store.directory,
    key: "1-0",
    recovering: false,
  });
  attempt.beforeDispatch(fakeAttemptState(root));
  const path = attempt.path;
  const id = store.id;
  await store.close();
  return { id, path, runScope, directory: store.directory };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "workflow-durable-cancel-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(root, "pi-session"));
  vi.stubEnv("HERDR_ENV", "");
  vi.stubEnv("ZELLIJ_SESSION_NAME", "");
  vi.stubEnv("TMUX", "");
  vi.stubEnv("SUBAGENT_CANCEL_SNAPSHOT", "off");
  fsFault.failures = 0;
  vi.stubEnv("SUBAGENT_CANCEL_SNAPSHOT_DIR", join(root, "snapshots"));
  fsFault.failOpenPath = undefined;
  harness = createHarness(root);
});

afterEach(async () => {
  for (const release of releases) release();
  releases.clear();
  const jobs = [...workflowJobRegistry.values()];
  for (const job of jobs) {
    if (job.status === "running") job.abort.abort();
  }
  await Promise.all(jobs.map((job) => job.promise.catch(() => undefined)));
  for (const job of jobs) workflowJobRegistry.delete(job.id);
  clearCompletionCoordinator(sessionOwner(harness.scope));
  clearSessionScopes();
  __setTmuxMultiplexer(undefined);
  fsFault.failOpenPath = undefined;
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("durable cancellation regressions", () => {
  it("does not cancel a run when a partial journal tail survives close and reopen", async () => {
    registerWorkflowTool(harness.pi, harness.scope);
    const { id, runScope, directory } = await persistedRunWithAttempt();
    const journalPath = join(directory, "journal.ndjson");
    await appendFile(journalPath, '{"partial":');
    const partialJournal = await readFile(journalPath);
    const cancel = getTool("cancel_workflow");

    const result = await cancel.execute(
      "partial-journal-cancel",
      { workflowId: id },
      undefined,
      undefined,
      harness.ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.details.status).toBe("error");
    expect(await readFile(journalPath)).toEqual(partialJournal);
    const events = await WorkflowRunStore.inspect(runScope, id);
    expect(events?.some((event) => event.kind === "cancelled")).toBe(false);
  });

  it("commits cancel-all intent before abort and retains it when settlement is interrupted", async () => {
    const agentStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const allowAgentSettlement = deferred<void>();
    releases.add(() => allowAgentSettlement.resolve());
    const runner: WorkflowAgentRunner = async ({ signal }) => {
      agentStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          abortObserved.resolve();
          void allowAgentSettlement.promise.then(() =>
            reject(new Error("agent stopped after cancel-all")),
          );
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    };
    const api = durableTools(runner);
    const id = await startDurableRun(api);
    const job = workflowJobRegistry.get(id)!;
    await agentStarted.promise;

    const appendEntered = deferred<void>();
    const allowIntentCommit = deferred<void>();
    releases.add(() => allowIntentCommit.resolve());
    const append = job.durable!.store.append.bind(job.durable!.store);
    vi.spyOn(job.durable!.store, "append").mockImplementation(
      async (kind, data) => {
        if (kind === "cancelled") {
          appendEntered.resolve();
          await allowIntentCommit.promise;
        }
        if (kind === "terminal")
          throw new Error("simulated interrupted terminal settlement");
        return append(kind, data);
      },
    );

    let journalAtAbort: Promise<RunEvent[] | undefined> | undefined;
    job.abort.signal.addEventListener(
      "abort",
      () => {
        journalAtAbort = WorkflowRunStore.inspect(harness.runScope, id);
      },
      { once: true },
    );
    const cancelAll = cancelAllFlows(sessionOwner(harness.scope));
    const first = await Promise.race([
      appendEntered.promise.then(() => "intent" as const),
      abortObserved.promise.then(() => "abort" as const),
    ]);
    expect(first).toBe("intent");
    expect(job.abort.signal.aborted).toBe(false);

    allowIntentCommit.resolve();
    const result = await cancelAll;
    expect(result.workflowsAborted).toBe(1);
    await abortObserved.promise;
    expect(journalAtAbort).toBeDefined();
    expect(
      (await journalAtAbort!)?.some((event) => event.kind === "cancelled"),
    ).toBe(true);

    allowAgentSettlement.resolve();
    await expect(job.promise).rejects.toThrow(
      "simulated interrupted terminal settlement",
    );
    const events = await WorkflowRunStore.inspect(harness.runScope, id);
    expect(events?.some((event) => event.kind === "cancelled")).toBe(true);
    expect(events?.some((event) => event.kind === "terminal")).toBe(false);
    const resume = (await api.run(
      { workflowId: id, async: false },
      undefined,
      undefined,
      harness.ctx,
    )) as ToolResult;
    expect(resume.isError).toBe(true);
    expect(resume.content?.[0]?.text).toContain("already terminal");
  });

  it("does not abort a durable run when cancel-all cannot persist intent", async () => {
    const agentStarted = deferred<void>();
    const finishAgent = deferred<void>();
    releases.add(() => finishAgent.resolve());
    let finish!: () => void;
    let attemptPath = "";
    let childState: InteractiveSubagentState | undefined;
    const runner: WorkflowAgentRunner = async ({ signal, durableAttempt }) => {
      const attempt = await prepareDurableProcess(durableAttempt!);
      const state = {
        ...fakeAttemptState(root),
        status: "running",
        parentSessionId: harness.runScope.sessionId,
      } as InteractiveSubagentState;
      attempt.beforeDispatch(state);
      attemptPath = attempt.path;
      childState = state;
      harness.scope.interactiveStates.set(state.id, state);
      agentStarted.resolve();
      return new Promise((resolve, reject) => {
        finish = () =>
          resolve({ isError: false, output: "finished", usage: zeroUsage() });
        const onAbort = () =>
          reject(new Error("unexpected abort after failed intent"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        void finishAgent.promise.then(() => finish());
      });
    };
    const api = durableTools(runner);
    const id = await startDurableRun(api);
    const job = workflowJobRegistry.get(id)!;
    await agentStarted.promise;
    if (!childState) throw new Error("Durable child state was not registered.");
    childState.workflowId = id;
    const childAbort = new AbortController();
    const childJob = {
      id: "owned-in-process-child",
      status: "running",
      liveStatus: {} as JobState["liveStatus"],
      session: {
        abort: vi.fn(async () => undefined),
      } as unknown as JobState["session"],
      startedAt: Date.now(),
      promise: Promise.resolve({
        isError: false,
        output: "child",
        usage: zeroUsage(),
      }),
      abort: childAbort,
      workflowId: id,
    } as JobState;
    if (!registerInProcessJob(childJob, sessionOwner(harness.scope))) {
      throw new Error("In-process child job was not registered.");
    }
    const append = job.durable!.store.append.bind(job.durable!.store);
    vi.spyOn(job.durable!.store, "append").mockImplementation((kind, data) =>
      kind === "cancelled"
        ? Promise.reject(new Error("run cancellation intent write failed"))
        : append(kind, data),
    );

    try {
      const result = await cancelAllFlows(sessionOwner(harness.scope));
      expect(result.workflowsFailed).toBe(1);
      expect(result.interactiveKilled).toBe(0);
      expect(job.abort.signal.aborted).toBe(false);
      expect(childAbort.signal.aborted).toBe(false);
      expect(childJob.status).toBe("running");
      expect(childJob.cancellation).toBeUndefined();
      expect(childState?.status).toBe("running");
      await expect(access(attemptPath + ".cancel")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const events = await WorkflowRunStore.inspect(harness.runScope, id);
      expect(events?.some((event) => event.kind === "cancelled")).toBe(false);
    } finally {
      finishAgent.resolve();
      if (!finish) finish = () => undefined;
      finish();
    }
    await job.promise;
  });

  it("keeps a sync durable workflow alive through both handlers when cancellation intent cannot persist", async () => {
    const agentStarted = deferred<void>();
    let childSignal: AbortSignal | undefined;
    let childState: InteractiveSubagentState | undefined;
    let attemptPath = "";
    const runner: WorkflowAgentRunner = async ({ signal, durableAttempt }) => {
      if (!durableAttempt) throw new Error("Expected a durable attempt.");
      const attempt = await prepareDurableProcess(durableAttempt);
      const state = {
        ...fakeAttemptState(root),
        status: "running",
        parentSessionId: harness.runScope.sessionId,
      } as InteractiveSubagentState;
      attempt.beforeDispatch(state);
      attemptPath = attempt.path;
      childState = state;
      harness.scope.interactiveStates.set(state.id, state);
      childSignal = signal;
      agentStarted.resolve();
      const { promise, reject } = Promise.withResolvers<never>();
      const onAbort = () => {
        state.status = "cancelled";
        reject(new Error("sync durable child cancelled"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      return promise;
    };
    const api = durableTools(runner);
    const foreground = new AbortController();
    type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
    type ShortcutOptions = Parameters<ExtensionAPI["registerShortcut"]>[1];
    type CommandHandler = CommandOptions["handler"];
    type ShortcutHandler = ShortcutOptions["handler"];
    let commandHandler: CommandHandler | undefined;
    let shortcutHandler: ShortcutHandler | undefined;
    const registrationApi = {
      registerCommand: (_name: string, options: CommandOptions) => {
        commandHandler = options.handler;
      },
      registerShortcut: (_shortcut: string, options: ShortcutOptions) => {
        shortcutHandler = options.handler;
      },
    } as unknown as ExtensionAPI;
    registerCancelAllFlows(registrationApi, harness.scope);
    if (!commandHandler || !shortcutHandler)
      throw new Error("Cancel-all handlers were not registered.");

    const cancelCtx = {
      ...harness.ctx,
      abort: () => foreground.abort(),
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    };
    const commandContext =
      cancelCtx as unknown as Parameters<CommandHandler>[1];
    const shortcutContext =
      cancelCtx as unknown as Parameters<ShortcutHandler>[0];
    const syncRun = api.run(
      { script: DURABLE_SCRIPT, async: false },
      foreground.signal,
      undefined,
      harness.ctx,
    );
    let syncRunSettled = false;
    void syncRun.then(() => {
      syncRunSettled = true;
    });
    await agentStarted.promise;
    const job = [...workflowJobRegistry.values()].find(
      (candidate) => candidate.executionMode === "sync",
    );
    if (!job?.durable || !childState || !childSignal)
      throw new Error("Synchronous durable workflow child did not start.");
    const id = job.id;
    childState.workflowId = id;
    const append = job.durable.store.append.bind(job.durable.store);
    let cancellationAppendFailures = 2;
    vi.spyOn(job.durable.store, "append").mockImplementation((kind, data) => {
      if (kind === "cancelled" && cancellationAppendFailures > 0) {
        cancellationAppendFailures--;
        return Promise.reject(
          new Error("run cancellation intent write failed"),
        );
      }
      return append(kind, data);
    });

    await commandHandler("", commandContext);

    expect(foreground.signal.aborted).toBe(false);
    expect(syncRunSettled).toBe(false);
    expect(job.status).toBe("running");
    expect(job.abort.signal.aborted).toBe(false);
    expect(childSignal.aborted).toBe(false);
    expect(childState.status).toBe("running");
    await expect(access(attemptPath + ".cancel")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const failedEvents = await WorkflowRunStore.inspect(harness.runScope, id);
    expect(failedEvents?.some((event) => event.kind === "cancelled")).toBe(
      false,
    );

    await shortcutHandler(shortcutContext);
    expect(foreground.signal.aborted).toBe(false);
    expect(job.status).toBe("running");
    expect(job.abort.signal.aborted).toBe(false);
    expect(childSignal.aborted).toBe(false);
    expect(childState.status).toBe("running");
    await expect(access(attemptPath + ".cancel")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const secondFailureEvents = await WorkflowRunStore.inspect(
      harness.runScope,
      id,
    );
    expect(
      secondFailureEvents?.some((event) => event.kind === "cancelled"),
    ).toBe(false);

    await shortcutHandler(shortcutContext);
    expect(foreground.signal.aborted).toBe(true);
    expect(job.abort.signal.aborted).toBe(true);
    await Promise.allSettled([job.promise, syncRun]);
    expect(job.status).toBe("cancelled");
    expect(childState.status).toBe("cancelled");
    await expect(access(attemptPath + ".cancel")).resolves.toBeUndefined();
    const retriedEvents = await WorkflowRunStore.inspect(harness.runScope, id);
    expect(retriedEvents?.some((event) => event.kind === "cancelled")).toBe(
      true,
    );
  });

  it("retries a failed attempt marker through public cancel_workflow after terminal intent", async () => {
    registerWorkflowTool(harness.pi, harness.scope);
    const { id, path, runScope } = await persistedRunWithAttempt();
    const cancel = getTool("cancel_workflow");
    fsFault.failOpenPath = path + ".cancel";

    await cancel.execute(
      "first-cancel",
      { workflowId: id },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(fsFault.failures).toBe(1);
    await expect(access(path + ".cancel")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const committed = await WorkflowRunStore.inspect(runScope, id);
    expect(committed?.some((event) => event.kind === "cancelled")).toBe(true);

    const retry = await cancel.execute(
      "retry-cancel",
      { workflowId: id },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(retry.details.status).toBe("cancelled");
    await expect(access(path + ".cancel")).resolves.toBeUndefined();
    const afterRetry = await WorkflowRunStore.inspect(runScope, id);
    expect(afterRetry?.some((event) => event.kind === "cancelled")).toBe(true);
  });

  it("retries live-job attempt cleanup after its cancellation marker write fails", async () => {
    registerWorkflowTool(harness.pi, harness.scope);
    const agentStarted = deferred<void>();
    let attemptPath = "";
    const runner: WorkflowAgentRunner = async ({ signal, durableAttempt }) => {
      const attempt = await prepareDurableProcess(durableAttempt!);
      attempt.beforeDispatch(fakeAttemptState(root));
      attemptPath = attempt.path;
      agentStarted.resolve();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error("live durable agent cancelled"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    };
    const api = durableTools(runner);
    const id = await startDurableRun(api);
    const job = workflowJobRegistry.get(id)!;
    await agentStarted.promise;
    const cancel = getTool("cancel_workflow");
    fsFault.failOpenPath = attemptPath + ".cancel";

    await expect(
      cancel.execute(
        "live-first-cancel",
        { workflowId: id },
        undefined,
        undefined,
        harness.ctx,
      ),
    ).rejects.toThrow("injected attempt cancellation write failure");
    expect(fsFault.failures).toBe(1);
    expect(job.abort.signal.aborted).toBe(false);
    expect(job.status).toBe("running");
    await expect(access(attemptPath + ".cancel")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const committed = await WorkflowRunStore.inspect(harness.runScope, id);
    expect(committed?.some((event) => event.kind === "cancelled")).toBe(true);

    const retry = await cancel.execute(
      "live-retry-cancel",
      { workflowId: id },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(retry.details.status).toBe("cancelled");
    expect(job.abort.signal.aborted).toBe(true);
    await Promise.allSettled([job.promise]);
    expect(job.status).toBe("cancelled");
    await expect(access(attemptPath + ".cancel")).resolves.toBeUndefined();
    const afterRetry = await WorkflowRunStore.inspect(harness.runScope, id);
    expect(afterRetry?.some((event) => event.kind === "cancelled")).toBe(true);
    expect(
      afterRetry?.some(
        (event) =>
          event.kind === "terminal" && event.data.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("returns the real interactive cancellation snapshot for a durable process without killing its mux pane", async () => {
    vi.stubEnv("SUBAGENT_CANCEL_SNAPSHOT", "full");
    const stateReady = deferred<InteractiveSubagentState>();
    const killPane = vi.fn();
    const mux: Multiplexer = {
      name: "tmux",
      capabilities: {
        structuredFocus: false,
        boundedCapture: false,
        nativeOverlay: false,
      },
      isAvailable: () => true,
      createPane: () => ({
        paneId: "%recycled-pane",
        windowName: "durable",
        session: "fake",
      }),
      getPaneLiveness: () => "alive",
      getPaneLivenessAsync: async () => "alive",
      getPaneActivityAsync: async () => "inactive",
      sendKeys: vi.fn(),
      sendEnter: vi.fn(() => {
        setImmediate(() => {
          const state = [...harness.scope.interactiveStates.values()][0];
          if (state) stateReady.resolve(state);
        });
      }),
      killPane,
      focusPane: async () => undefined,
      capturePane: async () => ({ output: "", truncated: false }),
      showNativeViewer: async () => false,
      buildAttachCommands: () => ({
        attachCommand: "attach",
        focusCommand: "focus",
      }),
    };
    __setTmuxMultiplexer(mux);
    registerWorkflowTool(harness.pi, harness.scope);

    const started = await getTool("workflow").execute(
      "start-durable-workflow",
      {
        durable: true,
        async: true,
        script:
          'export const meta={name:"snapshot",description:"d"}; return await agent("work", {id:"child"});',
      },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(started.details.status).toBe("started");
    const workflowId = started.details.workflowId;
    if (typeof workflowId !== "string")
      throw new Error("Durable workflow returned no id.");
    const id = workflowId;
    const job = workflowJobRegistry.get(id)!;
    const state = await stateReady.promise;
    await mkdir(state.artifactDir, { recursive: true });
    await writeFile(state.sessionFile, '{"type":"session"}\\n');
    await writeFile(
      join(state.artifactDir, "events.ndjson"),
      '{"type":"turn_started","turnId":"turn-1"}\\n',
    );
    await writeFile(
      join(state.artifactDir, "output.md"),
      "unfinished child output\\n",
    );
    await writeFile(
      join(state.artifactDir, "active-turn.json"),
      '{"turnId":"turn-1"}',
    );

    const cancelled = await getTool("cancel_workflow").execute(
      "cancel-durable-process",
      { workflowId: id },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(cancelled.details.status).toBe("cancelled");
    const receipts = cancelled.details.snapshots;
    const receipt = Array.isArray(receipts)
      ? receipts.find(isInteractiveSnapshotReceipt)
      : undefined;
    if (!receipt)
      throw new Error("Durable cancellation returned no snapshot receipt.");
    expect(receipt).toMatchObject({
      kind: "interactive",
      source: "workflow",
      status: "written",
    });
    expect(receipt.path).toContain(join(root, "snapshots"));
    const content = JSON.parse(
      await readFile(receipt.path, "utf8"),
    ) as InteractiveSnapshotPayload;
    expect(content.kind).toBe("interactive");
    expect(content.cancellation).toMatchObject({
      source: "workflow",
      id: state.id,
    });
    expect(content.files.sessionFile).toMatchObject({
      exists: true,
      bytes: expect.any(Number),
    });
    expect(content.files.sessionFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(content.files.events.exists).toBe(true);
    expect(content.files.output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(killPane).not.toHaveBeenCalled();
    const attemptPath = state.durableWorkflowAttempt;
    if (!attemptPath)
      throw new Error("Durable process attempt was not recorded.");
    await expect(access(attemptPath + ".cancel")).resolves.toBeUndefined();
    await expect(job.promise).rejects.toThrow(/aborted|cancelled|interrupted/i);
  });
});
