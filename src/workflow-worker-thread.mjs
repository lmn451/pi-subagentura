import { parentPort } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { defineWorkflow, schema } from "./workflow-v4-sdk.mjs";
import {
  makeGuardedDate,
  makeGuardedMath,
  parseWorkflow,
  workflowStringify,
} from "./workflow-script.mjs";

if (!parentPort) {
  throw new Error("workflow-worker-thread must be run as a Worker thread.");
}

let nextRpcId = 1;
const pending = new Map();
const outstandingAgentCalls = new Set();
let aborted = false;
const workflowAbort = new AbortController();
let workerConfig = {
  syncTimeoutMs: 30_000,
  maxItemsPerCall: 4096,
  maxWorkflowDepth: 1,
  budgetTotal: null,
  cwd: "",
};
let tokensSpent = 0;
const rpcErrorIds = new WeakMap();

function cancellationError(message = "Workflow aborted.") {
  const error = new Error(message);
  error.cancelled = true;
  return error;
}
function isTimeoutSignal(signal) {
  const reason = signal?.reason;
  return (
    reason?.category === "timeout" || reason?.name === "WorkflowTimeoutError"
  );
}

function rpc(method, payload, signal, onUsage) {
  if (aborted) return Promise.reject(cancellationError());
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? cancellationError());
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    const cancel = () => parentPort.postMessage({ type: "cancel_request", id });
    signal?.addEventListener("abort", cancel, { once: true });
    const clean = () => signal?.removeEventListener("abort", cancel);
    pending.set(id, {
      onUsage,
      resolve: (value) => {
        clean();
        signal?.aborted
          ? reject(signal.reason ?? cancellationError())
          : resolve(value);
      },
      reject: (error) => {
        clean();
        reject(error);
      },
    });
    parentPort.postMessage({ id, method, payload });
  });
}

function rpcIdFromError(error) {
  if (error === null || typeof error !== "object") return undefined;
  return rpcErrorIds.get(error);
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "abort") {
    aborted = true;
    workflowAbort.abort(cancellationError());
    for (const { reject } of pending.values()) {
      reject(cancellationError());
    }
    pending.clear();
    return;
  }

  if (msg.type === "response_offer") {
    parentPort.postMessage({
      type: "response_ready",
      id: msg.id,
      frontier: nextRpcId - 1,
    });
    return;
  }

  if (msg.type === "init") {
    workerConfig = {
      syncTimeoutMs: msg.syncTimeoutMs,
      maxItemsPerCall: msg.maxItemsPerCall,
      maxWorkflowDepth: msg.maxWorkflowDepth,
      budgetTotal: msg.budgetTotal,
      cwd: msg.cwd,
      durable: msg.durable === true,
      stepBased: msg.stepBased === true,
    };
    tokensSpent = msg.initialTokensSpent ?? 0;
    executeScript(msg.script, msg.args, 0)
      .then((value) => parentPort.postMessage({ type: "result", value }))
      .catch((err) => {
        const rpcId = rpcIdFromError(err);
        parentPort.postMessage({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          ...(err?.cancelled === true || err?.name === "WorkflowCancelledError"
            ? { cancelled: true }
            : {}),
          ...(rpcId === undefined ? {} : { rpcId }),
        });
      });
    return;
  }

  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    const tokensDelta =
      typeof msg.tokensDelta === "number" ? msg.tokensDelta : undefined;
    const budgetTokensDelta =
      typeof msg.budgetTokensDelta === "number"
        ? msg.budgetTokensDelta
        : tokensDelta;
    tokensSpent += budgetTokensDelta ?? 0;
    if (tokensDelta !== undefined) waiter.onUsage?.(tokensDelta);
    if (msg.ok) {
      waiter.resolve(msg.value);
    } else {
      const error = new Error(String(msg.error || "Workflow RPC failed."));
      const failure = msg.failure ?? msg.stats?.failure;
      if (failure && typeof failure === "object") {
        error.category = failure.errorCategory;
        error.stage = failure.errorStage;
      }
      if (workerConfig.stepBased && msg.stats?.schemaRepairExhausted === true) {
        error.schemaRepairExhausted = true;
      }
      if (msg.cancelled === true) error.cancelled = true;
      rpcErrorIds.set(error, msg.id);
      waiter.reject(error);
    }
  }
});

async function executeScript(
  script,
  args,
  depth,
  operationPath = [],
  ancestors = [],
  signal = workflowAbort.signal,
  invocationKey,
  inheritedUsage,
) {
  const parsed = parseWorkflow(script);
  const identity = createHash("sha256").update(script).digest("hex");
  if (workerConfig.stepBased && ancestors.includes(identity))
    throw new Error("Nested workflow cycle detected.");
  const result = await executeBody(
    parsed.meta,
    parsed.body,
    args,
    depth,
    operationPath,
    [...ancestors, identity],
    signal,
    script,
    parsed.format,
    invocationKey,
    inheritedUsage,
  );
  // A timed-out V4 step has already recorded its failure; don't let its
  // eventual agent RPC rejection override it while draining the worker.
  if (depth === 0) {
    while (outstandingAgentCalls.size > 0) {
      await Promise.all(
        [...outstandingAgentCalls].map((call) =>
          call.promise
            ? call.promise.catch((err) => {
                if (call.handledTimeout && isTimeoutSignal(call.signal)) return;
                throw err;
              })
            : call,
        ),
      );
    }
  }
  return { meta: parsed.meta, result };
}

async function executeBody(
  meta,
  body,
  args,
  depth,
  operationPath,
  ancestors,
  signal,
  source,
  format,
  invocationKey,
  inheritedUsage,
) {
  const runWorkflowDefinition =
    format === "definition"
      ? (await import("./workflow-v4-runtime.mjs")).runWorkflowDefinition
      : undefined;
  let currentPhase;
  let legacyAgentIndex = 0;
  // Map V4 step attempts to their calls so timeout ownership can include
  // pending work inside a nested workflow.
  const v4StepIds = new Map();
  const v4StepCalls = new Map();

  function checkAbort() {
    if (aborted) throw cancellationError();
    if (signal.aborted) {
      const reason = signal.reason;
      if (
        reason?.category === "timeout" ||
        reason?.name === "WorkflowTimeoutError"
      ) {
        throw reason;
      }
      if (reason?.cancelled === true) throw reason;
      throw cancellationError();
    }
  }

  function agent(prompt, opts = {}, agentSignal = signal, onUsage) {
    const call = (async () => {
      checkAbort();
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("agent(prompt): prompt must be a non-empty string.");
      }
      if (workerConfig.budgetTotal != null && budgetRemaining() <= 0) {
        throw new Error("Workflow token budget exhausted.");
      }
      const hasExplicitPhase = Object.prototype.hasOwnProperty.call(
        opts,
        "phase",
      );
      const resolvedPhase =
        hasExplicitPhase && opts.phase != null
          ? String(opts.phase)
          : currentPhase;
      const callOpts = { ...opts, phase: resolvedPhase };
      if (workerConfig.stepBased) {
        callOpts.schema = opts.schema ?? opts.output;
        callOpts.label = opts.label ?? opts.title;
      }
      delete callOpts.signal;
      if (workerConfig.stepBased) {
        callOpts.id = createHash("sha256")
          .update(
            JSON.stringify([
              ...operationPath,
              opts.id ?? `legacy-${++legacyAgentIndex}`,
            ]),
          )
          .digest("hex");
      }
      return await rpc(
        "agent",
        {
          prompt,
          opts: callOpts,
          v4Definition: format === "definition",
          ...(workerConfig.durable
            ? { operationPath: [...operationPath, opts.id] }
            : {}),
        },
        agentSignal,
        (amount) => {
          onUsage?.(amount);
          inheritedUsage?.(amount);
        },
      );
    })();
    const isV4AgentCall =
      format === "definition" && typeof opts.id === "string";
    const isOwnedDescendant =
      workerConfig.stepBased &&
      (invocationKey !== undefined || operationPath.length > 0);
    const trackedCall =
      isV4AgentCall || isOwnedDescendant
        ? {
            promise: call,
            signal: agentSignal,
            handledTimeout: false,
            invocationKey,
            operationPath,
          }
        : call;
    if (isV4AgentCall) v4StepCalls.set(opts.id, trackedCall);
    outstandingAgentCalls.add(trackedCall);
    void call.then(
      () => outstandingAgentCalls.delete(trackedCall),
      () => outstandingAgentCalls.delete(trackedCall),
    );
    return call;
  }

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel(thunks): expected an array of functions.");
    }
    if (thunks.length > workerConfig.maxItemsPerCall) {
      throw new Error(
        `parallel(): ${thunks.length} thunks exceeds the ${workerConfig.maxItemsPerCall} cap.`,
      );
    }
    return Promise.all(
      thunks.map((t) =>
        Promise.resolve()
          .then(() => {
            if (typeof t !== "function") {
              throw new Error(
                "parallel(): each item must be a thunk () => Promise.",
              );
            }
            checkAbort();
            return t();
          })
          .catch((err) => {
            if (aborted) throw err;
            return null;
          }),
      ),
    );
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) {
      throw new Error("pipeline(items, ...stages): items must be an array.");
    }
    if (items.length > workerConfig.maxItemsPerCall) {
      throw new Error(
        `pipeline(): ${items.length} items exceeds the ${workerConfig.maxItemsPerCall} cap.`,
      );
    }
    for (const stage of stages) {
      if (typeof stage !== "function") {
        throw new Error("pipeline(): stages must be functions.");
      }
    }
    const fns = stages;
    return Promise.all(
      items.map(async (item, index) => {
        let acc = item;
        try {
          for (const stage of fns) {
            checkAbort();
            acc = await stage(acc, item, index);
          }
          return acc;
        } catch (err) {
          if (aborted) throw err;
          return null;
        }
      }),
    );
  }

  async function retry(work, { attempts = 3, retryOnNull = true } = {}) {
    if (typeof work !== "function") {
      throw new Error("retry(work): expected a function.");
    }
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
      throw new Error("retry(): attempts must be an integer in 1–10.");
    }
    if (typeof retryOnNull !== "boolean") {
      throw new Error("retry(): retryOnNull must be a boolean.");
    }
    for (let attempt = 1; attempt <= attempts; attempt++) {
      checkAbort();
      try {
        const result = await work(attempt);
        checkAbort();
        if (result !== null || !retryOnNull || attempt === attempts) {
          return result;
        }
      } catch (error) {
        checkAbort();
        if (attempt === attempts) throw error;
      }
    }
  }

  function phase(title) {
    const t = String(title ?? "");
    currentPhase = t;
    parentPort.postMessage({
      type: "progress",
      payload: { kind: "phase", phase: t },
    });
  }

  function log(message) {
    parentPort.postMessage({
      type: "progress",
      payload: { kind: "log", message: String(message ?? "") },
    });
  }

  function workflow(nameOrRef, childArgs, options = {}, onUsage) {
    const call = (async () => {
      checkAbort();
      if (depth >= workerConfig.maxWorkflowDepth) {
        throw new Error(
          workerConfig.stepBased
            ? "Workflow nesting depth exceeds 8."
            : "workflow() composition is one level deep only.",
        );
      }
      const childPath = [
        ...(workerConfig.stepBased && Array.isArray(options.stepPath)
          ? [...operationPath, ...options.stepPath]
          : [
              ...operationPath,
              options.id ??
                options.idempotencyKey ??
                (workerConfig.stepBased ? nameOrRef : undefined),
            ]),
      ];
      const childScript = await rpc(
        "loadWorkflow",
        workerConfig.durable
          ? { name: nameOrRef, args: childArgs, operationPath: childPath }
          : nameOrRef,
      );
      const child = await executeScript(
        childScript,
        childArgs,
        depth + 1,
        childPath,
        ancestors,
        options.signal ?? signal,
        workerConfig.stepBased ? options.id : undefined,
        (amount) => {
          onUsage?.(amount);
          inheritedUsage?.(amount);
        },
      );
      return child.result;
    })();
    const isV4WorkflowCall =
      format === "definition" && typeof options.id === "string";
    const isOwnedDescendant =
      workerConfig.stepBased &&
      (invocationKey !== undefined || operationPath.length > 0);
    const trackedCall =
      isV4WorkflowCall || isOwnedDescendant
        ? {
            promise: call,
            signal: options.signal ?? signal,
            handledTimeout: false,
            invocationKey: isV4WorkflowCall ? options.id : invocationKey,
            operationPath,
          }
        : call;
    if (isV4WorkflowCall) v4StepCalls.set(options.id, trackedCall);
    outstandingAgentCalls.add(trackedCall);
    void call.then(
      () => outstandingAgentCalls.delete(trackedCall),
      () => outstandingAgentCalls.delete(trackedCall),
    );
    return call;
  }

  const budget = {
    total: workerConfig.budgetTotal,
    spent: () => tokensSpent,
    remaining: () => budgetRemaining(),
  };

  const sandbox = Object.assign(Object.create(null), {
    defineWorkflow,
    schema,
    __runWorkflowDefinition: (definition) =>
      runWorkflowDefinition(definition, args, {
        agent,
        workflow,
        signal,
        budget,
        maxItems: workerConfig.maxItemsPerCall,
        request: async (action, payload, requestSignal) => {
          const stepFailureSignal = requestSignal ?? signal;
          // Ignore only the nested abort; the worker-wide signal still fences
          // terminal writes if the session is cancelled.
          const rpcSignal =
            action === "step.fail" && stepFailureSignal?.aborted && !aborted
              ? workflowAbort.signal
              : stepFailureSignal;
          const response = await rpc(
            "v4",
            {
              action,
              payload: {
                ...payload,
                ...(payload.path
                  ? { path: [...operationPath, ...payload.path] }
                  : {}),
                definitionHash: createHash("sha256")
                  .update(JSON.stringify([source, invocationKey ?? null]))
                  .digest("hex"),
              },
            },
            rpcSignal,
          );
          if (
            action === "step.enter" &&
            ["agent", "workflow"].includes(payload.kind) &&
            response?.reuse !== true &&
            response?.persistedFailure === undefined &&
            Array.isArray(payload.path)
          ) {
            const attempt = Number.isInteger(response?.attempt)
              ? response.attempt
              : 1;
            const idempotencyKey =
              typeof response?.idempotencyKey === "string"
                ? response.idempotencyKey
                : payload.path.join("/");
            v4StepIds.set(
              JSON.stringify([payload.path, attempt]),
              `${idempotencyKey}:${attempt}`,
            );
          } else if (action === "step.fail" || action === "step.complete") {
            const key = JSON.stringify([payload.path, payload.attempt]);
            const stepId = v4StepIds.get(key);
            const trackedCall =
              stepId === undefined ? undefined : v4StepCalls.get(stepId);
            if (
              action === "step.fail" &&
              trackedCall &&
              isTimeoutSignal(trackedCall.signal)
            ) {
              trackedCall.handledTimeout = true;
              const failedPath = [
                ...operationPath,
                ...(Array.isArray(payload.path) ? payload.path : []),
              ];
              for (const descendant of outstandingAgentCalls) {
                if (!descendant.promise) continue;
                const descendantPath = descendant.operationPath;
                const isOwned =
                  descendant.invocationKey === stepId ||
                  (Array.isArray(descendantPath) &&
                    descendantPath.length >= failedPath.length &&
                    failedPath.every(
                      (part, index) => descendantPath[index] === part,
                    ));
                if (isOwned && isTimeoutSignal(descendant.signal)) {
                  descendant.handledTimeout = true;
                }
              }
            }
            v4StepIds.delete(key);
            if (stepId !== undefined) v4StepCalls.delete(stepId);
          }
          return response;
        },
        validate: (value, schema) =>
          rpc("v4", { action: "validate", payload: { value, schema } }, signal),
        log: (message, path) => {
          const text =
            typeof message === "string" ? message : workflowStringify(message);
          log(text);
          return rpc(
            "v4",
            {
              action: "step.progress",
              payload: { path: [...operationPath, ...path], message: text },
            },
            signal,
          );
        },
      }),
    agent,
    parallel,
    pipeline,
    retry,
    phase,
    log,
    workflow,
    args,
    budget,
    console: {
      log: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
      error: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
      warn: (...a) => log(a.map((x) => workflowStringify(x)).join(" ")),
    },
    Date: makeGuardedDate(),
    Math: makeGuardedMath(),
  });
  Object.defineProperty(sandbox, "cwd", {
    value: workerConfig.cwd,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  try {
    return await runInNewContext(
      format === "definition"
        ? `(${body})(__runWorkflowDefinition, defineWorkflow, schema)`
        : "(async () => {\n" + body + "\n})()",
      sandbox,
      {
        filename: "workflow:" + meta.name + ".js",
        timeout: workerConfig.syncTimeoutMs,
        contextCodeGeneration: { strings: false, wasm: false },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`Workflow "${meta.name}" failed: ${msg}`);
    if (typeof err?.name === "string") wrapped.name = err.name;
    if (typeof err?.category === "string") wrapped.category = err.category;
    if (typeof err?.stage === "string") wrapped.stage = err.stage;
    if (Array.isArray(err?.path)) wrapped.path = err.path;
    if (err?.blocked === true) wrapped.blocked = true;
    if (err?.schemaRepairExhausted === true) {
      wrapped.schemaRepairExhausted = true;
    }
    if (err?.cancelled === true || err?.name === "WorkflowCancelledError") {
      wrapped.name = "WorkflowCancelledError";
      wrapped.cancelled = true;
    }
    const rpcId = rpcIdFromError(err);
    if (rpcId !== undefined) rpcErrorIds.set(wrapped, rpcId);
    throw wrapped;
  }
}

function budgetRemaining() {
  return workerConfig.budgetTotal == null
    ? Infinity
    : Math.max(0, workerConfig.budgetTotal - tokensSpent);
}
