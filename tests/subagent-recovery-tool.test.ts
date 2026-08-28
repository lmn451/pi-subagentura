import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  clearSessionScopes,
  registerSessionScope,
  type SessionScope,
} from "../src/session-scope";

const { inspectRecovery, recoverChild } = vi.hoisted(() => ({
  inspectRecovery: vi.fn(),
  recoverChild: vi.fn(),
}));

vi.mock("../src/interactive-recovery", () => ({
  inspectDirectInteractiveRecovery: inspectRecovery,
  recoverDirectInteractiveSubagent: recoverChild,
}));

import { registerInteractiveSubagentTools } from "../src/tools/interactive";

const CHILD_ID = "a1b2c3d4e5f60718";
const plan = {
  childId: CHILD_ID,
  piSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  parentSessionId: "11111111-2222-4333-8444-555555555555",
  oldPaneId: "%dead",
  sessionFile: "/sessions/child.jsonl",
  artifactDir: "/sessions/artifacts/a1b2c3d4e5f60718",
  childCwd: "/worktree",
  mux: "tmux" as const,
  lineageRootId: "11111111-2222-4333-8444-555555555555",
  fingerprint: "fingerprint",
};

function state(): InteractiveSubagentState {
  return {
    id: CHILD_ID,
    name: "recoverable",
    task: "continue",
    paneId: "%dead",
    mux: "tmux",
    sessionFile: plan.sessionFile,
    cwd: "/project",
    parentSessionId: plan.parentSessionId,
    sessionOwner: { id: 7, generation: 1 },
    startedAt: 1,
    status: "exited",
    attachCommand: "old attach",
    selectPaneCommand: "old focus",
    launchScriptFile: "/old-launch.sh",
    artifactDir: plan.artifactDir,
  };
}

function setup() {
  const child = state();
  const scope: SessionScope = {
    id: 7,
    generation: 1,
    lifecycle: "started",
    pi: {} as never,
    parentStreaming: false,
    inProcessJobs: new Map(),
    pendingInProcessDeliveries: [],
    interactiveStates: new Map([[child.id, child]]),
  };
  registerSessionScope(scope);
  const tools: any[] = [];
  const pi = {
    registerTool: vi.fn((tool) => tools.push(tool)),
  };
  registerInteractiveSubagentTools(pi as never, scope);
  return {
    child,
    scope,
    tool: tools.find((tool) => tool.name === "recover_interactive_subagent"),
  };
}

beforeEach(() => {
  clearSessionScopes();
  vi.clearAllMocks();
  inspectRecovery.mockResolvedValue(plan);
});

afterEach(() => {
  clearSessionScopes();
});

describe("recover_interactive_subagent tool", () => {
  it("requires native user confirmation before recovery", async () => {
    const { child, tool } = setup();
    const confirm = vi.fn(async () => false);

    const result = await tool.execute(
      "call",
      { id: CHILD_ID },
      undefined,
      undefined,
      { cwd: "/project", ui: { confirm, setStatus: vi.fn() } },
    );

    expect(confirm).toHaveBeenCalledWith(
      "Recover dead interactive sub-agent?",
      expect.stringContaining(`Pi session ID: ${plan.piSessionId}`),
    );
    expect(result.details.status).toBe("confirmation_declined");
    expect(recoverChild).not.toHaveBeenCalled();
    expect(child.paneId).toBe("%dead");
  });

  it("recovers only after confirmation using the inspected fingerprint", async () => {
    const { child, scope, tool } = setup();
    const recovered = {
      ...child,
      paneId: "%new",
      muxSession: "mux-session",
      attachCommand: "new attach",
      selectPaneCommand: "new focus",
      status: "idle" as const,
    };
    recoverChild.mockResolvedValue(recovered);

    const result = await tool.execute(
      "call",
      { id: CHILD_ID },
      undefined,
      undefined,
      {
        cwd: "/project",
        ui: { confirm: vi.fn(async () => true), setStatus: vi.fn() },
      },
    );

    expect(recoverChild).toHaveBeenCalledWith({
      state: child,
      scope,
      parentCwd: "/project",
      expectedFingerprint: plan.fingerprint,
    });
    expect(result.details).toMatchObject({
      status: "recovered",
      id: CHILD_ID,
      paneId: "%new",
      piSessionId: plan.piSessionId,
    });
  });
});
