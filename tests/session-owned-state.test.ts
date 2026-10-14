import { afterEach, describe, expect, it } from "vitest";
import {
  getInProcessJob,
  inProcessJobsForOwner,
  registerInProcessJob,
  removeInProcessJob,
  type JobState,
} from "../src/helpers";
import {
  registerInteractiveSubagentState,
  removeInteractiveSubagentState,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import { createTestSessionScope } from "./session-scope-fixture";

function job(id: string, owner: ReturnType<typeof sessionOwner>): JobState {
  return {
    id,
    status: "running",
    liveStatus: {
      turn: 0,
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
    },
    session: {} as JobState["session"],
    startedAt: 1,
    promise: Promise.resolve({
      output: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      },
      model: "test/model",
      isError: false,
    }),
    deliveryOwner: {
      pi: {} as never,
      sessionScopeId: owner.id,
      sessionScopeGeneration: owner.generation,
    },
  };
}

afterEach(() => clearSessionScopes());

describe("session-owned runtime state", () => {
  it("isolates in-process jobs and fails closed without the exact owner", () => {
    const scopeA = createTestSessionScope();
    const scopeB = createTestSessionScope();
    const ownerA = sessionOwner(scopeA);
    const ownerB = sessionOwner(scopeB);
    const jobA = job("shared-id", ownerA);
    const jobB = job("shared-id", ownerB);

    expect(registerInProcessJob(jobA, ownerA)).toBe(true);
    expect(registerInProcessJob(jobB, ownerB)).toBe(true);
    expect(registerInProcessJob(job("wrong-owner", ownerA), ownerB)).toBe(
      false,
    );

    expect(getInProcessJob("shared-id", ownerA)).toBe(jobA);
    expect(getInProcessJob("shared-id", ownerB)).toBe(jobB);
    expect(getInProcessJob("shared-id")).toBeUndefined();
    expect(inProcessJobsForOwner().size).toBe(0);
    expect(removeInProcessJob("shared-id", ownerB)).toBe(true);
    expect(getInProcessJob("shared-id", ownerA)).toBe(jobA);
    expect(removeInProcessJob("shared-id")).toBe(false);
  });

  it("retains a state when its owning generation has been replaced", () => {
    const scope = createTestSessionScope();
    const state = {
      id: "interactive-child",
      name: "child",
      task: "test task",
      paneId: "%1",
      mux: "tmux",
      sessionFile: "",
      cwd: "/tmp",
      startedAt: 1,
      status: "running",
    } as InteractiveSubagentState;

    registerInteractiveSubagentState(state, scope);
    const staleOwner = state.sessionOwner;
    expect(staleOwner).toEqual(sessionOwner(scope));

    scope.generation++;

    expect(removeInteractiveSubagentState(state)).toBe(false);
    expect(scope.interactiveStates.get(state.id)).toBe(state);
  });
});
