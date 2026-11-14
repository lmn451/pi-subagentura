import {
  planArtifactRead,
  resolveArtifactRead,
  type ArtifactReadPlan,
  type ArtifactReadResult,
} from "../src/artifact-read-model";

const metadata = planArtifactRead([], { kind: "metadata" });
const turn = planArtifactRead([], { kind: "turn", turnId: "turn-1" });
const latest = planArtifactRead([], { kind: "latest" });

const snapshotKind: "snapshot" = turn.source.kind;
const metadataKind: "not_requested" = metadata.source.kind;
void snapshotKind;
void metadataKind;

resolveArtifactRead(metadata, { kind: "not_read" });
resolveArtifactRead(turn, { kind: "content", content: "answer" });
resolveArtifactRead(latest, { kind: "content", content: "partial" });

// @ts-expect-error Metadata requests cannot select a snapshot.
const metadataSnapshot: ArtifactReadPlan = {
  ...metadata,
  source: { kind: "snapshot", turnId: "turn-1" },
};
// @ts-expect-error Metadata requests cannot select mutable staging output.
const metadataStaging: ArtifactReadPlan = {
  ...metadata,
  source: { kind: "staging" },
};
// @ts-expect-error Explicit turns cannot read mutable staging output.
const turnStaging: ArtifactReadPlan = {
  ...turn,
  request: { kind: "turn", turnId: "turn-1" },
  source: { kind: "staging" },
};
// @ts-expect-error Metadata reads cannot receive content.
resolveArtifactRead(metadata, { kind: "content", content: "answer" });
// @ts-expect-error Metadata reads cannot receive a missing snapshot result.
resolveArtifactRead(metadata, { kind: "missing" });

const metadataResult = resolveArtifactRead(metadata, { kind: "not_read" });
// @ts-expect-error Metadata results cannot expose output content.
metadataResult.output.content;
// @ts-expect-error A metadata plan cannot be paired with content-bearing output.
const metadataContent: ArtifactReadResult = {
  ...metadataResult,
  output: { kind: "available", content: "answer" },
};

const outputResult = resolveArtifactRead(turn, {
  kind: "content",
  content: "answer",
});
// @ts-expect-error Output requests cannot produce metadata-only output.
const outputNotRequested: ArtifactReadResult = {
  ...outputResult,
  output: { kind: "not_requested" },
};
void outputNotRequested;

void metadataSnapshot;
void metadataStaging;
void turnStaging;
void metadataContent;
