import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentResult } from "../src/helpers";
import type { WorkflowAgentRunner } from "../src/workflow-core";
import { DurableWorkflowPlanController } from "../src/workflow-durable-plan";
import {
  WorkflowRunStore,
  deriveDurableWorkflowOwner,
} from "../src/workflow-run-store";
import {
  createDurableWorkflowRunId,
  type DurableWorkflowOwner,
} from "../src/workflow-run-types";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/workflow-durable-process-crash.ts", import.meta.url),
);
const TYPESCRIPT_LOADER_URL = pathToFileURL(
  fileURLToPath(
    new URL(
      "./fixtures/workflow-durable-typescript-loader.mjs",
      import.meta.url,
    ),
  ),
).href;
// Real watchdogs are required here because fake timers cannot bound an external
// OS process or its IPC channel.
const WAIT_TIMEOUT_MS = 7_000;

interface CrashReadyMessage {
  readonly type: "crash-ready";
  readonly runId: string;
  readonly evidence: {
    readonly taskASettlementSequence: number;
    readonly taskACompletionSequence: number;
    readonly taskBAttemptSequence: number;
    readonly taskBDispatchSequence: number;
  };
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const temporaryRoots = new Set<string>();
const activeChildren = new Set<ChildProcess>();

function isCrashReadyMessage(value: unknown): value is CrashReadyMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly type?: unknown;
    readonly runId?: unknown;
    readonly evidence?: unknown;
  };
  if (
    candidate.type !== "crash-ready" ||
    typeof candidate.runId !== "string" ||
    typeof candidate.evidence !== "object" ||
    candidate.evidence === null
  ) {
    return false;
  }
  const evidence = candidate.evidence as Partial<CrashReadyMessage["evidence"]>;
  return [
    evidence.taskASettlementSequence,
    evidence.taskACompletionSequence,
    evidence.taskBAttemptSequence,
    evidence.taskBDispatchSequence,
  ].every((sequence) => typeof sequence === "number");
}

function waitForCrashReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<CrashReadyMessage> {
  let resolve!: (message: CrashReadyMessage) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<CrashReadyMessage>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  let stderr = "";
  const onStderr = (chunk: Buffer | string) => {
    stderr += chunk.toString();
  };
  const onMessage = (message: unknown) => {
    if (isCrashReadyMessage(message)) {
      cleanup();
      resolve(message);
      return;
    }
    if (typeof message === "object" && message !== null) {
      const failure = message as {
        readonly type?: unknown;
        readonly message?: unknown;
      };
      if (failure.type === "fixture-error") {
        cleanup();
        reject(
          new Error(
            `workflow crash fixture failed: ${String(failure.message)}\n${stderr}`,
          ),
        );
      }
    }
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup();
    reject(
      new Error(
        `workflow crash fixture exited before readiness (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      ),
    );
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(
      new Error(
        `timed out waiting for workflow crash fixture readiness: ${stderr}`,
      ),
    );
  }, timeoutMs);
  function cleanup(): void {
    clearTimeout(timer);
    child.off("message", onMessage);
    child.off("error", onError);
    child.off("exit", onExit);
    child.stderr?.off("data", onStderr);
  }

  child.on("message", onMessage);
  child.once("error", onError);
  child.once("exit", onExit);
  child.stderr?.on("data", onStderr);
  return promise;
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  let resolve!: (exit: ChildExit) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ChildExit>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup();
    resolve({ code, signal });
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error("timed out waiting for workflow crash fixture exit"));
  }, timeoutMs);
  function cleanup(): void {
    clearTimeout(timer);
    child.off("exit", onExit);
    child.off("error", onError);
  }

  child.once("exit", onExit);
  child.once("error", onError);
  return promise;
}

function withTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  const timer = setTimeout(
    () => reject(new Error(`timed out waiting for ${label}`)),
    timeoutMs,
  );
  void operation.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return promise;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForExit(child, WAIT_TIMEOUT_MS);
  child.kill("SIGKILL");
  await exit;
}

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

function acquireController(
  homeDir: string,
  owner: DurableWorkflowOwner,
  generation: number,
  runner: WorkflowAgentRunner,
): Promise<DurableWorkflowPlanController> {
  return DurableWorkflowPlanController.acquire({
    store: new WorkflowRunStore({
      homeDir,
      processIdentity: {
        pid: process.pid,
        processStartIdentity: `workflow-crash-test-parent-${process.pid}`,
      },
    }),
    owner,
    scopeId: generation,
    generation,
    runAgentForRun: () => runner,
  });
}

async function releaseIfOpen(
  controller: DurableWorkflowPlanController | undefined,
): Promise<void> {
  if (controller === undefined) return;
  await withTimeout(controller.release(), "durable controller release");
}

afterEach(async () => {
  for (const child of activeChildren) {
    await terminateChild(child).catch(() => undefined);
  }
  activeChildren.clear();
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

describe("durable workflow process crash recovery", () => {
  it("replays committed A, retries active B, and preserves the terminal result across process replacement", async () => {
    const homeDir = mkdtempSync(
      join(tmpdir(), "workflow-durable-process-crash-"),
    );
    temporaryRoots.add(homeDir);
    const cwd = join(homeDir, "project");
    mkdirSync(cwd);
    const piSessionId = "pi-session-process-crash";
    const runId = createDurableWorkflowRunId("process-crash-a-b");
    const owner = await deriveDurableWorkflowOwner(cwd, piSessionId);
    let child: ChildProcess | undefined;
    let wrongOwnerController: DurableWorkflowPlanController | undefined;
    let resumedController: DurableWorkflowPlanController | undefined;
    let terminalController: DurableWorkflowPlanController | undefined;

    try {
      child = fork(
        FIXTURE_PATH,
        [JSON.stringify({ homeDir, cwd, piSessionId, runId })],
        {
          execArgv: ["--loader", TYPESCRIPT_LOADER_URL],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      activeChildren.add(child);

      const marker = await waitForCrashReady(child, WAIT_TIMEOUT_MS);
      expect(marker.runId).toBe(runId);
      expect(marker.evidence.taskASettlementSequence).toBeLessThan(
        marker.evidence.taskACompletionSequence,
      );
      expect(marker.evidence.taskACompletionSequence).toBeLessThan(
        marker.evidence.taskBAttemptSequence,
      );
      expect(marker.evidence.taskBAttemptSequence).toBeLessThan(
        marker.evidence.taskBDispatchSequence,
      );

      const childExit = waitForExit(child, WAIT_TIMEOUT_MS);
      expect(child.kill("SIGKILL")).toBe(true);
      await expect(childExit).resolves.toEqual({
        code: null,
        signal: "SIGKILL",
      });
      activeChildren.delete(child);
      child = undefined;

      const wrongOwner = await deriveDurableWorkflowOwner(
        cwd,
        "pi-session-process-crash-other",
      );
      const wrongOwnerCalls: string[] = [];
      wrongOwnerController = await acquireController(
        homeDir,
        wrongOwner,
        2,
        async ({ prompt }) => {
          wrongOwnerCalls.push(prompt);
          return success("must-not-run", 99, 99);
        },
      );
      const wrongOwnerStartup = await wrongOwnerController.open("startup");
      expect(wrongOwnerStartup.recovery.runs).toEqual([]);
      expect(await wrongOwnerController.getProjection(runId)).toBeUndefined();
      await expect(
        wrongOwnerController.trustedResume(runId, {
          trustedActorId: "trusted-test-actor",
        }),
      ).rejects.toMatchObject({ code: "run_not_found" });
      expect(wrongOwnerCalls).toEqual([]);
      await releaseIfOpen(wrongOwnerController);
      wrongOwnerController = undefined;

      const resumedCalls: string[] = [];
      resumedController = await acquireController(
        homeDir,
        owner,
        2,
        async ({ prompt }) => {
          resumedCalls.push(prompt);
          if (prompt !== "run-b") {
            throw new Error(
              "committed task A must replay without a runner call",
            );
          }
          return success("resumed-b", 2, 1);
        },
      );
      const startup = await resumedController.open("startup");
      expect(startup.completions).toEqual([]);
      expect(startup.recovery.runs).toHaveLength(1);
      expect(startup.recovery.runs[0]).toMatchObject({
        runId,
        interrupted: true,
        trustedResumeRequired: true,
        automaticResumeEligible: false,
      });
      expect(resumedCalls).toEqual([]);

      const interrupted = await resumedController.getProjection(runId);
      if (interrupted === undefined) {
        throw new Error("same-owner startup did not recover the crashed run");
      }
      const resumed = await resumedController.trustedResume(runId, {
        trustedActorId: "trusted-test-actor",
        expectedOwner: owner,
        expectedRunEpoch: interrupted.runEpoch,
      });
      const result = await withTimeout(
        resumed.completion,
        "trusted crash recovery completion",
      );

      expect(resumedCalls).toEqual(["run-b"]);
      expect(result).toMatchObject({
        status: "done",
        result: [
          { id: "task-a", output: "committed-a" },
          { id: "task-b", output: "resumed-b" },
        ],
      });
      const projection = await resumedController.getProjection(runId);
      expect(projection?.status).toBe("done");
      expect(projection?.terminal?.status).toBe("done");
      expect(projection?.accounting).toEqual({
        completeness: "lower_bound",
        reason: "ambiguous_dispatch",
        usage: {
          input: 7,
          output: 4,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 11,
          costUsd: 0,
          turns: 2,
        },
      });
      const operationA = projection?.operations.find(
        (operation) => operation.identity.operationId === "task-a",
      );
      const operationB = projection?.operations.find(
        (operation) => operation.identity.operationId === "task-b",
      );
      expect(operationA?.attempts).toHaveLength(1);
      expect(operationA?.replays).toHaveLength(1);
      expect(operationB?.attempts).toHaveLength(2);
      expect(
        operationB?.attempts.map((attempt) => attempt.attempt.attemptNumber),
      ).toEqual([1, 2]);

      await releaseIfOpen(resumedController);
      resumedController = undefined;

      const terminalCalls: string[] = [];
      terminalController = await acquireController(
        homeDir,
        owner,
        3,
        async ({ prompt }) => {
          terminalCalls.push(prompt);
          return success("must-not-run", 99, 99);
        },
      );
      const terminalStartup = await terminalController.open("startup");
      expect(terminalStartup.completions).toEqual([]);
      expect(terminalCalls).toEqual([]);
      expect(await terminalController.getProjection(runId)).toMatchObject({
        status: "done",
        terminal: { status: "done" },
        accounting: projection?.accounting,
      });
      expect(await terminalController.getResult(runId)).toEqual(result);
    } finally {
      await releaseIfOpen(terminalController).catch(() => undefined);
      await releaseIfOpen(resumedController).catch(() => undefined);
      await releaseIfOpen(wrongOwnerController).catch(() => undefined);
      if (child !== undefined) {
        await terminateChild(child).catch(() => undefined);
        activeChildren.delete(child);
      }
    }
  }, 20_000);
});
