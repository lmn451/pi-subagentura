import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDurableWorkflowController,
  createWorkflowOwnerIdentity,
  createWorkflowRunStore,
  durableWorkflowControllerForSession,
  durableWorkflowDispatcherForSession,
  durableWorkflowStoreForSession,
  runDurableWorkflowForSession,
  workflowOwnerFromSessionContext,
} from "../src/workflow-owner";
import {
  releaseDurableWorkflowAuthority,
  setDurableWorkflowOwner,
} from "../src/session-scope";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workflow owner identity", () => {
  it("constructs the complete durable fence", () => {
    expect(
      createWorkflowOwnerIdentity({
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 2,
        leaseToken: "lease",
      }),
    ).toMatchObject({ projectKey: "project", ownerGeneration: 2 });
  });

  it("rejects incomplete or unsafe identity fields", () => {
    expect(() =>
      createWorkflowOwnerIdentity({
        projectKey: "",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 0,
        leaseToken: "lease",
      }),
    ).toThrow("projectKey");
    expect(() =>
      createWorkflowOwnerIdentity({
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: -1,
        leaseToken: "lease",
      }),
    ).toThrow("generation");
  });

  it("binds a run store to the validated owner", () => {
    const store = createWorkflowRunStore("/tmp/workflows", {
      projectKey: "project",
      cwd: "/repo",
      piSessionId: "session",
      ownerId: "owner",
      ownerGeneration: 0,
      leaseToken: "lease",
    });
    expect(store).toBeDefined();
  });

  it("maps lifecycle naming to the durable owner contract", () => {
    expect(
      workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session",
        ownerId: "owner",
        generation: 3,
        leaseToken: "lease",
      }),
    ).toMatchObject({ piSessionId: "session", ownerGeneration: 3 });
  });

  it("constructs an owner-scoped durable controller", () => {
    expect(
      createDurableWorkflowController("/tmp/workflows", {
        projectKey: "project",
        cwd: "/repo",
        piSessionId: "session",
        ownerId: "owner",
        ownerGeneration: 0,
        leaseToken: "lease",
      }),
    ).toBeDefined();
  });

  it("does not create a controller before a session has an owner", () => {
    expect(
      durableWorkflowControllerForSession("/tmp/workflows", {
        durableWorkflowOwner: undefined,
      } as any),
    ).toBeUndefined();
  });

  it("does not create a store before a session has an owner", () => {
    expect(
      durableWorkflowStoreForSession("/tmp/workflows", {
        durableWorkflowOwner: undefined,
      } as any),
    ).toBeUndefined();
  });

  it("rejects execution before a session has an owner", () => {
    expect(() =>
      runDurableWorkflowForSession(
        "/tmp/workflows",
        {
          durableWorkflowOwner: undefined,
        } as any,
        {} as any,
      ),
    ).toThrow("unavailable");
  });

  it("reuses the session-scoped durable dispatcher", () => {
    const sessionScope = {
      durableWorkflowOwner: workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session-dispatcher",
        ownerId: "owner",
        generation: 1,
        leaseToken: "lease",
      }),
    };

    const first = durableWorkflowDispatcherForSession(sessionScope as any, 2);
    const second = durableWorkflowDispatcherForSession(sessionScope as any, 8);

    expect(second).toBe(first);
    expect(second.snapshot()).toEqual({ active: 0, queued: 0, max: 2 });
  });

  it("reuses cached durable run store and controller within one session scope", () => {
    const sessionScope = {
      durableWorkflowOwner: workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session",
        ownerId: "owner",
        generation: 1,
        leaseToken: "lease",
      }),
    };

    const storeA = durableWorkflowStoreForSession(
      "/tmp/workflows",
      sessionScope as any,
    );
    const storeB = durableWorkflowStoreForSession(
      "/tmp/workflows",
      sessionScope as any,
    );
    const controllerA = durableWorkflowControllerForSession(
      "/tmp/workflows",
      sessionScope as any,
    );
    const controllerB = durableWorkflowControllerForSession(
      "/tmp/workflows",
      sessionScope as any,
    );

    expect(storeA).toBe(storeB);
    expect(controllerA).toBe(controllerB);
  });

  it("resets cached durable authority if owner changes", () => {
    const scope = {
      durableWorkflowOwner: workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session",
        ownerId: "owner",
        generation: 1,
        leaseToken: "lease",
      }),
    };
    const storeBefore = durableWorkflowStoreForSession(
      "/tmp/workflows",
      scope as any,
    );
    expect(storeBefore).toBeDefined();

    setDurableWorkflowOwner(scope as any, {
      ...workflowOwnerFromSessionContext({
        projectKey: "project",
        cwd: "/repo",
        sessionId: "session",
        ownerId: "owner",
        generation: 2,
        leaseToken: "lease",
      }),
    });

    const storeAfter = durableWorkflowStoreForSession(
      "/tmp/workflows",
      scope as any,
    );
    expect(storeAfter).toBeDefined();
    expect(storeAfter).not.toBe(storeBefore);
  });

  it("releases a held namespace lease before allowing an owner-token migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-owner-release-"));
    roots.push(root);
    const initialOwner = workflowOwnerFromSessionContext({
      projectKey: "project",
      cwd: "/repo",
      sessionId: "session",
      ownerId: "owner",
      generation: 1,
      leaseToken: "lease-one",
    });
    const migratedOwner = workflowOwnerFromSessionContext({
      projectKey: "project",
      cwd: "/repo",
      sessionId: "session",
      ownerId: "owner",
      generation: 2,
      leaseToken: "lease-two",
    });

    const scope = { durableWorkflowOwner: initialOwner } as any;
    const activeStore = durableWorkflowStoreForSession(root, scope);
    expect(activeStore).toBeDefined();
    await activeStore!.createRun({
      runId: "run-owned",
      planRevision: 1,
      resumePolicy: "manual",
      owner: initialOwner,
    });

    const migratingScope = { durableWorkflowOwner: migratedOwner } as any;
    const pendingStore = durableWorkflowStoreForSession(root, migratingScope);
    expect(pendingStore).toBeDefined();
    await expect(
      pendingStore!.createRun({
        runId: "run-blocked",
        planRevision: 1,
        resumePolicy: "manual",
        owner: migratedOwner,
      }),
    ).rejects.toThrow("Workflow namespace lease is held by a different owner");

    await releaseDurableWorkflowAuthority(scope);
    const migratedStore = durableWorkflowStoreForSession(root, migratingScope);
    expect(migratedStore).toBeDefined();
    await expect(
      migratedStore!.createRun({
        runId: "run-migrated",
        planRevision: 1,
        resumePolicy: "manual",
        owner: migratedOwner,
      }),
    ).resolves.toMatchObject({ runId: "run-migrated" });
  });

  it("retains the scoped release handle when awaited release fails", async () => {
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("release failed"))
      .mockResolvedValueOnce(undefined);
    const store = { release } as any;
    const controller = {} as any;
    const scope = {
      durableWorkflowStore: store,
      durableWorkflowController: controller,
    } as any;

    await expect(releaseDurableWorkflowAuthority(scope)).rejects.toThrow(
      "release failed",
    );
    expect(scope.durableWorkflowStore).toBe(store);
    expect(scope.durableWorkflowController).toBe(controller);

    await releaseDurableWorkflowAuthority(scope);
    expect(scope.durableWorkflowStore).toBeUndefined();
    expect(scope.durableWorkflowController).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
