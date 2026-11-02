import { posix, win32 } from "node:path";
import type { TelemetrySessionHost } from "./telemetry";

const MAX_SOURCE_FIELD_LENGTH = 4_096;

function sourceField(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_SOURCE_FIELD_LENGTH
    ? trimmed
    : undefined;
}

/**
 * Orca's bundled stampRuntimeSourceEnv replaces inherited launch-source stamps.
 * Agterm's skill sets AGTERM_ENABLED=1 in spawned shells, including its quick
 * terminal. Both signals are measurement-only: inherited values are not live
 * process or routing authority. Conflicting valid host signals fail closed.
 */
export function resolveTelemetrySessionHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TelemetrySessionHost {
  const sourceId = sourceField(env.ORCA_RUNTIME_SOURCE_ID);
  const incarnation = sourceField(env.ORCA_RUNTIME_SOURCE_INCARNATION);
  const profile = sourceField(env.ORCA_RUNTIME_SOURCE_PROFILE_PATH);
  const pathApi = platform === "win32" ? win32 : posix;
  const hasOrcaLaunchOrigin = Boolean(
    sourceId && incarnation && profile && pathApi.isAbsolute(profile),
  );
  const hasAgtermMarker = env.AGTERM_ENABLED === "1";

  if (hasOrcaLaunchOrigin && hasAgtermMarker) return "unknown";
  if (hasOrcaLaunchOrigin) return "orca";
  return hasAgtermMarker ? "agterm" : "unknown";
}
