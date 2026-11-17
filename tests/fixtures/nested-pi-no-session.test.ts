import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it, expect, vi } from "vitest";
import registerExtension from "../../src/subagent";
import { CHILD_ARTIFACT_BOOTSTRAP_ENV } from "../../src/child-artifact-ownership";

const inheritedArtifactDir = process.env.ARTIFACT_DIR;
const inheritedBootstrap = process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV];
const nestedPiTest = it.skipIf(!inheritedArtifactDir);

nestedPiTest("keeps artifact hooks bound to this process's credential", () => {
  expect(process.env.NESTED_PI_NO_SESSION).toBe("1");
  expect(process.env.PI_SUBAGENTURA_CHILD).toBe("1");
  const artifactDir = inheritedArtifactDir!;

  const hooks = new Map<string, Function[]>();
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn().mockReturnValue(false),
    on: vi.fn((name: string, handler: Function) => {
      const handlers = hooks.get(name) ?? [];
      handlers.push(handler);
      hooks.set(name, handlers);
    }),
  };
  const entries: unknown[] = [];
  const context = { sessionManager: { getEntries: () => entries } };

  registerExtension(api as never);
  for (const handler of hooks.get("before_agent_start") ?? []) {
    handler({ systemPrompt: "base prompt" }, context);
  }

  if (!inheritedBootstrap) {
    expect(hooks.has("turn_start")).toBe(false);
    expect(hooks.has("before_provider_request")).toBe(false);
    expect(hooks.has("tool_execution_start")).toBe(false);
    expect(hooks.has("tool_execution_end")).toBe(false);
    expect(hooks.has("agent_end")).toBe(false);
    expect(readFileSync(`${artifactDir}/output.md`, "utf8")).toBe(
      "outer output",
    );
    expect(readFileSync(`${artifactDir}/active-turn.json`, "utf8")).toBe(
      "outer turn",
    );
    expect(readFileSync(`${artifactDir}/events.ndjson`, "utf8")).toBe(
      "outer events",
    );
    return;
  }

  expect(hooks.has("turn_start")).toBe(true);
  writeFileSync(`${artifactDir}/output.md`, "stale nested output");
  const turnContext = {
    sessionManager: { getEntries: () => entries },
  };
  for (const handler of hooks.get("before_agent_start") ?? []) {
    handler({ systemPrompt: "base prompt" }, turnContext);
  }
  entries.push({
    id: "nested-user",
    type: "message",
    message: { role: "user" },
  });
  for (const handler of hooks.get("turn_start") ?? []) {
    handler({ timestamp: 10 }, turnContext);
  }
  for (const handler of hooks.get("agent_end") ?? []) {
    handler(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      turnContext,
    );
  }
  for (const handler of hooks.get("agent_settled") ?? []) {
    handler({}, turnContext);
  }

  expect(readFileSync(`${artifactDir}/output.md`, "utf8")).toBe("");
  expect(
    JSON.parse(readFileSync(`${artifactDir}/active-turn.json`, "utf8")),
  ).toMatchObject({ turnId: "nested-user", started: true });
  const events = readFileSync(`${artifactDir}/events.ndjson`, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((event) => event.type === "completion")).toHaveLength(1);
  expect(events.filter((event) => event.type === "completion")).toMatchObject([
    { turnId: "nested-user", outcome: "done", source: "agent_settled" },
  ]);
  expect(existsSync(inheritedBootstrap)).toBe(false);
});
