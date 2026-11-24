import { describe, expect, it } from "vitest";
import {
  completionDisplayLabel,
  formatCompletionMessage,
} from "../src/completion-presentation";

describe("completion presentation", () => {
  it("starts notifications with the display label", () => {
    expect(
      formatCompletionMessage("workflow-lifecycle-review", "completed"),
    ).toBe("from: workflow-lifecycle-review, completed");
  });

  it("uses a bounded safe fallback for unnamed sources", () => {
    expect(formatCompletionMessage(undefined, "completed")).toBe(
      "from: sub-agent, completed",
    );
    expect(completionDisplayLabel("line one\nline two", "fallback")).toBe(
      "line one line two",
    );
    expect(completionDisplayLabel("x".repeat(500), "fallback").length).toBe(
      160,
    );
  });

  it("collapses adjacent control characters to one space", () => {
    expect(completionDisplayLabel("line one\n\u007fline two")).toBe(
      "line one line two",
    );
  });

  it("does not make duplicate labels part of source identity", () => {
    const first = formatCompletionMessage("reviewer", "first");
    const second = formatCompletionMessage("reviewer", "second");

    expect(first).toBe("from: reviewer, first");
    expect(second).toBe("from: reviewer, second");
  });
});
