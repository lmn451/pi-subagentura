import { describe, expect, it } from "vitest";
import {
  validateWorkflowApprovalDecision,
  validateWorkflowApprovalRequest,
} from "../src/workflow-run-types";

describe("workflow approval request", () => {
  it("accepts a fully bound trusted request", () => {
    expect(() =>
      validateWorkflowApprovalRequest({
        requestId: "request",
        policyHash: "hash",
        planRevision: 1,
        ownerGeneration: 2,
        leaseEpoch: 3,
        version: 1,
      }),
    ).not.toThrow();
  });

  it("rejects missing binding data and unsafe versions", () => {
    expect(() =>
      validateWorkflowApprovalRequest({
        requestId: "",
        policyHash: "hash",
        planRevision: 1,
        ownerGeneration: 0,
        leaseEpoch: 0,
        version: 1,
      }),
    ).toThrow("approval request");
    expect(() =>
      validateWorkflowApprovalRequest({
        requestId: "request",
        policyHash: "hash",
        planRevision: -1,
        ownerGeneration: 0,
        leaseEpoch: 0,
        version: 1,
      }),
    ).toThrow("version");
  });

  it("validates a host decision envelope", () => {
    expect(() =>
      validateWorkflowApprovalDecision({
        requestId: "request",
        status: "approved",
        decidedBy: "operator",
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkflowApprovalDecision({
        requestId: "request",
        status: "pending" as never,
        decidedBy: "operator",
      }),
    ).toThrow("status");
  });
});
