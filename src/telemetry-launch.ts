import {
  captureTelemetry,
  type TelemetryLaunchResolution,
  type TelemetrySession,
} from "./telemetry";

export type TelemetryLaunchRequest = Omit<
  TelemetryLaunchResolution,
  | "outcome"
  | "execution"
  | "mux"
  | "duration_ms"
  | "fallback_attempted"
  | "initial_failure_stage"
  | "initial_failure_operation"
  | "final_failure_stage"
  | "final_failure_operation"
>;

export type TelemetryLaunchResult = Pick<
  TelemetryLaunchResolution,
  "outcome" | "mux" | "fallback_attempted"
> &
  Partial<
    Pick<
      TelemetryLaunchResolution,
      | "execution"
      | "initial_failure_stage"
      | "initial_failure_operation"
      | "final_failure_stage"
      | "final_failure_operation"
    >
  >;

/** The one-shot resolver returned for a single logical child launch. */
export type TelemetryLaunchResolutionReporter = (
  result: TelemetryLaunchResult,
) => void;

/** Create a local one-shot reporter for one logical child launch. */
export function createLaunchResolutionReporter(
  session: TelemetrySession | undefined,
  request: TelemetryLaunchRequest,
  startedAt: number,
): TelemetryLaunchResolutionReporter {
  let resolved = false;
  return (result) => {
    if (resolved) return;
    resolved = true;
    try {
      captureTelemetry(
        session,
        {
          event: "agent_launch_resolved",
          ...request,
          ...result,
          duration_ms: Date.now() - startedAt,
        },
        { allowInactive: true },
      );
    } catch {
      // Telemetry must never change launch behavior.
    }
  };
}
