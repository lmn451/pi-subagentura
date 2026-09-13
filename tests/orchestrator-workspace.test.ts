import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OrchestratorWorkspaceGit } from "../src/orchestrator-workspace-git";
import { OrchestratorWorkspaceManager } from "../src/orchestrator-workspace-manager";
import {
  loadOrchestratorWorkspace,
  readWorkspaceOwnerMarker,
  workspaceStatePath,
  writeWorkspaceOwnerMarker,
} from "../src/orchestrator-workspace-state";
import { loadManagedWorkspaceViews } from "../src/orchestrator-workspace-view";

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function fixture(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-workspace-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workspace Test");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  return { root, head: git(root, "rev-parse", "HEAD").trim() };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("Orchestratorv2 managed Git workspaces", () => {
  it("reserves and provisions a locked linked worktree without changing main", async () => {
    const { root, head } = fixture();
    const manager = new OrchestratorWorkspaceManager();
    const reserved = await manager.reserve({
      agentId: "0123456789abcdef",
      workItemId: "task-one",
      sourceCwd: root,
      parentSessionId: "parent",
    });
    expect(reserved.assignment.lifecycle).toBe("reserved");
    const provisioned = await manager.provision(reserved);
    expect(provisioned.assignment.lifecycle).toBe("ready");
    expect(provisioned.worktree.branchRef).toBe(
      "refs/heads/orchestrator/task-one/0123456789abcdef",
    );
    expect(provisioned.worktree.locked).toBe(true);
    expect(git(root, "rev-parse", "HEAD").trim()).toBe(head);
    const marker = readWorkspaceOwnerMarker(provisioned.worktree.adminDir);
    expect(marker?.assignmentId).toBe(provisioned.assignment.assignmentId);
    expect(
      loadOrchestratorWorkspace(provisioned.repository.commonDir)?.revision,
    ).toBe(3);
  }, 60_000);

  it("rejects a duplicate concurrent assignment and retains durable state", async () => {
    const { root } = fixture();
    const first = new OrchestratorWorkspaceManager();
    const second = new OrchestratorWorkspaceManager();
    const requests = [first, second].map((manager) =>
      manager.reserve({
        agentId: "fedcba9876543210",
        workItemId: "same-task",
        sourceCwd: root,
        parentSessionId: "parent",
      }),
    );
    const results = await Promise.allSettled(requests);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const repository = await new OrchestratorWorkspaceGit().probeRepository(
      root,
    );
    const state = readFileSync(
      workspaceStatePath(repository.commonDir),
      "utf8",
    );
    expect(JSON.parse(state).assignments).toHaveLength(1);
  }, 60_000);

  it("requires the parent receipt and marker for an actionable projection", async () => {
    const { root } = fixture();
    const manager = new OrchestratorWorkspaceManager();
    const reserved = await manager.reserve({
      agentId: "aabbccddeeff0011",
      workItemId: "projection",
      sourceCwd: root,
      parentSessionId: "parent",
    });
    const provisioned = await manager.provision(reserved);
    const assigned = await manager.finalize(
      provisioned.repository,
      provisioned.assignment.assignmentId,
      provisioned.assignment.generation,
    );
    const authority = {
      type: "custom",
      customType: "orchestratorv2-workspace-authority",
      data: { repository: provisioned.repository, assignment: assigned },
    };
    const trusted = await loadManagedWorkspaceViews(root, new Map(), [
      authority,
    ]);
    expect(trusted.get(assigned.agentId)?.actionable).toBe(true);
    const untrusted = await loadManagedWorkspaceViews(root, new Map());
    expect(untrusted.get(assigned.agentId)?.reason).toBe("authority_missing");
    expect(untrusted.get(assigned.agentId)?.actionable).toBe(false);
  }, 60_000);

  it("keeps marker drift blocked and reconciliation read-only", async () => {
    const { root } = fixture();
    const manager = new OrchestratorWorkspaceManager();
    const reserved = await manager.reserve({
      agentId: "0011223344556677",
      workItemId: "drift",
      sourceCwd: root,
    });
    const provisioned = await manager.provision(reserved);
    const marker = readWorkspaceOwnerMarker(provisioned.worktree.adminDir)!;
    writeWorkspaceOwnerMarker(provisioned.worktree.adminDir, {
      ...marker,
      assignmentId: "foreign-assignment",
    });
    await expect(manager.provision(reserved)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    const before = readFileSync(
      workspaceStatePath(provisioned.repository.commonDir),
      "utf8",
    );
    await manager.reconcile(root);
    expect(
      readFileSync(
        workspaceStatePath(provisioned.repository.commonDir),
        "utf8",
      ),
    ).toBe(before);
  }, 60_000);
});
