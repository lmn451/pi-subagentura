import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSessionScopes,
  removeSessionScope,
  sessionOwner,
} from "../src/session-scope";
import {
  launchInteractiveSubagent,
  registerInteractiveSubagentState,
  type InteractiveSubagentState,
} from "../src/interactive-tmux";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";
import { INTERACTIVE_ARTIFACT_OWNER_FILE } from "../src/artifact";
import { createTestSessionScope } from "./session-scope-fixture";

const mux = vi.hoisted(() => ({
  name: "tmux",
  createPane: vi.fn(() => ({ paneId: "%42", session: "mock" })),
  killPane: vi.fn(),
  sendKeys: vi.fn(),
  sendEnter: vi.fn(),
  buildAttachCommands: vi.fn(() => ({
    attachCommand: "mock",
    focusCommand: "mock",
  })),
}));
vi.mock("../src/multiplexer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/multiplexer")>()),
  getMux: () => mux,
}));

const roots: string[] = [];
const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;

afterEach(() => {
  clearSessionScopes();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  if (previousSessionDir === undefined) {
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  } else {
    process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
  }
  vi.clearAllMocks();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "interactive-owner-boundaries-"));
  roots.push(root);
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  return root;
}

it.each(["removed", "shutdown", "registered", "stale-token"] as const)(
  "rejects a %s explicit launch owner before creating a pane",
  (reason) => {
    const cwd = temporaryRoot();
    const scope = createTestSessionScope();
    const originalOwner = sessionOwner(scope);
    if (reason === "removed") {
      scope.lifecycle = "shutdown";
      scope.generation++;
      removeSessionScope(scope.id);
    } else if (reason === "shutdown") {
      scope.lifecycle = "shutdown";
    } else if (reason === "registered") {
      scope.lifecycle = "registered";
    } else {
      scope.generation++;
    }

    expect(() =>
      launchInteractiveSubagent({
        name: "late caller",
        task: "ownership probe",
        cwd,
        sessionScope: scope,
        supervisorOwner: reason === "stale-token" ? originalOwner : undefined,
      }),
    ).toThrow(/live session scope/);
    expect(mux.createPane).not.toHaveBeenCalled();
    expect(scope.interactiveStates.size).toBe(0);
  },
);

it("does not expose a live peer artifact sharing the persisted parent id", async () => {
  const cwd = temporaryRoot();
  const tools = new Map<string, any>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: vi.fn(),
    getFlag: () => undefined,
    appendEntry: vi.fn(),
  } as any;
  const sessionManager = { getSessionId: () => "same-persisted-parent" };
  const scopeA = createTestSessionScope({ pi, sessionManager });
  const scopeB = createTestSessionScope({ sessionManager });
  const id = "aabbccdd";
  const artifactDir = join(cwd, "child-project", "artifacts", id);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, INTERACTIVE_ARTIFACT_OWNER_FILE),
    "same-persisted-parent",
  );
  writeFileSync(join(artifactDir, "output.md"), "live scope B output");
  registerInteractiveSubagentState(
    {
      id,
      artifactDir,
      parentSessionId: "same-persisted-parent",
      status: "running",
    } as InteractiveSubagentState,
    scopeB,
  );
  registerInteractiveSubagentTools(pi, scopeA);

  const result = await tools
    .get("read_subagent_artifact")
    .execute("read", { id }, undefined, undefined, { cwd });

  expect(scopeA.interactiveStates.size).toBe(0);
  expect(scopeB.interactiveStates.has(id)).toBe(true);
  expect(result.details.status).toBe("not_found");
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).not.toContain("live scope B output");
});
