import { AsyncLocalStorage } from "node:async_hooks";
import { Duration, Effect } from "effect";

const MAX_ITEMS = 4096;
const MAX_STEPS = 8192;
const MAX_REPEAT = 1000;
const MAX_ATTEMPTS = 10;
const MAX_DEPTH = 32;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const scopeStorage = new AsyncLocalStorage();

export class WorkflowStepError extends Error {
  constructor(message, options = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkflowStepError";
    this.category = options.category ?? "internal";
    this.stage = options.stage ?? "workflow";
    this.path = options.path ?? [];
  }
}

export class WorkflowCancelledError extends WorkflowStepError {
  constructor(path = [], cause) {
    super("Workflow was cancelled.", { path, cause, category: "unknown" });
    this.name = "WorkflowCancelledError";
  }
}

export class WorkflowTimeoutError extends WorkflowStepError {
  constructor(path, timeout) {
    super(`Workflow step timed out after ${timeout}.`, {
      path,
      category: "timeout",
    });
    this.name = "WorkflowTimeoutError";
  }
}

function validateId(id, field = "step id") {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new WorkflowStepError(`${field} must be 1–128 safe characters.`, {
      category: "internal",
    });
  }
  return id;
}

function currentScope() {
  return scopeStorage.getStore() ?? { path: [], counters: new Map() };
}

function generatedId(kind) {
  const scope = currentScope();
  const next = scope.counters.get(kind) ?? 0;
  scope.counters.set(kind, next + 1);
  return `${kind}-${next + 1}`;
}

function childPath(id, parent = currentScope().path) {
  if (parent.length >= MAX_DEPTH) {
    throw new WorkflowStepError("Workflow step nesting limit exceeded.", {
      path: parent,
      category: "capacity",
    });
  }
  return [...parent, validateId(id)];
}

function boundedConcurrency(value, fallback, itemCount) {
  if (value === undefined)
    return Math.max(1, Math.min(fallback, itemCount || 1));
  if (!Number.isInteger(value) || value < 1 || value > MAX_ITEMS) {
    throw new WorkflowStepError(
      "Concurrency must be an integer from 1 to 4096.",
      {
        category: "capacity",
      },
    );
  }
  return Math.min(value, itemCount || 1);
}

function serializeError(error, path) {
  const e = error instanceof Error ? error : new Error(String(error));
  return {
    name: e.name || "Error",
    message: e.message,
    ...(typeof e.category === "string" ? { category: e.category } : {}),
    ...(typeof e.stage === "string" ? { stage: e.stage } : {}),
    ...(Array.isArray(e.path) ? { path: e.path } : { path }),
  };
}

function isCancelled(error, signal) {
  return (
    signal?.aborted === true ||
    error instanceof WorkflowCancelledError ||
    error?.cancelled === true
  );
}

function bridgeRequest(bridge, action, payload, signal) {
  if (typeof bridge?.request === "function") {
    return bridge.request(action, payload, signal);
  }
  const named = {
    "step.enter": "enterStep",
    "step.complete": "completeStep",
    "step.fail": "failStep",
    "step.progress": "stepProgress",
    "gate.wait": "waitForGate",
    checkpoint: "checkpoint",
    "artifact.write": "writeArtifact",
    "artifact.read": "readArtifact",
    validate: "validate",
  }[action];
  if (named && typeof bridge?.[named] === "function") {
    return bridge[named](payload, signal);
  }
  throw new WorkflowStepError(`Workflow host does not support ${action}.`, {
    path: payload?.path ?? [],
    category: "internal",
  });
}

async function validateValue(bridge, value, schema, path) {
  if (schema === undefined) return value;
  let errors;
  if (typeof bridge?.validate === "function") {
    errors = await bridge.validate(value, schema);
  } else {
    errors = await bridgeRequest(bridge, "validate", { value, schema, path });
  }
  if (Array.isArray(errors) && errors.length > 0) {
    throw new WorkflowStepError(
      `Workflow value failed schema validation: ${errors.slice(0, 5).join("; ")}`,
      { path, category: "schema", stage: "schema_validation" },
    );
  }
  return value;
}

function combineSignals(parent, controller) {
  if (!parent) return controller.signal;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, controller.signal]);
  }
  const forward = () => controller.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => parent.removeEventListener("abort", forward),
    { once: true },
  );
  return controller.signal;
}

function parseTimeout(timeout) {
  if (timeout === undefined) return undefined;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
    return timeout;
  }
  if (typeof timeout === "string") {
    const match =
      /^(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|mins?|m|hours?|hrs?|h)$/i.exec(
        timeout.trim(),
      );
    if (match) {
      const unit = /^(ms|millisecond|milliseconds)$/i.test(match[2])
        ? 1
        : /^(s|second|seconds)$/i.test(match[2])
          ? 1000
          : /^(m|min|mins|minute|minutes)$/i.test(match[2])
            ? 60_000
            : 3_600_000;
      const milliseconds = Number(match[1]) * unit;
      if (Number.isFinite(milliseconds) && milliseconds > 0)
        return milliseconds;
    }
  }
  throw new WorkflowStepError(
    "Step timeout must be positive milliseconds or a duration string.",
    {
      category: "timeout",
    },
  );
}

function retryAttempts(policy) {
  const attempts = policy?.retry?.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new WorkflowStepError(
      "Retry attempts must be an integer from 1 to 10.",
      {
        category: "capacity",
      },
    );
  }
  return attempts;
}

function stepPolicy(options) {
  const names = [
    "timeout",
    "retry",
    "failure",
    "persist",
    "resume",
    "cache",
    "budget",
  ];
  const direct = Object.fromEntries(
    names
      .filter((name) => options?.[name] !== undefined)
      .map((name) => [name, options[name]]),
  );
  return { ...direct, ...(options?.policy ?? {}) };
}

function sleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return Effect.runPromise(Effect.sleep(Duration.millis(milliseconds)), {
    signal,
  });
}

function backoffMilliseconds(policy, attempt) {
  const backoff = policy?.retry?.backoff;
  if (!backoff) return 0;
  if (typeof backoff === "number" && Number.isFinite(backoff) && backoff >= 0)
    return Math.min(backoff, 30_000);
  if (backoff === "fixed") return 250;
  if (backoff === "exponential")
    return Math.min(250 * 2 ** (attempt - 1), 30_000);
  throw new WorkflowStepError(
    "Retry backoff must be fixed, exponential, or milliseconds.",
    {
      category: "internal",
    },
  );
}

function taskResult(error, path) {
  return { ok: false, error: serializeError(error, path) };
}

function resultOrThrow(policy, error, path) {
  if (policy?.failure === "continue" || policy?.failure === "collect") {
    return taskResult(error, path);
  }
  throw error;
}

function makeBudget(bridge) {
  const budget = bridge?.budget ?? {};
  const out = {};
  Object.defineProperties(out, {
    total: { enumerable: true, get: () => budget.total ?? null },
    spent: { enumerable: true, value: () => budget.spent?.() ?? 0 },
    remaining: {
      enumerable: true,
      value: () => budget.remaining?.() ?? null,
    },
    assertAvailable: {
      enumerable: true,
      value: (amount) => {
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0
        ) {
          throw new WorkflowStepError(
            "Budget assertion must be a non-negative finite number.",
            { category: "budget", stage: "budget" },
          );
        }
        const remaining = budget.remaining?.();
        if (typeof remaining === "number" && remaining < amount) {
          throw new WorkflowStepError("Workflow budget is insufficient.", {
            category: "budget",
            stage: "budget",
          });
        }
      },
    },
  });
  return Object.freeze(out);
}

/** Execute one compiled definition with Promise-based ctx operations. */
export async function runWorkflowDefinition(definition, args, bridge = {}) {
  if (!definition || typeof definition.run !== "function") {
    throw new WorkflowStepError(
      "Workflow definition must provide run(ctx, args).",
      {
        category: "schema",
      },
    );
  }
  const signal = bridge.signal;
  if (signal?.aborted) throw new WorkflowCancelledError([], signal.reason);
  await validateValue(bridge, args, definition.input, []);

  const root = {
    path: [],
    counters: new Map(),
    stepCounter: { count: 0 },
    seenPaths: new Set(),
    budgetCounters: [],
    signal,
  };
  const executeStep = async (
    id,
    options,
    run,
    parentScope = currentScope(),
  ) => {
    const path = childPath(id, parentScope.path);
    const pathToken = JSON.stringify([path, parentScope.retryFrames ?? []]);
    if (parentScope.seenPaths.has(pathToken)) {
      throw new WorkflowStepError(
        "Duplicate workflow step id in the same scope.",
        {
          path,
          category: "schema",
        },
      );
    }
    parentScope.seenPaths.add(pathToken);
    parentScope.stepCounter.count++;
    if (parentScope.stepCounter.count > MAX_STEPS) {
      throw capacityError(`Workflow step limit ${MAX_STEPS} exceeded.`);
    }
    const policy = stepPolicy(options);
    const maxAttempts = retryAttempts(policy);
    if (
      policy.budget !== undefined &&
      (typeof policy.budget !== "number" ||
        !Number.isFinite(policy.budget) ||
        policy.budget < 0)
    ) {
      throw new WorkflowStepError(
        "Step budget must be a non-negative finite number.",
        { path, category: "budget", stage: "budget" },
      );
    }
    const timeoutMs = parseTimeout(policy.timeout);
    const parentSignal = parentScope.signal ?? signal;
    let lastError;
    const budgetCounter = { spent: 0 };

    for (let localAttempt = 1; localAttempt <= maxAttempts; localAttempt++) {
      if (parentSignal?.aborted)
        throw new WorkflowCancelledError(path, parentSignal.reason);
      const entered = await bridgeRequest(bridge, "step.enter", {
        path,
        kind: options?.kind ?? "step",
        title: options?.title ?? id,
        ...(options?.input !== undefined ? { input: options.input } : {}),
        ...(Object.keys(policy).length > 0 ? { policy } : {}),
        ...(definition.sourceHash
          ? { definitionHash: definition.sourceHash }
          : {}),
      });
      if (
        entered?.reuse &&
        policy.cache !== false &&
        policy.resume !== false &&
        policy.persist !== false
      ) {
        return entered.value;
      }

      const attempt = Number.isInteger(entered?.attempt)
        ? entered.attempt
        : localAttempt;
      if (attempt > maxAttempts) {
        const exhausted = new WorkflowStepError(
          `Step retry limit ${maxAttempts} was exhausted before resume.`,
          { path, category: "capacity" },
        );
        await bridgeRequest(bridge, "step.fail", {
          path,
          error: serializeError(exhausted, path),
          attempt,
          status: "failed",
        });
        throw exhausted;
      }
      const controller = new AbortController();
      const operationSignal = combineSignals(parentSignal, controller);
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(
              () =>
                controller.abort(
                  new WorkflowTimeoutError(path, policy.timeout),
                ),
              timeoutMs,
            );
      timer?.unref?.();
      const budgetCounters = [
        ...(parentScope.budgetCounters ?? []),
        budgetCounter,
      ];
      try {
        const value = await Effect.runPromise(
          Effect.tryPromise({
            try: () =>
              Promise.resolve(
                scopeStorage.run(
                  {
                    path,
                    counters: new Map(),
                    stepCounter: parentScope.stepCounter,
                    seenPaths: parentScope.seenPaths,
                    budgetCounters,
                    signal: operationSignal,
                    retryFrames: [
                      ...(parentScope.retryFrames ?? []),
                      { path, attempt },
                    ],
                  },
                  () => run(operationSignal, entered, budgetCounters),
                ),
              ),
            catch: (error) => error,
          }),
          { signal: operationSignal },
        );
        if (policy.budget !== undefined) {
          if (budgetCounter.spent > policy.budget) {
            throw new WorkflowStepError(
              `Workflow step exceeded its budget of ${policy.budget}.`,
              { path, category: "budget", stage: "budget" },
            );
          }
        }
        await bridgeRequest(bridge, "step.complete", { path, value, attempt });
        return value;
      } catch (caught) {
        const timeoutError =
          controller.signal.aborted && !parentSignal?.aborted
            ? new WorkflowTimeoutError(path, policy.timeout)
            : undefined;
        const error = timeoutError ?? caught;
        lastError = error;
        const cancelled =
          isCancelled(error, parentSignal) || parentSignal?.aborted;
        const status = cancelled
          ? "cancelled"
          : error?.blocked === true
            ? "blocked"
            : undefined;
        await bridgeRequest(bridge, "step.fail", {
          path,
          error: serializeError(error, path),
          attempt,
          ...(status ? { status } : {}),
        });
        if (cancelled) throw new WorkflowCancelledError(path, error);
        if (attempt < maxAttempts && error?.category !== "budget") {
          await sleep(backoffMilliseconds(policy, attempt), parentSignal);
          continue;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!controller.signal.aborted) controller.abort();
      }
    }
    return resultOrThrow(policy, lastError, path);
  };

  const step = (id, options, run) => {
    if (typeof options === "function") {
      run = options;
      options = {};
    }
    if (typeof run !== "function") {
      throw new WorkflowStepError("ctx.step requires an async callback.", {
        category: "schema",
      });
    }
    return executeStep(id, options, run);
  };

  const agent = (id, options = {}) => {
    validateId(id, "agent id");
    if (typeof bridge.agent !== "function") {
      throw new WorkflowStepError(
        "Workflow host does not support agent calls.",
        {
          path: childPath(id),
          category: "internal",
        },
      );
    }
    return executeStep(
      id,
      {
        ...options,
        kind: "agent",
        input: { prompt: options.prompt, output: options.output },
      },
      async (stepSignal, entered) => {
        const counters = currentScope().budgetCounters ?? [];
        const agentId = `${entered?.idempotencyKey ?? pathKey(childPath(id))}:${entered?.attempt ?? 1}`;
        const value = await bridge.agent(
          options.prompt,
          {
            ...options,
            id: agentId,
            output: options.output,
          },
          stepSignal,
          (amount) => {
            if (typeof amount !== "number" || !Number.isFinite(amount)) return;
            for (const counter of counters) counter.spent += amount;
          },
        );
        return validateValue(bridge, value, options.output, childPath(id));
      },
    );
  };

  const group = (id, title, run) => {
    if (typeof title === "function") {
      run = title;
      title = id;
    }
    if (typeof run !== "function") {
      throw new WorkflowStepError("ctx.group requires an async callback.", {
        category: "schema",
      });
    }
    return executeStep(id, { kind: "group", title }, (stepSignal) =>
      runWithSignal(stepSignal, run),
    );
  };

  const parallel = (branches, options = {}) => {
    if (!branches || typeof branches !== "object" || Array.isArray(branches)) {
      throw new WorkflowStepError("ctx.parallel expects named branches.", {
        category: "schema",
      });
    }
    const entries = Object.entries(branches);
    if (entries.length > MAX_ITEMS)
      throw capacityError("parallel item cap exceeded.");
    const ids = entries.map(([name]) => validateId(name, "parallel branch id"));
    const parallelId = validateId(
      options.stepId ?? options.id ?? generatedId("parallel"),
    );
    return executeStep(
      parallelId,
      {
        kind: "group",
        title: options.title ?? parallelId,
        input: ids,
        policy: stepPolicy(options),
      },
      async (parallelSignal) => {
        const parent = currentScope();
        const wrappers = entries.map(([name, thunk], index) =>
          Effect.tryPromise({
            try: async () => {
              try {
                return {
                  ok: true,
                  value: await executeStep(
                    ids[index],
                    {
                      kind: "step",
                      title: options.titles?.[name] ?? name,
                    },
                    async (childSignal) => {
                      if (typeof thunk !== "function") {
                        throw new WorkflowStepError(
                          `Parallel branch ${name} must be a function.`,
                          { category: "schema" },
                        );
                      }
                      return runWithSignal(childSignal, thunk);
                    },
                    parent,
                  ),
                };
              } catch (error) {
                if (isCancelled(error, parent.signal)) throw error;
                return { ok: false, error };
              }
            },
            catch: (error) => error,
          }),
        );
        const values = await Effect.runPromise(
          Effect.all(wrappers, {
            concurrency: boundedConcurrency(
              options.concurrency,
              8,
              wrappers.length,
            ),
            discard: false,
          }),
          { signal: parallelSignal },
        );
        if (options.failure !== "collect" && options.failure !== "continue") {
          const output = {};
          for (let index = 0; index < entries.length; index++) {
            if (!values[index].ok) throw values[index].error;
            output[entries[index][0]] = values[index].value;
          }
          return output;
        }
        return Object.fromEntries(
          entries.map(([key], index) => [
            key,
            values[index].ok
              ? values[index]
              : taskResult(
                  values[index].error,
                  childPath(ids[index], parent.path),
                ),
          ]),
        );
      },
    );
  };

  const map = (items, mapper, options = {}) => {
    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      throw capacityError(`ctx.map accepts at most ${MAX_ITEMS} items.`);
    }
    if (typeof mapper !== "function") {
      throw new WorkflowStepError("ctx.map requires a mapper callback.", {
        category: "schema",
      });
    }
    const mapId = validateId(
      options.stepId ?? options.id ?? generatedId("map"),
    );
    const parent = currentScope();
    return executeStep(
      mapId,
      {
        kind: "group",
        title: options.title ?? mapId,
        input: items,
        policy: stepPolicy(options),
      },
      async (mapSignal) => {
        const work = items.map((item, index) =>
          Effect.tryPromise({
            try: async () => {
              try {
                return {
                  ok: true,
                  value: await executeStep(
                    itemId(item, index, options.key),
                    {
                      title:
                        options.titleForItem?.(item, index) ??
                        `Item ${index + 1}`,
                      input: item,
                    },
                    (itemSignal) =>
                      mapper(item, {
                        id: itemId(item, index, options.key),
                        index,
                        signal: itemSignal,
                      }),
                    {
                      ...currentScope(),
                      counters: new Map(),
                      path: [...parent.path, mapId],
                      stepCounter: parent.stepCounter,
                    },
                  ),
                };
              } catch (error) {
                if (isCancelled(error, mapSignal)) throw error;
                return { ok: false, error };
              }
            },
            catch: (error) => error,
          }),
        );
        const values = await Effect.runPromise(
          Effect.forEach(work, (fx) => fx, {
            concurrency: boundedConcurrency(
              options.concurrency,
              8,
              work.length,
            ),
          }),
          { signal: mapSignal },
        );
        if (options.failure === "collect" || options.failure === "continue") {
          return values.map((itemResult, index) =>
            itemResult.ok
              ? itemResult
              : taskResult(itemResult.error, [
                  ...parent.path,
                  mapId,
                  itemId(items[index], index, options.key),
                ]),
          );
        }
        return values.map((itemResult) => {
          if (itemResult.ok) return itemResult.value;
          throw itemResult.error;
        });
      },
    );
  };

  const pipeline = (items, ...stageArgs) => {
    const lastArg = stageArgs.at(-1);
    const options =
      lastArg !== null && typeof lastArg === "object" && !Array.isArray(lastArg)
        ? stageArgs.pop()
        : {};
    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      throw capacityError(`ctx.pipeline accepts at most ${MAX_ITEMS} items.`);
    }
    if (
      !stageArgs.length ||
      stageArgs.some((stage) => typeof stage !== "function")
    ) {
      throw new WorkflowStepError(
        "ctx.pipeline requires one or more stage callbacks.",
        {
          category: "schema",
        },
      );
    }
    const pipelineId = validateId(
      options.stepId ?? options.id ?? generatedId("pipeline"),
    );
    const parent = currentScope();
    return executeStep(
      pipelineId,
      {
        kind: "group",
        title: options.title ?? pipelineId,
        input: items,
        policy: stepPolicy(options),
      },
      async (pipelineSignal) => {
        const work = items.map((item, index) =>
          Effect.tryPromise({
            try: async () => {
              try {
                return {
                  ok: true,
                  value: await executeStep(
                    itemId(item, index, options.key),
                    {
                      title: `Pipeline item ${index + 1}`,
                      input: item,
                    },
                    async (itemSignal) => {
                      let value = item;
                      for (
                        let stageIndex = 0;
                        stageIndex < stageArgs.length;
                        stageIndex++
                      ) {
                        value = await executeStep(
                          `stage-${stageIndex + 1}`,
                          {
                            title: `Stage ${stageIndex + 1}`,
                            input: value,
                          },
                          (stageSignal) =>
                            stageArgs[stageIndex](value, {
                              item,
                              itemId: itemId(item, index, options.key),
                              index,
                              stage: stageIndex + 1,
                              signal: stageSignal,
                            }),
                        );
                      }
                      return value;
                    },
                    {
                      ...currentScope(),
                      counters: new Map(),
                      path: [...parent.path, pipelineId],
                      stepCounter: parent.stepCounter,
                    },
                  ),
                };
              } catch (error) {
                if (isCancelled(error, pipelineSignal)) throw error;
                return { ok: false, error };
              }
            },
            catch: (error) => error,
          }),
        );
        const values = await Effect.runPromise(
          Effect.forEach(work, (fx) => fx, {
            concurrency: boundedConcurrency(
              options.concurrency,
              8,
              work.length,
            ),
          }),
          { signal: pipelineSignal },
        );
        if (options.failure === "collect" || options.failure === "continue") {
          return values.map((itemResult, index) =>
            itemResult.ok
              ? itemResult
              : taskResult(itemResult.error, [
                  ...parent.path,
                  pipelineId,
                  itemId(items[index], index, options.key),
                ]),
          );
        }
        return values.map((itemResult) => {
          if (itemResult.ok) return itemResult.value;
          throw itemResult.error;
        });
      },
    );
  };

  const repeat = (id, options, body) => {
    validateId(id);
    if (
      !options ||
      !Number.isInteger(options.maxIterations) ||
      options.maxIterations < 1 ||
      options.maxIterations > MAX_REPEAT
    ) {
      throw capacityError(
        `ctx.repeat maxIterations must be from 1 to ${MAX_REPEAT}.`,
      );
    }
    if (typeof body !== "function") {
      throw new WorkflowStepError(
        "ctx.repeat requires an iteration callback.",
        {
          category: "schema",
        },
      );
    }
    return executeStep(
      id,
      { kind: "group", title: options.title ?? id },
      async (repeatSignal) => {
        let previous;
        let value;
        let termination = "max_iterations";
        let iterations = 0;
        for (
          let iteration = 1;
          iteration <= options.maxIterations;
          iteration++
        ) {
          if (repeatSignal?.aborted)
            throw new WorkflowCancelledError(
              currentScope().path,
              repeatSignal.reason,
            );
          iterations = iteration;
          value = await executeStep(
            `iteration-${iteration}`,
            {
              title:
                options.iterationTitle?.(iteration) ??
                `${options.title ?? id} ${iteration}`,
              input: { iteration, previous },
            },
            (iterationSignal) =>
              body({ iteration, previous, signal: iterationSignal }),
          );
          previous = value;
          const done = options.until
            ? await options.until({ value, iteration, previous })
            : false;
          if (done) {
            termination = "condition_met";
            break;
          }
          const remaining = bridge.budget?.remaining?.();
          if (typeof remaining === "number" && remaining <= 0) {
            termination = "budget_exhausted";
            break;
          }
        }
        const result = { value, iterations, termination };
        if (termination === "max_iterations" && options.onLimit === "throw") {
          throw new WorkflowStepError(
            "Workflow repeat reached its iteration limit.",
            {
              path: currentScope().path,
              category: "capacity",
            },
          );
        }
        return result;
      },
    );
  };

  const workflow = (name, childArgs, options = {}) => {
    validateId(options.stepId ?? options.id ?? name, "workflow step id");
    if (typeof bridge.workflow !== "function") {
      throw new WorkflowStepError(
        "Workflow host does not support nested workflows.",
        {
          path: childPath(options.stepId ?? options.id ?? name),
          category: "internal",
        },
      );
    }
    const id = options.stepId ?? options.id ?? name;
    return executeStep(
      id,
      {
        ...options,
        kind: "workflow",
        title: options.title ?? name,
        input: childArgs,
      },
      (stepSignal, entered, budgetCounters) => {
        let nestedUsage = 0;
        return Promise.resolve()
          .then(() =>
            bridge.workflow(
              name,
              childArgs,
              {
                ...options,
                stepPath: currentScope().path,
                idempotencyKey: entered?.idempotencyKey,
                id: `${entered?.idempotencyKey ?? pathKey(childPath(id))}:${entered?.attempt ?? 1}`,
                signal: stepSignal,
              },
              (amount) => {
                if (typeof amount === "number" && Number.isFinite(amount))
                  nestedUsage += amount;
              },
            ),
          )
          .finally(() => {
            for (const counter of budgetCounters) counter.spent += nestedUsage;
          });
      },
    );
  };

  const humanOperation = (kind, id, request) => {
    const normalizedRequest = {
      ...request,
      ...(kind === "gate"
        ? { kind: "gate", type: "confirm" }
        : request?.type === undefined && request?.prompt
          ? { type: "input", question: request.prompt }
          : {}),
    };
    return executeStep(
      id,
      {
        kind: "gate",
        title: normalizedRequest.title ?? normalizedRequest.question ?? id,
        input: normalizedRequest,
      },
      async (stepSignal) => {
        const response = await bridgeRequest(
          bridge,
          "gate.wait",
          {
            path: currentScope().path,
            kind,
            request: normalizedRequest,
          },
          stepSignal,
        );
        if (
          kind === "gate" &&
          (response === false || response?.approved === false)
        ) {
          const error = new WorkflowStepError("Workflow approval was denied.", {
            path: currentScope().path,
            category: "unknown",
            stage: "workflow",
          });
          error.blocked = true;
          throw error;
        }
        return response;
      },
    );
  };

  const checkpoint = (id, value) =>
    bridgeRequest(bridge, "checkpoint", {
      path: [...currentScope().path, validateId(id)],
      id,
      value,
    });

  const artifact = Object.freeze({
    write: (id, value, options = {}) =>
      bridgeRequest(bridge, "artifact.write", {
        path: [...currentScope().path, validateId(id)],
        id,
        value,
        type: options.type ?? "json",
      }),
    read: (ref) => bridgeRequest(bridge, "artifact.read", { ref }),
  });

  const log = (message) => {
    if (typeof bridge.log === "function")
      return bridge.log(message, currentScope().path);
    return bridgeRequest(bridge, "step.progress", {
      path: currentScope().path,
      message: typeof message === "string" ? message : JSON.stringify(message),
    });
  };

  const ctx = Object.freeze({
    step,
    agent,
    group,
    parallel,
    map,
    pipeline,
    repeat,
    workflow,
    ask: (id, request) => humanOperation("ask", id, request),
    gate: (id, request) => humanOperation("gate", id, request),
    checkpoint,
    artifact,
    log,
    budget: makeBudget(bridge),
    get signal() {
      return currentScope().signal ?? signal;
    },
  });

  let result;
  try {
    result = await scopeStorage.run(root, () =>
      Effect.runPromise(
        Effect.tryPromise({
          try: () => Promise.resolve(definition.run(ctx, args)),
          catch: (error) => error,
        }),
        { signal },
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw new WorkflowCancelledError([], signal.reason);
    throw error;
  }
  await validateValue(bridge, result, definition.output, []);
  return result;
}

function pathKey(path) {
  return path.join("/");
}

function itemId(item, index, keySelector) {
  let raw;
  try {
    raw =
      typeof keySelector === "function"
        ? keySelector(item, index)
        : item && typeof item === "object" && typeof item.id === "string"
          ? item.id
          : String(index + 1);
  } catch (error) {
    throw new WorkflowStepError("Map item key selector failed.", {
      path: currentScope().path,
      cause: error,
      category: "schema",
    });
  }
  return validateId(String(raw), "map item id");
}

function capacityError(message) {
  return new WorkflowStepError(message, {
    path: currentScope().path,
    category: "capacity",
  });
}

async function runWithSignal(signal, run) {
  if (signal?.aborted)
    throw new WorkflowCancelledError(currentScope().path, signal.reason);
  const value = await run(signal);
  if (signal?.aborted)
    throw new WorkflowCancelledError(currentScope().path, signal.reason);
  return value;
}
