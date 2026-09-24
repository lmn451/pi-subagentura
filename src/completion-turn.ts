import { randomUUID } from "node:crypto";
import { debugLog } from "./helpers";
import { asStringIdentifier, type WakeId } from "./identifier-types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CompletionMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

type SendUserMessage = (
  content: string,
  options: { deliverAs: "followUp" },
) => unknown;

interface CompletionTurnOptions {
  deliverAs: "followUp";
  triggerTurn: boolean;
  parentStreaming: boolean;
  /**
   * Called once when an idle synthetic wake reaches its bounded retry cap
   * without entering before_agent_start. The caller may release any
   * turn-fence state that would otherwise block subsequent completions.
   */
  onWakeExhausted?: () => void;
}

interface WakeState {
  activeWakeId: string;
  wakeIds: Set<string>;
  inFlight: boolean;
  wakePromptStarted: boolean;
  wakePromptSettled: boolean;
  wakeAttempts: number;
  ackAttempts: number;
  wakeExhaustedCallbacks: Set<() => void>;
  watchdogTimer?: ReturnType<typeof setTimeout>;
  ackRetryTimer?: ReturnType<typeof setTimeout>;
}
interface CompletionTurnGlobalState {
  __piSubagenturaCompletionTurnWakeStates?: WeakMap<ExtensionAPI, WakeState>;
}

function completionTurnGlobals(): typeof globalThis &
  CompletionTurnGlobalState {
  return globalThis as typeof globalThis & CompletionTurnGlobalState;
}

interface WakeRequestEntry {
  schemaVersion: 1;
  state: "requested";
  wakeId: string;
}

interface WakeAcknowledgementEntry {
  schemaVersion: 1;
  state: "acknowledged";
  wakeIds: string[];
}

export const ORCHESTRATOR_V2_WAKE_ENTRY_TYPE = "orchestratorv2-completion-wake";
export const ORCHESTRATOR_V2_WAKE_DETAIL_KEY = "orchestratorV2WakeId";
export const ORCHESTRATOR_V2_WAKEUP_MESSAGE =
  "[Orchestratorv2 coordinator wakeup] One or more completion events were " +
  "delivered immediately before this extension-generated message. Apply the " +
  "active thin-router policy: route or surface them without performing " +
  "specialist work.";
const ORCHESTRATOR_V2_WAKE_ID_TAG = "orchestratorv2-wake-id";

/** Delay between a wake request and a retry when no matching run starts. */
export const ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS = 30_000;
/** Maximum automatic wake requests in one bounded retry cycle. */
export const ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS = 3;
/** Delay between durable acknowledgement attempts after a transient failure. */
export const ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS = 1_000;
/** Maximum durable acknowledgement attempts in one bounded retry cycle. */
export const ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS = 3;

// Pi may load delivery and lifecycle extension graphs with separate module
// caches. Process-global state lets both copies coordinate the same live wake.
const wakeStates =
  (completionTurnGlobals().__piSubagenturaCompletionTurnWakeStates ??=
    new WeakMap<ExtensionAPI, WakeState>());

function clearWakeWatchdog(state: WakeState): void {
  if (state.watchdogTimer === undefined) return;
  clearTimeout(state.watchdogTimer);
  state.watchdogTimer = undefined;
}

function clearWakeAcknowledgementRetry(state: WakeState): void {
  if (state.ackRetryTimer === undefined) return;
  clearTimeout(state.ackRetryTimer);
  state.ackRetryTimer = undefined;
}

function notifyWakeExhausted(pi: ExtensionAPI, state: WakeState): void {
  if (
    wakeStates.get(pi) !== state ||
    state.wakePromptStarted ||
    state.wakePromptSettled ||
    state.wakeAttempts < ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS
  ) {
    return;
  }
  state.inFlight = false;
  const callbacks = [...state.wakeExhaustedCallbacks];
  state.wakeExhaustedCallbacks.clear();
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      debugLog("error", "orchestratorv2_wake_exhaustion_callback_failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }
  }
}

export function clearCompletionTurnWake(pi: ExtensionAPI): void {
  const state = wakeStates.get(pi);
  if (state) {
    clearWakeWatchdog(state);
    clearWakeAcknowledgementRetry(state);
  }
  wakeStates.delete(pi);
}

/**
 * Persist the acknowledgement for the active wake. Callers that observe
 * lifecycle events should use settleCompletionTurnWake() so unrelated runs
 * cannot acknowledge a pending request.
 */
export function acknowledgeCompletionTurnWake(pi: ExtensionAPI): boolean {
  const state = wakeStates.get(pi);
  if (!state) return false;
  clearWakeWatchdog(state);
  clearWakeAcknowledgementRetry(state);
  return attemptWakeAcknowledgement(pi, state);
}

function attemptWakeAcknowledgement(
  pi: ExtensionAPI,
  state: WakeState,
): boolean {
  if (wakeStates.get(pi) !== state) return false;
  state.ackAttempts += 1;
  try {
    const entry: WakeAcknowledgementEntry = {
      schemaVersion: 1,
      state: "acknowledged",
      wakeIds: [...state.wakeIds],
    };
    pi.appendEntry(ORCHESTRATOR_V2_WAKE_ENTRY_TYPE, entry);
    clearCompletionTurnWake(pi);
    return true;
  } catch (error) {
    if (wakeStates.get(pi) === state) {
      state.inFlight = false;
      if (state.wakePromptSettled) {
        scheduleWakeAcknowledgementRetry(pi, state);
      }
    }
    debugLog("error", "orchestratorv2_wake_ack_failed", {
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return false;
  }
}

function scheduleWakeAcknowledgementRetry(
  pi: ExtensionAPI,
  state: WakeState,
): void {
  clearWakeAcknowledgementRetry(state);
  if (state.ackAttempts >= ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS) return;
  const timer = setTimeout(() => {
    state.ackRetryTimer = undefined;
    if (wakeStates.get(pi) !== state || !state.wakePromptSettled) return;
    attemptWakeAcknowledgement(pi, state);
  }, ORCHESTRATOR_V2_WAKE_ACK_RETRY_DELAY_MS);
  state.ackRetryTimer = timer;
  timer.unref?.();
}

/**
 * Mark the exact synthetic user prompt that belongs to the active wake. Pi
 * does not include a run id in lifecycle events, so the prompt observed by
 * before_agent_start is the run identity we can safely carry to settlement.
 */
export function markCompletionTurnWakeStarted(
  pi: ExtensionAPI,
  prompt: string,
): boolean {
  const state = wakeStates.get(pi);
  if (!state || prompt !== orchestratorV2WakeupMessage(state.activeWakeId)) {
    return false;
  }
  state.wakePromptStarted = true;
  state.wakePromptSettled = false;
  state.inFlight = false;
  state.wakeExhaustedCallbacks.clear();
  clearWakeWatchdog(state);
  return true;
}

/** Acknowledge only the run previously marked by markCompletionTurnWakeStarted. */
export function settleCompletionTurnWake(pi: ExtensionAPI): boolean {
  const state = wakeStates.get(pi);
  if (!state || !state.wakePromptStarted || state.wakePromptSettled) {
    return false;
  }
  state.wakePromptSettled = true;
  return acknowledgeCompletionTurnWake(pi);
}

export function isOrchestratorV2Enabled(pi: ExtensionAPI): boolean {
  const getFlag = (pi as Partial<ExtensionAPI>).getFlag;
  return (
    typeof getFlag === "function" && getFlag.call(pi, "orchestratorv2") === true
  );
}

export function isOrchestratorMode(pi: ExtensionAPI): boolean {
  const getFlag = (pi as Partial<ExtensionAPI>).getFlag;
  if (typeof getFlag !== "function") return false;
  try {
    return (
      getFlag.call(pi, "orchestrator") === true ||
      getFlag.call(pi, "orchestratorv2") === true
    );
  } catch {
    /* Flag access is unavailable in lightweight host contexts. */
    return false;
  }
}

/**
 * Restore an unacknowledged wake only after its custom completion message is
 * durable. This closes the crash window between pointer delivery and the
 * synthetic turn that installs the per-turn Orchestratorv2 prompt.
 */
export function recoverCompletionTurnWakes(
  pi: ExtensionAPI,
  entries: readonly unknown[],
): boolean {
  if (!isOrchestratorV2Enabled(pi)) return false;
  const requested = new Set<string>();
  const acknowledged = new Set<string>();
  const delivered = new Set<string>();
  for (const entry of entries) {
    const wakeEntry = wakeEntryData(entry);
    if (wakeEntry?.state === "requested") requested.add(wakeEntry.wakeId);
    if (wakeEntry?.state === "acknowledged") {
      for (const wakeId of wakeEntry.wakeIds) acknowledged.add(wakeId);
    }
    const deliveredWakeId = deliveredWakeIdFromEntry(entry);
    if (deliveredWakeId) delivered.add(deliveredWakeId);
  }
  const recoverable = [...requested].filter(
    (wakeId) => !acknowledged.has(wakeId) && delivered.has(wakeId),
  );
  if (recoverable.length === 0) return false;

  const existing = wakeStates.get(pi);
  if (
    existing &&
    existing.activeWakeId === recoverable[0] &&
    existing.wakeIds.size === recoverable.length &&
    recoverable.every((wakeId) => existing.wakeIds.has(wakeId))
  ) {
    return true;
  }

  clearCompletionTurnWake(pi);
  const state: WakeState = {
    activeWakeId: recoverable[0],
    wakeIds: new Set(recoverable),
    inFlight: false,
    wakePromptStarted: false,
    wakePromptSettled: false,
    wakeAttempts: 0,
    ackAttempts: 0,
    wakeExhaustedCallbacks: new Set(),
  };
  wakeStates.set(pi, state);
  requestPromptWake(pi, state);
  return true;
}

/**
 * Pi custom-message turns bypass before_agent_start while idle. Wake an idle
 * Orchestratorv2 session through the user-message path so its prompt policy is
 * installed; a streaming turn already has that policy for its queued follow-up.
 */
export function sendCompletionTurn(
  pi: ExtensionAPI,
  message: CompletionMessage,
  options: CompletionTurnOptions,
): void {
  const wakeThroughPrompt =
    options.triggerTurn &&
    !options.parentStreaming &&
    isOrchestratorV2Enabled(pi);
  if (!wakeThroughPrompt) {
    pi.sendMessage(message, {
      deliverAs: options.deliverAs,
      triggerTurn: options.triggerTurn,
    });
    return;
  }

  let state = wakeStates.get(pi);
  if (!state) {
    const wakeId: WakeId = asStringIdentifier<"wake">(randomUUID());
    const request: WakeRequestEntry = {
      schemaVersion: 1,
      state: "requested",
      wakeId,
    };
    pi.appendEntry(ORCHESTRATOR_V2_WAKE_ENTRY_TYPE, request);
    state = {
      activeWakeId: wakeId,
      wakeIds: new Set([wakeId]),
      inFlight: false,
      wakePromptStarted: false,
      wakePromptSettled: false,
      wakeAttempts: 0,
      ackAttempts: 0,
      wakeExhaustedCallbacks: new Set(),
    };
    wakeStates.set(pi, state);
  }

  if (!state.inFlight && state.wakePromptSettled) {
    clearWakeAcknowledgementRetry(state);
    state.wakePromptStarted = false;
    state.wakePromptSettled = false;
    state.wakeAttempts = 0;
    state.ackAttempts = 0;
    state.wakeExhaustedCallbacks.clear();
  }

  if (
    !state.inFlight &&
    !state.wakePromptStarted &&
    !state.wakePromptSettled &&
    state.ackRetryTimer === undefined &&
    state.ackAttempts >= ORCHESTRATOR_V2_WAKE_ACK_MAX_ATTEMPTS
  ) {
    state.ackAttempts = 0;
  }

  if (
    !state.inFlight &&
    !state.wakePromptStarted &&
    !state.wakePromptSettled &&
    state.wakeAttempts >= ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS
  ) {
    state.wakeAttempts = 0;
  }

  if (
    !state.inFlight &&
    !state.wakePromptStarted &&
    !state.wakePromptSettled &&
    options.onWakeExhausted
  ) {
    state.wakeExhaustedCallbacks.add(options.onWakeExhausted);
  }

  pi.sendMessage(withWakeId(message, state.activeWakeId), {
    deliverAs: options.deliverAs,
    triggerTurn: false,
  });
  requestPromptWake(pi, state);
}

function requestPromptWake(pi: ExtensionAPI, state: WakeState): void {
  if (
    state.inFlight ||
    state.wakePromptStarted ||
    state.wakePromptSettled ||
    state.ackRetryTimer !== undefined ||
    state.wakeAttempts >= ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS
  ) {
    return;
  }
  state.inFlight = true;
  state.wakeAttempts += 1;
  try {
    const sendUserMessage = pi.sendUserMessage as unknown as SendUserMessage;
    const result = sendUserMessage(
      orchestratorV2WakeupMessage(state.activeWakeId),
      {
        deliverAs: "followUp",
      },
    );
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
  } catch (error) {
    state.inFlight = false;
    if (wakeStates.get(pi) === state && !state.wakePromptStarted) {
      scheduleWakeWatchdog(pi, state);
    }
    throw error;
  }
  if (wakeStates.get(pi) !== state || state.wakePromptStarted) return;
  scheduleWakeWatchdog(pi, state);
}

function scheduleWakeWatchdog(pi: ExtensionAPI, state: WakeState): void {
  clearWakeWatchdog(state);
  const timer = setTimeout(() => {
    state.watchdogTimer = undefined;
    if (wakeStates.get(pi) !== state || state.wakePromptStarted) return;
    state.inFlight = false;
    if (state.wakeAttempts >= ORCHESTRATOR_V2_WAKE_MAX_ATTEMPTS) {
      notifyWakeExhausted(pi, state);
      return;
    }
    try {
      requestPromptWake(pi, state);
    } catch (error) {
      debugLog("error", "orchestratorv2_wake_send_failed", {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }
  }, ORCHESTRATOR_V2_WAKE_WATCHDOG_DELAY_MS);
  state.watchdogTimer = timer;
  timer.unref?.();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    !("then" in value)
  ) {
    return false;
  }
  return typeof value.then === "function";
}

export function orchestratorV2WakeupMessage(wakeId: string): string {
  if (!isWakeId(wakeId)) throw new Error("invalid Orchestratorv2 wake id");
  return `${ORCHESTRATOR_V2_WAKEUP_MESSAGE}\n[${ORCHESTRATOR_V2_WAKE_ID_TAG}:${wakeId}]`;
}

export function isOrchestratorV2WakeupMessage(value: string): boolean {
  if (!value.includes(ORCHESTRATOR_V2_WAKEUP_MESSAGE)) return false;
  const match = value.match(
    new RegExp(`\\[${ORCHESTRATOR_V2_WAKE_ID_TAG}:([^\\]]+)\\]`),
  );
  return match !== null && isWakeId(match[1]);
}

function withWakeId(
  message: CompletionMessage,
  wakeId: string,
): CompletionMessage {
  const details = isRecord(message.details) ? message.details : {};
  return {
    ...message,
    details: { ...details, [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]: wakeId },
  };
}

function wakeEntryData(
  entry: unknown,
): WakeRequestEntry | WakeAcknowledgementEntry | undefined {
  if (!isRecord(entry) || entry.type !== "custom") return undefined;
  if (entry.customType !== ORCHESTRATOR_V2_WAKE_ENTRY_TYPE) return undefined;
  const data = entry.data;
  if (!isRecord(data) || data.schemaVersion !== 1) return undefined;
  if (data.state === "requested" && isWakeId(data.wakeId)) {
    return data as unknown as WakeRequestEntry;
  }
  if (
    data.state === "acknowledged" &&
    Array.isArray(data.wakeIds) &&
    data.wakeIds.every(isWakeId)
  ) {
    return data as unknown as WakeAcknowledgementEntry;
  }
  return undefined;
}

function deliveredWakeIdFromEntry(entry: unknown): string | undefined {
  if (!isRecord(entry) || entry.type !== "custom_message") return undefined;
  const message = isRecord(entry.message) ? entry.message : undefined;
  const details = isRecord(entry.details)
    ? entry.details
    : isRecord(message?.details)
      ? message.details
      : undefined;
  const wakeId = details?.[ORCHESTRATOR_V2_WAKE_DETAIL_KEY];
  return isWakeId(wakeId) ? wakeId : undefined;
}

function isWakeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
