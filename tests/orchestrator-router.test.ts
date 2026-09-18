import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrchestratorRoutingAuthorityEntry,
  upsertOrchestratorRoutingEntry,
  type OrchestratorRoutingEntry,
} from "../src/orchestrator-routing";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import {
  clearSessionScopes,
  advanceSessionScopeGeneration,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { registerOrchestratorRouterTool } from "../src/tools/orchestrator-router";
import type { InteractiveSubagentState } from "../src/interactive-tmux";

const CHILD_A = "0123456789abcdef";
const CHILD_B = "fedcba9876543210";

function api() {
  return {
    registerTool: vi.fn(),
    getFlag: vi.fn((name: string) => name === "orchestratorv2"),
  };
}

function tool(value: ReturnType<typeof api>): {
  execute: (...args: any[]) => Promise<any>;
} {
  return value.registerTool.mock.calls.find(
    ([definition]) => definition.name === "resolve_orchestrator_route",
  )?.[0];
}

function runtimeState(
  childId: string,
  scope: SessionScope,
  overrides: Partial<InteractiveSubagentState> = {},
): InteractiveSubagentState {
  return {
    id: childId,
    name: `agent-${childId}`,
    task: `Task for ${childId}`,
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
    sessionOwner: sessionOwner(scope),
    parentSessionId: scope.sessionManager?.getSessionId?.(),
    ...overrides,
  };
}

function routingEntry(childId: string): OrchestratorRoutingEntry {
  return {
    childId,
    description: `Own ${childId} responsibility`,
    aliases: [`alias-${childId.slice(0, 4)}`],
    provenance: "user",
    updatedAt: "2026-08-20T14:49:08.446Z",
  };
}

function context(
  root: string,
  entries: readonly OrchestratorRoutingEntry[],
  userId = "user-1",
): { cwd: string; sessionManager: { getBranch: () => unknown[] } } {
  return {
    cwd: root,
    sessionManager: {
      getBranch: () => [
        ...entries.map((entry) => ({
          type: "custom",
          customType: "orchestratorv2-routing-authority",
          data: createOrchestratorRoutingAuthorityEntry(root, entry),
        })),
        {
          id: userId,
          type: "message",
          message: { role: "user", content: "Route this task" },
        },
      ],
    },
  };
}

describe("orchestrator routing advisor", () => {
  let root: string;

  beforeEach(() => {
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", "jev");
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    root = mkdtempSync(join(tmpdir(), "orchestrator-router-"));
    clearSessionScopes();
    __setTmuxMultiplexer({
      getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
    } as never);
  });

  afterEach(() => {
    clearSessionScopes();
    __resetMuxInstances();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a trusted match from an injected engine without dispatch side effects", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    const state = runtimeState(CHILD_A, scope);
    scope.interactiveStates.set(CHILD_A, state);
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    const decide = vi.fn().mockResolvedValue({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({ decide }),
    });

    const result = await tool(value).execute(
      "route-1",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );

    expect(result.details.decision).toMatchObject({
      kind: "match",
      childId: CHILD_A,
    });
    expect(result.content[0].text).toContain(CHILD_A);
    expect(decide).toHaveBeenCalledWith(
      {
        task: "Review the API",
        candidates: [
          {
            childId: CHILD_A,
            description: `Own ${CHILD_A} responsibility`,
            aliases: [`alias-${CHILD_A.slice(0, 4)}`],
            status: "running",
          },
        ],
      },
      undefined,
    );
    expect(state.status).toBe("running");
    expect(value.registerTool).toHaveBeenCalledTimes(1);
  });

  it("does not call the engine when no current candidate is actionable", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    const decide = vi.fn();
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({ decide }),
    });

    const result = await tool(value).execute(
      "route-2",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, []),
    );

    expect(result.details.decision).toEqual({
      kind: "no_match",
      reason: "none",
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects an engine selection for an unknown child", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    scope.interactiveStates.set(CHILD_A, runtimeState(CHILD_A, scope));
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({
        decide: async () => ({
          kind: "match",
          childId: CHILD_B,
          evidence: {
            confidence: 0.95,
            topProbability: 0.9,
            runnerUpProbability: 0.1,
            margin: 0.8,
          },
        }),
      }),
    });

    const result = await tool(value).execute(
      "route-3",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );

    expect(result.details.decision).toEqual({
      kind: "error",
      reason: "invalid_response",
    });
  });

  it("rejects metadata changes made while the provider is in flight", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    scope.interactiveStates.set(CHILD_A, runtimeState(CHILD_A, scope));
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    let release!: (value: unknown) => void;
    let started = false;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({
        decide: async () => {
          started = true;
          return pending;
        },
      }),
    });
    const route = tool(value).execute(
      "route-4",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    entries[0] = {
      ...entries[0],
      description: "Own a changed responsibility",
      updatedAt: "2026-08-21T14:49:08.446Z",
    };
    const currentContext = context(root, entries);
    upsertOrchestratorRoutingEntry(root, entries[0]);
    release({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });
    const result = await route;

    expect(result.details.decision).toEqual({
      kind: "error",
      reason: "state_changed",
    });
    expect(currentContext.cwd).toBe(root);
  });

  it("routes from trusted authority when the project cache is malformed", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    const state = runtimeState(CHILD_A, scope);
    scope.interactiveStates.set(CHILD_A, state);
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    writeFileSync(
      join(root, ".pi", "subagentura-routing.json"),
      "{malformed cache",
    );
    const decide = vi.fn().mockResolvedValue({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({ decide }),
    });

    const result = await tool(value).execute(
      "route-cache-corrupt",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );

    expect(result.details.decision).toMatchObject({
      kind: "match",
      childId: CHILD_A,
    });
    expect(decide).toHaveBeenCalledOnce();
  });

  it("rejects an in-place runtime identity change while the provider is in flight", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    const state = runtimeState(CHILD_A, scope);
    scope.interactiveStates.set(CHILD_A, state);
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    let release!: (value: unknown) => void;
    let started = false;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({
        decide: async () => {
          started = true;
          return pending;
        },
      }),
    });
    const route = tool(value).execute(
      "route-runtime-identity",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    state.sessionFile = "/sessions/replaced.jsonl";
    release({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });

    const result = await route;
    expect(result.details.decision).toEqual({
      kind: "error",
      reason: "state_changed",
    });
  });

  it.each(["cwd", "workingCwd"] as const)(
    "rejects an in-place %s working-directory change while the provider is in flight",
    async (field) => {
      const value = api();
      const scope = registerSessionScope({
        id: 1,
        generation: 0,
        lifecycle: "started",
        pi: value as never,
        cwd: root,
        sessionManager: { getSessionId: () => "parent-1" },
      });
      const state = runtimeState(CHILD_A, scope, {
        workingCwd: "/repo/child-a",
      });
      scope.interactiveStates.set(CHILD_A, state);
      const entries = [routingEntry(CHILD_A)];
      upsertOrchestratorRoutingEntry(root, entries[0]);
      let release!: (value: unknown) => void;
      let started = false;
      const pending = new Promise<any>((resolve) => {
        release = resolve;
      });
      registerOrchestratorRouterTool(value as never, scope, {
        createEngine: () => ({
          decide: async () => {
            started = true;
            return pending;
          },
        }),
      });
      const route = tool(value).execute(
        `route-working-directory-${field}`,
        { task: "Review the API" },
        undefined,
        undefined,
        context(root, entries),
      );
      await vi.waitFor(() => expect(started).toBe(true));
      if (field === "cwd") {
        state.cwd = "/repo/replaced-parent";
      } else {
        state.workingCwd = "/repo/replaced-child";
      }
      release({
        kind: "match",
        childId: CHILD_A,
        evidence: {
          confidence: 0.95,
          topProbability: 0.9,
          runnerUpProbability: 0.1,
          margin: 0.8,
        },
      });

      const result = await route;
      expect(result.details.decision).toEqual({
        kind: "error",
        reason: "state_changed",
      });
    },
  );

  it("cancels a late result after the parent session generation is replaced", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    scope.interactiveStates.set(CHILD_A, runtimeState(CHILD_A, scope));
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    let release!: (value: unknown) => void;
    let started = false;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({
        decide: async () => {
          started = true;
          return pending;
        },
      }),
    });
    const route = tool(value).execute(
      "route-generation",
      { task: "Review the API" },
      undefined,
      undefined,
      context(root, entries),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    advanceSessionScopeGeneration(scope.id);
    release({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });

    const result = await route;
    expect(result.details.decision).toEqual({ kind: "cancelled" });
  });

  it("cancels a late result after the current user request changes", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    scope.interactiveStates.set(CHILD_A, runtimeState(CHILD_A, scope));
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    let userId = "user-1";
    const mutableContext = {
      cwd: root,
      sessionManager: {
        getBranch: () => [
          ...entries.map((entry) => ({
            type: "custom",
            customType: "orchestratorv2-routing-authority",
            data: createOrchestratorRoutingAuthorityEntry(root, entry),
          })),
          {
            id: userId,
            type: "message",
            message: { role: "user", content: "Route this task" },
          },
        ],
      },
    };
    let release!: (value: unknown) => void;
    let started = false;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({
        decide: async () => {
          started = true;
          return pending;
        },
      }),
    });
    const route = tool(value).execute(
      "route-request",
      { task: "Review the API" },
      undefined,
      undefined,
      mutableContext,
    );
    await vi.waitFor(() => expect(started).toBe(true));
    userId = "user-2";
    release({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });

    const result = await route;
    expect(result.details.decision).toEqual({ kind: "cancelled" });
  });

  it("returns cancelled and performs no late route when aborted", async () => {
    const value = api();
    const scope = registerSessionScope({
      id: 1,
      generation: 0,
      lifecycle: "started",
      pi: value as never,
      cwd: root,
      sessionManager: { getSessionId: () => "parent-1" },
    });
    scope.interactiveStates.set(CHILD_A, runtimeState(CHILD_A, scope));
    const entries = [routingEntry(CHILD_A)];
    upsertOrchestratorRoutingEntry(root, entries[0]);
    let release!: (value: unknown) => void;
    const pending = new Promise<any>((resolve) => {
      release = resolve;
    });
    registerOrchestratorRouterTool(value as never, scope, {
      createEngine: () => ({ decide: async () => pending }),
    });
    const controller = new AbortController();
    const route = tool(value).execute(
      "route-5",
      { task: "Review the API" },
      controller.signal,
      undefined,
      context(root, entries),
    );
    controller.abort();
    release({
      kind: "match",
      childId: CHILD_A,
      evidence: {
        confidence: 0.95,
        topProbability: 0.9,
        runnerUpProbability: 0.1,
        margin: 0.8,
      },
    });

    const result = await route;
    expect(result.details.decision).toEqual({ kind: "cancelled" });
  });
});
