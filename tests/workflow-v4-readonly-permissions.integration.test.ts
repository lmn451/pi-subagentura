import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { PiSessionHarness } from "./helpers/pi-session-harness";

import type { normalizeProviderContext } from "../src/pi-sdk-compat";

type ContextNormalizer = typeof normalizeProviderContext;

const repoRoot = new URL("..", import.meta.url).pathname;
const roots: string[] = [];
const harnesses: PiSessionHarness[] = [];
let normalizeProviderContextForTest: ContextNormalizer | undefined;
let restoreScopedEnvironment: (() => void) | undefined;
const READ_ONLY_SOURCE = 'export const source = "SDK_READ_ONLY_SOURCE";\n';

function toolNames(context: Context): string[] {
  const normalize = normalizeProviderContextForTest;
  if (!normalize)
    throw new Error("read-only SDK context normalizer was not loaded");
  return normalize(context).tools.map((tool) => tool.name);
}

function toolResult(context: Context, name: string) {
  const result = [...context.messages]
    .reverse()
    .find((entry) => entry.role === "toolResult" && entry.toolName === name);
  if (!result || result.role !== "toolResult")
    throw new Error(`no ${name} result in provider context`);
  return result;
}

async function waitForContexts(harness: PiSessionHarness, count: number) {
  await vi.waitFor(() => expect(harness.contexts).toHaveLength(count), {
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  restoreScopedEnvironment?.();
  restoreScopedEnvironment = undefined;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("read-only workflow agent SDK permissions", () => {
  it("retains the V4 read-only allowlist through the non-durable default process-to-SDK fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-readonly-fallback-"));
    roots.push(root);
    const privateHome = join(root, "home");
    const privateAgentDir = join(root, "pi-agent");
    mkdirSync(privateHome, { recursive: true, mode: 0o700 });
    mkdirSync(privateAgentDir, { recursive: true, mode: 0o700 });
    const previousHome = process.env.HOME;
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousMcpToolFlag = process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL;
    restoreScopedEnvironment = () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPiAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      if (previousMcpToolFlag === undefined)
        delete process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL;
      else process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL = previousMcpToolFlag;
    };
    process.env.HOME = privateHome;
    process.env.PI_CODING_AGENT_DIR = privateAgentDir;
    process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL = "1";
    writeFileSync(
      join(privateAgentDir, "settings.json"),
      JSON.stringify({
        extensions: [
          join(repoRoot, "tests/terminal-e2e/fixtures/mock-provider.ts"),
        ],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(privateAgentDir, "auth.json"),
      JSON.stringify({
        "subagentura-faux": { type: "api_key", key: "test" },
      }),
      { mode: 0o600 },
    );
    const [{ normalizeProviderContext }, { createPiSessionHarness }] =
      await Promise.all([
        import("../src/pi-sdk-compat"),
        import("./helpers/pi-session-harness"),
      ]);
    normalizeProviderContextForTest = normalizeProviderContext;
    const sourcePath = join(root, "source.ts");
    const forbiddenPath = join(root, "forbidden.txt");
    const mcpControlPath = join(root, "mcp-control.txt");
    const forbiddenMcpPath = join(root, "forbidden-mcp.txt");
    writeFileSync(sourcePath, READ_ONLY_SOURCE);
    const harness = await createPiSessionHarness(root, {
      extensionRoot: repoRoot,
      includeTools: true,
      bindExtensionLifecycle: true,
    });
    harnesses.push(harness);

    const script = `
      import { defineWorkflow, schema } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "readonly-fallback",
        version: 1,
        output: schema.object({ source: schema.string() }),
        run: async function(ctx) {
          await ctx.agent("mcp-control", {
            prompt: "Use the fake mutator to create the MCP control marker.",
            isolation: "in-process"
          });
          const options = {
            prompt: "Read source.ts and return its result.",
            readOnly: true,
            output: schema.object({ source: schema.string() })
          };
          const pending = ctx.agent("inspect-source", options);
          options.readOnly = false;
          return await pending;
        }
      });
    `;
    const run = harness.session.prompt("Run a read-only workflow agent.");
    await waitForContexts(harness, 1);
    expect(toolNames(harness.contexts[0])).toContain("workflow");

    const previousPath = process.env.PATH;
    process.env.PATH = join(root, "no-binaries");
    try {
      harness.completeNextTool("workflow", {
        script,
        async: false,
        durable: false,
      });
      await waitForContexts(harness, 2);
      const workflowToolResult = [...harness.contexts[1].messages]
        .reverse()
        .find(
          (message) =>
            message.role === "toolResult" && message.toolName === "workflow",
        );
      expect(
        toolNames(harness.contexts[1]),
        workflowToolResult
          ? JSON.stringify(workflowToolResult)
          : "No workflow toolResult in context[1].",
      ).toContain("mcp__e2e__mutate");
      harness.completeNextTool("mcp__e2e__mutate", {
        path: mcpControlPath,
        content: "SDK_MCP_CONTROL_SENTINEL",
      });
      await waitForContexts(harness, 3);
      expect(readFileSync(mcpControlPath, "utf8")).toBe(
        "SDK_MCP_CONTROL_SENTINEL",
      );
      harness.completeNext("SDK MCP control complete.");
      await waitForContexts(harness, 4);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(toolNames(harness.contexts[3]).sort()).toEqual([
      "find",
      "grep",
      "ls",
      "read",
    ]);
    harness.completeNextTool("read", { path: sourcePath });
    await waitForContexts(harness, 5);
    expect(
      JSON.stringify(toolResult(harness.contexts[4], "read").content),
    ).toContain("SDK_READ_ONLY_SOURCE");

    harness.completeNextTool("write", {
      path: forbiddenPath,
      content: "FORBIDDEN_WRITE",
    });
    await waitForContexts(harness, 6);
    expect(existsSync(forbiddenPath)).toBe(false);

    harness.completeNextTool("edit", {
      path: sourcePath,
      edits: [{ oldText: "SDK_READ_ONLY_SOURCE", newText: "FORBIDDEN_EDIT" }],
    });
    await waitForContexts(harness, 7);
    expect(readFileSync(sourcePath, "utf8")).toBe(READ_ONLY_SOURCE);

    harness.completeNextTool("bash", {
      command: `printf FORBIDDEN_BASH > '${sourcePath.replaceAll("'", "'\\''")}'`,
    });
    await waitForContexts(harness, 8);
    expect(readFileSync(sourcePath, "utf8")).toBe(READ_ONLY_SOURCE);

    harness.completeNextTool("subagent_isolated", {
      task: "[SDK_READ_ONLY_NESTED_SPAWN] Attempt a write.",
      model: "subagentura-faux/faux-model",
    });
    await waitForContexts(harness, 9);
    expect(toolNames(harness.contexts[8]).sort()).toEqual([
      "find",
      "grep",
      "ls",
      "read",
    ]);
    harness.completeNextTool("mcp__e2e__mutate", {
      path: forbiddenMcpPath,
      content: "FORBIDDEN_MCP_MUTATION",
    });
    await waitForContexts(harness, 10);
    expect(existsSync(forbiddenMcpPath)).toBe(false);
    expect(readFileSync(mcpControlPath, "utf8")).toBe(
      "SDK_MCP_CONTROL_SENTINEL",
    );
    harness.completeNext(JSON.stringify({ source: "SDK_READ_ONLY_SOURCE" }));
    await waitForContexts(harness, 11);
    const returnedResult = toolResult(harness.contexts[10], "workflow");
    const resultText = returnedResult.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const resultSeparator = resultText.indexOf("\n\n");
    expect(resultSeparator).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(resultText.slice(resultSeparator + 2))).toEqual({
      source: "SDK_READ_ONLY_SOURCE",
    });
    harness.completeNext("Workflow completed.");
    await run;
    await harness.session.waitForIdle();
    expect(readFileSync(sourcePath, "utf8")).toBe(READ_ONLY_SOURCE);
    expect(existsSync(forbiddenPath)).toBe(false);
  });
});
