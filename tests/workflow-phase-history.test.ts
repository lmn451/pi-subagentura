import { expect, it } from "vitest";
import {
  startWorkflowJob,
  cleanupWorkflowJobsForOwner,
} from "../src/workflow-jobs";
import { createTestSessionScope } from "./session-scope-fixture";

it("bounds phase titles and history in both the job and its result", async () => {
  const owner = { id: 27, generation: 1 };
  createTestSessionScope(owner);
  const job = startWorkflowJob(
    "phases",
    'export const meta = { name: "phases", description: "test" };\nfor (let i = 0; i < 103; i++) phase(i + ":" + "x".repeat(300));',
    {
      runAgent: async () => {
        throw new Error("unexpected agent");
      },
    },
    undefined,
    undefined,
    owner,
  );
  try {
    const result = await job.promise;
    for (const history of [job.snapshot, result]) {
      expect(history.phases).toHaveLength(100);
      expect(history.phasesOmitted).toBe(3);
      expect(history.phases[0]).toMatch(/^3:/);
      expect(history.phases.at(-1)).toMatch(/^102:/);
      expect(history.phases.every((title) => title.length === 256)).toBe(true);
    }
  } finally {
    cleanupWorkflowJobsForOwner(owner);
  }
});
