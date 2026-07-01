/**
 * Tests that the GitHub Actions publish workflow (.github/workflows/publish.yml)
 * maintains key invariants that protect the npm publish process.
 *
 * These tests are structural: they parse the YAML (without js-yaml) and verify
 * the shape, ordering, and content of workflow steps. They do NOT execute
 * the workflow or shell out to actions/validate.
 *
 * What is verified:
 *   - Trigger: only v* tags trigger publish
 *   - Permissions: id-token: write is present (trusted publishing / OIDC)
 *   - Pre-publish validation runs before npm publish:
 *       typecheck → tests → tarball smoke → pack:check → publish
 *   - Tag-version mismatch is checked before typecheck (early-exit)
 *   - npm publish uses --provenance and --access public
 *   - npm ci (not npm install) is used
 *   - Node version is 24 with npm cache
 *   - Every pre-publish validation step exists (typecheck, test, tarball, pack)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO = resolve(fileURLToPath(import.meta.url), "..", "..");
const WORKFLOW_PATH = resolve(REPO, ".github/workflows/publish.yml");

/**
 * Minimal YAML parser for the simple structure of .github/workflows/*.yml.
 *
 * Handles: mappings, sequences (at any indent level), quoted scalars,
 * block scalars (|), and nested combinations. Does NOT handle: anchors,
 * aliases, tags, complex keys, flow collections, or multi-document streams.
 */
function parseSimpleYaml(text: string): unknown {
  const lines = text.split("\n");
  let pos = 0;

  /** Consume the next non-empty line, stripping trailing whitespace. */
  function peek(): { indent: number; content: string } | null {
    while (pos < lines.length) {
      const rawLine = lines[pos++];
      const trimmed = rawLine.trimEnd();
      if (trimmed === "") continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      const content = trimmed.slice(indent);
      return { indent, content };
    }
    return null;
  }

  /** Peek without consuming. */
  function lookahead(): { indent: number; content: string } | null {
    const saved = pos;
    const r = peek();
    pos = saved;
    return r;
  }

  /** Skip the content lines of a block scalar (| or >). */
  function skipBlockScalar(headerIndent: number): void {
    while (true) {
      const n = lookahead();
      if (!n) break;
      if (n.indent <= headerIndent) break;
      peek(); // consume
    }
  }

  /** Unquote a scalar string if wrapped in matching quotes. */
  function unquote(s: string): string {
    if (s.length < 2) return s;
    const first = s[0];
    const last = s[s.length - 1];
    if (first === last && (first === '"' || first === "'"))
      return s.slice(1, -1);
    return s;
  }

  /** Check if a value is a block scalar indicator. */
  function isBlockScalar(v: string): boolean {
    return v === "|" || v === ">" || v === "|-" || v === ">-";
  }

  /** Parse children of a mapping key that has no inline value. */
  function parseChildren(keyIndent: number): unknown {
    const next = lookahead();
    if (!next) return null;
    if (next.indent <= keyIndent) return null;
    if (next.content.startsWith("- ")) return parseSequence(next.indent);
    return parseMapping(next.indent);
  }

  /** Parse a mapping block at a given indent level. */
  function parseMapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    while (true) {
      const next = lookahead();
      if (!next) break;
      if (next.indent < indent) break;
      if (next.indent !== indent) break;

      const line = peek()!; // safe: lookahead() confirmed non-null
      const colonIdx = line.content.indexOf(":");
      if (colonIdx === -1) break;

      const key = line.content.slice(0, colonIdx).trim();
      const rest = line.content.slice(colonIdx + 1).trim();

      if (rest) {
        if (isBlockScalar(rest)) {
          skipBlockScalar(line.indent);
          result[key] = rest; // placeholder; we don't parse the body
        } else {
          result[key] = unquote(rest);
        }
      } else {
        result[key] = parseChildren(line.indent);
      }
    }
    return result;
  }

  /** Parse a sequence where items are all at seqIndent. */
  function parseSequence(seqIndent: number): unknown[] {
    const result: unknown[] = [];

    while (true) {
      const next = lookahead();
      if (!next) break;
      if (next.indent < seqIndent) break;
      if (next.indent !== seqIndent) break;
      if (!next.content.startsWith("- ")) break;

      const line = peek()!; // safe: lookahead() confirmed non-null
      const itemIndent = line.indent;
      const rest = line.content.slice(2).trimStart();

      if (!rest) {
        // Bare "-" followed by indented children only
        const child = lookahead();
        if (child && child.indent > itemIndent) {
          result.push(parseMapping(child.indent));
        } else {
          result.push(null);
        }
      } else {
        const colonIdx = rest.indexOf(":");
        if (colonIdx >= 0) {
          // Inline mapping entry: "- key: value" possibly with more properties
          const item: Record<string, unknown> = {};
          const k = rest.slice(0, colonIdx).trim();
          const v = rest.slice(colonIdx + 1).trim();
          if (v) {
            if (isBlockScalar(v)) {
              skipBlockScalar(itemIndent);
              item[k] = v; // placeholder
            } else {
              item[k] = unquote(v);
            }
          } else {
            item[k] = parseChildren(itemIndent);
          }

          // Sibling properties at itemIndent + 2
          const propIndent = itemIndent + 2;
          while (true) {
            const n = lookahead();
            if (!n) break;
            if (n.indent < propIndent) break;
            // Stop if next sequence item at seqIndent
            if (n.indent === seqIndent && n.content.startsWith("- ")) break;
            if (n.indent !== propIndent) break;

            const pline = peek()!; // safe: lookahead() confirmed non-null
            const pcolon = pline.content.indexOf(":");
            if (pcolon === -1) break;
            const pk = pline.content.slice(0, pcolon).trim();
            const pr = pline.content.slice(pcolon + 1).trim();
            if (pr) {
              if (isBlockScalar(pr)) {
                skipBlockScalar(pline.indent);
                item[pk] = pr; // placeholder
              } else {
                item[pk] = unquote(pr);
              }
            } else {
              item[pk] = parseChildren(pline.indent);
            }
          }
          result.push(item);
        } else {
          // Scalar sequence element
          result.push(unquote(rest));
        }
      }
    }

    return result;
  }

  // Root: mapping at indent 0
  return parseMapping(0);
}

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

/** Extract the ordered steps array from the parsed workflow. */
function extractSteps(parsed: unknown): WorkflowStep[] {
  const root = parsed as Record<string, unknown>;
  const jobs = root.jobs as Record<string, unknown>;
  const publish = jobs?.publish as Record<string, unknown>;
  return (publish?.steps as WorkflowStep[]) ?? [];
}

/** Return the index of the first step whose `run` contains the given string. */
function findStepIndex(steps: WorkflowStep[], runContains: string): number {
  return steps.findIndex(
    (s) => typeof s.run === "string" && s.run.includes(runContains),
  );
}

/** Return the index of the first step whose `uses` starts with the given prefix. */
function findUseStepIndex(steps: WorkflowStep[], usesPrefix: string): number {
  return steps.findIndex(
    (s) => typeof s.uses === "string" && s.uses.startsWith(usesPrefix),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("publish workflow (.github/workflows/publish.yml)", () => {
  const raw = readFileSync(WORKFLOW_PATH, "utf-8");
  const parsed = parseSimpleYaml(raw);
  const root = parsed as Record<string, unknown>;
  const steps = extractSteps(parsed);
  const publishStepIdx = findStepIndex(steps, "npm publish");

  // ---- Trigger ----

  describe("trigger", () => {
    it('only runs on tags matching "v*"', () => {
      const on = root.on as Record<string, unknown>;
      const push = on?.push as Record<string, unknown>;
      const tags = push?.tags as string[];
      expect(tags).toBeDefined();
      expect(tags).toContain("v*");
      expect(tags).toHaveLength(1);
    });
  });

  // ---- Permissions ----

  describe("permissions", () => {
    it("grants id-token: write for OIDC / trusted publishing", () => {
      const perms = root.permissions as Record<string, unknown>;
      expect(perms).toBeDefined();
      expect(perms.contents).toBe("read");
      expect(perms["id-token"]).toBe("write");
    });
  });

  // ---- Pre-publish validation ordering ----

  describe("validation runs before publish", () => {
    it("has a typecheck step before npm publish", () => {
      const idx = findStepIndex(steps, "typecheck");
      expect(idx).not.toBe(-1);
      expect(idx).toBeLessThan(publishStepIdx);
    });

    it("has a test step (npm test) before npm publish", () => {
      const idx = findStepIndex(steps, "npm test");
      expect(idx).not.toBe(-1);
      expect(idx).toBeLessThan(publishStepIdx);
    });

    it("has a tarball smoke-test step before npm publish", () => {
      const idx = findStepIndex(steps, "published-tarball.test");
      expect(idx).not.toBe(-1);
      expect(idx).toBeLessThan(publishStepIdx);
    });

    it("has a pack:check step before npm publish", () => {
      const idx = findStepIndex(steps, "pack:check");
      expect(idx).not.toBe(-1);
      expect(idx).toBeLessThan(publishStepIdx);
    });

    it("the publish step is after all validation steps", () => {
      const packIdx = findStepIndex(steps, "pack:check");
      const tarballIdx = findStepIndex(steps, "published-tarball.test");
      const testIdx = findStepIndex(steps, "npm test");
      const typecheckIdx = findStepIndex(steps, "typecheck");
      const lastValidation = Math.max(
        packIdx,
        tarballIdx,
        testIdx,
        typecheckIdx,
      );
      expect(publishStepIdx).toBeGreaterThan(lastValidation);
    });

    it("publish is the final step in the job", () => {
      expect(publishStepIdx).toBe(steps.length - 1);
    });
  });

  // ---- Tag-version mismatch check ----

  describe("tag-version verification", () => {
    it("has a 'Verify tag matches package version' step", () => {
      const idx = steps.findIndex((s) =>
        (s.name ?? "").includes("Verify tag matches package version"),
      );
      expect(idx).not.toBe(-1);
    });

    it("runs before typecheck (early-exit before expensive steps)", () => {
      const verifyIdx = steps.findIndex((s) =>
        (s.name ?? "").includes("Verify tag matches package version"),
      );
      const typecheckIdx = findStepIndex(steps, "typecheck");
      expect(verifyIdx).toBeLessThan(typecheckIdx);
    });
  });

  // ---- npm publish flags ----

  describe("npm publish flags", () => {
    it("uses --provenance for OIDC attestation", () => {
      const step = steps[publishStepIdx];
      expect(step?.run).toContain("--provenance");
    });

    it("uses --access public for public packages", () => {
      const step = steps[publishStepIdx];
      expect(step?.run).toContain("--access public");
    });
  });

  // ---- Dependencies installation ----

  describe("dependency installation", () => {
    it("uses npm ci (not npm install) for deterministic installs", () => {
      const ciIdx = findStepIndex(steps, "npm ci");
      expect(ciIdx).not.toBe(-1);
      expect(findStepIndex(steps, "npm install")).toBe(-1);
    });

    it("runs before typecheck and tests", () => {
      const ciIdx = findStepIndex(steps, "npm ci");
      const typecheckIdx = findStepIndex(steps, "typecheck");
      expect(ciIdx).toBeLessThan(typecheckIdx);
    });
  });

  // ---- Runner setup ----

  describe("runner setup", () => {
    it("uses ubuntu-latest", () => {
      const jobs = root.jobs as Record<string, unknown>;
      const publish = jobs?.publish as Record<string, unknown>;
      expect(publish?.["runs-on"]).toBe("ubuntu-latest");
    });

    it("sets up Node.js v24 with npm cache", () => {
      const setupStep = steps.find((s) =>
        (s.uses ?? "").startsWith("actions/setup-node"),
      );
      expect(setupStep).toBeDefined();
      expect(setupStep!.with).toBeDefined();
      const withOpts = setupStep!.with as Record<string, unknown>;
      expect(withOpts["node-version"]).toBe("24");
      expect(withOpts["cache"]).toBe("npm");
      expect(withOpts["registry-url"]).toBe("https://registry.npmjs.org");
    });

    it("uses actions/checkout@v6 and actions/setup-node@v6", () => {
      expect(findUseStepIndex(steps, "actions/checkout@")).not.toBe(-1);
      expect(findUseStepIndex(steps, "actions/setup-node@")).not.toBe(-1);
      // Pin major versions are v6
      const checkoutStep = steps.find((s) =>
        (s.uses ?? "").startsWith("actions/checkout@"),
      );
      expect(checkoutStep!.uses).toBe("actions/checkout@v6");
      const setupStep = steps.find((s) =>
        (s.uses ?? "").startsWith("actions/setup-node@"),
      );
      expect(setupStep!.uses).toBe("actions/setup-node@v6");
    });
  });

  // ---- Just-in-case: the raw file is readable ----

  it("the workflow file exists and is non-empty", () => {
    expect(raw.length).toBeGreaterThan(0);
  });
});
