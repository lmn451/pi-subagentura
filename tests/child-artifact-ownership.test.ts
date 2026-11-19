import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRuntimeChildArtifactOwnership,
  CHILD_ARTIFACT_BOOTSTRAP_ENV,
  isCurrentChildArtifactOwnership,
  resetRuntimeChildArtifactOwnershipForTests,
  writeChildArtifactBootstrap,
} from "../src/child-artifact-ownership";
import { retireLineageBootstraps } from "../src/spawn-tree-context";
import { importFresh } from "./test-utils";

let root: string;
let previousArtifactDir: string | undefined;
let previousBootstrap: string | undefined;
let previousChildMarker: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "child-artifact-ownership-"));
  previousArtifactDir = process.env.ARTIFACT_DIR;
  previousBootstrap = process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV];
  previousChildMarker = process.env.PI_SUBAGENTURA_CHILD;
  resetRuntimeChildArtifactOwnershipForTests();
});

afterEach(() => {
  if (previousArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
  else process.env.ARTIFACT_DIR = previousArtifactDir;
  if (previousBootstrap === undefined) {
    delete process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV];
  } else {
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] = previousBootstrap;
  }
  if (previousChildMarker === undefined)
    delete process.env.PI_SUBAGENTURA_CHILD;
  else process.env.PI_SUBAGENTURA_CHILD = previousChildMarker;
  resetRuntimeChildArtifactOwnershipForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("one-use child artifact ownership", () => {
  it("claims the launch bootstrap once and retains ownership in this process", () => {
    const artifactDir = join(root, "outer-child");
    const bootstrap = writeChildArtifactBootstrap(artifactDir);
    process.env.ARTIFACT_DIR = artifactDir;
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] = bootstrap;

    const ownership = acquireRuntimeChildArtifactOwnership();

    expect(ownership).toMatchObject({ artifactDir: realpathSync(artifactDir) });
    expect(isCurrentChildArtifactOwnership(ownership)).toBe(true);
    expect(existsSync(bootstrap)).toBe(false);
    expect(process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV]).toBeUndefined();
    expect(acquireRuntimeChildArtifactOwnership()).toBe(ownership);
  });
  it("accepts a launch credential after a delayed startup", () => {
    const artifactDir = join(root, "delayed-child");
    process.env.ARTIFACT_DIR = artifactDir;
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] =
      writeChildArtifactBootstrap(artifactDir);
    const delayedTime = Date.now() + 60_001;

    vi.useFakeTimers();
    vi.setSystemTime(delayedTime);
    try {
      expect(acquireRuntimeChildArtifactOwnership()).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates nested no-session Pi while allowing a separately credentialed child", () => {
    const artifactDir = join(root, "outer-child");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "output.md"), "outer output", {
      mode: 0o600,
    });
    writeFileSync(join(artifactDir, "active-turn.json"), "outer turn", {
      mode: 0o600,
    });
    writeFileSync(join(artifactDir, "events.ndjson"), "outer events", {
      mode: 0o600,
    });
    process.env.ARTIFACT_DIR = artifactDir;
    process.env.PI_SUBAGENTURA_CHILD = "1";
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] =
      writeChildArtifactBootstrap(artifactDir);
    expect(acquireRuntimeChildArtifactOwnership()).toBeDefined();

    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const nestedPiPath = join(root, "pi");
    const vitestPath = join(process.cwd(), "node_modules/vitest/vitest.mjs");
    const nestedConfigPath = join(
      process.cwd(),
      "tests/fixtures/nested-pi-no-session.vitest.config.ts",
    );
    const nestedPiScript = [
      "#!/bin/sh",
      '[ "$1" = "--no-session" ] || exit 2',
      "export NESTED_PI_NO_SESSION=1",
      `exec ${quote(process.execPath)} ${quote(vitestPath)} run --config ${quote(nestedConfigPath)} --reporter=dot`,
      "",
    ].join("\n");
    writeFileSync(nestedPiPath, nestedPiScript, { mode: 0o700 });
    chmodSync(nestedPiPath, 0o700);

    const inherited = spawnSync(nestedPiPath, ["--no-session"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
      timeout: 30_000,
    });
    expect(inherited.status, `${inherited.stdout}\\n${inherited.stderr}`).toBe(
      0,
    );
    expect(readFileSync(join(artifactDir, "output.md"), "utf8")).toBe(
      "outer output",
    );
    expect(readFileSync(join(artifactDir, "active-turn.json"), "utf8")).toBe(
      "outer turn",
    );
    expect(readFileSync(join(artifactDir, "events.ndjson"), "utf8")).toBe(
      "outer events",
    );

    const nestedArtifactDir = join(root, "nested-child");
    const nestedBootstrap = writeChildArtifactBootstrap(nestedArtifactDir);
    const credentialed = spawnSync(nestedPiPath, ["--no-session"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ARTIFACT_DIR: nestedArtifactDir,
        [CHILD_ARTIFACT_BOOTSTRAP_ENV]: nestedBootstrap,
        NESTED_PI_DELAYED_START: "1",
      },
      timeout: 30_000,
    });
    expect(
      credentialed.status,
      `${credentialed.stdout}\n${credentialed.stderr}`,
    ).toBe(0);
    expect(existsSync(nestedBootstrap)).toBe(false);
    expect(readFileSync(join(nestedArtifactDir, "output.md"), "utf8")).toBe("");
    expect(
      JSON.parse(
        readFileSync(join(nestedArtifactDir, "active-turn.json"), "utf8"),
      ),
    ).toMatchObject({ turnId: "nested-user", started: true });
    const nestedEvents = readFileSync(
      join(nestedArtifactDir, "events.ndjson"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      nestedEvents.filter((event) => event.type === "completion"),
    ).toMatchObject([
      { turnId: "nested-user", outcome: "done", source: "agent_settled" },
    ]);
    expect(readFileSync(join(artifactDir, "output.md"), "utf8")).toBe(
      "outer output",
    );
    expect(readFileSync(join(artifactDir, "active-turn.json"), "utf8")).toBe(
      "outer turn",
    );
    expect(readFileSync(join(artifactDir, "events.ndjson"), "utf8")).toBe(
      "outer events",
    );
  });

  it("accepts a separately issued credential for a nested interactive child", () => {
    const outerArtifactDir = join(root, "outer-child");
    process.env.ARTIFACT_DIR = outerArtifactDir;
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] =
      writeChildArtifactBootstrap(outerArtifactDir);
    const outerOwnership = acquireRuntimeChildArtifactOwnership();
    expect(isCurrentChildArtifactOwnership(outerOwnership)).toBe(true);

    const nestedArtifactDir = join(root, "nested-child");
    process.env.ARTIFACT_DIR = nestedArtifactDir;
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] =
      writeChildArtifactBootstrap(nestedArtifactDir);
    const nestedOwnership = acquireRuntimeChildArtifactOwnership();

    expect(nestedOwnership).toMatchObject({
      artifactDir: realpathSync(nestedArtifactDir),
    });
    expect(isCurrentChildArtifactOwnership(nestedOwnership)).toBe(true);
    expect(nestedOwnership).not.toBe(outerOwnership);
  });

  it("rejects a bootstrap for a different artifact directory", () => {
    const sourceArtifactDir = join(root, "source-child");
    const targetArtifactDir = join(root, "other-child");
    mkdirSync(targetArtifactDir, { recursive: true });
    const bootstrap = writeChildArtifactBootstrap(sourceArtifactDir);
    process.env.ARTIFACT_DIR = targetArtifactDir;
    process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] = bootstrap;

    expect(() => acquireRuntimeChildArtifactOwnership()).toThrow(
      /outside its target/,
    );
    expect(existsSync(bootstrap)).toBe(true);
    expect(process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV]).toBeUndefined();
  });
  it("retires unclaimed ownership when child lineage is retired", () => {
    const artifactDir = join(root, "pending-child");
    const bootstrap = writeChildArtifactBootstrap(artifactDir);

    retireLineageBootstraps(artifactDir);

    expect(existsSync(bootstrap)).toBe(false);
  });
  it("removes stale claim files without removing a live claimant's file", () => {
    const artifactDir = join(root, "claimed-child");
    mkdirSync(artifactDir, { recursive: true });
    const child = spawnSync(process.execPath, ["-e", ""], {
      encoding: "utf8",
    });
    if (child.status !== 0 || child.pid === undefined) {
      throw new Error("Could not create an exited claim owner");
    }
    const staleClaim = join(
      artifactDir,
      `.child-artifact-bootstrap-${"a".repeat(16)}.json.claimed-${child.pid}-${"b".repeat(16)}`,
    );
    const liveClaim = join(
      artifactDir,
      `.child-artifact-bootstrap-${"c".repeat(16)}.json.claimed-${process.pid}-${"d".repeat(16)}`,
    );
    writeFileSync(staleClaim, "stale", { mode: 0o600 });
    writeFileSync(liveClaim, "live", { mode: 0o600 });

    retireLineageBootstraps(artifactDir);

    expect(existsSync(staleClaim)).toBe(false);
    expect(existsSync(liveClaim)).toBe(true);
  });
});

it("validates the same process-owned object after Pi loads a different copy", async () => {
  const artifactDir = join(root, "project-child");
  const bootstrap = writeChildArtifactBootstrap(artifactDir);
  process.env.ARTIFACT_DIR = artifactDir;
  process.env[CHILD_ARTIFACT_BOOTSTRAP_ENV] = bootstrap;
  const ownership = acquireRuntimeChildArtifactOwnership();
  expect(isCurrentChildArtifactOwnership(ownership)).toBe(true);
  expect(existsSync(bootstrap)).toBe(false);

  const projectCopy = await importFresh<
    typeof import("../src/child-artifact-ownership")
  >("../src/child-artifact-ownership");
  expect(projectCopy.acquireRuntimeChildArtifactOwnership).not.toBe(
    acquireRuntimeChildArtifactOwnership,
  );
  expect(projectCopy.acquireRuntimeChildArtifactOwnership()).toBe(ownership);
  expect(projectCopy.isCurrentChildArtifactOwnership(ownership)).toBe(true);
  expect(projectCopy.isCurrentChildArtifactOwnership({ ...ownership })).toBe(
    false,
  );
});
