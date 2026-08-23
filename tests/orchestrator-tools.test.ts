import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Schema from "typebox/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS,
  MAX_ORCHESTRATOR_TASK_PREVIEW_BYTES,
  buildOrchestratorAgentProjection,
  listOrchestratorRoutingEntries,
  saveOrchestratorRoutingEntries,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import * as orchestratorRouting from "../src/orchestrator-routing";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { registerOrchestratorTools } from "../src/tools/orchestrator";
import {
  ORCHESTRATOR_V2_WAKE_DETAIL_KEY,
  orchestratorV2WakeupMessage,
} from "../src/completion-turn";

const CHILD_A = "0123456789abcdef";
const CHILD_B = "fedcba9876543210";
const CHILD_C = "1111111111111111";

function routingEntry(
  childId: string,
  overrides: Partial<OrchestratorRoutingEntry> = {},
): OrchestratorRoutingEntry {
  return {
    childId,
    description: `Own responsibility for ${childId}`,
    aliases: [`alias-${childId.slice(0, 4)}`],
    provenance: "user",
    updatedAt: "2026-08-20T14:49:08.446Z",
    ...overrides,
  };
}

function runtimeState(
  childId: string,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  return {
    id: childId,
    name: `agent-${childId}`,
    task: `Inspect ${childId}`,
    paneId: `%${childId}`,
    mux: "tmux",
    sessionFile: `/sessions/${childId}.jsonl`,
    cwd: "/repo",
    startedAt: 1,
    status: "running",
    attachCommand: `tmux attach -t ${childId}`,
    selectPaneCommand: `tmux select-pane -t %${childId}`,
    launchScriptFile: `/artifacts/${childId}/launch.sh`,
    artifactDir: `/artifacts/${childId}`,
    ...overrides,
  };
}

function mockApi() {
  return { registerTool: vi.fn() };
}

function startedScope(
  pi: ReturnType<typeof mockApi>,
  id: number,
  sessionId: string,
): SessionScope {
  return registerSessionScope({
    id,
    generation: 0,
    lifecycle: "started",
    pi: pi as never,
    sessionManager: { getSessionId: () => sessionId },
  });
}

function registerState(
  scope: SessionScope,
  childId: string,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  const state = runtimeState(childId, {
    sessionOwner: sessionOwner(scope),
    parentSessionId: scope.sessionManager?.getSessionId?.(),
    ...overrides,
  });
  scope.interactiveStates.set(childId, state);
  return state;
}

function tool(api: ReturnType<typeof mockApi>, name: string): any {
  return api.registerTool.mock.calls.find(([definition]) => {
    return definition.name === name;
  })?.[0];
}

function toolContext(root: string, userId?: string, userText?: string) {
  const branch =
    userId && userText !== undefined
      ? [
          {
            id: userId,
            type: "message",
            message: { role: "user", content: userText },
          },
        ]
      : [];
  return {
    cwd: root,
    sessionManager: { getBranch: () => branch },
  };
}

describe("Orchestratorv2 compact agent projection", () => {
  beforeEach(() => {
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
    } as never);
  });

  afterEach(() => {
    __resetMuxInstances();
  });

  it("joins routing metadata to bounded runtime pointers without child output", async () => {
    const secret = "SECRET_CHILD_TRANSCRIPT_OUTPUT";
    const state = runtimeState(CHILD_A, {
      name: "API owner",
      task: `  Review\n the API   ${"x".repeat(600)} ${secret}`,
      lastStopText: secret,
      lastToolSummary: secret,
    });

    const projection = await buildOrchestratorAgentProjection(
      [routingEntry(CHILD_A)],
      new Map([[CHILD_A, state]]),
    );

    expect(projection).toMatchObject({ total: 1, omitted: 0 });
    expect(projection.agents[0]).toEqual({
      childId: CHILD_A,
      name: "API owner",
      description: `Own responsibility for ${CHILD_A}`,
      aliases: ["alias-0123"],
      provenance: "user",
      updatedAt: "2026-08-20T14:49:08.446Z",
      taskPreview: expect.stringMatching(/^Review the API x+…$/),
      status: "running",
      liveness: "alive",
      stale: false,
      attachable: true,
      actionable: true,
      attachCommand: `tmux attach -t ${CHILD_A}`,
      focusCommand: `tmux select-pane -t %${CHILD_A}`,
      artifactDir: `/artifacts/${CHILD_A}`,
      sessionFile: `/sessions/${CHILD_A}.jsonl`,
    });
    expect(
      Buffer.byteLength(projection.agents[0].taskPreview ?? "", "utf8"),
    ).toBeLessThanOrEqual(MAX_ORCHESTRATOR_TASK_PREVIEW_BYTES);
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(JSON.stringify(projection)).not.toContain("paneId");
  });

  it("keeps persisted metadata with no current runtime stale and non-actionable", async () => {
    const projection = await buildOrchestratorAgentProjection(
      [routingEntry(CHILD_A)],
      new Map(),
    );

    expect(projection.agents).toEqual([
      {
        childId: CHILD_A,
        description: `Own responsibility for ${CHILD_A}`,
        aliases: ["alias-0123"],
        provenance: "user",
        updatedAt: "2026-08-20T14:49:08.446Z",
        status: "unknown",
        liveness: "unknown",
        stale: true,
        attachable: false,
        actionable: false,
        reason: "runtime_missing",
      },
    ]);
  });

  it("keeps unknown pane liveness non-actionable", async () => {
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockResolvedValue("unknown"),
    } as never);
    const state = runtimeState(CHILD_B, { status: "idle" });

    const projection = await buildOrchestratorAgentProjection(
      [],
      new Map([[CHILD_B, state]]),
    );

    expect(projection.agents).toEqual([
      {
        childId: CHILD_B,
        name: `agent-${CHILD_B}`,
        taskPreview: `Inspect ${CHILD_B}`,
        status: "idle",
        liveness: "unknown",
        stale: false,
        attachable: false,
        actionable: false,
        reason: "pane_liveness_unknown",
        artifactDir: `/artifacts/${CHILD_B}`,
        sessionFile: `/sessions/${CHILD_B}.jsonl`,
      },
    ]);
  });

  it("keeps unknown runtime status non-actionable", async () => {
    const state = runtimeState(CHILD_B, { status: "unknown" });

    const projection = await buildOrchestratorAgentProjection(
      [],
      new Map([[CHILD_B, state]]),
    );

    expect(projection.agents[0]).toMatchObject({
      childId: CHILD_B,
      status: "unknown",
      liveness: "alive",
      actionable: false,
      reason: "runtime_status_unknown",
    });
    expect(projection.agents[0]).not.toHaveProperty("attachCommand");
    expect(projection.agents[0]).not.toHaveProperty("focusCommand");
  });

  it("keeps workflow-owned runtimes non-actionable until their result is consumed and idle", async () => {
    for (const overrides of [
      {
        status: "running" as const,
        workflowResultConsumed: true,
      },
      {
        status: "idle" as const,
        workflowResultConsumed: false,
      },
    ]) {
      const state = runtimeState(CHILD_B, {
        completionOwner: "workflow",
        ...overrides,
      });
      const projection = await buildOrchestratorAgentProjection(
        [],
        new Map([[CHILD_B, state]]),
      );

      expect(projection.agents[0]).toMatchObject({
        childId: CHILD_B,
        actionable: false,
        reason: "workflow_owned",
      });
      expect(projection.agents[0]).not.toHaveProperty("attachCommand");
      expect(projection.agents[0]).not.toHaveProperty("focusCommand");
    }

    const released = runtimeState(CHILD_B, {
      status: "idle",
      completionOwner: "workflow",
      workflowResultConsumed: true,
    });
    const projection = await buildOrchestratorAgentProjection(
      [],
      new Map([[CHILD_B, released]]),
    );

    expect(projection.agents[0]).toMatchObject({
      childId: CHILD_B,
      attachable: true,
      actionable: false,
      reason: "routing_metadata_missing",
      attachCommand: `tmux attach -t ${CHILD_B}`,
      focusCommand: `tmux select-pane -t %${CHILD_B}`,
    });
  });

  it("bounds the projection while prioritizing current runtimes over stale metadata", async () => {
    const states = new Map<string, InteractiveSubagentState>();
    for (let index = 0; index <= MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS; index++) {
      const childId = index.toString(16).padStart(16, "0");
      states.set(childId, runtimeState(childId));
    }
    const persisted = routingEntry("ffffffffffffffff");

    const projection = await buildOrchestratorAgentProjection(
      [persisted],
      states,
    );

    expect(projection.total).toBe(MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS + 2);
    expect(projection.agents).toHaveLength(MAX_ORCHESTRATOR_AGENT_VIEW_ITEMS);
    expect(projection.omitted).toBe(2);
    expect(
      projection.agents.some((agent) => agent.childId === persisted.childId),
    ).toBe(false);
    expect(projection.agents.every((agent) => agent.stale === false)).toBe(
      true,
    );
  });
});

describe("Orchestratorv2 metadata tools", () => {
  let root: string;

  beforeEach(() => {
    clearSessionScopes();
    root = mkdtempSync(join(tmpdir(), "orchestrator-tools-"));
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    clearSessionScopes();
    __resetMuxInstances();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers exactly list and token-confirmed update with required provenance", () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");

    registerOrchestratorTools(api as never, scope);

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(
      api.registerTool.mock.calls.map(([definition]) => definition.name).sort(),
    ).toEqual(
      [
        "list_orchestrator_agents",
        "update_orchestrator_agent_description",
      ].sort(),
    );
    const update = tool(api, "update_orchestrator_agent_description");
    expect(update).toBeDefined();
    expect(update.parameters.properties.confirmed.type).toBe("boolean");
    expect(update.parameters.properties.confirmationToken).toBeDefined();
    expect(update.parameters.required).toEqual(
      expect.arrayContaining([
        "childId",
        "description",
        "provenance",
        "confirmed",
      ]),
    );

    const compiled = Schema.Compile(update.parameters);
    const common = {
      childId: CHILD_A,
      description: "Own the API",
      confirmed: true as const,
    };
    expect(compiled.Check({ ...common, provenance: "user" })).toBe(true);
    expect(compiled.Check({ ...common, provenance: "orchestratorv2" })).toBe(
      true,
    );
    expect(compiled.Check(common)).toBe(false);
  });

  it("accepts exactly the safe legacy and current child ID lengths", () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");

    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const compiled = Schema.Compile(update.parameters);
    const common = {
      description: "Own the API",
      provenance: "user" as const,
      confirmed: true as const,
    };

    expect(compiled.Check({ ...common, childId: "01234567" })).toBe(true);
    expect(compiled.Check({ ...common, childId: CHILD_A })).toBe(true);
    expect(compiled.Check({ ...common, childId: "0123456789abcde" })).toBe(
      false,
    );
    expect(compiled.Check({ ...common, childId: "0123456789abcdef0" })).toBe(
      false,
    );
    expect(compiled.Check({ ...common, childId: "0123456A" })).toBe(false);
  });

  it("lists only current-scope runtime fields while retaining foreign metadata as stale", async () => {
    upsertOrchestratorRoutingEntry(root, routingEntry(CHILD_A));
    upsertOrchestratorRoutingEntry(root, routingEntry(CHILD_B));
    const apiA = mockApi();
    const apiB = mockApi();
    const scopeA = startedScope(apiA, 1, "parent-a");
    const scopeB = startedScope(apiB, 2, "parent-b");
    registerState(scopeA, CHILD_A, { name: "parent-a-agent" });
    registerState(scopeB, CHILD_B, {
      name: "PRIVATE-parent-b-agent",
      task: "PRIVATE parent B task",
    });
    registerState(scopeB, CHILD_C, {
      name: "PRIVATE-runtime-only-agent",
    });
    registerOrchestratorTools(apiA as never, scopeA);

    const result = await tool(apiA, "list_orchestrator_agents").execute(
      "list-1",
      {},
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("ok");
    expect(result.details.agents).toEqual([
      expect.objectContaining({
        childId: CHILD_A,
        name: "parent-a-agent",
        stale: false,
        actionable: true,
      }),
      expect.objectContaining({
        childId: CHILD_B,
        status: "unknown",
        liveness: "unknown",
        stale: true,
        actionable: false,
        reason: "runtime_missing",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-parent-b-agent");
    expect(JSON.stringify(result)).not.toContain("PRIVATE parent B task");
    expect(JSON.stringify(result)).not.toContain(CHILD_C);
  });

  it("loads missing, empty, and loaded metadata on demand without a routing cache", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerOrchestratorTools(api as never, scope);
    const list = tool(api, "list_orchestrator_agents");

    const missing = await list.execute(
      "list-missing",
      {},
      undefined,
      undefined,
      { cwd: root },
    );
    expect(missing.details).toMatchObject({
      status: "ok",
      routingMetadataStatus: "missing",
      agents: [],
    });
    expect(missing.content[0].text).toContain(
      '"routingMetadataStatus": "missing"',
    );

    saveOrchestratorRoutingEntries(root, []);
    const empty = await list.execute("list-empty", {}, undefined, undefined, {
      cwd: root,
    });
    expect(empty.details).toMatchObject({
      status: "ok",
      routingMetadataStatus: "empty",
      agents: [],
    });
    expect(empty.content[0].text).toContain('"routingMetadataStatus": "empty"');

    upsertOrchestratorRoutingEntry(root, routingEntry(CHILD_A));
    const loaded = await list.execute("list-loaded", {}, undefined, undefined, {
      cwd: root,
    });
    expect(loaded.details).toMatchObject({
      status: "ok",
      routingMetadataStatus: "loaded",
      agents: [
        {
          childId: CHILD_A,
          status: "unknown",
          liveness: "unknown",
          stale: true,
          actionable: false,
          reason: "runtime_missing",
        },
      ],
    });
  });

  it("updates metadata only after the exact token appears in a later user message", async () => {
    upsertOrchestratorRoutingEntry(
      root,
      routingEntry(CHILD_A, { aliases: ["old"], provenance: "user" }),
    );
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);

    const update = tool(api, "update_orchestrator_agent_description");
    const requested = await update.execute(
      "update-request",
      {
        childId: CHILD_A,
        description: "Own the public API and release compatibility",
        aliases: ["api", "release"],
        provenance: "orchestratorv2",
        confirmed: false,
      },
      undefined,
      undefined,
      toolContext(root, "user-1", "Please change the responsibility"),
    );
    const confirmationToken = requested.details.confirmationToken;
    expect(requested.details.status).toBe("confirmation_required");
    expect(listOrchestratorRoutingEntries(root)[0].aliases).toEqual(["old"]);

    const result = await update.execute(
      "update-confirmed",
      {
        childId: CHILD_A,
        description: "Own the public API and release compatibility",
        aliases: ["api", "release"],
        provenance: "orchestratorv2",
        confirmed: true,
        confirmationToken,
      },
      undefined,
      undefined,
      toolContext(root, "user-2", `I confirm ${confirmationToken}`),
    );

    expect(result.isError).toBeFalsy();
    expect(result.details).toMatchObject({
      status: "updated",
      entry: {
        childId: CHILD_A,
        description: "Own the public API and release compatibility",
        aliases: ["api", "release"],
        provenance: "orchestratorv2",
      },
    });
    expect(listOrchestratorRoutingEntries(root)).toEqual([
      expect.objectContaining({
        childId: CHILD_A,
        description: "Own the public API and release compatibility",
        aliases: ["api", "release"],
        provenance: "orchestratorv2",
        updatedAt: expect.any(String),
      }),
    ]);

    const replay = await update.execute(
      "update-replay",
      {
        childId: CHILD_A,
        description: "Own the public API and release compatibility",
        aliases: ["api", "release"],
        provenance: "orchestratorv2",
        confirmed: true,
        confirmationToken,
      },
      undefined,
      undefined,
      toolContext(root, "user-2", `I confirm ${confirmationToken}`),
    );
    expect(replay.details.status).toBe("confirmation_invalid");
  });

  it("ignores extension-generated coordinator wakes when finding user confirmation", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const params = {
      childId: CHILD_A,
      description: "Own authentication",
      provenance: "user" as const,
    };
    const requested = await update.execute(
      "request",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const confirmationToken = requested.details.confirmationToken;
    const branch = [
      {
        id: "user-1",
        type: "message",
        message: { role: "user", content: "Make the change" },
      },
      {
        id: "user-2",
        type: "message",
        message: { role: "user", content: `Confirm ${confirmationToken}` },
      },
      {
        id: "completion-pointer",
        type: "custom_message",
        details: {
          [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]:
            "12345678-1234-1234-9234-123456789abc",
        },
      },
      {
        id: "extension-wake",
        type: "message",
        message: {
          role: "user",
          content: `hook prefix\n${orchestratorV2WakeupMessage(
            "12345678-1234-1234-9234-123456789abc",
          )}\nhook suffix`,
        },
      },
    ];

    const result = await update.execute(
      "confirmed",
      { ...params, confirmed: true, confirmationToken },
      undefined,
      undefined,
      { cwd: root, sessionManager: { getBranch: () => branch } },
    );

    expect(result.details.status).toBe("updated");
  });

  it("accepts a real confirmation after a pointer whose synthetic wake never arrived", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const params = {
      childId: CHILD_A,
      description: "Own authentication",
      provenance: "user" as const,
    };
    const requested = await update.execute(
      "request",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const confirmationToken = requested.details.confirmationToken;
    const branch = [
      {
        id: "user-1",
        type: "message",
        message: { role: "user", content: "Make the change" },
      },
      {
        id: "completion-pointer",
        type: "custom_message",
        details: {
          [ORCHESTRATOR_V2_WAKE_DETAIL_KEY]:
            "12345678-1234-1234-9234-123456789abc",
        },
      },
      {
        id: "user-2",
        type: "message",
        message: { role: "user", content: `Confirm ${confirmationToken}` },
      },
    ];

    const result = await update.execute(
      "confirmed",
      { ...params, confirmed: true, confirmationToken },
      undefined,
      undefined,
      { cwd: root, sessionManager: { getBranch: () => branch } },
    );

    expect(result.details.status).toBe("updated");
  });

  it("rejects byte-invalid routing metadata before issuing a token", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");

    const result = await update.execute(
      "request-invalid",
      {
        childId: CHILD_A,
        description: "😀".repeat(1025),
        provenance: "user",
        confirmed: false,
      },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );

    expect(result.details.status).toBe("routing_metadata_error");
    expect(result.details).not.toHaveProperty("confirmationToken");
    expect(result.content[0].text).toContain("description exceeds 4096 bytes");
  });

  it("atomically rejects a confirmed update when metadata changes during the write", async () => {
    upsertOrchestratorRoutingEntry(root, routingEntry(CHILD_A));
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const params = {
      childId: CHILD_A,
      description: "Own authentication",
      provenance: "user" as const,
    };
    const requested = await update.execute(
      "request",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const confirmationToken = requested.details.confirmationToken;
    const originalUpsert = orchestratorRouting.upsertOrchestratorRoutingEntry;
    vi.spyOn(
      orchestratorRouting,
      "upsertOrchestratorRoutingEntry",
    ).mockImplementationOnce((cwd, entry, options) => {
      originalUpsert(
        cwd,
        routingEntry(CHILD_A, {
          description: "Concurrent checkout ownership",
          updatedAt: "2026-08-23T20:30:00.000Z",
        }),
      );
      return originalUpsert(cwd, entry, options);
    });

    const result = await update.execute(
      "confirmed",
      { ...params, confirmed: true, confirmationToken },
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${confirmationToken}`),
    );

    expect(result.details.status).toBe("routing_metadata_error");
    expect(listOrchestratorRoutingEntries(root)[0]).toMatchObject({
      description: "Concurrent checkout ownership",
      updatedAt: "2026-08-23T20:30:00.000Z",
    });
  });

  it("rejects model-asserted confirmation and mismatched payloads", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");

    const direct = await update.execute(
      "direct",
      {
        childId: CHILD_A,
        description: "Own authentication",
        provenance: "user",
        confirmed: true,
      },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    expect(direct.details.status).toBe("confirmation_invalid");

    const requested = await update.execute(
      "request",
      {
        childId: CHILD_A,
        description: "Own authentication",
        provenance: "user",
        confirmed: false,
      },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const confirmationToken = requested.details.confirmationToken;
    const mismatch = await update.execute(
      "mismatch",
      {
        childId: CHILD_A,
        description: "Own checkout instead",
        provenance: "user",
        confirmed: true,
        confirmationToken,
      },
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${confirmationToken}`),
    );

    expect(mismatch.details.status).toBe("confirmation_invalid");
    expect(listOrchestratorRoutingEntries(root)).toEqual([]);
  });

  it("retains a valid token across persistence failure and consumes it after success", async () => {
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const params = {
      childId: CHILD_A,
      description: "Own authentication",
      provenance: "user" as const,
    };
    const requested = await update.execute(
      "request",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const confirmationToken = requested.details.confirmationToken;
    vi.spyOn(
      orchestratorRouting,
      "upsertOrchestratorRoutingEntry",
    ).mockImplementationOnce(() => {
      throw new Error("transient rename failure");
    });
    const confirmed = {
      ...params,
      confirmed: true,
      confirmationToken,
    };

    const failed = await update.execute(
      "failed",
      confirmed,
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${confirmationToken}`),
    );
    const retried = await update.execute(
      "retried",
      confirmed,
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${confirmationToken}`),
    );
    const replay = await update.execute(
      "replay",
      confirmed,
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${confirmationToken}`),
    );

    expect(failed.details.status).toBe("routing_metadata_error");
    expect(retried.details.status).toBe("updated");
    expect(replay.details.status).toBe("confirmation_invalid");
  });

  it("expires confirmation tokens and binds them to scope generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T20:00:00.000Z"));
    const api = mockApi();
    const scope = startedScope(api, 1, "parent-a");
    registerState(scope, CHILD_A);
    registerOrchestratorTools(api as never, scope);
    const update = tool(api, "update_orchestrator_agent_description");
    const params = {
      childId: CHILD_A,
      description: "Own authentication",
      provenance: "user" as const,
    };
    const requested = await update.execute(
      "request-expiring",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-1", "Make the change"),
    );
    const expiredToken = requested.details.confirmationToken;
    vi.setSystemTime(new Date("2026-08-23T20:10:00.001Z"));

    const expired = await update.execute(
      "expired",
      { ...params, confirmed: true, confirmationToken: expiredToken },
      undefined,
      undefined,
      toolContext(root, "user-2", `Confirm ${expiredToken}`),
    );
    expect(expired.details.status).toBe("confirmation_invalid");

    const fresh = await update.execute(
      "request-generation",
      { ...params, confirmed: false },
      undefined,
      undefined,
      toolContext(root, "user-2", "Try again"),
    );
    scope.generation++;
    const generationMismatch = await update.execute(
      "generation-mismatch",
      {
        ...params,
        confirmed: true,
        confirmationToken: fresh.details.confirmationToken,
      },
      undefined,
      undefined,
      toolContext(root, "user-3", `Confirm ${fresh.details.confirmationToken}`),
    );
    expect(generationMismatch.details.status).toBe("confirmation_invalid");
  });

  it("does not accept a confirmation token in another session scope", async () => {
    const apiA = mockApi();
    const scopeA = startedScope(apiA, 1, "parent-a");
    registerState(scopeA, CHILD_A);
    registerOrchestratorTools(apiA as never, scopeA);
    const requested = await tool(
      apiA,
      "update_orchestrator_agent_description",
    ).execute(
      "request-a",
      {
        childId: CHILD_A,
        description: "Own authentication",
        provenance: "user",
        confirmed: false,
      },
      undefined,
      undefined,
      toolContext(root, "user-a1", "Make the change"),
    );
    const apiB = mockApi();
    const scopeB = startedScope(apiB, 2, "parent-b");
    registerState(scopeB, CHILD_A);
    registerOrchestratorTools(apiB as never, scopeB);

    const crossScope = await tool(
      apiB,
      "update_orchestrator_agent_description",
    ).execute(
      "confirm-b",
      {
        childId: CHILD_A,
        description: "Own authentication",
        provenance: "user",
        confirmed: true,
        confirmationToken: requested.details.confirmationToken,
      },
      undefined,
      undefined,
      toolContext(
        root,
        "user-b1",
        `Confirm ${requested.details.confirmationToken}`,
      ),
    );

    expect(crossScope.details.status).toBe("confirmation_invalid");
    expect(listOrchestratorRoutingEntries(root)).toEqual([]);
  });

  it("does not update stale metadata backed only by another parent scope", async () => {
    const original = routingEntry(CHILD_B, {
      description: "Parent B owns docs",
    });
    upsertOrchestratorRoutingEntry(root, original);
    const apiA = mockApi();
    const apiB = mockApi();
    const scopeA = startedScope(apiA, 1, "parent-a");
    const scopeB = startedScope(apiB, 2, "parent-b");
    registerState(scopeB, CHILD_B);
    registerOrchestratorTools(apiA as never, scopeA);

    const result = await tool(
      apiA,
      "update_orchestrator_agent_description",
    ).execute(
      "update-foreign",
      {
        childId: CHILD_B,
        description: "Parent A should not replace this",
        provenance: "user",
        confirmed: true,
      },
      undefined,
      undefined,
      { cwd: root },
    );

    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      status: "not_actionable",
      childId: CHILD_B,
      reason: "runtime_missing_in_current_session",
    });
    expect(listOrchestratorRoutingEntries(root)).toEqual([original]);
  });
});
