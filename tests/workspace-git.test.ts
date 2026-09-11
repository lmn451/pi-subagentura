import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkspaceGitAdapter,
  WorkspaceGitError,
  parseWorkspaceAttributes,
  parseWorkspaceFilters,
  parseWorkspaceIndexFlags,
  parseWorkspaceStatus,
  shortBranchName,
} from "../src/workspace-git";
import { createRepositoryRecord } from "../src/workspace-ledger";

function rootFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "workspace-git-unit-"));
  mkdirSync(join(root, ".git"));
  return root;
}

describe("WorkspaceGitAdapter safety and parsers", () => {
  it("rejects non-allowlisted and forceful argv before invoking the runner", async () => {
    const runner = vi.fn();
    const root = rootFixture();
    try {
      const adapter = new WorkspaceGitAdapter({ runner });
      await expect(
        adapter.run(["reset", "--hard"], root),
      ).rejects.toMatchObject({ code: "forbidden_command" });
      await expect(
        adapter.run(["switch", "--force", "feature"], root),
      ).rejects.toMatchObject({ code: "forbidden_command" });
      await expect(
        adapter.run(["switch", "--create", "feature"], root),
      ).rejects.toMatchObject({ code: "forbidden_command" });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes argv-only noninteractive options with inherited GIT variables removed", async () => {
    const root = rootFixture();
    const runner = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const adapter = new WorkspaceGitAdapter({
      runner,
      hooksPath: join(root, "private-hooks"),
    });
    await adapter.run(
      [
        "rev-parse",
        "--show-toplevel",
        "--git-common-dir",
        "--git-dir",
        "--show-object-format",
        "--is-bare-repository",
        "--is-inside-work-tree",
      ],
      root,
    );
    const [, args, options] = runner.mock.calls[0];
    expect(args).toEqual([
      "rev-parse",
      "--show-toplevel",
      "--git-common-dir",
      "--git-dir",
      "--show-object-format",
      "--is-bare-repository",
      "--is-inside-work-tree",
    ]);
    expect(options.shell).toBe(false);
    expect(options.env.GIT_CONFIG_COUNT).toBe("3");
    expect(options.env.GIT_CONFIG_VALUE_0).toBe(
      realpathSync(join(root, "private-hooks")),
    );
    expect(options.env.GIT_CONFIG_VALUE_1).toBe("");
    expect(options.env.GIT_CONFIG_VALUE_2).toBe("false");
    rmSync(root, { recursive: true, force: true });
  });

  it("parses NUL-safe status, hidden index flags, filters, and path attributes", () => {
    expect(
      parseWorkspaceStatus("1 .M N... 100644 100644 100644 abc abc path.txt\0"),
    ).toMatchObject({ dirty: true, records: 1 });
    expect(parseWorkspaceStatus("! ignored.txt\0")).toMatchObject({
      ignored: true,
      records: 1,
    });
    expect(
      parseWorkspaceStatus(
        "u UU N... 100644 100644 100644 100644 abc abc abc abc conflict.txt\0",
      ),
    ).toMatchObject({ conflicted: true, dirty: true });
    expect(
      parseWorkspaceIndexFlags("H tracked.txt\0h hidden.txt\0S sparse.txt\0"),
    ).toEqual({
      paths: ["tracked.txt", "hidden.txt", "sparse.txt"],
      hidden: true,
    });
    expect(
      parseWorkspaceFilters("filter.lfs.clean\0git-lfs clean\0").configured,
    ).toBe(true);
    expect(parseWorkspaceAttributes("src/a.txt\0filter\0lfs\0").filtered).toBe(
      true,
    );
    expect(() => parseWorkspaceStatus("1 .M truncated")).toThrow(
      WorkspaceGitError,
    );
    expect(() => parseWorkspaceIndexFlags("H path")).toThrow(WorkspaceGitError);
  });

  it("validates full branch refs and rejects spaces and helper remotes", () => {
    expect(shortBranchName("refs/heads/feature/topic")).toBe("feature/topic");
    expect(() => shortBranchName("feature/topic")).toThrow();
    expect(() => shortBranchName("refs/heads/feature topic")).toThrow();
  });
});

describe("WorkspaceGitAdapter publication observations", () => {
  it("accepts only exact full-ref/full-OID remote observations", async () => {
    const root = rootFixture();
    const repository = {
      ...createRepositoryRecord({
        commonDir: join(root, ".git"),
        gitDir: join(root, ".git"),
        objectFormat: "sha1",
      }),
      root,
      bare: false as const,
    };
    const oid = "a".repeat(40);
    const runner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: `${oid}\trefs/heads/main\n`,
      stderr: "",
    });
    try {
      const adapter = new WorkspaceGitAdapter({ runner });
      const equal = await adapter.observeRemoteRef(
        "origin",
        "refs/heads/main",
        oid,
        repository,
      );
      expect(equal).toEqual({ observedOid: oid, result: "equal" });
      await expect(
        adapter.observeRemoteRef(
          "ext::unsafe",
          "refs/heads/main",
          oid,
          repository,
        ),
      ).rejects.toMatchObject({ code: "unsafe_remote" });
      expect(runner).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
