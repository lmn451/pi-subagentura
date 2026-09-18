import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceGitAdapter, WorkspaceGitError } from "../src/workspace-git";
import { WorkspaceManager } from "../src/workspace-manager";
import { loadWorkspaceLedger } from "../src/workspace-ledger";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixture(): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "workspace-recovery-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Workspace Test"]);
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "initial"]);
  return { root, head: git(root, ["rev-parse", "HEAD"]).trim() };
}

function manager(adapter: WorkspaceGitAdapter) {
  return new WorkspaceManager({
    git: adapter,
    processInstanceId: "recovery-process",
    parentSessionId: "recovery-session",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace operation recovery", () => {
  it("classifies a timeout after the Git mutation from exact after-state and never retries", async () => {
    const fixtureData = fixture();
    const adapter = new WorkspaceGitAdapter();
    const workspace = manager(adapter);
    const registered = await workspace.registerSlot(
      { slotId: "main", root: fixtureData.root },
      fixtureData.root,
    );
    const operationId = "operation-after";
    const mutate = vi
      .spyOn(adapter, "createBranch")
      .mockImplementation(async (branchRef, baseOid, repository) => {
        git(repository.root, [
          "switch",
          "--create",
          branchRef.slice("refs/heads/".length),
          baseOid,
        ]);
        throw new WorkspaceGitError("timeout", "lost response");
      });
    const result = await workspace.assign(
      {
        slotId: "main",
        workItemId: "after-work",
        branchRef: "refs/heads/recovered/after",
        action: "create_branch",
        baseOid: fixtureData.head,
        operationId,
        expectedRevision: 1,
        expectedEpoch: 0,
      },
      fixtureData.root,
    );

    expect(result.operation).toMatchObject({
      classification: "after",
      command: "timeout",
    });
    expect(mutate).toHaveBeenCalledOnce();
    const retry = await workspace.assign(
      {
        slotId: "main",
        workItemId: "after-work",
        branchRef: "refs/heads/recovered/after",
        action: "create_branch",
        baseOid: fixtureData.head,
        operationId,
        expectedRevision: 1,
        expectedEpoch: 0,
      },
      fixtureData.root,
    );
    expect(retry.operation?.classification).toBe("after");
    expect(mutate).toHaveBeenCalledOnce();
  }, 60_000);

  it("persists before and mismatch classifications without automatic replay", async () => {
    const beforeFixture = fixture();
    const beforeAdapter = new WorkspaceGitAdapter();
    const beforeManager = manager(beforeAdapter);
    await beforeManager.registerSlot(
      { slotId: "main", root: beforeFixture.root },
      beforeFixture.root,
    );
    const beforeMutate = vi
      .spyOn(beforeAdapter, "createBranch")
      .mockRejectedValue(new WorkspaceGitError("timeout", "no mutation"));
    await expect(
      beforeManager.assign(
        {
          slotId: "main",
          workItemId: "before-work",
          branchRef: "refs/heads/recovered/before",
          action: "create_branch",
          baseOid: beforeFixture.head,
          operationId: "operation-before",
          expectedRevision: 1,
          expectedEpoch: 0,
        },
        beforeFixture.root,
      ),
    ).rejects.toMatchObject({ code: "operation_pending" });
    expect(beforeMutate).toHaveBeenCalledOnce();
    const beforeLedger = loadWorkspaceLedger(join(beforeFixture.root, ".git"))!;
    expect(beforeLedger.outcomes[0]?.classification).toBe("before");
    const abandoned = await beforeManager.recover(
      "operation-before",
      beforeLedger.ledgerRevision,
      "abandon-before-state",
      beforeFixture.root,
    );
    expect(abandoned.decision).toMatchObject({
      classification: "before",
      slotState: "available",
      assignmentState: "retired",
      replayed: false,
    });
    expect(beforeMutate).toHaveBeenCalledOnce();

    const mismatchFixture = fixture();
    const mismatchAdapter = new WorkspaceGitAdapter();
    const mismatchManager = manager(mismatchAdapter);
    await mismatchManager.registerSlot(
      { slotId: "main", root: mismatchFixture.root },
      mismatchFixture.root,
    );
    vi.spyOn(mismatchAdapter, "createBranch").mockImplementation(
      async (_branchRef, baseOid, repository) => {
        git(repository.root, ["switch", "--create", "unexpected", baseOid]);
        throw new WorkspaceGitError("cancelled", "cancelled after mutation");
      },
    );
    await expect(
      mismatchManager.assign(
        {
          slotId: "main",
          workItemId: "mismatch-work",
          branchRef: "refs/heads/recovered/mismatch",
          action: "create_branch",
          baseOid: mismatchFixture.head,
          operationId: "operation-mismatch",
          expectedRevision: 1,
          expectedEpoch: 0,
        },
        mismatchFixture.root,
      ),
    ).rejects.toMatchObject({ code: "unsafe_state" });
    const mismatchLedger = loadWorkspaceLedger(
      join(mismatchFixture.root, ".git"),
    )!;
    expect(mismatchLedger.outcomes[0]?.classification).toBe("mismatch");
    expect(mismatchLedger.slots[0]?.state).toBe("blocked");
  }, 60_000);
});
