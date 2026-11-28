import {
  inProcessJobOwner,
  scheduleJobCleanup,
  type JobState,
  type SubagentResult,
} from "./helpers";
import { publishCompletion } from "./completion-coordinator";
import type { SessionOwnerToken } from "./session-scope";
import { zeroUsage } from "./usage";
type SettlementListener = (owner: SessionOwnerToken | undefined) => void;

function createAsyncJobErrorResult(error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    output: `Sub-agent crashed: ${message}`,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    model: undefined,
    isError: true,
    errorMessage: message,
  };
}

export function publishInProcessCompletion(
  jobState: JobState,
  result: SubagentResult,
  owner?: SessionOwnerToken,
): void {
  if (!jobState.completionPolicy || jobState.completionOwner === "workflow") {
    return;
  }
  if (jobState.completionPublished) return;
  publishCompletion(
    {
      schemaVersion: 1,
      completionId: `job:${jobState.id}`,
      source: "in-process",
      sourceId: jobState.id,
      label: `Job ${jobState.id}`,
      status: result.cancelled
        ? "cancelled"
        : result.isError
          ? "error"
          : "done",
      policy: jobState.completionPolicy,
      ...(jobState.completionGroupId
        ? { groupId: jobState.completionGroupId }
        : {}),
      references: result.cancelled
        ? [{ label: "status", value: "cancelled; no result retained" }]
        : [
            {
              label: "result",
              value: `call get_subagent_result with jobId ${JSON.stringify(jobState.id)}`,
            },
          ],
      completedAt: jobState.completedAt ?? Date.now(),
    },
    owner,
  );
  jobState.completionPublished = true;
}

function settleAsyncJob(
  jobId: string,
  jobState: JobState,
  result: SubagentResult,
  onSettled?: SettlementListener,
): void {
  jobState.completedAt ??= Date.now();
  const owner = inProcessJobOwner(jobState);
  if (jobState.status === "cancelled") {
    publishInProcessCompletion(
      jobState,
      result.cancelled
        ? result
        : {
            output: "",
            usage: zeroUsage(),
            isError: false,
            cancelled: true,
          },
      owner,
    );
    return;
  }
  if (result.cancelled) {
    jobState.status = "cancelled";
    jobState.result = result;
    publishInProcessCompletion(jobState, result, owner);
    scheduleJobCleanup(jobId, true, undefined, owner);
    onSettled?.(owner);
    return;
  }
  jobState.status = result.isError ? "error" : "done";
  jobState.result = result;
  scheduleJobCleanup(jobId, false, jobState.maxAge, owner);

  publishInProcessCompletion(jobState, result, owner);
  // Workflow aggregates own completion publication for their child jobs.

  onSettled?.(owner);
}

export function attachAsyncJobSettlement(
  jobId: string,
  jobState: JobState,
  onSettled?: SettlementListener,
): void {
  const settledPromise = jobState.promise.catch(createAsyncJobErrorResult);
  jobState.promise = settledPromise;
  void settledPromise.then((result) => {
    settleAsyncJob(jobId, jobState, result, onSettled);
  });
}
