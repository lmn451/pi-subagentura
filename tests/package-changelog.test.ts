import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

describe("Pi extension update changelog", () => {
  it("ships the configured changelog with versioned release entries", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const result = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    // npm versions return either an array or a map keyed by package name.
    const packed = JSON.parse(result.stdout);
    const { files } = Array.isArray(packed) ? packed[0] : packed[pkg.name];
    expect(pkg.pi.changelogPath).toBe("CHANGELOG.md");
    expect(files.map((file: { path: string }) => file.path)).toContain(
      pkg.pi.changelogPath,
    );
    expect(
      readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    ).toContain(`## [${pkg.version}]`);
  });
});
