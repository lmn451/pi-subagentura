import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { importFresh } from "./test-utils";
import { registerToolWithDefaultGuidance } from "../src/tool-guidance";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("tool call parameter rendering", () => {
  it("shows extension tool parameters only when the call is expanded", () => {
    const pi = { registerTool: vi.fn() } as any;
    registerToolWithDefaultGuidance(pi, {
      name: "list_available_models",
      label: "List Available Models",
      description: "List models",
      parameters: Type.Object({ filter: Type.Optional(Type.String()) }),
      execute: vi.fn(),
      renderCall: () => new Text("List Available Models", 0, 0),
    });
    const tool = pi.registerTool.mock.calls[0]![0];
    const args = { filter: "openai" };
    const render = (expanded: boolean) =>
      tool
        .renderCall(args, theme, { expanded })
        .render(80)
        .join("\n")
        .trimEnd();

    expect(render(false)).toBe("List Available Models");
    expect(render(true)).toContain('"filter": "openai"');
  });

  it("shows arguments for tools without a custom call renderer", () => {
    const pi = { registerTool: vi.fn() } as any;
    registerToolWithDefaultGuidance(pi, {
      name: "get_subagent_status",
      label: "Get Subagent Status",
      description: "Get status",
      parameters: Type.Object({ jobId: Type.String() }),
      execute: vi.fn(),
    });
    const tool = pi.registerTool.mock.calls[0]![0];

    expect(
      tool
        .renderCall({ jobId: "abc123" }, theme, { expanded: true })
        .render(80)
        .join("\n"),
    ).toContain('"jobId": "abc123"');
  });
  it("logs tool names and parameters when debug logging is enabled", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "subagentura-tool-log-"));
    const priorLogDir = process.env.SUBAGENT_DEBUG_LOG_DIR;
    process.env.SUBAGENT_DEBUG_LOG_DIR = logDir;
    try {
      const { registerToolWithDefaultGuidance: registerTool } =
        await importFresh<typeof import("../src/tool-guidance")>(
          "../src/tool-guidance",
        );
      const pi = { registerTool: vi.fn() } as any;
      registerTool(pi, {
        name: "list_available_models",
        label: "List Available Models",
        description: "List models",
        parameters: Type.Object({ filter: Type.String() }),
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        }),
      });
      const tool = pi.registerTool.mock.calls[0]![0];
      const args = { filter: "openai" };
      await tool.execute("call-1", args, undefined, undefined, {});

      const logFile = readdirSync(logDir).find((file) =>
        file.endsWith(".jsonl"),
      );
      expect(logFile).toBeDefined();
      const entries = readFileSync(join(logDir, logFile!), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toContainEqual(
        expect.objectContaining({
          event: "extension_tool_call",
          toolName: "list_available_models",
          args,
        }),
      );
    } finally {
      if (priorLogDir === undefined) delete process.env.SUBAGENT_DEBUG_LOG_DIR;
      else process.env.SUBAGENT_DEBUG_LOG_DIR = priorLogDir;
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
