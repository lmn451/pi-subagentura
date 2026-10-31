import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerExtension from "../src/subagent";

const root = fileURLToPath(new URL("../", import.meta.url));
const promptAsset = readFileSync(
  new URL("../ORCHESTRATOR_V2_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const hostPromptAsset = readFileSync(
  new URL("../INTERACTIVE_SUBAGENT_SYSTEM_PROMPT.md", import.meta.url),
  "utf8",
).trim();
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function emittedPrompt(): string {
  const prompt = loadPrompt("orchestratorv2");
  expect(prompt).toEqual(expect.any(String));
  return prompt ?? "";
}

function section(heading: string): string {
  const prompt = emittedPrompt();
  const marker = `## ${heading}\n`;
  expect(prompt).toContain(marker);
  return (prompt.split(marker)[1]?.split("\n## ")[0] ?? "").replace(
    /\s+/g,
    " ",
  );
}

function loadPrompt(flag: string): string | undefined {
  vi.stubEnv("PI_SUBAGENTURA_CHILD", undefined);
  const api = {
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getFlag: vi.fn((name: string) => name === flag),
    on: vi.fn(),
  };
  registerExtension(api as never);
  const handler = api.on.mock.calls.find(
    ([event]) => event === "before_agent_start",
  )?.[1];
  return handler({ systemPrompt: "base prompt" }, {})?.systemPrompt;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// The emitted system prompt is an intentional interface, not proof of model behavior.
describe("Orchestratorv2 emitted prompt contract", () => {
  it("emits current caller/terminal proof requirements", () => {
    const surface = section("Execution surface and precedence");
    expect(surface).toContain("skills get orca-cli --json");
    expect(surface).toContain("skills get orchestration --json");
    expect(surface).toContain("before command discovery");
    expect(surface).toContain("current caller and terminal");
    expect(surface).toContain("running Pi session");
    expect(surface).toContain(
      "Skill presence or CLI installation alone is not proof",
    );
    expect(surface).toContain("positively outside Orca");
    expect(surface).toContain("unavailable or ambiguous");
    expect(surface).toContain("do not silently fall back");
    expect(surface).toContain(
      "Do not infer or override `mux` from those markers alone",
    );
  });

  it("emits native-only tool, schema, and advisor scope", () => {
    const surface = section("Execution surface and precedence");
    for (const name of [
      "list_orchestrator_agents",
      "update_orchestrator_agent_description",
      "resolve_orchestrator_route",
      "includeContext",
      "read_subagent_artifact",
      "orchestratorv2-completion-wakeup",
    ]) {
      expect(surface).toContain(name);
    }
    expect(surface).toContain("native children only");
    expect(surface).toContain("including any later Optional routing advisor");
    expect(surface).toContain("Never fabricate native registry entries");
    const emitted = emittedPrompt();
    expect(emitted).toContain(
      "## Responsibilities, authority, and confirmation (native only)",
    );
    expect(emitted).toContain("## Context contract (native only)");
    expect(emitted).toContain("## Completion coordination (native only)");
  });

  it("emits skill-authoritative same-checkout terminal instructions", () => {
    const orca = section("Orca-managed Pi specialists");
    expect(orca).toContain("same checkout");
    expect(orca).toContain("no new worktrees unless the user requests them");
    expect(orca).toContain("terminal surface");
    expect(orca).toContain("Prefer Pi");
    expect(orca).toContain("same model and reasoning effort");
    expect(orca).toContain("do not guess flags, model IDs, or effort syntax");
    expect(orca).toContain("effective launch receipt");
    expect(orca).toContain("supervised coordination");
    expect(orca).toContain(
      "ordinary terminal prompts or full ownership handoffs",
    );
    expect(orca).toContain("Do not create Run/Task/Dispatch lifecycle state");
    expect(orca).toContain("Do not require a separate lifecycle decision");
    expect(orca).toContain("obtain a user decision at settlement when");
    expect(orca).toContain("Ordinary handoffs end after verified delivery");
    expect(orca).toContain("destructive cleanup requires user approval");
    expect(orca).toContain("Do not delete visible tabs by default");
    // Operation syntax belongs to version-matched skills, not a second CLI manual.
    expect(emittedPrompt()).not.toMatch(
      /orca (?:agent launch|terminal send|orchestration worker-start) --/,
    );
  });

  it("includes shared host-managed agent-launch guidance", () => {
    const hosts = section("Host-aware interactive agent launches");
    expect(hosts).toContain("Preserve an explicit `mux` choice");
    expect(hosts).toContain("verify the current caller and terminal topology");
    expect(hosts).toContain("session new --command");
    expect(hosts).toContain("agtermctl msg");
    expect(hosts).toContain("agent launch");
  });

  it("emits ownership, delivery, and evidence-based completion constraints", () => {
    const orca = section("Orca-managed Pi specialists");
    for (const rule of [
      "explicit responsibility",
      "current runtime identity",
      "Titles, labels, agent type, and workspace membership are not ownership",
      "Rediscover stale handles",
      "never dual-send",
      "ambiguous launch or send failure",
      "do not respawn or resend on silence",
      "Idle, timeout, input acceptance, or mailbox enqueue is not completion",
      "Do not promise automatic Subagentura completion",
      "focus/switch only; do not also send",
    ]) {
      expect(orca).toContain(rule);
    }
  });

  it("emits the complete report-based implementation handoff gate", () => {
    const gate = section("Implementation handoff completeness gate");
    expect(gate).toContain("Retrieve every completed scout/planner report");
    expect(gate).toContain("Orca reports");
    expect(gate).toContain("Task/Dispatch");
    expect(gate).toContain("actual report");
    expect(gate).toContain("not invented native child/turn IDs");
    expect(gate).toContain("explicit initial brief");
    expect(gate).toContain(
      "compare the handoff against every retrieved report",
    );
    expect(gate).toContain("expected tests/commands");
    expect(gate).toContain("not to repeat broad scouting or planning");
    expect(gate).toContain(
      "Never rely on implicit sibling transcript visibility",
    );
  });

  it("composes shared guidance with the selected prompt mode", () => {
    vi.stubEnv("PI_SUBAGENTURA_CHILD", undefined);
    vi.stubEnv("PI_ORCHESTRATOR_ROUTER", undefined);
    expect(loadPrompt("orchestratorv2")).toBe(
      `base prompt\n\n${hostPromptAsset}\n\n${promptAsset}`,
    );
    const orchestratorPrompt = loadPrompt("orchestrator") ?? "";
    expect(orchestratorPrompt).toContain(hostPromptAsset);
    expect(orchestratorPrompt).not.toContain("Orca-managed Pi specialists");
    expect(loadPrompt("")).toBe(`base prompt\n\n${hostPromptAsset}`);
  });

  it("ships the shared host guidance and v2 prompt in npm pack", () => {
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
      const packedPrompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/ORCHESTRATOR_V2_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      const packedHostPrompt = execFileSync(
        "tar",
        ["-xOf", tarball, "package/INTERACTIVE_SUBAGENT_SYSTEM_PROMPT.md"],
        { encoding: "utf8" },
      ).trim();
      const packedReadme = execFileSync(
        "tar",
        ["-xOf", tarball, "package/README.md"],
        { encoding: "utf8" },
      );
      expect(packedPrompt).toBe(promptAsset);
      expect(packedPrompt).toContain("## Orca-managed Pi specialists");
      expect(packedHostPrompt).toBe(hostPromptAsset);
      expect(packedReadme).toBe(readme);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
