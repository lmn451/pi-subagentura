import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceGitAdapter } from "../src/workspace-git";
import { WorkspaceManager } from "../src/workspace-manager";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import {
  loadWorkspaceLedger,
  readWorkspaceLedger,
} from "../src/workspace-ledger";
import {
  reportWorkspaceProposal,
  writeWorkspaceAssignmentMarker,
  type WorkspaceProposal,
} from "../src/workspace-reports";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "workspace-manager-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Workspace Test"]);
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "initial"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]).trim() };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  interactiveSubagentRegistry.clear();
});

describe("WorkspaceManager assignment and advisory boundaries", () => {
  it("requires explicit closeChild for an idle managed child and preserves epochs", async () => {
    const fixtureData = fixture();
    const artifactDir = mkdtempSync(
      join(tmpdir(), "workspace-child-artifact-"),
    );
    roots.push(artifactDir);
    let child: any;
    const manager = new WorkspaceManager({
      git: new WorkspaceGitAdapter(),
      processInstanceId: "manager-process",
      parentSessionId: "manager-session",
      launchChild: async (params) => {
        writeWorkspaceAssignmentMarker(artifactDir, params.workspaceAssignment);
        child = {
          id: params.preallocatedId,
          status: "idle",
          workingCwd: params.cwd,
          artifactDir,
          workspaceRepoId: params.workspaceAssignment.repoId,
          workspaceSlotId: params.workspaceAssignment.slotId,
          workspaceAssignmentId: params.workspaceAssignment.assignmentId,
          workspaceAssignmentEpoch: params.workspaceAssignment.assignmentEpoch,
          workspaceBranchRef: params.workspaceAssignment.branchRef,
          paneAlive: true,
        };
        return child;
      },
      getChild: () => child,
      closeChild: async (runtime) => {
        runtime.status = "exited";
        runtime.paneAlive = false;
        return { closed: true, paneAlive: false };
      },
    });
    const registered = await manager.registerSlot(
      { slotId: "main", root: fixtureData.root },
      fixtureData.root,
    );
    const assigned = await manager.assign(
      {
        slotId: "main",
        workItemId: "managed-work",
        branchRef: "refs/heads/master",
        expectedRevision: registered.slot.revision + 1,
        expectedEpoch: 0,
        childMode: "new",
        task: "managed task",
      },
      fixtureData.root,
    );

    await expect(
      manager.release(
        {
          slotId: "main",
          assignmentId: assigned.assignment.assignmentId,
          expectedRevision: 3,
          expectedEpoch: 1,
        },
        fixtureData.root,
      ),
    ).rejects.toMatchObject({ code: "child_idle" });
    const released = await manager.release(
      {
        slotId: "main",
        assignmentId: assigned.assignment.assignmentId,
        expectedRevision: 3,
        expectedEpoch: 1,
        childId: assigned.child!.id,
        closeChild: true,
      },
      fixtureData.root,
    );
    expect(released.childClosed).toBe(true);
    expect(released.slot.state).toBe("available");
    expect(released.assignment.state).toBe("retired");
    expect(
      loadWorkspaceLedger(assigned.repository.commonDir)?.ledgerRevision,
    ).toBe(4);
  }, 60_000);

  it("records duplicate and invalid-hash proposals without granting child authority", async () => {
    const fixtureData = fixture();
    let child: any;
    const artifactDir = mkdtempSync(
      join(tmpdir(), "workspace-proposal-artifact-"),
    );
    roots.push(artifactDir);
    const manager = new WorkspaceManager({
      git: new WorkspaceGitAdapter(),
      processInstanceId: "proposal-process",
      parentSessionId: "proposal-session",
      launchChild: async (params) => {
        writeWorkspaceAssignmentMarker(artifactDir, params.workspaceAssignment);
        child = {
          id: params.preallocatedId,
          status: "idle",
          workingCwd: params.cwd,
          artifactDir,
          workspaceRepoId: params.workspaceAssignment.repoId,
          workspaceSlotId: params.workspaceAssignment.slotId,
          workspaceAssignmentId: params.workspaceAssignment.assignmentId,
          workspaceAssignmentEpoch: params.workspaceAssignment.assignmentEpoch,
          workspaceBranchRef: params.workspaceAssignment.branchRef,
        };
        return child;
      },
      getChild: () => child,
    });
    const registered = await manager.registerSlot(
      { slotId: "main", root: fixtureData.root },
      fixtureData.root,
    );
    const assigned = await manager.assign(
      {
        slotId: "main",
        workItemId: "proposal-work",
        branchRef: "refs/heads/master",
        expectedRevision: 1,
        expectedEpoch: 0,
        childMode: "new",
      },
      fixtureData.root,
    );
    const proposal: WorkspaceProposal = reportWorkspaceProposal(
      child.artifactDir,
      {
        proposalId: "proposal-1",
        turnId: "turn-1",
        kind: "status",
        facts: { clean: true },
        reportedAt: 1,
      },
    );
    const accepted = (await manager.reconcileProposals(fixtureData.root))[0];
    expect(accepted?.result).toBe("accepted");
    expect(
      (
        await manager.acceptProposal(
          proposal,
          child.artifactDir,
          fixtureData.root,
        )
      ).result,
    ).toBe("duplicate");
    expect(
      (
        await manager.acceptProposal(
          { ...proposal, facts: { clean: false } },
          child.artifactDir,
          fixtureData.root,
        )
      ).result,
    ).toBe("invalid");
    const stale = await manager.acceptProposal(
      {
        ...proposal,
        proposalId: "proposal-stale",
        assignmentEpoch: assigned.assignment.epoch + 1,
      },
      child.artifactDir,
      fixtureData.root,
    );
    expect(stale.result).toBe("stale");
    const ledger = readWorkspaceLedger(assigned.repository.commonDir);
    expect(ledger.kind).toBe("valid");
    expect(
      ledger.kind === "valid"
        ? ledger.ledger.proposalReceipts.map((receipt) => receipt.result)
        : [],
    ).toEqual(["accepted", "invalid", "stale"]);
  }, 60_000);
  it("blocks legacy and uncertain occupants even when Git is clean", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-occupancy-"));
    roots.push(root);
    const slot = {
      slotId: "main",
      kind: "main" as const,
      adminKey: "main",
      root,
      gitDir: root,
      state: "available" as const,
      revision: 0,
      assignmentEpoch: 0,
    };
    interactiveSubagentRegistry.set("0123456789abcdef", {
      id: "0123456789abcdef",
      status: "running",
      workingCwd: root,
    } as any);
    expect(new WorkspaceManager().scanOccupancy(slot, undefined)).toBe(
      "foreign",
    );
    interactiveSubagentRegistry.clear();
    interactiveSubagentRegistry.set("0123456789abcdef", {
      id: "0123456789abcdef",
      status: "unknown",
      workingCwd: root,
    } as any);
    expect(new WorkspaceManager().scanOccupancy(slot, undefined)).toBe(
      "unknown",
    );
  });
});
