import { beforeEach, describe, expect, it, vi } from "vitest";
import * as artifactIO from "../src/artifact";
import { readArtifactDocument } from "../src/artifact-read";

vi.mock("../src/artifact", () => ({
  readEvents: vi.fn(),
  readOutputForTurnId: vi.fn(),
  readOutputWithDiagnostics: vi.fn(),
  listOutputHistory: vi.fn(),
}));

const artifact = {} as artifactIO.SubagentArtifact;
const start: artifactIO.SubagentEvent = {
  version: 2,
  eventId: "start",
  turnId: "turn",
  ts: 100,
  type: "turn_started",
  status: "running",
};
const completion: artifactIO.SubagentEvent = {
  version: 2,
  eventId: "done",
  turnId: "turn",
  ts: 50,
  type: "completion",
  status: "done",
  outcome: "done",
  source: "agent_settled",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(artifactIO.readEvents).mockReturnValue([start]);
  vi.mocked(artifactIO.listOutputHistory).mockReturnValue([]);
  vi.mocked(artifactIO.readOutputForTurnId).mockReturnValue("snapshot");
  vi.mocked(artifactIO.readOutputWithDiagnostics).mockReturnValue({
    content: "staging",
  });
});

describe("artifact read IO planning", () => {
  it("does not read output for metadata requests", () => {
    const document = readArtifactDocument(artifact, { includeOutput: false });
    expect(document.result.output.kind).toBe("not_requested");
    expect(artifactIO.readOutputForTurnId).not.toHaveBeenCalled();
    expect(artifactIO.readOutputWithDiagnostics).not.toHaveBeenCalled();
  });

  it("reads staging only for an active lifecycle", () => {
    expect(readArtifactDocument(artifact, {}).result.output).toEqual({
      kind: "available",
      content: "staging",
    });
    expect(
      artifactIO.readOutputWithDiagnostics,
    ).toHaveBeenCalledExactlyOnceWith(artifact);
    expect(artifactIO.readOutputForTurnId).not.toHaveBeenCalled();
  });

  it("does not read unassociated staging output", () => {
    vi.mocked(artifactIO.readEvents).mockReturnValue([]);
    expect(readArtifactDocument(artifact, {}).result.output.kind).toBe(
      "pending",
    );
    expect(artifactIO.readOutputWithDiagnostics).not.toHaveBeenCalled();
  });

  it("selects immutable output before applying the display timestamp filter", () => {
    vi.mocked(artifactIO.readEvents).mockReturnValue([start, completion]);
    const document = readArtifactDocument(artifact, { since: 75 });
    expect(document.events).toEqual([start]);
    expect(document.result.status).toBe("done");
    expect(document.result.output).toEqual({
      kind: "available",
      content: "snapshot",
    });
    expect(artifactIO.readOutputForTurnId).toHaveBeenCalledExactlyOnceWith(
      artifact,
      "turn",
    );
    expect(artifactIO.readOutputWithDiagnostics).not.toHaveBeenCalled();
  });

  it("honors an explicit turn even when output is otherwise disabled", () => {
    readArtifactDocument(artifact, { turnId: "older", includeOutput: false });
    expect(artifactIO.readOutputForTurnId).toHaveBeenCalledExactlyOnceWith(
      artifact,
      "older",
    );
    expect(artifactIO.readOutputWithDiagnostics).not.toHaveBeenCalled();
  });

  it("never falls back to staging when an immutable snapshot is missing", () => {
    vi.mocked(artifactIO.readEvents).mockReturnValue([start, completion]);
    vi.mocked(artifactIO.readOutputForTurnId).mockReturnValue(null);
    expect(readArtifactDocument(artifact, {}).result.output.kind).toBe(
      "missing",
    );
    expect(artifactIO.readOutputWithDiagnostics).not.toHaveBeenCalled();
  });
});
