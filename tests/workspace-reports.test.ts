import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_WORKSPACE_PROPOSAL_BYTES,
  WORKSPACE_ASSIGNMENT_MARKER,
  readWorkspaceAssignmentMarker,
  readWorkspaceProposals,
  reportWorkspaceProposal,
  validateWorkspaceAssignmentMarker,
  writeWorkspaceAssignmentMarker,
} from "../src/workspace-reports";

const roots: string[] = [];

function marker() {
  return {
    schemaVersion: 1 as const,
    repoId: "a".repeat(64),
    slotId: "linked:slot",
    assignmentId: "assignment-1",
    assignmentEpoch: 2,
    childId: "0123456789abcdef",
    root: "/tmp/worktree",
    branchRef: "refs/heads/feature/workspace",
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace assignment markers and child proposals", () => {
  it("writes private canonical markers and records bounded reports", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "workspace-reports-"));
    roots.push(artifactDir);
    writeWorkspaceAssignmentMarker(artifactDir, marker());
    expect(readWorkspaceAssignmentMarker(artifactDir)).toEqual(marker());
    const raw = readFileSync(
      join(artifactDir, WORKSPACE_ASSIGNMENT_MARKER),
      "utf8",
    );
    expect(raw.indexOf('"assignmentEpoch"')).toBeLessThan(
      raw.indexOf('"repoId"'),
    );
    const proposal = reportWorkspaceProposal(artifactDir, {
      proposalId: "proposal-1",
      turnId: "turn-1",
      kind: "observation",
      facts: { clean: true, nested: { note: "advisory" } },
      reportedAt: 123,
    });
    expect(proposal.childId).toBe(marker().childId);
    expect(readWorkspaceProposals(artifactDir)).toMatchObject({
      proposals: [proposal],
      issues: [],
    });
  });

  it("fails closed for wrong marker mode, malformed JSON, and oversized facts", () => {
    const artifactDir = mkdtempSync(
      join(tmpdir(), "workspace-reports-invalid-"),
    );
    roots.push(artifactDir);
    writeWorkspaceAssignmentMarker(artifactDir, marker());
    const markerPath = join(artifactDir, WORKSPACE_ASSIGNMENT_MARKER);
    chmodSync(markerPath, 0o644);
    expect(() => readWorkspaceAssignmentMarker(artifactDir)).toThrowError(
      expect.objectContaining({ code: "wrong_mode" }),
    );
    chmodSync(markerPath, 0o600);
    writeFileSync(markerPath, "{", { mode: 0o600 });
    expect(() => readWorkspaceAssignmentMarker(artifactDir)).toThrowError(
      expect.objectContaining({ code: "malformed" }),
    );
    rmSync(markerPath);
    writeWorkspaceAssignmentMarker(artifactDir, marker());
    expect(() =>
      reportWorkspaceProposal(artifactDir, {
        proposalId: "too-large",
        turnId: "turn-1",
        kind: "status",
        facts: { text: "x".repeat(MAX_WORKSPACE_PROPOSAL_BYTES) },
      }),
    ).toThrow();
  });

  it("rejects a proposal whose turn is no longer active", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "workspace-reports-turn-"));
    roots.push(artifactDir);
    writeWorkspaceAssignmentMarker(artifactDir, marker());
    writeFileSync(
      join(artifactDir, "active-turn.json"),
      JSON.stringify({ turnId: "turn-2" }),
      { mode: 0o600 },
    );
    expect(() =>
      reportWorkspaceProposal(artifactDir, {
        proposalId: "stale-turn",
        turnId: "turn-1",
        kind: "status",
        facts: { clean: true },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects marker identity drift instead of allowing a child to redefine itself", () => {
    expect(() =>
      validateWorkspaceAssignmentMarker({
        ...marker(),
        childId: "not-a-child-id",
      }),
    ).toThrow();
    expect(() =>
      validateWorkspaceAssignmentMarker({
        ...marker(),
        branchRef: "feature/workspace",
      }),
    ).toThrow();
    expect(() =>
      validateWorkspaceAssignmentMarker({
        ...marker(),
        unknown: true,
      }),
    ).toThrow();
  });
});
