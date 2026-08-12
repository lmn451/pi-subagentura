import { once } from "node:events";
import type { SubagentResult } from "../../src/helpers";
import type { WorkflowAgentRunner } from "../../src/workflow-core";
import { DurableWorkflowPlanController } from "../../src/workflow-durable-plan";
import { validateWorkflowPlan } from "../../src/workflow-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
} from "../../src/workflow-run-store";
import { isDurableWorkflowRunId } from "../../src/workflow-run-types";

interface FixtureConfig {
  readonly homeDir: string;
  readonly cwd: string;
  readonly piSessionId: string;
  readonly runId: string;
}

const TASK_A_ID = "task-a";
const TASK_B_ID = "task-b";

function success(
  output: string,
  input: number,
  outputTokens: number,
): Extract<SubagentResult, { isError: false }> {
  return {
    isError: false,
    output,
    usage: {
      input,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
  };
}

function send(message: Record<string, unknown>): void {
  if (typeof process.send !== "function" || !process.connected) {
    throw new Error("workflow crash fixture requires an IPC channel");
  }
  process.send(message);
}

function fixturePlan() {
  return validateWorkflowPlan({
    name: "durable-process-crash",
    description: "two-task durable crash fixture",
    phases: [
      {
        id: "phase-a",
        name: "Phase A",
        mode: "sequence",
        tasks: [
          {
            id: TASK_A_ID,
            content: "Task A",
            instruction: "run-a",
          },
          {
            id: TASK_B_ID,
            content: "Task B",
            instruction: "run-b",
          },
        ],
      },
    ],
  });
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "null") as FixtureConfig | null;
  if (
    config === null ||
    typeof config.homeDir !== "string" ||
    typeof config.cwd !== "string" ||
    typeof config.piSessionId !== "string" ||
    !isDurableWorkflowRunId(config.runId)
  ) {
    throw new Error("workflow crash fixture received invalid configuration");
  }

  const runId = config.runId;
  const owner = await deriveDurableWorkflowOwner(
    config.cwd,
    config.piSessionId,
  );
  const store = new WorkflowRunStore({
    homeDir: config.homeDir,
    processIdentity: {
      pid: process.pid,
      processStartIdentity: `workflow-crash-fixture-${process.pid}`,
    },
  });

  const runner: WorkflowAgentRunner = async ({ prompt }) => {
    if (prompt === "run-a") return success("committed-a", 5, 3);
    if (prompt !== "run-b") throw new Error(`unexpected prompt: ${prompt}`);

    const journal = await store.openRun(owner, runId);
    const events = await journal.readEvents();
    const taskASettled = events.find(
      (event) =>
        event.type === "operation_settled" &&
        event.payload.attempt.operation.operationId === TASK_A_ID,
    );
    const taskACompleted = events.find(
      (event) =>
        event.type === "task_transitioned" &&
        event.payload.taskId === TASK_A_ID &&
        event.payload.to === "succeeded",
    );
    const taskBStarted = events.find(
      (event) =>
        event.type === "attempt_started" &&
        event.payload.attempt.operation.operationId === TASK_B_ID,
    );
    const taskBDispatched = events.find(
      (event) =>
        event.type === "operation_dispatched" &&
        event.payload.attempt.operation.operationId === TASK_B_ID,
    );
    if (
      taskASettled === undefined ||
      taskACompleted === undefined ||
      taskBStarted === undefined ||
      taskBDispatched === undefined
    ) {
      throw new Error(
        "readiness marker requested before durable task A commit and task B dispatch",
      );
    }

    send({
      type: "crash-ready",
      runId,
      evidence: {
        taskASettlementSequence: taskASettled.sequence,
        taskACompletionSequence: taskACompleted.sequence,
        taskBAttemptSequence: taskBStarted.sequence,
        taskBDispatchSequence: taskBDispatched.sequence,
      },
    });
    await once(process, "disconnect");
    throw new Error("workflow crash fixture parent disconnected before kill");
  };

  const controller = await DurableWorkflowPlanController.acquire({
    store,
    owner,
    scopeId: 1,
    generation: 1,
    runAgentForRun: () => runner,
  });
  const execution = await controller.startPlan({
    runId,
    plan: fixturePlan(),
    resumePolicy: "trusted_resume",
  });
  const result = await execution.completion;
  throw new Error(
    `workflow crash fixture unexpectedly completed with status ${result.status}`,
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  if (typeof process.send === "function" && process.connected) {
    process.send({ type: "fixture-error", message }, () => {
      if (process.connected && typeof process.disconnect === "function") {
        process.disconnect();
      }
    });
  }
});
