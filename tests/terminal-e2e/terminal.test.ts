import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

type ReadOnlyMode = "process" | "in-process";

async function startReadOnlyWorkflow(mode: ReadOnlyMode) {
  const suffix = mode === "process" ? "PROCESS" : "IN_PROCESS";
  const parentMarker = `[E2E:WORKFLOW_READONLY_${suffix}]`;
  const childMarker = `[E2E:CHILD_WORKFLOW_READONLY_${suffix}]`;
  harness.scenario = `workflow-readonly-${mode}`;
  const previous = process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL;
  process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL = "1";
  try {
    await harness.start();
  } finally {
    if (previous === undefined)
      delete process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL;
    else process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL = previous;
  }
  writeFileSync(
    join(harness.workspace, "readonly-source.ts"),
    'export const source = "READ_ONLY_SOURCE_SENTINEL";\n',
  );
  await harness.sendPrompt(
    `${parentMarker} Run a durable workflow review of readonly-source.ts.`,
  );
  return { parentMarker, childMarker };
}

type WorkflowToolResult = {
  text?: string;
  details?: unknown;
};

function workflowResultFor(marker: string): WorkflowToolResult | undefined {
  for (const event of harness.providerEvents()) {
    if (event.marker !== marker || !Array.isArray(event.contextToolResults))
      continue;
    for (const candidate of event.contextToolResults as unknown[]) {
      if (!candidate || typeof candidate !== "object") continue;
      if (!("toolName" in candidate) || candidate.toolName !== "workflow")
        continue;
      const rawText =
        "text" in candidate && typeof candidate.text === "string"
          ? candidate.text
          : undefined;
      const resultSeparator = rawText?.indexOf("\n\n") ?? -1;
      return {
        text:
          resultSeparator >= 0 ? rawText?.slice(resultSeparator + 2) : rawText,
        details: "details" in candidate ? candidate.details : undefined,
      };
    }
  }
  return undefined;
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

function completionForArtifactDir(
  events: Array<Record<string, unknown>>,
  artifactDir: string,
): Record<string, unknown> {
  const event = events.find(
    (candidate) =>
      candidate.type === "completion" &&
      resolve(dirname(String(candidate.path))) === resolve(artifactDir),
  );
  if (!event) throw new Error(`no completion artifact for ${artifactDir}`);
  return event;
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
    "starts a real Pi editor in the isolated PTY",
    async () => {
      await harness.start();
      // start() gates on the editor key hints, so assert the things it does not:
      // the scripted model is selected and both extensions loaded.
      const screen = harness.renderedScreen();
      expect(screen).toContain("mock • medium");
      // Long checkout paths can wrap a filename across terminal rows.
      const unwrapped = screen.replace(/\s+/g, "");
      expect(unwrapped).toContain("mock-provider.ts");
      expect(unwrapped).toContain("subagent.ts");
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
      expect(childEvent?.contextRoles).toContain("user");
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
    "runs a read-only V4 durable process workflow and returns its captured result",
    async () => {
      const { parentMarker, childMarker } =
        await startReadOnlyWorkflow("process");
      const controlMarker = "[E2E:CHILD_WORKFLOW_MCP_CONTROL_PROCESS]";
      await harness.waitForProvider(
        (events) => hasStage(events, childMarker, "complete"),
        "read-only process workflow child result",
      );
      await waitForParentSettled(parentMarker);
      await harness.assertNoNetwork();

      const events = harness.providerEvents();
      const parentInitial = events.find(
        (event) => event.marker === parentMarker && event.requestSeq === 1,
      );
      expect(parentInitial?.contextToolNames).toContain("mcp__e2e__mutate");
      const controlEvents = events.filter(
        (event) => event.marker === controlMarker,
      );
      const initialControl = controlEvents.find(
        (event) => event.requestSeq === 1,
      );
      expect(initialControl?.contextToolNames).toContain("mcp__e2e__mutate");
      expect(
        controlEvents
          .filter((event) => event.eventType === "tool_call")
          .map((event) => event.toolCallName),
      ).toEqual(["mcp__e2e__mutate", "write", "bash"]);
      expect(
        readFileSync(
          join(harness.workspace, "readonly-mcp-control.txt"),
          "utf8",
        ),
      ).toBe("PROCESS_MCP_CONTROL_SENTINEL");
      expect(
        events.some(
          (event) => event.marker === "[E2E:CHILD_READONLY_NESTED_SPAWN]",
        ),
      ).toBe(false);
      const childEvents = events.filter(
        (event) => event.marker === childMarker,
      );
      const initialChild = childEvents.find((event) => event.requestSeq === 1);
      expect(initialChild?.contextToolNames).toEqual(
        expect.arrayContaining(["read", "grep", "find", "ls"]),
      );
      expect(initialChild?.contextToolNames).toHaveLength(4);
      expect(initialChild?.contextToolNames).not.toContain("structured_output");
      expect(initialChild?.contextToolNames).not.toContain("mcp__e2e__mutate");
      expect(
        childEvents
          .filter((event) => event.eventType === "tool_call")
          .map((event) => event.toolCallName),
      ).toEqual([
        "read",
        "write",
        "edit",
        "bash",
        "subagent_interactive",
        "mcp__e2e__mutate",
      ]);

      expect(
        readFileSync(join(harness.workspace, "readonly-source.ts"), "utf8"),
      ).toBe('export const source = "READ_ONLY_SOURCE_SENTINEL";\n');
      expect(
        existsSync(join(harness.workspace, "readonly-mcp-created.txt")),
      ).toBe(false);
      const artifactDir = initialChild?.childArtifactDir;
      expect(typeof artifactDir).toBe("string");
      const outputPath = join(String(artifactDir), "output.md");
      const output = existsSync(outputPath)
        ? readFileSync(outputPath, "utf8")
        : "";
      expect(output).not.toContain("FORBIDDEN_OUTPUT_WRITE");
      const artifactEvents = harness.artifactEvents();
      const controlArtifactDir = String(initialControl?.childArtifactDir);
      expect(typeof initialControl?.childArtifactDir).toBe("string");
      const controlCompletion = completionForArtifactDir(
        artifactEvents,
        controlArtifactDir,
      );
      const controlOutput = controlCompletion.output as
        | Record<string, unknown>
        | undefined;
      const controlSnapshotPath = resolve(
        dirname(String(controlCompletion.path)),
        String(controlOutput?.path),
      );
      expect(JSON.parse(readFileSync(controlSnapshotPath, "utf8"))).toEqual({
        written: true,
      });
      assertCompletionSnapshot(controlCompletion, '"written":true');
      const readOnlyArtifactDir = String(initialChild?.childArtifactDir);
      expect(typeof initialChild?.childArtifactDir).toBe("string");
      const readOnlyCompletion = completionForArtifactDir(
        artifactEvents,
        readOnlyArtifactDir,
      );
      assertCompletionSnapshot(
        readOnlyCompletion,
        "READ_ONLY_SOURCE_SENTINEL",
        "agent_settled",
      );

      const workflowResult = workflowResultFor(parentMarker);
      expect(workflowResult).toBeDefined();
      expect(JSON.parse(String(workflowResult?.text))).toEqual({
        source: "READ_ONLY_SOURCE_SENTINEL",
      });
      expect(workflowResult?.details).toMatchObject({
        status: "done",
        durable: true,
      });
      expect(
        (workflowResult?.details as { workflowId?: unknown } | undefined)
          ?.workflowId,
      ).toMatch(/^wfd_/);
    },
    timeout,
  );

  it(
    "reads and returns SDK structured output for a read-only in-process workflow",
    async () => {
      const { parentMarker, childMarker } =
        await startReadOnlyWorkflow("in-process");
      await harness.waitForProvider(
        (events) => hasStage(events, childMarker, "complete"),
        "read-only in-process workflow child result",
      );
      await waitForParentSettled(parentMarker);
      await harness.assertNoNetwork();

      const events = harness.providerEvents();
      const parentInitial = events.find(
        (event) => event.marker === parentMarker && event.requestSeq === 1,
      );
      expect(parentInitial?.contextToolNames).toContain("mcp__e2e__mutate");
      const childEvents = events.filter(
        (event) => event.marker === childMarker,
      );
      expect(
        events.some(
          (event) => event.marker === "[E2E:CHILD_READONLY_NESTED_SPAWN]",
        ),
      ).toBe(false);
      const initialChild = childEvents.find((event) => event.requestSeq === 1);
      expect(initialChild?.contextToolNames).toEqual(
        expect.arrayContaining([
          "read",
          "grep",
          "find",
          "ls",
          "structured_output",
        ]),
      );
      expect(initialChild?.contextToolNames).toHaveLength(5);
      expect(initialChild?.contextToolNames).not.toContain("write");
      expect(initialChild?.contextToolNames).not.toContain("edit");
      expect(initialChild?.contextToolNames).not.toContain("bash");
      expect(initialChild?.contextToolNames).not.toContain("subagent_isolated");
      expect(
        childEvents
          .filter((event) => event.eventType === "tool_call")
          .map((event) => event.toolCallName),
      ).toEqual([
        "read",
        "write",
        "edit",
        "bash",
        "subagent_isolated",
        "mcp__e2e__mutate",
        "structured_output",
      ]);
      expect(
        readFileSync(join(harness.workspace, "readonly-source.ts"), "utf8"),
      ).toBe('export const source = "READ_ONLY_SOURCE_SENTINEL";\n');
      expect(existsSync(join(harness.workspace, "readonly-output.md"))).toBe(
        false,
      );
      expect(
        existsSync(join(harness.workspace, "readonly-mcp-created.txt")),
      ).toBe(false);
      const workflowResult = workflowResultFor(parentMarker);
      expect(workflowResult).toBeDefined();
      expect(JSON.parse(String(workflowResult?.text))).toEqual({
        source: "READ_ONLY_SOURCE_SENTINEL",
      });
      expect(workflowResult?.details).toMatchObject({
        status: "done",
        durable: true,
      });
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
