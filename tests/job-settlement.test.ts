import { expect, it, vi } from "vitest";
import type { JobState } from "../src/helpers";
import {
  attachAsyncJobSettlement,
  publishInProcessCompletion,
} from "../src/job-settlement";
import { publishCompletion } from "../src/completion-coordinator";
import { zeroUsage } from "../src/usage";
vi.mock("../src/completion-coordinator", () => ({
  publishCompletion: vi.fn(),
}));
vi.mock("../src/helpers", () => ({
  inProcessJobOwner: () => undefined,
  scheduleJobCleanup: vi.fn(),
}));
it.each(["standalone", "workflow"] as const)(
  "settles successful and rejected %s jobs without duplicate publication",
  async (completionOwner) => {
    for (const failed of [false, true]) {
      vi.mocked(publishCompletion).mockClear();
      const job: JobState = {
        id: "job",
        status: "running",
        startedAt: 0,
        liveStatus: {} as JobState["liveStatus"],
        session: {} as JobState["session"],
        completionPolicy: "each",
        completionOwner,
        promise: failed
          ? Promise.reject(new Error("failure"))
          : Promise.resolve({
              output: "ok",
              isError: false,
              usage: zeroUsage(),
            }),
      };
      attachAsyncJobSettlement(job.id, job);
      const result = await job.promise;
      expect(job.status).toBe(failed ? "error" : "done");
      expect(job.result).toBe(result);
      expect(publishCompletion).toHaveBeenCalledTimes(
        completionOwner === "standalone" ? 1 : 0,
      );
      publishInProcessCompletion(job, result);
      expect(publishCompletion).toHaveBeenCalledTimes(
        completionOwner === "standalone" ? 1 : 0,
      );
    }
  },
);
