import {
  listOutputHistory,
  readEvents,
  readOutputForTurnId,
  readOutputWithDiagnostics,
  type OutputHistoryEntry,
  type SubagentArtifact,
  type SubagentEvent,
} from "./artifact";
import {
  artifactReadRequest,
  planArtifactRead,
  resolveArtifactRead,
  type ArtifactReadResult,
  type ArtifactReadSource,
  type ArtifactReadValue,
} from "./artifact-read-model";

export interface ArtifactReadParams {
  readonly includeOutput?: boolean;
  readonly turnId?: string;
  readonly since?: number;
}

export interface ArtifactReadDocument {
  readonly result: ArtifactReadResult;
  readonly events: readonly SubagentEvent[];
  readonly outputHistory: readonly OutputHistoryEntry[];
}

function readSelectedOutput(
  artifact: SubagentArtifact,
  source: ArtifactReadSource,
): ArtifactReadValue {
  switch (source.kind) {
    case "not_requested":
    case "unavailable":
      return { kind: "not_read" };
    case "snapshot": {
      const content = readOutputForTurnId(artifact, source.turnId);
      return content === null
        ? { kind: "missing" }
        : { kind: "content", content };
    }
    case "staging": {
      const { content, outputError } = readOutputWithDiagnostics(artifact);
      if (outputError) return { kind: "error", error: outputError };
      return content === null
        ? { kind: "missing" }
        : { kind: "content", content };
    }
  }
}

export function readArtifactDocument(
  artifact: SubagentArtifact,
  params: ArtifactReadParams,
): ArtifactReadDocument {
  const allEvents = readEvents(artifact);
  const plan = planArtifactRead(allEvents, artifactReadRequest(params));
  const result = resolveArtifactRead(
    plan,
    readSelectedOutput(artifact, plan.source),
  );
  const since = params.since;
  const events =
    since === undefined
      ? allEvents
      : allEvents.filter((event) => event.ts >= since);
  return { result, events, outputHistory: listOutputHistory(artifact) };
}
