import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleWorkflowTrustedResumeCommand,
  resolveContainedWorkflowPlanPath,
  writeContainedWorkflowPlanExport,
} from "../src/workflow-plan-commands";
import { registerWorkflowPlanMutationTool } from "../src/workflow-plan-tool";
import { createDurableWorkflowRunId } from "../src/workflow-run-types";

describe("workflow plan command containment", () => {
  it("accepts contained export paths and rejects traversal or absolute escape", () => {
    const cwd = resolve("/tmp/workflow-plan-project");
    expect(resolveContainedWorkflowPlanPath(cwd, "plans/current.json")).toBe(
      resolve(cwd, "plans/current.json"),
    );
    expect(() =>
      resolveContainedWorkflowPlanPath(cwd, "../outside.json"),
    ).toThrow(/inside the current working directory/);
    expect(() =>
      resolveContainedWorkflowPlanPath(cwd, resolve(cwd, "..", "outside.json")),
    ).toThrow(/inside the current working directory/);
  });

  it("rejects a symlink export target without modifying its victim", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-plan-export-"));
    const outside = mkdtempSync(join(tmpdir(), "workflow-plan-victim-"));
    const victim = join(outside, "victim.json");
    const target = join(root, "current.json");
    try {
      writeFileSync(victim, "do-not-touch", "utf8");
      symlinkSync(victim, target);

      await expect(
        writeContainedWorkflowPlanExport(root, "current.json", {
          safe: true,
        }),
      ).rejects.toThrow(/regular file/);
      expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a nested export parent outside cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-plan-export-"));
    const outside = mkdtempSync(join(tmpdir(), "workflow-plan-outside-"));
    try {
      symlinkSync(outside, join(root, "linked"), "dir");
      await expect(
        writeContainedWorkflowPlanExport(root, "linked/escape.json", {
          safe: true,
        }),
      ).rejects.toThrow(/direct files/);
      expect(existsSync(join(outside, "escape.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("cannot publish through a renamed descendant parent", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-plan-export-"));
    const outside = mkdtempSync(join(tmpdir(), "workflow-plan-outside-"));
    const parent = join(root, "plans");
    const displacedParent = join(outside, "displaced-plans");
    try {
      mkdirSync(parent);
      writeFileSync(join(parent, "sentinel.json"), "sentinel", "utf8");
      renameSync(parent, displacedParent);
      symlinkSync(outside, parent, "dir");

      await expect(
        writeContainedWorkflowPlanExport(root, "plans/current.json", {
          safe: true,
        }),
      ).rejects.toThrow(/direct files/);
      expect(existsSync(join(outside, "current.json"))).toBe(false);
      expect(readFileSync(join(displacedParent, "sentinel.json"), "utf8")).toBe(
        "sentinel",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("atomically replaces a valid export with usable JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "workflow-plan-export-"));
    const target = join(root, "current.json");
    try {
      writeFileSync(target, "stale", "utf8");
      const document = { safe: true, revision: 7 };

      await expect(
        writeContainedWorkflowPlanExport(root, "current.json", document),
      ).resolves.toBe(target);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(document);
      expect(readdirSync(root)).toEqual(["current.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("workflow plan trusted resume command", () => {
  it("requires the selected epoch and forwards the exact owner and epoch fence", async () => {
    const runId = createDurableWorkflowRunId("resume-command");
    const owner = { projectKey: "project", piSessionKey: "session" };
    const completion = Promise.resolve();
    const authority = {
      getProjection: vi.fn().mockResolvedValue({ owner, runEpoch: 6 }),
      trustedResume: vi.fn().mockResolvedValue({ runId, completion }),
    };

    await expect(
      handleWorkflowTrustedResumeCommand(runId, authority),
    ).rejects.toThrow("Usage: /workflow-plan resume <workflow-id> <run-epoch>");
    expect(authority.getProjection).not.toHaveBeenCalled();

    await expect(
      handleWorkflowTrustedResumeCommand(`${runId} 5`, authority),
    ).rejects.toMatchObject({ code: "epoch_mismatch" });
    expect(authority.trustedResume).not.toHaveBeenCalled();

    await expect(
      handleWorkflowTrustedResumeCommand(`${runId} 6`, authority),
    ).resolves.toEqual({ workflowId: runId, runEpoch: 6, completion });
    expect(authority.trustedResume).toHaveBeenCalledTimes(1);
    expect(authority.trustedResume).toHaveBeenCalledWith(runId, {
      trustedActorId: "workflow-plan-command",
      expectedOwner: owner,
      expectedRunEpoch: 6,
    });
  });
});

describe("workflow plan model trust boundary", () => {
  it("registers only one-operation future-work actions and no settlement or approval powers", () => {
    const registered: unknown[] = [];
    const pi = {
      registerTool: vi.fn((tool: unknown) => registered.push(tool)),
    };
    registerWorkflowPlanMutationTool(pi as never, undefined);
    const tool = registered[0] as {
      name: string;
      parameters: unknown;
    };
    const schema = JSON.stringify(tool.parameters);

    expect(tool.name).toBe("workflow_plan");
    expect(schema).toContain('"view"');
    expect(schema).toContain('"append"');
    expect(schema).toContain('"block"');
    expect(schema).toContain('"unblock"');
    expect(schema).toContain('"skip"');
    expect(schema).not.toContain("replace_future");
    expect(schema).not.toContain('"resume"');
    expect(schema).not.toMatch(
      /start|succeed|fail|attempt|output|usage|approv/,
    );
  });
});
