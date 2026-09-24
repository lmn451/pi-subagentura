import { describe, expect, it } from "vitest";
import {
  FAILURE_CODES,
  failureGuidance,
  formatFailureGuidance,
  normalizeFailureCode,
  failureCodeFromArtifactEvent,
  formatProcessExitContext,
  isFailureCode,
  failureCodeFromArtifactEvents,
  processExitContextFromArtifactEvents,
} from "../src/diagnostics";

describe("structured failure diagnostics", () => {
  it.each(FAILURE_CODES)("provides local guidance for %s", (code) => {
    const guidance = failureGuidance(code);
    expect(guidance.label.length).toBeGreaterThan(0);
    expect(guidance.explanation.length).toBeGreaterThan(0);
    expect(guidance.action.length).toBeGreaterThan(0);
    expect(formatFailureGuidance(code)).toContain(guidance.action);
  });

  it("maps untrusted values to static unknown guidance", () => {
    const privateText = "Bearer secret /private/project/custom-tool";
    expect(normalizeFailureCode(privateText)).toBe("unknown");
    expect(formatFailureGuidance(privateText)).not.toContain(privateText);
    expect(formatFailureGuidance(privateText)).toBe(
      formatFailureGuidance("unknown"),
    );
  });

  it("keeps the runtime failure-code allowlist immutable", () => {
    const privateCode = "private_customer_failure_code";
    expect(Object.isFrozen(FAILURE_CODES)).toBe(true);
    expect(() =>
      (FAILURE_CODES as unknown as string[]).push(privateCode),
    ).toThrow();
    expect(isFailureCode(privateCode)).toBe(false);
    expect(normalizeFailureCode(privateCode)).toBe("unknown");
  });

  it("classifies structured event sources without reading raw messages", () => {
    expect(
      failureCodeFromArtifactEvent({
        type: "completion",
        source: "process_exit",
        outcome: "error",
        message: "private provider text",
      }),
    ).toBe("interactive_process_exit");
    expect(
      failureCodeFromArtifactEvent({
        type: "completion",
        source: "agent_settled",
        outcome: "error",
        agentStopReason: "error",
        errorMessage: "private provider text",
      }),
    ).toBe("provider_error");
    expect(
      failureCodeFromArtifactEvent({
        type: "completion",
        source: "explicit",
        outcome: "error",
        errorMessage: "private provider text",
      }),
    ).toBe("unknown");
    expect(
      failureCodeFromArtifactEvent({
        type: "process_exited",
        status: "done",
        processExitPhase: "active_tool",
        processExitKind: "unknown",
      }),
    ).toBe("interactive_process_exit");
    expect(
      failureCodeFromArtifactEvent({
        type: "process_exited",
        status: "error",
        processExitPhase: "after_completion",
        processExitKind: "nonzero",
      }),
    ).toBe("interactive_process_exit");
    expect(
      failureCodeFromArtifactEvent({
        type: "process_exited",
        status: "done",
        processExitPhase: "after_completion",
        processExitKind: "normal",
      }),
    ).toBeUndefined();
    expect(
      failureCodeFromArtifactEvent({
        type: "completion",
        source: "parent",
        outcome: "cancelled",
      }),
    ).toBeUndefined();
  });

  it("formats only allowlisted process-exit context", () => {
    const rendered = formatProcessExitContext({
      type: "process_exited",
      status: "done",
      terminationReason: "active_tool",
      processExitPhase: "active_tool",
      processExitKind: "unknown",
      lastTool: "private-tool-name",
      errorMessage: "Bearer private-token",
    });
    expect(rendered).toBe(
      "Process context: terminationReason=active_tool, processExitPhase=active_tool, processExitKind=unknown",
    );
    expect(rendered).not.toContain("private-tool-name");
    expect(rendered).not.toContain("private-token");
    expect(
      formatProcessExitContext({
        type: "process_exited",
        terminationReason: "private-reason",
        processExitPhase: "private-tool",
        processExitKind: "private-kind",
      }),
    ).toBeUndefined();
  });

  it("selects failure and process context from the latest observed turn", () => {
    const oldProviderError = {
      type: "completion",
      turnId: "old-turn",
      status: "error",
      outcome: "error",
      source: "agent_settled",
      agentStopReason: "error",
    };
    const newTurn = {
      type: "turn_started",
      turnId: "new-turn",
      status: "running",
    };
    expect(
      failureCodeFromArtifactEvents([oldProviderError, newTurn]),
    ).toBeUndefined();
    expect(
      processExitContextFromArtifactEvents([oldProviderError, newTurn]),
    ).toBeUndefined();

    const cancelledTurn = {
      type: "completion",
      turnId: "new-turn",
      status: "cancelled",
      outcome: "cancelled",
      source: "parent",
    };
    expect(
      failureCodeFromArtifactEvents([oldProviderError, newTurn, cancelledTurn]),
    ).toBeUndefined();

    const successfulCompletion = {
      type: "completion",
      turnId: "completed-turn",
      status: "done",
      outcome: "done",
      source: "agent_settled",
    };
    const laterNonzeroExit = {
      type: "process_exited",
      turnId: "completed-turn",
      status: "error",
      exitCode: 17,
      terminationReason: "nonzero_exit",
      processExitPhase: "after_completion",
      processExitKind: "nonzero",
    };
    expect(
      failureCodeFromArtifactEvents([successfulCompletion, laterNonzeroExit]),
    ).toBe("interactive_process_exit");
    expect(
      processExitContextFromArtifactEvents([
        successfulCompletion,
        laterNonzeroExit,
      ]),
    ).toBe(
      "Process context: terminationReason=nonzero_exit, processExitPhase=after_completion, processExitKind=nonzero",
    );
  });
});
