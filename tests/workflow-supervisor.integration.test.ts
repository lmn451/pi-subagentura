/**
 * End-to-end coverage for workflow-owned children as seen by the parent session's
 * live surfaces: the supervisor overlay, the activity widget, the running-agents
 * footer, the job registries, and `session_shutdown`.
 *
 * Only the two process boundaries are stubbed — `launchInteractiveSubagent` (which
 * would spawn a real tmux pane) and `startSubagentJob` (which would open a real
 * model session). Everything in between is the real code path: `registerWorkflowTool`
 * → `startWorkflowJob` → `runWorkflow` in a real Worker → `runAgent` →
 * `awaitInteractiveResult`, plus the real poller, the real session context stack
 * and the real `session_shutdown` handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubagentResult } from "../src/helpers";

const { mockAwaitInteractiveResult, mockLaunch, mockStartSubagentJob } =
  vi.hoisted(() => ({
    mockAwaitInteractiveResult: vi.fn(),
    mockLaunch: vi.fn(),
    mockStartSubagentJob: vi.fn(),
  }));

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return { ...actual, launchInteractiveSubagent: mockLaunch };
});

vi.mock("../src/workflow-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/workflow-worker")>();
  return { ...actual, awaitInteractiveResult: mockAwaitInteractiveResult };
});

vi.mock("../src/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helpers")>();
  return { ...actual, startSubagentJob: mockStartSubagentJob };
});

import { pollArtifactChanges } from "../src/artifact-poller";
import { jobRegistry } from "../src/helpers";
import {
  buildAsyncSupervisorItems,
  directSupervisorItems,
} from "../src/interactive-supervisor-registration";
import type { AsyncSupervisorItem } from "../src/interactive-supervisor-ui";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import {
  advanceSessionScopeGeneration,
  clearSessionScopes,
  registerSessionScope,
  removeSessionScope,
  setLegacyActiveSessionRefs,
  type SessionScope,
} from "../src/session-scope";
import {
  MAX_WORKFLOW_JOBS,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { registerWorkflowTool } from "../src/workflow-tool";

const ACTIVITY_WIDGET_KEY = "subagentura-activity";
const RUNNING_FOOTER_KEY = "subagentura-running";

const tempDirs: string[] = [];
let releaseAgent!: (result: SubagentResult) => void;
let killPane: ReturnType<typeof vi.fn>;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "workflow-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function subagentResult(output: string): SubagentResult {
  return {
    isError: false,
    output,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
    },
    model: "test/model",
  };
}

function fakeUi() {
  return {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
}

/** Register a live session context the way `registerSessionHandlers` does. */
function liveSessionContext(options: {
  id: number;
  sessionId: string;
  ui?: ReturnType<typeof fakeUi>;
}): { context: SessionScope; ui: ReturnType<typeof fakeUi> } {
  const ui = options.ui ?? fakeUi();
  const context: SessionScope = {
    id: options.id,
    generation: 1,
    lifecycle: "started",
    pi: { sendMessage: vi.fn() } as never,
    ui: ui as never,
    sessionManager: {
      getSessionId: () => options.sessionId,
      getEntries: () => [],
    },
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map(),
  };
  registerSessionScope(context);
  setLegacyActiveSessionRefs(context);
  return { context, ui };
}

function ownerOf(context: SessionScope) {
  return { id: context.id, generation: context.generation };
}

/** [id, depth] pairs, the two things the grouped supervisor list is about. */
function rowShape(items: AsyncSupervisorItem[]): [string, number][] {
  return items.map((item) => [
    item.kind === "in-process" || item.kind === "workflow"
      ? item.job.id
      : item.state.id,
    item.depth,
  ]);
}

function lastWidgetRows(
  ui: ReturnType<typeof fakeUi>,
): string[] | undefined | "never-painted" {
  const calls = ui.setWidget.mock.calls.filter(
    ([key]) => key === ACTIVITY_WIDGET_KEY,
  );
  if (calls.length === 0) return "never-painted";
  return calls.at(-1)?.[1] as string[] | undefined;
}

function lastFooter(
  ui: ReturnType<typeof fakeUi>,
): string | undefined | "never-painted" {
  const calls = ui.setStatus.mock.calls.filter(
    ([key]) => key === RUNNING_FOOTER_KEY,
  );
  if (calls.length === 0) return "never-painted";
  return calls.at(-1)?.[1] as string | undefined;
}

function plainInteractiveState(
  id: string,
  parentSessionId: string,
): InteractiveSubagentState {
  return {
    id,
    name: id,
    task: "unrelated work",
    paneId: `%${id}`,
    mux: "tmux",
    sessionFile: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    parentSessionId,
    startedAt: Date.now(),
    status: "running",
    attachCommand: "attach",
    selectPaneCommand: "focus",
    launchScriptFile: `/tmp/${id}.sh`,
    artifactDir: tempDir(),
  };
}

function workflowTool(pi: { registerTool: ReturnType<typeof vi.fn> }): any {
  const tools: any[] = [];
  (pi.registerTool as any).mockImplementation((tool: any) => tools.push(tool));
  return () => tools.find((tool) => tool.name === "workflow");
}

function makePi() {
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  };
  const findTool = workflowTool(pi as never);
  return { pi, findTool };
}

const SINGLE_AGENT_SCRIPT = (name: string) =>
  `export const meta = { name: "${name}", description: "d" };\n` +
  'return await agent("inspect", { label: "reviewer" });';

beforeEach(() => {
  clearSessionScopes();
  setLegacyActiveSessionRefs(undefined);
  jobRegistry.clear();
  workflowJobRegistry.clear();
  interactiveSubagentRegistry.clear();
  killPane = vi.fn();
  __setTmuxMultiplexer({
    getPaneLiveness: vi.fn(() => "alive"),
    getPaneLivenessAsync: vi.fn(async () => "alive"),
    killPane,
  } as never);
  mockAwaitInteractiveResult.mockImplementation(
    () =>
      new Promise<SubagentResult>((resolve) => {
        releaseAgent = resolve;
      }),
  );
  mockStartSubagentJob.mockRejectedValue(
    new Error("unexpected in-process fallback"),
  );
  mockLaunch.mockImplementation((params) => {
    const state = {
      id: "workflow-child",
      name: params.name,
      task: params.task,
      paneId: "%42",
      mux: "tmux",
      sessionFile: "/tmp/workflow-child.jsonl",
      cwd: params.cwd,
      startedAt: Date.now(),
      status: "running",
      attachCommand: "attach",
      selectPaneCommand: "focus",
      launchScriptFile: "/tmp/workflow-child.sh",
      artifactDir: tempDir(),
      supervisorOwner: params.supervisorOwner,
      workflowId: params.workflowId,
      completionOwner: params.completionOwner,
    };
    interactiveSubagentRegistry.set(state.id, state as never);
    return state;
  });
});

afterEach(() => {
  interactiveSubagentRegistry.clear();
  workflowJobRegistry.clear();
  jobRegistry.clear();
  clearSessionScopes();
  setLegacyActiveSessionRefs(undefined);
  __resetMuxInstances();
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("workflow supervisor integration", () => {
  it("shows a live process child under its tracked sync workflow", async () => {
    const { context } = liveSessionContext({ id: 7, sessionId: "session-a" });
    const owner = ownerOf(context);
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, context);

    const execution = findTool().execute(
      "call-sync",
      { script: SINGLE_AGENT_SCRIPT("sync-visible"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );

    await vi.waitFor(() => expect(mockLaunch).toHaveBeenCalledOnce());
    const workflow = [...workflowJobRegistry.values()].find(
      (job) => job.name === "sync-visible",
    );
    expect(workflow).toBeDefined();
    expect(workflow?.executionMode).toBe("sync");
    expect(mockLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        background: true,
        completionOwner: "workflow",
        supervisorOwner: owner,
        workflowId: workflow?.id,
      }),
    );
    // Process workflow children persist their parent session identity so a
    // compatible restarted owner can adopt the pane safely.
    expect(mockLaunch.mock.calls[0]?.[0]?.parentSessionId).toBe("session-a");

    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );
    expect(rowShape(items)).toEqual([
      [workflow!.id, 0],
      ["workflow-child", 1],
    ]);

    releaseAgent(subagentResult("reviewed"));
    const result = await execution;

    expect(result.details.status).toBe("done");
    // Aggregating the result does not dispose the process pane. The registry keeps
    // the live state until artifact polling observes completion and transitions it
    // to idle, preserving the pane for inspection.
    expect(interactiveSubagentRegistry.has("workflow-child")).toBe(true);
    expect(
      (
        interactiveSubagentRegistry.get(
          "workflow-child",
        ) as InteractiveSubagentState & {
          workflowResultConsumed?: boolean;
        }
      ).workflowResultConsumed,
    ).toBe(true);
    expect(killPane).not.toHaveBeenCalled();
    // A sync workflow returned its result inline, so it must not linger where
    // get_workflow_result could re-serve it or the supervisor could show it.
    expect(workflowJobRegistry.has(workflow!.id)).toBe(false);
  });

  it("counts and lists a workflow child on the owning session's footer and widget", async () => {
    // The merge-defect guard. The base branch scoped both surfaces on
    // (ui identity + state.parentSessionId), a key workflow children structurally
    // cannot satisfy: a textually clean merge left them visible in the supervisor
    // but missing from the widget and undercounted in the footer.
    const a = liveSessionContext({ id: 7, sessionId: "session-a" });
    const b = liveSessionContext({ id: 8, sessionId: "session-b" });
    const ownerA = ownerOf(a.context);
    setLegacyActiveSessionRefs(a.context);

    // A sibling session's plain agent must NOT be counted or listed for A.
    const sibling = plainInteractiveState("sibling-agent", "session-b");
    interactiveSubagentRegistry.set(sibling.id, sibling);
    b.context.interactiveStates.set(sibling.id, sibling);

    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, a.context);
    const execution = findTool().execute(
      "call-widget",
      { script: SINGLE_AGENT_SCRIPT("widget-visible"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    await vi.waitFor(() => expect(mockLaunch).toHaveBeenCalledOnce());
    expect(a.context.interactiveStates.get("workflow-child")).toBe(
      interactiveSubagentRegistry.get("workflow-child"),
    );

    await pollArtifactChanges(a.context.pi, ownerA);

    const rows = lastWidgetRows(a.ui);
    expect(Array.isArray(rows) ? rows : rows).toHaveLength(1);
    // The activity row renders the child's display name ("reviewer" is the
    // workflow agent label passed through to launchInteractiveSubagent).
    expect((rows as string[]).join("\n")).toContain("reviewer");
    expect((rows as string[]).join("\n")).not.toContain("sibling-agent");
    expect(lastFooter(a.ui)).toBe("⚡ 1 sub-agent active");
    // B's surfaces are untouched by A's tick.
    expect(lastWidgetRows(b.ui)).toBe("never-painted");

    releaseAgent(subagentResult("reviewed"));
    await execution;
  });

  it("registers, settles, and deregisters an in-process fallback child", async () => {
    const { context } = liveSessionContext({ id: 7, sessionId: "session-a" });
    const owner = ownerOf(context);
    const start = vi.fn();
    let releaseChild!: (result: SubagentResult) => void;
    mockLaunch.mockImplementationOnce(() => {
      throw new Error("mux unavailable");
    });
    mockStartSubagentJob.mockResolvedValueOnce({
      jobId: "fallback-child",
      jobPromise: new Promise<SubagentResult>((resolve) => {
        releaseChild = resolve;
      }),
      liveStatus: { turn: 0, output: "", usage: {} },
      session: { abort: vi.fn() },
      modelLabel: "test/model",
      thinkingLevel: "medium",
      start,
    });
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, context);

    const execution = findTool().execute(
      "call-fallback",
      { script: SINGLE_AGENT_SCRIPT("fallback"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const childJob = jobRegistry.get("fallback-child");
    expect(childJob).toBeDefined();
    expect(childJob?.status).toBe("running");
    expect(childJob?.completionOwner).toBe("workflow");
    expect(childJob?.abort).toBeInstanceOf(AbortController);
    // Reachable by every owner-scoped sweep, including session_shutdown's drain.
    expect(childJob?.deliveryOwner).toMatchObject({
      sessionScopeId: owner.id,
      sessionScopeGeneration: owner.generation,
    });
    const workflow = [...workflowJobRegistry.values()].find(
      (job) => job.name === "fallback",
    );
    const items = buildAsyncSupervisorItems(
      directSupervisorItems(undefined, owner),
      owner,
    );
    expect(rowShape(items)).toEqual([
      [workflow!.id, 0],
      ["fallback-child", 1],
    ]);

    releaseChild(subagentResult("fallback complete"));
    const result = await execution;

    expect(result.details.status).toBe("done");
    expect(result.content[0]?.text).toContain("fallback complete");
    // Settlement wrote a terminal status, so the row is never actionable-forever,
    // never double-counted against its own workflow, and never picked up by
    // session_shutdown's "status === running" cancellation-record loop.
    expect(childJob?.status).toBe("done");
    expect(childJob?.result?.output).toBe("fallback complete");
    expect(jobRegistry.has("fallback-child")).toBe(false);
  });

  it("does not start an in-process child whose parent shut down mid-spawn", async () => {
    const { context } = liveSessionContext({ id: 7, sessionId: "session-a" });
    const start = vi.fn();
    const disposeBeforeStart = vi.fn();
    const sessionAbort = vi.fn();
    let releaseSpawn!: (prepared: unknown) => void;
    mockLaunch.mockImplementationOnce(() => {
      throw new Error("mux unavailable");
    });
    mockStartSubagentJob.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSpawn = resolve;
      }),
    );
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, context);

    const execution = findTool().execute(
      "call-escape",
      { script: SINGLE_AGENT_SCRIPT("escape"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    await vi.waitFor(() => expect(mockStartSubagentJob).toHaveBeenCalledOnce());

    // The parent session shuts down while startSubagentJob is still pending.
    advanceSessionScopeGeneration(context.id);
    removeSessionScope(context.id);
    releaseSpawn({
      jobId: "escaped-child",
      jobPromise: new Promise(() => {}),
      liveStatus: { turn: 0, output: "", usage: {} },
      session: { abort: sessionAbort },
      modelLabel: "test/model",
      start,
      disposeBeforeStart,
    });

    const result = await execution;

    expect(start).not.toHaveBeenCalled();
    expect(disposeBeforeStart).toHaveBeenCalledOnce();
    expect(sessionAbort).toHaveBeenCalledOnce();
    expect(jobRegistry.has("escaped-child")).toBe(false);
    expect(result.details.status).toBe("error");
  });

  it("leaves an unownable in-process child out of the registry", async () => {
    // With no session scope, the child cannot join an owner-scoped registry or
    // shutdown sweep, so it must remain unregistered.
    const start = vi.fn();
    let releaseChild!: (result: SubagentResult) => void;
    mockLaunch.mockImplementationOnce(() => {
      throw new Error("mux unavailable");
    });
    mockStartSubagentJob.mockResolvedValueOnce({
      jobId: "unowned-child",
      jobPromise: new Promise<SubagentResult>((resolve) => {
        releaseChild = resolve;
      }),
      liveStatus: { turn: 0, output: "", usage: {} },
      session: { abort: vi.fn() },
      modelLabel: "test/model",
      start,
    });
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never);

    const execution = findTool().execute(
      "call-unowned",
      { script: SINGLE_AGENT_SCRIPT("unowned"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    // Inspected while the child is live, which is the only window in which an
    // unreachable row would be observable.
    expect(jobRegistry.size).toBe(0);

    releaseChild(subagentResult("unowned complete"));
    const result = await execution;

    expect(result.details.status).toBe("done");
    expect(result.content[0]?.text).toContain("unowned complete");
    expect(jobRegistry.size).toBe(0);
  });

  it("retains a completed interactive child when the workflow later fails", async () => {
    const { context } = liveSessionContext({ id: 7, sessionId: "session-a" });
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, context);

    const execution = findTool().execute(
      "call-failure",
      {
        script:
          'export const meta = { name: "failing", description: "d" };\n' +
          'await agent("inspect", { label: "reviewer" });\n' +
          'throw new Error("script blew up");',
        async: false,
      },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    await vi.waitFor(() => expect(mockLaunch).toHaveBeenCalledOnce());
    expect(interactiveSubagentRegistry.has("workflow-child")).toBe(true);
    const workflow = [...workflowJobRegistry.values()].find(
      (job) => job.name === "failing",
    );
    expect(workflow).toBeDefined();

    releaseAgent(subagentResult("reviewed"));
    const result = await execution;

    expect(result.isError).toBe(true);
    // A later workflow-script error likewise does not dispose the child whose
    // successful result was already aggregated.
    expect(interactiveSubagentRegistry.has("workflow-child")).toBe(true);
    expect(killPane).not.toHaveBeenCalled();
    expect(workflowJobRegistry.has(workflow!.id)).toBe(false);
  });

  it("runs a sync workflow even when the async job cap is saturated", async () => {
    const { context } = liveSessionContext({ id: 7, sessionId: "session-a" });
    const owner = ownerOf(context);
    for (let index = 0; index < MAX_WORKFLOW_JOBS; index++) {
      const id = `saturating-${index}`;
      workflowJobRegistry.set(id, {
        id,
        kind: "script",
        name: id,
        status: "running",
        startedAt: Date.now(),
        promise: new Promise(() => {}),
        abort: new AbortController(),
        parentSessionOwner: owner,
        snapshot: {
          agentsSpawned: 0,
          errorCount: 0,
          tokensSpent: 0,
          phases: [],
        },
      } as unknown as WorkflowJobState);
    }
    const { pi, findTool } = makePi();
    registerWorkflowTool(pi as never, context);

    // The async path still refuses — the cap is what protects the registry.
    const refused = await findTool().execute(
      "call-async-capped",
      { script: SINGLE_AGENT_SCRIPT("async-capped") },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("workflow jobs already running");

    // The blocking sync path must not acquire a new failure mode from being
    // tracked: it always ran before, so it still runs now.
    const execution = findTool().execute(
      "call-sync-capped",
      { script: SINGLE_AGENT_SCRIPT("sync-capped"), async: false },
      undefined,
      vi.fn(),
      { cwd: "/tmp", modelRegistry: {} },
    );
    await vi.waitFor(() => expect(mockLaunch).toHaveBeenCalledOnce());
    releaseAgent(subagentResult("reviewed"));
    const result = await execution;

    expect(result.details.status).toBe("done");
    expect(
      [...workflowJobRegistry.values()].some(
        (job) => job.name === "sync-capped",
      ),
    ).toBe(false);
  });
});
