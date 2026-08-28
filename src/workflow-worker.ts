import { Worker } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNever,
  eventLogEndOffset,
  isTurnTerminal,
  readEventBatch,
  readOutput,
  readOutputForTurnId,
  type SubagentArtifact,
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
  createSemaphore,
  defaultConcurrency,
  defaultProcessConcurrency,
  extractJson,
  validateSchemaDefinition,
  validateSchema,
  type RunWorkflowOptions,
  type Semaphore,
  type WorkflowAgentOpts,
  type WorkflowAgentRunner,
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
  isPaneAliveAsync,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";

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
  sem: Semaphore;
  processSem: Semaphore;
  loadWorkflow?: (name: string) => string | null;
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
  const engine: Engine = {
    runAgent: opts.runAgent,
    abort,
    signal: abort.signal,
    closed: false,
    onProgress: opts.onProgress,
    onCancellationSnapshot: opts.onCancellationSnapshot,
    sem: createSemaphore(opts.concurrency ?? defaultConcurrency()),
    processSem: createSemaphore(
      opts.processConcurrency ?? defaultProcessConcurrency(),
    ),
    loadWorkflow: opts.loadWorkflow,
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
  }
}

type WorkerRpcRequest = { id: number; method: string; payload: any };
type WorkerRpcResponse = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  tokensDelta: number;
};

class WorkerRpcFailure extends Error {
  readonly tokensDelta: number;
  readonly runnerFailure: { cause: unknown } | undefined;

  constructor(
    error: unknown,
    tokensDelta: number,
    runnerFailure?: { cause: unknown },
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "WorkerRpcFailure";
    this.tokensDelta = tokensDelta;
    this.runnerFailure = runnerFailure;
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
  const runAgentCall = async (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }): Promise<{ value: unknown; tokensDelta: number }> => {
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
    const isolation = agentOpts.isolation ?? "process";
    const isProcess = isolation !== "in-process";
    if (
      agentOpts.reusable !== undefined &&
      typeof agentOpts.reusable !== "boolean"
    ) {
      throw new Error("agent() reusable must be a boolean.");
    }
    if (agentOpts.reusable && hasSchema) {
      throw new Error(
        "agent() reusable cannot be combined with schema because rejected retry attempts cannot retain standalone context safely.",
      );
    }
    if (agentOpts.reusable && !isProcess) {
      throw new Error(
        "agent() reusable requires process isolation; in-process context cannot be promoted to a standalone interactive child.",
      );
    }
    const sem = isProcess ? engine.processSem : engine.sem;
    const resolvedPhase =
      agentOpts.phase != null ? String(agentOpts.phase) : undefined;
    await sem.acquire();
    let tokensDelta = 0;
    let runnerFailure: { cause: unknown } | undefined;
    try {
      let lastErr = "";
      const attempts = hasSchema ? SCHEMA_RETRIES : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (engine.signal?.aborted) throw new Error("Workflow aborted.");
        if (engine.counters.agentsSpawned >= MAX_TOTAL_AGENTS) {
          throw new Error(
            `Workflow exceeded the ${MAX_TOTAL_AGENTS}-agent lifetime cap.`,
          );
        }
        engine.counters.agentsSpawned++;
        const agentId = ++engine.nextAgentAttemptId;
        engine.counters.runningCount++;
        let status: "done" | "error" = "done";
        let agentUsage: WorkflowUsage | undefined;
        let finalModel = agentOpts.model;
        try {
          emit({
            kind: "agent_start",
            label: agentOpts.label,
            phase: resolvedPhase,
            model: agentOpts.model,
            agentId,
          });
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
          const agentRun = Promise.resolve().then(() =>
            engine.runAgent({
              prompt: finalPrompt,
              persona: agentOpts.persona,
              model: agentOpts.model,
              signal: engine.signal,
              isolation,
              label: agentOpts.label,
              ...(hasSchema && !isProcess ? { schema: agentOpts.schema } : {}),
              onCancellationSnapshot: engine.onCancellationSnapshot,
              thinkingLevel: agentOpts.thinkingLevel,
              reusable: agentOpts.reusable,
              onProgress: (ev) => {
                if (ev.liveUsage) activeRun.liveUsage = { ...ev.liveUsage };
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
            }),
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
          if (res.isError) {
            status = "error";
            engine.counters.errorCount++;
            return { value: null, tokensDelta };
          }
          if (!hasSchema) return { value: res.output, tokensDelta };
          if (!isProcess && res.workflowStructuredOutput != null) {
            const schemaCapture = res.workflowStructuredOutput;
            if (!schemaCapture?.called) {
              status = "error";
              lastErr = "No structured_output call found.";
              continue;
            }
            const verrs = validateSchema(schemaCapture.value, agentOpts.schema);
            if (verrs.length === 0)
              return { value: schemaCapture.value, tokensDelta };
            status = "error";
            lastErr = verrs.slice(0, 5).join("; ");
            continue;
          }
          const raw = extractJson(res.output);
          if (raw != null) {
            try {
              const parsed = JSON.parse(raw);
              const verrs = validateSchema(parsed, agentOpts.schema);
              if (verrs.length === 0) return { value: parsed, tokensDelta };
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
      engine.counters.errorCount++;
      emit({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
      });
      return { value: null, tokensDelta };
    } catch (error) {
      throw new WorkerRpcFailure(error, tokensDelta, runnerFailure);
    } finally {
      sem.release();
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
  runAgentCall: (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }) => Promise<{ value: unknown; tokensDelta: number }>,
): Promise<{ meta: WorkflowMeta; result: unknown }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const runnerFailures = new Map<number, unknown>();
    const worker = new Worker(
      new URL("./workflow-worker-thread.mjs", import.meta.url),
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
      runnerFailures.clear();
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
        if (typeof msg.rpcId === "number" && runnerFailures.has(msg.rpcId)) {
          fail(
            new WorkerTerminalFailure(message, runnerFailures.get(msg.rpcId)),
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
        if (err instanceof WorkerRpcFailure && err.runnerFailure) {
          runnerFailures.set(msg.id, err.runnerFailure.cause);
        }
        const error = err instanceof Error ? err.message : String(err);
        const tokensDelta =
          err instanceof WorkerRpcFailure ? err.tokensDelta : 0;
        postWorkerResponse(worker, {
          id: msg.id,
          ok: false,
          error,
          tokensDelta,
        });
      });
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!settled && code !== 0)
        fail(new Error(`Workflow worker exited with code ${code}.`));
    });
    worker.postMessage({
      type: "init",
      script,
      args,
      cwd: engine.cwd,
      budgetTotal: engine.budgetTotal,
      syncTimeoutMs: WORKFLOW_SYNC_TIMEOUT_MS,
      maxItemsPerCall: MAX_ITEMS_PER_CALL,
      maxWorkflowDepth: MAX_WORKFLOW_DEPTH,
    });
  });
}

async function handleWorkerRpc(
  msg: WorkerRpcRequest,
  worker: Worker,
  engine: Engine,
  runAgentCall: (payload: {
    prompt: unknown;
    opts?: WorkflowAgentOpts;
  }) => Promise<{ value: unknown; tokensDelta: number }>,
): Promise<void> {
  if (msg.method === "agent") {
    const response = await runAgentCall(msg.payload);
    postWorkerResponse(worker, {
      id: msg.id,
      ok: true,
      value: response.value,
      tokensDelta: response.tokensDelta,
    });
    return;
  }
  if (msg.method === "loadWorkflow") {
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
    worker.postMessage(msg);
  } catch {
    /* worker may already be terminated after cancellation */
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

interface InteractiveResultEventCursor {
  byteOffset: number;
  activeTurnId?: string;
  sawTurnStart: boolean;
  terminal: TurnTerminalEvent | null;
}

function foldInteractiveResultEvent(
  cursor: InteractiveResultEventCursor,
  event: SubagentEvent,
): void {
  if (event.type === "turn_started") {
    cursor.sawTurnStart = true;
    cursor.activeTurnId = event.turnId;
    cursor.terminal = null;
    return;
  }
  if (cursor.sawTurnStart) {
    if (event.type === "completion" && event.turnId === cursor.activeTurnId) {
      cursor.terminal = event;
    }
    return;
  }
  if (isTurnTerminal(event)) cursor.terminal = event;
}

function readCurrentTurnTerminal(
  art: SubagentArtifact,
  cursor: InteractiveResultEventCursor,
): TurnTerminalEvent | null {
  if (eventLogEndOffset(art) < cursor.byteOffset) {
    cursor.byteOffset = 0;
    cursor.activeTurnId = undefined;
    cursor.sawTurnStart = false;
    cursor.terminal = null;
  }
  for (;;) {
    const batch = readEventBatch(art, cursor.byteOffset);
    for (const record of batch.records) {
      foldInteractiveResultEvent(cursor, record.event);
    }
    if (batch.endOffset <= cursor.byteOffset) break;
    cursor.byteOffset = batch.endOffset;
    if (cursor.byteOffset >= eventLogEndOffset(art)) break;
  }
  return cursor.terminal;
}

/**
 * Await a process-backed sub-agent's owned terminal artifact event, then read the
 * matching immutable `outputs/<eventId>.md` snapshot by turnId. Mutable output.md
 * remains legacy/staging fallback only. Honors abort and dead-pane detection.
 */
export async function awaitInteractiveResult(
  state: InteractiveSubagentState,
  signal: AbortSignal | undefined,
  pollMs = INTERACTIVE_POLL_MS,
  onCancellationSnapshot?: (receipt: CancellationSnapshotReceipt) => void,
): Promise<SubagentResult> {
  const art = artifactFor(state);
  let deadTicks = 0;
  const eventCursor: InteractiveResultEventCursor = {
    byteOffset: 0,
    sawTurnStart: false,
    terminal: null,
  };
  for (;;) {
    let terminal: TurnTerminalEvent | null;
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
    terminal = readCurrentTurnTerminal(art, eventCursor);
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
      alive = await isPaneAliveAsync(state);
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
