import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";
import { LINEAGE_BOOTSTRAP_ENV } from "../src/spawn-tree-context";

const root = fileURLToPath(new URL("../", import.meta.url));
const legacyPromptAsset = readFileSync(
  new URL("../ORCHESTRATOR_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const v2PromptAsset = readFileSync(
  new URL("../ORCHESTRATOR_V2_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const orcaPromptAsset = readFileSync(
  new URL("../ORCA_INTERACTIVE_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const childArtifactDirs: string[] = [];

type BeforeAgentStart = (
  event: { systemPrompt: string },
  context: unknown,
) => { systemPrompt: string } | undefined;

function emittedPrompt(mode: { flag?: string; child?: boolean }) {
  vi.stubEnv("PI_SUBAGENTURA_CHILD", mode.child ? "1" : undefined);
  const artifactDir = mode.child
    ? mkdtempSync(join(tmpdir(), "orca-prompt-child-"))
    : undefined;
  if (artifactDir) childArtifactDirs.push(artifactDir);
  vi.stubEnv("ARTIFACT_DIR", artifactDir);
  vi.stubEnv(LINEAGE_BOOTSTRAP_ENV, undefined);

  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn((name: string) => name === mode.flag),
    on: vi.fn<(event: string, handler: BeforeAgentStart) => void>(),
  };
  registerExtension(api as never);
  const handler = api.on.mock.calls.find(
    ([event]) => event === "before_agent_start",
  )?.[1];
  if (!handler) {
    throw new Error("before_agent_start handler was not registered");
  }
  const result = handler({ systemPrompt: "base prompt" }, {});
  return { api, prompt: result?.systemPrompt };
}

afterEach(() => {
  for (const directory of childArtifactDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

// The emitted system prompt is an intentional interface, not proof of model
// behavior.
describe("interactive prompt assembly contract", () => {
  const promptCases = [
    { name: "normal parent", child: false, flag: undefined, modeAssets: [] },
    {
      name: "legacy root",
      child: false,
      flag: "orchestrator",
      modeAssets: [legacyPromptAsset],
    },
    {
      name: "V2 root",
      child: false,
      flag: "orchestratorv2",
      modeAssets: [v2PromptAsset],
    },
    { name: "interactive child", child: true, flag: undefined, modeAssets: [] },
  ] as const;

  for (const mode of promptCases) {
    it(`emits exact assembly for ${mode.name}`, () => {
      const { api, prompt } = emittedPrompt(mode);
      expect(prompt).toBe(
        ["base prompt", ...mode.modeAssets, orcaPromptAsset].join("\n\n"),
      );
      expect(prompt?.split(orcaPromptAsset).length).toBe(2);
      if (mode.child) {
        expect(api.getFlag).not.toHaveBeenCalled();
      }
    });
  }

  it("ships the shared and V2 prompt assets in npm pack", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-prompt-contract-"));
    try {
      execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--silent",
          "--pack-destination",
          directory,
        ],
        { cwd: root, encoding: "utf8" },
      );
      const filename = readdirSync(directory).find((name) =>
        name.endsWith(".tgz"),
      );
      expect(filename).toBeDefined();
      const tarball = join(directory, filename!);
      const packedOrcaPrompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/ORCA_INTERACTIVE_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      const packedV2Prompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/ORCHESTRATOR_V2_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      expect(packedOrcaPrompt).toBe(orcaPromptAsset);
      expect(packedV2Prompt).toBe(v2PromptAsset);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
