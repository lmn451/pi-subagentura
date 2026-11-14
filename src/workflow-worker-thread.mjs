import { parentPort } from "node:worker_threads";
import { createContext, runInContext } from "node:vm";
import {
  isParentWorkerMessage,
  isWorkerParentMessage,
} from "./workflow-rpc.mjs";
import {
  makeGuardedDate,
  makeGuardedMath,
  parseWorkflow,
  workflowStringify,
} from "./workflow-script.mjs";

if (!parentPort) {
  throw new Error("workflow-worker-thread must be run as a Worker thread.");
}
const port = parentPort;

/** @typedef {import('./workflow-rpc.ts').WorkerRpcRequest} WorkerRpcRequest */
/** @typedef {import('./workflow-rpc.ts').WorkerInit} WorkerInit */
/** @typedef {import('./workflow-rpc.ts').WorkerParentMessage} WorkerParentMessage */
/** @typedef {import('./workflow-rpc.ts').WorkerAgentOpts} WorkerAgentOpts */
/** @typedef {{ meta: import('./workflow-script.mjs').ParsedWorkflowMeta, result: unknown }} ScriptResult */
/** @param {WorkerParentMessage} message */
function post(message) {
  port.postMessage(message);
}

let nextRpcId = 1;
/** @type {Map<number, {resolve: (value: unknown) => void, reject: (error: Error) => void}>} */
const pending = new Map();
/** @type {Set<Promise<unknown>>} */
const outstandingAgentCalls = new Set();
let aborted = false;
/** @type {Omit<WorkerInit, 'type' | 'script' | 'args'>} */
let workerConfig = {
  syncTimeoutMs: 30_000,
  maxItemsPerCall: 4096,
  maxWorkflowDepth: 1,
  budgetTotal: null,
  cwd: "",
};
let tokensSpent = 0;
/** @type {WeakMap<object, number>} */
const rpcErrorIds = new WeakMap();

/** @param {Omit<Extract<WorkerRpcRequest, {method: 'agent'}>, 'id'> | Omit<Extract<WorkerRpcRequest, {method: 'loadWorkflow'}>, 'id'>} request @returns {Promise<unknown>} */
function rpc(request) {
  if (aborted) return Promise.reject(new Error("Workflow aborted."));
  return new Promise((resolve, reject) => {
    const id = nextRpcId++;
    if (!isWorkerParentMessage({ id, ...request })) {
      reject(new Error("Invalid workflow RPC request."));
      return;
    }
    pending.set(id, { resolve, reject });
    post({ id, ...request });
  });
}

/** @param {unknown} error @returns {number | undefined} */
function rpcIdFromError(error) {
  if (error === null || typeof error !== "object") return undefined;
  return rpcErrorIds.get(error);
}

port.on("message", (/** @type {unknown} */ msg) => {
  if (!isParentWorkerMessage(msg)) return;

  if ("type" in msg && msg.type === "abort") {
    aborted = true;
    for (const { reject } of pending.values()) {
      reject(new Error("Workflow aborted."));
    }
    pending.clear();
    return;
  }

  if ("type" in msg && msg.type === "init") {
    workerConfig = {
      syncTimeoutMs: msg.syncTimeoutMs,
      maxItemsPerCall: msg.maxItemsPerCall,
      maxWorkflowDepth: msg.maxWorkflowDepth,
      budgetTotal: msg.budgetTotal,
      cwd: msg.cwd,
    };
    executeScript(msg.script, msg.args, 0)
      .then((value) => post({ type: "result", value }))
      .catch((err) => {
        const rpcId = rpcIdFromError(err);
        post({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          ...(rpcId === undefined ? {} : { rpcId }),
        });
      });
    return;
  }

  if ("id" in msg && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    tokensSpent += typeof msg.tokensDelta === "number" ? msg.tokensDelta : 0;
    if (msg.ok) {
      waiter.resolve(msg.value);
    } else {
      const error = new Error(String(msg.error || "Workflow RPC failed."));
      rpcErrorIds.set(error, msg.id);
      waiter.reject(error);
    }
  }
});

/** @param {string} script @param {unknown} args @param {number} depth @returns {Promise<ScriptResult>} */
async function executeScript(script, args, depth) {
  const parsed = parseWorkflow(script);
  const result = await executeBody(parsed.meta, parsed.body, args, depth);
  while (outstandingAgentCalls.size > 0) {
    await Promise.all([...outstandingAgentCalls]);
  }
  return { meta: parsed.meta, result };
}

/** @param {import('./workflow-script.mjs').ParsedWorkflowMeta} meta @param {string} body @param {unknown} args @param {number} depth @returns {Promise<unknown>} */
async function executeBody(meta, body, args, depth) {
  /** @type {string | undefined} */
  let currentPhase;

  function isAborted() {
    return aborted;
  }

  function checkAbort() {
    if (aborted) throw new Error("Workflow aborted.");
  }

  /** @param {unknown} prompt @param {WorkerAgentOpts} opts */
  function agent(prompt, opts = {}) {
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
      return await rpc({
        method: "agent",
        payload: {
          prompt,
          opts: callOpts,
        },
      });
    })();
    outstandingAgentCalls.add(call);
    void call.then(
      () => outstandingAgentCalls.delete(call),
      () => outstandingAgentCalls.delete(call),
    );
    return call;
  }

  /** @param {unknown} thunks */
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
            if (isAborted()) throw err;
            return null;
          }),
      ),
    );
  }

  /** @param {unknown} items @param {...unknown} stages */
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
            if (typeof stage !== "function")
              throw new Error("Invalid pipeline stage.");
            acc = await stage(acc, item, index);
          }
          return acc;
        } catch (err) {
          if (isAborted()) throw err;
          return null;
        }
      }),
    );
  }

  /** @param {unknown} title */
  function phase(title) {
    const t = String(title ?? "");
    currentPhase = t;
    post({
      type: "progress",
      payload: { kind: "phase", phase: t },
    });
  }

  /** @param {unknown} message */
  function log(message) {
    post({
      type: "progress",
      payload: { kind: "log", message: String(message ?? "") },
    });
  }

  /** @param {unknown} nameOrRef @param {unknown} childArgs */
  async function workflow(nameOrRef, childArgs) {
    checkAbort();
    if (depth >= workerConfig.maxWorkflowDepth) {
      throw new Error("workflow() composition is one level deep only.");
    }
    if (typeof nameOrRef !== "string")
      throw new Error(
        "workflow(nameOrRef): expected a saved-workflow name string.",
      );
    const childScript = await rpc({
      method: "loadWorkflow",
      payload: nameOrRef,
    });
    if (typeof childScript !== "string")
      throw new Error("Invalid workflow script response.");
    const child = await executeScript(childScript, childArgs, depth + 1);
    return child.result;
  }

  const budget = {
    total: workerConfig.budgetTotal,
    spent: () => tokensSpent,
    remaining: () => budgetRemaining(),
  };

  const bridge = {
    agent,
    isAborted,
    maxItemsPerCall: workerConfig.maxItemsPerCall,
    phase,
    log,
    workflow,
    args,
    budget,
    rememberError: (
      /** @type {unknown} */ source,
      /** @type {object} */ target,
    ) => {
      const id = rpcIdFromError(source);
      if (id !== undefined) rpcErrorIds.set(target, id);
    },
  };
  const sandbox = Object.assign(Object.create(null), { __bridge: bridge });
  Object.defineProperty(sandbox, "cwd", {
    value: workerConfig.cwd,
    enumerable: true,
    writable: false,
    configurable: false,
  });

  try {
    const context = createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    // Only the bootstrap closures see host values. User-visible callables, promises,
    // errors and data prototypes belong to the VM realm. This reduces accidental
    // determinism bypasses, not the need to trust workflow authors.
    runInContext(
      `((bridge) => {
      delete globalThis.__bridge;
      const keys = Object.keys;
      const define = Object.defineProperty;
      const tag = Function.prototype.call.bind(Object.prototype.toString);
      const isRealmObject = Function.prototype.call.bind(
        Function.prototype[Symbol.hasInstance], Object);
      const NativeDate = Date;
      const isArray = Array.isArray;
      const RealmArray = Array;
      const SeenMap = Map;
      const mapHas = Function.prototype.call.bind(Map.prototype.has);
      const mapGet = Function.prototype.call.bind(Map.prototype.get);
      const mapSet = Function.prototype.call.bind(Map.prototype.set);
      const dateTime = Function.prototype.call.bind(NativeDate.prototype.getTime);
      const GuardedDate = (${makeGuardedDate.toString()})();
      const GuardedMath = (${makeGuardedMath.toString()})();
      function clone(value, seen = new SeenMap()) {
        if (value === null || typeof value !== 'object') return value;
        if (isRealmObject(value)) return value;
        if (mapHas(seen, value)) return mapGet(seen, value);
        let out;
        switch (tag(value)) {
          case '[object Date]':
            out = new GuardedDate(dateTime(value));
            mapSet(seen, value, out); return out;
          case '[object RegExp]':
            out = new RegExp(value.source, value.flags);
            mapSet(seen, value, out); return out;
          case '[object Map]':
            out = new SeenMap(); mapSet(seen, value, out);
            for (const [k, v] of value) out.set(clone(k, seen), clone(v, seen));
            return out;
          case '[object Set]':
            out = new Set(); mapSet(seen, value, out);
            for (const v of value) out.add(clone(v, seen));
            return out;
          default: out = isArray(value) ? new RealmArray(value.length) : {};
        }
        mapSet(seen, value, out);
        for (const key of keys(value)) define(out, key, {
          value: clone(value[key], seen), enumerable: true, writable: true, configurable: true,
        });
        return out;
      }
      const copyError = (source) => {
        const error = new Error(String(source && source.message || source));
        bridge.rememberError(source, error);
        return error;
      };
      const isAborted = () => bridge.isAborted();
      const checkAbort = () => {
        if (isAborted()) throw new Error('Workflow aborted.');
      };
      const workerConfig = { maxItemsPerCall: bridge.maxItemsPerCall };
      globalThis.parallel = (${parallel.toString()});
      globalThis.pipeline = (${pipeline.toString()});
      for (const key of ['agent', 'workflow']) {
        globalThis[key] = (...args) => {
          const call = (async () => {
            try { return clone(await bridge[key](...args)); }
            catch (error) { throw copyError(error); }
          })();
          // The host tracks unawaited agent failures when draining the run.
          if (key === 'agent') void call.catch(() => {});
          return call;
        };
      }
      for (const key of ['phase', 'log']) {
        globalThis[key] = (...args) => {
          try { bridge[key](...args); }
          catch (error) { throw copyError(error); }
        };
      }
      globalThis.args = clone(bridge.args);
      globalThis.budget = {
        total: bridge.budget.total,
        spent: () => bridge.budget.spent(),
        remaining: () => bridge.budget.remaining(),
      };
      const stringify = (${workflowStringify.toString()});
      globalThis.console = {};
      for (const key of ['log', 'error', 'warn']) {
        console[key] = (...args) => log(args.map(stringify).join(' '));
      }
      globalThis.Date = GuardedDate;
      globalThis.Math = GuardedMath;
    })(__bridge);`,
      context,
      { timeout: workerConfig.syncTimeoutMs },
    );
    return await runInContext("(async () => {\n" + body + "\n})()", context, {
      filename: "workflow:" + meta.name + ".js",
      timeout: workerConfig.syncTimeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`Workflow "${meta.name}" failed: ${msg}`);
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
