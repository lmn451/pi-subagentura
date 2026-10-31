import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import registerExtension from "../src/subagent";
import { LINEAGE_BOOTSTRAP_ENV } from "../src/spawn-tree-context";
import { buildChildSubagentProtocol } from "../src/interactive-tmux";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

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
const interactivePromptAsset = readFileSync(
  new URL("../INTERACTIVE_SUBAGENT_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const childArtifactDirs: string[] = [];
function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function expectSharedPromptAssets(
  prompt: string,
  modeAssets: readonly string[],
) {
  expect(countOccurrences(prompt, orcaPromptAsset)).toBe(1);
  expect(countOccurrences(prompt, interactivePromptAsset)).toBe(1);
  expect(countOccurrences(prompt, legacyPromptAsset)).toBe(
    modeAssets.includes(legacyPromptAsset) ? 1 : 0,
  );
  expect(countOccurrences(prompt, v2PromptAsset)).toBe(
    modeAssets.includes(v2PromptAsset) ? 1 : 0,
  );
}

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
        [
          "base prompt",
          ...mode.modeAssets,
          orcaPromptAsset,
          interactivePromptAsset,
        ].join("\n\n"),
      );
      expect(countOccurrences(prompt ?? "", orcaPromptAsset)).toBe(1);
      expect(countOccurrences(prompt ?? "", interactivePromptAsset)).toBe(1);
      if (mode.child) {
        expect(api.getFlag).not.toHaveBeenCalled();
      }
    });
  }

  it("ships both shared prompts and the V2 prompt in npm pack", () => {
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
      const packedInteractivePrompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/INTERACTIVE_SUBAGENT_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      const packedV2Prompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/ORCHESTRATOR_V2_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      expect(packedOrcaPrompt).toBe(orcaPromptAsset);
      expect(packedInteractivePrompt).toBe(interactivePromptAsset);
      expect(packedV2Prompt).toBe(v2PromptAsset);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
describe("interactive prompts in Pi SDK sessions", () => {
  const promptCases = [
    {
      name: "normal parent",
      child: false,
      extensionFlags: {},
      modeAssets: [],
    },
    {
      name: "legacy root",
      child: false,
      extensionFlags: { orchestrator: true },
      modeAssets: [legacyPromptAsset],
    },
    {
      name: "V2 root",
      child: false,
      extensionFlags: { orchestratorv2: true },
      modeAssets: [v2PromptAsset],
    },
    {
      name: "interactive child",
      child: true,
      extensionFlags: { orchestrator: true, orchestratorv2: true },
      modeAssets: [],
    },
  ] as const;

  for (const mode of promptCases) {
    it(`emits stable shared assets for a ${mode.name}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "orca-prompt-session-"));
      const childArtifactDir = mode.child
        ? mkdtempSync(join(tmpdir(), "orca-prompt-session-child-"))
        : undefined;
      if (childArtifactDir) childArtifactDirs.push(childArtifactDir);
      const childProtocol = childArtifactDir
        ? buildChildSubagentProtocol(childArtifactDir)
        : undefined;
      let harness: PiSessionHarness | undefined;

      try {
        const sessionHarness = await createPiSessionHarness(cwd, {
          appendSystemPrompt: childProtocol,
          childArtifactDir,
          extensionFlags: mode.extensionFlags,
          extensionRoot: root,
          includeTools: true,
        });
        harness = sessionHarness;
        expect(
          sessionHarness.session.getToolDefinition("subagent_interactive"),
        ).toBeDefined();

        const firstTurn = sessionHarness.session.prompt("first prompt turn");
        await vi.waitFor(() => expect(sessionHarness.contexts).toHaveLength(1));
        const firstPrompt = getCurrentSystemPrompt(
          sessionHarness.contexts[0]!.messages,
        );
        expectSharedPromptAssets(firstPrompt, mode.modeAssets);
        if (childProtocol) {
          expect(countOccurrences(firstPrompt, childProtocol)).toBe(1);
        }
        sessionHarness.completeNext();
        await firstTurn;
        await sessionHarness.session.waitForIdle();

        const secondTurn = sessionHarness.session.prompt("second prompt turn");
        await vi.waitFor(() => expect(sessionHarness.contexts).toHaveLength(2));
        const secondPrompt = getCurrentSystemPrompt(
          sessionHarness.contexts[1]!.messages,
        );
        expectSharedPromptAssets(secondPrompt, mode.modeAssets);
        expect(secondPrompt).toBe(firstPrompt);
        if (childProtocol) {
          expect(countOccurrences(secondPrompt, childProtocol)).toBe(1);
        }
        sessionHarness.completeNext();
        await secondTurn;
        await sessionHarness.session.waitForIdle();
      } finally {
        harness?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
