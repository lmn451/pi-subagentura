import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLI_SOURCE as legacy } from "./fixtures/legacy-artifact-cli";
import { writeCliScript } from "../src/subagent-artifact-cli";
import { appendCompletionEvent, artifactPath } from "../src/artifact";
import { completionLockPathForTurn } from "../src/completion-writer-lock.mjs";

it("leaves a markerless turn to the legacy helper before and during its commit", () => {
  const root = mkdtempSync(join(tmpdir(), "completion-mixed-"));
  try {
    const artifact = artifactPath(root, "child");
    mkdirSync(artifact.dir);
    const turnId = "shared-turn";
    const lock = completionLockPathForTurn(artifact.dir, turnId);
    writeFileSync(
      join(artifact.dir, "active-turn.json"),
      JSON.stringify({ turnId, started: true }),
    );
    const oldCli = join(artifact.dir, "cli.mjs"),
      newCli = join(root, "new.mjs"),
      gate = join(root, "at-append.cjs");
    writeFileSync(oldCli, legacy);
    writeCliScript(newCli);
    expect(() =>
      appendCompletionEvent(artifact, {
        turnId,
        outcome: "cancelled",
        source: "parent",
      }),
    ).toThrow(/legacy completion writer/);
    // Run the other CLI after the old writer's duplicate check but before its append.
    // Age the held lock instead of pausing the test for 31 seconds.
    writeFileSync(
      gate,
      `const fs=require('node:fs'),{spawnSync}=require('node:child_process');\nconst append=fs.appendFileSync;\nfs.appendFileSync=function(file,data,...rest){\n if(JSON.parse(data).type==='completion'){\n const age=new Date(Date.now()-31000); fs.utimesSync(${JSON.stringify(lock)},age,age);\n const peer=spawnSync(process.execPath,[${JSON.stringify(newCli)},'cancelled'],{encoding:'utf8',timeout:5000});\n if(peer.error || peer.status!==1 || !peer.stderr.includes('legacy completion writer') || !fs.existsSync(${JSON.stringify(lock)})) throw Error('new helper did not leave the old writer alone: '+peer.stderr);\n }\n return append.call(fs,file,data,...rest);\n};require('node:module').syncBuiltinESMExports();`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", gate, oldCli, "done", "0"],
      {
        env: { ...process.env, ARTIFACT_DIR: artifact.dir },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const events = readFileSync(artifact.statusFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.type === "completion")).toEqual([
      expect.objectContaining({ turnId, outcome: "done" }),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
