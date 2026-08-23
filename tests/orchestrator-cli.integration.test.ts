import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_CLI = join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const EXPECTED_TOOLS = [
  "cancel_interactive_subagent",
  "cleanup_subagent_artifacts",
  "get_interactive_subagent_status",
  "list_available_models",
  "list_orchestrator_agents",
  "list_subagent_artifacts",
  "read_subagent_artifact",
  "remove_orchestrator_agent_description",
  "send_interactive_subagent_message",
  "subagent_interactive",
  "update_orchestrator_agent_description",
].sort();

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Orchestratorv2 real Pi CLI boundary", () => {
  it("exposes only router-safe tools and appends the v2 prompt", () => {
    const root = mkdtempSync(join(tmpdir(), "orchestrator-cli-"));
    roots.push(root);
    const providerLog = join(root, "provider.ndjson");

    execFileSync(
      process.execPath,
      [
        PI_CLI,
        "--offline",
        "--approve",
        "--api-key",
        "subagentura-e2e-test-key",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "--mode",
        "json",
        "--print",
        "-e",
        join(ROOT, "src", "subagent.ts"),
        "-e",
        join(ROOT, "tests", "terminal-e2e", "fixtures", "mock-provider.ts"),
        "--model",
        "subagentura-e2e/mock",
        "--orchestratorv2=true",
        "[E2E:ORCHESTRATOR_BOUNDARY] Report the active router surface.",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          PI_CODING_AGENT_DIR: join(root, ".pi-agent"),
          SUBAGENTURA_E2E_LOG: providerLog,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
          ALL_PROXY: "http://127.0.0.1:1",
          NO_PROXY: "",
        },
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const events = readFileSync(providerLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const request = events.find(
      (event) =>
        event.marker === "[E2E:ORCHESTRATOR_BOUNDARY]" &&
        event.beforeStage === "initial",
    );
    const completion = events.find(
      (event) =>
        event.marker === "[E2E:ORCHESTRATOR_BOUNDARY]" &&
        event.afterStage === "complete",
    );

    expect(request?.contextToolNames).toEqual(EXPECTED_TOOLS);
    expect(completion?.contextHasOrchestratorV2Prompt).toBe(true);
    expect(completion?.routingListObserved).toBe(true);
  });
});
