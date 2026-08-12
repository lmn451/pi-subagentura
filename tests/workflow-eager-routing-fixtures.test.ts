import { describe, expect, it } from "vitest";
import { decideWorkflowEagerRequest } from "../src/workflow-eager-policy";

const DIRECT_FIXTURES = [
  "Fix the typo in src/help.ts.",
  "Run the focused parser test.",
  "Update the package version.",
  "Remove the unused import.",
  "Add a null check to parseConfig.",
  "Why is the build failing?",
  "Explain how the dispatcher works.",
  "Thanks for your help!",
  "Draft an implementation plan only; do not make changes.",
  "Wait for my confirmation before making changes.",
  "/workflow-status",
  "Resume the active workflow.",
  "The parser currently has three stages.",
] as const;

const ROUTED_FIXTURES = [
  "Implement the parser migration and add regression tests.",
  "Refactor the store and then update every caller.",
  "First, audit the protocol. Then, fix the race. Finally, verify recovery.",
  "Complete this in two phases: implement the codec, then migrate callers.",
  [
    "Prepare the release:",
    "1. Update package metadata",
    "2. Run compatibility checks",
  ].join("\n"),
  [
    "Migrate the API:",
    "- Add the replacement endpoint",
    "- Update all consumers",
  ].join("\n"),
] as const;

describe("workflow eager routing quality fixtures", () => {
  it("has no preferred-mode false positives in the direct fixture set", () => {
    const routed = DIRECT_FIXTURES.filter(
      (prompt) => decideWorkflowEagerRequest(prompt, "preferred").route,
    );

    expect({ total: DIRECT_FIXTURES.length, falsePositives: routed }).toEqual({
      total: 13,
      falsePositives: [],
    });
  });

  it("routes every explicit multi-slice fixture in preferred mode", () => {
    const missed = ROUTED_FIXTURES.filter(
      (prompt) => !decideWorkflowEagerRequest(prompt, "preferred").route,
    );

    expect({ total: ROUTED_FIXTURES.length, missed }).toEqual({
      total: 6,
      missed: [],
    });
  });

  it("retains mandatory suppressions in always mode", () => {
    const mandatory = DIRECT_FIXTURES.slice(5, 12);
    const routed = mandatory.filter(
      (prompt) => decideWorkflowEagerRequest(prompt, "always").route,
    );

    expect(routed).toEqual([]);
  });
});
