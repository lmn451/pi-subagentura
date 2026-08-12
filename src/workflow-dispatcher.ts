import type { SubagentResult } from "./helpers";
import {
  defaultConcurrency,
  defaultProcessConcurrency,
  type WorkflowAgentRunner,
} from "./workflow-core";

type WorkflowAgentRequest = Parameters<WorkflowAgentRunner>[0];

export interface WorkflowAgentDispatcherOptions {
  /** Maximum concurrently running in-process agents. */
  concurrency?: number;
  /** Maximum concurrently running process-backed agents. */
  processConcurrency?: number;
  /** Optional default runner used by run(). */
  runAgent?: WorkflowAgentRunner;
}

export interface WorkflowAgentDispatchOptions {
  /**
   * Signal used only while waiting for a dispatcher slot. Once started, the
   * request's own signal controls the agent.
   */
  signal?: AbortSignal;
  /**
   * Internal fence evaluated after acquiring a lane slot and immediately before
   * invoking the runner. A rejection releases the slot without dispatching.
   */
  beforeStart?: () => void | Promise<void>;
}

interface QueuedDispatch {
  readonly start: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface DispatchLane {
  readonly cap: number;
  active: number;
  readonly queue: QueuedDispatch[];
}

/**
 * The single concurrency boundary for workflow agent execution.
 *
 * It deliberately knows nothing about durable replay or workflow state. Process
 * and in-process work use independent lanes, and every accepted dispatch remains
 * observable by drain() until it either runs to settlement or leaves the queue.
 */
export class WorkflowAgentDispatcher {
  readonly #inProcess: DispatchLane;
  readonly #process: DispatchLane;
  readonly #defaultRunner?: WorkflowAgentRunner;
  #closed = false;
  #closeReason: unknown;
  #pending = 0;
  readonly #drainWaiters = new Set<() => void>();

  constructor(options: WorkflowAgentDispatcherOptions = {}) {
    this.#inProcess = createLane(
      options.concurrency ?? defaultConcurrency(),
      "concurrency",
    );
    this.#process = createLane(
      options.processConcurrency ?? defaultProcessConcurrency(),
      "processConcurrency",
    );
    this.#defaultRunner = options.runAgent;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get activeCount(): number {
    return this.#inProcess.active + this.#process.active;
  }

  get queuedCount(): number {
    return this.#inProcess.queue.length + this.#process.queue.length;
  }

  run(
    request: WorkflowAgentRequest,
    options?: WorkflowAgentDispatchOptions,
  ): Promise<SubagentResult>;
  run(
    request: WorkflowAgentRequest,
    runner: WorkflowAgentRunner,
    options?: WorkflowAgentDispatchOptions,
  ): Promise<SubagentResult>;
  run(
    request: WorkflowAgentRequest,
    runnerOrOptions?: WorkflowAgentRunner | WorkflowAgentDispatchOptions,
    maybeOptions?: WorkflowAgentDispatchOptions,
  ): Promise<SubagentResult> {
    const runner =
      typeof runnerOrOptions === "function"
        ? runnerOrOptions
        : this.#defaultRunner;
    const options =
      typeof runnerOrOptions === "function" ? maybeOptions : runnerOrOptions;
    if (runner === undefined) {
      return Promise.reject(
        new Error("WorkflowAgentDispatcher requires a runner."),
      );
    }

    const lane =
      request.isolation === "in-process" ? this.#inProcess : this.#process;
    const queueSignal = options?.signal ?? request.signal;
    if (this.#closed) return Promise.reject(this.#closeReason);
    if (queueSignal?.aborted) {
      return Promise.reject(abortReason(queueSignal));
    }

    this.#pending++;
    return new Promise<SubagentResult>((resolve, reject) => {
      const settleQueuedRejection = (reason: unknown) => {
        this.#pending--;
        reject(reason);
        this.#notifyDrained();
      };
      const queued: QueuedDispatch = {
        signal: queueSignal,
        reject: settleQueuedRejection,
        start: () => {
          if (queued.onAbort && queued.signal) {
            queued.signal.removeEventListener("abort", queued.onAbort);
          }
          lane.active++;
          Promise.resolve()
            .then(() => options?.beforeStart?.())
            .then(() => runner(request))
            .then(resolve, reject)
            .finally(() => {
              lane.active--;
              this.#pending--;
              this.#pump(lane);
              this.#notifyDrained();
            });
        },
        ...(queueSignal
          ? {
              onAbort: () => {
                const index = lane.queue.indexOf(queued);
                if (index < 0) return;
                lane.queue.splice(index, 1);
                settleQueuedRejection(abortReason(queueSignal));
              },
            }
          : {}),
      };

      if (lane.active < lane.cap) {
        queued.start();
        return;
      }
      lane.queue.push(queued);
      if (queued.onAbort && queueSignal) {
        queueSignal.addEventListener("abort", queued.onAbort, { once: true });
      }
    });
  }

  /** Reject queued and future dispatches. Already-running agents are untouched. */
  close(
    reason: unknown = new Error("Workflow agent dispatcher is closed."),
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#rejectQueue(this.#inProcess, reason);
    this.#rejectQueue(this.#process, reason);
    this.#notifyDrained();
  }

  /** Wait for every dispatch accepted before or during this call to settle. */
  drain(): Promise<void> {
    if (this.#pending === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
  }

  #pump(lane: DispatchLane): void {
    while (!this.#closed && lane.active < lane.cap) {
      const next = lane.queue.shift();
      if (next === undefined) return;
      if (next.signal?.aborted) {
        if (next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.reject(abortReason(next.signal));
        continue;
      }
      next.start();
    }
  }

  #rejectQueue(lane: DispatchLane, reason: unknown): void {
    for (;;) {
      const queued = lane.queue.shift();
      if (queued === undefined) return;
      if (queued.onAbort && queued.signal) {
        queued.signal.removeEventListener("abort", queued.onAbort);
      }
      queued.reject(reason);
    }
  }

  #notifyDrained(): void {
    if (this.#pending !== 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

function createLane(cap: number, name: string): DispatchLane {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return { cap, active: 0, queue: [] };
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}
