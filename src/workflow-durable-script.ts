import { createHash, randomUUID } from "node:crypto";
import type { SubagentResult, Usage } from "./helpers";
import {
  MAX_WORKFLOW_DEPTH,
  zeroUsage,
  type WorkflowAgentRunner,
  type WorkflowDurableAgentDispatchResult,
  type WorkflowDurableAgentPayload,
  type WorkflowDurableLoadedDefinition,
  type WorkflowDurableScriptAdapter,
  type WorkflowDurableWorkflowPayload,
  type WorkflowDurableWorkflowCompletion,
  type WorkflowProgress,
  type WorkflowRunResultWithUsage,
} from "./workflow-core";
import {
  decodeDurableValue,
  encodeDurableValue,
  type DurableValue,
} from "./workflow-durable-value";
import { runWorkflow } from "./workflow-worker";
import type { WorkflowAgentDispatcher } from "./workflow-dispatcher";
import {
  durableWorkflowOperationBlobCodec,
  WorkflowRunOperationJournal,
  type WorkflowRunEventDraft,
} from "./workflow-operation-journal";
import {
  WorkflowOperationGate,
  WorkflowOperationInterruptedError,
  type WorkflowOperationDispatchResult,
} from "./workflow-operation-gate";
import {
  foldWorkflowRunEvents,
  type DurableWorkflowProjection,
  type WorkflowProjectionRepository,
} from "./workflow-projection-repository";
import type {
  WorkflowRunJournal,
  WorkflowRunLease,
  WorkflowRunStore,
} from "./workflow-run-store";
import {
  ROOT_WORKFLOW_DEFINITION_PATH,
  WORKFLOW_RUN_SCHEMA_VERSION,
  appendWorkflowDefinitionPath,
  createDurableWorkflowRunId,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  isDurableWorkflowRunId,
  isWorkflowDefinitionPath,
  isWorkflowIdentifier,
  type DurableWorkflowOwner,
  type DurableWorkflowResumePolicy,
  type DurableWorkflowRunId,
  type WorkflowDefinitionDigest,
  type WorkflowBlobReference,
  type WorkflowDefinitionPath,
  type WorkflowEventReceipt,
  type WorkflowOperationRequest,
  type WorkflowResponseOrdinal,
  type WorkflowRunEpochFence,
  type WorkflowRunEvent,
} from "./workflow-run-types";
import {
  analyzeDurableWorkflow,
  parseWorkflow,
  type DurableWorkflowAnalysis,
  type DurableWorkflowOperationAnalysis,
} from "./workflow-script";

const ROOT_DEFINITION_PATH = createWorkflowDefinitionPath(
  ROOT_WORKFLOW_DEFINITION_PATH,
);
const DEFAULT_REPLAY_GAP_TIMEOUT_MS = 250;
const DURABLE_GATE_DISPATCH = Symbol("durableWorkflowGateDispatch");

type RoutedDurableDispatchRequest = Parameters<WorkflowAgentRunner>[0] & {
  readonly [DURABLE_GATE_DISPATCH]: (
    request: Parameters<WorkflowAgentRunner>[0],
  ) => Promise<SubagentResult>;
};

export function createDurableWorkflowScriptRunId(): DurableWorkflowRunId {
  return createDurableWorkflowRunId(`script-${randomUUID()}`);
}

export type DurableWorkflowScriptErrorCode =
  | "invalid_script"
  | "run_active"
  | "run_not_found"
  | "terminal_run"
  | "replay_diverged"
  | "interrupted";

export class DurableWorkflowScriptError extends Error {
  readonly code: DurableWorkflowScriptErrorCode;

  constructor(code: DurableWorkflowScriptErrorCode, message: string) {
    super(message);
    this.name = "DurableWorkflowScriptError";
    this.code = code;
  }
}

export type DurableWorkflowScriptTerminalStatus =
  "done" | "error" | "cancelled";

export interface StoredDurableWorkflowScriptResult {
  readonly terminalStatus: DurableWorkflowScriptTerminalStatus;
  readonly result: WorkflowRunResultWithUsage;
}

function isDurableRecordValue(
  value: DurableValue | undefined,
): value is { readonly [key: string]: DurableValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeStoredDurableWorkflowScriptResult(
  value: DurableValue | undefined,
): StoredDurableWorkflowScriptResult {
  if (
    !isDurableRecordValue(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "durable_script_result" ||
    (value.terminalStatus !== "done" &&
      value.terminalStatus !== "error" &&
      value.terminalStatus !== "cancelled") ||
    !isDurableRecordValue(value.result)
  ) {
    throw new DurableWorkflowScriptError(
      "invalid_script",
      "Persisted durable script result envelope is invalid.",
    );
  }
  return {
    terminalStatus: value.terminalStatus,
    result: value.result as unknown as WorkflowRunResultWithUsage,
  };
}

export interface DurableWorkflowScriptStartOptions {
  readonly script: string;
  readonly args?: unknown;
  readonly cwd: string;
  readonly budgetTotal?: number | null;
  readonly loadWorkflow?: (name: string) => string | null;
  readonly runId?: DurableWorkflowRunId;
  readonly resumePolicy?: DurableWorkflowResumePolicy;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
}

export interface DurableWorkflowScriptResumeOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
  readonly trustedActorId?: string;
}

export interface DurableWorkflowScriptExecution {
  readonly runId: DurableWorkflowRunId;
  readonly completion: Promise<WorkflowRunResultWithUsage>;
}

export interface DurableWorkflowScriptAdapterOptions {
  readonly store: WorkflowRunStore;
  readonly lease: WorkflowRunLease;
  readonly owner: DurableWorkflowOwner;
  readonly repository: WorkflowProjectionRepository;
  readonly runAgentForRun: (runId: DurableWorkflowRunId) => WorkflowAgentRunner;
  readonly dispatcher: WorkflowAgentDispatcher;
  readonly generateId?: () => string;
  readonly replayGapTimeoutMs?: number;
}

interface PreparedDefinition {
  readonly path: WorkflowDefinitionPath;
  readonly source: string;
  readonly digest: WorkflowDefinitionDigest;
  readonly name: string;
  readonly parentOperationId: string | null;
  readonly parentDefinitionPath: WorkflowDefinitionPath | null;
  readonly analysis: DurableWorkflowAnalysis;
  /** Persisted template path when this definition was materialized dynamically. */
  readonly templatePath?: WorkflowDefinitionPath;
}

interface PreparedScriptBundle {
  readonly argsPresent: boolean;
  readonly args: DurableValue;
  readonly cwd: string;
  readonly budgetTotal: number | null;
  readonly resumePolicy: DurableWorkflowResumePolicy;
  readonly definitions: readonly PreparedDefinition[];
}

interface PersistedScriptLaunch {
  readonly executionKind: "script";
  readonly argsPresent: boolean;
  readonly args: DurableValue;
  readonly cwd: string;
  readonly budgetTotal: number | null;
  readonly resumePolicy: DurableWorkflowResumePolicy;
  readonly definitions: readonly {
    readonly path: string;
    readonly name: string;
    readonly parentOperationId: string | null;
    readonly parentDefinitionPath: string | null;
    readonly analysis: DurableWorkflowAnalysis;
  }[];
}

interface ActiveScriptExecution {
  readonly runId: DurableWorkflowRunId;
  readonly journal: WorkflowRunJournal;
  readonly bundle: PreparedScriptBundle;
  readonly abort: AbortController;
  readonly externalSignal?: AbortSignal;
  readonly onProgress?: (progress: WorkflowProgress) => void;
  completion: Promise<WorkflowRunResultWithUsage>;
  interruptionReason?: "reload" | "quit" | "process_crash" | "owner_replaced";
  cancellationReason?: string;
}

type DurableResponseEnvelope = Extract<SubagentResult, { isError: false }> & {
  readonly durableScriptResponse?: unknown;
};

type DurableAgentCallResult = WorkflowDurableAgentDispatchResult & {
  readonly cancelled?: true;
};

interface OrderedWaiter<T> {
  readonly ordinal: number;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  readonly deliver: () => T;
}

interface ResponseLane {
  next: number;
  readonly pending: Map<number, OrderedWaiter<unknown>>;
  timer?: ReturnType<typeof setTimeout>;
  failure?: DurableWorkflowScriptError;
}

export function prepareDurableWorkflowScript(
  script: string,
  options: {
    readonly args?: unknown;
    readonly cwd: string;
    readonly budgetTotal?: number | null;
    readonly loadWorkflow?: (name: string) => string | null;
    readonly resumePolicy?: DurableWorkflowResumePolicy;
  },
): PreparedScriptBundle {
  const definitions: PreparedDefinition[] = [];
  const capture = (
    source: string,
    path: WorkflowDefinitionPath,
    parentDefinitionPath: WorkflowDefinitionPath | null,
    parentOperationId: string | null,
    depth: number,
    ancestorDigests: ReadonlySet<WorkflowDefinitionDigest>,
  ): void => {
    const digest = sourceDigest(source);
    if (ancestorDigests.has(digest)) {
      throw new DurableWorkflowScriptError(
        "invalid_script",
        `Durable workflow definition cycle reaches ${path}.`,
      );
    }
    const analysis = analyzeDurableWorkflow(source, {
      allowNested: depth < MAX_WORKFLOW_DEPTH,
    });
    const meta = parseWorkflow(source).meta;
    definitions.push({
      path,
      source,
      digest,
      name: meta.name,
      parentDefinitionPath,
      parentOperationId,
      analysis,
    });
    const nextAncestors = new Set(ancestorDigests);
    nextAncestors.add(digest);
    for (const [operationIndex, operation] of analysis.operations.entries()) {
      if (operation.kind !== "workflow") continue;
      const name = operation.name;
      if (name === undefined) {
        throw new DurableWorkflowScriptError(
          "invalid_script",
          "Durable workflow analysis omitted a saved-workflow name.",
        );
      }
      const child = options.loadWorkflow?.(name) ?? null;
      if (child === null) {
        throw new DurableWorkflowScriptError(
          "invalid_script",
          `Durable workflow(): no saved workflow named "${name}".`,
        );
      }
      const operationId =
        operation.id ?? dynamicWorkflowTemplateId(operationIndex);
      capture(
        child,
        appendWorkflowDefinitionPath(path, operationId),
        path,
        operationId,
        depth + 1,
        nextAncestors,
      );
    }
  };
  capture(
    script,
    ROOT_DEFINITION_PATH,
    null,
    null,
    0,
    new Set<WorkflowDefinitionDigest>(),
  );
  const encodedArgs = encodeDurableValue(
    options.args === undefined ? null : options.args,
  );
  const resumePolicy = options.resumePolicy ?? "trusted_resume";
  if (
    resumePolicy !== "automatic_on_reload_or_resume" &&
    resumePolicy !== "trusted_resume" &&
    resumePolicy !== "never"
  ) {
    throw new DurableWorkflowScriptError(
      "invalid_script",
      "Durable script resume policy is invalid.",
    );
  }
  return Object.freeze({
    argsPresent: options.args !== undefined,
    args: decodeDurableValue(encodedArgs.json),
    cwd: options.cwd,
    budgetTotal: options.budgetTotal ?? null,
    resumePolicy,
    definitions: Object.freeze(definitions),
  });
}

export class DurableWorkflowScriptControllerAdapter {
  readonly #lease: WorkflowRunLease;
  readonly #owner: DurableWorkflowOwner;
  readonly #repository: WorkflowProjectionRepository;
  readonly #runAgentForRun: (
    runId: DurableWorkflowRunId,
  ) => WorkflowAgentRunner;
  readonly #dispatcher: WorkflowAgentDispatcher;
  readonly #generateId: () => string;
  readonly #replayGapTimeoutMs: number;
  readonly #active = new Map<DurableWorkflowRunId, ActiveScriptExecution>();

  constructor(options: DurableWorkflowScriptAdapterOptions) {
    this.#lease = options.lease;
    this.#owner = options.owner;
    this.#repository = options.repository;
    this.#runAgentForRun = options.runAgentForRun;
    this.#dispatcher = options.dispatcher;
    this.#generateId = options.generateId ?? randomUUID;
    this.#replayGapTimeoutMs =
      options.replayGapTimeoutMs ?? DEFAULT_REPLAY_GAP_TIMEOUT_MS;
  }

  async startScript(
    options: DurableWorkflowScriptStartOptions,
  ): Promise<DurableWorkflowScriptExecution> {
    const bundle = prepareDurableWorkflowScript(options.script, options);
    const runId = options.runId ?? createDurableWorkflowScriptRunId();
    if (!isDurableWorkflowRunId(runId)) {
      throw new DurableWorkflowScriptError(
        "invalid_script",
        "Durable workflow run ID is invalid.",
      );
    }
    if (this.#active.has(runId)) {
      throw new DurableWorkflowScriptError(
        "run_active",
        `Durable workflow run ${runId} already has an executor.`,
      );
    }
    const launch: PersistedScriptLaunch = {
      executionKind: "script",
      argsPresent: bundle.argsPresent,
      args: bundle.args,
      cwd: bundle.cwd,
      budgetTotal: bundle.budgetTotal,
      resumePolicy: bundle.resumePolicy,
      definitions: bundle.definitions.map((definition) => ({
        path: definition.path,
        name: definition.name,
        parentOperationId: definition.parentOperationId,
        parentDefinitionPath: definition.parentDefinitionPath,
        analysis: definition.analysis,
      })),
    };
    const journal = await this.#lease.createRun({ runId, launch });
    const references = new Map<WorkflowDefinitionPath, WorkflowBlobReference>();
    for (const definition of bundle.definitions) {
      const reference = await journal.writeDefinition(definition.source);
      if (reference.sha256 !== definition.digest) {
        throw new DurableWorkflowScriptError(
          "invalid_script",
          `Immutable durable definition ${definition.path} changed while it was captured.`,
        );
      }
      references.set(definition.path, reference);
    }
    const fence = requiredFence(journal);
    await this.#appendEvent(
      journal,
      "run_created",
      {
        durableOwner: this.#owner,
        executionKind: "script",
        rootDefinitionPath: ROOT_DEFINITION_PATH,
        rootDefinitionDigest: bundle.definitions[0].digest,
        resumePolicy: bundle.resumePolicy,
      },
      false,
    );
    await this.#appendEvent(journal, "run_epoch_acquired", {
      fence,
      previousRunEpoch: null,
      reason: "created",
    });
    for (const definition of bundle.definitions) {
      const reference = references.get(definition.path);
      if (reference === undefined) {
        throw new DurableWorkflowScriptError(
          "invalid_script",
          `Durable definition ${definition.path} was not captured.`,
        );
      }
      await this.#appendEvent(
        journal,
        "definition_captured",
        definition.parentOperationId === null
          ? {
              captureKind: "root",
              definitionPath: definition.path,
              definitionDigest: definition.digest,
              definition: reference,
            }
          : {
              captureKind: "nested",
              definitionPath: definition.path,
              definitionDigest: definition.digest,
              definition: reference,
              parentOperation: createWorkflowOperationIdentity(
                runId,
                definition.parentDefinitionPath!,
                definition.parentOperationId,
              ),
            },
      );
    }
    const execution = this.#newExecution(journal, bundle, options);
    return this.#startExecution(execution);
  }

  async resumeRecovered(
    recovered: DurableWorkflowProjection,
    reason: "startup" | "reload" | "resume" | "trusted_resume",
    options: DurableWorkflowScriptResumeOptions = {},
  ): Promise<DurableWorkflowScriptExecution> {
    if (
      reason === "trusted_resume" &&
      !isWorkflowIdentifier(options.trustedActorId)
    ) {
      throw new DurableWorkflowScriptError(
        "invalid_script",
        "Trusted durable script resume requires a valid actor ID.",
      );
    }
    if (recovered.executionKind !== "script") {
      throw new DurableWorkflowScriptError(
        "invalid_script",
        `Durable workflow run ${recovered.runId} is not a script.`,
      );
    }
    if (recovered.terminal !== undefined) {
      throw new DurableWorkflowScriptError(
        "terminal_run",
        `Durable workflow run ${recovered.runId} is already terminal.`,
      );
    }
    if (this.#active.has(recovered.runId)) {
      throw new DurableWorkflowScriptError(
        "run_active",
        `Durable workflow run ${recovered.runId} already has an executor.`,
      );
    }
    const journal = await this.#lease.acquireRun(
      recovered.runId,
      reason === "reload"
        ? "reload"
        : reason === "startup"
          ? "startup"
          : "resume",
    );
    let projection = await this.#refresh(journal);
    if (projection.cancellationRequestedEventId !== undefined) {
      for (const operation of projection.operations) {
        const attempt = operation.attempts.at(-1);
        if (attempt?.status !== "started") continue;
        await this.#appendEvent(journal, "attempt_cancelled", {
          attempt: attempt.attempt,
          reason: "Recovered committed cancellation request.",
        });
      }
      projection = await this.#refresh(journal);
      const cancellation = (await journal.readEvents()).find(
        (event) =>
          event.eventId === projection.cancellationRequestedEventId &&
          event.type === "run_cancellation_requested",
      );
      const cancellationReason =
        cancellation?.type === "run_cancellation_requested"
          ? cancellation.payload.reason
          : "Recovered committed cancellation request.";
      const bundle = await this.#readBundle(journal);
      const result =
        (await this.#readProjectionResult(journal, projection)) ??
        terminalFallback(bundle, projection, cancellationReason);
      const completion = this.#recordResult(
        journal,
        result,
        "cancelled",
        cancellationReason,
      );
      return Object.freeze({ runId: recovered.runId, completion });
    }
    if (projection.status !== "interrupted") {
      await this.#appendEvent(journal, "run_interrupted", {
        reason: reason === "reload" ? "reload" : "process_crash",
      });
      projection = await this.#refresh(journal);
    }
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (attempt?.status !== "started") continue;
      await this.#appendEvent(journal, "attempt_interrupted", {
        attempt: attempt.attempt,
        reason: "recovery",
      });
    }
    const bundle = await this.#readBundle(journal);
    await this.#appendEvent(journal, "run_resumed", {
      reason:
        reason === "trusted_resume"
          ? "trusted_resume"
          : reason === "reload"
            ? "reload"
            : "resume",
      ...(reason === "trusted_resume"
        ? { trustedActorId: options.trustedActorId! }
        : {}),
    });
    const execution = this.#newExecution(journal, bundle, options);
    return this.#startExecution(execution);
  }

  async trustedCancel(
    projection: DurableWorkflowProjection,
    reason: string,
    trustedActorId: string,
  ): Promise<WorkflowRunResultWithUsage> {
    const active = this.#active.get(projection.runId);
    if (active !== undefined) {
      if (active.cancellationReason === undefined) {
        active.cancellationReason = reason;
        await this.#appendEvent(active.journal, "run_cancellation_requested", {
          reason,
          trustedActorId,
        });
        active.abort.abort(reason);
      }
      try {
        return await active.completion;
      } catch {
        const stored = await this.#readStoredResult(active.journal);
        if (stored !== undefined) return stored;
        throw new DurableWorkflowScriptError(
          "interrupted",
          `Durable workflow run ${projection.runId} cancellation did not commit a result.`,
        );
      }
    }
    const journal = await this.#lease.acquireRun(projection.runId, "resume");
    let refreshed = await this.#refresh(journal);
    if (refreshed.terminal !== undefined) {
      const stored = await this.#readProjectionResult(journal, refreshed);
      if (stored !== undefined) return stored;
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: terminal durable workflow run ${projection.runId} has no result`,
      );
    }
    if (refreshed.cancellationRequestedEventId === undefined) {
      await this.#appendEvent(journal, "run_cancellation_requested", {
        reason,
        trustedActorId,
      });
      refreshed = await this.#refresh(journal);
    }
    for (const operation of refreshed.operations) {
      const attempt = operation.attempts.at(-1);
      if (attempt?.status !== "started") continue;
      await this.#appendEvent(journal, "attempt_cancelled", {
        attempt: attempt.attempt,
        reason,
      });
    }
    refreshed = await this.#refresh(journal);
    const bundle = await this.#readBundle(journal);
    const result =
      (await this.#readProjectionResult(journal, refreshed)) ??
      terminalFallback(bundle, refreshed, reason);
    return this.#recordResult(journal, result, "cancelled", reason);
  }

  async interrupt(
    reason: "reload" | "quit" | "process_crash" | "owner_replaced",
    runId?: DurableWorkflowRunId,
  ): Promise<void> {
    const active =
      runId === undefined
        ? [...this.#active.values()]
        : [this.#active.get(runId)].filter(
            (execution): execution is ActiveScriptExecution =>
              execution !== undefined,
          );
    for (const execution of active) {
      if (execution.cancellationReason === undefined) {
        execution.interruptionReason = reason;
      }
      if (!execution.abort.signal.aborted) execution.abort.abort(reason);
    }
    await Promise.allSettled(active.map((execution) => execution.completion));
  }

  #newExecution(
    journal: WorkflowRunJournal,
    bundle: PreparedScriptBundle,
    options: DurableWorkflowScriptResumeOptions,
  ): ActiveScriptExecution {
    const abort = new AbortController();
    if (options.signal?.aborted) abort.abort(options.signal.reason);
    return {
      runId: journal.runId,
      journal,
      bundle,
      abort,
      externalSignal: options.signal,
      onProgress: options.onProgress,
      completion: undefined as unknown as Promise<WorkflowRunResultWithUsage>,
      ...(options.signal?.aborted
        ? { interruptionReason: "owner_replaced" as const }
        : {}),
    };
  }

  #startExecution(
    execution: ActiveScriptExecution,
  ): DurableWorkflowScriptExecution {
    this.#active.set(execution.runId, execution);
    const forwardAbort = () => {
      if (execution.cancellationReason === undefined) {
        execution.interruptionReason = "owner_replaced";
      }
      if (!execution.abort.signal.aborted) {
        execution.abort.abort(execution.externalSignal?.reason);
      }
    };
    execution.externalSignal?.addEventListener("abort", forwardAbort, {
      once: true,
    });
    const completion = this.#execute(execution).finally(() => {
      execution.externalSignal?.removeEventListener("abort", forwardAbort);
      if (this.#active.get(execution.runId) === execution) {
        this.#active.delete(execution.runId);
      }
    });
    execution.completion = completion;
    return Object.freeze({ runId: execution.runId, completion });
  }

  async #execute(
    execution: ActiveScriptExecution,
  ): Promise<WorkflowRunResultWithUsage> {
    const root = execution.bundle.definitions[0];
    const runAgent = this.#runAgentForRun(execution.runId);
    const durableScript = new OperationAdapter({
      journal: execution.journal,
      bundle: execution.bundle,
      replayGapTimeoutMs: this.#replayGapTimeoutMs,
      refresh: () => this.#refresh(execution.journal),
      interruptionReason: () => execution.interruptionReason,
    });
    try {
      const result = await runWorkflow(root.source, {
        args: execution.bundle.argsPresent ? execution.bundle.args : undefined,
        cwd: execution.bundle.cwd,
        budgetTotal: execution.bundle.budgetTotal,
        runAgent,
        signal: execution.abort.signal,
        onProgress: execution.onProgress,
        dispatcher: this.#dispatcher,
        loadWorkflow: () => null,
        durableScript,
      });
      if (execution.interruptionReason !== undefined) {
        await this.#finishInterruption(execution);
      }
      if (execution.cancellationReason !== undefined) {
        const projection = await this.#refresh(execution.journal);
        const cancelled = {
          ...result,
          result: null,
          usage: { ...projection.accounting.usage },
        };
        await this.#recordResult(
          execution.journal,
          cancelled,
          "cancelled",
          execution.cancellationReason,
        );
        return cancelled;
      }
      const projection = await this.#refresh(execution.journal);
      const committed = {
        ...result,
        usage: { ...projection.accounting.usage },
        tokensSpent: projection.accounting.usage.output,
      };
      await this.#recordResult(execution.journal, committed, "done");
      return committed;
    } catch (error) {
      await durableScript.drain();
      if (
        execution.interruptionReason !== undefined &&
        execution.cancellationReason === undefined
      ) {
        await this.#finishInterruption(execution);
      }
      const projection = await this.#refresh(execution.journal);
      if (projection.result !== undefined) {
        // The committed result is authoritative. Recovery repairs any missing
        // terminal/result binding; never append a conflicting fallback result.
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      const failed = terminalFallback(execution.bundle, projection, message);
      const terminalStatus =
        execution.cancellationReason === undefined ? "error" : "cancelled";
      await this.#recordResult(
        execution.journal,
        failed,
        terminalStatus,
        execution.cancellationReason,
      );
      if (terminalStatus === "cancelled") {
        return Object.assign(failed, { cancelled: true as const });
      }
      throw error;
    }
  }

  async #finishInterruption(execution: ActiveScriptExecution): Promise<never> {
    const reason = execution.interruptionReason ?? "owner_replaced";
    let projection = await this.#refresh(execution.journal);
    if (projection.status !== "interrupted") {
      await this.#appendEvent(execution.journal, "run_interrupted", { reason });
      projection = await this.#refresh(execution.journal);
    }
    for (const operation of projection.operations) {
      const attempt = operation.attempts.at(-1);
      if (attempt?.status !== "started") continue;
      await this.#appendEvent(execution.journal, "attempt_interrupted", {
        attempt: attempt.attempt,
        reason: "process_exit",
      });
    }
    throw new DurableWorkflowScriptError(
      "interrupted",
      `Durable workflow run ${execution.runId} was interrupted (${reason}).`,
    );
  }
  async #recordResult(
    journal: WorkflowRunJournal,
    result: WorkflowRunResultWithUsage,
    status: "done" | "error" | "cancelled",
    cancellationReason?: string,
  ): Promise<WorkflowRunResultWithUsage> {
    let projection = await this.#refresh(journal);
    let reference = projection.result?.result;
    let resultEventId = projection.result?.eventId;
    let authoritative = result;
    if (reference === undefined || resultEventId === undefined) {
      reference = await journal.writeOutput({
        schemaVersion: 1,
        kind: "durable_script_result",
        terminalStatus: status,
        result,
      });
      const resultEvent = await this.#appendEvent(
        journal,
        "run_result_recorded",
        {
          result: reference,
          accounting: projection.accounting,
        },
      );
      resultEventId = resultEvent.eventId;
      projection = await this.#refresh(journal);
    } else {
      const stored = decodeStoredDurableWorkflowScriptResult(
        await journal.readOutput(reference),
      );
      if (stored.terminalStatus !== status) {
        throw new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: recorded script result status is ${stored.terminalStatus}, not ${status}`,
        );
      }
      authoritative = stored.result;
    }
    if (status === "cancelled" && projection.status !== "cancelled") {
      await this.#appendEvent(journal, "run_cancelled", {
        reason: cancellationReason ?? "Cancelled by trusted request.",
        accounting: projection.accounting,
      });
      projection = await this.#refresh(journal);
    }
    if (projection.terminal !== undefined) return authoritative;
    const terminal = await this.#appendEvent(journal, "run_terminal", {
      status,
      accounting: projection.accounting,
      resultEventId,
    });
    await journal.writeResult({
      terminalEventId: terminal.eventId,
      baseEventByteEndExclusive: terminal.receipt.byteEndExclusive,
      result: reference,
    });
    await this.#refresh(journal);
    return authoritative;
  }

  async #readStoredResult(
    journal: WorkflowRunJournal,
  ): Promise<WorkflowRunResultWithUsage | undefined> {
    const binding = await journal.readResult();
    if (binding === undefined) return undefined;
    return decodeStoredDurableWorkflowScriptResult(
      await journal.readOutput(binding.result),
    ).result;
  }

  async #readProjectionResult(
    journal: WorkflowRunJournal,
    projection: DurableWorkflowProjection,
  ): Promise<WorkflowRunResultWithUsage | undefined> {
    if (projection.result === undefined) return undefined;
    return decodeStoredDurableWorkflowScriptResult(
      await journal.readOutput(projection.result.result),
    ).result;
  }

  async #readBundle(
    journal: WorkflowRunJournal,
  ): Promise<PreparedScriptBundle> {
    const launch = journal.readLaunch() as unknown as PersistedScriptLaunch;
    if (
      launch === null ||
      typeof launch !== "object" ||
      launch.executionKind !== "script" ||
      !Array.isArray(launch.definitions) ||
      typeof launch.cwd !== "string"
    ) {
      throw new DurableWorkflowScriptError(
        "invalid_script",
        "Persisted durable script launch is invalid.",
      );
    }
    const projection = await this.#refresh(journal);
    const definitions: PreparedDefinition[] = [];
    for (const persisted of launch.definitions) {
      if (
        !isWorkflowDefinitionPath(persisted.path) ||
        typeof persisted.name !== "string" ||
        (persisted.parentOperationId !== null &&
          !isWorkflowIdentifier(persisted.parentOperationId)) ||
        (persisted.parentDefinitionPath !== null &&
          !isWorkflowDefinitionPath(persisted.parentDefinitionPath)) ||
        (persisted.parentOperationId === null) !==
          (persisted.parentDefinitionPath === null) ||
        (persisted.parentDefinitionPath !== null &&
          persisted.parentOperationId !== null &&
          appendWorkflowDefinitionPath(
            persisted.parentDefinitionPath,
            persisted.parentOperationId,
          ) !== persisted.path)
      ) {
        throw new DurableWorkflowScriptError(
          "invalid_script",
          "Persisted durable script definition metadata is invalid.",
        );
      }
      const captured = projection.definitions.find(
        (candidate) => candidate.definitionPath === persisted.path,
      );
      if (captured === undefined) {
        throw new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: captured definition ${persisted.path} is missing`,
        );
      }
      const source = await journal.readDefinition(captured.definition);
      const digest = sourceDigest(source);
      if (digest !== captured.definitionDigest) {
        throw new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: captured definition ${persisted.path} changed`,
        );
      }
      const analysis = analyzeDurableWorkflow(source, {
        allowNested: true,
      });
      if (
        encodeDurableValue(analysis).sha256 !==
        encodeDurableValue(persisted.analysis).sha256
      ) {
        throw new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: operation table for ${persisted.path} changed`,
        );
      }
      definitions.push({
        path: persisted.path,
        source,
        digest,
        name: persisted.name,
        parentOperationId: persisted.parentOperationId,
        parentDefinitionPath: persisted.parentDefinitionPath,
        analysis,
      });
    }
    return {
      argsPresent: launch.argsPresent,
      args: launch.args,
      cwd: launch.cwd,
      budgetTotal: launch.budgetTotal,
      resumePolicy: launch.resumePolicy,
      definitions,
    };
  }

  async #refresh(
    journal: WorkflowRunJournal,
  ): Promise<DurableWorkflowProjection> {
    const projection = foldWorkflowRunEvents(await journal.readEvents());
    await this.#repository.replace(this.#owner, projection);
    return projection;
  }

  async #appendEvent<Type extends WorkflowRunEvent["type"]>(
    journal: WorkflowRunJournal,
    type: Type,
    payload: Extract<WorkflowRunEvent, { type: Type }>["payload"],
    refresh = true,
  ): Promise<{
    readonly eventId: string;
    readonly receipt: WorkflowEventReceipt;
  }> {
    const fence = requiredFence(journal);
    const { event, receipt } = await new WorkflowRunOperationJournal(
      journal,
      this.#generateId,
    ).appendEvent(fence, { type, payload } as WorkflowRunEventDraft<Type>);
    if (refresh) await this.#refresh(journal);
    return { eventId: event.eventId, receipt };
  }
}

class OperationAdapter implements WorkflowDurableScriptAdapter {
  readonly rootDefinitionPath = ROOT_DEFINITION_PATH;
  readonly #journal: WorkflowRunJournal;
  readonly #bundle: PreparedScriptBundle;
  readonly #operationJournal: WorkflowRunOperationJournal;
  readonly #gate: WorkflowOperationGate;
  readonly #fence: WorkflowRunEpochFence;
  readonly #refresh: () => Promise<DurableWorkflowProjection>;
  readonly #replayGapTimeoutMs: number;
  readonly #runtimeDefinitions = new Map<
    WorkflowDefinitionPath,
    PreparedDefinition
  >();
  readonly #interruptionReason: () =>
    ActiveScriptExecution["interruptionReason"] | undefined;
  readonly #lanes = new Map<WorkflowDefinitionPath, ResponseLane>();
  readonly #executions = new Map<string, Promise<unknown>>();

  constructor(options: {
    readonly journal: WorkflowRunJournal;
    readonly bundle: PreparedScriptBundle;
    readonly replayGapTimeoutMs: number;
    readonly interruptionReason: () =>
      ActiveScriptExecution["interruptionReason"] | undefined;
    readonly refresh: () => Promise<DurableWorkflowProjection>;
  }) {
    this.#journal = options.journal;
    this.#bundle = options.bundle;
    this.#operationJournal = new WorkflowRunOperationJournal(options.journal);
    this.#gate = new WorkflowOperationGate({
      journal: this.#operationJournal,
      blobCodec: durableWorkflowOperationBlobCodec,
      dispatcher: {
        run: (request) => {
          const route = (request as Partial<RoutedDurableDispatchRequest>)[
            DURABLE_GATE_DISPATCH
          ];
          if (route === undefined) {
            throw new DurableWorkflowScriptError(
              "replay_diverged",
              "replay_diverged: durable operation gate lost its dispatcher route",
            );
          }
          return route(request);
        },
      },
    });
    this.#fence = requiredFence(options.journal);
    this.#refresh = options.refresh;
    this.#replayGapTimeoutMs = options.replayGapTimeoutMs;
    this.#interruptionReason = options.interruptionReason;
  }
  async drain(): Promise<void> {
    await Promise.allSettled(this.#executions.values());
  }

  async runAgent(
    payload: WorkflowDurableAgentPayload,
    dispatch: (
      request: Parameters<WorkflowAgentRunner>[0],
    ) => Promise<WorkflowDurableAgentDispatchResult>,
  ): Promise<WorkflowDurableAgentDispatchResult> {
    const definition = this.#requiredDefinition(payload.definitionPath);
    const id = requiredOperationId(payload.opts?.id, "agent");
    requiredOperation(definition, id, "agent");
    const isolation = payload.opts?.isolation ?? "process";
    const effectiveModel = payload.effectiveModel ?? payload.opts?.model;
    const settings = encodeDurableValue({
      prompt: payload.prompt,
      persona: payload.opts?.persona ?? null,
      model: effectiveModel ?? null,
      isolation,
      schema: payload.opts?.schema ?? null,
      label: payload.opts?.label ?? null,
      phase: payload.opts?.phase ?? null,
      agentType: payload.opts?.agentType ?? null,
      thinkingLevel: payload.opts?.thinkingLevel ?? null,
    });
    const request = await this.#operationJournal.prepareOperation(
      this.#fence,
      operationPreparation(
        this.#journal.runId,
        definition,
        id,
        settings.sha256,
      ),
    );
    return this.#executeOrdered(
      definition.path,
      request,
      {
        prompt: typeof payload.prompt === "string" ? payload.prompt : "",
        persona: payload.opts?.persona,
        model: effectiveModel,
        isolation,
        label: payload.opts?.label,
        schema: payload.opts?.schema,
        thinkingLevel: payload.opts?.thinkingLevel,
      },
      dispatch,
    );
  }

  async loadWorkflow(
    payload: WorkflowDurableWorkflowPayload,
    _load: (name: string) => string | null,
  ): Promise<WorkflowDurableLoadedDefinition> {
    const { child } = await this.#prepareWorkflow(payload);
    return { script: child.source, definitionPath: child.path };
  }

  async completeWorkflow(
    payload: WorkflowDurableWorkflowPayload,
    completion: WorkflowDurableWorkflowCompletion,
  ): Promise<unknown> {
    if (
      completion === null ||
      typeof completion !== "object" ||
      (completion.status !== "succeeded" &&
        (completion.status !== "failed" ||
          typeof completion.error !== "string"))
    ) {
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        "replay_diverged: worker supplied an invalid nested workflow completion",
      );
    }
    const { parent, id, request } = await this.#prepareWorkflow(payload);
    const response = await this.#executeOrdered(
      parent.path,
      request,
      {
        prompt: `durable-workflow:${id}`,
        isolation: "in-process",
      },
      async () => {
        if (completion.status === "failed") {
          throw new Error(completion.error);
        }
        return {
          value: completion.value,
          tokensDelta: 0,
          usage: zeroUsage(),
        };
      },
    );
    return response.value;
  }

  async #prepareWorkflow(payload: WorkflowDurableWorkflowPayload): Promise<{
    readonly parent: PreparedDefinition;
    readonly child: PreparedDefinition;
    readonly id: string;
    readonly request: WorkflowOperationRequest;
  }> {
    const parent = this.#requiredDefinition(payload.parentDefinitionPath);
    const id = requiredOperationId(payload.opts?.id, "workflow");
    const operation = requiredOperation(
      parent,
      id,
      "workflow",
      typeof payload.name === "string" ? payload.name : undefined,
    );
    if (typeof payload.name !== "string" || payload.name !== operation.name) {
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: nested workflow ${id} changed its saved name`,
      );
    }
    const child = await this.#materializeChild(parent, operation, id);
    const settings = encodeDurableValue({
      name: payload.name,
      args: payload.args ?? null,
      nestedDefinitionDigest: child.digest,
    });
    const request = await this.#operationJournal.prepareOperation(
      this.#fence,
      operationPreparation(this.#journal.runId, parent, id, settings.sha256),
    );
    return { parent, child, id, request };
  }

  #executeOrdered<T extends WorkflowDurableAgentDispatchResult>(
    path: WorkflowDefinitionPath,
    request: WorkflowOperationRequest,
    dispatchRequest: Parameters<WorkflowAgentRunner>[0],
    dispatch: (
      request: Parameters<WorkflowAgentRunner>[0],
    ) => Promise<WorkflowDurableAgentDispatchResult>,
  ): Promise<T> {
    const key = `${path}\u0000${request.identity.operationId}`;
    const existing = this.#executions.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const execution = this.#executeGate<T>(
      path,
      request,
      dispatchRequest,
      dispatch,
    );
    this.#executions.set(key, execution);
    return execution;
  }

  async #executeGate<T extends WorkflowDurableAgentDispatchResult>(
    path: WorkflowDefinitionPath,
    request: WorkflowOperationRequest,
    dispatchRequest: Parameters<WorkflowAgentRunner>[0],
    dispatch: (
      request: Parameters<WorkflowAgentRunner>[0],
    ) => Promise<WorkflowDurableAgentDispatchResult>,
  ): Promise<T> {
    const routedRequest: RoutedDurableDispatchRequest = {
      ...dispatchRequest,
      [DURABLE_GATE_DISPATCH]: async (request) => {
        try {
          await this.#refresh();
          const response = (await dispatch(request)) as DurableAgentCallResult;
          if (response.cancelled && this.#interruptionReason() !== undefined) {
            throw scriptOperationInterruption(
              this.#interruptionReason()!,
              response.usage,
            );
          }
          return {
            isError: false,
            output: response.cancelled ? String(response.value ?? "") : "",
            usage: response.usage,
            ...(response.cancelled ? { cancelled: true as const } : {}),
            durableScriptResponse: response,
          } as DurableResponseEnvelope;
        } catch (error) {
          const reason = this.#interruptionReason();
          if (
            reason !== undefined &&
            !(error instanceof WorkflowOperationInterruptedError)
          ) {
            const usage = (error as { readonly usage?: Usage } | null)?.usage;
            throw scriptOperationInterruption(reason, usage);
          }
          throw error;
        }
      },
    };
    let outcome: WorkflowOperationDispatchResult | undefined;
    let failure: unknown;
    try {
      outcome = await this.#gate.execute(this.#fence, request, routedRequest);
    } catch (error) {
      failure = error;
    }
    await this.#refresh();
    const state = await this.#operationJournal.readOperation(
      this.#fence,
      request.identity,
    );
    const ordinal = state.settlement?.responseOrdinal;
    if (ordinal === undefined) {
      if (failure !== undefined) throw failure;
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: operation ${request.identity.operationId} has no committed response ordinal`,
      );
    }
    return this.#releaseInOrder(path, ordinal, () => {
      if (failure !== undefined) throw failure;
      const envelope = outcome as DurableResponseEnvelope | null;
      if (
        envelope !== null &&
        typeof envelope === "object" &&
        "durableScriptResponse" in envelope
      ) {
        return envelope.durableScriptResponse as T;
      }
      if (
        envelope !== null &&
        typeof envelope === "object" &&
        envelope.cancelled === true
      ) {
        return {
          value: null,
          tokensDelta: envelope.usage.output,
          usage: envelope.usage,
          cancelled: true,
        } as unknown as T;
      }
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: operation ${request.identity.operationId} has an invalid committed response`,
      );
    });
  }

  #releaseInOrder<T>(
    path: WorkflowDefinitionPath,
    ordinal: WorkflowResponseOrdinal,
    deliver: () => T,
  ): Promise<T> {
    let lane = this.#lanes.get(path);
    if (lane === undefined) {
      lane = { next: 1, pending: new Map() };
      this.#lanes.set(path, lane);
    }
    if (lane.failure !== undefined) return Promise.reject(lane.failure);
    if (ordinal < lane.next || lane.pending.has(ordinal)) {
      return Promise.reject(
        new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: response ordinal ${ordinal} for ${path} was duplicated`,
        ),
      );
    }
    return new Promise<T>((resolve, reject) => {
      lane?.pending.set(ordinal, {
        ordinal,
        resolve: resolve as (value: unknown) => void,
        reject,
        deliver,
      });
      this.#flushLane(path, lane as ResponseLane);
    });
  }

  #flushLane(path: WorkflowDefinitionPath, lane: ResponseLane): void {
    for (;;) {
      const waiter = lane.pending.get(lane.next);
      if (waiter === undefined) break;
      lane.pending.delete(lane.next);
      lane.next += 1;
      try {
        waiter.resolve(waiter.deliver());
      } catch (error) {
        waiter.reject(error);
      }
    }
    if (lane.pending.size === 0) {
      if (lane.timer !== undefined) clearTimeout(lane.timer);
      lane.timer = undefined;
      return;
    }
    if (lane.timer !== undefined) return;
    lane.timer = setTimeout(() => {
      const failure = new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: expected response ordinal ${lane.next} for ${path} was not requested`,
      );
      lane.failure = failure;
      for (const waiter of lane.pending.values()) waiter.reject(failure);
      lane.pending.clear();
      lane.timer = undefined;
    }, this.#replayGapTimeoutMs);
  }

  async #materializeChild(
    parent: PreparedDefinition,
    operation: DurableWorkflowOperationAnalysis,
    operationId: string,
  ): Promise<PreparedDefinition> {
    const childPath = appendWorkflowDefinitionPath(parent.path, operationId);
    const existingRuntime = this.#runtimeDefinitions.get(childPath);
    if (existingRuntime !== undefined) return existingRuntime;
    const operationIndex = parent.analysis.operations.indexOf(operation);
    const templateOperationId =
      operation.id ?? dynamicWorkflowTemplateId(operationIndex);
    const templateParentPath = parent.templatePath ?? parent.path;
    const template = this.#requiredDefinition(
      appendWorkflowDefinitionPath(templateParentPath, templateOperationId),
    );
    const child =
      childPath === template.path
        ? template
        : {
            ...template,
            path: childPath,
            parentDefinitionPath: parent.path,
            parentOperationId: operationId,
            templatePath: template.templatePath ?? template.path,
          };
    this.#runtimeDefinitions.set(childPath, child);
    await this.#captureRuntimeDefinition(child, parent, operationId);
    return child;
  }

  async #captureRuntimeDefinition(
    child: PreparedDefinition,
    parent: PreparedDefinition,
    operationId: string,
  ): Promise<void> {
    const projection = await this.#refresh();
    const existing = projection.definitions.find(
      (candidate) => candidate.definitionPath === child.path,
    );
    if (existing !== undefined) {
      if (
        existing.definitionDigest !== child.digest ||
        existing.parentOperation?.definitionPath !== parent.path ||
        existing.parentOperation.operationId !== operationId
      ) {
        throw new DurableWorkflowScriptError(
          "replay_diverged",
          `replay_diverged: dynamic definition ${child.path} conflicts with committed evidence`,
        );
      }
      return;
    }
    const reference = await this.#journal.writeDefinition(child.source);
    if (reference.sha256 !== child.digest) {
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: dynamic definition ${child.path} changed while captured`,
      );
    }
    await this.#operationJournal.appendEvent(this.#fence, {
      type: "definition_captured",
      payload: {
        captureKind: "nested",
        definitionPath: child.path,
        definitionDigest: child.digest,
        definition: reference,
        parentOperation: createWorkflowOperationIdentity(
          this.#journal.runId,
          parent.path,
          operationId,
        ),
      },
    });
    await this.#refresh();
  }

  #requiredDefinition(path: string): PreparedDefinition {
    if (!isWorkflowDefinitionPath(path)) {
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        "replay_diverged: worker supplied an invalid definition path",
      );
    }
    const definition =
      this.#runtimeDefinitions.get(path) ??
      this.#bundle.definitions.find((candidate) => candidate.path === path);
    if (definition === undefined) {
      throw new DurableWorkflowScriptError(
        "replay_diverged",
        `replay_diverged: definition ${path} was not captured`,
      );
    }
    return definition;
  }
}

function operationPreparation(
  runId: DurableWorkflowRunId,
  definition: PreparedDefinition,
  operationId: string,
  digest: string,
): Omit<WorkflowOperationRequest, "dispatchOrdinal"> {
  return {
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    identity: createWorkflowOperationIdentity(
      runId,
      definition.path,
      operationId,
    ),
    requestDigest: createWorkflowRequestDigest(digest),
    definitionDigest: definition.digest,
  };
}

function scriptOperationInterruption(
  reason: NonNullable<ActiveScriptExecution["interruptionReason"]>,
  usage?: Usage,
): WorkflowOperationInterruptedError {
  return new WorkflowOperationInterruptedError(
    reason === "process_crash" || reason === "quit"
      ? "process_exit"
      : "owner_replaced",
    `Durable workflow script operation interrupted (${reason}).`,
    usage,
  );
}

function requiredOperation(
  definition: PreparedDefinition,
  operationId: string,
  kind: "agent" | "workflow",
  workflowName?: string,
): DurableWorkflowOperationAnalysis {
  const operation =
    definition.analysis.operations.find(
      (candidate) => candidate.id === operationId && candidate.kind === kind,
    ) ??
    definition.analysis.operations.find(
      (candidate) =>
        candidate.dynamicId === true &&
        candidate.kind === kind &&
        (kind !== "workflow" ||
          workflowName === undefined ||
          candidate.name === workflowName),
    );
  if (operation === undefined) {
    throw new DurableWorkflowScriptError(
      "replay_diverged",
      `replay_diverged: operation ${operationId} is not in captured definition ${definition.path}`,
    );
  }
  return operation;
}

function dynamicWorkflowTemplateId(operationIndex: number): string {
  return `dynamic-workflow-${operationIndex + 1}`;
}

function requiredOperationId(
  value: unknown,
  kind: "agent" | "workflow",
): string {
  if (!isWorkflowIdentifier(value)) {
    throw new DurableWorkflowScriptError(
      "replay_diverged",
      `replay_diverged: durable ${kind}() omitted its explicit operation id`,
    );
  }
  return value;
}

function sourceDigest(source: string): WorkflowDefinitionDigest {
  return createWorkflowDefinitionDigest(
    createHash("sha256").update(source).digest("hex"),
  );
}

function requiredFence(journal: WorkflowRunJournal): WorkflowRunEpochFence {
  if (journal.fence === undefined) {
    throw new DurableWorkflowScriptError(
      "interrupted",
      `Durable workflow run ${journal.runId} has no current epoch fence.`,
    );
  }
  return journal.fence;
}

function terminalFallback(
  bundle: PreparedScriptBundle,
  projection: DurableWorkflowProjection,
  message: string,
): WorkflowRunResultWithUsage {
  const meta = parseWorkflow(bundle.definitions[0].source).meta;
  return {
    meta,
    result: { error: message },
    agentsSpawned: projection.operations.filter(
      (operation) =>
        bundle.definitions
          .find(
            (definition) =>
              definition.path === operation.identity.definitionPath,
          )
          ?.analysis.operations.some(
            (candidate) =>
              candidate.kind === "agent" &&
              (candidate.dynamicId === true ||
                candidate.id === operation.identity.operationId),
          ) === true,
    ).length,
    errorCount: 1,
    tokensSpent: projection.accounting.usage.output,
    usage: { ...projection.accounting.usage },
    phases: [],
  };
}
