import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowNamespaceLease } from "../src/workflow-lease";

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "workflow-lease-"));
}

describe("WorkflowNamespaceLease", () => {
  it("serializes acquisition and releases only its own lease", async () => {
    const rootDir = await root();
    const first = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "one",
      leaseToken: "token-one",
    });
    const second = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "two",
      leaseToken: "token-two",
    });
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow("lease is held");
    await second.release();
    await first.assertHeld();
    await first.release();
    await expect(second.acquire()).resolves.toMatchObject({ epoch: 1 });
  });

  it("takes over a valid stale lease exactly once", async () => {
    const rootDir = await root();
    let now = 100;
    const first = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "one",
      leaseToken: "token-one",
      staleAfterMs: 10,
      now: () => now,
      processId: 2_000_000_000,
    });
    const second = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "two",
      leaseToken: "token-two",
      staleAfterMs: 10,
      now: () => now,
    });
    await first.acquire();
    now = 111;
    await expect(second.acquire()).resolves.toMatchObject({ epoch: 2 });
    await expect(first.assertHeld()).rejects.toThrow("not held");
  });

  it("stale-owner release cannot delete a replacement lease", async () => {
    const rootDir = await root();
    let now = 100;
    const first = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "one",
      leaseToken: "token-one",
      staleAfterMs: 10,
      now: () => now,
      processId: 2_000_000_000,
    });
    const replacement = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "replacement",
      leaseToken: "token-replacement",
      staleAfterMs: 10,
      now: () => now,
    });

    await first.acquire();
    now = 111;
    await expect(replacement.acquire()).resolves.toMatchObject({ epoch: 2 });
    await first.release();
    await expect(replacement.assertHeld()).resolves.toBeUndefined();
    await replacement.release();
  });

  it("recovers an abandoned interlock only when its process is dead", async () => {
    const rootDir = await root();
    const dir = join(rootDir, "project");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "namespace.interlock"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerId: "dead",
        leaseToken: "dead-token",
        lockToken: "lock",
        acquiredAt: 100,
        processId: 2_000_000_000,
      })}\n`,
    );
    let now = 111;
    const lease = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "one",
      leaseToken: "token-one",
      staleAfterMs: 10,
      now: () => now,
    });
    await expect(lease.acquire()).resolves.toMatchObject({ epoch: 1 });
    await lease.release();

    await writeFile(
      join(dir, "namespace.interlock"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerId: "live",
        leaseToken: "live-token",
        lockToken: "lock-live",
        acquiredAt: 100,
        processId: process.pid,
      })}\n`,
    );
    now = 200;
    const blocked = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "two",
      leaseToken: "token-two",
      staleAfterMs: 10,
      now: () => now,
    });
    await expect(blocked.acquire()).rejects.toThrow("interlock is held");
  });
  it("fails closed when a stale lease reuses the current PID with a different start identity", async () => {
    const rootDir = await root();
    const dir = join(rootDir, "project");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "namespace.lease"),
      `${JSON.stringify({
        schemaVersion: 1,
        ownerId: "old-owner",
        leaseToken: "old-token",
        epoch: 4,
        acquiredAt: 100,
        processId: process.pid,
        processStartTime: 0,
      })}\n`,
    );
    const lease = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "replacement",
      leaseToken: "replacement-token",
      staleAfterMs: 10,
      now: () => 111,
    });
    await expect(lease.acquire()).rejects.toThrow("process identity changed");
  });

  it("fails closed on malformed lease evidence", async () => {
    const rootDir = await root();
    const dir = join(rootDir, "project");
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true });
    await writeFile(join(dir, "namespace.lease"), "not-json\n");
    const lease = new WorkflowNamespaceLease({
      rootDir,
      namespace: "project",
      ownerId: "one",
      leaseToken: "token-one",
      now: () => 1000,
    });
    await expect(lease.acquire()).rejects.toThrow("corrupt");
  });
});
