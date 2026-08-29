/**
 * Tests for src/rendering.ts — TUI rendering helpers.
 *
 * Covers every code path in:
 *   - renderSubagentCall
 *   - renderSubagentResult (async spawn, partial, final — error/success/usage,
 *     collapsed/expanded)
 *   - renderSubagentNotify (inject/error/success, collapsed/expanded)
 *   - formatActivityRow (with/without lastActivityAt, with/without lastToolSummary)
 *   - renderAsyncSpawn
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────

const { Text: MockText, truncateToWidthMock } = vi.hoisted(() => {
  class Text {
    text: string;
    paddingX: number;
    paddingY: number;
    constructor(text = "", paddingX = 1, paddingY = 1) {
      this.text = text;
      this.paddingX = paddingX;
      this.paddingY = paddingY;
    }
  }
  return {
    Text,
    truncateToWidthMock: vi.fn((s: string, _w: number) => s),
  };
});

const { formatUsageMock, sanitizeOutputMock } = vi.hoisted(() => ({
  formatUsageMock: vi.fn(() => ""),
  sanitizeOutputMock: vi.fn((s: string) => s),
}));

// ── Module mocks ─────────────────────────────────────────

vi.mock("@earendil-works/pi-tui", () => ({
  Text: MockText,
  truncateToWidth: truncateToWidthMock,
  visibleWidth: (text: string) => text.length,
}));

vi.mock("../src/helpers", () => ({
  formatUsage: formatUsageMock,
}));

vi.mock("../src/notifications", () => ({
  sanitizeOutput: sanitizeOutputMock,
}));

// ── Imports after mocks ──────────────────────────────────

import type { Text } from "@earendil-works/pi-tui";
import {
  renderSubagentCall,
  renderSubagentResult,
  renderAsyncSpawn,
  renderSubagentNotify,
  formatActivityRow,
  coarseElapsedMs,
  ACTIVITY_ELAPSED_BUCKET_MS,
} from "../src/rendering";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────

/**
 * Extract the rendered text from a Text object.
 * The real `Text` class declares `text` as private, but our mock
 * exposes it as a public property. This cast lets tests assert on it.
 */
function t(t: Text): string {
  return (t as unknown as { text: string }).text;
}

// ── Theme mock ───────────────────────────────────────────
// Identity functions: fg and bold return the text as-is so we
// can assert on the composed string without ANSI noise.

const testTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

// ── Shared fixtures ──────────────────────────────────────

const sampleUsage = {
  input: 100,
  output: 50,
  cacheRead: 10,
  cacheWrite: 5,
  cost: 0.002,
  turns: 1,
};

// ── Tests ────────────────────────────────────────────────

describe("renderSubagentCall", () => {
  it("renders a basic call with task label and task preview", () => {
    const result = renderSubagentCall(
      { task: "Hello world" },
      testTheme,
      "subagent_with_context",
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("subagent_with_context Hello world");
  });

  it("truncates the task preview when longer than 60 chars", () => {
    const longTask = "a".repeat(70);
    const result = renderSubagentCall(
      { task: longTask },
      testTheme,
      "subagent_isolated",
    );
    expect(t(result)).toBe("subagent_isolated " + "a".repeat(57) + "\u2026");
  });

  it("appends the model tag when args.model is set", () => {
    const result = renderSubagentCall(
      { task: "analyze", model: "anthropic/claude-sonnet-4-5" },
      testTheme,
      "subagent_with_context",
    );
    expect(t(result)).toBe(
      "subagent_with_context analyze @anthropic/claude-sonnet-4-5",
    );
  });

  it("renders the requested thinking level beside the model", () => {
    const result = renderSubagentCall(
      {
        task: "analyze",
        model: "anthropic/claude-sonnet-4-5",
        thinkingLevel: "high",
      },
      testTheme,
      "subagent_with_context",
    );
    expect(t(result)).toBe(
      "subagent_with_context analyze @anthropic/claude-sonnet-4-5 · thinking: high",
    );
  });

  it("appends the [async] badge when args.async is truthy", () => {
    const result = renderSubagentCall(
      { task: "analyze", async: true },
      testTheme,
      "subagent_with_context",
    );
    expect(t(result)).toBe("subagent_with_context analyze [async]");
  });

  it("renders model tag and async badge simultaneously", () => {
    const result = renderSubagentCall(
      { task: "deep research", model: "openai/o3", async: true },
      testTheme,
      "subagent_isolated",
    );
    expect(t(result)).toBe(
      "subagent_isolated deep research @openai/o3 [async]",
    );
  });

  it("handles missing task gracefully", () => {
    const result = renderSubagentCall(
      {} as Record<string, unknown>,
      testTheme,
      "subagent_with_context",
    );
    expect(t(result)).toBe("subagent_with_context ");
  });
});

describe("renderSubagentResult", () => {
  beforeEach(() => {
    formatUsageMock.mockReturnValue("");
    truncateToWidthMock.mockImplementation((s: string) => s);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Async spawn ───────────────────────────────────────

  it("renders async spawn result when details.status === 'started'", () => {
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "started" as const,
          jobId: "job-42",
          contextMessages: 5,
        },
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toMatch(/⚡ Sub-agent started — job job-42/);
    expect(t(result)).toMatch(/get_subagent_status/);
  });

  it("renders the requested thinking level for an interactive spawn result", () => {
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "started" as const,
          jobId: "job-43",
          contextMessages: 0,
          thinkingLevel: "high",
        },
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(t(result)).toContain("· thinking: high");
  });
  it("renders the effective thinking level in a partial result", () => {
    formatUsageMock.mockReturnValue("~1.0K tokens gpt-4");
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          model: "gpt-4",
          thinkingLevel: "low",
          subagentStatus: {
            turn: 1,
            output: "progress",
            usage: sampleUsage,
            thinkingLevel: "low",
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(t(result)).toContain("· thinking: low");
  });

  // ── Partial / running ─────────────────────────────────

  it("renders partial result with turn, active tool, usage, and output", () => {
    formatUsageMock.mockReturnValue("~1.0K tokens");
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          model: "gpt-4",
          subagentStatus: {
            turn: 3,
            activeTool: { name: "read", args: { path: "foo.ts" } },
            output: "some progress output here",
            usage: sampleUsage,
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    // Title
    expect(t(result)).toContain("\u25cf");
    expect(t(result)).toContain("Sub-agent working");
    // Turn
    expect(t(result)).toContain("\u2014 turn 3");
    // Active tool
    expect(t(result)).toContain("\u2192");
    expect(t(result)).toContain("read");
    expect(t(result)).toContain('{"path":"foo.ts"}');
    // Usage
    expect(t(result)).toContain("~1.0K tokens");
    // Output preview
    expect(t(result)).toContain("some progress output here");
    // Model was forwarded to formatUsage
    expect(formatUsageMock).toHaveBeenCalledWith(sampleUsage, "gpt-4");
    // truncateToWidth was called for the output preview
    expect(truncateToWidthMock).toHaveBeenCalledWith(
      "some progress output here",
      120,
    );
  });

  it("renders partial result with active tool and unserializable args (circular)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          subagentStatus: {
            turn: 1,
            activeTool: { name: "crashy", args: circular },
            output: "",
            usage: sampleUsage,
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    // Circular args fall back to "{…}"
    expect(t(result)).toContain("{…}");
    expect(t(result)).not.toContain("self");
  });

  it("renders partial result without activeTool (only turn and output)", () => {
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          subagentStatus: {
            turn: 2,
            output: "interim",
            usage: sampleUsage,
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u2014 turn 2");
    expect(t(result)).toContain("interim");
    // No tool arrow
    expect(t(result)).not.toContain("\u2192");
  });

  it("renders partial result without formatUsage return value", () => {
    formatUsageMock.mockReturnValue("");
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          subagentStatus: {
            turn: 1,
            output: "data",
            usage: sampleUsage,
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    // Usage string is empty, so no usage line
    expect(t(result)).not.toMatch(/tokens|cache|cost/i);
  });

  it("renders partial result without status details (falls back to …)", () => {
    const result = renderSubagentResult(
      {
        content: [],
        details: { status: "running" as const },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u25cf");
    expect(t(result)).toContain("Sub-agent working");
    expect(t(result)).toContain("\u2026");
  });

  it("renders partial result with empty output preview (output line skipped)", () => {
    const result = renderSubagentResult(
      {
        content: [],
        details: {
          status: "running" as const,
          subagentStatus: {
            turn: 1,
            activeTool: { name: "compute", args: {} },
            output: "",
            usage: sampleUsage,
          },
        },
      },
      { expanded: false, isPartial: true },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u2014 turn 1");
    expect(t(result)).toContain("\u2192");
    expect(t(result)).toContain("compute");
    // Empty output should not append a separate output line after tool args
    expect(t(result)).toMatch(/\{\}$/);
  });

  // ── Final result: error ───────────────────────────────

  it("renders final error result collapsed (truncated preview)", () => {
    const errorText = "Something went wrong: ".repeat(10);
    truncateToWidthMock.mockReturnValue("truncated-error");
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: errorText }],
        details: undefined as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("truncated-error");
    expect(truncateToWidthMock).toHaveBeenCalledWith(
      errorText.replace(/\s+/g, " "),
      120,
    );
  });

  it("renders final error result expanded (full text)", () => {
    const errorText = "Fatal: authentication failed";
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: errorText }],
        details: undefined as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe(errorText);
  });

  // ── Final result: success with usageStr ───────────────

  it("renders final success result with usage collapsed (header only)", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "This is the full output." }],
        details: { usageSummary: "~1.5K tokens" },
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    // Only the header (✓ + usage) — no output body
    expect(t(result)).toBe("\u2713 ~1.5K tokens");
  });

  it("renders the effective thinking level in a final result", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: {
          usageSummary: "~1.5K tokens gpt-4",
          thinkingLevel: "low",
        },
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(t(result)).toBe("✓ ~1.5K tokens gpt-4 · thinking: low");
  });

  it("renders final success result with usage expanded (header + full text)", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "Full output here.\nLine 2." }],
        details: { usageSummary: "~2.0K tokens" },
      },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("\u2713 ~2.0K tokens\nFull output here.\nLine 2.");
  });

  // ── Final result: success without usageStr ────────────

  it("renders final success result without usage collapsed (dimmed preview)", () => {
    truncateToWidthMock.mockReturnValue("preview-text");
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "Some long final output" }],
        details: {} as Record<string, unknown>,
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("preview-text");
    expect(truncateToWidthMock).toHaveBeenCalledWith(
      "Some long final output".replace(/\s+/g, " "),
      120,
    );
  });

  it("renders final success result without usage expanded (full text)", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "Full output body" }],
        details: {} as Record<string, unknown>,
      },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("Full output body");
  });

  // ── Edge cases ────────────────────────────────────────

  it("handles empty text content (no text-type items)", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "image", text: "img.png" }] as any,
        details: {} as Record<string, unknown>,
      },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("");
  });

  it("handles empty content array", () => {
    const result = renderSubagentResult(
      { content: [], details: {} as Record<string, unknown> },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("");
  });

  it("renders final error with empty text", () => {
    truncateToWidthMock.mockReturnValue("");
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "" }],
        details: undefined as unknown as Record<string, unknown>,
        isError: true,
      },
      { expanded: false, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("");
  });

  it("renders final success with usage and empty text expanded", () => {
    const result = renderSubagentResult(
      {
        content: [{ type: "text", text: "" }],
        details: { usageSummary: "~0 tokens" },
      },
      { expanded: true, isPartial: false },
      testTheme,
      undefined,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("\u2713 ~0 tokens\n");
  });
});

describe("renderAsyncSpawn", () => {
  it("renders the compact async spawn display with job id and hint", () => {
    const result = renderAsyncSpawn(
      { status: "started", jobId: "abc12345", contextMessages: 3 },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toMatch(/⚡ Sub-agent started — job abc12345/);
    expect(t(result)).toMatch(/get_subagent_status/);
  });
});

describe("renderSubagentNotify", () => {
  beforeEach(() => {
    sanitizeOutputMock.mockImplementation((s: string) => s);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Collapsed ─────────────────────────────────────────

  it("renders collapsed inject mode notification", () => {
    const result = renderSubagentNotify(
      {
        content: "Sub-agent completed",
        details: {
          mode: "inject",
          result: { isError: false, output: "" },
        },
      },
      { expanded: false },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("Sub-agent completed");
  });

  it("renders collapsed error notification in error color", () => {
    const result = renderSubagentNotify(
      {
        content: "Something failed",
        details: {
          mode: "notify",
          result: { isError: true, output: "error details" },
        },
      },
      { expanded: false },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("Something failed");
  });

  it("renders collapsed success notification in accent color", () => {
    const result = renderSubagentNotify(
      {
        content: "All done",
        details: {
          mode: "notify",
          result: { isError: false },
        },
      },
      { expanded: false },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("All done");
  });

  it("renders collapsed notification when details is undefined", () => {
    const result = renderSubagentNotify(
      { content: "Just a message" },
      { expanded: false },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toBe("Just a message");
  });

  // ── Expanded ──────────────────────────────────────────

  it("renders expanded inject notification with header, body, and sanitized output", () => {
    sanitizeOutputMock.mockReturnValue("sk-...[REDACTED]");
    const result = renderSubagentNotify(
      {
        content: "Result injected above",
        details: {
          mode: "inject",
          result: { isError: false, output: "sk-abc123def456" },
        },
      },
      { expanded: true },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u26a1 Injected Sub-agent Result");
    expect(t(result)).toContain("Result injected above");
    expect(t(result)).toContain("sk-...[REDACTED]");
    expect(sanitizeOutputMock).toHaveBeenCalledWith("sk-abc123def456");
  });

  it("renders expanded error notification with error header", () => {
    sanitizeOutputMock.mockReturnValue("error trace");
    const result = renderSubagentNotify(
      {
        content: "Task crashed",
        details: {
          mode: "notify",
          result: { isError: true, output: "error trace" },
        },
      },
      { expanded: true },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u274c Sub-agent Failed");
    expect(t(result)).toContain("Task crashed");
    expect(t(result)).toContain("error trace");
  });

  it("renders expanded success notification with success header", () => {
    sanitizeOutputMock.mockReturnValue("all good");
    const result = renderSubagentNotify(
      {
        content: "Completed",
        details: {
          mode: "notify",
          result: { isError: false, output: "all good" },
        },
      },
      { expanded: true },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u2705 Sub-agent Completed");
    expect(t(result)).toContain("Completed");
    expect(t(result)).toContain("all good");
  });

  it("renders expanded notification with missing output (falls back to empty)", () => {
    sanitizeOutputMock.mockReturnValue("");
    const result = renderSubagentNotify(
      {
        content: "Done",
        details: {
          mode: "notify",
          result: { isError: false },
        },
      },
      { expanded: true },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("\u2705 Sub-agent Completed");
    expect(t(result)).toContain("Done");
    // Output is empty string; the expanded template ends with a trailing newline
    expect(t(result)).toMatch(/\n$/);
  });

  it("renders expanded notification when details is undefined", () => {
    const result = renderSubagentNotify(
      { content: "Bare notification" },
      { expanded: true },
      testTheme,
    );
    expect(result).toBeInstanceOf(MockText);
    // details is undefined → isInject=false, isError=undefined (falsy)
    // → success header, body is text, output is sanitizeOutput("") = ""
    expect(t(result)).toContain("\u2705 Sub-agent Completed");
    expect(t(result)).toContain("Bare notification");
  });
});

describe("formatActivityRow", () => {
  it("formats a row with the latest activity summary and a coarse clock", () => {
    const result = formatActivityRow(
      {
        lastActivityAt: 3000,
        lastToolSummary: "reading main.ts",
        name: "helper-1",
        id: "x",
        task: "",
        paneId: "",
        sessionFile: "",
        cwd: "",
        startedAt: 0,
        status: "running",
        mux: "tmux",
        attachCommand: "",
        selectPaneCommand: "",
        launchScriptFile: "",
        artifactDir: "",
      },
      33_000,
    );
    expect(result).toBe("▶ helper-1: reading main.ts (30s ago)");
  });

  it("keeps the row byte-identical inside one coarse bucket and changes across it", () => {
    const state = {
      lastActivityAt: 1_000,
      lastToolSummary: "reading main.ts",
      name: "helper-bucket",
      id: "x",
      task: "",
      paneId: "",
      sessionFile: "",
      cwd: "",
      startedAt: 0,
      status: "running" as const,
      mux: "tmux" as const,
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
      artifactDir: "",
    };

    // Sub-bucket elapsed reads as "just now" and never changes mid-bucket, so
    // the poller's memoized setWidget suppresses the repaint.
    expect(formatActivityRow(state, 1_500)).toBe(
      formatActivityRow(state, 1_000 + ACTIVITY_ELAPSED_BUCKET_MS - 1),
    );
    expect(formatActivityRow(state, 1_500)).toBe(
      "▶ helper-bucket: reading main.ts (just now)",
    );
    expect(formatActivityRow(state, 1_000 + ACTIVITY_ELAPSED_BUCKET_MS)).toBe(
      formatActivityRow(state, 1_000 + 2 * ACTIVITY_ELAPSED_BUCKET_MS - 1),
    );
    expect(formatActivityRow(state, 1_000 + ACTIVITY_ELAPSED_BUCKET_MS)).toBe(
      "▶ helper-bucket: reading main.ts (10s ago)",
    );
    expect(formatActivityRow(state, 61_000)).toBe(
      "▶ helper-bucket: reading main.ts (1m ago)",
    );
    expect(formatActivityRow(state, 3_601_000)).toBe(
      "▶ helper-bucket: reading main.ts (1h ago)",
    );
  });

  it("clamps a clock skewed into the future to just now", () => {
    expect(coarseElapsedMs(-5_000)).toBe(0);
    expect(coarseElapsedMs(Number.NaN)).toBe(0);
  });

  it("renders idle agents as ready for follow-up without stale activity", () => {
    const result = formatActivityRow({
      name: "helper-idle",
      lastToolSummary: "stale tool",
      lastActivityAt: 3000,
      id: "x",
      task: "",
      paneId: "",
      sessionFile: "",
      cwd: "",
      startedAt: 0,
      status: "idle",
      mux: "tmux",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
      artifactDir: "",
    });
    expect(result).toBe("○ helper-idle: idle — ready for follow-up");
    expect(result).not.toContain("stale tool");
  });

  it("formats a running row without activity metadata", () => {
    const result = formatActivityRow({
      name: "helper-2",
      // No lastActivityAt: the row omits the clock entirely.
      lastToolSummary: "searching",
      id: "x",
      task: "",
      paneId: "",
      sessionFile: "",
      cwd: "",
      startedAt: 0,
      status: "running",
      mux: "tmux",
      attachCommand: "",
      selectPaneCommand: "",
      launchScriptFile: "",
      artifactDir: "",
    });
    expect(result).toBe("▶ helper-2: searching");
  });

  it("falls back to starting when no activity summary exists", () => {
    const result = formatActivityRow(
      {
        lastActivityAt: 8000,
        name: "helper-3",
        id: "x",
        task: "",
        paneId: "",
        sessionFile: "",
        cwd: "",
        startedAt: 0,
        status: "running",
        mux: "tmux",
        attachCommand: "",
        selectPaneCommand: "",
        launchScriptFile: "",
        artifactDir: "",
      },
      8000,
    );
    expect(result).toBe("▶ helper-3: starting… (just now)");
  });
});

describe("renderSubagentNotify protocol-v2 details", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders an expanded pointer completion with a success header", () => {
    const result = renderSubagentNotify(
      {
        content: "Artifact pointer",
        details: { mode: "notify", status: "done" },
      },
      { expanded: true },
      testTheme,
    );

    expect(result).toBeInstanceOf(MockText);
    expect(t(result)).toContain("✅ Sub-agent Completed");
    expect(t(result)).toContain("Artifact pointer");
  });

  it("renders protocol-v2 errors with the failure header", () => {
    const result = renderSubagentNotify(
      {
        content: "Error artifact pointer",
        details: { mode: "notify", status: "error", error: true },
      },
      { expanded: true },
      testTheme,
    );

    expect(t(result)).toContain("❌ Sub-agent Failed");
    expect(t(result)).toContain("Error artifact pointer");
  });

  it("joins text blocks in collapsed custom-message content", () => {
    const result = renderSubagentNotify(
      {
        content: [
          { type: "text", text: "Collapsed " },
          { type: "image" },
          { type: "text", text: "content" },
        ],
        details: { mode: "notify", status: "done" },
      },
      { expanded: false },
      testTheme,
    );

    expect(t(result)).toBe("Collapsed content");
  });
});
