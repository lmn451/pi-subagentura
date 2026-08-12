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
  it.each([
    ["request", false, false, false, false, false],
    ["result", true, false, false, false, false],
    ["marker", true, true, false, false, false],
    ["delivery", true, true, true, false, false],
    ["dispatched", true, true, true, true, false],
    ["receipt", true, true, true, true, true],
  ])(
    "F12 repairs the %s cancellation settlement prefix idempotently",
    async (
      _label,
      hasResult,
      hasMarker,
      hasDelivery,
      hasDispatched,
      hasReceipt,
    ) => {
      const root = await mkdtemp(join(tmpdir(), "workflow-cancel-prefix-"));
      roots.push(root);
      const runId = `cancel-${_label}`;
      const requestId = `request-${_label}`;
      const store = new WorkflowRunStore({ rootDir: root, owner });
      await store.createRun({
        runId,
        planRevision: 1,
        resumePolicy: "manual",
        owner,
      });
      await store.append(runId, "run_started", {});
      const request: WorkflowCancellationRequest = {
        ownerId: owner.ownerId,
        ownerGeneration: owner.ownerGeneration,
        leaseEpoch: await store.getLeaseEpoch(),
        requestId,
      };
      await store.append(runId, "run_cancel_requested", request);
      if (hasResult) {
        await store.append(runId, "run_result", {
          result: { status: "cancelled" },
          cancellation: request,
        });
      }
      if (hasMarker) await store.append(runId, "run_cancelled", request);
      if (hasDelivery) {
        await store.append(runId, "delivery_intent", {
          deliveryId: workflowDeliveryId(runId),
          kind: "terminal",
          message: `Workflow ${runId} cancelled`,
        });
      }
      if (hasDispatched) {
        await store.append(runId, "delivery_dispatched", {
          deliveryId: workflowDeliveryId(runId),
        });
      }
      if (hasReceipt) {
        await store.append(runId, "delivery_receipt", {
          deliveryId: workflowDeliveryId(runId),
        });
      }

      const controller = new DurableWorkflowController({ store, owner });
      await expect(controller.cancel(runId, requestId)).resolves.toMatchObject({
        status: "cancelled",
        terminal: { status: "cancelled" },
      });
      await expect(controller.cancel(runId, requestId)).resolves.toMatchObject({
        status: "cancelled",
      });

      const events = (await store.readRun(runId)).events;
      expect(
        events.filter((event) => event.type === "run_cancel_requested"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "run_result"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "run_cancelled"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "delivery_intent"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "delivery_dispatched"),
      ).toHaveLength(hasDispatched ? 1 : 0);
      expect(
        events.filter((event) => event.type === "delivery_receipt"),
      ).toHaveLength(hasReceipt ? 1 : 0);
    },
  );
});
