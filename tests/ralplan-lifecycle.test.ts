import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionHandlers } from "../src/session-handlers";
import { sessionOwner, clearSessionScopes } from "../src/session-scope";
import { workflowJobRegistry } from "../src/workflow-jobs";
import {
  clearRalplanBindingsForTests,
  createRalplanRun,
  getRalplanRunById,
} from "../src/ralplan-state";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ralplan-lifecycle-"));
  roots.push(value);
  return value;
}

function registration() {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getFlag: vi.fn(() => false),
  } as any;
  const scope = registerSessionHandlers(pi);
  return { handlers, scope };
}

afterEach(() => {
  const handle = (globalThis as any).__piSubagenturaInteractivePollerHandle;
  if (handle) clearInterval(handle);
  (globalThis as any).__piSubagenturaInteractivePollerHandle = undefined;
  workflowJobRegistry.clear();
  clearRalplanBindingsForTests();
  clearSessionScopes();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("RALPLAN session lifecycle", () => {
  it.each([
    ["reload", "interrupted"],
    ["resume", "interrupted"],
    ["quit", "interrupted"],
    ["new", "cancelled"],
    ["fork", "cancelled"],
  ])("cancels jobs before persisting %s evidence", (reason, phase) => {
    const cwd = root();
    const { handlers, scope } = registration();
    const ctx = {
      cwd,
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
      sessionManager: {
        getSessionId: () => "session-a",
        getEntries: () => [],
        getBranch: () => [],
      },
    };
    handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const owner = sessionOwner(scope);
    const record = createRalplanRun({
      cwd,
      workflowId: "wf_lifecycle",
      workflowName: "ralplan-occ",
      owner,
      parentSessionId: "session-a",
    });
    const abort = new AbortController();
    workflowJobRegistry.set("wf_lifecycle", {
      id: "wf_lifecycle",
      name: "ralplan-occ",
      status: "running",
      executionMode: "async",
      startedAt: Date.now(),
      promise: new Promise(() => {}),
      abort,
      snapshot: { agentsSpawned: 0, errorCount: 0, tokensSpent: 0, phases: [] },
      parentSessionOwner: owner,
    });

    if (
      reason === "reload" ||
      reason === "resume" ||
      reason === "new" ||
      reason === "fork"
    ) {
      handlers.get("session_start")![0]({ reason }, ctx);
    } else {
      handlers.get("session_shutdown")![0]({ reason }, ctx);
    }

    expect(abort.signal.aborted).toBe(true);
    expect(workflowJobRegistry.has("wf_lifecycle")).toBe(false);
    expect(getRalplanRunById(cwd, record.runId)).toMatchObject({
      phase,
      active: false,
      deactivationReason: `session ${reason}`,
    });
  });
});
