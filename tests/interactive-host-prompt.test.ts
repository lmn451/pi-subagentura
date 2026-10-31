import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { importFresh } from "./test-utils";

function emittedPrompt(flag?: string): string {
  vi.stubEnv("PI_SUBAGENTURA_CHILD", undefined);
  vi.stubEnv("PI_ORCHESTRATOR_ROUTER", undefined);
  const callbacks: Array<[string, Function]> = [];
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn((name: string) => name === flag),
    on: vi.fn((name: string, handler: Function) => {
      callbacks.push([name, handler]);
    }),
  };
  registerExtension(api as never);
  const handler = callbacks.find(
    ([name]) => name === "before_agent_start",
  )?.[1];
  expect(handler).toBeDefined();
  return handler?.({ systemPrompt: "base prompt" }, {})?.systemPrompt ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shared interactive host guidance", () => {
  it.each([undefined, "orchestrator", "orchestratorv2"])(
    "is available in %s mode",
    (flag) => {
      const prompt = emittedPrompt(flag);
      expect(prompt).toContain("## Host-aware interactive agent launches");
      expect(
        prompt.split("## Host-aware interactive agent launches"),
      ).toHaveLength(2);
    },
  );

  it("keeps explicit multiplexer selection separate from host discovery", () => {
    const prompt = emittedPrompt();
    expect(prompt).toContain("Preserve an explicit `mux` choice");
    expect(prompt).toContain(
      "Do not infer or override `mux` from host markers",
    );
    expect(prompt).toContain("verify the current caller and terminal topology");
  });

  it("documents supported Orca and Agterm host launch paths", () => {
    const prompt = emittedPrompt();
    expect(prompt).toContain("orca-cli");
    expect(prompt).toContain("orchestration");
    expect(prompt).toContain("session new --command");
    expect(prompt).toContain("agtermctl msg");
    expect(prompt).toContain("`session type` is not a launcher");
  });

  it("includes the shared guidance in native interactive child prompts", async () => {
    const { buildChildSubagentProtocol } = await importFresh<
      typeof import("../src/interactive-tmux")
    >("../src/interactive-tmux");
    const protocol = buildChildSubagentProtocol("/tmp/child-artifacts");

    expect(protocol).toContain("## Host-aware interactive agent launches");
  });
});
