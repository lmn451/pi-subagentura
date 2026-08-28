import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const skill = readFileSync(
  resolve(root, "skills/pi-session-recovery/SKILL.md"),
  "utf8",
);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("packaged Pi session recovery skill", () => {
  it("has incident-only discovery metadata", () => {
    expect(skill).toMatch(/^---\nname: pi-session-recovery\n/);
    expect(skill).toMatch(
      /description: .*lost\/closed tmux.*dead Pi child.*orphaned\/partial session recovery.*session reattachment/i,
    );
    expect(skill).toContain("Do not activate for");
    expect(skill).toContain("normal agent spawning");
    expect(skill).toContain("ordinary workflow reuse");
    expect(skill).toMatch(/routine\s+`\/resume`/);
  });

  it("documents non-destructive recovery and identity boundaries", () => {
    for (const pattern of [
      /JSONL header/i,
      /subagent runtime\/registry identity/i,
      /pi --session/,
      /--session-dir/,
      /pi --fork/,
      /git .*status/,
      /Do not run `git reset`/,
      /tmux/i,
      /Zellij/,
      /direct interactive/i,
      /workflow child/i,
      /in-process/i,
      /conversation recovery/i,
      /registry\/lineage/i,
      /explicit confirmation/i,
    ]) {
      expect(skill).toMatch(pattern);
    }
    expect(skill).not.toMatch(/\/Users\/[^<]/);
    expect(skill).not.toMatch(/[A-Z]:\\Users\\/);
  });

  it("registers both packaged skills without relying on convention discovery", () => {
    expect(pkg.pi.skills).toEqual([
      "./skills/ralplan",
      "./skills/pi-session-recovery",
    ]);
    expect(pkg.files).toContain("skills/pi-session-recovery");
  });
});
