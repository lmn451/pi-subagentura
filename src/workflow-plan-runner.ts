import { createHash } from "node:crypto";
import type { SessionOwnerToken } from "./session-scope";
import {
  beginNextExecutionOperation,
  commitExecutionOperation,
  completeExecutionRecord,
  failExecutionOperation,
  getExecutionRecord,
  startExecutionRecord,
  type DeclarativeExecutionTask,
  type DurableExecutionRecord,
} from "./workflow-run-store";

export interface ExecutionTaskResult {
  summary: string;
  outputDigest: string;
}

export interface ExecutionTaskContext {
  executionId: string;
  operationId: string;
  task: DeclarativeExecutionTask;
  attempt: number;
  signal?: AbortSignal;
}

export type ExecutionTaskRunner = (
  context: ExecutionTaskContext,
) => Promise<ExecutionTaskResult>;

export function digestExecutionOutput(output: string): string {
  return createHash("sha256").update(output).digest("hex");
}

export async function runDurableExecution(input: {
  cwd: string;
  executionId: string;
  expectedRevision: number;
  owner: SessionOwnerToken;
  parentSessionId?: string;
  runTask: ExecutionTaskRunner;
  signal?: AbortSignal;
}): Promise<DurableExecutionRecord> {
  let current = startExecutionRecord({
    cwd: input.cwd,
    executionId: input.executionId,
    expectedRevision: input.expectedRevision,
    owner: input.owner,
    parentSessionId: input.parentSessionId,
  });
  const leaseEpoch = current.lease!.epoch;

  while (true) {
    if (input.signal?.aborted) {
      throw new Error("Durable execution aborted");
    }
    const operation = beginNextExecutionOperation({
      cwd: input.cwd,
      executionId: input.executionId,
      expectedRevision: current.revision,
      leaseEpoch,
      owner: input.owner,
    });
    if (!operation) {
      current = getExecutionRecord(input.cwd, input.executionId)!;
      return completeExecutionRecord({
        cwd: input.cwd,
        executionId: input.executionId,
        expectedRevision: current.revision,
        leaseEpoch,
        owner: input.owner,
      });
    }

    try {
      const outcome = await input.runTask({
        executionId: input.executionId,
        operationId: operation.operationId,
        task: operation.task,
        attempt: operation.attempt,
        signal: input.signal,
      });
      current = commitExecutionOperation({
        cwd: input.cwd,
        executionId: input.executionId,
        operationId: operation.operationId,
        leaseEpoch,
        owner: input.owner,
        summary: outcome.summary,
        outputDigest: outcome.outputDigest,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        failExecutionOperation({
          cwd: input.cwd,
          executionId: input.executionId,
          operationId: operation.operationId,
          leaseEpoch,
          owner: input.owner,
          error: message,
        });
      } catch {
        /* cancellation/interruption may already have fenced this stale worker */
      }
      throw error;
    }
  }
}
