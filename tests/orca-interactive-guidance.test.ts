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
const hostEnvironmentVariables = [
  "ORCA_RUNTIME_SOURCE_ID",
  "ORCA_RUNTIME_SOURCE_INCARNATION",
  "ORCA_RUNTIME_SOURCE_PROFILE_PATH",
  "AGTERM_ENABLED",
  "REX_SESSION",
  "REX_BLOCK",
  "TERM_PROGRAM",
  "TMUX",
  "ZELLIJ_SESSION_NAME",
  "HERDR_ENV",
] as const;
type PromptHostEnvironment = Partial<
  Record<(typeof hostEnvironmentVariables)[number], string>
>;
const validOrcaEnvironment = {
  ORCA_RUNTIME_SOURCE_ID: "test-source",
  ORCA_RUNTIME_SOURCE_INCARNATION: "test-incarnation",
  ORCA_RUNTIME_SOURCE_PROFILE_PATH: "/private/profile",
} satisfies PromptHostEnvironment;
const validRexEnvironment = {
  REX_SESSION: "test-session",
  REX_BLOCK: "test-block",
} satisfies PromptHostEnvironment;

function stubHostEnvironment(environment: PromptHostEnvironment = {}) {
  for (const variable of hostEnvironmentVariables) {
    vi.stubEnv(variable, environment[variable]);
  }
}
const childArtifactDirs: string[] = [];
function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function expectSharedPromptAssets(
  prompt: string,
  modeAssets: readonly string[],
  hostAssets: readonly string[],
) {
  expect(countOccurrences(prompt, orcaPromptAsset)).toBe(
    hostAssets.includes(orcaPromptAsset) ? 1 : 0,
  );
  expect(countOccurrences(prompt, interactivePromptAsset)).toBe(
    hostAssets.includes(interactivePromptAsset) ? 1 : 0,
  );
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

function emittedPrompt(mode: {
  flag?: string;
  child?: boolean;
  hostEnv?: PromptHostEnvironment;
}) {
  vi.stubEnv("PI_SUBAGENTURA_CHILD", mode.child ? "1" : undefined);
  stubHostEnvironment(mode.hostEnv);
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
    {
      name: "normal parent",
      child: false,
      modeAssets: [],
      hostEnv: {},
      hostAssets: [],
    },
    {
      name: "legacy root",
      child: false,
      flag: "orchestrator",
      modeAssets: [legacyPromptAsset],
      hostEnv: {},
      hostAssets: [],
    },
    {
      name: "V2 root",
      child: false,
      flag: "orchestratorv2",
      modeAssets: [v2PromptAsset],
      hostEnv: {},
      hostAssets: [],
    },
    {
      name: "interactive child inheriting Orca origin",
      child: true,
      hostEnv: validOrcaEnvironment,
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "Orca-context parent",
      child: false,
      hostEnv: validOrcaEnvironment,
      modeAssets: [],
      hostAssets: [orcaPromptAsset, interactivePromptAsset],
    },
    {
      name: "Orca-context V2 parent",
      child: false,
      flag: "orchestratorv2",
      hostEnv: validOrcaEnvironment,
      modeAssets: [v2PromptAsset],
      hostAssets: [orcaPromptAsset, interactivePromptAsset],
    },
    {
      name: "Agterm-context parent",
      child: false,
      hostEnv: { AGTERM_ENABLED: "1" },
      modeAssets: [],
      hostAssets: [interactivePromptAsset],
    },
    {
      name: "Rex-context parent",
      child: false,
      hostEnv: validRexEnvironment,
      modeAssets: [],
      hostAssets: [interactivePromptAsset],
    },
    {
      name: "unrelated terminal and mux markers",
      child: false,
      hostEnv: { TERM_PROGRAM: "agterm", TMUX: "/tmp/tmux" },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "incomplete Orca origin",
      child: false,
      hostEnv: { ORCA_RUNTIME_SOURCE_ID: "test-source" },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "incomplete Rex location hints",
      child: false,
      hostEnv: { REX_SESSION: "test-session" },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "conflicting Orca and Agterm observations",
      child: false,
      hostEnv: { ...validOrcaEnvironment, AGTERM_ENABLED: "1" },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "conflicting Orca and Rex observations",
      child: false,
      hostEnv: { ...validOrcaEnvironment, ...validRexEnvironment },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "conflicting Agterm and Rex observations",
      child: false,
      hostEnv: { AGTERM_ENABLED: "1", ...validRexEnvironment },
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "native child inheriting Orca origin and orchestration flags",
      child: true,
      flag: "orchestrator",
      hostEnv: validOrcaEnvironment,
      modeAssets: [],
      hostAssets: [],
    },
  ] as const;

  for (const mode of promptCases) {
    it(`emits exact assembly for ${mode.name}`, () => {
      const { api, prompt } = emittedPrompt(mode);
      const expected = [
        "base prompt",
        ...mode.modeAssets,
        ...mode.hostAssets,
      ].join("\n\n");
      if (mode.modeAssets.length === 0 && mode.hostAssets.length === 0) {
        expect(prompt).toBeUndefined();
      } else {
        expect(prompt).toBe(expected);
      }
      expectSharedPromptAssets(
        prompt ?? "base prompt",
        mode.modeAssets,
        mode.hostAssets,
      );
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
      hostEnv: {},
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "legacy root",
      child: false,
      extensionFlags: { orchestrator: true },
      hostEnv: {},
      modeAssets: [legacyPromptAsset],
      hostAssets: [],
    },
    {
      name: "V2 root",
      child: false,
      extensionFlags: { orchestratorv2: true },
      hostEnv: {},
      modeAssets: [v2PromptAsset],
      hostAssets: [],
    },
    {
      name: "interactive child inheriting Orca origin",
      child: true,
      extensionFlags: { orchestrator: true, orchestratorv2: true },
      hostEnv: validOrcaEnvironment,
      modeAssets: [],
      hostAssets: [],
    },
    {
      name: "Orca-context parent",
      child: false,
      extensionFlags: {},
      hostEnv: validOrcaEnvironment,
      modeAssets: [],
      hostAssets: [orcaPromptAsset, interactivePromptAsset],
    },
    {
      name: "Agterm-context parent",
      child: false,
      extensionFlags: {},
      hostEnv: { AGTERM_ENABLED: "1" },
      modeAssets: [],
      hostAssets: [interactivePromptAsset],
    },
    {
      name: "Rex-context parent",
      child: false,
      extensionFlags: {},
      hostEnv: validRexEnvironment,
      modeAssets: [],
      hostAssets: [interactivePromptAsset],
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
        stubHostEnvironment(mode.hostEnv);
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
        expectSharedPromptAssets(firstPrompt, mode.modeAssets, mode.hostAssets);
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
        expectSharedPromptAssets(
          secondPrompt,
          mode.modeAssets,
          mode.hostAssets,
        );
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
