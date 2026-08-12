import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableWorkflowController,
  workflowDeliveryId,
} from "../src/workflow-durable-plan-runner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type {
  WorkflowCancellationRequest,
  WorkflowOwnerIdentity,
} from "../src/workflow-run-types";

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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable cancellation crash-prefix repair", () => {
  it("F12 repairs a terminal cancellation prefix when a later cancel call has no request ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-cancel-prefix-"));
    roots.push(root);
    const runId = "cancel-reissued";
    const request: WorkflowCancellationRequest = {
      ownerId: owner.ownerId,
      ownerGeneration: owner.ownerGeneration,
      leaseEpoch: 1,
      requestId: "original-request",
    };
    const store = new WorkflowRunStore({ rootDir: root, owner });
    await store.createRun({
      runId,
      planRevision: 1,
      resumePolicy: "manual",
      owner,
    });
    await store.append(runId, "run_cancel_requested", request);
    await store.append(runId, "run_result", {
      result: { status: "cancelled" },
      cancellation: request,
    });

    const controller = new DurableWorkflowController({ store, owner });
    await expect(controller.cancel(runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(controller.cancel(runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    const events = (await store.readRun(runId)).events;
    expect(
      events.filter((event) => event.type === "run_cancelled"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "delivery_intent"),
    ).toHaveLength(1);
    expect(
      events.find((event) => event.type === "delivery_intent")?.payload,
    ).toMatchObject({ deliveryId: workflowDeliveryId(runId) });
  });
});
