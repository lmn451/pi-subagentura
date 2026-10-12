import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
});
