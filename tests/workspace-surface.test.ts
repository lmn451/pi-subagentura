import { afterEach, describe, expect, it, vi } from "vitest";
import Schema from "typebox/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWorkspaceTools } from "../src/tools/workspace";
import {
  readWorkspaceAssignmentMarker,
  writeWorkspaceAssignmentMarker,
} from "../src/workspace-reports";
import {
  registerSessionScope,
  clearSessionScopes,
  type SessionScope,
} from "../src/session-scope";
import { WorkspaceAssignParams } from "../src/schemas";

function scope(pi: any): SessionScope {
  return registerSessionScope({
    id: 1,
    generation: 0,
    lifecycle: "started",
    pi,
    sessionManager: { getSessionId: () => "parent" },
  });
}

afterEach(() => clearSessionScopes());

describe("workspace tool registration boundaries", () => {
  it("gives a parent the manager tools and no child report", () => {
    const api = { registerTool: vi.fn() };
    registerWorkspaceTools(api as any, scope(api));
    const names = api.registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "workspace_discover",
        "workspace_reconcile",
        "workspace_register_slot",
        "workspace_release",
        "workspace_assign",
        "workspace_adopt",
        "workspace_recover",
        "workspace_observe_publication",
        "workspace_record_pr",
        "workspace_observe_pr",
      ]),
    );
    expect(names).not.toContain("workspace_report");
  });

  it("gives a child only the bounded advisory report tool", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "workspace-surface-"));
    const api = { registerTool: vi.fn() };
    const childScope = scope(api);
    writeWorkspaceAssignmentMarker(artifactDir, {
      schemaVersion: 1,
      repoId: "a".repeat(64),
      slotId: "linked:slot",
      assignmentId: "assignment",
      assignmentEpoch: 1,
      childId: "0123456789abcdef",
      root: "/tmp/worktree",
      branchRef: "refs/heads/workspace",
    });
    const previous = process.env.ARTIFACT_DIR;
    process.env.ARTIFACT_DIR = artifactDir;
    try {
      registerWorkspaceTools(api as any, childScope, true);
      const names = api.registerTool.mock.calls.map(([tool]) => tool.name);
      expect(names).toEqual(["workspace_report"]);
      const report = api.registerTool.mock.calls[0][0];
      const result = await report.execute("report", {
        proposalId: "proposal",
        turnId: "turn",
        kind: "status",
        facts: { clean: true },
      });
      expect(result.details.status).toBe("reported");
      expect(readWorkspaceAssignmentMarker(artifactDir)?.childId).toBe(
        "0123456789abcdef",
      );
    } finally {
      if (previous === undefined) delete process.env.ARTIFACT_DIR;
      else process.env.ARTIFACT_DIR = previous;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
  it("keeps assignment inputs bounded and closed", () => {
    const compiled = Schema.Compile(WorkspaceAssignParams);
    expect(
      compiled.Check({
        slotId: "main",
        workItemId: "work",
        branchRef: "refs/heads/feature/work",
        expectedRevision: 1,
        expectedEpoch: 0,
      }),
    ).toBe(true);
    expect(
      compiled.Check({
        slotId: "main",
        workItemId: "work",
        branchRef: "feature/work",
        expectedRevision: 1,
        expectedEpoch: 0,
      }),
    ).toBe(false);
    expect(
      compiled.Check({
        slotId: "main",
        workItemId: "work",
        branchRef: "refs/heads/feature/work",
        expectedRevision: 1,
        expectedEpoch: 0,
        extra: true,
      }),
    ).toBe(false);
  });
});
