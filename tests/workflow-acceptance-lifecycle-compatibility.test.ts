import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { registerWorkflowTool } from "../src/workflow";
import {
  clearSessionScopes,
  createSessionScope,
  getSessionScopes,
  getStartedSessionScopes,
  registerSessionScope,
  setDurableWorkflowOwner,
  type SessionScope,
} from "../src/session-scope";
import {
  formatWorkflowContinuity,
  MAX_CONTINUITY_CHARS,
} from "../src/workflow-continuity";
import {
  runDurableWorkflowForSession,
  workflowOwnerFromSessionContext,
} from "../src/workflow-owner";
import { WorkflowRunStore } from "../src/workflow-run-store";
import type { WorkflowPlan } from "../src/workflow-plan";
import type { WorkflowOwnerIdentity } from "../src/workflow-run-types";
import { WORKFLOWS_DIR } from "../src/workflow-core";
import {
  createPiSessionHarness,
  type PiSessionHarness,
} from "./helpers/pi-session-harness";

const repoRoot = new URL("..", import.meta.url).pathname;
const roots: string[] = [];
const harnesses: PiSessionHarness[] = [];
const disposedHarnesses = new Set<PiSessionHarness>();
const stores: WorkflowRunStore[] = [];

function ownerFor(root: string, ownerId = "f18-owner"): WorkflowOwnerIdentity {
  return {
    projectKey: basename(root),
    cwd: root,
    piSessionId: "f18-session",
    ownerId,
    ownerGeneration: 0,
    leaseToken: `${ownerId}-lease`,
  };
}

function commandAndToolHarness(scope?: SessionScope) {
  const tools = new Map<string, { execute: Function }>();
  const commands = new Map<string, { handler: Function }>();
  const entries: unknown[] = [];
  const pi = {
    registerTool: vi.fn((tool: { name: string; execute: Function }) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, command: { handler: Function }) => {
      commands.set(name, command);
    }),
    sendMessage: vi.fn((message: unknown) => {
      entries.push(message);
    }),
  } as any;
  registerWorkflowTool(pi, scope);
  return { commands, entries, pi, tools };
}

function legacyScript(): string {
  return [
    'export const meta = { name: "f18-legacy", description: "compatibility" };',
    "return { received: args, cwd: cwd };",
  ].join("\n");
}

async function realScope(): Promise<{
  harness: PiSessionHarness;
  scope: SessionScope;
}> {
  const existingScopeIds = new Set(getSessionScopes().map(({ id }) => id));
  const harness = await createPiSessionHarness(repoRoot);
  harnesses.push(harness);
  const newScopes = getSessionScopes().filter(
    ({ id }) => !existingScopeIds.has(id),
  );
  const scope =
    newScopes.find(
      (candidate) => candidate.sessionManager === harness.sessionManager,
    ) ?? (newScopes.length === 1 ? newScopes[0] : undefined);
  if (!scope) throw new Error("real Pi harness has no session scope");
  scope.lifecycle = "started";
  scope.sessionManager = harness.sessionManager;
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  } as any;
  harness.session.extensionRunner.setUIContext(ui);
  scope.ui = ui;
  await harness.session.bindExtensions({ uiContext: ui });
  return { harness, scope };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    if (!disposedHarnesses.has(harness)) harness.dispose();
  }
  disposedHarnesses.clear();
  for (const scope of getSessionScopes())
    await scope.durableWorkflowStore?.release();
  clearSessionScopes();
  for (const store of stores.splice(0)) await store.release();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("frozen durable workflow lifecycle and compatibility acceptance", () => {
  it("F16 exercises real Pi startup, prompt, reload, and shutdown while auditing bounded continuity", async () => {
    const { harness, scope } = await realScope();
    const root = await mkdtemp(join(tmpdir(), "workflow-f16-lifecycle-"));
    roots.push(root);
    const owner = workflowOwnerFromSessionContext({
      projectKey: basename(root),
      cwd: root,
      sessionId: harness.sessionManager.getSessionId(),
      ownerId: "f16-owner",
      generation: 0,
      leaseToken: "f16-lease",
    });
    setDurableWorkflowOwner(scope, owner);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const plan: WorkflowPlan = {
      schemaVersion: 1,
      name: "f16-continuity",
      phases: [
        {
          id: "phase",
          mode: "sequential",
          tasks: [
            {
              id: "gated",
              prompt: "continuity task",
              approval: { policyHash: "f16-policy", denial: "stop" },
            },
          ],
        },
      ],
    };
    const projection = await runDurableWorkflowForSession(root, scope, {
      runId: "f16-continuity-run",
      plan,
      runAgent: vi.fn(async () => {
        throw new Error("approval should block dispatch");
      }),
    });
    expect(projection.status).toBe("blocked");
    expect(scope.durableWorkflowContinuity).toMatchObject({
      runId: projection.runId,
      revision: projection.revision,
      status: "blocked",
      approvalPendingCount: 1,
    });

    const continuity = formatWorkflowContinuity(
      scope.durableWorkflowContinuity!,
    );
    expect(continuity.length).toBeLessThanOrEqual(MAX_CONTINUITY_CHARS);
    expect(continuity).toContain("factual, non-authoritative; outputs omitted");
    expect(continuity).toContain("run=f16-continuity-run");
    expect(continuity).not.toContain("continuity task");

    const prompt = harness.session.prompt("inspect durable continuity");
    await vi.waitFor(() => expect(harness.contexts).toHaveLength(1));
    const firstContext = harness.contexts[0]!;
    expect(firstContext.systemPrompt).toContain(
      "Durable workflow continuity (factual, non-authoritative; outputs omitted):",
    );
    expect(firstContext.systemPrompt?.length ?? 0).toBeGreaterThan(0);
    harness.completeNext("continuity inspected");
    await prompt;
    await harness.session.waitForIdle();
    expect(
      harness.sessionManager
        .getEntries()
        .some(
          (entry: any) =>
            entry.type === "message" && entry.message?.role === "user",
        ),
    ).toBe(true);

    expect(harness.session.hasExtensionHandlers("before_agent_start")).toBe(
      true,
    );
    let reloadCallbackCalled = false;
    await harness.session.reload({
      beforeSessionStart: () => {
        reloadCallbackCalled = true;
      },
    });
    expect(reloadCallbackCalled).toBe(true);
    expect(scope.lifecycle).toBe("shutdown");
    expect(harness.session.hasExtensionHandlers("before_agent_start")).toBe(
      true,
    );
    expect(
      getStartedSessionScopes().some(
        (candidate) => candidate.sessionManager === harness.sessionManager,
      ),
    ).toBe(true);

    harness.session.dispose();
    disposedHarnesses.add(harness);
    expect(harness.session.isIdle).toBe(true);
  }, 30_000);

  it("F18 preserves registered legacy script/name calls and rejects durable JS/process before creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-f18-compat-"));
    roots.push(root);
    const owner = ownerFor(root);
    const scope = createSessionScope({} as any);
    scope.lifecycle = "started";
    scope.generation = 1;
    scope.durableWorkflowOwner = owner;
    scope.sessionManager = {
      getSessionId: () => owner.piSessionId,
      getEntries: () => [],
    };
    registerSessionScope(scope);
    const harness = commandAndToolHarness(scope);
    const workflowTool = harness.tools.get("workflow");
    const saveTool = harness.tools.get("save_workflow");
    const listTool = harness.tools.get("list_workflows");
    const deleteTool = harness.tools.get("delete_workflow");
    const durableTool = harness.tools.get("start_durable_workflow");
    expect(workflowTool).toBeDefined();
    expect(saveTool).toBeDefined();
    expect(listTool).toBeDefined();
    expect(deleteTool).toBeDefined();
    expect(durableTool).toBeDefined();

    const name = "f18-legacy";
    const file = join(WORKFLOWS_DIR, `${name}.js`);
    const hadOriginal = existsSync(file);
    const original = hadOriginal ? readFileSync(file) : undefined;
    try {
      const script = legacyScript();
      const direct = await workflowTool!.execute(
        "f18-direct",
        { script, args: { value: 7 }, async: false },
        new AbortController().signal,
        vi.fn(),
        { cwd: root },
      );
      expect(direct).toMatchObject({
        details: {
          status: "done",
          name,
          agentsSpawned: 0,
          errorCount: 0,
        },
      });
      expect(direct.content[0].text).toContain('"value":7');

      const saved = await saveTool!.execute("f18-save", { name, script });
      expect(saved).toMatchObject({
        details: { status: "saved", name },
      });
      expect(existsSync(file)).toBe(true);

      const listed = await listTool!.execute();
      expect(listed.details.workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name, description: "compatibility" }),
        ]),
      );
      const named = await workflowTool!.execute(
        "f18-name",
        { name, args: { value: 9 }, async: false },
        new AbortController().signal,
        vi.fn(),
        { cwd: root },
      );
      expect(named).toMatchObject({
        details: { status: "done", name, agentsSpawned: 0, errorCount: 0 },
      });
      expect(named.content[0].text).toContain('"value":9');

      const deleted = await deleteTool!.execute("f18-delete", { name });
      expect(deleted).toMatchObject({
        details: { status: "deleted", name },
      });
      expect(existsSync(file)).toBe(false);

      const durableStore = new WorkflowRunStore({
        rootDir: root,
        owner,
      });
      stores.push(durableStore);
      const beforeDurableRuns = await durableStore.listRunIds();
      const durableJs = await workflowTool!.execute(
        "f18-durable-js",
        { script, durable: true, async: false },
        new AbortController().signal,
        vi.fn(),
        { cwd: root },
      );
      expect(durableJs).toMatchObject({
        isError: true,
        details: { status: "unsupported_durable" },
      });
      expect(durableJs.content[0].text).toBe(
        "Durable JavaScript workflows are not supported; use start_durable_workflow with a declarative plan.",
      );
      expect(await durableStore.listRunIds()).toEqual(beforeDurableRuns);

      vi.spyOn(process, "cwd").mockReturnValue(root);
      const processPlan = {
        schemaVersion: 1,
        name: "f18-process-rejection",
        phases: [
          {
            id: "phase",
            mode: "sequential",
            tasks: [{ id: "task", prompt: "process", isolation: "process" }],
          },
        ],
      } as any;
      await expect(
        durableTool!.execute(
          "f18-process",
          { runId: "f18-process", plan: processPlan },
          undefined,
          vi.fn(),
          { cwd: root },
        ),
      ).rejects.toThrow("Process isolation is not supported by the preview");
      expect(await durableStore.listRunIds()).toEqual(beforeDurableRuns);
    } finally {
      if (hadOriginal) writeFileSync(file, original!);
      else if (existsSync(file)) unlinkSync(file);
    }
  });

  it("F20 audits the frozen documents without changing deferred boundaries or claiming X01-X06", () => {
    const todo = readFileSync(join(repoRoot, "todo.md"), "utf8");
    const qa = readFileSync(join(repoRoot, "qa.md"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const frozen = readFileSync(
      join(repoRoot, "docs/pr84-frozen-acceptance.md"),
      "utf8",
    );

    expect(todo).toContain("[DEFERRED — PR #84 foundation scope] 22.");
    expect(todo).toContain("[DEFERRED — PR #84 foundation scope] 29.");
    expect(todo).toContain(
      "[x] 60. Reject unsupported durable legacy requests",
    );
    expect(qa).toContain("X01–X05 (out-of-scope this PR) | Deferred");
    expect(qa).toContain(
      "X06 (security boundary)        | Deferred / helper-only checks",
    );
    expect(qa).toContain(
      "**X05:** exactly-once execution/notification claims.",
    );
    expect(frozen).toContain("Status: **merge-ready**");
    expect(frozen).toContain("X01–X05 remain explicitly deferred");
    expect(frozen).toContain("X06 remains");
    expect(readme).toContain("Process-isolated durable launch");
    expect(readme).toContain("exactly-once notification claims remain");
    expect(readme).not.toContain("exactly-once guarantees");
  });
});
