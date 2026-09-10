import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendCompletionEvent,
  artifactPath,
  writeOutput,
} from "../src/artifact";
import {
  clearCompletionCoordinator,
  prepareCompletionManifest,
  publishCompletion,
  type CompletionSource,
} from "../src/completion-coordinator";
import { sessionLedgerPath } from "../src/completion-ledger";
import {
  jobRegistry,
  registerInProcessJob,
  type JobState,
  type SubagentResult,
} from "../src/helpers";
import type { InteractiveSubagentState } from "../src/interactive-tmux";
import {
  clearSessionScopes,
  registerSessionScope,
  sessionOwner,
  type SessionScope,
} from "../src/session-scope";
import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";
import {
  startWorkflowJob,
  workflowJobRegistry,
  type WorkflowJobState,
} from "../src/workflow-jobs";
import { registerWorkflowTool } from "../src/workflow-tool";

describe("result collection during receipt storage failure", () => {
  let root: string;
  let scope: SessionScope;
  let receiptPath: string;
  let unavailable: boolean;
  let entries: Array<{ type: string; customType: string; data: unknown }>;
  let tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;

  beforeEach(() => {
    clearSessionScopes();
    root = mkdtempSync(join(tmpdir(), "subagentura-result-receipt-"));
    unavailable = true;
    entries = [];
    tools = new Map();
    const pi = {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
      getFlag: () => undefined,
      appendEntry: (customType: string, data: unknown) => {
        if (unavailable && customType === "subagentura-completion-consumed") {
          throw new Error("receipt storage unavailable");
        }
        entries.push({ type: "custom", customType, data });
      },
    } as unknown as ExtensionAPI;
    scope = registerSessionScope({
      id: 1,
      generation: 1,
      lifecycle: "started",
      parentStreaming: true,
      cwd: root,
      pi,
      sessionManager: {
        getSessionId: () => "receipt-session",
        getSessionDir: () => root,
        getEntries: () => entries,
      },
    });
    receiptPath = sessionLedgerPath(
      root,
      "receipt-session",
      "subagentura-completion-consumed",
    );
    mkdirSync(receiptPath, { recursive: true });
    registerInProcessSubagentTools(pi, scope);
    registerInteractiveSubagentTools(pi, scope);
    registerWorkflowTool(pi, scope);
  });

  afterEach(() => {
    clearCompletionCoordinator(sessionOwner(scope));
    jobRegistry.clear();
    workflowJobRegistry.clear();
    clearSessionScopes();
    rmSync(root, { recursive: true, force: true });
  });

  function publish(source: CompletionSource, sourceId: string): void {
    publishCompletion(
      {
        schemaVersion: 1,
        completionId: `completion-${sourceId}`,
        source,
        sourceId,
        ...(source === "interactive" ? { turnId: "turn-result" } : {}),
        label: "Result",
        status: "done",
        policy: "each",
        references: [{ label: "result", value: sourceId }],
        completedAt: Date.now(),
      },
      sessionOwner(scope),
    );
  }

  function restoreStorage(): void {
    rmSync(receiptPath, { recursive: true });
    unavailable = false;
  }

  function expectDurableConsumption(): void {
    expect(
      entries.some(
        (entry) => entry.customType === "subagentura-completion-consumed",
      ),
    ).toBe(true);
    clearCompletionCoordinator(sessionOwner(scope));
    expect(prepareCompletionManifest(sessionOwner(scope))).toBeUndefined();
  }

  it("preserves an in-process result and collection cleanup until the receipt succeeds", async () => {
    const result: SubagentResult = {
      isError: false,
      output: "retained result",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 1,
      },
    };
    const job: JobState = {
      id: "receipt-job",
      status: "done",
      session: {} as JobState["session"],
      startedAt: Date.now(),
      liveStatus: { turn: 1, output: result.output, usage: result.usage },
      result,
      promise: Promise.resolve(result),
      completionPolicy: "each",
      cleanupAfterCollection: true,
    };
    expect(registerInProcessJob(job, sessionOwner(scope))).toBe(true);
    publish("in-process", job.id);
    const read = () =>
      tools.get("get_subagent_result")!.execute("read", { jobId: job.id });

    await expect(read()).rejects.toThrow(/receipt.*persist|persist.*receipt/i);
    expect(job.resultRetrieved).not.toBe(true);
    expect(job.cleanupAfterCollection).toBe(true);
    expect(jobRegistry.get(job.id)).toBe(job);
    restoreStorage();
    expect((await read()).content[0].text).toBe(result.output);
    expect(job.resultRetrieved).toBe(true);
    expectDurableConsumption();
  });

  it.each([false, true])(
    "preserves a workflow result for retry (error=%s)",
    async (failed) => {
      const job: WorkflowJobState = startWorkflowJob(
        "receipt-workflow",
        'export const meta = { name: "receipt-workflow", description: "d" };\n' +
          (failed
            ? 'throw new Error("workflow failure");'
            : 'return "retained result";'),
        { runAgent: vi.fn() },
        undefined,
        undefined,
        sessionOwner(scope),
      );
      await job.promise.catch(() => undefined);
      job.completionPolicy = "each";
      publish("workflow", job.id);
      const read = () =>
        tools
          .get("get_workflow_result")!
          .execute("read", { workflowId: job.id });

      await expect(read()).rejects.toThrow(
        /receipt.*persist|persist.*receipt/i,
      );
      expect(job.resultRetrieved).not.toBe(true);
      expect(workflowJobRegistry.get(job.id)).toBe(job);
      restoreStorage();
      expect((await read()).content[0].text).toContain(
        failed ? "workflow failure" : "retained result",
      );
      expect(job.resultRetrieved).toBe(true);
      expectDurableConsumption();
    },
  );

  it("preserves an interactive snapshot for retry", async () => {
    const id = "abcd123400000001";
    const art = artifactPath(root, id);
    writeOutput(art, "retained snapshot");
    appendCompletionEvent(art, {
      turnId: "turn-result",
      outcome: "done",
      source: "agent_settled",
    });
    scope.interactiveStates.set(id, {
      id,
      name: "Result",
      task: "task",
      cwd: root,
      artifactDir: art.dir,
      status: "exited",
      mux: "tmux",
      paneId: "%99",
      startedAt: Date.now(),
      sessionFile: join(root, "session.jsonl"),
      launchScriptFile: join(root, "launch.sh"),
      attachCommand: "",
      selectPaneCommand: "",
    } satisfies InteractiveSubagentState);
    publish("interactive", id);
    const read = () =>
      tools
        .get("read_subagent_artifact")!
        .execute("read", { id, turnId: "turn-result" }, undefined, undefined, {
          cwd: root,
        });

    await expect(read()).rejects.toThrow(/receipt.*persist|persist.*receipt/i);
    restoreStorage();
    expect((await read()).details.output).toBe("retained snapshot");
    expectDurableConsumption();
  });
});
