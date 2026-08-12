import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workflowDeliveryId } from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore, workflowRunPath } from "../src/workflow-run-store";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";

const roots: string[] = [];
const owner: WorkflowOwnerIdentity = {
  projectKey: "project",
  cwd: "/repo",
  piSessionId: "session",
  ownerId: "owner",
  ownerGeneration: 1,
  leaseToken: "lease",
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function makeRun(
  root: string,
  runId: string,
): Promise<{ store: WorkflowRunStore; runDir: string; runsDir: string }> {
  const store = new WorkflowRunStore({ rootDir: root, owner });
  await store.createRun({
    runId,
    planRevision: 1,
    resumePolicy: "manual",
    owner,
  });
  const runDir = workflowRunPath(root, owner, runId);
  return { store, runDir, runsDir: dirname(runDir) };
}

async function makeDeliveredRun(root: string, runId: string) {
  const result = await makeRun(root, runId);
  const launchPath = join(result.runDir, "launch.json");
  const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
    createdAt: number;
  };
  launch.createdAt = 0;
  await writeFile(launchPath, `${JSON.stringify(launch)}\n`);
  await result.store.append(runId, "run_terminal", {
    result: { status: "done", result: "complete" },
  });
  await result.store.append(runId, "delivery_intent", {
    deliveryId: workflowDeliveryId(runId),
    kind: "terminal",
    message: `Workflow ${runId} done`,
  });
  await result.store.append(runId, "delivery_dispatched", {
    deliveryId: workflowDeliveryId(runId),
  });
  await result.store.append(runId, "delivery_receipt", {
    deliveryId: workflowDeliveryId(runId),
  });
  return result;
}

describe("durable storage revalidation and substitution matrix", () => {
  it("F05 rejects lexical project, session, and run identifiers before path construction", () => {
    for (const projectKey of [
      "../project",
      "nested/project",
      "nested\\project",
    ]) {
      expect(() =>
        workflowRunPath("/tmp/workflows", { ...owner, projectKey }, "run"),
      ).toThrow("Invalid workflow project key");
    }
    for (const piSessionId of [
      "../session",
      "nested/session",
      "nested\\session",
    ]) {
      expect(() =>
        workflowRunPath("/tmp/workflows", { ...owner, piSessionId }, "run"),
      ).toThrow("Invalid workflow session id");
    }
    for (const runId of ["../run", "nested/run", "nested\\run"]) {
      expect(() => workflowRunPath("/tmp/workflows", owner, runId)).toThrow(
        "Invalid durable workflow run ID",
      );
    }
  });

  it.each([
    ["launch.json", "symlink"],
    ["launch.json", "hardlink"],
    ["launch.json", "non-regular"],
    ["events.ndjson", "symlink"],
    ["events.ndjson", "hardlink"],
    ["events.ndjson", "non-regular"],
  ] as const)(
    "F05 rejects %s %s substitution without modifying the outside target",
    async (fileName, substitution) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-revalidation-"));
      roots.push(root);
      const runId = `substitution-${fileName === "launch.json" ? "launch" : "events"}-${substitution}`;
      const { store, runDir } = await makeRun(root, runId);
      const target = join(runDir, fileName);
      const outside = join(root, `outside-${fileName}-${substitution}`);
      const original = await readFile(target);
      if (substitution === "symlink") {
        await writeFile(outside, original);
        await rm(target);
        await symlink(outside, target);
      } else if (substitution === "hardlink") {
        await writeFile(outside, original);
        await rm(target);
        await link(outside, target);
      } else {
        await rm(target);
        await mkdir(target);
      }

      const operation =
        fileName === "launch.json"
          ? store.readRun(runId)
          : store.append(runId, "blocked", {});
      await expect(operation).rejects.toThrow(
        fileName === "launch.json" ? "corrupt" : "not regular",
      );
      if (substitution !== "non-regular")
        await expect(readFile(outside)).resolves.toEqual(original);
    },
  );

  it("F05 refuses an append after lease revalidation is lost and keeps the prior prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-revalidation-"));
    roots.push(root);
    const runId = "append-lease-loss";
    const { store, runDir } = await makeRun(root, runId);
    const eventsPath = join(runDir, "events.ndjson");
    await store.append(runId, "committed", {});
    const prefix = await readFile(eventsPath);
    const originalAssert = (store as any).assertNamespaceLease.bind(store);
    let calls = 0;
    vi.spyOn(store as any, "assertNamespaceLease").mockImplementation(
      async () => {
        calls++;
        if (calls === 3) throw new Error("lease lost before append write");
        return originalAssert();
      },
    );

    await expect(store.append(runId, "must-not-write", {})).rejects.toThrow(
      "lease lost before append write",
    );
    await expect(readFile(eventsPath)).resolves.toEqual(prefix);
  });

  it("F05 refuses prune deletion after lease revalidation is lost and keeps the tombstone", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-revalidation-"));
    roots.push(root);
    const runId = "prune-lease-loss";
    const { store, runDir, runsDir } = await makeDeliveredRun(root, runId);
    const originalAssert = (store as any).assertNamespaceLease.bind(store);
    let calls = 0;
    vi.spyOn(store as any, "assertNamespaceLease").mockImplementation(
      async () => {
        const lease = await originalAssert();
        calls++;
        if (calls === 5) throw new Error("lease lost before prune delete");
        return lease;
      },
    );

    await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).rejects.toThrow(
      "lease lost before prune delete",
    );
    const tombstone = join(runsDir, `.tombstone-${runId}`);
    await expect(
      readFile(join(tombstone, "events.ndjson"), "utf8"),
    ).resolves.toContain("run_terminal");
    await expect(readFile(join(runDir, "events.ndjson"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it.each(["symlink", "non-regular"] as const)(
    "F05 rejects a %s run-directory substitution during prune before deleting the replacement",
    async (substitution) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-revalidation-"));
      roots.push(root);
      const runId = `prune-${substitution}`;
      const { store, runDir, runsDir } = await makeDeliveredRun(root, runId);
      const outside = join(root, `outside-${substitution}`);
      if (substitution === "symlink") {
        await mkdir(outside);
        await writeFile(join(outside, "sentinel"), "keep");
      } else {
        await writeFile(outside, "keep");
      }
      const originalAssert = (store as any).assertNamespaceLease.bind(store);
      let calls = 0;
      vi.spyOn(store as any, "assertNamespaceLease").mockImplementation(
        async () => {
          const lease = await originalAssert();
          calls++;
          if (calls === 4) {
            await rename(runDir, join(root, "original-run"));
            if (substitution === "symlink") await symlink(outside, runDir);
            else await writeFile(runDir, "replacement");
          }
          return lease;
        },
      );

      await expect(store.pruneTerminalRuns({ olderThanMs: 0 })).rejects.toThrow(
        /descriptor changed|not a directory/,
      );
      const tombstone = join(runsDir, `.tombstone-${runId}`);
      if (substitution === "symlink") {
        await expect(readFile(join(outside, "sentinel"), "utf8")).resolves.toBe(
          "keep",
        );
        await expect(
          readFile(join(tombstone, "sentinel"), "utf8"),
        ).resolves.toBe("keep");
      } else {
        await expect(readFile(outside, "utf8")).resolves.toBe("keep");
        await expect(readFile(tombstone, "utf8")).resolves.toBe("replacement");
      }
    },
  );
});
