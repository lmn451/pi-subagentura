export interface WorkflowSessionDispatcherOptions {
  maxConcurrent?: number;
  max?: number;
}

export interface WorkflowSessionDispatcherSnapshot {
  active: number;
  queued: number;
  max: number;
}

interface QueueEntry<T> {
  work: () => Promise<T> | T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

/** FIFO session-wide capacity for in-process durable task execution. */
export class WorkflowSessionDispatcher {
  private readonly maxConcurrent: number;
  private readonly queue: QueueEntry<unknown>[] = [];
  private activeCount = 0;

  public constructor(options: WorkflowSessionDispatcherOptions | number = {}) {
    const max =
      typeof options === "number"
        ? options
        : (options.maxConcurrent ?? options.max ?? 4);
    if (!Number.isSafeInteger(max) || max <= 0)
      throw new Error("Workflow dispatcher concurrency must be positive");
    this.maxConcurrent = max;
  }

  public snapshot(): WorkflowSessionDispatcherSnapshot {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      max: this.maxConcurrent,
    };
  }

  public getSnapshot(): WorkflowSessionDispatcherSnapshot {
    return this.snapshot();
  }

  public run<T>(work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = { work, resolve, reject, signal };
      const abortListener = (): void => {
        const index = this.queue.indexOf(entry as QueueEntry<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.abortListener = undefined;
        reject(signal?.reason ?? abortError());
        this.drain();
      };
      entry.abortListener = abortListener;
      signal?.addEventListener("abort", abortListener, { once: true });
      this.queue.push(entry as QueueEntry<unknown>);
      this.drain();
    });
  }

  public acquire<T>(
    work: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.run(work, signal);
  }

  public withSlot<T>(
    work: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.run(work, signal);
  }

  private drain(): void {
    while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.signal?.aborted) {
        entry.abortListener = undefined;
        entry.reject(entry.signal.reason ?? abortError());
        continue;
      }
      if (entry.abortListener && entry.signal)
        entry.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
      this.activeCount++;
      Promise.resolve()
        .then(entry.work)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeCount--;
          this.drain();
        });
    }
  }
}

function abortError(): Error {
  const error = new Error("Workflow task cancelled");
  error.name = "AbortError";
  return error;
}
