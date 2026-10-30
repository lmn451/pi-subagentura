import { posix, win32 } from "node:path";
import type { TelemetrySessionHost } from "./telemetry";

const MAX_SOURCE_FIELD_LENGTH = 4_096;

function sourceField(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed &&
    trimmed.length <= MAX_SOURCE_FIELD_LENGTH &&
    !/[\x00-\x1f\x7f]/.test(trimmed)
    ? trimmed
    : undefined;
}

/**
 * Orca's bundled stampRuntimeSourceEnv replaces inherited launch-source stamps.
 * This is launch-origin measurement, not live-process or routing authority:
 * another standalone root can inherit a valid stamp and retain that origin.
 */
export function resolveTelemetrySessionHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TelemetrySessionHost {
  const sourceId = sourceField(env.ORCA_RUNTIME_SOURCE_ID);
  const incarnation = sourceField(env.ORCA_RUNTIME_SOURCE_INCARNATION);
  const profile = sourceField(env.ORCA_RUNTIME_SOURCE_PROFILE_PATH);
  const pathApi = platform === "win32" ? win32 : posix;
  if (!sourceId || !incarnation || !profile || !pathApi.isAbsolute(profile)) {
    return "unknown";
  }
  return "orca";
}
