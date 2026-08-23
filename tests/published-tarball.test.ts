/**
 * Regression test for the pi-subagentura@2.0.0 publish bug.
 *
 * What happened: `package.json` `files` array listed subagent.ts,
 * interactive-tmux.ts, artifact.ts, subagent-artifact-cli.ts, README.md, and
 * LICENSE — but NOT helpers.ts. Both subagent.ts and interactive-tmux.ts do
 * `import { ... } from "./helpers"`. The published tarball therefore loaded
 * with `Cannot find module './helpers'` the moment Pi tried to import the
 * extension, breaking every install of 2.0.0.
 *
 * What this test does: packs the current source with `npm pack`, extracts the
 * tarball to a temp dir, and verifies that every local import (`./foo`) in
 * every `.ts` file shipped in the tarball resolves to a file that is itself
 * in the tarball. If `package.json` `files` drifts away from the import
 * graph again — for helpers.ts or any future module — this test fails before
 * the bad version is published.
 *
 * Runs in ~1-2s locally; uses only npm and tar (both standard on macOS,
 * Linux, and the GitHub Actions ubuntu-latest runner).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files: string[];
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const SOURCE_EXTENSIONS = [".ts", ".mts", ".mjs", ".js"];
const APPROVED_PI_PEERS = new Set([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);

interface PackResult {
  tgz: string;
  entries: string[];
  pkgDir: string;
}

function pack(work: string): PackResult {
  const packed = spawnSync(
    "npm",
    ["pack", "--pack-destination", work, "--silent"],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  );
  if (packed.status !== 0) {
    throw new Error(
      `npm pack failed (exit ${packed.status}):\n${packed.stderr || packed.stdout}`,
    );
  }
  const tgzName = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgzName) {
    throw new Error(
      `npm pack produced no .tgz in ${work}\nstdout: ${packed.stdout}`,
    );
  }
  const tgz = join(work, tgzName);

  const list = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" });
  if (list.status !== 0) {
    throw new Error(`tar -tzf failed (exit ${list.status}):\n${list.stderr}`);
  }
  const entries = list.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => e.replace(/^package\//, ""));

  const pkgDir = join(work, "pkg");
  mkdirSync(pkgDir);
  const extract = spawnSync("tar", ["-xzf", tgz, "-C", pkgDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(
      `tar -xzf failed (exit ${extract.status}):\n${extract.stderr}`,
    );
  }

  return { tgz, entries, pkgDir: join(pkgDir, "package") };
}

interface SourceReference {
  specifier: string;
  runtime: boolean;
}

function sourceReferences(source: string): SourceReference[] {
  const references: SourceReference[] = [];
  const patterns: Array<{
    regex: RegExp;
    runtime: (match: RegExpExecArray) => boolean;
  }> = [
    {
      regex: /\bimport\s+(type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
      runtime: (match) => match[1] === undefined,
    },
    {
      regex: /\bexport\s+(type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
      runtime: (match) => match[1] === undefined,
    },
    {
      regex: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
      runtime: () => true,
    },
    {
      regex:
        /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
      runtime: () => true,
    },
  ];
  for (const { regex, runtime } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source)) !== null) {
      const specifier = match[2] ?? match[1];
      references.push({ specifier, runtime: runtime(match) });
    }
  }
  return references;
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extname(path));
}

function localCandidates(importer: string, specifier: string): string[] {
  const base = resolve("/package", dirname(importer), specifier);
  const packageRelative = relative("/package", base);
  if (extname(packageRelative)) return [packageRelative];
  return [
    packageRelative,
    ...SOURCE_EXTENSIONS.map((extension) => packageRelative + extension),
    ...SOURCE_EXTENSIONS.map((extension) =>
      join(packageRelative, "index" + extension),
    ),
  ];
}

function packageName(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0];
  return specifier.split("/").slice(0, 2).join("/");
}

function packageFileDeclarationMatches(
  declaration: string,
  entries: string[],
): boolean {
  if (entries.includes(declaration)) return true;
  if (declaration.includes("*")) {
    const pattern = declaration
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", "[^/]*");
    const regex = new RegExp(`^${pattern}$`);
    return entries.some((entry) => regex.test(entry));
  }
  const directory = declaration.replace(/\/$/, "");
  return entries.some((entry) => entry.startsWith(`${directory}/`));
}

describe("published tarball", () => {
  const work = mkdtempSync(join(tmpdir(), "pi-subagentura-pubtest-"));
  let entries: string[] = [];
  let pkgDir = "";
  let tgz = "";

  beforeAll(() => {
    const r = pack(work);
    entries = r.entries;
    pkgDir = r.pkgDir;
    tgz = r.tgz;
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("npm pack produces a non-empty tarball", () => {
    expect(
      entries.length,
      `tarball empty; working dir: ${work}`,
    ).toBeGreaterThan(0);
  });

  it("package.json `files` array matches the tarball contents", () => {
    const missing = PKG.files.filter(
      (file) => !packageFileDeclarationMatches(file, entries),
    );
    expect(
      missing,
      `tarball is missing files declared in package.json: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("contains src/helpers.ts (regression test for the v2.0.0 publish bug)", () => {
    expect(
      entries,
      "src/helpers.ts is missing from the tarball — this is the exact pi-subagentura@2.0.0 regression. " +
        "Re-add it to package.json `files`.",
    ).toContain("src/helpers.ts");
  });

  it("contains the Orchestratorv2 prompt and routing import closure", () => {
    expect(entries).toEqual(
      expect.arrayContaining([
        "ORCHESTRATOR_V2_SYSTEM_PROMPT.md",
        "src/orchestrator-routing.ts",
        "src/tools/orchestrator.ts",
      ]),
    );

    const extensionSource = readFileSync(
      join(pkgDir, "src/subagent.ts"),
      "utf8",
    );
    expect(sourceReferences(extensionSource)).toEqual(
      expect.arrayContaining([
        {
          specifier: "../ORCHESTRATOR_V2_SYSTEM_PROMPT.md",
          runtime: true,
        },
        { specifier: "./tools/orchestrator", runtime: true },
      ]),
    );

    const toolSource = readFileSync(
      join(pkgDir, "src/tools/orchestrator.ts"),
      "utf8",
    );
    expect(sourceReferences(toolSource)).toContainEqual({
      specifier: "../orchestrator-routing",
      runtime: true,
    });
  });

  it("publishes workflow declarations through the workflow subpath", () => {
    expect(entries).toContain("types/workflow.d.ts");
    const packedPackage = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    );
    expect(packedPackage.exports).toEqual({
      ".": "./src/subagent.ts",
      "./workflow": { types: "./types/workflow.d.ts" },
    });
  });

  it("contains the workflow guide, examples, and bundled RALPLAN skill", () => {
    expect(entries).toEqual(
      expect.arrayContaining([
        "docs/workflows.md",
        "examples/workflows/README.md",
        "examples/workflows/package-to-skill.mjs",
        "examples/workflows/ralplan-consensus.mjs",
        "examples/workflows/ralplan-from-skill.mjs",
        "examples/workflows/ralplan-occ.mjs",
        "examples/workflows/skill-to-workflow.mjs",
        "skills/ralplan/SKILL.md",
      ]),
    );
  });

  it("resolves every package-relative source dependency inside the tarball", () => {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!isSourceFile(entry)) continue;
      const src = readFileSync(join(pkgDir, entry), "utf8");
      for (const { specifier } of sourceReferences(src)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../"))
          continue;
        const candidates = localCandidates(entry, specifier);
        if (!candidates.some((candidate) => entries.includes(candidate))) {
          failures.push(
            `${entry} references '${specifier}' but none of ${candidates.join(", ")} is in the tarball`,
          );
        }
      }
    }
    expect(
      failures,
      failures.length === 0 ? "" : `\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("ships the workflow worker thread referenced through import.meta.url", () => {
    const source = readFileSync(join(pkgDir, "src/workflow-worker.ts"), "utf8");
    expect(sourceReferences(source)).toContainEqual({
      specifier: "./workflow-worker-thread.mjs",
      runtime: true,
    });
    expect(entries).toContain("src/workflow-worker-thread.mjs");
  });

  it("declares every bare runtime source import", () => {
    const declared = new Set(Object.keys(PKG.dependencies ?? {}));
    for (const peer of Object.keys(PKG.peerDependencies ?? {})) {
      if (APPROVED_PI_PEERS.has(peer)) declared.add(peer);
    }
    const failures: string[] = [];
    for (const entry of entries) {
      if (!isSourceFile(entry)) continue;
      const source = readFileSync(join(pkgDir, entry), "utf8");
      for (const reference of sourceReferences(source)) {
        const specifier = reference.specifier;
        if (
          !reference.runtime ||
          specifier.startsWith("./") ||
          specifier.startsWith("../") ||
          specifier.startsWith("node:")
        ) {
          continue;
        }
        const dependency = packageName(specifier);
        if (!declared.has(dependency)) {
          failures.push(
            `${entry} imports undeclared runtime dependency '${dependency}'`,
          );
        }
      }
    }
    expect(
      failures,
      failures.length === 0 ? "" : `\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("loads and registers the packed extension in a clean production consumer", () => {
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    const install = spawnSync(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", tgz, "jiti"],
      { cwd: consumer, encoding: "utf8" },
    );
    if (install.status !== 0) {
      throw new Error(
        `clean consumer install failed (exit ${install.status}):\n${install.stderr || install.stdout}`,
      );
    }
    const smoke = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { createJiti } from "jiti"; const jiti = createJiti(import.meta.url); const mod = await jiti.import("pi-subagentura", { default: false }); if (typeof mod.default !== "function") process.exit(2); const flags = []; const tools = []; mod.default({ registerTool: (tool) => tools.push(tool.name), registerMessageRenderer() {}, registerFlag: (name) => flags.push(name), registerCommand() {}, registerShortcut() {}, getFlag: () => false, on() {} }); if (!flags.includes("orchestratorv2") || !tools.includes("list_orchestrator_agents") || !tools.includes("update_orchestrator_agent_description") || !tools.includes("remove_orchestrator_agent_description")) process.exit(3);',
      ],
      { cwd: consumer, encoding: "utf8" },
    );
    expect(smoke.status, smoke.stderr || smoke.stdout).toBe(0);
  }, 60_000);
});
