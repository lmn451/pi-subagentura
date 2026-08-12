import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowProcessAttemptManifest,
  recoverWorkflowProcessAttempt,
  type WorkflowProcessAttemptInspector,
  type WorkflowProcessPaneAssignment,
} from "../src/workflow-process-attempt";
import {
  createDurableWorkflowRunId,
  createWorkflowAttemptId,
  createWorkflowAttemptNumber,
  createWorkflowDefinitionDigest,
  createWorkflowDefinitionPath,
  createWorkflowDispatchOrdinal,
  createWorkflowOperationIdentity,
  createWorkflowRequestDigest,
  type WorkflowOperationAttempt,
} from "../src/workflow-run-types";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/workflow-process-attempt-crash.mjs", import.meta.url),
);
const activeChildren = new Set<ChildProcess>();
const temporaryRoots = new Set<string>();

interface FixtureState {
  launchPrepared: boolean;
  panes: Array<{ paneId: string; alive: boolean }>;
  assignment: string | null;
  launchDispatched: boolean;
  commandCount: number;
  childStarted: boolean;
  terminalCount: number;
}

function attempt(): WorkflowOperationAttempt {
  const runId = createDurableWorkflowRunId("process-crash-window");
  return {
    operation: createWorkflowOperationIdentity(
      runId,
      createWorkflowDefinitionPath("root"),
      "task-a",
    ),
    requestDigest: createWorkflowRequestDigest("3".repeat(64)),
    definitionDigest: createWorkflowDefinitionDigest("4".repeat(64)),
    dispatchOrdinal: createWorkflowDispatchOrdinal(1),
    attemptId: createWorkflowAttemptId("attempt-1"),
    attemptNumber: createWorkflowAttemptNumber(1),
  };
}

function assignment(paneId: string): WorkflowProcessPaneAssignment {
  return {
    backend: "tmux",
    paneId,
    windowName: "wf-crash-window",
    muxSession: "fixture-session",
    artifactDir: `/tmp/workflow-process-crash/${paneId}`,
    sessionFile: `/tmp/workflow-process-crash/${paneId}.jsonl`,
    launchScriptFile: `/tmp/workflow-process-crash/${paneId}.sh`,
  };
}

function waitForPhase(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`fixture did not reach ${expected}`));
    }, 5_000);
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        !("phase" in message) ||
        message.type !== "phase" ||
        message.phase !== expected
      ) {
        return;
      }
      clearTimeout(timeout);
      child.off("message", onMessage);
      resolve();
    };
    child.on("message", onMessage);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function crashAt(
  phase: "before_pane" | "pane_created" | "pane_assigned" | "child_started",
): Promise<FixtureState> {
  const root = mkdtempSync(join(tmpdir(), "workflow-process-crash-"));
  temporaryRoots.add(root);
  const statePath = join(root, "state.json");
  const child = fork(FIXTURE, [], {
    env: {
      ...process.env,
      WORKFLOW_PROCESS_STATE: statePath,
      WORKFLOW_PROCESS_CRASH_AT: phase,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  activeChildren.add(child);
  await waitForPhase(child, phase);
  child.kill("SIGKILL");
  await waitForExit(child);
  activeChildren.delete(child);
  return JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;
}

afterEach(async () => {
  for (const child of activeChildren) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  activeChildren.clear();
  for (const root of temporaryRoots)
    rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("workflow process subprocess crash windows", () => {
  it.each([
    ["before_pane", "retry"],
    ["pane_created", "fenced"],
    ["pane_assigned", "fenced"],
    ["child_started", "adopt_live"],
  ] as const)(
    "recovers %s without a duplicate live pane or command",
    async (phase, expectedResolution) => {
      const state = await crashAt(phase);
      const manifest = createWorkflowProcessAttemptManifest(
        attempt(),
        1,
        "nonce_1234567890abcdef",
        "process",
      );
      const assignmentById = (paneId: string) => assignment(paneId);
      const inspector: WorkflowProcessAttemptInspector = {
        findByMarker: vi.fn(async () =>
          state.panes
            .filter((pane) => pane.alive)
            .map((pane) => assignmentById(pane.paneId)),
        ),
        paneLiveness: vi.fn(async (candidate) => {
          const pane = state.panes.find(
            (entry) => entry.paneId === candidate.paneId,
          );
          return pane?.alive ? "alive" : "dead";
        }),
        terminalEvidence: vi.fn(async () => []),
        fence: vi.fn(async (candidate) => {
          const pane = state.panes.find(
            (entry) => entry.paneId === candidate.paneId,
          );
          if (pane) pane.alive = false;
        }),
      };
      const persistedAssignment =
        state.assignment === null
          ? undefined
          : assignmentById(state.assignment);
      const resolution = await recoverWorkflowProcessAttempt(
        {
          manifest,
          assignment: persistedAssignment,
          launchDispatched: state.launchDispatched,
          childStarted: state.childStarted,
          terminal: false,
          adopted: false,
          fenced: false,
        },
        inspector,
        { maxAmbiguousProbes: 3 },
      );

      expect(resolution.kind).toBe(expectedResolution);
      if (resolution.kind === "retry" || resolution.kind === "fenced") {
        state.panes.push({ paneId: "%fixture-retry", alive: true });
        state.commandCount += 1;
        state.childStarted = true;
        state.terminalCount += 1;
      } else {
        state.terminalCount += 1;
      }

      expect(state.panes.filter((pane) => pane.alive)).toHaveLength(1);
      expect(state.commandCount).toBe(1);
      expect(state.terminalCount).toBe(1);
      if (phase === "child_started") {
        expect(inspector.fence).not.toHaveBeenCalled();
      }
    },
  );
});
