import type { TelemetryRuntimeFailureKind } from "./telemetry";

const activeEpisodes = new Map<string, Set<TelemetryRuntimeFailureKind>>();
let nextEpisodeId = 1;

/**
 * Claim a new observed episode for an artifact and failure kind. The artifact
 * path stays process-local; the returned counter is suitable only for the
 * telemetry client's in-memory dedupe key.
 */
export function beginRuntimeFailureEpisode(
  artifactDir: string,
  kind: TelemetryRuntimeFailureKind,
): number | undefined {
  let kinds = activeEpisodes.get(artifactDir);
  if (!kinds) {
    kinds = new Set();
    activeEpisodes.set(artifactDir, kinds);
  }
  if (kinds.has(kind)) return undefined;
  kinds.add(kind);
  return nextEpisodeId++;
}

/** A known liveness/read clears only this artifact's matching outage episode. */
export function clearRuntimeFailureEpisode(
  artifactDir: string,
  kind: TelemetryRuntimeFailureKind,
): void {
  const kinds = activeEpisodes.get(artifactDir);
  if (!kinds) return;
  kinds.delete(kind);
  if (kinds.size === 0) activeEpisodes.delete(artifactDir);
}

export function runtimeFailureDedupeKey(
  kind: TelemetryRuntimeFailureKind,
  episodeId: number,
): string {
  return `runtime-failure:${kind}:${episodeId}`;
}
