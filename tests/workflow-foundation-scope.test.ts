import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const qa = readFileSync(resolve(REPO_ROOT, "qa.md"), "utf8");
const todo = readFileSync(resolve(REPO_ROOT, "todo.md"), "utf8");
const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");

describe("workflow foundation scope", () => {
  it("keeps out-of-scope X01..X05 items explicitly deferred in todo", () => {
    const deferred = [
      ...Array.from({ length: 4 }, (_, i) => String(25 + i)),
      ...Array.from({ length: 9 }, (_, i) => String(29 + i)),
      "43",
    ];

    for (const id of deferred) {
      expect(
        todo,
        `todo.md must mark task ${id} as PR #84 foundation scope deferred`,
      ).toMatch(
        new RegExp(
          `^\\s*- \\[[^\\]]*PR #84 foundation scope[^\\]]*\\]\\s*${id}\\.`,
          "m",
        ),
      );
      expect(
        todo,
        `todo.md must not keep task ${id} as checked complete`,
      ).not.toContain(`- [x] ${id}.`);
    }
  });

  it("documents frozen scope and deferred roadmap in QA", () => {
    expect(qa).toMatch(/## 1\. Frozen plan scope in practice/);
    expect(qa).toMatch(/X01/);
    expect(qa).toMatch(/X02/);
    expect(qa).toMatch(/X03/);
    expect(qa).toMatch(/X04/);
    expect(qa).toMatch(/X05/);
    expect(qa).toMatch(/X06/);
    expect(qa).toMatch(/DEFERRED — PR #84 foundation scope/);
  });

  it("README explains production scope and doesn't over-claim notifications", () => {
    expect(readme).toMatch(/at-least-once/);
    expect(readme).toMatch(/trusted-command/i);
    expect(readme).toMatch(/claim-bound[\s\S]*launch intent/);
    expect(readme).toMatch(/durable JavaScript\s+replay/);
    expect(readme).toMatch(/deferred/i);
  });
});
