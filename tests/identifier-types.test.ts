import { describe, expect, it } from "vitest";
import {
  asNumericIdentifier,
  asStringIdentifier,
  type InProcessJobId,
  type SessionScopeId,
  type WorkflowId,
} from "../src/identifier-types";

const jobId = asStringIdentifier<"in-process-job">("job-1");
const workflowId = asStringIdentifier<"workflow">("wf-1");
const scopeId = asNumericIdentifier<"session-scope">(1);

// @ts-expect-error Different identifier domains must not be assignable.
const invalidWorkflowId: WorkflowId = jobId;

// @ts-expect-error String and numeric identifier domains must not mix.
const invalidScopeId: SessionScopeId = jobId;

const typedJobId: InProcessJobId = jobId;

void invalidWorkflowId;
void invalidScopeId;
void typedJobId;
void workflowId;
void scopeId;

describe("identifier taxonomy", () => {
  it("brands strings and numbers without changing runtime values", () => {
    expect(jobId).toBe("job-1");
    expect(workflowId).toBe("wf-1");
    expect(scopeId).toBe(1);
  });
});
