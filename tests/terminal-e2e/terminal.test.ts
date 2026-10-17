import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  E2E_MODEL,
  E2E_PROVIDER,
  gateForMarker,
} from "./fixtures/mock-provider";
import {
  createHarness,
  tmuxVersion,
  type PaneInfo,
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
  harness.omitChildApiKey = scenario.omitChildApiKey ?? false;
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

function childPanes() {
  const panes = harness.panes();
  return panes.filter(
    (pane) => pane.id !== harness.parentPane && pane.session.startsWith("e2e-"),
  );
}

async function waitForAnthropicConfigErrorPane() {
  let errorPane: PaneInfo | undefined;
  await harness.waitFor(() => {
    errorPane = childPanes().find((pane) => {
      const screen = harness.paneScreen(pane.id);
      return (
        /anthropic|claude-sonnet-4-5/i.test(screen) &&
        /api\s*key|credential|authentication|not configured|login/i.test(screen)
      );
    });
    return errorPane !== undefined;
  }, "actual Anthropic configuration error in a live child pane");
  if (!errorPane) throw new Error("Anthropic error pane disappeared");
  return errorPane;
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

function assertPreTurnPromptError(completion: Record<string, unknown>) {
  const turnId = String(completion.turnId);
  expect(completion.type).toBe("completion");
  expect(completion.status).toBe("error");
  expect(completion.outcome).toBe("error");
  expect(completion.source).toBe("prompt_error");
  expect(completion.exitCode).toBe(1);
  expect(typeof completion.errorMessage).toBe("string");
  expect(completion.message).toBe(completion.errorMessage);

  const output = completion.output as Record<string, unknown> | undefined;
  expect(output?.bytes).toBe(0);
  const snapshotPath = resolve(
    dirname(String(completion.path)),
    String(output?.path),
  );
  const content = readFileSync(snapshotPath, "utf8");
  expect(content).toBe("");
  expect(output?.sha256).toBe(createHash("sha256").update("").digest("hex"));

  const events = harness
    .artifactEvents()
    .filter((event) => event.path === completion.path);
  expect(
    events.filter(
      (event) => event.type === "turn_started" && event.turnId === turnId,
    ),
  ).toHaveLength(0);
  expect(
    events.filter(
      (event) => event.type === "completion" && event.turnId === turnId,
    ),
  ).toHaveLength(1);
}

async function selectRecoveryModel(
  pane: PaneInfo,
  completion: Record<string, unknown>,
): Promise<void> {
  const artifactDir = dirname(String(completion.path));
  harness.tmux(["send-keys", "-t", pane.id, "-l", "--", "/model"]);
  harness.tmux(["send-keys", "-t", pane.id, "Enter"]);
  await harness.waitFor(
    () => harness.paneScreen(pane.id).includes("Model Name:"),
    "native child model selector is ready",
  );
  harness.tmux([
    "send-keys",
    "-t",
    pane.id,
    "-l",
    "--",
    `${E2E_PROVIDER}/${E2E_MODEL}`,
  ]);
  await harness.waitFor(() => {
    const screen = harness.paneScreen(pane.id);
    return (
      screen.includes(`${E2E_MODEL} [${E2E_PROVIDER}]`) &&
      screen.includes("Model Name: E2E Mock")
    );
  }, "native child model selector filters to the fixture model");
  harness.tmux(["send-keys", "-t", pane.id, "Enter"]);

  await harness.waitForProvider(
    (events) =>
      events.some(
        (event) =>
          event.eventType === "model_select" &&
          event.artifactDir === artifactDir &&
          event.selectedProvider === E2E_PROVIDER &&
          event.selectedModelId === E2E_MODEL &&
          event.source === "set",
      ),
    "actual child model_select confirms the E2E provider/model",
  );
}

async function recoverPromptErrorChild(
  completion: Record<string, unknown>,
  errorPane: PaneInfo,
): Promise<void> {
  await selectRecoveryModel(errorPane, completion);
  const turnId = String(completion.turnId);
  const recoveryParentMarker = "[E2E:INTERACTIVE_PROMPT_ERROR_RECOVERY_PARENT]";
  const recoveryChildMarker = "[E2E:CHILD_INTERACTIVE_PROMPT_ERROR_RECOVERY]";
  await harness.sendPrompt(
    `${recoveryParentMarker} Send a valid follow-up to the recovered child.`,
  );
  await waitForParentSettled(recoveryParentMarker);
  await harness.waitForProvider(
    (events) => hasStage(events, recoveryChildMarker, "complete"),
    "valid child follow-up completes normally",
  );
  let recovery: Record<string, unknown> | undefined;
  await harness.waitFor(() => {
    recovery = harness
      .artifactEvents()
      .find(
        (event) =>
          event.path === completion.path &&
          event.type === "completion" &&
          event.turnId !== turnId &&
          event.outcome !== "error",
      );
    return recovery !== undefined;
  }, "separate normal recovery completion");
  const recoveryCompletion = recovery;
  if (!recoveryCompletion)
    throw new Error("normal recovery completion missing");
  expect(recoveryCompletion.source).toBe("explicit");
  assertCompletionSnapshot(
    recoveryCompletion,
    "[E2E:INTERACTIVE_OUTPUT_1]",
    "explicit",
  );
  expect(recoveryCompletion.turnId).not.toBe(completion.turnId);
}

async function waitForPromptErrorCompletion() {
  let completion: Record<string, unknown> | undefined;
  await harness.waitFor(
    () => {
      completion = harness
        .artifactEvents()
        .find(
          (event) =>
            event.type === "completion" &&
            event.source === "prompt_error" &&
            event.outcome === "error" &&
            typeof event.errorMessage === "string",
        );
      return completion !== undefined;
    },
    "pre-turn prompt-error completion",
    20_000,
  );
  if (!completion) throw new Error("pre-turn prompt-error completion missing");
  return completion;
}

async function waitForPromptErrorAfter(firstTurnId: string) {
  let completion: Record<string, unknown> | undefined;
  await harness.waitFor(
    () => {
      completion = harness
        .artifactEvents()
        .find(
          (event) =>
            event.type === "completion" &&
            event.source === "prompt_error" &&
            event.outcome === "error" &&
            typeof event.errorMessage === "string" &&
            event.turnId !== firstTurnId,
        );
      return completion !== undefined;
    },
    "second pre-turn prompt-error completion after native session replacement",
    20_000,
  );
  if (!completion) throw new Error("second prompt-error completion missing");
  return completion;
}

async function sendChildPrompt(pane: PaneInfo, text: string): Promise<void> {
  harness.tmux(["send-keys", "-t", pane.id, "-l", "--", text]);
  await harness.waitFor(
    () => harness.paneScreen(pane.id).includes(text),
    "child Pi echoes the prompt after native session replacement",
  );
  harness.tmux(["send-keys", "-t", pane.id, "Enter"]);
}

async function retryPromptErrorAfterNativeNew(
  firstCompletion: Record<string, unknown>,
  pane: PaneInfo,
  childId: string,
): Promise<void> {
  const firstTurnId = String(firstCompletion.turnId);
  harness.tmux(["send-keys", "-t", pane.id, "-l", "--", "/new"]);
  harness.tmux(["send-keys", "-t", pane.id, "Enter"]);
  await harness.waitFor(
    () => harness.paneScreen(pane.id).includes("New session started"),
    "native /new replaces the child Pi session",
  );
  await sendChildPrompt(
    pane,
    "Retry the Anthropic request after starting a new session.",
  );

  const secondCompletion = await waitForPromptErrorAfter(firstTurnId);
  assertPreTurnPromptError(secondCompletion);
  await harness.waitForProvider(
    (events) =>
      events.some(
        (event) =>
          event.eventType === "artifact_read_observed" &&
          event.childId === childId &&
          event.turnId === secondCompletion?.turnId &&
          typeof event.resultText === "string" &&
          event.resultText.includes(String(secondCompletion.errorMessage)),
      ),
    "parent observes the second raw error from the replacement session",
  );
}

describe("real Pi terminal E2E", () => {
  it(
    "shows extension tool parameters only after Ctrl+O expansion",
    async () => {
      await startScenario("tool-parameters");
      await harness.waitForScreen(
        (screen) => screen.includes("List Available Models"),
        "model-list tool call",
      );
      const collapsed = harness.renderedScreen();
      expect(collapsed).not.toContain('"filter"');
      expect(collapsed).not.toContain('"authOnly"');

      harness.sendKey("C-o");
      await harness.waitForScreen(
        (screen) => screen.includes('"filter": "subagentura-e2e"'),
        "expanded model-list parameters",
      );
      const expanded = harness.renderedScreen();
      expect(expanded).toContain('"authOnly": false');

      await harness.waitForScreen(
        (screen) =>
          screen.includes("Parent settled for [E2E:TOOL_PARAMETERS]."),
        "parent settled after model-list tool call",
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
    "inspects and retrieves an async isolated child with coordinated completion",
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

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.child!, "complete"),
        "async completion",
      );
      await harness.waitForScreen(
        (screen) => /from: Job [a-f0-9]{16}, ✓ done/.test(screen),
        "async completion TUI notice",
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Async completion reference received"),
        "async completion parent manifest",
      );

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
              event.marker === "[E2E:WORKFLOW_STATUS]" &&
              event.route === "trigger-followup",
          ).length === 1,
        "background workflow trigger follow-up",
        20_000,
      );
      await harness.waitForScreen(
        (screen) => screen.includes("Async completion reference received"),
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
        (screen) =>
          screen.includes("Interactive completion reference received"),
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
    "delivers a real Anthropic pre-turn prompt error and recovers in the same child",
    async () => {
      const scenario = getScenario("interactive-prompt-error-each");
      await startScenario(scenario.name);
      await waitForParentSettled(scenario.marker);
      const errorPane = await waitForAnthropicConfigErrorPane();
      const completion = await waitForPromptErrorCompletion();
      assertPreTurnPromptError(completion);
      const childId = String(
        harness
          .providerEvents()
          .find(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "interactive_spawn_result",
          )?.childId,
      );
      const turnId = String(completion.turnId);
      const rawError = String(completion.errorMessage);
      expect(rawError).toMatch(/anthropic/i);
      expect(
        harness
          .providerEvents()
          .some((event) => event.marker === scenario.child),
      ).toBe(false);

      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_requested" &&
              event.childId === childId &&
              event.turnId === turnId &&
              event.status === "error",
          ),
        "parent exact-ID error artifact read",
      );
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_observed" &&
              event.childId === childId &&
              event.turnId === turnId,
          ),
        "parent observes the real artifact-reader result",
      );
      const observedRead = harness
        .providerEvents()
        .find(
          (event) =>
            event.marker === scenario.marker &&
            event.eventType === "artifact_read_observed" &&
            event.childId === childId &&
            event.turnId === turnId,
        );
      expect(typeof observedRead?.resultText).toBe("string");
      expect(observedRead?.resultText).toContain(rawError);
      const whitespaceFreeError = rawError.replace(/\s/g, "");
      await harness.waitFor(
        () =>
          harness
            .scrollback(errorPane.id)
            .replace(/\s/g, "")
            .includes(whitespaceFreeError),
        "real configuration error remains on the live child pane",
      );
      await harness.waitFor(
        () =>
          harness.scrollback().replace(/\s/g, "").includes(whitespaceFreeError),
        "parent displays the raw diagnostic returned by read_subagent_artifact",
      );
      expect(harness.panes().some((pane) => pane.id === errorPane.id)).toBe(
        true,
      );

      await retryPromptErrorAfterNativeNew(completion, errorPane, childId);
      await recoverPromptErrorChild(completion, errorPane);
      await harness.assertNoNetwork();
    },
    timeout,
  );

  it(
    "delivers a real Anthropic pre-turn prompt error before its grouped sibling finishes",
    async () => {
      const scenario = getScenario("interactive-prompt-error-group");
      await startScenario(scenario.name);
      await waitForParentSettled(scenario.marker);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.sibling!, "gated"),
        "registered grouped sibling waits at its provider gate",
      );
      await harness.waitFor(
        () => childPanes().length === 2,
        "both grouped interactive child panes",
      );
      const errorPane = await waitForAnthropicConfigErrorPane();
      const completion = await waitForPromptErrorCompletion();
      assertPreTurnPromptError(completion);
      const spawnResults = harness
        .providerEvents()
        .filter(
          (event) =>
            event.marker === scenario.marker &&
            event.eventType === "interactive_spawn_result",
        );
      const siblingId = String(
        spawnResults.find((event) => event.sequence === 2)?.childId,
      );
      const errorChildId = String(
        spawnResults.find((event) => event.sequence === 3)?.childId,
      );
      const errorTurnId = String(completion.turnId);
      const rawError = String(completion.errorMessage);
      expect(rawError).toMatch(/anthropic/i);

      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_requested" &&
              event.childId === errorChildId &&
              event.turnId === errorTurnId &&
              event.status === "error",
          ),
        "group error read despite its pending sibling",
      );
      const beforeRelease = harness.providerEvents();
      expect(hasStage(beforeRelease, scenario.sibling!, "complete")).toBe(
        false,
      );
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_observed" &&
              event.childId === errorChildId &&
              event.turnId === errorTurnId,
          ),
        "parent observes grouped error artifact result while sibling is gated",
      );
      const observedRead = harness
        .providerEvents()
        .find(
          (event) =>
            event.marker === scenario.marker &&
            event.eventType === "artifact_read_observed" &&
            event.childId === errorChildId &&
            event.turnId === errorTurnId,
        );
      expect(typeof observedRead?.resultText).toBe("string");
      expect(observedRead?.resultText).toContain(rawError);
      const whitespaceFreeError = rawError.replace(/\s/g, "");
      await harness.waitFor(
        () =>
          harness
            .scrollback(errorPane.id)
            .replace(/\s/g, "")
            .includes(whitespaceFreeError),
        "actual grouped Anthropic error remains visible in the live child",
      );
      await harness.waitFor(
        () =>
          harness.scrollback().replace(/\s/g, "").includes(whitespaceFreeError),
        "parent observes raw grouped error diagnostic",
      );
      expect(harness.panes().some((pane) => pane.id === errorPane.id)).toBe(
        true,
      );
      expect(
        harness
          .providerEvents()
          .filter(
            (event) =>
              event.eventType === "artifact_read_requested" &&
              event.childId === errorChildId,
          ),
      ).toHaveLength(1);

      harness.release(scenario.gate!);
      await harness.waitForProvider(
        (events) => hasStage(events, scenario.sibling!, "complete"),
        "remaining grouped sibling completes after release",
      );
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_requested" &&
              event.childId === siblingId &&
              event.status === "done",
          ),
        "parent receives the remaining grouped completion",
      );
      const reads = harness
        .providerEvents()
        .filter((event) => event.eventType === "artifact_read_requested");
      expect(reads).toHaveLength(2);
      expect(
        reads.filter((event) => event.childId === errorChildId),
      ).toHaveLength(1);
      expect(reads.filter((event) => event.childId === siblingId)).toHaveLength(
        1,
      );
      const siblingRead = reads.find((event) => event.childId === siblingId);
      expect(typeof siblingRead?.turnId).toBe("string");
      await harness.waitForProvider(
        (events) =>
          events.some(
            (event) =>
              event.marker === scenario.marker &&
              event.eventType === "artifact_read_observed" &&
              event.childId === siblingId &&
              event.turnId === siblingRead?.turnId,
          ),
        "parent observes the exact sibling artifact read result",
      );
      await harness.waitFor(
        () =>
          harness
            .scrollback()
            .includes(`Reading turnId: ${String(siblingRead?.turnId)}`),
        "parent reads the sibling's distinct grouped turn",
      );
      await recoverPromptErrorChild(completion, errorPane);
      expect(
        harness
          .providerEvents()
          .filter(
            (event) =>
              event.eventType === "artifact_read_requested" &&
              event.childId === errorChildId,
          ),
      ).toHaveLength(1);
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
      // An aborted turn need not produce another provider response. Verify
      // recovery by completing a distinct turn through the same editor.
      const recovery = getScenario("sync-isolated");
      await harness.sendPrompt(recovery.prompt);
      await harness.waitForProvider(
        (events) => hasStage(events, recovery.child!, "gated"),
        "new child after synchronous cancellation",
      );
      harness.release(recovery.gate!);
      await waitForParentSettled(recovery.marker);
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
