import { describe, expect, it } from "vitest";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";
import {
  applyPlanEvent,
  assertLegalTaskTransition,
  createPlanProjection,
  isLegalTaskTransition,
  selectReadyTasks,
  workflowPlanStatus,
  WORKFLOW_PLAN_TASK_STATUSES,
  type WorkflowPlanEvent,
  type WorkflowPlanProjection,
  type WorkflowPlanTaskStatus,
} from "../src/workflow-plan-state";

function makePlan(
  phases: Array<{
    id: string;
    mode: "sequence" | "parallel";
    tasks: string[];
  }>,
): WorkflowPlanDefinition {
  return {
    name: "state test",
    description: "Exercises the pure workflow plan reducer",
    phases: phases.map((phase) => ({
      id: phase.id,
      name: phase.id,
      mode: phase.mode,
      tasks: phase.tasks.map((id) => ({
        id,
        content: `content ${id}`,
        instruction: `instruction ${id}`,
      })),
    })),
  };
}

function applyEvents(
  projection: WorkflowPlanProjection,
  ...events: WorkflowPlanEvent[]
): WorkflowPlanProjection {
  return events.reduce(applyPlanEvent, projection);
}

function task(projection: WorkflowPlanProjection, taskId: string) {
  for (const phase of projection.phases) {
    const match = phase.tasks.find(
      (candidate) => candidate.definition.id === taskId,
    );
    if (match !== undefined) {
      return match;
    }
  }
  throw new Error(`Missing task ${taskId}`);
}

function readyIds(
  projection: WorkflowPlanProjection,
  limit = Number.MAX_SAFE_INTEGER,
): string[] {
  return selectReadyTasks(projection, limit).map(
    (candidate) => candidate.definition.id,
  );
}

const LEGAL_TRANSITIONS = new Set([
  "pending->running",
  "pending->blocked",
  "pending->skipped",
  "pending->cancelled",
  "running->succeeded",
  "running->failed",
  "running->skipped",
  "running->cancelled",
  "blocked->pending",
  "blocked->skipped",
  "blocked->cancelled",
]);

describe("workflow plan task transitions", () => {
  it("accepts every legal transition and rejects every illegal transition", () => {
    for (const from of WORKFLOW_PLAN_TASK_STATUSES) {
      for (const to of WORKFLOW_PLAN_TASK_STATUSES) {
        const expected = LEGAL_TRANSITIONS.has(`${from}->${to}`);
        expect(isLegalTaskTransition(from, to)).toBe(expected);
        if (expected) {
          expect(() => assertLegalTaskTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertLegalTaskTransition(from, to)).toThrow(
            `Illegal workflow plan task transition: ${from} -> ${to}`,
          );
        }
      }
    }
  });

  it.each<{
    prepare: WorkflowPlanEvent[];
    event: WorkflowPlanEvent;
    to: WorkflowPlanTaskStatus;
  }>([
    {
      prepare: [],
      event: { type: "task_started", taskId: "a" },
      to: "running",
    },
    {
      prepare: [],
      event: { type: "task_blocked", taskId: "a" },
      to: "blocked",
    },
    {
      prepare: [],
      event: { type: "task_skipped", taskId: "a" },
      to: "skipped",
    },
    {
      prepare: [],
      event: { type: "task_cancelled", taskId: "a" },
      to: "cancelled",
    },
    {
      prepare: [{ type: "task_started", taskId: "a" }],
      event: { type: "task_succeeded", taskId: "a", result: "ok" },
      to: "succeeded",
    },
    {
      prepare: [{ type: "task_started", taskId: "a" }],
      event: { type: "task_failed", taskId: "a", error: "bad" },
      to: "failed",
    },
    {
      prepare: [{ type: "task_started", taskId: "a" }],
      event: { type: "task_cancelled", taskId: "a" },
      to: "cancelled",
    },
    {
      prepare: [{ type: "task_blocked", taskId: "a" }],
      event: { type: "task_unblocked", taskId: "a" },
      to: "pending",
    },
    {
      prepare: [{ type: "task_blocked", taskId: "a" }],
      event: { type: "task_skipped", taskId: "a" },
      to: "skipped",
    },
    {
      prepare: [{ type: "task_blocked", taskId: "a" }],
      event: { type: "task_cancelled", taskId: "a" },
      to: "cancelled",
    },
  ])("folds evidence to $to", ({ prepare, event, to }) => {
    const initial = createPlanProjection(
      makePlan([{ id: "phase", mode: "sequence", tasks: ["a"] }]),
    );
    const prepared = applyEvents(initial, ...prepare);

    expect(task(applyPlanEvent(prepared, event), "a").status).toBe(to);
  });

  it("rejects evidence that is illegal for the current task state", () => {
    const projection = createPlanProjection(
      makePlan([{ id: "phase", mode: "sequence", tasks: ["a"] }]),
    );

    expect(() =>
      applyPlanEvent(projection, {
        type: "task_succeeded",
        taskId: "a",
        result: null,
      }),
    ).toThrow("Illegal workflow plan task transition: pending -> succeeded");
    expect(() =>
      applyPlanEvent(projection, { type: "task_started", taskId: "missing" }),
    ).toThrow('Unknown workflow plan task "missing"');
  });
});

describe("workflow plan eligibility", () => {
  it("runs sequential tasks in declaration order and accepts a skipped predecessor", () => {
    let projection = createPlanProjection(
      makePlan([{ id: "sequence", mode: "sequence", tasks: ["a", "b", "c"] }]),
    );

    expect(readyIds(projection)).toEqual(["a"]);
    projection = applyPlanEvent(projection, {
      type: "task_started",
      taskId: "a",
    });
    expect(readyIds(projection)).toEqual([]);
    projection = applyPlanEvent(projection, {
      type: "task_succeeded",
      taskId: "a",
      result: { answer: 1 },
    });
    expect(readyIds(projection)).toEqual(["b"]);
    projection = applyPlanEvent(projection, {
      type: "task_skipped",
      taskId: "b",
      reason: "not needed",
    });

    expect(readyIds(projection)).toEqual(["c"]);
    expect(task(projection, "a")).toMatchObject({
      status: "succeeded",
      result: { answer: 1 },
    });
    expect(task(projection, "b")).toMatchObject({
      status: "skipped",
      reason: "not needed",
    });
  });

  it("exposes eligible parallel siblings while blocked siblings remain in history", () => {
    let projection = createPlanProjection(
      makePlan([{ id: "parallel", mode: "parallel", tasks: ["a", "b", "c"] }]),
    );

    expect(readyIds(projection)).toEqual(["a", "b", "c"]);
    projection = applyPlanEvent(projection, {
      type: "task_blocked",
      taskId: "a",
      reason: "dependency",
    });

    expect(readyIds(projection)).toEqual(["b", "c"]);
    expect(workflowPlanStatus(projection)).toBe("running");
    expect(task(projection, "a")).toMatchObject({
      status: "blocked",
      reason: "dependency",
    });
  });

  it("bounds selection by total in-flight concurrency", () => {
    let projection = createPlanProjection(
      makePlan([
        {
          id: "parallel",
          mode: "parallel",
          tasks: ["a", "b", "c", "d"],
        },
      ]),
    );

    expect(readyIds(projection, 2)).toEqual(["a", "b"]);
    projection = applyPlanEvent(projection, {
      type: "task_started",
      taskId: "a",
    });
    expect(readyIds(projection, 2)).toEqual(["b"]);
    projection = applyPlanEvent(projection, {
      type: "task_started",
      taskId: "b",
    });
    expect(readyIds(projection, 2)).toEqual([]);
    expect(readyIds(projection, 3)).toEqual(["c"]);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid concurrency limit %s",
    (limit) => {
      const projection = createPlanProjection(
        makePlan([{ id: "phase", mode: "parallel", tasks: ["a"] }]),
      );

      expect(() => selectReadyTasks(projection, limit)).toThrow(
        "concurrencyLimit must be a positive safe integer",
      );
    },
  );

  it("does not advance phases until the current phase has no active task", () => {
    let projection = createPlanProjection(
      makePlan([
        { id: "first", mode: "sequence", tasks: ["a"] },
        { id: "second", mode: "parallel", tasks: ["b", "c"] },
      ]),
    );

    expect(readyIds(projection)).toEqual(["a"]);
    projection = applyPlanEvent(projection, {
      type: "task_blocked",
      taskId: "a",
    });
    expect(readyIds(projection)).toEqual([]);
    expect(workflowPlanStatus(projection)).toBe("blocked");
    expect(() =>
      applyPlanEvent(projection, {
        type: "task_started",
        taskId: "b",
      }),
    ).toThrow('Workflow plan task "b" is not eligible');
    projection = applyPlanEvent(projection, {
      type: "task_unblocked",
      taskId: "a",
    });
    projection = applyPlanEvent(projection, {
      type: "task_started",
      taskId: "a",
    });
    expect(readyIds(projection)).toEqual([]);
    projection = applyPlanEvent(projection, {
      type: "task_succeeded",
      taskId: "a",
      result: null,
    });

    expect(readyIds(projection)).toEqual(["b", "c"]);
  });
});

describe("workflow plan status", () => {
  it("is blocked only when required work is blocked and no work is running or eligible", () => {
    let mixed = createPlanProjection(
      makePlan([{ id: "parallel", mode: "parallel", tasks: ["a", "b"] }]),
    );
    mixed = applyPlanEvent(mixed, { type: "task_blocked", taskId: "a" });
    expect(workflowPlanStatus(mixed)).toBe("running");

    const withRunning = applyPlanEvent(mixed, {
      type: "task_started",
      taskId: "b",
    });
    expect(workflowPlanStatus(withRunning)).toBe("running");

    const allBlocked = applyPlanEvent(mixed, {
      type: "task_blocked",
      taskId: "b",
    });
    expect(readyIds(allBlocked)).toEqual([]);
    expect(workflowPlanStatus(allBlocked)).toBe("blocked");
  });

  it("stops sequential successors immediately after failure", () => {
    let projection = createPlanProjection(
      makePlan([
        { id: "first", mode: "sequence", tasks: ["a", "b"] },
        { id: "later", mode: "sequence", tasks: ["c"] },
      ]),
    );
    projection = applyEvents(
      projection,
      { type: "task_started", taskId: "a" },
      { type: "task_failed", taskId: "a", error: "failed" },
    );

    expect(task(projection, "a")).toMatchObject({
      status: "failed",
      error: "failed",
    });
    expect(task(projection, "b").status).toBe("cancelled");
    expect(task(projection, "c").status).toBe("cancelled");
    expect(readyIds(projection)).toEqual([]);
    expect(workflowPlanStatus(projection)).toBe("error");
  });

  it("closes parallel dispatch on failure while running siblings drain", () => {
    let projection = createPlanProjection(
      makePlan([
        { id: "parallel", mode: "parallel", tasks: ["a", "b", "c"] },
        { id: "later", mode: "sequence", tasks: ["d"] },
      ]),
    );
    projection = applyEvents(
      projection,
      { type: "task_started", taskId: "a" },
      { type: "task_started", taskId: "b" },
      { type: "task_failed", taskId: "a", error: { code: "boom" } },
    );

    expect(task(projection, "a")).toMatchObject({
      status: "failed",
      error: { code: "boom" },
    });
    expect(task(projection, "b").status).toBe("running");
    expect(task(projection, "c").status).toBe("cancelled");
    expect(task(projection, "d").status).toBe("cancelled");
    expect(readyIds(projection)).toEqual([]);
    expect(workflowPlanStatus(projection)).toBe("running");

    projection = applyPlanEvent(projection, {
      type: "task_succeeded",
      taskId: "b",
      result: "drained",
    });
    expect(task(projection, "b")).toMatchObject({
      status: "succeeded",
      result: "drained",
    });
    expect(workflowPlanStatus(projection)).toBe("error");
  });

  it("cancels every nonterminal task while preserving completed and skipped history", () => {
    let projection = createPlanProjection(
      makePlan([
        { id: "history", mode: "sequence", tasks: ["done", "skip"] },
        {
          id: "active",
          mode: "parallel",
          tasks: ["running", "pending", "blocked"],
        },
      ]),
    );
    projection = applyEvents(
      projection,
      { type: "task_started", taskId: "done" },
      { type: "task_succeeded", taskId: "done", result: 42 },
      { type: "task_skipped", taskId: "skip", reason: "optional" },
      { type: "task_started", taskId: "running" },
      { type: "task_blocked", taskId: "blocked", reason: "waiting" },
      { type: "run_cancelled", reason: "user requested" },
    );

    expect(task(projection, "done")).toMatchObject({
      status: "succeeded",
      result: 42,
    });
    expect(task(projection, "skip")).toMatchObject({
      status: "skipped",
      reason: "optional",
    });
    for (const taskId of ["running", "pending", "blocked"]) {
      expect(task(projection, taskId)).toMatchObject({
        status: "cancelled",
        reason: "user requested",
      });
    }
    expect(workflowPlanStatus(projection)).toBe("cancelled");
  });
});

describe("workflow plan immutability", () => {
  it("copies definition input and never mutates a projection while folding", () => {
    const definition = makePlan([
      { id: "parallel", mode: "parallel", tasks: ["a", "b", "c"] },
    ]);
    const definitionSnapshot = structuredClone(definition);
    const initial = createPlanProjection(definition);

    expect(definition).toEqual(definitionSnapshot);
    expect(initial.definition).toEqual(definitionSnapshot);
    expect(initial.definition).not.toBe(definition);
    expect(initial.definition.phases[0]).not.toBe(definition.phases[0]);
    expect(initial.definition.phases[0].tasks[0]).not.toBe(
      definition.phases[0].tasks[0],
    );

    const running = applyEvents(
      initial,
      { type: "task_started", taskId: "a" },
      { type: "task_started", taskId: "b" },
    );
    const runningSnapshot = structuredClone(running);
    const failed = applyPlanEvent(running, {
      type: "task_failed",
      taskId: "a",
      error: "nope",
    });

    expect(running).toEqual(runningSnapshot);
    expect(task(running, "a").status).toBe("running");
    expect(task(running, "c").status).toBe("pending");
    expect(task(failed, "a").status).toBe("failed");
    expect(task(failed, "b").status).toBe("running");
    expect(task(failed, "c").status).toBe("cancelled");
  });

  it("does not allow terminal tasks or terminal runs to change", () => {
    const twoTasks = makePlan([
      { id: "phase", mode: "sequence", tasks: ["a", "b"] },
    ]);
    const firstSucceeded = applyEvents(
      createPlanProjection(twoTasks),
      { type: "task_started", taskId: "a" },
      { type: "task_succeeded", taskId: "a", result: null },
    );
    expect(() =>
      applyPlanEvent(firstSucceeded, { type: "task_started", taskId: "a" }),
    ).toThrow("Illegal workflow plan task transition: succeeded -> running");

    const done = applyEvents(
      firstSucceeded,
      { type: "task_started", taskId: "b" },
      { type: "task_succeeded", taskId: "b", result: null },
    );
    expect(workflowPlanStatus(done)).toBe("done");
    expect(() => applyPlanEvent(done, { type: "run_cancelled" })).toThrow(
      "Cannot apply run_cancelled to terminal workflow plan (done)",
    );

    const errored = applyEvents(
      createPlanProjection(
        makePlan([{ id: "phase", mode: "sequence", tasks: ["a"] }]),
      ),
      { type: "task_started", taskId: "a" },
      { type: "task_failed", taskId: "a", error: "bad" },
    );
    expect(() => applyPlanEvent(errored, { type: "run_cancelled" })).toThrow(
      "Cannot apply run_cancelled to terminal workflow plan (error)",
    );

    const cancelled = applyPlanEvent(
      createPlanProjection(
        makePlan([{ id: "phase", mode: "sequence", tasks: ["a"] }]),
      ),
      { type: "run_cancelled" },
    );
    expect(() =>
      applyPlanEvent(cancelled, { type: "task_started", taskId: "a" }),
    ).toThrow(
      "Cannot apply task_started to terminal workflow plan (cancelled)",
    );
  });
});
