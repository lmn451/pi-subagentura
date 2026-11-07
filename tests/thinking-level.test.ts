/**
 * Behavioral tests for thinkingLevel propagation across sub-agent spawn surfaces.
 *
 * Verifies requested thinking levels on their user-visible execution surfaces.
 *
 * 1. Interactive subagent CLI command and spawn result
 * 2. Workflow agent() runner request
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// ---------------------------------------------------------------------------
// Test: buildPiInteractiveCommand includes --thinking flag (REAL function)
// ---------------------------------------------------------------------------

describe("buildPiInteractiveCommand thinkingLevel", () => {
  let buildPiInteractiveCommand: typeof import("../src/interactive-tmux.js").buildPiInteractiveCommand;

  beforeEach(async () => {
    const mod = await import("../src/interactive-tmux.js");
    buildPiInteractiveCommand = mod.buildPiInteractiveCommand;
  });

  it("includes --thinking flag when thinkingLevel is provided", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "high",
    });
    expect(command).toContain("--thinking 'high'");
  });

  it("omits --thinking flag when thinkingLevel is undefined", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
    });
    expect(command).not.toContain("--thinking");
  });

  it("omits --thinking flag when thinkingLevel is empty string", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "" as any,
    });
    expect(command).not.toContain("--thinking");
  });

  it.each(VALID_THINKING_LEVELS)(
    "includes --thinking for level: %s",
    (level) => {
      const command = buildPiInteractiveCommand({
        sessionFile: "/tmp/test-session.jsonl",
        name: "test-agent",
        promptFile: "/tmp/prompt.md",
        cwd: "/tmp",
        thinkingLevel: level,
      });
      expect(command).toContain(`--thinking '${level}'`);
    },
  );

  it("includes --thinking before the prompt file argument", () => {
    const command = buildPiInteractiveCommand({
      sessionFile: "/tmp/test-session.jsonl",
      name: "test-agent",
      promptFile: "/tmp/prompt.md",
      cwd: "/tmp",
      thinkingLevel: "low",
    });
    const thinkingIdx = command.indexOf("--thinking");
    const promptIdx = command.indexOf("@/tmp/prompt.md");
    expect(thinkingIdx).toBeLessThan(promptIdx);
  });
});

vi.mock("../src/interactive-tmux", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/interactive-tmux")>();
  return {
    ...actual,
    isTmuxAvailable: () => false,
  };
});

import { registerInteractiveSubagentTools } from "../src/tools/interactive";
import { createTestSessionScope } from "./session-scope-fixture";

describe("interactive subagent thinkingLevel rendering", () => {
  it("renders the requested thinking level in the spawn result", () => {
    const api = { registerTool: vi.fn() };
    registerInteractiveSubagentTools(
      api as any,
      createTestSessionScope({ pi: api as any }),
    );
    const toolDef = api.registerTool.mock.calls.find(
      ([tool]: any[]) => tool.name === "subagent_interactive",
    )?.[0];
    const theme = {
      fg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    };

    toolDef.renderResult(
      {
        content: [{ type: "text", text: "started" }],
        details: { id: "agent-1", paneId: "%1", thinkingLevel: "high" },
      },
      {},
      theme,
    );

    expect(theme.fg).toHaveBeenCalledWith(
      "dim",
      expect.stringContaining("thinking: high"),
    );
  });
});

// ---------------------------------------------------------------------------
// Test: Workflow agent() passes thinkingLevel to runner
// ---------------------------------------------------------------------------

describe("workflow agent thinkingLevel propagation", () => {
  it("agent() with thinkingLevel passes it to the runner", async () => {
    const { runWorkflow } = await import("../src/workflow");

    let capturedReq: any = null;
    const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
      async (req) => {
        capturedReq = req;
        return {
          isError: false,
          output: "result",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: "test/model",
        };
      };

    const meta = `export const meta = { name: "test", description: "test workflow" };`;
    const body = `return await agent("hello", { thinkingLevel: "high" });`;

    await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

    expect(capturedReq).not.toBeNull();
    expect(capturedReq.thinkingLevel).toBe("high");
  });

  it("agent() without thinkingLevel omits it from runner request", async () => {
    const { runWorkflow } = await import("../src/workflow");

    let capturedReq: any = null;
    const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
      async (req) => {
        capturedReq = req;
        return {
          isError: false,
          output: "result",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            turns: 1,
          },
          model: "test/model",
        };
      };

    const meta = `export const meta = { name: "test", description: "test workflow" };`;
    const body = `return await agent("hello");`;

    await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

    expect(capturedReq).not.toBeNull();
    expect(capturedReq.thinkingLevel).toBeUndefined();
  });

  it("agent() with all thinkingLevel values passes correctly", async () => {
    const { runWorkflow } = await import("../src/workflow");

    for (const level of VALID_THINKING_LEVELS) {
      let capturedReq: any = null;
      const mockRunner: import("../src/workflow-core.js").WorkflowAgentRunner =
        async (req) => {
          capturedReq = req;
          return {
            isError: false,
            output: "result",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 1,
            },
            model: "test/model",
          };
        };

      const meta = `export const meta = { name: "test", description: "test workflow" };`;
      const body = `return await agent("hello", { thinkingLevel: "${level}" });`;

      await runWorkflow(meta + "\n" + body, { runAgent: mockRunner });

      expect(capturedReq.thinkingLevel).toBe(level);
    }
  });
});
