import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Schema from "typebox/schema";

const { mockLaunchInteractiveSubagent, mockSendCommandToPane } = vi.hoisted(
  () => ({
    mockLaunchInteractiveSubagent: vi.fn(),
    mockSendCommandToPane: vi.fn(),
  }),
);

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    launchInteractiveSubagent: mockLaunchInteractiveSubagent,
    sendCommandToPane: mockSendCommandToPane,
  };
});

import registerExtension from "../src/subagent";
import {
  appendCompletionEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import { pollArtifactChanges } from "../src/artifact-poller";
import {
  interactiveSubagentRegistry,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import {
  MAX_ORCHESTRATOR_ROUTING_RECORDS,
  listOrchestratorRoutingEntries,
  orchestratorRoutingFilePath,
  saveOrchestratorRoutingEntries,
  upsertOrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import { InteractiveParams } from "../src/schemas";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";

const CHILD_A = "0123456789abcdef";
const CHILD_B = "fedcba9876543210";
const CHILD_C = "1111111111111111";
const savedChildMode = process.env.PI_SUBAGENTURA_CHILD;
const roots: string[] = [];
let launchIds: string[] = [];

interface ScenarioEnvironment {
  api: ReturnType<typeof mockApi>;
  ctx: ReturnType<typeof mockContext>;
  root: string;
  scope: SessionScope;
}

function mockApi(orchestratorv2 = false) {
  return {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn(
      (name: string) => orchestratorv2 && name === "orchestratorv2",
    ),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  };
}

function mockContext(root: string, branch: unknown[] = []) {
  return {
    cwd: root,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn().mockReturnValue(branch),
      getEntries: vi.fn().mockReturnValue([]),
      getSessionId: vi.fn().mockReturnValue("orchestrator-parent"),
    },
  };
}

function registeredTool(api: ReturnType<typeof mockApi>, name: string): any {
  return api.registerTool.mock.calls.find(([definition]) => {
    return definition.name === name;
  })?.[0];
}

function setupScenario(orchestratorv2 = false): ScenarioEnvironment {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-scenarios-"));
  roots.push(root);
  const api = mockApi(orchestratorv2);
  const ctx = mockContext(root);
  registerExtension(api as never);
  const scope = getSessionScopes().find(
    (candidate) => candidate.pi === (api as unknown as typeof candidate.pi),
  );
  if (!scope) throw new Error("extension did not register a session scope");
  scope.lifecycle = "started";
  scope.ui = ctx.ui as never;
  scope.sessionManager = ctx.sessionManager;
  return { api, ctx, root, scope };
}

function makeRuntimeState(
  id: string,
  params: any,
  scope: SessionScope,
): InteractiveSubagentState {
  return {
    id,
    name: params.name,
    task: params.task,
    paneId: `%${id.slice(0, 4)}`,
    mux: "tmux",
    sessionFile: join(params.parentCwd, "sessions", `${id}.jsonl`),
    cwd: params.cwd,
    parentSessionId: params.parentSessionId,
    sessionOwner: sessionOwner(scope),
    startedAt: Date.now(),
    status: "running",
    attachCommand: `tmux attach-session -t orchestrator-${id}`,
    selectPaneCommand: `tmux select-pane -t %${id.slice(0, 4)}`,
    launchScriptFile: join(params.parentCwd, "launch", `${id}.sh`),
    artifactDir: join(params.parentCwd, ".artifacts", id),
    notifyOnComplete: params.notifyOnComplete,
    triggerTurnOnComplete: params.triggerTurnOnComplete,
  };
}

async function executeTool(
  definition: any,
  params: Record<string, unknown>,
  ctx: ReturnType<typeof mockContext>,
) {
  return definition.execute(
    `scenario-${definition.name}`,
    params,
    undefined,
    undefined,
    ctx,
  );
}

async function spawnAgentsAB(environment: ScenarioEnvironment): Promise<void> {
  const spawn = registeredTool(environment.api, "subagent_interactive");
  await executeTool(
    spawn,
    {
      name: "Agent A",
      task: "Own the API migration",
      routingDescription: "Own API migration and compatibility",
      routingAliases: ["api", "migration"],
    },
    environment.ctx,
  );
  await executeTool(
    spawn,
    {
      name: "Agent B",
      task: "Own release verification",
      routingDescription: "Own release verification and packaging",
      routingAliases: ["release", "packaging"],
    },
    environment.ctx,
  );
}

beforeEach(() => {
  delete process.env.PI_SUBAGENTURA_CHILD;
  clearSessionScopes();
  interactiveSubagentRegistry.clear();
  vi.clearAllMocks();
  launchIds = [CHILD_A, CHILD_B, CHILD_C];
  __setTmuxMultiplexer({
    getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
  } as never);
  mockSendCommandToPane.mockReturnValue(undefined);
  mockLaunchInteractiveSubagent.mockImplementation((params: any) => {
    const id = launchIds.shift();
    if (!id) throw new Error("scenario did not reserve a child id");
    const scope = params.sessionScope as SessionScope | undefined;
    if (!scope) throw new Error("spawn did not receive its session scope");
    const state = makeRuntimeState(id, params, scope);
    scope.interactiveStates.set(id, state);
    return state;
  });
});

afterEach(() => {
  clearSessionScopes();
  interactiveSubagentRegistry.clear();
  __resetMuxInstances();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (savedChildMode === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
  else process.env.PI_SUBAGENTURA_CHILD = savedChildMode;
});

describe("Orchestratorv2 thin-router scenarios", () => {
  it("spawns broad-request children A and B through the existing interactive path with explicit routing metadata", async () => {
    const environment = setupScenario();

    await spawnAgentsAB(environment);

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2);
    expect(mockLaunchInteractiveSubagent.mock.calls[0][0]).toMatchObject({
      name: "Agent A",
      task: "Own the API migration",
      sessionScope: environment.scope,
    });
    expect(mockLaunchInteractiveSubagent.mock.calls[1][0]).toMatchObject({
      name: "Agent B",
      task: "Own release verification",
      sessionScope: environment.scope,
    });
    expect(listOrchestratorRoutingEntries(environment.root)).toEqual([
      expect.objectContaining({
        childId: CHILD_A,
        description: "Own API migration and compatibility",
        aliases: ["api", "migration"],
        updatedAt: expect.any(String),
      }),
      expect.objectContaining({
        childId: CHILD_B,
        description: "Own release verification and packaging",
        aliases: ["release", "packaging"],
        updatedAt: expect.any(String),
      }),
    ]);
    expect([...environment.scope.interactiveStates.keys()]).toEqual([
      CHILD_A,
      CHILD_B,
    ]);
  });

  it("recovers a full routing overlay through confirmed removal and update", async () => {
    const environment = setupScenario(true);
    const historical = Array.from(
      { length: MAX_ORCHESTRATOR_ROUTING_RECORDS },
      (_, index) => ({
        childId: index.toString(16).padStart(16, "0"),
        description: `Historical responsibility ${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );
    saveOrchestratorRoutingEntries(environment.root, historical);
    const routingFile = orchestratorRoutingFilePath(environment.root);
    const beforeSpawn = readFileSync(routingFile, "utf8");
    const spawn = registeredTool(environment.api, "subagent_interactive");

    const spawned = await executeTool(
      spawn,
      {
        name: "Capacity recovery child",
        task: "Own work after routing capacity is exhausted",
        routingDescription: "Own post-capacity work",
        routingAliases: ["capacity-recovery"],
      },
      environment.ctx,
    );

    expect(spawned.isError).not.toBe(true);
    expect(spawned.details.routingMetadata).toMatchObject({
      status: "warning",
      error: expect.stringContaining("routing record count exceeds"),
    });
    expect(readFileSync(routingFile, "utf8")).toBe(beforeSpawn);
    expect(environment.scope.interactiveStates.has(CHILD_A)).toBe(true);

    const remove = registeredTool(
      environment.api,
      "remove_orchestrator_agent_description",
    );
    const removed = await executeTool(
      remove,
      { childId: historical[0].childId, confirmed: true },
      environment.ctx,
    );
    expect(removed.details.status).toBe("removed");

    const update = registeredTool(
      environment.api,
      "update_orchestrator_agent_description",
    );
    const updated = await executeTool(
      update,
      {
        childId: CHILD_A,
        description: "Own post-capacity work",
        aliases: ["capacity-recovery"],
        confirmed: true,
      },
      environment.ctx,
    );

    expect(updated.details.status).toBe("updated");
    const entries = listOrchestratorRoutingEntries(environment.root);
    expect(entries).toHaveLength(MAX_ORCHESTRATOR_ROUTING_RECORDS);
    expect(entries).toContainEqual(
      expect.objectContaining({
        childId: CHILD_A,
        description: "Own post-capacity work",
        aliases: ["capacity-recovery"],
      }),
    );
    expect(entries).not.toContainEqual(historical[0]);
  });

  it("lists A and B with current pointers and delegates to the selected child without creating a new one", async () => {
    const environment = setupScenario();
    await spawnAgentsAB(environment);
    const list = registeredTool(environment.api, "list_orchestrator_agents");
    const send = registeredTool(
      environment.api,
      "send_interactive_subagent_message",
    );

    const listed = await executeTool(list, {}, environment.ctx);
    const delegated = await executeTool(
      send,
      {
        id: CHILD_B,
        message: "Verify the release tarball against the agreed checklist",
      },
      environment.ctx,
    );

    expect(listed.details.agents).toEqual([
      expect.objectContaining({
        childId: CHILD_A,
        description: "Own API migration and compatibility",
        aliases: ["api", "migration"],
        actionable: true,
        attachCommand: `tmux attach-session -t orchestrator-${CHILD_A}`,
        focusCommand: "tmux select-pane -t %0123",
      }),
      expect.objectContaining({
        childId: CHILD_B,
        description: "Own release verification and packaging",
        aliases: ["release", "packaging"],
        actionable: true,
        attachCommand: `tmux attach-session -t orchestrator-${CHILD_B}`,
        focusCommand: "tmux select-pane -t %fedc",
      }),
    ]);
    expect(mockSendCommandToPane).toHaveBeenCalledWith(
      expect.objectContaining({ id: CHILD_B, paneId: "%fedc" }),
      expect.stringMatching(
        /^Verify the release tarball.*MANDATORY COMPLETION PROTOCOL/s,
      ),
    );
    expect(delegated.details).toMatchObject({ id: CHILD_B, status: "sent" });
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2);
  });

  it("represents ambiguity through the v2 prompt and available list without a semantic resolver or model-backed claim", async () => {
    const environment = setupScenario(true);
    await spawnAgentsAB(environment);
    const list = registeredTool(environment.api, "list_orchestrator_agents");
    const listed = await executeTool(list, {}, environment.ctx);
    const beforeAgentStart = environment.api.on.mock.calls.find(
      ([event]) => event === "before_agent_start",
    )?.[1];
    const promptResult = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      {},
    );
    const toolNames = environment.api.registerTool.mock.calls.map(
      ([definition]) => definition.name,
    );

    expect(listed.details.agents.map((agent: any) => agent.childId)).toEqual([
      CHILD_A,
      CHILD_B,
    ]);
    expect(promptResult.systemPrompt).toContain(
      "If multiple children plausibly match, or the intended action is unclear, ask the user",
    );
    expect(promptResult.systemPrompt).toContain(
      "instead of silently selecting, spawning, or fanning out",
    );
    expect(toolNames).not.toContain("resolve_orchestrator_route");
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2);
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
  });

  it("delivers an important completion through the existing pointer-only artifact path without auto-spawn", async () => {
    const environment = setupScenario();
    const spawn = registeredTool(environment.api, "subagent_interactive");
    await executeTool(
      spawn,
      {
        name: "Agent A",
        task: "Inspect the API migration",
        routingDescription: "Own API migration and compatibility",
        routingAliases: ["api"],
        notifyOnComplete: "notify",
      },
      environment.ctx,
    );
    const state = environment.scope.interactiveStates.get(CHILD_A)!;
    state.parentSessionId = undefined;
    state.eventByteCursor = 0;
    const art = artifactPath(join(environment.root, ".artifacts"), CHILD_A);
    writeOutput(art, "PRIVATE CHILD OUTPUT THAT MUST REMAIN POINTER-ONLY");
    appendCompletionEvent(art, {
      turnId: "turn-important-concern",
      outcome: "done",
      source: "agent_end",
      eventId: "completion-important-concern",
      message:
        "Additional concern: review downstream compatibility separately.",
    });

    await pollArtifactChanges(
      environment.api as never,
      sessionOwner(environment.scope),
    );

    expect(environment.api.sendMessage).toHaveBeenCalledOnce();
    const [message, options] = environment.api.sendMessage.mock.calls[0];
    expect(message.details).toMatchObject({ mode: "notify", status: "done" });
    expect(message.content).toContain(
      "Additional concern: review downstream compatibility separately.",
    );
    expect(message.content).toContain("Output:");
    expect(message.content).toContain("Activity log:");
    expect(message.content).not.toContain(
      "PRIVATE CHILD OUTPUT THAT MUST REMAIN POINTER-ONLY",
    );
    expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(1);
    expect(environment.scope.interactiveStates.size).toBe(1);
  });

  it("uses the existing spawn tool for a user-approved separate investigation while A and B remain represented", async () => {
    const environment = setupScenario();
    await spawnAgentsAB(environment);
    const originalA = environment.scope.interactiveStates.get(CHILD_A);
    const originalB = environment.scope.interactiveStates.get(CHILD_B);
    const spawn = registeredTool(environment.api, "subagent_interactive");

    await executeTool(
      spawn,
      {
        name: "Agent C",
        task: "Investigate the approved downstream compatibility concern",
        routingDescription: "Own the separate downstream compatibility review",
        routingAliases: ["compatibility", "downstream"],
      },
      environment.ctx,
    );
    const listed = await executeTool(
      registeredTool(environment.api, "list_orchestrator_agents"),
      {},
      environment.ctx,
    );

    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(3);
    expect(environment.scope.interactiveStates.get(CHILD_A)).toBe(originalA);
    expect(environment.scope.interactiveStates.get(CHILD_B)).toBe(originalB);
    expect(listed.details.agents).toEqual([
      expect.objectContaining({ childId: CHILD_A, stale: false }),
      expect.objectContaining({ childId: CHILD_C, stale: false }),
      expect.objectContaining({ childId: CHILD_B, stale: false }),
    ]);
  });

  it("exposes the selected direct-work attach and focus commands without sending a follow-up", async () => {
    const environment = setupScenario(true);
    await spawnAgentsAB(environment);
    const listed = await executeTool(
      registeredTool(environment.api, "list_orchestrator_agents"),
      {},
      environment.ctx,
    );
    const selected = listed.details.agents.find(
      (agent: any) => agent.childId === CHILD_A,
    );
    const beforeAgentStart = environment.api.on.mock.calls.find(
      ([event]) => event === "before_agent_start",
    )?.[1];
    const promptResult = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      {},
    );

    expect(selected).toMatchObject({
      childId: CHILD_A,
      actionable: true,
      attachCommand: `tmux attach-session -t orchestrator-${CHILD_A}`,
      focusCommand: "tmux select-pane -t %0123",
    });
    expect(promptResult.systemPrompt).toContain(
      "For direct work, return the selected child's attach or focus command to the user",
    );
    expect(mockSendCommandToPane).not.toHaveBeenCalled();
    expect(mockLaunchInteractiveSubagent).toHaveBeenCalledTimes(2);
  });

  it("keeps persisted metadata with a missing runtime stale, unknown, non-actionable, and unreplaced", async () => {
    const environment = setupScenario(true);
    upsertOrchestratorRoutingEntry(environment.root, {
      childId: CHILD_C,
      description: "Own a previously approved investigation",
      aliases: ["previous-investigation"],
      provenance: "user",
    });
    const list = registeredTool(environment.api, "list_orchestrator_agents");

    const listed = await executeTool(list, {}, environment.ctx);

    expect(listed.details.agents).toEqual([
      expect.objectContaining({
        childId: CHILD_C,
        description: "Own a previously approved investigation",
        aliases: ["previous-investigation"],
        provenance: "user",
        updatedAt: expect.any(String),
        status: "unknown",
        liveness: "unknown",
        stale: true,
        actionable: false,
        reason: "runtime_missing",
      }),
    ]);
    expect(listed.details.agents[0]).not.toHaveProperty("attachCommand");
    expect(listed.details.agents[0]).not.toHaveProperty("focusCommand");
    expect(listOrchestratorRoutingEntries(environment.root)).toHaveLength(1);
    expect(environment.scope.interactiveStates.size).toBe(0);
    expect(mockLaunchInteractiveSubagent).not.toHaveBeenCalled();

    const beforeAgentStart = environment.api.on.mock.calls.find(
      ([event]) => event === "before_agent_start",
    )?.[1];
    const promptResult = await beforeAgentStart(
      { systemPrompt: "base prompt" },
      {},
    );
    expect(promptResult.systemPrompt).toContain(
      "An exact or continuation match is not routable",
    );
    expect(promptResult.systemPrompt).toContain("`stale: true`");
    expect(promptResult.systemPrompt).toContain("`actionable: false`");
    expect(promptResult.systemPrompt).toContain(
      "runtime is missing or unknown",
    );
    expect(promptResult.systemPrompt).toContain("liveness is dead or unknown");
    expect(promptResult.systemPrompt).toContain(
      "never auto-delegate, replace, or respawn it",
    );
  });

  it("exercises the registered context schema for legacy, parent-branch, and explicit-context spawns", async () => {
    const environment = setupScenario();
    const spawn = registeredTool(environment.api, "subagent_interactive");
    const compiled = Schema.Compile(spawn.parameters);
    const legacyParams = { task: "Independent legacy task" };
    const parentParams = {
      task: "Parent branch task",
      includeContext: true as const,
    };
    const explicitParams = {
      task: "Explicit context task",
      includeContext: false as const,
      context: "EXPLICIT-HANDOFF-CONTEXT",
    };

    expect(spawn.parameters).toBe(InteractiveParams);
    expect(compiled.Check(legacyParams)).toBe(true);
    expect(compiled.Check(parentParams)).toBe(true);
    expect(compiled.Check(explicitParams)).toBe(true);

    const legacyCtx = mockContext(environment.root, [
      {
        type: "message",
        message: { role: "user", content: "LEGACY-MUST-NOT-READ-BRANCH" },
      },
    ]);
    const parentCtx = mockContext(environment.root, [
      {
        type: "message",
        message: { role: "user", content: "PARENT-BRANCH-CONTEXT" },
      },
    ]);
    const explicitCtx = mockContext(environment.root, [
      {
        type: "message",
        message: { role: "user", content: "EXPLICIT-MUST-NOT-READ-BRANCH" },
      },
    ]);

    await executeTool(spawn, legacyParams, legacyCtx);
    await executeTool(spawn, parentParams, parentCtx);
    await executeTool(spawn, explicitParams, explicitCtx);

    expect(legacyCtx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(parentCtx.sessionManager.getBranch).toHaveBeenCalledOnce();
    expect(explicitCtx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(
      mockLaunchInteractiveSubagent.mock.calls[0][0].contextText,
    ).toBeNull();
    expect(
      mockLaunchInteractiveSubagent.mock.calls[1][0].contextText,
    ).toContain("PARENT-BRANCH-CONTEXT");
    expect(mockLaunchInteractiveSubagent.mock.calls[2][0].contextText).toBe(
      "EXPLICIT-HANDOFF-CONTEXT",
    );
  });
});
