import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { artifactPath, readEvents } from "../src/artifact";
import {
  CHILD_ARTIFACT_BOOTSTRAP_ENV,
  writeChildArtifactBootstrap,
} from "../src/child-artifact-ownership";

it("completes an ungated pi --print child without reading a disposed context", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "pi-print-shutdown-"));
  try {
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    for (const dir of [home, agentDir, cwd]) mkdirSync(dir);
    const art = artifactPath(root, "abcdef0123456789");
    const sessionFile = join(root, "session.jsonl");
    const result = spawnSync(
      process.execPath,
      [
        join(repo, "node_modules/.bin/pi"),
        "--print",
        "--offline",
        "--approve",
        "--api-key",
        "test",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "-e",
        join(repo, "src/subagent.ts"),
        "-e",
        join(repo, "tests/terminal-e2e/fixtures/mock-provider.ts"),
        "--model",
        "subagentura-e2e/mock",
        "--session",
        sessionFile,
        "[E2E:CHILD_SMOKE] Complete immediately.",
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
          PI_OFFLINE: "1",
          DO_NOT_TRACK: "1",
          PI_SUBAGENTURA_CHILD: "1",
          ARTIFACT_DIR: art.dir,
          [CHILD_ARTIFACT_BOOTSTRAP_ENV]: writeChildArtifactBootstrap(art.dir),
          SUBAGENTURA_E2E_API_KEY: "test",
          NODE_OPTIONS: `--require=${JSON.stringify(join(repo, "tests/terminal-e2e/fixtures/deny-network.cjs"))}`,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("stale");
    const entries = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const user = entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    expect(user).toBeDefined();
    const events = readEvents(art);
    expect(
      events.filter((event) => event.type === "turn_started"),
    ).toMatchObject([{ turnId: user.id }]);
    expect(events.filter((event) => event.type === "completion")).toMatchObject(
      [{ turnId: user.id, outcome: "done", source: "agent_settled" }],
    );
    const completion = events.find((event) => event.type === "completion");
    expect(completion).toHaveProperty("output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
