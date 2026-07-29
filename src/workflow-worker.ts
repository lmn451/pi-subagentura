import { Worker } from "node:worker_threads";
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
import { debugLog } from "./helpers";
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
  zeroUsage,
  zeroWorkflowUsage,
} from "./workflow-core";
import { workflowStringify } from "./workflow-script";
import {
  advanceInteractiveState,
  cancelInteractiveSubagent,
  getInteractiveMachineState,
  observeInteractivePane,
  type InteractiveSubagentState,
} from "./interactive-tmux";
import type { CancellationSnapshotReceipt } from "./cancellation-snapshots";

// ── Engine (shared across nested workflows) ──────────────────────────

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
    /** @deprecated Output-token count; use usage.totalTokens. */
    tokensSpent: number;
    runningCount: number;
  };
  nextAgentAttemptId: number;

  usage: WorkflowUsage;
  failureCause?: unknown;
  phases: string[];
}

function withProgressCounters(
  progress: WorkflowProgressUpdate,
  counters: Engine["counters"],
  usage: WorkflowUsage,
): WorkflowProgress {
  switch (progress.kind) {
    case "phase":
    case "log":
    case "agent_start":
    case "agent_done":
      return { ...progress, ...counters, usage: { ...usage } };
    default:
      return assertNever(progress);
  }
}

function usageIfPresent(usage: WorkflowUsage): WorkflowUsage | undefined {
  if (usage.totalTokens === 0 && usage.costUsd === 0 && usage.turns === 0) {
    return undefined;
  }
  return { ...usage };
}

function workflowFailureCause(
  error: unknown,
  engine: Engine,
  signal: AbortSignal | undefined,
): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason;
  const candidate = engine.failureCause;
  if (candidate !== undefined) {
    const message =
      candidate instanceof Error ? candidate.message : String(candidate);
    if (error instanceof Error && error.message.includes(message))
      return candidate;
  }
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
    if (error instanceof WorkflowExecutionError && error.usage) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowExecutionError(
      message,
      usageIfPresent(engine.usage),
      workflowFailureCause(error, engine, opts.signal),
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
};

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
    engine.onProgress?.(withProgressCounters(p, engine.counters, engine.usage));
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
    const sem = isProcess ? engine.processSem : engine.sem;
    const resolvedPhase =
      agentOpts.phase != null ? String(agentOpts.phase) : undefined;
    await sem.acquire();
    let tokensDelta = 0;
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
          try {
            res = await engine.runAgent({
              prompt: finalPrompt,
              persona: agentOpts.persona,
              model: agentOpts.model,
              signal: engine.signal,
              isolation,
              label: agentOpts.label,
              ...(hasSchema && !isProcess ? { schema: agentOpts.schema } : {}),
              onCancellationSnapshot: engine.onCancellationSnapshot,
              thinkingLevel: agentOpts.thinkingLevel,
              onProgress: (ev) => {
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
            });
          } catch (error) {
            status = "error";
            engine.failureCause = error;
            if (!engine.signal.aborted) engine.counters.errorCount++;
            throw error;
          }
          const outTokens = res.usage?.output ?? 0;
          tokensDelta += outTokens;
          engine.usage = addWorkflowUsage(engine.usage, res.usage);
          engine.counters.tokensSpent += outTokens;
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
            model: agentOpts.model,
            status,
            agentId,
          });
        }
      }
      engine.counters.errorCount++;
      emit({
        kind: "log",
        message: `agent(schema) failed after ${attempts} attempts: ${lastErr}`,
      });
      return { value: null, tokensDelta };
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
        fail(new Error(String(msg.error ?? "Workflow worker failed.")));
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
        const error = err instanceof Error ? err.message : String(err);
        postWorkerResponse(worker, { id: msg.id, ok: false, error });
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
    const value = await runAgentCall(msg.payload);
    postWorkerResponse(worker, { id: msg.id, ok: true, value });
    return;
  }
  if (msg.method === "loadWorkflow") {
    const script = loadWorkflowRef(msg.payload, engine);
    if (script == null && typeof msg.payload === "string") {
      throw new Error(`workflow(): no saved workflow named "${msg.payload}".`);
    }
    postWorkerResponse(worker, { id: msg.id, ok: true, value: script });
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
    const lines = raw.split("\n").filter((l) => l.trim());
    const usage: Usage = { ...zeroUsage() };
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "message") continue;
        const msg = entry.message;
        if (msg?.role !== "assistant" || !msg?.usage) continue;
        const u = msg.usage;
        usage.turns++;
        usage.input += u.input ?? 0;
        usage.output += u.output ?? 0;
        usage.cacheRead += u.cacheRead ?? 0;
        usage.cacheWrite += u.cacheWrite ?? 0;
        if (u.cost?.total != null) usage.cost += u.cost.total;
      } catch {
        /* skip malformed lines */
      }
    }
    return usage;
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
        const cancelled = cancelInteractiveSubagent(state.id, "workflow");
        if (cancelled?.cancellationSnapshot) {
          onCancellationSnapshot?.(cancelled.cancellationSnapshot);
        }
      } catch {
        /* best effort */
      }
      return {
        isError: true,
        output: "",
        usage: zeroUsage(),
        model: undefined,
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
                model: state.model ?? "process",
              };
            case "error":
            case "cancelled":
              return {
                isError: true,
                output:
                  readOutputForTurnId(art, terminal.turnId) ?? "(no output)",
                usage,
                model: undefined,
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
            model: state.model ?? "process",
          };
        case "error":
        case "cancelled":
          return {
            isError: true,
            output: readOutput(art) ?? "(no output)",
            usage,
            model: undefined,
            errorMessage:
              terminal.message ?? `interactive sub-agent ${terminal.type}`,
          };
        default:
          return assertNever(terminal);
      }
    }
    // No terminal event yet — only a confirmed dead pane advances the grace
    // counter. Unavailable or unknown observation cannot prove process death.
    const started = advanceInteractiveState(state, {
      type: "pane_observation_started",
    });
    const revision =
      started.kind === "applied"
        ? started.state.observationRevision
        : getInteractiveMachineState(state).observationRevision;
    try {
      const liveness = await observeInteractivePane(state);
      advanceInteractiveState(state, {
        type: "pane_observed",
        revision,
        liveness,
      });
    } catch (error) {
      advanceInteractiveState(state, {
        type: "pane_observed",
        revision,
        liveness: {
          kind: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
    if (getInteractiveMachineState(state).pane.kind === "dead") {
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
          usage: zeroUsage(),
          model: undefined,
          errorMessage: "interactive sub-agent pane exited before completing",
        };
      }
    } else {
      deadTicks = 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
