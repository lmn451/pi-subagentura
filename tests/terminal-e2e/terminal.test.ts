import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateForMarker } from "./fixtures/mock-provider";
import {
  createHarness,
  tmuxVersion,
  type TerminalHarness,
} from "./harness.mjs";
import { getScenario } from "./scenarios.mjs";

const timeout = 60_000;
let harness: TerminalHarness;

/**
 * `C-M-a` needs `extended-keys-format csi-u`, which tmux only understands from
 * 3.5. ubuntu-latest ships 3.4, so the shortcut test is *reported as skipped*
 * there rather than silently not executing inside a passing test body.
 */
const tmux = tmuxVersion();
const supportsExtendedKeyShortcut =
  tmux.major > 3 || (tmux.major === 3 && tmux.minor >= 5);

beforeEach(() => {
  harness = createHarness({ scenario: "terminal" });
});

// Every harness owns a tmux server, a real Pi process, retained child panes and a
// temp tree. Tearing them down here instead of in one afterAll keeps later tests
// off the load created by earlier ones and keeps teardown out of a single hook
// whose blocking, serialized work has no parallelism to gain.
afterEach(async (context) => {
  await harness.cleanup(context.task.result?.state === "fail");
}, timeout);

function hasStage(
  events: Array<Record<string, unknown>>,
  marker: string,
  stage: string,
): boolean {
  return events.some(
    (event) => event.marker === marker && event.afterStage === stage,
  );
}

async function startScenario(name: string): Promise<void> {
  const scenario = getScenario(name);
  harness.scenario = name;
  await harness.start();
  await harness.sendPrompt(scenario.prompt);
}

async function waitForParentSettled(marker: string): Promise<void> {
  await harness.waitForProvider(
    (events) => hasStage(events, marker, "complete"),
    `${marker} parent completion`,
  );
  await harness.waitForScreen(
    (screen) => screen.includes(`Parent settled for ${marker}`),
    `${marker} settled screen`,
  );
}

async function sendMarker(marker: string): Promise<void> {
  await harness.sendPrompt(`${marker} Continue the deterministic fixture.`);
  await waitForParentSettled(marker);
}

async function runGatedScenario(name: string): Promise<void> {
  const scenario = getScenario(name);
  const toolName = name.includes("workflow")
    ? "workflow"
    : name.includes("isolated")
      ? "subagent_isolated"
      : "subagent_with_context";
  await startScenario(name);
  await harness.waitForProvider(
    (events) => hasStage(events, scenario.child!, "gated"),
    `${name} child gate`,
  );
  // The provider log is written by the child before the parent TUI repaints, so
  // the tool call needs its own wait rather than a synchronous read.
  await harness.waitForScreen(
    (screen) => screen.includes(toolName),
    `${name} tool call rendered`,
  );
  harness.release(scenario.gate!);
  await harness.waitForProvider(
    (events) => hasStage(events, scenario.child!, "complete"),
    `${name} child completion`,
  );
  await waitForParentSettled(scenario.marker);
  await harness.waitForScreen(
    (screen) => screen.includes(scenario.expected),
    `${name} rendered ${scenario.expected}`,
  );
  await harness.assertNoNetwork();
}

function childPane() {
  return harness
    .panes()
    .find(
      (pane) =>
        pane.id !== harness.parentPane && pane.session.startsWith("e2e-"),
    );
}

async function openSupervisor(): Promise<void> {
  await harness.sendPrompt("/subagents");
  await harness.waitForScreen(
    (screen) => screen.includes("Async Subagents"),
    "supervisor overlay",
  );
}

async function closeSupervisor(key = "q"): Promise<void> {
  harness.sendKey(key);
  await harness.waitForScreen(
    (screen) => !screen.includes("Async Subagents"),
    "supervisor close",
  );
}

function assertCompletionSnapshot(
  event: Record<string, unknown>,
  marker: string,
  expectedSource?: string,
) {
  const output = event.output as Record<string, unknown> | undefined;
  const eventsPath = String(event.path);
  expect(output).toBeDefined();
  const snapshotPath = resolve(dirname(eventsPath), String(output?.path));
  const content = readFileSync(snapshotPath, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  expect(content).toContain(marker);
  expect(output?.sha256).toBe(sha256);
  if (expectedSource) expect(event.source).toBe(expectedSource);
}

describe("real Pi terminal E2E", () => {
  it(
    "starts a real Pi editor in the isolated PTY",
    async () => {
      await harness.start();
      // start() gates on the editor key hints, so assert the things it does not:
      // the scripted model is selected and both extensions loaded.
      const screen = harness.renderedScreen();
      expect(screen).toContain("mock • medium");
      expect(screen).toContain("mock-provider.ts");
      expect(screen).toContain("subagent.ts");
      expect(harness.panes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ session: expect.stringMatching(/^e2e-/) }),
        ]),
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders a synchronous context sub-agent through a gated child",
    async () => {
      await runGatedScenario("sync-context");
      const childEvent = harness
        .providerEvents()
        .find((event) => event.marker === "[E2E:CHILD_SYNC_CONTEXT]");
      expect(childEvent?.contextMarkers).toContain("[E2E:SYNC_CONTEXT]");
      expect(childEvent?.contextHasParentSentinel).toBe(true);
      expect(childEvent?.contextRoles).toContain("user");
      expect(childEvent?.contextMessageCount).toBe(1);
      expect(childEvent?.contextToolNames).toEqual([
        "read",
        "bash",
        "edit",
        "write",
      ]);
    },
    timeout,
  );

  it(
    "renders a synchronous isolated sub-agent without parent context",
    async () => {
      await runGatedScenario("sync-isolated");
      const childEvent = harness
        .providerEvents()
        .find((event) => event.marker === "[E2E:CHILD_SYNC_ISOLATED]");
      expect(childEvent?.contextMarkers).not.toContain("[E2E:SYNC_ISOLATED]");
      expect(childEvent?.contextHasParentSentinel).toBe(false);
      expect(childEvent?.contextRoles).toEqual(["user"]);
      expect(childEvent?.contextMessageCount).toBe(1);
      expect(childEvent?.contextToolNames).toEqual([
        "read",
        "bash",
        "edit",
        "write",
      ]);
    },
    timeout,
  );

  it(
    "inspects and retrieves an async isolated child without a triggering turn",
    async () => {
      const scenario = getScenario("async-isolated");
      await startScenario("async-isolated");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "async child gate",
      );
      await waitForParentSettled(scenario.marker);
      await harness.waitForScreen(
        (screen) => screen.includes(scenario.expected),
        "async start notice",
      );

      await sendMarker("[E2E:ASYNC_STATUS]");
      // The job-id suffix distinguishes the status *tool call* from the
      // "Use get_subagent_status to check progress." hint painted earlier.
      await harness.waitForScreen(
        (screen) => /get_subagent_status [a-f0-9]{16}/.test(screen),
        "status tool call rendered",
      );
      const parentCallsBeforeRelease = harness
        .providerEvents()
        .filter((event) => event.marker === scenario.marker).length;

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "async completion",
      );
      await harness.waitForScreen(
        (screen) => /✅ Job [a-f0-9]{16} done/.test(screen),
        "async completion notification",
      );
      expect(
        harness
          .providerEvents()
          .filter((event) => event.marker === scenario.marker),
      ).toHaveLength(parentCallsBeforeRelease);

      await sendMarker("[E2E:ASYNC_RESULT]");
      await harness.waitForScreen(
        (screen) => /get_subagent_result [a-f0-9]{16}/.test(screen),
        "result tool call rendered",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders an in-process workflow phase and completion",
    async () => {
      await runGatedScenario("workflow");
      await harness.waitForScreen(
        (screen) => screen.includes("Child result for [E2E:CHILD_WORKFLOW]."),
        "in-process workflow child result rendered",
      );
    },
    timeout,
  );

  it(
    "runs a background workflow with status, result, and one trigger follow-up",
    async () => {
      const scenario = getScenario("background-workflow");
      await startScenario("background-workflow");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "background workflow child gate",
      );
      await waitForParentSettled(scenario.marker);
      await harness.waitForScreen(
        (screen) => screen.includes(scenario.expected),
        "background workflow start notice",
      );
      await sendMarker("[E2E:WORKFLOW_STATUS]");
      await harness.waitForScreen(
        (screen) => screen.includes('Workflow "e2e-workflow" [running]'),
        "workflow status result rendered",
      );

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "background workflow child completion",
      );
      await harness.waitForProvider(
        (events) =>
          events.filter(
            (event) =>
              event.marker === scenario.marker &&
              event.route === "trigger-followup",
          ).length === 1,
        "background workflow trigger follow-up",
        20_000,
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Workflow follow-up settled"),
        "background workflow settled screen",
      );
      await sendMarker("[E2E:WORKFLOW_RESULT]");
      await harness.waitForScreen(
        (screen) => screen.includes("Child result for [E2E:CHILD_WORKFLOW]."),
        "workflow result returned the child output",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "runs a process-isolated workflow in a retained tmux pane",
    async () => {
      await runGatedScenario("process-workflow");
      const pane = childPane();
      expect(pane).toBeDefined();
      await harness.waitFor(
        () =>
          harness
            .paneScreen(pane?.id)
            .includes("Child result for [E2E:CHILD_WORKFLOW_PROCESS]."),
        "process workflow child pane result",
      );
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      expect(
        harness
          .providerEvents()
          .some(
            (event) =>
              event.marker === "[E2E:CHILD_WORKFLOW_PROCESS]" &&
              event.afterStage === "complete",
          ),
      ).toBe(true);
    },
    timeout,
  );

  it(
    "renders a workflow partial failure without losing successful progress",
    async () => {
      const scenario = getScenario("workflow-partial");
      await startScenario("workflow-partial");
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_OK]", "gated"),
        "partial workflow success gate",
      );
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_ERROR]", "failed"),
        "partial workflow deterministic failure",
      );
      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:CHILD_WORKFLOW_OK]", "complete"),
        "partial workflow successful child",
      );
      await waitForParentSettled(scenario.marker);
      await harness.waitForScreen(
        (screen) => screen.includes(scenario.expected),
        "partial workflow error summary rendered",
      );
      await harness.waitForScreen(
        (screen) =>
          screen.includes("Child result for [E2E:CHILD_WORKFLOW_OK]."),
        "partial workflow retained successful output",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "keeps one interactive child pane for a distinct follow-up turn",
    async () => {
      const scenario = getScenario("interactive");
      await startScenario("interactive");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "interactive child gate",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "interactive completion",
      );
      await harness.waitFor(
        () =>
          harness.paneScreen(pane?.id).includes("Interactive child complete"),
        "interactive child idle pane",
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Completion output was not injected"),
        "interactive parent notification",
        20_000,
      );

      const firstCompletions = harness
        .artifactEvents()
        .filter((event) => event.type === "completion");
      expect(firstCompletions).toHaveLength(1);

      await harness.sendPrompt(
        "[E2E:INTERACTIVE_FOLLOWUP_PARENT] Send the deterministic follow-up.",
      );
      await harness.waitForProvider(
        (events) =>
          hasStage(events, "[E2E:CHILD_INTERACTIVE_FOLLOWUP]", "gated"),
        "interactive follow-up gate",
      );
      harness.release(gateForMarker("[E2E:CHILD_INTERACTIVE_FOLLOWUP]"));
      await harness.waitForProvider(
        (events) =>
          hasStage(events, "[E2E:CHILD_INTERACTIVE_FOLLOWUP]", "complete"),
        "interactive follow-up completion",
      );
      await harness.waitFor(
        () =>
          harness.paneScreen(pane?.id).includes("[E2E:INTERACTIVE_OUTPUT_2]"),
        "interactive follow-up pane output",
      );

      const completions = harness
        .artifactEvents()
        .filter((event) => event.type === "completion");
      expect(completions).toHaveLength(2);
      expect(new Set(completions.map((event) => event.turnId)).size).toBe(2);
      assertCompletionSnapshot(
        completions[0],
        "[E2E:INTERACTIVE_OUTPUT_1]",
        "explicit",
      );
      assertCompletionSnapshot(
        completions[1],
        "[E2E:INTERACTIVE_OUTPUT_2]",
        "explicit",
      );
      const artifactDir = dirname(String(completions[0].path));
      const sessionRoot = resolve(artifactDir, "../..");
      expect(existsSync(resolve(artifactDir, "output.md"))).toBe(true);
      expect(
        readdirSync(sessionRoot).some((name) => name.endsWith(".jsonl")),
      ).toBe(true);
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "retains an interactive artifact after a child provider failure",
    async () => {
      const scenario = getScenario("interactive-error");
      await startScenario("interactive-error");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "failed"),
        "interactive child provider failure",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();
      await harness.waitFor(
        () =>
          harness
            .artifactEvents()
            .some(
              (event) =>
                event.type === "completion" && event.outcome === "error",
            ),
        "interactive error artifact",
        20_000,
      );
      const completion = harness
        .artifactEvents()
        .find(
          (event) => event.type === "completion" && event.outcome === "error",
        );
      expect(completion?.source).toBe("agent_settled");
      const output = completion?.output as Record<string, unknown> | undefined;
      expect(output?.bytes).toBe(0);
      expect(existsSync(resolve(String(output?.path)))).toBe(true);
      await harness.waitFor(
        () =>
          harness
            .paneScreen(pane?.id)
            .includes("Error: scripted provider error"),
        "interactive child error screen",
        20_000,
      );
      expect(
        harness.panes().some((candidate) => candidate.id === pane?.id),
      ).toBe(true);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "cancels an interactive pane while retaining its artifact completion",
    async () => {
      const scenario = getScenario("interactive");
      await startScenario("interactive");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "interactive cancellation gate",
      );
      await waitForParentSettled(scenario.marker);
      const pane = childPane();
      expect(pane).toBeDefined();

      await harness.sendPrompt(
        "[E2E:INTERACTIVE_CANCEL_PARENT] Cancel the interactive fixture.",
      );
      await waitForParentSettled("[E2E:INTERACTIVE_CANCEL_PARENT]");
      await harness.waitFor(
        () => !harness.panes().some((candidate) => candidate.id === pane?.id),
        "interactive pane cancellation",
      );
      await harness.waitFor(
        () =>
          harness
            .artifactEvents()
            .some(
              (event) =>
                event.type === "completion" && event.outcome === "cancelled",
            ),
        "retained interactive cancellation artifact",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "navigates the supervisor and cancels its selected async child",
    async () => {
      const scenario = getScenario("async-isolated");
      await startScenario("async-isolated");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "supervisor fixture gate",
      );
      await waitForParentSettled(scenario.marker);

      let standaloneJobId: string | undefined;
      await openSupervisor();
      await harness.waitForScreen((screen) => {
        const selectedStandalone = screen.match(
          /▶ ▸ \[in-process\] → running ([a-f0-9]{16})\b/,
        );
        if (!selectedStandalone) return false;
        standaloneJobId = selectedStandalone[1];
        return true;
      }, "standalone in-process row selected as running");
      expect(standaloneJobId).toMatch(/^[a-f0-9]{16}$/);
      if (!standaloneJobId) {
        throw new Error("selected standalone job id was not captured");
      }
      await closeSupervisor();

      const workflow = getScenario("background-workflow");
      await harness.sendPrompt(workflow.prompt);
      await harness.waitForProvider(
        (events) => hasStage(events, workflow.child!, "gated"),
        "supervisor workflow gate",
      );
      await waitForParentSettled(workflow.marker);

      await openSupervisor();
      await harness.waitForScreen(
        (screen) => screen.includes("▶ ▸ [workflow] → running e2e-workflow"),
        "workflow root selected first",
      );
      harness.sendKey("Enter");
      await harness.waitForScreen(
        (screen) =>
          screen.includes("▶ ▾ [workflow] → running e2e-workflow") &&
          screen.includes("Workflow: e2e-workflow") &&
          screen.includes("Agents:"),
        "expanded workflow root details",
      );
      harness.sendKey("j");
      await harness.waitForScreen((screen) => {
        const selectedGroupedChild = screen.match(
          /▶ ▸ \[in-process\] → running ([a-f0-9]{16})\b/,
        );
        return (
          selectedGroupedChild !== null &&
          selectedGroupedChild[1] !== standaloneJobId
        );
      }, "grouped workflow child selected");
      harness.sendKey("j");
      await harness.waitForScreen(
        (screen) =>
          screen.includes(`▶ ▸ [in-process] → running ${standaloneJobId}`),
        "captured standalone job selected",
      );
      harness.sendKey("Enter");
      await harness.waitForScreen((screen) => {
        const selectedRow = `▶ ▾ [in-process] → running ${standaloneJobId}`;
        const selectedRowIndex = screen.indexOf(selectedRow);
        return (
          selectedRowIndex >= 0 &&
          screen.indexOf("Model: subagentura-e2e/mock", selectedRowIndex) >
            selectedRowIndex
        );
      }, "expanded captured standalone job details");
      harness.sendKey("x");
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.child &&
              event.afterStage === "failed" &&
              event.abort === true,
          ),
        "supervisor cancellation",
      );
      await closeSupervisor("Escape");
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it.skipIf(!supportsExtendedKeyShortcut)(
    "opens the supervisor through the C-M-a shortcut (tmux >= 3.5)",
    async () => {
      const scenario = getScenario("async-isolated");
      await startScenario("async-isolated");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "supervisor shortcut fixture gate",
      );
      await waitForParentSettled(scenario.marker);

      harness.sendKey("C-M-a");
      await harness.waitForScreen(
        (screen) => screen.includes("Async Subagents"),
        "supervisor shortcut overlay",
      );
      await closeSupervisor();
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "cancels a synchronous child through the real TUI escape path",
    async () => {
      const scenario = getScenario("sync-context");
      await startScenario("sync-context");
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "gated"),
        "synchronous cancellation gate",
      );
      harness.sendKey("Escape");
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.child &&
              event.afterStage === "failed" &&
              event.abort === true,
          ),
        "synchronous child abort",
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Parent settled for [E2E:SYNC_CONTEXT]"),
        "parent idle after synchronous cancellation",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "renders a provider error as a terminal screen state",
    async () => {
      const scenario = getScenario("error");
      await startScenario("error");
      await harness.waitForProvider(
        (events) => hasStage(events, "[E2E:ERROR]", "failed"),
        "provider error",
      );
      // The prompt itself contains "provider error", so match the fixture's own
      // message, which the user never typed.
      await harness.waitForScreen(
        (screen) => screen.includes(scenario.expected),
        "provider error rendered",
      );
      await harness.assertNoNetwork();
    },
    timeout,
  );
});
