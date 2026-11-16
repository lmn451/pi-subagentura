import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, listOutputHistory, writeOutput } from "../src/artifact";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const repoRoot = new URL("..", import.meta.url).pathname;
const harnesses: PiSessionHarness[] = [];
const artifactRoots: string[] = [];
const diagnosticsEnv = "PI_SUBAGENTURA_CHILD_DIAGNOSTICS";
const previousDiagnosticsSetting = process.env[diagnosticsEnv];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
  for (const root of artifactRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (previousDiagnosticsSetting === undefined) {
    delete process.env[diagnosticsEnv];
  } else {
    process.env[diagnosticsEnv] = previousDiagnosticsSetting;
  }
});

function diagnosticsFor(artifactDir: string): any[] {
  return readFileSync(join(artifactDir, "child-diagnostics.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("interactive child output diagnostics", () => {
  it("distinguishes absent final text, absent output, and a snapshotted output", async () => {
    process.env[diagnosticsEnv] = "1";
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagentura-output-diagnostics-"),
    );
    artifactRoots.push(root);
    const artifact = artifactPath(root, "child0001");
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: artifact.dir,
    });
    harnesses.push(harness);
    const assistantText = "private fake assistant 🌱";

    const runTurn = async (
      turnIndex: number,
      assistantText: string,
      output?: string,
    ) => {
      const prompt = harness.session.prompt(`synthetic turn ${turnIndex}`);
      await vi.waitFor(() => expect(harness.contexts).toHaveLength(turnIndex));
      if (output !== undefined) writeOutput(artifact, output);
      harness.completeNext(assistantText);
      await prompt;
      await harness.session.waitForIdle();
    };

    await runTurn(1, "");
    await runTurn(2, assistantText);
    await runTurn(3, assistantText, "test-owned output");

    const diagnostics = diagnosticsFor(artifact.dir);
    expect(diagnostics).toHaveLength(3);
    expect(
      diagnostics.map(({ finalMessageTextBytes }) => finalMessageTextBytes),
    ).toEqual([
      0,
      Buffer.byteLength(assistantText),
      Buffer.byteLength(assistantText),
    ]);
    expect(diagnostics.map(({ stopReason }) => stopReason)).toEqual([
      "stop",
      "stop",
      "stop",
    ]);
    expect(diagnostics.map(({ contentPartTypes }) => contentPartTypes)).toEqual(
      [["text"], ["text"], ["text"]],
    );
    expect(diagnostics.map(({ toolCallCount }) => toolCallCount)).toEqual([
      0, 0, 0,
    ]);
    expect(
      diagnostics.map(({ outputWriteSucceeded }) => outputWriteSucceeded),
    ).toEqual([false, false, true]);
    expect(diagnostics.map(({ outputBytes }) => outputBytes)).toEqual([
      0,
      0,
      Buffer.byteLength("test-owned output"),
    ]);
    expect(diagnostics.every(({ aborted, error }) => !aborted && !error)).toBe(
      true,
    );
    expect(JSON.stringify(diagnostics)).not.toContain(assistantText);
    expect(JSON.stringify(diagnostics)).not.toContain("test-owned output");
    expect(
      listOutputHistory(artifact).map((entry) =>
        entry.output ? readFileSync(entry.output.path, "utf8") : null,
      ),
    ).toEqual(["", "", "test-owned output"]);
  });

  it("does not create diagnostics unless the opt-in is enabled", async () => {
    delete process.env[diagnosticsEnv];
    const root = mkdtempSync(
      join(tmpdir(), "pi-subagentura-output-diagnostics-"),
    );
    artifactRoots.push(root);
    const artifact = artifactPath(root, "child0002");
    const harness = await createPiSessionHarness(repoRoot, {
      childArtifactDir: artifact.dir,
    });
    harnesses.push(harness);

    const prompt = harness.session.prompt("synthetic opt-out turn");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    harness.completeNext("private fake assistant text");
    await prompt;
    await harness.session.waitForIdle();

    expect(() =>
      readFileSync(join(artifact.dir, "child-diagnostics.ndjson")),
    ).toThrow();
  });
});
