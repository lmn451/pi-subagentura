import type { SubagentResult } from "./helpers";
import {
  MAX_TOTAL_AGENTS,
  addWorkflowUsage,
  zeroWorkflowUsage,
  attachWorkflowFailure,
  workflowFailureClassification,
  type WorkflowAgentRunner,
  type WorkflowRunResultWithUsage,
} from "./workflow-core";
import {
  WorkflowRunStore,
  WorkflowPersistenceError,
  encodeRunValue,
  decodeRunValue,
  runValueMatches,
} from "./workflow-run-store";

export interface WorkflowRpcRequest {
  id: number;
  method: string;
  payload: any;
}
export interface WorkflowRpcResponse {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  tokensDelta: number;
}

export interface DurableAttemptContext {
  /** Stable within this run, including schema repair attempt number. */
  key: string;
  directory: string;
  recovering: boolean;
  /** Adapter calls before a new process launch, not when adopting one. */
  recordDispatch?: () => Promise<void>;
}

export class WorkflowReplayError extends WorkflowPersistenceError {
  constructor(message: string) {
    super(`Workflow replay divergence: ${message}`);
  }
}

/** One transcript across root and nested scripts; no per-branch replay lanes. */
export class DurableWorkflow {
  readonly definition: any;
  readonly replaying: boolean;
  private requests: any[];
  private responses: any[];
  private requestIndex = 0;
  private responseIndex = 0;
  private pending = new Map<
    number,
    {
      request: WorkflowRpcRequest;
      execute: () => Promise<WorkflowRpcResponse>;
      durable: boolean;
    }
  >();
  private operations = new Set<string>();
  private offers: WorkflowRpcResponse[] = [];
  private offered = false;
  private stopped = false;
  private inFlight = new Set<Promise<unknown>>();
  private attemptOutcomes = new Map<string, any>();
  private attempts = new Map<string, any>();
  private send!: (value: unknown) => void;
  private fail!: (error: unknown) => void;
  private dispatchCount = 0;
  private recordedUsage = zeroWorkflowUsage();
  readonly priorErrorCount: number;

  constructor(readonly store: WorkflowRunStore) {
    this.definition = store.events[0].data;
    this.requests = store.events
      .filter((e) => e.kind === "request")
      .map((e) => e.data);
    this.responses = store.events
      .filter((e) => e.kind === "response")
      .map((e) => e.data);
    this.replaying = this.requests.length > 0;
    this.priorErrorCount = this.responses.reduce(
      (total, row) =>
        total +
        (decodeRunValue<
          WorkflowRpcResponse & { stats?: { errorCount?: number } }
        >(row.value).stats?.errorCount ?? 0),
      0,
    );
    this.dispatchCount = store.events.filter(
      (event) => event.kind === "dispatch",
    ).length;
    for (const event of store.events) {
      if (event.kind === "attempt")
        this.attempts.set(event.data.key, event.data);
      if (event.kind === "outcome")
        this.attemptOutcomes.set(event.data.key, event.data);
    }
    for (const outcome of this.attemptOutcomes.values()) {
      const result = outcome.ok
        ? decodeRunValue<SubagentResult>(outcome.value)
        : outcome;
      this.recordedUsage = addWorkflowUsage(this.recordedUsage, result.usage);
    }
  }

  bind(send: (value: unknown) => void, fail: (error: unknown) => void): void {
    this.send = send;
    this.fail = (error) => {
      this.stopped = true;
      fail(error);
    };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  dispatch(
    request: WorkflowRpcRequest,
    execute: () => Promise<WorkflowRpcResponse>,
  ): void {
    if (this.stopped) return;
    try {
      if (request.id !== this.requestIndex + 1 || request.id > 8192)
        throw new WorkflowReplayError(
          "invalid request sequence or 8192-operation cap exceeded.",
        );
      const path = request.payload?.operationPath;
      if (
        !Array.isArray(path) ||
        path.length < 1 ||
        path.length > 2 ||
        path.some(
          (id: unknown) =>
            typeof id !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id),
        )
      ) {
        throw new WorkflowReplayError(
          "every durable agent() and workflow() call requires a stable, safe id (1–128 characters).",
        );
      }
      const key = JSON.stringify(path);
      if (this.operations.has(key))
        throw new WorkflowReplayError(
          `duplicate operation id ${key}. Use distinct ids for items and retry attempts.`,
        );
      this.operations.add(key);
      const previous = this.requests[this.requestIndex++];
      if (
        previous &&
        (previous.id !== request.id ||
          previous.method !== request.method ||
          !runValueMatches(previous.payload, request.payload))
      ) {
        throw new WorkflowReplayError(
          `request ${request.id} does not match its recorded definition/arguments.`,
        );
      }
      const pending = { request, execute, durable: !!previous };
      this.pending.set(request.id, pending);
      if (!previous) {
        void this.track(
          this.store.append("request", {
            ...request,
            payload: encodeRunValue(request.payload),
          }),
        ).then(() => {
          pending.durable = true;
          this.pump();
        }, this.fail);
      }
      this.pump();
    } catch (error) {
      this.fail(error);
    }
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.responseIndex < this.responses.length) {
      const response = this.responses[this.responseIndex];
      if (response.frontier > this.requestIndex) return;
      const pending = this.pending.get(response.id);
      if (!pending?.durable) return;
      this.pending.delete(response.id);
      this.responseIndex++;
      this.send(decodeRunValue(response.value));
    }
    if (this.requestIndex < this.requests.length) return;
    for (const [id, pending] of this.pending) {
      if (!pending.durable) continue;
      this.pending.delete(id);
      void this.track(pending.execute()).then((response) => {
        if (this.stopped) return;
        this.offers.push(response);
        this.offerNext();
      }, this.fail);
    }
  }

  private offerNext(): void {
    if (this.stopped || this.offered || this.offers.length === 0) return;
    this.offered = true;
    this.send({ type: "response_offer", id: this.offers[0].id });
  }

  /** Worker has drained prior microtasks and reports its exact request frontier. */
  acceptResponse(id: number, frontier: number): void {
    if (this.stopped) return;
    const response = this.offers[0];
    if (
      !this.offered ||
      response?.id !== id ||
      frontier !== this.requestIndex
    ) {
      this.fail(new WorkflowReplayError("invalid response acknowledgement."));
      return;
    }
    void this.track(
      this.store.append("response", {
        id,
        frontier,
        value: encodeRunValue(response),
      }),
    ).then(() => {
      if (this.stopped) return;
      this.send(response);
      this.offers.shift();
      this.offered = false;
      this.offerNext();
    }, this.fail);
  }

  assertComplete(): void {
    if (
      this.requestIndex < this.requests.length ||
      this.responseIndex < this.responses.length ||
      this.pending.size ||
      this.offers.length
    ) {
      throw new WorkflowReplayError(
        "program completed before consuming its transcript.",
      );
    }
  }

  async runAttempt(
    requestId: number,
    attempt: number,
    request: Parameters<WorkflowAgentRunner>[0],
    run: WorkflowAgentRunner,
  ): Promise<SubagentResult> {
    if (this.stopped || request.signal?.aborted)
      throw new Error("Workflow interrupted.");
    const key = `${requestId}-${attempt}`;
    const {
      signal: _signal,
      onProgress: _progress,
      onCancellationSnapshot: _snapshot,
      ...behavior
    } = request;
    const previous = this.attempts.get(key);
    if (previous && !runValueMatches(previous.configuration, behavior))
      throw new WorkflowReplayError("agent attempt configuration changed.");
    const committed = this.attemptOutcomes.get(key);
    if (committed) return this.restoreOutcome(committed);
    if (!previous) {
      if (this.attempts.size >= MAX_TOTAL_AGENTS)
        throw new WorkflowPersistenceError(
          "Durable workflow lifetime agent cap exhausted.",
        );
      if (this.usage().output >= this.definition.budgetTotal)
        throw new WorkflowPersistenceError(
          "Durable workflow output budget exhausted.",
        );
      const data = {
        key,
        configuration: encodeRunValue(behavior),
        isolation: request.isolation ?? "process",
      };
      this.attempts.set(key, data);
      await this.store.append("attempt", data);
    }
    // The launcher receives persisted identity, never a callback supplied by JS.
    let dispatched = false;
    const durableAttempt: DurableAttemptContext = {
      key,
      directory: this.store.directory,
      recovering: !!previous,
      recordDispatch: async () => {
        if (dispatched) return;
        if (this.stopped || request.signal?.aborted)
          throw new Error("Workflow interrupted before dispatch.");
        if (this.dispatchCount >= MAX_TOTAL_AGENTS)
          throw new WorkflowPersistenceError(
            "Durable workflow lifetime agent dispatch cap exhausted.",
          );
        if (this.usage().output >= this.definition.budgetTotal)
          throw new WorkflowPersistenceError(
            "Durable workflow output budget exhausted.",
          );
        dispatched = true;
        const sequence = ++this.dispatchCount;
        await this.store.append("dispatch", { key, sequence });
        if (this.stopped || request.signal?.aborted)
          throw new Error("Workflow interrupted before dispatch.");
      },
    };
    try {
      if (this.stopped || request.signal?.aborted)
        throw new Error("Workflow interrupted before dispatch.");
      if (request.isolation === "in-process")
        await durableAttempt.recordDispatch!();
      const result = await run({ ...request, durableAttempt });
      if (this.stopped || request.signal?.aborted)
        throw new Error("Workflow interrupted.");
      const data = {
        key,
        ok: true,
        value: encodeRunValue(result),
        failure: workflowFailureClassification(result),
      };
      await this.store.append("outcome", data);
      this.attemptOutcomes.set(key, data);
      this.recordedUsage = addWorkflowUsage(this.recordedUsage, result.usage);
      return result;
    } catch (error) {
      if (
        this.stopped ||
        request.signal?.aborted ||
        error instanceof WorkflowPersistenceError
      )
        throw error;
      const data = {
        key,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failure: workflowFailureClassification(error),
        usage: (error as { usage?: SubagentResult["usage"] } | null)?.usage,
      };
      await this.store.append("outcome", data);
      this.attemptOutcomes.set(key, data);
      this.recordedUsage = addWorkflowUsage(this.recordedUsage, data.usage);
      throw error;
    }
  }

  private restoreOutcome(outcome: any): SubagentResult {
    if (outcome.ok) {
      const result = decodeRunValue<SubagentResult>(outcome.value);
      return outcome.failure
        ? attachWorkflowFailure(result, outcome.failure)
        : result;
    }
    const error = Object.assign(new Error(outcome.error), {
      usage: outcome.usage,
    });
    throw outcome.failure
      ? attachWorkflowFailure(error, outcome.failure)
      : error;
  }

  usage() {
    return { ...this.recordedUsage };
  }

  get agentsSpawned(): number {
    return Math.max(this.attempts.size, this.dispatchCount);
  }

  result(result: WorkflowRunResultWithUsage): WorkflowRunResultWithUsage {
    const usage = this.usage();
    let errorCount = 0;
    let cancelledCount = 0;
    let failure = result.failure;
    for (const event of this.store.events) {
      if (event.kind !== "response") continue;
      const response = decodeRunValue<
        WorkflowRpcResponse & {
          stats?: {
            errorCount?: number;
            cancelledCount?: number;
            failure?: typeof failure;
          };
        }
      >(event.data.value);
      errorCount += response.stats?.errorCount ?? 0;
      cancelledCount += response.stats?.cancelledCount ?? 0;
      failure ??= response.stats?.failure;
    }
    return {
      ...result,
      errorCount,
      ...(cancelledCount ? { cancelledCount } : {}),
      ...(failure ? { failure } : {}),
      usage,
      tokensSpent: usage.output,
      agentsSpawned: Math.max(this.attempts.size, this.dispatchCount),
    };
  }

  stop(): void {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    // Do not release ownership while a runner can still act in this process.
    await Promise.allSettled([...this.inFlight]);
    await this.store.flush();
  }
}
