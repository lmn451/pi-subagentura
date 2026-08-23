import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import registerExtension from "../src/subagent";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const README = readFileSync(resolve(REPO, "README.md"), "utf8");

function section(start: string, end: string): string {
  const startIndex = README.indexOf(start);
  const endIndex = README.indexOf(end, startIndex + start.length);
  expect(startIndex, `README is missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `README is missing ${end}`).toBeGreaterThan(startIndex);
  return README.slice(startIndex, endIndex);
}

describe("README public surface", () => {
  it("inventories every registered public tool and slash command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const flags: string[] = [];
    const api = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      registerShortcut: vi.fn(),
      registerMessageRenderer: vi.fn(),
      registerFlag: vi.fn((name: string) => flags.push(name)),
      getFlag: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    };
    const previousChild = process.env.PI_SUBAGENTURA_CHILD;
    delete process.env.PI_SUBAGENTURA_CHILD;
    try {
      registerExtension(api as any);
    } finally {
      if (previousChild === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
      else process.env.PI_SUBAGENTURA_CHILD = previousChild;
    }

    const toolInventory = section(
      "## Agent-facing tools",
      "## How it compares",
    );
    const commandInventory = section(
      "## User commands",
      "## Agent-facing tools",
    );
    const orchestrationDefaults = section(
      "## Bundled orchestration defaults",
      "## Cancellation context snapshots",
    );

    expect(tools).toHaveLength(23);
    expect(
      tools.filter((name) => name.includes("orchestrator")).sort(),
    ).toEqual(
      [
        "list_orchestrator_agents",
        "update_orchestrator_agent_description",
      ].sort(),
    );
    expect(commands).toHaveLength(9);
    for (const name of tools) {
      expect(toolInventory, `Missing tool inventory row for ${name}`).toContain(
        `| \`${name}\``,
      );
    }
    for (const name of commands) {
      expect(
        commandInventory,
        `Missing command inventory row for /${name}`,
      ).toContain(`| \`/${name}\``);
    }
    for (const name of flags) {
      expect(
        orchestrationDefaults,
        `Missing flag documentation for --${name}`,
      ).toContain(`--${name}`);
    }
  });
});
