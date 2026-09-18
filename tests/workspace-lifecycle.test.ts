import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSessionHandlers } from "../src/session-handlers";
import { WORKSPACE_LEDGER_FILE } from "../src/workspace-ledger";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace lifecycle fencing", () => {
  it("preserves the repository ledger across an explicit /new transition", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-lifecycle-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    const ledger = join(root, ".git", WORKSPACE_LEDGER_FILE);
    writeFileSync(ledger, "durable-ledger", { mode: 0o600 });
    const api = { on: vi.fn() };
    const scope = registerSessionHandlers(api as any);
    scope.lifecycle = "started";
    scope.cwd = root;
    const shutdown = api.on.mock.calls.find(
      ([event]) => event === "session_shutdown",
    )?.[1];
    expect(shutdown).toBeTypeOf("function");
    shutdown({ reason: "new" }, { cwd: root });
    expect(readFileSync(ledger, "utf8")).toBe("durable-ledger");
  });
});
