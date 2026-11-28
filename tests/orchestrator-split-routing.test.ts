import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerExtension from "../src/subagent";
import { __resetMuxInstances, __setTmuxMultiplexer } from "../src/multiplexer";
import {
  createOrchestratorRoutingAuthorityEntry,
  ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE,
} from "../src/orchestrator-routing";
import {
  clearSessionScopes,
  getSessionScopes,
  sessionOwner,
} from "../src/session-scope";
import {
  classifierResult,
  nativeClassifierRegistry,
} from "./helpers/native-classifier";

const { send, launch } = vi.hoisted(() => ({ send: vi.fn(), launch: vi.fn() }));
vi.mock("../src/interactive-tmux", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/interactive-tmux")>()),
  sendCommandToPane: send,
  launchInteractiveSubagent: launch,
}));

const advisor = "resolve_orchestrator_route";
const secret = "synthetic-metadata-marker";
const apiMaterial = "synthetic-inline-API-work-material";
const releaseMaterial = "synthetic-inline-release-work-material";
const apiWork = "Review API compatibility read-only and report findings";
const releaseWork = "Verify release packaging read-only and report findings";
const whole = `${apiWork}; independently, ${releaseWork}`;
const apiId = "0123456789abcdef";
const releaseId = "fedcba9876543210";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "split-routing-"));
  vi.stubEnv("ROUTING_TEST_SECRET", secret);
  __setTmuxMultiplexer({
    getPaneLivenessAsync: vi.fn().mockResolvedValue("alive"),
  } as never);
});

afterEach(() => {
  clearSessionScopes();
  __resetMuxInstances();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function setup(mode: "plain" | "optional" | "forced", split = true) {
  vi.stubEnv("PI_ORCHESTRATOR_ROUTER", mode === "optional" ? "jev" : undefined);
  const modelRegistry = nativeClassifierRegistry();
  const flags = [
    "orchestratorv2",
    ...(split ? ["split"] : []),
    ...(mode === "forced" ? ["force-jev"] : []),
  ];
  const pi = {
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    getFlag: (name: string) => flags.includes(name),
    on: vi.fn(),
  };
  const branch: unknown[] = [
    {
      type: "message",
      id: "request",
      message: {
        role: "user",
        content: `${whole}\n${apiMaterial}\n${releaseMaterial}`,
      },
    },
  ];
  const ctx = {
    cwd: root,
    modelRegistry,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "split-parent",
    },
  };
  registerExtension(pi as never);
  const scope = getSessionScopes().find((entry) => entry.pi === (pi as never))!;
  Object.assign(scope, {
    cwd: root,
    lifecycle: "started",
    sessionManager: ctx.sessionManager,
  });
  let prompt = "base prompt";
  for (const [event, handler] of pi.on.mock.calls) {
    if (event !== "before_agent_start") continue;
    const result = await handler({ systemPrompt: prompt }, ctx);
    if (result?.systemPrompt) prompt = result.systemPrompt;
  }
  const tool = (name: string) =>
    pi.registerTool.mock.calls.find(([entry]) => entry.name === name)?.[0];
  const call = (name: string, params: Record<string, unknown>) =>
    tool(name).execute(name, params, undefined, undefined, ctx);
  return {
    prompt: prompt.replace(/\s+/g, " "),
    modelRegistry,
    scope,
    branch,
    tool,
    call,
  };
}

type Scenario = Awaited<ReturnType<typeof setup>>;

function addOwner(scenario: Scenario, id: string, responsibility: string) {
  const { scope, branch } = scenario;
  scope.interactiveStates.set(id, {
    id,
    task: `${apiMaterial}\n${releaseMaterial}`,
    name: responsibility,
    cwd: root,
    parentSessionId: "split-parent",
    sessionOwner: sessionOwner(scope),
    mux: "tmux",
    paneId: `%${id}`,
    status: "running",
    startedAt: Date.now(),
    sessionFile: join(root, id, "child.jsonl"),
    artifactDir: join(root, id),
    attachCommand: "tmux attach",
    selectPaneCommand: `tmux select-pane -t %${id}`,
    launchScriptFile: join(root, id, "launch.sh"),
  });
  branch.push({
    type: "custom",
    customType: ORCHESTRATOR_ROUTING_AUTHORITY_ENTRY_TYPE,
    data: createOrchestratorRoutingAuthorityEntry(root, {
      childId: id,
      description: responsibility,
      aliases: [secret, id],
      updatedAt: "2026-08-20T14:49:08.446Z",
      provenance: "user",
    }),
  });
}

function choices(registry: Scenario["modelRegistry"], index = 0) {
  return Object.keys(
    registry.classify.mock.calls[index][1].questions.route.criteria,
  );
}

function expectSafePayload(
  scenario: Scenario,
  index: number,
  description: string,
) {
  const payload = scenario.modelRegistry.classify.mock.calls[index][1];
  expect(payload.state.task).toBe(description);
  const serialized = JSON.stringify(payload);
  for (const excluded of [
    secret,
    apiMaterial,
    releaseMaterial,
    apiId,
    releaseId,
    root,
  ]) {
    expect(serialized).not.toContain(excluded);
  }
  return serialized;
}

describe("composed native split and privacy guidance", () => {
  it.each(["plain", "optional", "forced"] as const)(
    "keeps whole-first policy consistent for %s",
    async (mode) => {
      const { prompt, tool } = await setup(mode);
      expect(prompt).toContain(
        "Without an applicable native routing advisor, decompose broad requests",
      );
      expect(prompt).not.toContain(
        "Every broad user-originated request must be decomposed",
      );
      expect(prompt).toContain("Only on `split_needed`");
      expect(prompt).toContain("even with zero eligible children");
      expect(prompt).toContain("a single handoff, not a split");
      expect(prompt).toContain("Never split a part again");
      expect(prompt).toContain(
        "On `no_match`, including `low_confidence` or `ambiguous`, apply the base owner-selection policy to the assessed whole request or part. When that policy calls for creation, create exactly one child for that scope without splitting.",
      );
      expect(prompt).toContain(
        "Do not guess a split or handoff from an error or unavailable result.",
      );
      if (mode === "plain") {
        expect(tool(advisor)).toBeUndefined();
        return;
      }
      expect(tool(advisor)).toBeDefined();
      expect(prompt).toContain(
        "Use `routingDescription` for a minimal classifier-safe description",
      );
      expect(prompt).toContain(
        "If no safe description is sufficient, do not call the advisor",
      );
      expect(prompt).toContain(
        "ask for a safe rephrasing or an explicit target",
      );
      expect(prompt).toContain(
        "Keep embedded work material out of classifier input",
      );
      expect(prompt).not.toMatch(
        /resolve_orchestrator_route with (?:the user's|the) original task/,
      );
      expect(prompt).not.toContain("send the original task");
    },
  );
});

describe("registered split advisor with a stub classifier", () => {
  it.each(["optional", "forced"] as const)(
    "assesses a complete empty registry in %s mode",
    async (mode) => {
      const scenario = await setup(mode);
      const { modelRegistry, call } = scenario;
      modelRegistry.classify
        .mockResolvedValueOnce(
          classifierResult("split", { split: 0.95, none: 0.05 }),
        )
        .mockResolvedValueOnce(
          classifierResult("none", { split: 0.05, none: 0.95 }),
        );
      expect(
        (await call(advisor, { routingDescription: whole })).details.decision
          .kind,
      ).toBe("split_needed");
      expect(choices(modelRegistry)).toEqual(["split", "none"]);
      expectSafePayload(scenario, 0, whole);
      expect(
        (await call(advisor, { routingDescription: apiWork, part: true }))
          .details.decision,
      ).toEqual({
        kind: "no_match",
        reason: "new_child_recommended",
      });
      expect(modelRegistry.classify).toHaveBeenCalledOnce();
      expect(
        (await call(advisor, { routingDescription: whole })).details.decision,
      ).toMatchObject({
        kind: "no_match",
        reason: "new_child_recommended",
      });
      expect(choices(modelRegistry, 1)).toEqual(["split", "none"]);
      expect(send).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("abstains on weak split evidence with one eligible child", async () => {
    const scenario = await setup("forced");
    addOwner(scenario, apiId, "Own API compatibility review");
    scenario.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult(
        "split",
        { candidate_0: 0.02, split: 0.95, none: 0.03 },
        0.4,
      ),
    );
    const result = await scenario.call(advisor, { routingDescription: whole });
    expect(result.details.decision).toMatchObject({
      kind: "split_uncertain",
      reason: "low_confidence",
    });
    expect(choices(scenario.modelRegistry)).toEqual([
      "candidate_0",
      "split",
      "none",
    ]);
    expectSafePayload(scenario, 0, whole);
    expect(send).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["optional", "forced"] as const)(
    "advises on parts and separately sends two authorized handoffs in %s mode",
    async (mode) => {
      const scenario = await setup(mode);
      const { modelRegistry, call } = scenario;
      addOwner(scenario, apiId, "Own API compatibility review");
      addOwner(scenario, releaseId, "Own release packaging verification");
      modelRegistry.classify.mockImplementation(async (_model, context) => {
        const offered = Object.keys(context.questions.route.criteria);
        const choice = offered.includes("split")
          ? "split"
          : context.state.task === apiWork
            ? "candidate_0"
            : "candidate_1";
        return classifierResult(
          choice,
          Object.fromEntries(
            offered.map((option) => [option, option === choice ? 1 : 0]),
          ),
        );
      });
      expect(
        (await call(advisor, { routingDescription: whole })).details.decision
          .kind,
      ).toBe("split_needed");
      expect(choices(modelRegistry)).toEqual([
        "candidate_0",
        "candidate_1",
        "split",
        "none",
      ]);
      expectSafePayload(scenario, 0, whole);

      // Script the parent's choices. Neither advisor nor dispatch checks model adherence.
      for (const [
        index,
        description,
        owner,
        material,
        other,
        otherMaterial,
      ] of [
        [1, apiWork, apiId, apiMaterial, releaseWork, releaseMaterial],
        [2, releaseWork, releaseId, releaseMaterial, apiWork, apiMaterial],
      ] as const) {
        const {
          details: { decision },
        } = await call(advisor, {
          routingDescription: description,
          part: true,
        });
        expect(decision).toMatchObject({ kind: "match", childId: owner });
        expect(choices(modelRegistry, index)).toEqual([
          "candidate_0",
          "candidate_1",
          "none",
        ]);
        expect(expectSafePayload(scenario, index, description)).not.toContain(
          other,
        );
        expect(send).toHaveBeenCalledTimes(index - 1);
        const handoff = await call("send_interactive_subagent_message", {
          id: decision.childId,
          message: `${description}\n${material}`,
        });
        expect(handoff.details.status).toBe("sent");
        const [state, message] = send.mock.calls[index - 1];
        expect(state.id).toBe(owner);
        expect(message).toContain(material);
        expect(message).not.toContain(otherMaterial);
        expect(message).not.toContain(other);
      }
      expect(modelRegistry.classify).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledTimes(2);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("rejects a classifier trying to split a part again", async () => {
    const scenario = await setup("forced");
    addOwner(scenario, apiId, "Own API compatibility review");
    scenario.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult("split", { candidate_0: 0.02, split: 0.95, none: 0.03 }),
    );
    expect(
      (
        await scenario.call(advisor, {
          routingDescription: apiWork,
          part: true,
        })
      ).details.decision,
    ).toEqual({
      kind: "error",
      reason: "invalid_response",
    });
    expect(choices(scenario.modelRegistry)).toEqual(["candidate_0", "none"]);
  });

  it.each(["optional", "forced"] as const)(
    "makes no classifier call for missing, blank or raw-only inputs at either split stage in %s mode",
    async (mode) => {
      const scenario = await setup(mode);
      for (const withOwner of [false, true]) {
        if (withOwner)
          addOwner(scenario, apiId, "Own API compatibility review");
        for (const part of [{}, { part: true }]) {
          for (const unsafe of [
            {},
            { routingDescription: "  " },
            { task: apiMaterial },
            { routingDescription: apiWork, task: apiMaterial },
          ]) {
            expect(
              (await scenario.call(advisor, { ...part, ...unsafe })).details
                .decision,
            ).toEqual({ kind: "error", reason: "invalid_input" });
          }
        }
      }
      expect(scenario.modelRegistry.classify).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("retains legacy task only for optional non-split calls, and rejects dual input", async () => {
    const scenario = await setup("optional", false);
    addOwner(scenario, apiId, "Own API compatibility review");
    const { call, modelRegistry } = scenario;
    expect(
      (await call(advisor, { task: apiWork, routingDescription: releaseWork }))
        .details.decision,
    ).toMatchObject({ reason: "invalid_input" });
    expect(modelRegistry.classify).not.toHaveBeenCalled();
    expect(
      (await call(advisor, { task: apiWork })).details.decision,
    ).toMatchObject({ kind: "match", childId: apiId });
    expectSafePayload(scenario, 0, apiWork);
    expect(
      (await call(advisor, { routingDescription: apiWork })).details.decision,
    ).toMatchObject({ kind: "match", childId: apiId });
  });

  it("rejects raw-only input in forced non-split mode", async () => {
    const scenario = await setup("forced", false);
    addOwner(scenario, apiId, "Own API compatibility review");
    expect(
      (await scenario.call(advisor, { task: apiMaterial })).details.decision,
    ).toEqual({ kind: "error", reason: "invalid_input" });
    expect(scenario.modelRegistry.classify).not.toHaveBeenCalled();
  });

  it("reserves one of llama.cpp's 62 labels for whole split assessment only", async () => {
    const scenario = await setup("forced");
    scenario.modelRegistry.model.api = "llama-cpp-classify";
    const { modelRegistry, call } = scenario;
    modelRegistry.classify.mockImplementation(async (_model, context) => {
      const offered = Object.keys(context.questions.route.criteria);
      return classifierResult(
        "none",
        Object.fromEntries(
          offered.map((option) => [option, option === "none" ? 1 : 0]),
        ),
      );
    });
    for (let index = 0; index < 60; index++) {
      addOwner(
        scenario,
        (index + 1).toString(16).padStart(16, "0"),
        `Own area ${index}`,
      );
    }
    expect(
      (await call(advisor, { routingDescription: whole })).details.decision,
    ).toMatchObject({ reason: "new_child_recommended" });
    expect(choices(modelRegistry)).toHaveLength(62);
    expect(choices(modelRegistry).slice(-2)).toEqual(["split", "none"]);
    addOwner(scenario, releaseId, "Own release packaging verification");
    expect(
      (await call(advisor, { routingDescription: whole })).details.decision,
    ).toMatchObject({ reason: "payload_too_large" });
    expect(modelRegistry.classify).toHaveBeenCalledOnce();
    expect(
      (await call(advisor, { routingDescription: apiWork, part: true })).details
        .decision,
    ).toMatchObject({ reason: "new_child_recommended" });
    expect(choices(modelRegistry, 1)).toHaveLength(62);
    expect(choices(modelRegistry, 1)).not.toContain("split");
  });
});
it.each(["optional", "forced"] as const)(
  "asks about a narrow split decision with no children in %s mode",
  async (mode) => {
    const s = await setup(mode);
    s.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult("split", { split: 0.51, none: 0.49 }),
    );
    const result = await s.call(advisor, { routingDescription: whole });
    expect(result.details.decision.kind).toBe("split_uncertain");
    expect(result.content[0].text).toContain(
      "Do not split, send, or create a child",
    );
    expect(s.prompt).toContain("On `split_uncertain`");
    expect(send).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  },
);

describe("explicit handoff scope check", () => {
  it.each([
    ["candidate_0", 0.96, "fit"],
    ["none", 0.96, "mismatch"],
    ["none", 0.51, "uncertain"],
  ] as const)(
    "maps %s at %s to %s without dispatch",
    async (choice, p, kind) => {
      const s = await setup("optional");
      addOwner(s, apiId, "Review the API, read-only");
      addOwner(s, releaseId, "Publish release packages");
      s.modelRegistry.classify.mockResolvedValueOnce(
        classifierResult(choice, {
          candidate_0: choice === "candidate_0" ? p : 1 - p,
          none: choice === "none" ? p : 1 - p,
        }),
      );
      const result = await s.call(advisor, {
        scopeCheckChildId: apiId,
        routingDescription: apiWork,
      });
      expect(result.details).toMatchObject({
        status: "scope_advice",
        decision: { kind },
      });
      expect(choices(s.modelRegistry)).toEqual(["candidate_0", "none"]);
      const serialized = expectSafePayload(s, 0, apiWork);
      expect(serialized).not.toContain("Publish release packages");
      expect(send).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("redacts eligible sibling IDs from scope-check classifier text", async () => {
    const s = await setup("optional", false);
    addOwner(s, apiId, `Review ${releaseId} API work`);
    addOwner(s, releaseId, "Publish packages");
    addOwner(s, "abcdef12", "Short sibling");
    addOwner(s, "abcdef1234567890", "Long sibling");
    s.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult("candidate_0", { candidate_0: 0.96, none: 0.04 }),
    );

    const result = await s.call(advisor, {
      scopeCheckChildId: apiId,
      routingDescription: `Review ${releaseId}; task abcdef1234567890; criteria ${releaseId}`,
    });

    expect(result.details).toMatchObject({ decision: { kind: "fit" } });
    const payload = JSON.stringify(s.modelRegistry.classify.mock.calls[0][1]);
    expect(payload).not.toContain(releaseId);
    expect(payload).not.toContain("abcdef12");
    expect(payload).not.toContain(apiId);
    expect(choices(s.modelRegistry)).toEqual(["candidate_0", "none"]);
  });

  it("does not fail selected-child scope advice for unrelated incomplete siblings", async () => {
    const s = await setup("optional", false);
    addOwner(s, apiId, "Review API");
    addOwner(s, releaseId, "Publish packages");
    s.scope.interactiveStates.delete(releaseId);
    s.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult("none", { candidate_0: 0.01, none: 0.99 }),
    );

    const result = await s.call(advisor, {
      scopeCheckChildId: apiId,
      routingDescription: apiWork,
    });

    expect(result.details).toMatchObject({ decision: { kind: "mismatch" } });
  });
  it("rechecks the selected target after the sibling's final probe", async () => {
    const s = await setup("optional", false);
    addOwner(s, apiId, "Review API");
    addOwner(s, releaseId, "Other work");
    const siblingProbeStarted = Promise.withResolvers<void>();
    const releaseSiblingProbe = Promise.withResolvers<"alive">();
    let siblingProbeCount = 0;
    __setTmuxMultiplexer({
      getPaneLivenessAsync: async (paneId: string) => {
        if (paneId === `%${releaseId}` && ++siblingProbeCount === 2) {
          siblingProbeStarted.resolve();
          return releaseSiblingProbe.promise;
        }
        return "alive";
      },
    } as never);
    s.modelRegistry.classify.mockResolvedValueOnce(
      classifierResult("candidate_0", {
        candidate_0: 0.96,
        none: 0.04,
      }),
    );
    const pending = s.call(advisor, {
      scopeCheckChildId: apiId,
      routingDescription: apiWork,
    });
    await siblingProbeStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    s.scope.interactiveStates.get(apiId)!.status = "cancelled";
    releaseSiblingProbe.resolve("alive");

    expect((await pending).details.decision).toEqual({
      kind: "error",
      reason: "state_changed",
    });
    expect(send).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects unknown targets, legacy input, and part routing without a classifier call", async () => {
    const s = await setup("optional", false);
    addOwner(s, apiId, "Read-only review");
    for (const params of [
      { scopeCheckChildId: releaseId, routingDescription: apiWork },
      { scopeCheckChildId: apiId, task: apiMaterial },
      { scopeCheckChildId: apiId, routingDescription: apiWork, part: true },
    ])
      expect((await s.call(advisor, params)).details.decision.kind).toBe(
        "error",
      );
    expect(s.modelRegistry.classify).not.toHaveBeenCalled();
  });
});
