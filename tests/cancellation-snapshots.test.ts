import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  jobRegistry,
  registerInProcessJob,
  type JobState,
} from "../src/helpers";
import { registerInProcessSubagentTools } from "../src/tools/in-process";
import { cancelAllFlows } from "../src/cancel-all-flows";
import { registerSessionHandlers } from "../src/session-handlers";
import { clearSessionScopes, sessionOwner } from "../src/session-scope";
import { registerWorkflowTool } from "../src/workflow-tool";
import { startWorkflowJob, workflowJobRegistry } from "../src/workflow-jobs";
import {
  snapshotInProcessSession,
  snapshotInteractiveContext,
  type CancellationSnapshotReceipt,
} from "../src/cancellation-snapshots";
import type { CancellationSnapshotSource } from "../src/cancellation-snapshots";
import { interactiveSubagentRegistry } from "../src/interactive-tmux";
import { __setTmuxMultiplexer } from "../src/multiplexer";

const originalEnv = {
  mode: process.env.SUBAGENT_CANCEL_SNAPSHOT,
  dir: process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR,
  maxBytes: process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES,
};

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    model: { provider: "test", id: "model-1" },
    thinkingLevel: "high",
    state: {
      streamingMessage: {
        role: "assistant",
        content: [{ type: "text", text: "streaming" }],
      },
      pendingToolCalls: new Set<string>(["tool-1"]),
    },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          id: "entry-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        },
      ],
    },
    ...overrides,
  } as any;
}

function inProcessInput(session = fakeSession()) {
  return {
    kind: "in-process" as const,
    jobId: "job-1",
    session,
    cwd: "/tmp/project",
    parentSessionId: "parent-1",
    model: "test/model-1",
    thinkingLevel: "high",
    activeTool: { name: "bash", args: { command: "echo hi" } },
    partialOutput: "partial output",
    startedAt: 100,
    source: "cancel_subagent" as const,
  };
}

function interactiveInput(root: string) {
  const artifactDir = join(root, "artifacts", "interactive-1");
  const sessionFile = join(root, "child-session.jsonl");
  const eventsFile = join(artifactDir, "events.ndjson");
  const outputFile = join(artifactDir, "output.md");
  const activeTurnFile = join(artifactDir, "active-turn.json");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(sessionFile, '{"type":"session"}\n');
  writeFileSync(eventsFile, '{"type":"turn_started"}\n');
  writeFileSync(outputFile, "child output\n");
  writeFileSync(activeTurnFile, '{"turnId":"turn-1"}\n');
  return {
    kind: "interactive" as const,
    id: "interactive-1",
    parentSessionId: "parent-1",
    cwd: "/tmp/project",
    sessionFile,
    artifactDir,
    source: "cancel_interactive_subagent" as const,
    startedAt: 100,
  };
}

function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out;
}

function setSnapshotEnv(dir: string, maxBytes?: number): void {
  process.env.SUBAGENT_CANCEL_SNAPSHOT = "full";
  process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR = dir;
  if (maxBytes === undefined)
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES;
  else process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES = String(maxBytes);
}

beforeEach(() => {
  jobRegistry.clear();
  workflowJobRegistry.clear();
  clearSessionScopes();
  interactiveSubagentRegistry.clear();
  __setTmuxMultiplexer({
    getPaneLiveness: () => "dead",
  } as any);
});

afterEach(() => {
  if (originalEnv.mode === undefined)
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT;
  else process.env.SUBAGENT_CANCEL_SNAPSHOT = originalEnv.mode;
  if (originalEnv.dir === undefined)
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR;
  else process.env.SUBAGENT_CANCEL_SNAPSHOT_DIR = originalEnv.dir;
  if (originalEnv.maxBytes === undefined)
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES;
  else process.env.SUBAGENT_CANCEL_SNAPSHOT_MAX_BYTES = originalEnv.maxBytes;
  vi.restoreAllMocks();
  workflowJobRegistry.clear();
  interactiveSubagentRegistry.clear();
  __setTmuxMultiplexer(undefined);
});

describe("cancellation snapshots", () => {
  it("is disabled by default", () => {
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT;
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-off-"));
    const receipt = snapshotInProcessSession(inProcessInput());
    expect(receipt.status).toBe("disabled");
    expect(allFiles(root)).toHaveLength(0);
  });

  it("omits disabled receipts from cancel-all results", async () => {
    delete process.env.SUBAGENT_CANCEL_SNAPSHOT;
    const input = inProcessInput();
    jobRegistry.set("job-disabled", {
      id: "job-disabled",
      status: "running",
      session: { ...input.session, abort: vi.fn() },
      liveStatus: { output: input.partialOutput, activeTool: input.activeTool },
      cwd: input.cwd,
      modelLabel: input.model,
    } as any);

    const result = await cancelAllFlows();

    expect(result.jobsAborted).toBe(1);
    expect(result.snapshots).toEqual([]);
  });

  it("writes a private full in-process snapshot with canonical context and partial state", () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-full-"));
    setSnapshotEnv(root);
    const receipt = snapshotInProcessSession(inProcessInput());
    expect(receipt.status).toBe("written");
    expect(receipt.path).toBeDefined();
    const stat = statSync(receipt.path!);
    expect(stat.mode & 0o777).toBe(0o600);
    const payload = JSON.parse(readFileSync(receipt.path!, "utf8"));
    expect(payload.schemaVersion).toBe(1);
    expect(payload.kind).toBe("in-process");
    expect(payload.context.branchEntries).toHaveLength(1);
    expect(payload.context.streamingMessage).toBeDefined();
    expect(payload.context.partialOutput).toBe("partial output");
    expect(payload.context.activeTool.name).toBe("bash");
    expect(payload.session).toMatchObject({
      jobId: "job-1",
      sessionId: "session-1",
      model: "test/model-1",
      thinkingLevel: "high",
      cwd: "/tmp/project",
    });
    expect(payload.cancellation.source).toBe("cancel_subagent");
  });

  it("preserves a bounded partial snapshot and records explicit truncation metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-cap-"));
    setSnapshotEnv(root, 16 * 1024);
    const huge = fakeSession({
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            id: "huge",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "x".repeat(100_000) }],
            },
          },
        ],
      },
    });
    const receipt = snapshotInProcessSession({
      ...inProcessInput(huge),
      partialOutput: "y".repeat(100_000),
    });
    expect(["written", "truncated"]).toContain(receipt.status);
    const payload = JSON.parse(readFileSync(receipt.path!, "utf8"));
    expect(receipt.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(payload.truncated).toBe(true);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it("writes an interactive manifest with path, size, and hash metadata without copying transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-interactive-"));
    setSnapshotEnv(join(root, "snapshots"));
    const input = interactiveInput(root);
    const receipt = snapshotInteractiveContext({
      ...input,
      source: "session_shutdown",
      cancellationOrigin: "session_start",
      cancellationLifecycleReason: "startup",
    });
    expect(receipt.status).toBe("written");
    const payload = JSON.parse(readFileSync(receipt.path!, "utf8"));
    expect(payload.kind).toBe("interactive");
    expect(payload.cancellation).toMatchObject({
      source: "session_shutdown",
      cancellationOrigin: "session_start",
      cancellationLifecycleReason: "startup",
    });
    expect(payload.files.sessionFile.bytes).toBeGreaterThan(0);
    expect(payload.files.sessionFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(root, "snapshots", "interactive-1.jsonl"))).toBe(
      false,
    );
  });

  it("normalizes interactive snapshot cancellation metadata", () => {
    const supervisorRoot = mkdtempSync(
      join(tmpdir(), "cancel-snapshot-supervisor-"),
    );
    setSnapshotEnv(join(supervisorRoot, "snapshots"));
    const supervisorReceipt = snapshotInteractiveContext({
      ...interactiveInput(supervisorRoot),
      cancellationOrigin: "supervisor",
      cancellationLifecycleReason: "startup",
    });
    const supervisorPayload = JSON.parse(
      readFileSync(supervisorReceipt.path!, "utf8"),
    );
    expect(supervisorPayload.cancellation.cancellationOrigin).toBe(
      "supervisor",
    );
    expect(supervisorPayload.cancellation).not.toHaveProperty(
      "cancellationLifecycleReason",
    );

    const invalidRoot = mkdtempSync(
      join(tmpdir(), "cancel-snapshot-invalid-origin-"),
    );
    setSnapshotEnv(join(invalidRoot, "snapshots"));
    const invalidReceipt = snapshotInteractiveContext({
      ...interactiveInput(invalidRoot),
      cancellationOrigin: "invalid" as any,
      cancellationLifecycleReason: "startup",
    });
    const invalidPayload = JSON.parse(
      readFileSync(invalidReceipt.path!, "utf8"),
    );
    expect(invalidPayload.cancellation).not.toHaveProperty(
      "cancellationOrigin",
    );
    expect(invalidPayload.cancellation).not.toHaveProperty(
      "cancellationLifecycleReason",
    );
  });

  it("retains cancel-all origin in the pre-captured interactive snapshot", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "cancel-snapshot-all-interactive-"),
    );
    setSnapshotEnv(join(root, "snapshots"));
    const input = interactiveInput(root);
    const bootstrapPath = join(
      input.artifactDir,
      ".lineage-bootstrap-0123456789abcdef.json",
    );
    writeFileSync(bootstrapPath, "unconsumed", { mode: 0o600 });
    interactiveSubagentRegistry.set(input.id, {
      id: input.id,
      name: "interactive",
      task: "test",
      paneId: "%42",
      mux: "tmux",
      sessionFile: input.sessionFile,
      cwd: input.cwd,
      parentSessionId: input.parentSessionId,
      startedAt: input.startedAt,
      status: "running",
      attachCommand: "attach",
      selectPaneCommand: "focus",
      launchScriptFile: join(root, "launch.sh"),
      artifactDir: input.artifactDir,
    });

    const result = await cancelAllFlows();

    expect(result.interactiveKilled).toBe(1);
    expect(result.snapshots).toHaveLength(1);
    expect(existsSync(bootstrapPath)).toBe(false);
    const payload = JSON.parse(
      readFileSync(result.snapshots![0].path!, "utf8"),
    );
    expect(payload.cancellation).toMatchObject({
      source: "cancel_all",
      cancellationOrigin: "cancel_all",
    });
  });

  it("never blocks cancellation when snapshot capture fails", () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-error-"));
    setSnapshotEnv(root);
    const receipt = snapshotInProcessSession(
      inProcessInput({
        sessionManager: {
          getBranch: () => {
            throw new Error("broken");
          },
        },
      }),
    );
    expect(receipt.status).toBe("written");
    expect(receipt.errors).toContain("branch_entries_unavailable: broken");
  });

  it("is idempotent for overlapping cancellation paths", () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-idempotent-"));
    setSnapshotEnv(root);
    const first = snapshotInProcessSession(inProcessInput());
    const second = snapshotInProcessSession({
      ...inProcessInput(),
      source: "session_shutdown",
    });
    expect(first.path).toBe(second.path);
    expect(second.status).toBe("deduplicated");
    expect(allFiles(root)).toHaveLength(1);
  });

  it("captures all cancel-all snapshots before the first slow abort awaits", async () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-all-"));
    setSnapshotEnv(root);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let filesAtFirstAbort = 0;
    const abort1 = vi.fn(async () => {
      filesAtFirstAbort = allFiles(root).length;
      release();
    });
    const abort2 = vi.fn();
    const input = inProcessInput();
    const makeJob = (id: string, abort: () => Promise<void> | void) => ({
      id,
      status: "running",
      session: { ...input.session, abort },
      liveStatus: { output: "partial", activeTool: input.activeTool },
      cwd: input.cwd,
      modelLabel: input.model,
    });
    jobRegistry.set("job-1", makeJob("job-1", abort1) as any);
    jobRegistry.set("job-2", makeJob("job-2", abort2) as any);
    const resultPromise = cancelAllFlows();
    await pending;
    const result = await resultPromise;
    expect(filesAtFirstAbort).toBeGreaterThanOrEqual(2);
    expect(abort1).toHaveBeenCalledOnce();
    expect(abort2).toHaveBeenCalledOnce();
    expect(result.snapshots).toHaveLength(2);
  });

  it("reports snapshot receipt details on per-ID cancellation", async () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-per-id-"));
    setSnapshotEnv(root);
    const tools: Record<string, any> = {};
    registerInProcessSubagentTools({
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
    } as any);
    const abort = vi.fn();
    const input = inProcessInput();
    jobRegistry.set("job-1", {
      id: "job-1",
      status: "running",
      session: { ...input.session, abort },
      liveStatus: { output: input.partialOutput, activeTool: input.activeTool },
      cwd: input.cwd,
      modelLabel: input.model,
    } as any);
    const result = await tools.cancel_subagent.execute(
      "call",
      { jobId: "job-1" },
      undefined,
      undefined,
      { cwd: input.cwd, ui: { setStatus: vi.fn() } },
    );
    expect(result.details.snapshot.path).toBeDefined();
    expect(result.details.snapshot.status).toBe("written");
    expect(abort).toHaveBeenCalledOnce();
  });

  it("keeps explicit receipt errors out of notification content", async () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-notify-"));
    setSnapshotEnv(root);
    const receipt: CancellationSnapshotReceipt = {
      schemaVersion: 1,
      kind: "in-process",
      status: "error",
      enabled: true,
      source: "cancel_all",
      key: "key",
      error: "secret-like path details",
    };
    expect(JSON.stringify(receipt)).toContain("error");
    expect(JSON.stringify(receipt)).not.toContain("partial output");
  });

  it("propagates workflow cancellation callbacks to nested agents", async () => {
    const { runWorkflow } = await import("../src/workflow-worker");
    const controller = new AbortController();
    const receipt = {
      schemaVersion: 1 as const,
      kind: "in-process" as const,
      status: "written" as const,
      enabled: true,
      source: "workflow" as CancellationSnapshotSource,
      key: "workflow-key",
      path: "/private/workflow-snapshot.json",
    };
    const promise = runWorkflow(
      'export const meta = { name: "snapshot", description: "snapshot" }; return await agent("work");',
      {
        signal: controller.signal,
        runAgent: async ({ signal, onCancellationSnapshot }) => {
          return new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                onCancellationSnapshot?.(receipt);
                reject(new Error("Workflow aborted."));
              },
              { once: true },
            );
          });
        },
      },
    );
    await Promise.resolve();
    controller.abort();
    await expect(promise).rejects.toThrow("Workflow aborted");
  });

  it("waits for asynchronous workflow snapshot receipts before returning", async () => {
    setSnapshotEnv(mkdtempSync(join(tmpdir(), "workflow-receipt-wait-")));
    const tools: Record<string, any> = {};
    registerWorkflowTool({
      registerTool: (tool: any) => {
        tools[tool.name] = tool;
      },
    } as any);
    let markAgentEntered!: () => void;
    const agentEntered = new Promise<void>((resolve) => {
      markAgentEntered = resolve;
    });
    const receipt: CancellationSnapshotReceipt = {
      schemaVersion: 1,
      kind: "interactive",
      status: "written",
      enabled: true,
      source: "workflow",
      key: "async-workflow-receipt",
      path: "/private/async-workflow-snapshot.json",
    };
    const state = startWorkflowJob(
      "snapshot-wait",
      'export const meta = { name: "snapshot-wait", description: "test" }; return await agent("work");',
      {
        runAgent: async ({ signal, onCancellationSnapshot }) => {
          markAgentEntered();
          return new Promise<never>((_resolve, reject) => {
            const abort = () => {
              setTimeout(() => {
                onCancellationSnapshot?.(receipt);
                reject(new Error("Workflow aborted."));
              }, 25);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        },
      },
    );
    await agentEntered;
    const settlement = state.promise.catch((error: unknown) => error);

    const firstCancellation = tools.cancel_workflow.execute(
      "cancel-call",
      { workflowId: state.id },
      undefined,
      undefined,
    );
    const concurrentCancellation = tools.cancel_workflow.execute(
      "concurrent-cancel-call",
      { workflowId: state.id },
      undefined,
      undefined,
    );
    const [result, concurrentResult] = await Promise.all([
      firstCancellation,
      concurrentCancellation,
    ]);
    await expect(settlement).resolves.toMatchObject({
      message: "Workflow aborted.",
    });

    expect(result.details.snapshots).toContainEqual(receipt);
    expect(concurrentResult.details.snapshots).toContainEqual(receipt);
  });

  it("snapshots only the owning scope's jobs before aborting them", async () => {
    const root = mkdtempSync(join(tmpdir(), "cancel-snapshot-shutdown-"));
    setSnapshotEnv(root);
    type LifecycleHandler = (...args: unknown[]) => unknown;
    const handlers: Record<string, LifecycleHandler[]> = {};
    const peerHandlers: Record<string, LifecycleHandler[]> = {};
    const captureHandlers = (
      target: Record<string, LifecycleHandler[]>,
    ): ExtensionAPI =>
      ({
        on: (event: string, handler: LifecycleHandler) => {
          (target[event] ??= []).push(handler);
        },
      }) as unknown as ExtensionAPI;
    const scope = registerSessionHandlers(captureHandlers(handlers));
    const peerScope = registerSessionHandlers(captureHandlers(peerHandlers));
    const sessionManager = { getSessionId: () => "owner-session" };
    handlers.session_start.at(-1)!(
      { reason: "startup" },
      { cwd: root, sessionManager },
    );
    peerHandlers.session_start.at(-1)!(
      { reason: "startup" },
      {
        cwd: root,
        sessionManager: { getSessionId: () => "peer-session" },
      },
    );

    const input = inProcessInput();
    const abort = vi.fn(() => {
      expect(allFiles(root).length).toBeGreaterThan(0);
    });
    const peerAbort = vi.fn();
    const owner = sessionOwner(scope);
    const peerOwner = sessionOwner(peerScope);
    // The fixture supplies the fields exercised by scoped shutdown cleanup.
    const job = {
      id: "job-shutdown",
      status: "running",
      session: { ...input.session, abort },
      liveStatus: { output: input.partialOutput, activeTool: input.activeTool },
      cwd: input.cwd,
      modelLabel: input.model,
      deliveryOwner: {
        sessionScopeId: owner.id,
        sessionScopeGeneration: owner.generation,
      },
    } as unknown as JobState;
    const peerJob = {
      ...job,
      id: "job-peer",
      session: { ...input.session, abort: peerAbort },
      deliveryOwner: {
        sessionScopeId: peerOwner.id,
        sessionScopeGeneration: peerOwner.generation,
      },
    } as unknown as JobState;
    expect(registerInProcessJob(job, owner)).toBe(true);
    expect(registerInProcessJob(peerJob, peerOwner)).toBe(true);

    const shutdown = handlers.session_shutdown.at(-1)!;
    await shutdown({ reason: "new" }, { cwd: root, sessionManager });

    expect(abort).toHaveBeenCalledOnce();
    expect(job.cancellationSnapshot?.status).toBe("written");
    expect(scope.inProcessJobs.size).toBe(0);
    expect(jobRegistry.has(job.id)).toBe(false);
    expect(peerAbort).not.toHaveBeenCalled();
    expect(peerScope.inProcessJobs.get(peerJob.id)).toBe(peerJob);
    expect(jobRegistry.get(peerJob.id)).toBe(peerJob);

    await peerHandlers.session_shutdown.at(-1)!(
      { reason: "quit" },
      {
        cwd: root,
        sessionManager: { getSessionId: () => "peer-session" },
      },
    );
  });
});
