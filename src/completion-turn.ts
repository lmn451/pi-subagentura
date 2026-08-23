import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CompletionMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

interface CompletionTurnOptions {
  deliverAs: "followUp";
  triggerTurn: boolean;
  parentStreaming: boolean;
}

interface WakeState {
  activeWakeId: string;
  wakeIds: Set<string>;
  inFlight: boolean;
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

const wakeStates = new WeakMap<ExtensionAPI, WakeState>();

export function clearCompletionTurnWake(pi: ExtensionAPI): void {
  wakeStates.delete(pi);
}

export function acknowledgeCompletionTurnWake(pi: ExtensionAPI): void {
  const state = wakeStates.get(pi);
  if (!state) return;
  try {
    const entry: WakeAcknowledgementEntry = {
      schemaVersion: 1,
      state: "acknowledged",
      wakeIds: [...state.wakeIds],
    };
    pi.appendEntry(ORCHESTRATOR_V2_WAKE_ENTRY_TYPE, entry);
    clearCompletionTurnWake(pi);
  } catch (error) {
    if (wakeStates.get(pi) === state) state.inFlight = false;
    console.error(
      "[subagentura] Orchestratorv2 completion wake acknowledgement failed",
      error,
    );
  }
}

export function isOrchestratorV2Enabled(pi: ExtensionAPI): boolean {
  const getFlag = (pi as Partial<ExtensionAPI>).getFlag;
  return (
    typeof getFlag === "function" && getFlag.call(pi, "orchestratorv2") === true
  );
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
  clearCompletionTurnWake(pi);
  const state: WakeState = {
    activeWakeId: recoverable[0],
    wakeIds: new Set(recoverable),
    inFlight: false,
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
    const wakeId = randomUUID();
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
    };
    wakeStates.set(pi, state);
  }

  pi.sendMessage(withWakeId(message, state.activeWakeId), {
    deliverAs: options.deliverAs,
    triggerTurn: false,
  });
  requestPromptWake(pi, state);
}

function requestPromptWake(pi: ExtensionAPI, state: WakeState): void {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    pi.sendUserMessage(orchestratorV2WakeupMessage(state.activeWakeId), {
      deliverAs: "followUp",
    });
  } catch (error) {
    state.inFlight = false;
    throw error;
  }
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
