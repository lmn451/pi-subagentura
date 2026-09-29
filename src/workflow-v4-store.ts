import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  encodeRunValue,
  decodeRunValue,
  runValueMatches,
  WorkflowPersistenceError,
  type WorkflowRunStore,
  type RunEvent,
} from "./workflow-run-store";
import { validateSchema } from "./workflow-core";

export interface V4StepNode {
  path: string[];
  id: string;
  kind: string;
  title: string;
  status: string;
  attempt: number;
  generation?: number;
  inputHash: string;
  definitionHash: string;
  startedAt: number;
  completedAt?: number;
  input: string;
  policy: string;
  output?: string;
  error?: {
    name: string;
    message: string;
    category?: string;
    stage?: string;
    path?: string[];
  };
  request?: any;
  answer?: unknown;
}

const MAX_STEPS = 8192;
const MAX_VALUE_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL = 64 * 1024 * 1024;
const liveStores = new Map<string, WorkflowV4Store>();
const liveStoreIds = new WeakMap<WorkflowV4Store, string>();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const key = (path: string[]) => JSON.stringify(path);

function checkedPath(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 64 ||
    value.some(
      (part) =>
        typeof part !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(part),
    )
  ) {
    throw new WorkflowPersistenceError("Invalid workflow step path.");
  }
  return [...value];
}

function encoded(value: unknown): string {
  const result = encodeRunValue(value);
  if (Buffer.byteLength(result, "base64") > MAX_VALUE_BYTES)
    throw new WorkflowPersistenceError(
      "Step values exceed 512 KiB; use an artifact.",
    );
  return result;
}

export function workflowV4Steps(events: RunEvent[], limit = 256) {
  const nodes = new Map<string, V4StepNode>();
  for (const event of events) {
    if (event.kind === "v4.step") nodes.set(key(event.data.path), event.data);
  }
  const terminal = events.findLast(
    (event) => event.kind === "cancelled" || event.kind === "terminal",
  );
  const terminalStatus =
    terminal?.data.status ??
    (terminal?.kind === "cancelled" ? "cancelled" : undefined);
  const retiredStatus =
    terminalStatus === "cancelled"
      ? "cancelled"
      : terminalStatus === "error"
        ? "failed"
        : terminalStatus === "done"
          ? "skipped"
          : undefined;
  const all = [...nodes.values()].map((node) =>
    retiredStatus &&
    ["waiting_for_input", "running", "pending"].includes(node.status)
      ? { ...node, status: retiredStatus }
      : node,
  );
  const active = all.filter((node) =>
    ["waiting_for_input", "running", "pending"].includes(node.status),
  );
  const selected = new Set(active.slice(0, limit));
  for (const node of all.toReversed()) {
    if (selected.size >= limit) break;
    selected.add(node);
  }
  return all
    .filter((node) => selected.has(node))
    .map(({ input, policy, output, answer, ...node }) => node);
}

/** The journal owns step state; this adapter also serves deterministic memory tests. */
export class WorkflowV4Store {
  private nodes = new Map<string, V4StepNode>();
  private artifacts = new Map<string, { ref: any; value?: unknown }>();
  private waiters = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly definitionHash: string;

  constructor(
    private readonly source: string,
    readonly store?: WorkflowRunStore,
    private readonly onStep?: (
      steps: ReturnType<typeof workflowV4Steps>,
    ) => void,
    private readonly requestInput?: (
      request: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>,
    workflowId?: string,
  ) {
    this.definitionHash = hash(source);
    for (const event of store?.events ?? []) {
      if (event.kind === "v4.step")
        this.nodes.set(key(event.data.path), event.data);
      if (event.kind === "v4.artifact")
        this.artifacts.set(event.data.ref.id, event.data);
    }
    const liveId = workflowId ?? store?.id;
    if (liveId) {
      liveStores.set(liveId, this);
      liveStoreIds.set(this, liveId);
    }
    this.publish();
  }

  snapshot() {
    return workflowV4Steps([
      ...(this.store?.events ?? []),
      ...[...this.nodes.values()].map((data) => ({ kind: "v4.step", data })),
    ]);
  }

  getStep(path: string[]) {
    const node = this.nodes.get(key(checkedPath(path)));
    return node
      ? workflowV4Steps([{ kind: "v4.step", data: node }])[0]
      : undefined;
  }

  private publish() {
    this.onStep?.(this.snapshot());
  }

  private async save(node: V4StepNode): Promise<void> {
    if (this.closed) throw new Error("Workflow step store is closed.");
    await this.store?.append("v4.step", node);
    this.nodes.set(key(node.path), node);
    this.publish();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {
      /* The caller receives the failure; later requests can still cancel. */
    });
    return next;
  }

  private node(path: unknown): V4StepNode {
    const found = this.nodes.get(key(checkedPath(path)));
    if (!found) throw new Error("Workflow step has not started.");
    return found;
  }

  async request(
    action: string,
    payload: any,
    signal?: AbortSignal,
  ): Promise<any> {
    if (this.closed) throw new Error("Workflow step store is closed.");
    if (action === "validate")
      return validateSchema(payload.value, payload.schema);
    if (action === "gate.wait") return this.wait(payload, signal);
    return this.serialize(async () => {
      if (action === "step.enter") return this.enter(payload);
      if (action === "artifact.write") return this.writeArtifact(payload);
      if (action === "artifact.read") return this.readArtifact(payload.ref);
      if (action === "checkpoint") {
        const entered = await this.enter({
          ...payload,
          kind: "checkpoint",
          input: payload.value,
          policy: {},
        });
        if (entered.reuse) return entered.value;
        const node = this.node(payload.path);
        await this.save({
          ...node,
          status: "completed",
          output: encoded(payload.value),
          completedAt: Date.now(),
        });
        return payload.value;
      }
      if (action === "step.progress") {
        const path =
          Array.isArray(payload.path) && payload.path.length === 0
            ? []
            : checkedPath(payload.path);
        await this.store?.append("v4.progress", {
          path,
          message: String(payload.message).slice(0, 2048),
        });
        return undefined;
      }
      const node = this.node(payload.path);
      if (action === "step.complete") {
        const policy = decodeRunValue<any>(node.policy);
        await this.save({
          ...node,
          status: "completed",
          output: policy.persist === false ? undefined : encoded(payload.value),
          completedAt: Date.now(),
          error: undefined,
        });
      } else if (action === "step.fail") {
        const status = ["failed", "cancelled", "blocked", "skipped"].includes(
          payload.status,
        )
          ? payload.status
          : "failed";
        await this.save({
          ...node,
          status,
          completedAt: Date.now(),
          error: {
            name: String(payload.error?.name ?? "WorkflowError").slice(0, 128),
            message: String(
              payload.error?.message ?? "Workflow step failed",
            ).slice(0, 2048),
            ...(typeof payload.error?.category === "string"
              ? { category: payload.error.category.slice(0, 64) }
              : {}),
            ...(typeof payload.error?.stage === "string"
              ? { stage: payload.error.stage.slice(0, 64) }
              : {}),
            path: node.path,
          },
        });
      } else throw new Error(`Unknown workflow step action: ${action}`);
      return undefined;
    });
  }

  private async enter(payload: any) {
    const path = checkedPath(payload.path);
    const previous = this.nodes.get(key(path));
    if (!previous && this.nodes.size >= MAX_STEPS)
      throw new Error("Workflow step limit exceeded.");
    const input = encoded(payload.input);
    const policy = encoded(payload.policy ?? {});
    const definitionHash = hash(
      this.definitionHash + String(payload.definitionHash ?? ""),
    );
    const compatible =
      previous &&
      previous.definitionHash === definitionHash &&
      runValueMatches(previous.input, payload.input) &&
      runValueMatches(previous.policy, payload.policy ?? {});
    if (
      compatible &&
      previous.output !== undefined &&
      ["completed", "restored"].includes(previous.status) &&
      payload.policy?.resume !== false &&
      payload.policy?.persist !== false &&
      payload.policy?.cache !== false
    ) {
      const restored = { ...previous, status: "restored" };
      await this.save(restored);
      return {
        reuse: true,
        value: decodeRunValue(previous.output!),
        attempt: previous.attempt,
        idempotencyKey: hash(
          JSON.stringify([
            path,
            definitionHash,
            previous.input,
            previous.policy,
            previous.generation ?? 0,
          ]),
        ),
      };
    }
    if (
      compatible &&
      previous.status === "failed" &&
      payload.policy?.persist !== false &&
      payload.policy?.cache !== false &&
      payload.policy?.resume !== false &&
      (previous.attempt >= (payload.policy?.retry?.attempts ?? 1) ||
        previous.error?.category === "budget") &&
      ["collect", "continue"].includes(payload.policy?.failure)
    ) {
      return {
        reuse: false,
        attempt: previous.attempt,
        persistedFailure: previous.error,
        idempotencyKey: hash(
          JSON.stringify([
            path,
            definitionHash,
            previous.input,
            previous.policy,
            previous.generation ?? 0,
          ]),
        ),
      };
    }
    const freshExecution =
      compatible &&
      (["completed", "restored"].includes(previous.status) ||
        (previous.status === "failed" &&
          (payload.policy?.cache === false ||
            payload.policy?.resume === false ||
            payload.policy?.persist === false)));
    const generation = compatible
      ? (previous.generation ?? 0) + (freshExecution ? 1 : 0)
      : 0;
    const attempt =
      compatible && !freshExecution
        ? previous.attempt +
          (["failed", "cancelled", "blocked"].includes(previous.status) ? 1 : 0)
        : 1;
    const node: V4StepNode = {
      ...(compatible ? previous : {}),
      path,
      id: path.at(-1)!,
      kind: String(payload.kind ?? "step").slice(0, 32),
      title: String(payload.title ?? path.at(-1)).slice(0, 512),
      status: "running",
      attempt,
      generation,
      input,
      policy,
      inputHash: hash(input),
      definitionHash,
      startedAt: compatible ? previous.startedAt : Date.now(),
      completedAt: undefined,
      error: undefined,
    };
    await this.save(node);
    return {
      reuse: false,
      attempt,
      idempotencyKey: hash(
        JSON.stringify([path, definitionHash, input, policy, generation]),
      ),
    };
  }

  private async wait(payload: any, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const pathKey = key(checkedPath(payload.path));
    let answer: unknown;
    let answered = false;
    await this.serialize(async () => {
      const node = this.node(payload.path);
      if (Object.prototype.hasOwnProperty.call(node, "answer")) {
        answer = node.answer;
        answered = true;
        return;
      }
      const request = payload.request;
      if (
        !request ||
        typeof request !== "object" ||
        JSON.stringify(request).length > 16_384
      )
        throw new Error("Invalid or oversized workflow input request.");
      if (this.waiters.has(pathKey))
        throw new Error("Workflow input is already waiting.");
      await this.save({ ...node, status: "waiting_for_input", request });
    });
    if (answered) return answer;
    let installed:
      | { resolve: (value: unknown) => void; reject: (error: Error) => void }
      | undefined;
    const pending = new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Workflow interrupted."));
        return;
      }
      installed = { resolve, reject };
      this.waiters.set(pathKey, installed);
      // An answer can arrive between persistence and installing this waiter.
      const node = this.nodes.get(pathKey)!;
      if (Object.prototype.hasOwnProperty.call(node, "answer")) {
        this.waiters.delete(pathKey);
        resolve(node.answer);
      }
    });
    const rejectWait = (error: unknown) => {
      if (this.waiters.get(pathKey) !== installed) return;
      this.waiters.delete(pathKey);
      installed?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    };
    const waitAttempt = this.node(payload.path).attempt;
    const onAbort = () => {
      rejectWait(new Error("Workflow input was interrupted."));
      void this.serialize(async () => {
        const current = this.nodes.get(pathKey);
        if (
          !current ||
          current.status !== "waiting_for_input" ||
          current.attempt !== waitAttempt
        )
          return;
        await this.save({
          ...current,
          status: "cancelled",
          completedAt: Date.now(),
          error: {
            name: "AbortError",
            message: "Workflow input was interrupted.",
            path: current.path,
          },
        });
      }).catch(() => {
        /* Abort may race store shutdown; the invoking job still receives it. */
      });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    if (
      this.requestInput &&
      installed &&
      this.waiters.get(pathKey) === installed
    ) {
      const attempt = this.node(payload.path).attempt;
      void Promise.resolve()
        .then(() => this.requestInput!(payload.request, signal))
        .then((value) => {
          if (this.waiters.get(pathKey) !== installed) return;
          if (value === undefined)
            throw new Error("Workflow input was dismissed.");
          return this.answer(payload.path, value, attempt);
        })
        .catch(rejectWait);
    }
    return pending.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  async answer(
    path: string[],
    value: unknown,
    expectedAttempt?: number,
  ): Promise<void> {
    await this.serialize(async () => {
      const node = this.node(path);
      if (expectedAttempt !== undefined && node.attempt !== expectedAttempt)
        throw new Error("Workflow input attempt has changed.");
      if (!node.request || node.status !== "waiting_for_input")
        throw new Error("This step is not waiting for input.");
      const request = node.request;
      if (
        (request.type === "confirm" || request.kind === "gate") &&
        typeof value !== "boolean"
      )
        throw new Error("Approval requires a boolean answer.");
      if (
        request.type === "select" &&
        (!Array.isArray(request.choices) || !request.choices.includes(value))
      )
        throw new Error("Answer must match one of the choices.");
      if (request.type === "input" && typeof value !== "string")
        throw new Error("Input requires a string answer.");
      encoded(value);
      await this.save({ ...node, status: "running", answer: value });
      const waiter = this.waiters.get(key(path));
      this.waiters.delete(key(path));
      waiter?.resolve(value);
    });
  }

  private async writeArtifact(payload: any) {
    const path = checkedPath(payload.path);
    const type = payload.type === "text" ? "text" : "json";
    const content =
      type === "text" ? String(payload.value) : JSON.stringify(payload.value);
    if (typeof content !== "string")
      throw new Error("Artifact must have a serializable value.");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_ARTIFACT_BYTES)
      throw new Error("Workflow artifact exceeds 2 MiB.");
    const id = hash(key(path) + content);
    const existing = this.artifacts.get(id);
    if (existing) return existing.ref;
    if (
      [...this.artifacts.values()].reduce(
        (sum, item) => sum + item.ref.bytes,
        bytes,
      ) > MAX_ARTIFACT_TOTAL
    )
      throw new Error("Workflow artifact budget exceeded.");
    const ref = { id, type, bytes, sha256: hash(content) };
    if (this.store) {
      const dir = join(this.store.directory, "v4-artifacts");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = join(dir, `${id}.${randomUUID()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, join(dir, id));
      const directory = await open(dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      await this.store.append("v4.artifact", { ref });
    }
    this.artifacts.set(id, {
      ref,
      ...(this.store ? {} : { value: payload.value }),
    });
    return ref;
  }

  private async readArtifact(ref: any) {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.id))
      throw new Error("Invalid artifact reference.");
    const item = this.artifacts.get(ref.id);
    if (!item) throw new Error("Unknown workflow artifact.");
    if (!this.store) return item.value;
    const file = join(this.store.directory, "v4-artifacts", ref.id);
    if (
      (await stat(file)).size !== item.ref.bytes ||
      item.ref.bytes > MAX_ARTIFACT_BYTES
    )
      throw new Error("Invalid artifact size.");
    const content = await readFile(file, "utf8");
    if (hash(content) !== item.ref.sha256)
      throw new Error("Workflow artifact integrity check failed.");
    return item.ref.type === "text" ? content : JSON.parse(content);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.values())
      waiter.reject(new Error("Workflow interrupted."));
    this.waiters.clear();
    const liveId = liveStoreIds.get(this);
    if (liveId && liveStores.get(liveId) === this) liveStores.delete(liveId);
  }
}

export function getLiveWorkflowV4Store(id: string) {
  return liveStores.get(id);
}
