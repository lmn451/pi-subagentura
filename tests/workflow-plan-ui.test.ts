import { describe, expect, it } from "vitest";
import type { WorkflowPlanDefinition } from "../src/workflow-plan";
import {
  createPlanProjection,
  type WorkflowPlanProjection,
} from "../src/workflow-plan-state";
import {
  formatWorkflowPlanRows,
  formatWorkflowPlanSummary,
} from "../src/workflow-plan-ui";

function makeProjection(): WorkflowPlanProjection {
  const definition: WorkflowPlanDefinition = {
    name: "release plan",
    description: "A phased preview",
    phases: [
      {
        id: "prepare",
        name: "Prepare",
        mode: "sequence",
        tasks: [
          {
            id: "task-success",
            content: "Check package",
            instruction: "check",
          },
        ],
      },
      {
        id: "review",
        name: "Review",
        mode: "parallel",
        tasks: [
          {
            id: "task-pending",
            content: "Awaiting dispatch",
            instruction: "wait",
          },
          { id: "task-active", content: "Build package", instruction: "build" },
          {
            id: "task-blocked",
            content: "Publish package",
            instruction: "publish",
          },
          { id: "task-failed", content: "Run checks", instruction: "check" },
          { id: "task-skipped", content: "Notify team", instruction: "notify" },
          { id: "task-cancelled", content: "Clean up", instruction: "clean" },
        ],
      },
    ],
  };
  const projection = createPlanProjection(definition);
  const runtime = {
    "task-success": {
      status: "succeeded",
      result: { output: "must not be rendered" },
    },
    "task-pending": { status: "pending" },
    "task-active": { status: "running" },
    "task-blocked": { status: "blocked", reason: "waiting for approval" },
    "task-failed": { status: "failed", error: new Error("checks failed") },
    "task-skipped": { status: "skipped", reason: "not needed" },
    "task-cancelled": {
      status: "cancelled",
      reason: "user stopped preview",
    },
  } as const;
  return {
    ...projection,
    phases: projection.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({
        ...task,
        ...runtime[task.definition.id as keyof typeof runtime],
      })),
    })),
  };
}

describe("workflow plan presentation", () => {
  it("renders ordered sequence and parallel phase headings", () => {
    const rows = formatWorkflowPlanRows(makeProjection());
    expect(
      rows.filter((row) => row.depth === 0).map((row) => row.text),
    ).toEqual(["◆ phase: Prepare [sequence]", "◆ phase: Review [parallel]"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 0, 1, 1, 1, 1, 1, 1]);
  });

  it("includes every task state, stable IDs, and actionable detail", () => {
    const rows = formatWorkflowPlanRows(makeProjection());
    const taskRows = rows.filter((row) => row.taskId !== undefined);
    expect(taskRows.map((row) => row.status)).toEqual([
      "succeeded",
      "pending",
      "running",
      "blocked",
      "failed",
      "skipped",
      "cancelled",
    ]);
    for (const row of taskRows) {
      expect(row.text).toContain(row.taskId!);
      expect(row.text).toContain(`[${row.status}]`);
    }
    expect(
      taskRows.find((row) => row.taskId === "task-active")!.text,
    ).toContain("active");
    expect(
      taskRows.find((row) => row.taskId === "task-blocked")!.text,
    ).toContain("waiting for approval");
    expect(
      taskRows.find((row) => row.taskId === "task-failed")!.text,
    ).toContain("error: checks failed");
    expect(
      taskRows.find((row) => row.taskId === "task-skipped")!.text,
    ).toContain("reason: not needed");
    expect(
      taskRows.find((row) => row.taskId === "task-cancelled")!.text,
    ).toContain("reason: user stopped preview");
  });
  it("removes terminal and bidi controls from untrusted plan text", () => {
    const projection = makeProjection();
    const bidiControls =
      "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const adversarial = {
      ...projection,
      definition: {
        ...projection.definition,
        name: `\u001b[31m发布${bidiControls}计划\u009b2J`,
      },
      phases: projection.phases.map((phase) => ({
        ...phase,
        definition: {
          ...phase.definition,
          name: `\u001b]0;owned\u0007阶段${bidiControls}Ω`,
        },
        tasks: phase.tasks.map((task) => ({
          ...task,
          definition: {
            ...task.definition,
            id: `${task.definition.id}\u202e]dehsiuf[\u202c`,
            content: `任务${bidiControls}Ω\u001b[2J`,
          },
          reason: `等待\u2067]dehsiuf[\u2069批准\u009b2J`,
          error: new Error(`失败\u202e]dehsius[\u202c原因\u001b[31m`),
        })),
      })),
    } as WorkflowPlanProjection;

    const rendered = [
      formatWorkflowPlanSummary(adversarial),
      ...formatWorkflowPlanRows(adversarial).map((row) => row.text),
    ];
    for (const row of rendered) {
      expect(row).not.toMatch(
        /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
      );
    }
    const text = rendered.join("\n");
    expect(text).toContain("发布计划");
    expect(text).toContain("阶段Ω");
    expect(text).toContain("任务Ω");
    expect(text).toContain("等待]dehsiuf[批准");
    expect(text).toContain("失败]dehsius[原因");
  });

  it("summarizes the derived overall status without task output", () => {
    const summary = formatWorkflowPlanSummary(makeProjection());
    expect(summary).toContain("release plan");
    expect(summary).toContain("status: running");
    expect(summary).toContain("active");
    expect(summary).toContain("blocked");
    expect(summary).toContain("error");
    expect(summary).not.toContain("must not be rendered");
    expect(summary).not.toContain("output");
    expect(
      formatWorkflowPlanRows(makeProjection())
        .map((row) => row.text)
        .join("\n"),
    ).not.toContain("must not be rendered");
  });

  it("bounds rows and keeps stable IDs before truncating task content", () => {
    const rows = formatWorkflowPlanRows(makeProjection(), { width: 36 });
    expect(rows.every((row) => row.text.length <= 36)).toBe(true);
    expect(rows.find((row) => row.taskId === "task-active")!.text).toContain(
      "task-active",
    );
    expect(rows.find((row) => row.taskId === "task-active")!.text).toContain(
      "…",
    );
    expect(
      formatWorkflowPlanSummary(makeProjection(), { width: 12 }).length,
    ).toBeLessThanOrEqual(12);
    expect(formatWorkflowPlanSummary(makeProjection(), { width: 0 })).toBe("");
  });

  it("supports an ASCII-safe presentation", () => {
    const summary = formatWorkflowPlanSummary(makeProjection(), {
      ascii: true,
    });
    const rows = formatWorkflowPlanRows(makeProjection(), { ascii: true });
    expect(
      [...summary, ...rows.flatMap((row) => [...row.text])].every(
        (char) => char.charCodeAt(0) < 128,
      ),
    ).toBe(true);
    expect(rows[0]!.text).toBe("* phase: Prepare [sequence]");
    expect(rows.find((row) => row.taskId === "task-success")!.text).toContain(
      "OK",
    );
  });

  it("handles empty and impossible runtime shapes without throwing", () => {
    expect(formatWorkflowPlanSummary({} as WorkflowPlanProjection)).toContain(
      "0/0 complete",
    );
    expect(
      formatWorkflowPlanRows({
        phases: [null, { tasks: null }],
      } as unknown as WorkflowPlanProjection),
    ).toEqual([{ depth: 0, text: "◆ phase: phase [sequence]" }]);
    expect(
      formatWorkflowPlanRows(null as unknown as WorkflowPlanProjection),
    ).toEqual([]);
  });

  it("does not mutate the projection", () => {
    const projection = makeProjection();
    const before = JSON.stringify(projection);
    formatWorkflowPlanSummary(projection, { width: 30, ascii: true });
    formatWorkflowPlanRows(projection, { width: 30, ascii: true });
    expect(JSON.stringify(projection)).toBe(before);
  });
});
