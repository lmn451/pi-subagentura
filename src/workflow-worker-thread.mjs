import { parentPort } from "node:worker_threads";
import { runInNewContext } from "node:vm";
import { types as utilTypes } from "node:util";
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
let workerConfig = {
  syncTimeoutMs: 30_000,
  maxItemsPerCall: 4096,
  maxWorkflowDepth: 1,
  budgetTotal: null,
  cwd: "",
  durable: null,
  cloneLimits: null,
};
let tokensSpent = 0;
const rpcErrorIds = new WeakMap();
const fatalWorkflowErrors = new WeakSet();

function rpc(method, payload) {
  if (aborted) return Promise.reject(new Error("Workflow aborted."));
  const message = { id: nextRpcId++, method, payload };
  try {
    assertBoundedClone(message, `workflow ${method} request`);
  } catch (error) {
    markFatalWorkflowError(error);
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    try {
      parentPort.postMessage(message);
    } catch (error) {
      pending.delete(message.id);
      const failure = cloneTransferError(`workflow ${method} request`, error);
      reject(failure);
    }
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
    for (const { reject } of pending.values()) {
      reject(new Error("Workflow aborted."));
    }
    pending.clear();
    return;
  }

  if (msg.type === "init") {
    workerConfig = {
      syncTimeoutMs: msg.syncTimeoutMs,
      maxItemsPerCall: msg.maxItemsPerCall,
      maxWorkflowDepth: msg.maxWorkflowDepth,
      budgetTotal: msg.budgetTotal,
      cwd: msg.cwd,
      durable: msg.durable,
      cloneLimits: msg.cloneLimits,
    };
    executeScript(
      msg.script,
      msg.args,
      0,
      msg.durable?.rootDefinitionPath ?? null,
    )
      .then((value) => {
        postBounded({ type: "result", value }, "workflow result");
      })
      .catch((err) => {
        const rpcId = rpcIdFromError(err);
        parentPort.postMessage({
          type: "error",
          error: boundedErrorMessage(err),
          ...(rpcId === undefined ? {} : { rpcId }),
        });
      });
    return;
  }

  if (typeof msg.id === "number" && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    tokensSpent += typeof msg.tokensDelta === "number" ? msg.tokensDelta : 0;
    if (msg.ok) {
      waiter.resolve(msg.value);
    } else {
      const error = new Error(String(msg.error || "Workflow RPC failed."));
      rpcErrorIds.set(error, msg.id);
      if (msg.fatal === true) markFatalWorkflowError(error);
      waiter.reject(error);
    }
  }
});

async function executeScript(script, args, depth, definitionPath) {
  const parsed = parseWorkflow(script);
  const result = await executeBody(
    parsed.meta,
    parsed.body,
    args,
    depth,
    definitionPath,
  );
  while (outstandingAgentCalls.size > 0) {
    await Promise.all([...outstandingAgentCalls]);
  }
  return { meta: parsed.meta, result };
}

async function executeBody(meta, body, args, depth, definitionPath) {
  let currentPhase;

  function checkAbort() {
    if (aborted) throw new Error("Workflow aborted.");
  }

  function agent(prompt, opts = {}) {
    const call = (async () => {
      checkAbort();
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("agent(prompt): prompt must be a non-empty string.");
      }
      if (
        workerConfig.durable !== null &&
        (typeof opts.id !== "string" || opts.id.length === 0)
      ) {
        throw new Error(
          "Durable agent(prompt, opts) requires an explicit stable opts.id.",
        );
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
      return await rpc("agent", {
        prompt,
        opts: callOpts,
        ...(workerConfig.durable === null ? {} : { definitionPath }),
      });
    })();
    outstandingAgentCalls.add(call);
    void call.then(
      () => outstandingAgentCalls.delete(call),
      () => outstandingAgentCalls.delete(call),
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
            if (aborted || isFatalWorkflowError(err)) throw err;
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
          if (aborted || isFatalWorkflowError(err)) throw err;
          return null;
        }
      }),
    );
  }

  function phase(title) {
    const t = String(title ?? "");
    currentPhase = t;
    postBounded(
      {
        type: "progress",
        payload: { kind: "phase", phase: t },
      },
      "workflow progress",
    );
  }

  function log(message) {
    postBounded(
      {
        type: "progress",
        payload: { kind: "log", message: String(message ?? "") },
      },
      "workflow progress",
    );
  }

  async function workflow(nameOrRef, childArgs, opts = {}) {
    checkAbort();
    if (depth >= workerConfig.maxWorkflowDepth) {
      throw new Error(
        `workflow() composition exceeds the maximum depth of ${workerConfig.maxWorkflowDepth}.`,
      );
    }
    if (
      workerConfig.durable !== null &&
      (typeof opts.id !== "string" || opts.id.length === 0)
    ) {
      throw new Error(
        "Durable workflow(name, args, opts) requires an explicit stable opts.id.",
      );
    }
    const durablePayload =
      workerConfig.durable === null
        ? null
        : {
            name: nameOrRef,
            args: childArgs,
            opts,
            parentDefinitionPath: definitionPath,
          };
    const loaded = await rpc(
      "loadWorkflow",
      durablePayload === null ? nameOrRef : durablePayload,
    );
    if (durablePayload === null) {
      const child = await executeScript(loaded, childArgs, depth + 1, null);
      return child.result;
    }
    let completion;
    try {
      const child = await executeScript(
        loaded.script,
        childArgs,
        depth + 1,
        loaded.definitionPath,
      );
      completion = { status: "succeeded", value: child.result };
    } catch (error) {
      completion = { status: "failed", error: boundedErrorMessage(error) };
    }
    return await rpc("completeWorkflow", {
      workflow: durablePayload,
      completion,
    });
  }

  const budget = {
    total: workerConfig.budgetTotal,
    spent: () => tokensSpent,
    remaining: () => budgetRemaining(),
  };

  const sandbox = Object.assign(Object.create(null), {
    agent,
    parallel,
    pipeline,
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
      "(async () => {\n" + body + "\n})()",
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
    const rpcId = rpcIdFromError(err);
    if (rpcId !== undefined) rpcErrorIds.set(wrapped, rpcId);
    if (isFatalWorkflowError(err)) markFatalWorkflowError(wrapped);
    throw wrapped;
  }
}

function budgetRemaining() {
  return workerConfig.budgetTotal == null
    ? Infinity
    : Math.max(0, workerConfig.budgetTotal - tokensSpent);
}

function markFatalWorkflowError(error) {
  if (error !== null && typeof error === "object") {
    fatalWorkflowErrors.add(error);
  }
  return error;
}

function isFatalWorkflowError(error) {
  return (
    error !== null &&
    typeof error === "object" &&
    fatalWorkflowErrors.has(error)
  );
}

function boundedErrorMessage(error) {
  let message;
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {
    message = "Workflow worker failed with an unprintable error.";
  }
  return message.length <= 512 ? message : `${message.slice(0, 509)}...`;
}

function cloneTransferError(label, cause) {
  const detail = boundedErrorMessage(cause);
  return markFatalWorkflowError(
    new Error(`Unable to transfer bounded ${label}: ${detail}`),
  );
}

function postBounded(message, label) {
  assertBoundedClone(message, label);
  try {
    parentPort.postMessage(message);
  } catch (error) {
    throw cloneTransferError(label, error);
  }
}

function assertBoundedClone(root, label) {
  const limits = workerConfig.cloneLimits;
  if (limits === null) {
    throw markFatalWorkflowError(
      new Error("Workflow clone limits were not initialized."),
    );
  }
  const seen = new WeakSet();
  const stack = [{ value: root, depth: 0 }];
  let nodes = 0;
  let bytes = 0;

  const fail = (dimension, actual, detail = "exceeded") => {
    const limit = limits[dimension];
    const error = new Error(
      `Workflow clone quota ${dimension} ${detail} for ${label} (${actual} > ${limit}).`,
    );
    error.name = "WorkflowCloneQuotaError";
    throw markFatalWorkflowError(error);
  };
  const consumeBytes = (amount) => {
    bytes += amount;
    if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) {
      fail("maxBytes", bytes);
    }
  };
  const consumeString = (value) => {
    const stringBytes = Buffer.byteLength(value, "utf8");
    if (stringBytes > limits.maxStringBytes) {
      fail("maxStringBytes", stringBytes);
    }
    consumeBytes(stringBytes + 2);
  };
  const enqueue = (value, depth) => {
    const projectedNodes = nodes + stack.length + 1;
    if (projectedNodes > limits.maxNodes) {
      fail("maxNodes", projectedNodes);
    }
    if (depth > limits.maxDepth) fail("maxDepth", depth);
    stack.push({ value, depth });
  };

  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > limits.maxNodes) fail("maxNodes", nodes);
    if (depth > limits.maxDepth) fail("maxDepth", depth);

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
        throw markFatalWorkflowError(
          new TypeError(
            `Unsupported ${typeof value} in ${label} structured-clone payload.`,
          ),
        );
      case "object":
        break;
      default:
        throw markFatalWorkflowError(
          new TypeError(
            `Unsupported value in ${label} structured-clone payload.`,
          ),
        );
    }

    if (seen.has(value)) {
      consumeBytes(4);
      continue;
    }
    seen.add(value);
    if (utilTypes.isProxy(value)) {
      throw markFatalWorkflowError(
        new TypeError(`Proxy values are not allowed in ${label}.`),
      );
    }

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
      consumeString(
        Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get.call(
          value,
        ),
      );
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
      throw markFatalWorkflowError(
        new TypeError(
          `Unsupported object in ${label} structured-clone payload.`,
        ),
      );
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (typeof key !== "string") {
        throw markFatalWorkflowError(
          new TypeError(`Symbol keys are not allowed in ${label}.`),
        );
      }
      consumeString(key);
      if (!("value" in descriptor)) {
        throw markFatalWorkflowError(
          new TypeError(`Accessors are not allowed in ${label}.`),
        );
      }
      enqueue(descriptor.value, depth + 1);
    }
    consumeBytes(2);
  }
}
