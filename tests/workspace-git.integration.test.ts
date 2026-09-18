import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceGitAdapter } from "../src/workspace-git";
import { WorkspaceManager } from "../src/workspace-manager";
import { loadWorkspaceLedger } from "../src/workspace-ledger";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repositoryFixture(): { root: string; linked: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "workspace-git-integration-"));
  roots.push(root);
  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main);
  git(main, ["init", "-q"]);
  git(main, ["config", "user.email", "test@example.invalid"]);
  git(main, ["config", "user.name", "Workspace Test"]);
  writeFileSync(join(main, "tracked.txt"), "initial\n");
  git(main, ["add", "tracked.txt"]);
  git(main, ["commit", "-qm", "initial"]);
  const head = git(main, ["rev-parse", "HEAD"]).trim();
  git(main, ["worktree", "add", "-q", "-b", "slot-base", linked]);
  return { root: realpathSync(main), linked: realpathSync(linked), head };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceGitAdapter temporary repository probes", () => {
  it("canonicalizes linked worktree identity and reports a clean slot", async () => {
    const fixture = repositoryFixture();
    const adapter = new WorkspaceGitAdapter();
    const repository = await adapter.probeRepository(fixture.linked);
    const worktrees = await adapter.listWorktrees(repository);
    const linked = worktrees.find((item) => item.root === fixture.linked);

    expect(repository.objectFormat).toBe("sha1");
    expect(repository.repoId).toMatch(/^[a-f0-9]{64}$/);
    expect(linked).toMatchObject({
      kind: "linked",
      adminKey: "linked",
      branchRef: "refs/heads/slot-base",
      checkout: "branch",
    });
    expect(linked?.headOid).toBe(fixture.head);
    expect(await adapter.probeWorktree(repository, linked!)).toMatchObject({
      root: fixture.linked,
      branchRef: "refs/heads/slot-base",
      headOid: fixture.head,
      checkout: "branch",
      status: "clean",
      admin: "normal",
    });
  }, 60_000);

  it("identifies an unborn checkout instead of treating it as a branch slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-git-unborn-"));
    roots.push(root);
    git(root, ["init", "-q"]);
    const adapter = new WorkspaceGitAdapter();
    const repository = await adapter.probeRepository(root);
    const record = (await adapter.listWorktrees(repository)).find(
      (item) => item.root === realpathSync(root),
    );
    expect(record).toMatchObject({ checkout: "unborn" });
    expect(record?.headOid).toBeUndefined();
  }, 60_000);

  it("reuses one linked slot for a new branch without creating another worktree", async () => {
    const fixture = repositoryFixture();
    const adapter = new WorkspaceGitAdapter();
    const manager = new WorkspaceManager({
      git: adapter,
      processInstanceId: "integration-process",
      parentSessionId: "integration-session",
    });
    const registered = await manager.registerSlot(
      { slotId: "linked:linked", root: fixture.linked },
      fixture.root,
    );
    const assigned = await manager.assign(
      {
        slotId: registered.slot.slotId,
        workItemId: "first-work",
        branchRef: "refs/heads/feature/one",
        action: "create_branch",
        baseOid: fixture.head,
        expectedRevision: 1,
        expectedEpoch: 0,
      },
      fixture.root,
    );
    const released = await manager.release(
      {
        slotId: registered.slot.slotId,
        assignmentId: assigned.assignment.assignmentId,
        expectedRevision: 4,
        expectedEpoch: 1,
      },
      fixture.root,
    );
    const reassigned = await manager.assign(
      {
        slotId: registered.slot.slotId,
        workItemId: "second-work",
        branchRef: "refs/heads/feature/two",
        action: "create_branch",
        baseOid: fixture.head,
        expectedRevision: 5,
        expectedEpoch: 1,
      },
      fixture.root,
    );

    expect(assigned.operation?.classification).toBe("after");
    expect(released.slot.root).toBe(fixture.linked);
    expect(reassigned.slot.root).toBe(fixture.linked);
    expect(reassigned.assignment.epoch).toBe(2);
    expect(git(fixture.linked, ["branch", "--show-current"]).trim()).toBe(
      "feature/two",
    );
    expect(
      git(fixture.root, ["worktree", "list", "--porcelain"]).match(
        /^worktree /gm,
      ),
    ).toHaveLength(2);
    const ledger = loadWorkspaceLedger(reassigned.repository.commonDir)!;
    expect(ledger.workItems.map((item) => item.workItemId)).toEqual([
      "first-work",
      "second-work",
    ]);
    expect(
      ledger.assignments.filter((item) => item.state === "retired"),
    ).toHaveLength(1);
  }, 60_000);

  it("classifies moved and prunable worktrees as non-reusable", async () => {
    const fixture = repositoryFixture();
    const adapter = new WorkspaceGitAdapter();
    const repository = await adapter.probeRepository(fixture.root);
    const manager = new WorkspaceManager({
      git: adapter,
      processInstanceId: "moved-process",
      parentSessionId: "moved-session",
    });
    await manager.registerSlot(
      { slotId: "linked:linked", root: fixture.linked },
      fixture.root,
    );
    const moved = join(fixture.root, "moved");
    git(fixture.root, ["worktree", "move", fixture.linked, moved]);
    const movedDiscovery = await manager.discover(fixture.root);
    const movedView = movedDiscovery.slots.find(
      (view) => view.slot.slotId === "linked:linked",
    );
    expect(movedView?.blockers).toContain("root_changed");
    expect(movedView?.reusable).toBe(false);
    rmSync(moved, { recursive: true, force: true });
    const records = await adapter.listWorktrees(repository);
    const prunable = records.find((item) => item.prunable);
    expect(prunable?.prunable).toBe(true);
    await expect(
      adapter.observeWorktree(repository, prunable!),
    ).resolves.toMatchObject({
      status: "unknown",
      admin: "prunable",
    });
  }, 60_000);

  it("reports a real merge conflict as conflicted occupancy", async () => {
    const fixture = repositoryFixture();
    const adapter = new WorkspaceGitAdapter();
    const repository = await adapter.probeRepository(fixture.root);
    const record = (await adapter.listWorktrees(repository)).find(
      (item) => item.root === fixture.linked,
    )!;
    writeFileSync(join(fixture.root, "tracked.txt"), "main-change\n");
    git(fixture.root, ["add", "tracked.txt"]);
    git(fixture.root, ["commit", "-qm", "main change"]);
    writeFileSync(join(fixture.linked, "tracked.txt"), "linked-change\n");
    git(fixture.linked, ["add", "tracked.txt"]);
    git(fixture.linked, ["commit", "-qm", "linked change"]);
    expect(() => git(fixture.linked, ["merge", "master"])).toThrow();
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "conflicted",
    );
  }, 60_000);

  it("blocks dirty, ignored, hidden-index, filter, and hook-sensitive slots", async () => {
    const fixture = repositoryFixture();
    const adapter = new WorkspaceGitAdapter();
    const repository = await adapter.probeRepository(fixture.linked);
    const worktrees = await adapter.listWorktrees(repository);
    const record = worktrees.find((item) => item.root === fixture.linked)!;

    writeFileSync(join(fixture.linked, "dirty.txt"), "dirty\n");
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "dirty",
    );
    rmSync(join(fixture.linked, "dirty.txt"));

    git(fixture.linked, ["config", "core.excludesfile", "/dev/null"]);
    writeFileSync(join(fixture.linked, ".ignored"), "ignored\n");
    writeFileSync(join(fixture.linked, ".gitignore"), ".ignored\n");
    git(fixture.linked, ["add", ".gitignore"]);
    git(fixture.linked, ["commit", "-qm", "ignore"]);
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "ignored",
    );
    rmSync(join(fixture.linked, ".ignored"));

    git(fixture.linked, ["config", "filter.test.clean", "cat"]);
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "dirty",
    );
    git(fixture.linked, ["config", "--unset", "filter.test.clean"]);
    writeFileSync(
      join(fixture.linked, ".gitattributes"),
      "tracked.txt filter=test\n",
    );
    git(fixture.linked, ["add", ".gitattributes"]);
    git(fixture.linked, ["commit", "-qm", "filter"]);
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "dirty",
    );

    writeFileSync(join(record.gitDir, "index.lock"), "lock\n");
    expect((await adapter.probeWorktree(repository, record)).admin).toBe(
      "locked",
    );
    rmSync(join(record.gitDir, "index.lock"));

    git(fixture.linked, ["update-index", "--assume-unchanged", "tracked.txt"]);
    expect((await adapter.probeWorktree(repository, record)).status).toBe(
      "dirty",
    );
  }, 60_000);
});
