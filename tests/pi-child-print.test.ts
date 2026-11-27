import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { artifactPath, readEvents } from "../src/artifact";
import {
  CHILD_ARTIFACT_BOOTSTRAP_ENV,
  writeChildArtifactBootstrap,
} from "../src/child-artifact-ownership";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(repo, "tests/terminal-e2e/fixtures");

it("exits cleanly after a fast print-mode child records its persisted turn", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-print-"));
  try {
    const art = artifactPath(root, "child");
    const bootstrap = writeChildArtifactBootstrap(art.dir);
    const sessionFile = join(root, "child.jsonl");
    const networkLog = join(root, "network.ndjson");
    const marker = "[E2E:CHILD_SMOKE]";
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        join(fixtures, "deny-network.cjs"),
        join(repo, "node_modules/.bin/pi"),
        "--offline",
        "--approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        join(repo, "src/subagent.ts"),
        "--extension",
        join(fixtures, "mock-provider.ts"),
        "--print",
        "--model",
        "subagentura-e2e/mock",
        "--session",
        sessionFile,
        `${marker} Return immediately.`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          HOME: root,
          PI_CODING_AGENT_DIR: join(root, "agent"),
          PI_OFFLINE: "1",
          DO_NOT_TRACK: "1",
          SUBAGENTURA_E2E_API_KEY: "subagentura-e2e-test-key",
          SUBAGENTURA_E2E_NETWORK_LOG: networkLog,
          ARTIFACT_DIR: art.dir,
          PI_SUBAGENTURA_CHILD: "1",
          [CHILD_ARTIFACT_BOOTSTRAP_ENV]: bootstrap,
        },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.slice(-2000)).toBe(0);
    expect(result.stdout).toContain(`Child result for ${marker}.`);
    expect(existsSync(bootstrap)).toBe(false);
    const userEntry = SessionManager.open(sessionFile)
      .getEntries()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    expect(userEntry).toBeDefined();
    expect(readEvents(art)).toMatchObject([
      { type: "turn_started", turnId: userEntry?.id },
      {
        type: "completion",
        turnId: userEntry?.id,
        outcome: "done",
        source: "agent_settled",
        exitCode: 0,
      },
    ]);
    expect(
      readFileSync(networkLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).kind),
    ).toEqual(["armed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
