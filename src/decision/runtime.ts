import {
  DecisionBackendError,
  type ChoiceDecisionRequest,
  type DecisionBackendErrorCode,
  type DecisionBackend,
  type DecisionErrorReason,
  type DecisionJSONValue,
  type DecisionObservation,
  type DecisionPolicy,
  type DecisionResult,
} from "./types";
import { isValidDecisionObservation, ThresholdDecisionPolicy } from "./policy";

export const MIN_DECISION_CHOICES = 2;
export const MAX_DECISION_CHOICES = 32;
export const MAX_DECISION_CHOICE_VALUE_BYTES = 128;
export const MAX_DECISION_DESCRIPTION_BYTES = 2 * 1024;
export const MAX_DECISION_QUESTION_BYTES = 4 * 1024;
export const MAX_DECISION_INSTRUCTIONS_BYTES = 4 * 1024;
export const MAX_DECISION_STATE_BYTES = 16 * 1024;
export const MAX_DECISION_REQUEST_BYTES = 32 * 1024;
export const MAX_DECISION_DEADLINE_MS = 5 * 60 * 1_000;
const BACKEND_ERROR_CODES: readonly DecisionBackendErrorCode[] = [
  "timeout",
  "rate_limited",
  "unavailable",
  "invalid_response",
  "payload_too_large",
  "invalid_config",
  "unsupported",
];

export interface DecisionRuntimeOptions {
  deadlineMs?: number;
}

type RequestValidationReason = "invalid_input" | "payload_too_large";

type InvocationOutcome<T extends string> =
  | { kind: "observation"; observation: DecisionObservation<T> }
  | { kind: "backend_error"; error: DecisionBackendError }
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "unavailable" };

export class DecisionRuntime {
  private readonly backend: DecisionBackend;
  private readonly policy: DecisionPolicy;
  private readonly deadlineMs: number | undefined;

  constructor(
    backend: DecisionBackend,
    policy: DecisionPolicy = new ThresholdDecisionPolicy(),
    options: DecisionRuntimeOptions = {},
  ) {
    assertBackend(backend);
    assertDeadline(options.deadlineMs);
    this.backend = backend;
    this.policy = policy;
    this.deadlineMs = options.deadlineMs;
  }

  async decide<T extends string>(
    request: ChoiceDecisionRequest<T>,
    signal?: AbortSignal,
  ): Promise<DecisionResult<T>> {
    if (signal?.aborted) return { kind: "cancelled" };

    const validationReason = validateChoiceDecisionRequest(request);
    if (validationReason !== undefined) {
      return { kind: "error", reason: validationReason };
    }
    if (signal?.aborted) return { kind: "cancelled" };

    const outcome = await invokeBackend(
      this.backend,
      request,
      signal,
      this.deadlineMs,
    );
    if (outcome.kind === "cancelled") return outcome;
    if (outcome.kind !== "timeout" && signal?.aborted) {
      return { kind: "cancelled" };
    }
    if (outcome.kind === "timeout") {
      return { kind: "error", reason: "timeout" };
    }
    if (outcome.kind === "backend_error") {
      return { kind: "error", reason: outcome.error.code };
    }
    if (outcome.kind === "unavailable") {
      return { kind: "error", reason: "unavailable" };
    }
    if (signal?.aborted) return { kind: "cancelled" };
    if (!isValidDecisionObservation(outcome.observation, request)) {
      return { kind: "error", reason: "invalid_response" };
    }
    if (signal?.aborted) return { kind: "cancelled" };
    try {
      return this.policy.evaluate(outcome.observation, request);
    } catch {
      // A policy exception is a local configuration failure, not provider data.
      return { kind: "error", reason: "invalid_config" };
    }
  }
}

export function validateChoiceDecisionRequest(
  request: unknown,
): RequestValidationReason | undefined {
  try {
    return validateChoiceDecisionRequestUnsafe(request);
  } catch {
    // Request objects may be proxies or getters controlled by the caller.
    return "invalid_input";
  }
}

function validateChoiceDecisionRequestUnsafe(
  request: unknown,
): RequestValidationReason | undefined {
  if (!isRecord(request)) return "invalid_input";
  if (
    typeof request.question !== "string" ||
    request.question.trim().length === 0
  ) {
    return "invalid_input";
  }
  if (byteLength(request.question) > MAX_DECISION_QUESTION_BYTES) {
    return "payload_too_large";
  }
  if (
    request.instructions !== undefined &&
    (typeof request.instructions !== "string" ||
      request.instructions.trim().length === 0)
  ) {
    return "invalid_input";
  }
  if (
    typeof request.instructions === "string" &&
    byteLength(request.instructions) > MAX_DECISION_INSTRUCTIONS_BYTES
  ) {
    return "payload_too_large";
  }
  if (!Array.isArray(request.choices)) return "invalid_input";
  if (
    request.choices.length < MIN_DECISION_CHOICES ||
    request.choices.length > MAX_DECISION_CHOICES
  ) {
    return request.choices.length > MAX_DECISION_CHOICES
      ? "payload_too_large"
      : "invalid_input";
  }

  const values = new Set<string>();
  for (const choice of request.choices) {
    if (!isRecord(choice)) return "invalid_input";
    if (
      typeof choice.value !== "string" ||
      choice.value.trim().length === 0 ||
      values.has(choice.value)
    ) {
      return "invalid_input";
    }
    if (byteLength(choice.value) > MAX_DECISION_CHOICE_VALUE_BYTES) {
      return "payload_too_large";
    }
    if (
      typeof choice.description !== "string" ||
      choice.description.trim().length === 0
    ) {
      return "invalid_input";
    }
    if (byteLength(choice.description) > MAX_DECISION_DESCRIPTION_BYTES) {
      return "payload_too_large";
    }
    values.add(choice.value);
  }

  if (request.state !== undefined) {
    if (!isDecisionJSONValue(request.state)) return "invalid_input";
    let serializedState: string;
    try {
      serializedState = JSON.stringify(request.state);
    } catch {
      // A valid-looking object may still throw while being serialized.
      return "invalid_input";
    }
    if (byteLength(serializedState) > MAX_DECISION_STATE_BYTES) {
      return "payload_too_large";
    }
  }

  let serializedRequest: string;
  try {
    serializedRequest = JSON.stringify({
      ...(request.state === undefined ? {} : { state: request.state }),
      question: request.question,
      ...(request.instructions === undefined
        ? {}
        : { instructions: request.instructions }),
      choices: request.choices,
    });
  } catch {
    // Do not let a custom request object escape the validation boundary.
    return "invalid_input";
  }
  return byteLength(serializedRequest) > MAX_DECISION_REQUEST_BYTES
    ? "payload_too_large"
    : undefined;
}

async function invokeBackend<T extends string>(
  backend: DecisionBackend,
  request: ChoiceDecisionRequest<T>,
  callerSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): Promise<InvocationOutcome<T>> {
  if (callerSignal?.aborted) return { kind: "cancelled" };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callerAbortHandler: (() => void) | undefined;
  let resolveAbort: ((kind: "cancelled" | "timeout") => void) | undefined;
  const abortPromise = new Promise<"cancelled" | "timeout">((resolve) => {
    resolveAbort = resolve;
  });
  callerAbortHandler = () => {
    controller.abort();
    resolveAbort?.("cancelled");
  };
  callerSignal?.addEventListener("abort", callerAbortHandler, { once: true });
  if (deadlineMs !== undefined) {
    timer = setTimeout(() => {
      controller.abort();
      resolveAbort?.("timeout");
    }, deadlineMs);
    timer.unref?.();
  }

  const backendPromise = Promise.resolve().then(() =>
    backend.choose(request, controller.signal),
  );
  const operation = backendPromise.then(
    (observation): InvocationOutcome<T> => ({
      kind: "observation",
      observation,
    }),
    (error: unknown): InvocationOutcome<T> => normalizeBackendError(error),
  );
  try {
    const winner = await Promise.race([
      operation,
      abortPromise.then((kind): InvocationOutcome<T> => ({ kind })),
    ]);
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (callerAbortHandler !== undefined) {
      callerSignal?.removeEventListener("abort", callerAbortHandler);
    }
    controller.abort();
    void backendPromise.catch(() => undefined);
  }
}

function normalizeBackendError<T extends string>(
  error: unknown,
): InvocationOutcome<T> {
  if (
    error instanceof DecisionBackendError &&
    isDecisionBackendErrorCode(error.code)
  ) {
    return { kind: "backend_error", error };
  }
  return { kind: "unavailable" };
}

function isDecisionBackendErrorCode(
  value: unknown,
): value is DecisionBackendErrorCode {
  return (
    typeof value === "string" &&
    BACKEND_ERROR_CODES.includes(value as DecisionBackendErrorCode)
  );
}

function assertBackend(backend: DecisionBackend): void {
  if (
    !backend ||
    typeof backend !== "object" ||
    typeof backend.id !== "string" ||
    backend.id.trim().length === 0 ||
    typeof backend.choose !== "function"
  ) {
    throw new TypeError("a decision backend with choose() is required");
  }
}

function assertDeadline(deadlineMs: number | undefined): void {
  if (deadlineMs === undefined) return;
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 0 ||
    deadlineMs > MAX_DECISION_DEADLINE_MS
  ) {
    throw new RangeError(
      `decision deadline must be an integer from 0 to ${MAX_DECISION_DEADLINE_MS}ms`,
    );
  }
}

function isDecisionJSONValue(value: unknown): value is DecisionJSONValue {
  return isDecisionJSONValueWithAncestors(value, new Set<object>());
}

function isDecisionJSONValueWithAncestors(
  value: unknown,
  ancestors: Set<object>,
): value is DecisionJSONValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  if (Array.isArray(value)) {
    return value.every((item) =>
      isDecisionJSONValueWithAncestors(item, nextAncestors),
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) =>
    isDecisionJSONValueWithAncestors(item, nextAncestors),
  );
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
