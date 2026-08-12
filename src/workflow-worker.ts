import { Worker } from "node:worker_threads";
import { types as utilTypes } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNever,
  isTurnTerminal,
  readEvents,
  readOutput,
  readOutputForTurnId,
  type SubagentEvent,
  type TurnTerminalEvent,
} from "./artifact";
import { debugLog, usageFromAssistantMessages } from "./helpers";
import type { SubagentResult, Usage } from "./helpers";
import {
  INTERACTIVE_DEAD_GRACE_TICKS,
  INTERACTIVE_POLL_MS,
  MAX_ITEMS_PER_CALL,
  MAX_TOTAL_AGENTS,
  MAX_WORKFLOW_DEPTH,
  SCHEMA_RETRIES,
  WORKFLOW_SYNC_TIMEOUT_MS,
  WORKFLOW_WALL_TIMEOUT_MS,
  WORKFLOW_CLONE_LIMITS,
  WORKFLOW_WORKER_RESOURCE_LIMITS,
  extractJson,
  validateSchemaDefinition,
  validateSchema,
  type RunWorkflowOptions,
  type WorkflowAgentOpts,
  type WorkflowAgentRunner,
  type WorkflowDurableAgentDispatchResult,
  type WorkflowMeta,
  type WorkflowProgress,
  type WorkflowProgressUpdate,
  type WorkflowRunResultWithUsage,
  WorkflowExecutionError,
  type WorkflowUsage,
  addWorkflowUsage,
  workflowUsageFromUsage,
  zeroUsage,
  zeroWorkflowUsage,
} from "./workflow-core";
import { workflowStringify } from "./workflow-script";
import {
  cancelInteractiveSubagent,
  isPaneAlive,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";
import { WorkflowAgentDispatcher } from "./workflow-dispatcher";
import {
  WorkflowQuotaError,
  type WorkflowQuotaDimension,
} from "./workflow-quotas";

// ── Engine (shared across nested workflows) ──────────────────────────

interface ActiveAgentRun {
  promise: Promise<SubagentResult>;
  liveUsage?: WorkflowUsage;
  usageAccounted: boolean;
}

interface Engine {
  runAgent: WorkflowAgentRunner;
  abort: AbortController;
  signal: AbortSignal;
  closed: boolean;
  onProgress?: (p: WorkflowProgress) => void;
  onCancellationSnapshot?: RunWorkflowOptions["onCancellationSnapshot"];
  dispatcher: WorkflowAgentDispatcher;
  ownsDispatcher: boolean;
  loadWorkflow?: (name: string) => string | null;
  durableScript?: RunWorkflowOptions["durableScript"];
  cwd: string;
  budgetTotal: number | null;
  workflowTimeoutMs: number;
  counters: {
    agentsSpawned: number;
    errorCount: number;
    /** @deprecated Output-token count; use usage.output. */
    tokensSpent: number;
    runningCount: number;
  };
  nextAgentAttemptId: number;

  usage: WorkflowUsage;
  activeAgentRuns: Set<ActiveAgentRun>;
  phases: string[];
}

function withProgressCounters(
  progress: WorkflowProgressUpdate,
  counters: Engine["counters"],
  usage: WorkflowUsage,
  budgetTotal: number | null,
): WorkflowProgress {
  switch (progress.kind) {
    case "phase":
    case "log":
    case "agent_start":
    case "agent_done":
      return {
        ...progress,
        ...counters,
        budgetTotal,
        usage: { ...usage },
      };
    default:
      return assertNever(progress);
  }
}

function usageIfPresent(usage: WorkflowUsage): WorkflowUsage | undefined {
  if (
    usage.totalTokens === 0 &&
    usage.costUsd === 0 &&
    usage.turns === 0 &&
    usage.costSource === undefined
  ) {
    return undefined;
  }
  return { ...usage };
}

function usageAsProjectUsage(usage: WorkflowUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.costUsd,
    ...(usage.costSource ? { costSource: usage.costSource } : {}),
    turns: usage.turns,
  };
}

function accountAgentUsage(
  engine: Engine,
  run: ActiveAgentRun,
  usage: Usage | undefined,
): void {
  if (run.usageAccounted || !usage) return;
  const previousOutput = engine.usage.output;
  const aggregate = addWorkflowUsage(engine.usage, usage);
  engine.counters.tokensSpent += aggregate.output - previousOutput;
  engine.usage = aggregate;
  run.usageAccounted = true;
}

function captureActiveAgentUsage(engine: Engine): void {
  for (const run of engine.activeAgentRuns) {
    accountAgentUsage(
      engine,
      run,
      run.liveUsage ? usageAsProjectUsage(run.liveUsage) : undefined,
    );
  }
}

async function drainActiveAgentRuns(engine: Engine): Promise<void> {
  const pending = [...engine.activeAgentRuns].map((run) => run.promise);
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
  captureActiveAgentUsage(engine);
}

function workflowFailureCause(
  error: unknown,
  signal: AbortSignal | undefined,
): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason;
  if (error instanceof WorkerTerminalFailure) return error.originalCause;
  return error;
}

export async function runWorkflow(
  script: string,
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResultWithUsage> {
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(opts.signal?.reason);
  if (opts.signal?.aborted) {
    abort.abort(opts.signal.reason);
  } else {
    opts.signal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const dispatcher =
    opts.dispatcher ??
    new WorkflowAgentDispatcher({
      concurrency: opts.concurrency,
      processConcurrency: opts.processConcurrency,
    });
  const engine: Engine = {
    runAgent: opts.runAgent,
    abort,
    signal: abort.signal,
    closed: false,
    onProgress: opts.onProgress,
    onCancellationSnapshot: opts.onCancellationSnapshot,
    dispatcher,
    ownsDispatcher: opts.dispatcher === undefined,
    loadWorkflow: opts.loadWorkflow,
    durableScript: opts.durableScript,
    cwd: opts.cwd ?? process.cwd(),
    budgetTotal: opts.budgetTotal ?? null,
    counters: {
      agentsSpawned: 0,
      errorCount: 0,
      tokensSpent: 0,
      runningCount: 0,
    },
    nextAgentAttemptId: 0,

    usage: zeroWorkflowUsage(),
    activeAgentRuns: new Set(),
    workflowTimeoutMs: opts.workflowTimeoutMs ?? WORKFLOW_WALL_TIMEOUT_MS,
    phases: [],
  };
  try {
    const { meta, result } = await executeScript(script, engine, opts.args, 0);
    return {
      meta,
      result,
      agentsSpawned: engine.counters.agentsSpawned,
      errorCount: engine.counters.errorCount,
      tokensSpent: engine.counters.tokensSpent,
      usage: { ...engine.usage },
      phases: [...engine.phases],
    };
  } catch (error) {
    const cause = workflowFailureCause(error, opts.signal);
    if (!abort.signal.aborted) abort.abort(error);
    await drainActiveAgentRuns(engine);
    if (error instanceof WorkflowExecutionError && error.usage) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowExecutionError(
      message,
      usageIfPresent(engine.usage),
      cause,
    );
  } finally {
    opts.signal?.removeEventListener("abort", forwardAbort);
    if (engine.ownsDispatcher) {
      engine.dispatcher.close();
    }
  }
}

type WorkerRpcRequest = { id: number; method: string; payload: any };
type WorkerRpcResponse = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  tokensDelta: number;
  fatal?: boolean;
};

type WorkerAgentCall = (
  payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  },
  gateRequest?: Parameters<WorkflowAgentRunner>[0],
) => Promise<WorkflowDurableAgentDispatchResult>;

class WorkerRpcFailure extends Error {
  readonly tokensDelta: number;
  readonly runnerFailure: { cause: unknown } | undefined;
  readonly originalCause: unknown;
  readonly usage: Usage;

  constructor(
    error: unknown,
    tokensDelta: number,
    runnerFailure: { cause: unknown } | undefined,
    usage: Usage,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "WorkerRpcFailure";
    this.originalCause = error;
    this.tokensDelta = tokensDelta;
    this.runnerFailure = runnerFailure;
    this.usage = usage;
  }
}

class WorkerTerminalFailure extends Error {
  readonly originalCause: unknown;

  constructor(message: string, originalCause: unknown) {
    super(message);
    this.name = "WorkerTerminalFailure";
    this.originalCause = originalCause;
  }
}

class WorkerCloneTransferFailure extends Error {
  readonly originalCause: unknown;

  constructor(label: string, originalCause: unknown) {
    const detail =
      originalCause instanceof Error
        ? originalCause.message
        : "structured clone rejected the payload";
    super(`Unable to transfer bounded ${label}: ${detail.slice(0, 512)}`, {
      cause: originalCause,
    });
    this.name = "WorkerCloneTransferFailure";
    this.originalCause = originalCause;
  }
}

function boundedWorkerErrorMessage(error: unknown): string {
  let message: string;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "Workflow RPC failed with an unprintable error.";
  }
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
}

const CLONE_QUOTA_DIMENSIONS = {
  maxDepth: "maxValueDepth",
  maxNodes: "maxValueNodes",
  maxStringBytes: "maxValueStringBytes",
  maxBytes: "maxValueBytes",
} as const satisfies Record<
  keyof typeof WORKFLOW_CLONE_LIMITS,
  WorkflowQuotaDimension
>;

function assertBoundedWorkerClone(root: unknown, label: string): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  let bytes = 0;

  const fail = (
    dimension: keyof typeof WORKFLOW_CLONE_LIMITS,
    actual: number,
  ): never => {
    throw new WorkflowQuotaError(
      CLONE_QUOTA_DIMENSIONS[dimension],
      WORKFLOW_CLONE_LIMITS[dimension],
      actual,
    );
  };
  const consumeBytes = (amount: number): void => {
    bytes += amount;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > WORKFLOW_CLONE_LIMITS.maxBytes
    ) {
      fail("maxBytes", bytes);
    }
  };
  const consumeString = (value: string): void => {
    const stringBytes = Buffer.byteLength(value, "utf8");
    if (stringBytes > WORKFLOW_CLONE_LIMITS.maxStringBytes) {
      fail("maxStringBytes", stringBytes);
    }
    consumeBytes(stringBytes + 2);
  };
  const enqueue = (value: unknown, depth: number): void => {
    const projectedNodes = nodes + stack.length + 1;
    if (projectedNodes > WORKFLOW_CLONE_LIMITS.maxNodes) {
      fail("maxNodes", projectedNodes);
    }
    if (depth > WORKFLOW_CLONE_LIMITS.maxDepth) fail("maxDepth", depth);
    stack.push({ value, depth });
  };
  const unsupported = (detail: string): never => {
    throw new TypeError(`${detail} in ${label} structured-clone payload.`);
  };

  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > WORKFLOW_CLONE_LIMITS.maxNodes) fail("maxNodes", nodes);
    if (depth > WORKFLOW_CLONE_LIMITS.maxDepth) fail("maxDepth", depth);

    if (value === null || value === undefined) {
      consumeBytes(4);
      continue;
    }
    switch (typeof value) {
      case "boolean":
        consumeBytes(5);
        continue;
      case "number":
        consumeBytes(8);
        continue;
      case "string":
        consumeString(value);
        continue;
      case "bigint":
      case "symbol":
      case "function":
        unsupported(`Unsupported ${typeof value}`);
      case "object":
        break;
      default:
        unsupported("Unsupported value");
    }

    if (seen.has(value)) {
      consumeBytes(4);
      continue;
    }
    seen.add(value);
    if (utilTypes.isProxy(value)) unsupported("Proxy value");

    if (utilTypes.isAnyArrayBuffer(value)) {
      consumeBytes(value.byteLength);
      continue;
    }
    if (utilTypes.isArrayBufferView(value)) {
      consumeBytes(8);
      enqueue(value.buffer, depth + 1);
      continue;
    }
    if (utilTypes.isDate(value)) {
      consumeBytes(8);
      continue;
    }
    if (utilTypes.isRegExp(value)) {
      const sourceDescriptor = Object.getOwnPropertyDescriptor(
        RegExp.prototype,
        "source",
      );
      if (typeof sourceDescriptor?.get !== "function") {
        throw new TypeError(
          `Uninspectable RegExp in ${label} structured-clone payload.`,
        );
      }
      const source = sourceDescriptor.get.call(value);
      if (typeof source !== "string") {
        throw new TypeError(
          `Invalid RegExp source in ${label} structured-clone payload.`,
        );
      }
      consumeString(source);
      consumeBytes(8);
      continue;
    }
    if (utilTypes.isMap(value)) {
      consumeBytes(2);
      for (const [key, entryValue] of Map.prototype.entries.call(value)) {
        enqueue(entryValue, depth + 1);
        enqueue(key, depth + 1);
      }
      continue;
    }
    if (utilTypes.isSet(value)) {
      consumeBytes(2);
      for (const entryValue of Set.prototype.values.call(value)) {
        enqueue(entryValue, depth + 1);
      }
      continue;
    }
    if (
      utilTypes.isNativeError(value) ||
      utilTypes.isPromise(value) ||
      utilTypes.isWeakMap(value) ||
      utilTypes.isWeakSet(value)
    ) {
      unsupported("Unsupported object");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") {
        throw new TypeError(`Symbol key in ${label} structured-clone payload.`);
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      consumeString(key);
      if (!("value" in descriptor)) unsupported("Accessor");
      enqueue(descriptor.value, depth + 1);
    }
    consumeBytes(2);
  }
}

async function executeScript(
  script: string,
  engine: Engine,
  args: unknown,
  _depth: number,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  const emit = (p: WorkflowProgressUpdate) => {
    if (engine.closed) return;
    if (p.kind === "phase" && p.phase) {
      engine.phases.push(p.phase);
    }
    engine.onProgress?.(
      withProgressCounters(
        p,
        engine.counters,
        engine.usage,
        engine.budgetTotal,
      ),
    );
  };
  const runAgentCall = async (
    payload: {
      prompt: unknown;
      opts?: WorkflowAgentOpts;
    },
    gateRequest?: Parameters<WorkflowAgentRunner>[0],
  ): Promise<WorkflowDurableAgentDispatchResult> => {
    if (typeof payload.prompt !== "string" || payload.prompt.trim() === "") {
      throw new Error("agent(prompt): prompt must be a non-empty string.");
    }

    const prompt = payload.prompt;
    const agentOpts = payload.opts ?? {};
    const hasSchema = agentOpts.schema != null;
    if (hasSchema) {
      const schemaValidation = validateSchemaDefinition(agentOpts.schema);
      if (schemaValidation.length > 0) {
        throw new Error(
          `Invalid workflow schema: ${schemaValidation.join("; ")}`,
        );
      }
    }
    const isolation =
      gateRequest?.isolation ?? agentOpts.isolation ?? "process";
    const effectiveModel = gateRequest?.model ?? agentOpts.model;
    const isProcess = isolation !== "in-process";
    const resolvedPhase =
      agentOpts.phase != null ? String(agentOpts.phase) : undefined;
    let tokensDelta = 0;
    let operationUsage = zeroWorkflowUsage();
    let runnerFailure: { cause: unknown } | undefined;
    try {
      let lastErr = "";
      const attempts = hasSchema ? SCHEMA_RETRIES : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (engine.signal?.aborted) throw new Error("Workflow aborted.");
        let agentId: number | undefined;
        let runnerStarted = false;
        let status: "done" | "error" = "done";
        let agentUsage: WorkflowUsage | undefined;
        let finalModel = effectiveModel;
        try {
          const finalPrompt = hasSchema
            ? isProcess
              ? buildProcessSchemaPrompt(
                  prompt,
                  agentOpts.schema,
                  attempt,
                  lastErr,
                )
              : buildInProcessSchemaPrompt(prompt, attempt, lastErr)
            : prompt;
          let res: SubagentResult;
          const activeRun: ActiveAgentRun = {
            promise: undefined as unknown as Promise<SubagentResult>,
            usageAccounted: false,
          };
          const agentRun = engine.dispatcher.run(
            {
              ...gateRequest,
              prompt: finalPrompt,
              persona: gateRequest?.persona ?? agentOpts.persona,
              model: effectiveModel,
              signal: engine.signal,
              isolation,
              label: gateRequest?.label ?? agentOpts.label,
              ...(hasSchema && !isProcess ? { schema: agentOpts.schema } : {}),
              onCancellationSnapshot: engine.onCancellationSnapshot,
              thinkingLevel: agentOpts.thinkingLevel,
              onProgress: (ev) => {
                if (ev.liveUsage) activeRun.liveUsage = { ...ev.liveUsage };
                gateRequest?.onProgress?.(ev);
                if (ev.kind === "phase") {
                  if (ev.phase) {
                    emit({
                      ...ev,
                      phase: resolvedPhase ?? ev.phase,
                      agentId,
                    });
                  }
                  return;
                }
                emit({
                  ...ev,
                  phase: resolvedPhase ?? ev.phase,
                  agentId,
                });
              },
            },
            async (request: Parameters<WorkflowAgentRunner>[0]) => {
              if (engine.signal.aborted) throw new Error("Workflow aborted.");
              if (engine.counters.agentsSpawned >= MAX_TOTAL_AGENTS) {
                throw new Error(
                  `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
                );
              }
              engine.counters.agentsSpawned++;
              agentId = ++engine.nextAgentAttemptId;
              engine.counters.runningCount++;
              runnerStarted = true;
              emit({
                kind: "agent_start",
                label: agentOpts.label,
                phase: resolvedPhase,
                model: effectiveModel,
                agentId,
              });
              return engine.runAgent(request);
            },
          );
          activeRun.promise = agentRun;
          engine.activeAgentRuns.add(activeRun);
          try {
            try {
              res = await agentRun;
              finalModel = res.model ?? agentOpts.model;
            } catch (error) {
              const errorUsage = (error as { usage?: Usage } | null)?.usage;
              const terminalAgentUsage = workflowUsageFromUsage(errorUsage);
              const partialUsage =
                terminalAgentUsage !== undefined
                  ? errorUsage
                  : activeRun.liveUsage
                    ? usageAsProjectUsage(activeRun.liveUsage)
                    : undefined;
              agentUsage =
                terminalAgentUsage ?? workflowUsageFromUsage(partialUsage);
              tokensDelta += agentUsage?.output ?? 0;
              accountAgentUsage(engine, activeRun, partialUsage);
              operationUsage = addWorkflowUsage(operationUsage, partialUsage);
              status = "error";
              runnerFailure = { cause: error };
              if (!engine.signal.aborted) engine.counters.errorCount++;
              throw error;
            }
          } finally {
            engine.activeAgentRuns.delete(activeRun);
          }
          agentUsage = workflowUsageFromUsage(res.usage);
          const outTokens = agentUsage?.output ?? 0;
          tokensDelta += outTokens;
          accountAgentUsage(engine, activeRun, res.usage);
          operationUsage = addWorkflowUsage(operationUsage, res.usage);
          if (res.isError) {
            status = "error";
            engine.counters.errorCount++;
            return {
              value: null,
              tokensDelta,
              usage: usageAsProjectUsage(operationUsage),
            };
          }
          if (res.cancelled) {
            return {
              value: res.output,
              tokensDelta,
              usage: usageAsProjectUsage(operationUsage),
              cancelled: true,
            };
          }
          if (!hasSchema)
            return {
              value: res.output,
              tokensDelta,
              usage: usageAsProjectUsage(operationUsage),
            };
          if (!isProcess && res.workflowStructuredOutput != null) {
            const schemaCapture = res.workflowStructuredOutput;
            if (!schemaCapture?.called) {
              status = "error";
              lastErr = "No structured_output call found.";
              continue;
            }
            const verrs = validateSchema(schemaCapture.value, agentOpts.schema);
            if (verrs.length === 0)
              return {
                value: schemaCapture.value,
                tokensDelta,
                usage: usageAsProjectUsage(operationUsage),
              };
            status = "error";
            lastErr = verrs.slice(0, 5).join("; ");
            continue;
          }
          const raw = extractJson(res.output);
          if (raw != null) {
            try {
              const parsed = JSON.parse(raw);
              const verrs = validateSchema(parsed, agentOpts.schema);
              if (verrs.length === 0)
                return {
                  value: parsed,
                  tokensDelta,
                  usage: usageAsProjectUsage(operationUsage),
                };
              status = "error";
              lastErr = verrs.slice(0, 5).join("; ");
            } catch (e) {
              status = "error";
              lastErr = `JSON parse error: ${
                e instanceof Error ? e.message : String(e)
              }`;
            }
          } else {
            status = "error";
            lastErr = "no JSON object/array found in output";
          }
        } finally {
          if (runnerStarted) {
            engine.counters.runningCount--;
            emit({
              kind: "agent_done",
              label: agentOpts.label,
              phase: resolvedPhase,
              model: finalModel,
              status,
              agentId,
              agentUsage,
            });
          }
        }
      }
      engine.counters.errorCount++;
      emit({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
      });
      return {
        value: null,
        tokensDelta,
        usage: usageAsProjectUsage(operationUsage),
      };
    } catch (error) {
      throw new WorkerRpcFailure(
        error,
        tokensDelta,
        runnerFailure,
        usageAsProjectUsage(operationUsage),
      );
    }
  };

  return runWorkflowWorker(script, args, engine, emit, runAgentCall);
}

function loadWorkflowRef(nameOrRef: unknown, engine: Engine): string | null {
  if (typeof nameOrRef === "string") {
    return engine.loadWorkflow ? engine.loadWorkflow(nameOrRef) : null;
  }
  throw new Error(
    "workflow(nameOrRef): expected a saved-workflow name string.",
  );
}

function runWorkflowWorker(
  script: string,
  args: unknown,
  engine: Engine,
  emit: (p: WorkflowProgressUpdate) => void,
  runAgentCall: WorkerAgentCall,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  const initMessage = {
    type: "init",
    script,
    args,
    cwd: engine.cwd,
    budgetTotal: engine.budgetTotal,
    syncTimeoutMs: WORKFLOW_SYNC_TIMEOUT_MS,
    maxItemsPerCall: MAX_ITEMS_PER_CALL,
    maxWorkflowDepth: MAX_WORKFLOW_DEPTH,
    cloneLimits: WORKFLOW_CLONE_LIMITS,
    durable:
      engine.durableScript === undefined
        ? null
        : {
            rootDefinitionPath: engine.durableScript.rootDefinitionPath,
          },
  };
  assertBoundedWorkerClone(initMessage, "workflow initialization");
  return new Promise((resolve, reject) => {
    let settled = false;
    const terminalFailures = new Map<number, unknown>();
    const worker = new Worker(
      new URL("./workflow-worker-thread.mjs", import.meta.url),
      { resourceLimits: WORKFLOW_WORKER_RESOURCE_LIMITS },
    );
    const terminateWorker = () => {
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        /* worker may already be dead */
      }
      worker.terminate().catch(() => {});
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      engine.closed = true;
      cleanup();
      terminateWorker();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const done = (value: { meta: WorkflowMeta; result: unknown }) => {
      if (settled) return;
      settled = true;
      engine.closed = true;
      cleanup();
      terminateWorker();
      resolve(value);
    };
    const onAbort = () => fail(new Error("Workflow aborted."));
    const timeout = setTimeout(() => {
      const err = new Error(
        `Workflow timed out after ${engine.workflowTimeoutMs}ms; the worker was terminated.`,
      );
      fail(err);
      engine.abort.abort(err);
    }, engine.workflowTimeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      engine.signal.removeEventListener("abort", onAbort);
      terminalFailures.clear();
      worker.removeAllListeners();
    };

    engine.signal?.addEventListener("abort", onAbort, { once: true });
    if (engine.signal?.aborted) {
      onAbort();
      return;
    }

    worker.on("message", (msg: WorkerRpcRequest | WorkerRpcResponse | any) => {
      if (settled || !msg || typeof msg !== "object") return;
      if (msg.type === "result") {
        done(msg.value);
        return;
      }
      if (msg.type === "error") {
        const message = String(msg.error ?? "Workflow worker failed.");
        if (typeof msg.rpcId === "number" && terminalFailures.has(msg.rpcId)) {
          fail(
            new WorkerTerminalFailure(message, terminalFailures.get(msg.rpcId)),
          );
        } else {
          fail(new Error(message));
        }
        return;
      }
      if (msg.type === "progress") {
        emit(msg.payload);
        return;
      }
      if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
      handleWorkerRpc(
        msg as WorkerRpcRequest,
        worker,
        engine,
        runAgentCall,
      ).catch((err) => {
        if (settled) return;
        const fatal =
          engine.durableScript !== undefined ||
          err instanceof WorkflowQuotaError ||
          err instanceof WorkerCloneTransferFailure;
        if (err instanceof WorkerRpcFailure && err.runnerFailure) {
          terminalFailures.set(msg.id, err.runnerFailure.cause);
        } else if (fatal) {
          const originalCause =
            err instanceof WorkerRpcFailure
              ? err.originalCause
              : err instanceof WorkerCloneTransferFailure
                ? err.originalCause
                : err;
          terminalFailures.set(msg.id, originalCause);
        }
        const tokensDelta =
          err instanceof WorkerRpcFailure ? err.tokensDelta : 0;
        try {
          postWorkerResponse(worker, {
            id: msg.id,
            ok: false,
            error: boundedWorkerErrorMessage(err),
            tokensDelta,
            fatal,
          });
        } catch (responseError) {
          fail(responseError);
        }
      });
    });
    worker.on("error", (error) => {
      const errorCode =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (errorCode === "ERR_WORKER_OUT_OF_MEMORY") {
        fail(
          new Error(
            `Workflow worker exceeded its ${WORKFLOW_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb} MiB old-generation memory limit.`,
            { cause: error },
          ),
        );
        return;
      }
      fail(error);
    });
    worker.on("exit", (code) => {
      if (!settled && code !== 0)
        fail(new Error(`Workflow worker exited with code ${code}.`));
    });
    try {
      worker.postMessage(initMessage);
    } catch (error) {
      fail(new WorkerCloneTransferFailure("workflow initialization", error));
    }
  });
}

async function handleWorkerRpc(
  msg: WorkerRpcRequest,
  worker: Worker,
  engine: Engine,
  runAgentCall: WorkerAgentCall,
): Promise<void> {
  if (msg.method === "agent") {
    let response: WorkflowDurableAgentDispatchResult;
    if (engine.durableScript === undefined) {
      response = await runAgentCall(msg.payload);
    } else {
      const requestedModel = msg.payload?.opts?.model;
      const effectiveModel =
        engine.runAgent.resolveModel?.(requestedModel) ?? requestedModel;
      response = await engine.durableScript.runAgent(
        { ...msg.payload, effectiveModel },
        (request) => runAgentCall(msg.payload, request),
      );
    }
    postWorkerResponse(worker, {
      id: msg.id,
      ok: true,
      value: response.value,
      tokensDelta: response.tokensDelta,
    });
    return;
  }
  if (msg.method === "completeWorkflow") {
    if (engine.durableScript === undefined) {
      throw new Error(
        "completeWorkflow is only available to durable workflow runs.",
      );
    }
    const value = await engine.durableScript.completeWorkflow(
      msg.payload?.workflow,
      msg.payload?.completion,
    );
    postWorkerResponse(worker, {
      id: msg.id,
      ok: true,
      value,
      tokensDelta: 0,
    });
    return;
  }
  if (msg.method === "loadWorkflow") {
    if (engine.durableScript !== undefined) {
      const loaded = await engine.durableScript.loadWorkflow(
        msg.payload,
        (name) => loadWorkflowRef(name, engine),
      );
      postWorkerResponse(worker, {
        id: msg.id,
        ok: true,
        value: loaded,
        tokensDelta: 0,
      });
      return;
    }
    const script = loadWorkflowRef(msg.payload, engine);
    if (script == null && typeof msg.payload === "string") {
      throw new Error(`workflow(): no saved workflow named "${msg.payload}".`);
    }
    postWorkerResponse(worker, {
      id: msg.id,
      ok: true,
      value: script,
      tokensDelta: 0,
    });
    return;
  }
  throw new Error(`Unknown workflow worker RPC method: ${msg.method}`);
}

function postWorkerResponse(worker: Worker, msg: WorkerRpcResponse): void {
  try {
    assertBoundedWorkerClone(msg, "workflow RPC response");
    worker.postMessage(msg);
  } catch (error) {
    if (error instanceof WorkflowQuotaError) throw error;
    if (error instanceof WorkerCloneTransferFailure) throw error;
    throw new WorkerCloneTransferFailure("workflow RPC response", error);
  }
}

export function stringify(x: unknown): string {
  return workflowStringify(x);
}

function buildProcessSchemaPrompt(
  prompt: string,
  schema: unknown,
  attempt: number,
  lastErr: string,
): string {
  const schemaText = JSON.stringify(schema, null, 2);
  const retry =
    attempt > 0
      ? `\n\nYour previous response did not satisfy the schema (${lastErr}). Return corrected JSON only.`
      : "";
  return (
    `${prompt}\n\n` +
    `Respond with ONLY a single JSON value that conforms to this JSON Schema. ` +
    `No prose, no markdown fences, no commentary.\n\nJSON Schema:\n${schemaText}${retry}`
  );
}
function buildInProcessSchemaPrompt(
  prompt: string,
  attempt: number,
  lastErr: string,
): string {
  const retry =
    attempt > 0
      ? `\n\nYour previous response did not include a valid structured_output call (${lastErr}). Retry using a single tool call.`
      : "";
  return (
    `${prompt}${retry}` +
    `\n\nUse the structured_output tool as your ONLY final action.`
  );
}

// ── tmux/zellij process-backed agents ────────────────────────────────

/** Build a SubagentArtifact view over an interactive sub-agent's on-disk artifact dir. */
function artifactFor(state: InteractiveSubagentState) {
  return {
    id: state.id,
    dir: state.artifactDir,
    statusFile: join(state.artifactDir, "events.ndjson"),
    outputFile: join(state.artifactDir, "output.md"),
  };
}

/**
 * Parse token usage from a child Pi's session JSONL file.
 * Reads assistant messages with `usage` data and aggregates them,
 * mirroring the in-process path in helpers.ts.
 * Returns zeroUsage() if the file is missing, unparseable, or has no usage data.
 */
function parseUsageFromSessionFile(sessionFile: string | undefined): Usage {
  try {
    if (!sessionFile || !existsSync(sessionFile)) return zeroUsage();
    const raw = readFileSync(sessionFile, "utf8");
    const messages: unknown[] = [];
    for (const line of raw.split("\n").filter((l) => l.trim())) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "message" && entry.message) {
          messages.push(entry.message);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return usageFromAssistantMessages(messages, zeroUsage());
  } catch {
    return zeroUsage();
  }
}

function findCurrentTurnTerminal(
  events: SubagentEvent[],
): TurnTerminalEvent | null {
  let latestTurnStart = -1;
  let latestTurnId: string | undefined;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === "turn_started") {
      latestTurnStart = index;
      latestTurnId = event.turnId;
    }
  }
  if (latestTurnStart >= 0) {
    for (let index = events.length - 1; index > latestTurnStart; index--) {
      const event = events[index];
      if (event.type === "completion" && event.turnId === latestTurnId) {
        return event;
      }
    }
    return null;
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (isTurnTerminal(event)) return event;
  }
  return null;
}

/**
 * Await a process-backed (tmux/zellij) sub-agent's terminal event by polling its artifact dir,
 * then read its output.md. Honors the abort signal and detects a dead pane that never completed.
 */
export async function awaitInteractiveResult(
  state: InteractiveSubagentState,
  signal: AbortSignal | undefined,
  pollMs = INTERACTIVE_POLL_MS,
  onCancellationSnapshot?: (receipt: CancellationSnapshotReceipt) => void,
): Promise<SubagentResult> {
  const art = artifactFor(state);
  let deadTicks = 0;
  for (;;) {
    if (signal?.aborted) {
      try {
        const cancelled = cancelInteractiveSubagent(
          state.id,
          "workflow",
          state,
        );
        if (cancelled?.cancellationSnapshot) {
          onCancellationSnapshot?.(cancelled.cancellationSnapshot);
        }
      } catch {
        /* best effort */
      }
      const cancellationUsage = parseUsageFromSessionFile(state.sessionFile);
      return {
        isError: true,
        output: "",
        usage: cancellationUsage,
        errorMessage: "aborted",
      };
    }
    const events = readEvents(art);
    const terminal = findCurrentTurnTerminal(events);
    if (terminal) {
      const usage = parseUsageFromSessionFile(state.sessionFile);
      switch (terminal.type) {
        case "completion":
          switch (terminal.outcome) {
            case "done":
              return {
                isError: false,
                output:
                  readOutputForTurnId(art, terminal.turnId) ?? "(no output)",
                usage,
                ...(state.model !== undefined ? { model: state.model } : {}),
              };
            case "error":
            case "cancelled":
              return {
                isError: true,
                output:
                  readOutputForTurnId(art, terminal.turnId) ?? "(no output)",
                usage,
                errorMessage:
                  terminal.errorMessage ??
                  terminal.message ??
                  `interactive sub-agent ${terminal.outcome}`,
              };
            default:
              return assertNever(terminal.outcome);
          }
        case "done":
          return {
            isError: false,
            output: readOutput(art) ?? "(no output)",
            usage,
            ...(state.model !== undefined ? { model: state.model } : {}),
          };
        case "error":
        case "cancelled":
          return {
            isError: true,
            output: readOutput(art) ?? "(no output)",
            usage,
            errorMessage:
              terminal.message ?? `interactive sub-agent ${terminal.type}`,
          };
        default:
          return assertNever(terminal);
      }
    }
    // No terminal event yet — if the pane has died, give it a few grace ticks for a final flush.
    let alive = true;
    try {
      alive = isPaneAlive(state);
    } catch {
      alive = false;
    }
    if (!alive) {
      deadTicks++;
      debugLog("warn", "interactive_dead_pane", {
        deadTicks,
        graceLimit: INTERACTIVE_DEAD_GRACE_TICKS,
      });
      if (deadTicks >= INTERACTIVE_DEAD_GRACE_TICKS) {
        const output = readOutput(art) ?? "(no output)";
        return {
          isError: true,
          output,
          usage: parseUsageFromSessionFile(state.sessionFile),
          errorMessage: "interactive sub-agent pane exited before completing",
        };
      }
    } else {
      deadTicks = 0;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, pollMs);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
