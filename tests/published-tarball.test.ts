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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const PKG = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files: string[];
};
const NM_SMOKE_DIR = join(
  REPO,
  "node_modules",
  ".pi-subagentura-smoke-" + PKG.version,
);

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

/** Returns the module specifier for every `from "./foo"` (or `./foo/bar`) in source. */
function localImports(source: string): string[] {
  const re = /from\s+["'](\.\/[^"']+)["']/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1].slice(2)); // strip "./"
  return out;
}

/** Local module `./foo` resolves to either `./foo.ts` or `./foo/index.ts`. */
function resolvesInTarball(mod: string, entries: string[]): boolean {
  return (
    entries.includes(`src/${mod}.ts`) || entries.includes(`src/${mod}/index.ts`)
  );
}

describe("published tarball", () => {
  const work = mkdtempSync(join(tmpdir(), "pi-subagentura-pubtest-"));
  let entries: string[] = [];
  let pkgDir = "";

  beforeAll(() => {
    const r = pack(work);
    entries = r.entries;
    pkgDir = r.pkgDir;
    // Copy extracted tarball into node_modules so Vite resolves bare specifiers
    if (existsSync(NM_SMOKE_DIR))
      rmSync(NM_SMOKE_DIR, { recursive: true, force: true });
    cpSync(pkgDir, NM_SMOKE_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(NM_SMOKE_DIR))
      rmSync(NM_SMOKE_DIR, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("npm pack produces a non-empty tarball", () => {
    expect(
      entries.length,
      `tarball empty; working dir: ${work}`,
    ).toBeGreaterThan(0);
  });

  it("package.json `files` array matches the tarball contents", () => {
    const missing = PKG.files.filter((f) => !entries.includes(f));
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

  it("every local import in shipped .ts files resolves to a file in the tarball", () => {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".ts")) continue;
      const src = readFileSync(join(pkgDir, entry), "utf8");
      for (const mod of localImports(src)) {
        if (!resolvesInTarball(mod, entries)) {
          failures.push(
            `${entry} imports './${mod}' but no candidate (${mod}.ts, ${mod}/index.ts) is in the tarball`,
          );
        }
      }
    }
    expect(
      failures,
      failures.length === 0 ? "" : `\n${failures.join("\n")}`,
    ).toEqual([]);
  });

  it("extension entrypoint can be imported like Pi does", async () => {
    // Pi reads package.json#pi.extensions → ["./src/subagent.ts"],
    // resolves relative to the package root, and does a dynamic import
    const pkgJson = JSON.parse(
      readFileSync(join(NM_SMOKE_DIR, "package.json"), "utf-8"),
    );
    const extensions = pkgJson.pi?.extensions;
    expect(extensions).toBeDefined();
    expect(Array.isArray(extensions)).toBe(true);
    expect(extensions!.length).toBeGreaterThan(0);
    const entrypoint = extensions![0];
    expect(entrypoint).toBe("./src/subagent.ts");

    // Dynamic import like Pi does — resolves the relative path against the package root
    const mod = await import(join(NM_SMOKE_DIR, entrypoint));

    // Default export is the extension registration function
    expect(typeof mod.default).toBe("function");

    // Key named exports that Pi references
    expect(typeof mod.formatUsage).toBe("function");
    expect(mod.jobRegistry).toBeDefined();
  });

  describe("package.json `files` array", () => {
    it("includes every local import of every shipped .ts file (static check)", () => {
      const tsFiles = PKG.files.filter((f) => f.endsWith(".ts"));
      const failures: string[] = [];
      for (const f of tsFiles) {
        const source = readFileSync(join(REPO, f), "utf8");
        for (const mod of localImports(source)) {
          if (!resolvesInFiles(mod)) {
            failures.push(
              `${f} imports './${mod}' but 'src/${mod}.ts' (or 'src/${mod}/index.ts') is not in package.json 'files'`,
            );
          }
        }
      }
      expect(
        failures,
        failures.length === 0 ? "" : `\n${failures.join("\n")}`,
      ).toEqual([]);
    });

    function resolvesInFiles(mod: string): boolean {
      return (
        PKG.files.includes(`src/${mod}.ts`) ||
        PKG.files.includes(`src/${mod}/index.ts`)
      );
    }
  });
});
