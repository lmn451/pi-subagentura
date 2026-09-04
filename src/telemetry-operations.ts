import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getSessionScopes,
  resolveLiveSessionScope,
  resolveToolSessionScope,
  sessionOwner,
} from "./session-scope";
import {
  captureTelemetry,
  telemetryOperationName,
  type TelemetryOperationOutcome,
  type TelemetryOperationResultStatus,
  type TelemetrySurface,
} from "./telemetry";

/** Never evaluate getters or inspect content, arguments, errors, or nested output. */
function dataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    // A host result can be a proxy; diagnostics must not change its behavior.
    return undefined;
  }
}

function resultStatus(result: unknown): TelemetryOperationResultStatus {
  switch (dataProperty(dataProperty(result, "details"), "status")) {
    case "ok":
    case "saved":
    case "deleted":
    case "updated":
    case "sent":
      return "ok";
    case "started":
      return "started";
    case "running":
    case "idle":
      return "running";
    case "done":
    case "exited":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "wait_timeout":
      return "wait_timeout";
    case "wait_cancelled":
      return "wait_cancelled";
    case "not_found":
    case "session_unavailable":
    case "lineage_unavailable":
    case "not_actionable":
    case "workflow_owned":
      return "unavailable";
    case "invalid_id":
    case "invalid_selector":
    case "invalid_context":
    case "invalid_routing_metadata":
    case "empty_message":
    case "message_too_large":
    case "confirmation_invalid":
      return "invalid_input";
    case "confirmation_required":
    case "user_confirmation_required":
      return "confirmation_required";
    case "error":
    case "send_failed":
    case "routing_metadata_error":
      return "error";
    default:
      return "unknown";
  }
}

export function withOperationTelemetry<Args extends unknown[], Result>(
  pi: ExtensionAPI,
  surface: TelemetrySurface,
  name: string,
  execute: (...args: Args) => Promise<Result> | Result,
  signalIndex?: number,
): (...args: Args) => Promise<Result> {
  const operation = telemetryOperationName(surface, name);
  const registrations = getSessionScopes().filter((scope) => scope.pi === pi);
  // Bind to one registration, never whichever parent happens to be active later.
  const token =
    registrations.length === 1 ? { id: registrations[0].id } : undefined;
  return async function (this: unknown, ...args: Args): Promise<Result> {
    const scope = token ? resolveToolSessionScope(token) : undefined;
    const telemetry = scope?.telemetry;
    if (!operation || !scope || !telemetry?.enabled || !telemetry.active) {
      return execute.apply(this, args);
    }
    const owner = sessionOwner(scope);
    const sessionRole = scope.lineageMode === "child" ? "child" : "root";
    const startedAt = Date.now();
    captureTelemetry(telemetry, {
      event: "operation_started",
      surface,
      operation,
      session_role: sessionRole,
    });
    const finish = (
      outcome: TelemetryOperationOutcome,
      result?: unknown,
    ): void => {
      if (resolveLiveSessionScope(owner)?.telemetry !== telemetry) return;
      captureTelemetry(telemetry, {
        event: "operation_completed",
        surface,
        operation,
        session_role: sessionRole,
        outcome,
        result_status: surface === "tool" ? resultStatus(result) : "unknown",
        duration_ms: Date.now() - startedAt,
      });
    };
    try {
      const result = await execute.apply(this, args);
      finish(
        dataProperty(result, "isError") === true
          ? "reported_error"
          : "returned",
        result,
      );
      return result;
    } catch (error) {
      const signal = signalIndex === undefined ? undefined : args[signalIndex];
      finish(
        signal instanceof AbortSignal && signal.aborted ? "aborted" : "threw",
      );
      throw error;
    }
  };
}

export function registerCommandWithTelemetry(
  pi: ExtensionAPI,
  name: string,
  options: Parameters<ExtensionAPI["registerCommand"]>[1],
): void {
  pi.registerCommand(name, {
    ...options,
    handler: withOperationTelemetry(pi, "command", name, options.handler),
  });
}

export function registerShortcutWithTelemetry(
  pi: ExtensionAPI,
  shortcut: Parameters<ExtensionAPI["registerShortcut"]>[0],
  options: Parameters<ExtensionAPI["registerShortcut"]>[1],
): void {
  pi.registerShortcut(shortcut, {
    ...options,
    handler: withOperationTelemetry(pi, "shortcut", shortcut, options.handler),
  });
}
