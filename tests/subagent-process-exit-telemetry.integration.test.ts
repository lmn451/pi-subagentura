import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendCompletionEvent,
  appendEvent,
  artifactPath,
} from "../src/artifact";
import { clearSessionScopes, registerSessionScope } from "../src/session-scope";
import { createTelemetrySession } from "../src/telemetry";
import { writeCliScript } from "../src/subagent-artifact-cli";
import { registerInteractiveSubagentTools } from "../src/tools/interactive";
import { importFresh } from "./test-utils";

const testRoots: string[] = [];
let previousAgentDir: string | undefined;

function makeTmp(): string {
  const root = mkdtempSync(join(tmpdir(), "subagentura-process-exit-"));
  testRoots.push(root);
  return root;
}

describe("interactive process-exit telemetry integration", () => {
  beforeEach(() => {
    clearSessionScopes();
    (globalThis as any).__piSubagenturaInteractiveRegistry?.clear?.();
    (globalThis as any).__piSubagenturaPiRef = undefined;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = makeTmp();
    process.env.PI_CODING_AGENT_DIR = root;
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.doMock("node:child_process", () => ({
      execFileSync: () => Buffer.from("%99\n"),
      execFile: (
        _file: string,
        _args: string[],
        _options: object,
        callback: Function,
      ) => callback(null, "%99\n"),
    }));
  });

  afterEach(() => {
    clearSessionScopes();
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    while (testRoots.length > 0) {
      rmSync(testRoots.pop()!, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "exit 0 while a tool is active",
      exitCode: 0,
      activeTool: true,
      completed: false,
      cancelled: false,
      expectedStatus: "error",
      expectedTerminalReason: "process_exit",
      expectedExitBucket: "zero",
      expectedFailureCode: "interactive_process_exit",
      expectedPhase: "active_tool",
      expectedKind: "unknown",
      expectedTerminationReason: "active_tool",
      expectedLocalDiagnostic: true,
    },
    {
      label: "nonzero exit after completion",
      exitCode: 17,
      activeTool: false,
      completed: true,
      cancelled: false,
      expectedStatus: "success",
      expectedTerminalReason: "completed",
      expectedExitBucket: undefined,
      expectedFailureCode: undefined,
      expectedPhase: undefined,
      expectedKind: undefined,
      expectedTerminationReason: "nonzero_exit",
      expectedLocalDiagnostic: true,
    },
    {
      label: "parent cancellation",
      exitCode: 143,
      activeTool: true,
      completed: false,
      cancelled: true,
      expectedStatus: "cancelled",
      expectedTerminalReason: "process_exit",
      expectedExitBucket: "nonzero",
      expectedFailureCode: undefined,
      expectedPhase: "active_tool",
      expectedKind: "cancelled",
      expectedTerminationReason: "cancelled",
      expectedLocalDiagnostic: false,
    },
  ] as const)(
    "$label keeps one outcome and reports local context",
    async (scenario) => {
      const mod =
        await importFresh<typeof import("../src/subagent")>("../src/subagent");
      const root = process.env.PI_CODING_AGENT_DIR!;
      const id = "deadbeefcafebabe";
      const artifactDir = join(root, id);
      mkdirSync(artifactDir, { recursive: true });
      const state: import("../src/interactive-tmux").InteractiveSubagentState =
        {
          id,
          name: "Test",
          task: "private task",
          paneId: "%99",
          mux: "tmux",
          sessionFile: join(root, "session.jsonl"),
          cwd: root,
          startedAt: 0,
          status: "running",
          attachCommand: "",
          selectPaneCommand: "",
          launchScriptFile: "",
          artifactDir,
          parentSessionId: "pi",
        };
      const telemetry = createTelemetrySession(true, "orchestrator_v2");
      const owner = { id: 901, generation: 1 };
      const toolDefinitions = new Map<string, any>();
      const parentPi = {
        sendMessage: vi.fn(),
        registerTool: (definition: { name: string }) =>
          toolDefinitions.set(definition.name, definition),
      };
      const scope = registerSessionScope({
        ...owner,
        lifecycle: "started",
        pi: parentPi as unknown as ExtensionAPI,
        ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } as any,
        sessionManager: { getSessionId: () => "pi" },
        telemetry,
      });
      Object.assign(state, {
        telemetryEligible: true,
        telemetryCorrelationId: telemetry.correlationId,
        telemetryActiveTurnId: "turn-1",
        telemetryTurnStartedAt: 1,
        telemetryInvocationSource: "interactive",
        telemetryCompletionPolicy: "each",
        telemetryAsync: true,
        telemetryDepth: 1,
        telemetryDepthBucket: "1",
        telemetryModel: "default",
      });
      scope.interactiveStates.set(id, state);
      mod.interactiveSubagentRegistry.set(id, state);

      const art = artifactPath(root, id);
      appendEvent(art, {
        version: 2,
        eventId: "turn-started",
        turnId: "turn-1",
        ts: 1,
        type: "turn_started",
        status: "running",
      });
      if (scenario.completed) {
        appendCompletionEvent(art, {
          turnId: "turn-1",
          outcome: "done",
          source: "agent_settled",
          exitCode: 0,
        });
      }
      if (scenario.cancelled)
        writeFileSync(join(artifactDir, ".cancelled"), "");
      writeFileSync(
        join(artifactDir, "active-turn.json"),
        JSON.stringify({
          turnId: "turn-1",
          started: true,
          startedAt: 1,
          activeTools: scenario.activeTool
            ? [
                {
                  name: "private_custom_tool",
                  callId: "opaque-private-call",
                  startedAt: 2,
                },
              ]
            : [],
          ...(scenario.activeTool ? { lastTool: "private_custom_tool" } : {}),
        }),
      );
      const cliPath = join(artifactDir, "cli.mjs");
      writeCliScript(cliPath);
      const cliResult = spawnSync(
        "node",
        [cliPath, "process-exit", String(scenario.exitCode)],
        {
          env: { ...process.env, ARTIFACT_DIR: artifactDir },
          encoding: "utf8",
        },
      );
      expect(cliResult.status).toBe(0);
      const events = readFileSync(art.statusFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.at(-1)).toMatchObject({
        type: "process_exited",
        processExitPhase: scenario.completed
          ? "after_completion"
          : "active_tool",
        processExitKind: scenario.cancelled
          ? "cancelled"
          : scenario.completed
            ? "nonzero"
            : scenario.exitCode === 0
              ? "unknown"
              : "nonzero",
        terminationReason: scenario.expectedTerminationReason,
      });
      if (!scenario.completed) {
        expect(events.at(-2)).toMatchObject({
          type: "completion",
          source: "process_exit",
          outcome: scenario.cancelled ? "cancelled" : "error",
          processExitPhase: "active_tool",
          processExitKind: scenario.cancelled
            ? "cancelled"
            : scenario.exitCode === 0
              ? "unknown"
              : "nonzero",
        });
      }

      const payloads: Array<{
        event?: string;
        properties?: Record<string, unknown>;
      }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        payloads.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      });
      const mux = await import("../src/multiplexer");
      mux.__setTmuxMultiplexer({
        getPaneLivenessAsync: async () => "dead",
      } as unknown as import("../src/multiplexer-contracts").Multiplexer);

      await mod.pollArtifactChanges({ sendMessage: vi.fn() } as any, owner);

      const completed = payloads.filter(
        (payload) => payload.event === "pi_subagentura_task_completed",
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]?.properties).toMatchObject({
        status: scenario.expectedStatus,
        terminal_reason: scenario.expectedTerminalReason,
      });
      if (scenario.expectedExitBucket) {
        expect(completed[0]?.properties?.exit_code_bucket).toBe(
          scenario.expectedExitBucket,
        );
      } else {
        expect(completed[0]?.properties).not.toHaveProperty("exit_code_bucket");
      }
      if (scenario.expectedFailureCode) {
        expect(completed[0]?.properties?.failure_code).toBe(
          scenario.expectedFailureCode,
        );
      } else {
        expect(completed[0]?.properties).not.toHaveProperty("failure_code");
      }
      if (scenario.expectedPhase) {
        expect(completed[0]?.properties?.process_exit_phase).toBe(
          scenario.expectedPhase,
        );
        expect(completed[0]?.properties?.process_exit_kind).toBe(
          scenario.expectedKind,
        );
      } else {
        expect(completed[0]?.properties).not.toHaveProperty(
          "process_exit_phase",
        );
        expect(completed[0]?.properties).not.toHaveProperty(
          "process_exit_kind",
        );
      }
      expect(JSON.stringify(payloads)).not.toContain("private_custom_tool");
      expect(JSON.stringify(payloads)).not.toContain("opaque-private-call");
      expect(JSON.stringify(payloads)).not.toContain("private task");

      registerInteractiveSubagentTools(
        parentPi as unknown as ExtensionAPI,
        scope,
      );
      const artifactTool = toolDefinitions.get("read_subagent_artifact");
      const artifactResult = await artifactTool.execute(
        "read-artifact",
        { id, output: false },
        undefined,
        undefined,
        { cwd: root },
      );
      const localText = artifactResult.content[0].text;
      expect(localText).toContain(
        `Process context: terminationReason=${scenario.expectedTerminationReason}`,
      );
      if (scenario.expectedLocalDiagnostic) {
        expect(localText).toContain(
          "Diagnostic [interactive_process_exit]: Interactive sub-agent process exit.",
        );
        expect(localText).toContain("processExitPhase=");
        expect(localText).toContain("processExitKind=");
      } else {
        expect(localText).not.toContain("Diagnostic [");
        expect(localText).toContain("processExitKind=cancelled");
      }
      expect(localText).not.toContain("private_custom_tool");
      expect(localText).not.toContain("opaque-private-call");
      expect(localText).not.toContain("private task");
      if (scenario.completed) {
        expect(localText).not.toContain(
          "before its authoritative turn completion",
        );
        expect(localText).toContain("processExitPhase=after_completion");
        expect(localText).toContain("processExitKind=nonzero");
      }
      const listTool = toolDefinitions.get("list_subagent_artifacts");
      const listResult = await listTool.execute(
        "list-artifacts",
        {},
        undefined,
        undefined,
        {
          cwd: root,
          ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
        },
      );
      expect(listResult.content[0].text).toContain(
        `Process context: terminationReason=${scenario.expectedTerminationReason}`,
      );
      if (scenario.expectedLocalDiagnostic) {
        expect(listResult.content[0].text).toContain(
          "Diagnostic [interactive_process_exit]: Interactive sub-agent process exit.",
        );
      } else {
        expect(listResult.content[0].text).not.toContain("Diagnostic [");
      }
    },
  );
});
