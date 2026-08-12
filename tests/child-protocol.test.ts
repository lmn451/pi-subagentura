import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath, readEvents } from "../src/artifact";
import { readActiveTurn, registerChildProtocol } from "../src/child-protocol";

function registerHandlers() {
  const handlers = new Map<string, Function>();
  const pi = {
    on: vi.fn((name: string, handler: Function) => handlers.set(name, handler)),
  };
  registerChildProtocol(pi as any);
  return handlers;
}

describe("child protocol lifecycle", () => {
  let root: string;
  let artifactDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), "pi-subagentura-child-protocol-"));
    artifactDir = join(root, "child");
    process.env.ARTIFACT_DIR = artifactDir;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_MARKER;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_NONCE;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_ATTEMPT_ID;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_EPOCH;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ARTIFACT_DIR;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_MARKER;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_NONCE;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_ATTEMPT_ID;
    delete process.env.PI_SUBAGENTURA_WORKFLOW_EPOCH;
    rmSync(root, { recursive: true, force: true });
  });

  it("records exact workflow child-start identity before registering handlers", () => {
    process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_MARKER = "wf-launch-marker";
    process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_NONCE = "nonce-1";
    process.env.PI_SUBAGENTURA_WORKFLOW_ATTEMPT_ID = "attempt-1";
    process.env.PI_SUBAGENTURA_WORKFLOW_EPOCH = "7";

    registerHandlers();

    expect(
      JSON.parse(
        readFileSync(join(artifactDir, "process-child-started.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      launchMarker: "wf-launch-marker",
      nonce: "nonce-1",
      attemptId: "attempt-1",
      epoch: 7,
    });
  });

  it("rejects partial workflow child identity before registering handlers", () => {
    process.env.PI_SUBAGENTURA_WORKFLOW_LAUNCH_MARKER = "wf-launch-marker";
    expect(() => registerHandlers()).toThrow(
      "Invalid workflow process launch identity",
    );
    expect(existsSync(join(artifactDir, "process-child-started.json"))).toBe(
      false,
    );
  });
  it("binds persisted turns and records activity plus settled completion", () => {
    const handlers = registerHandlers();
    let entries: any[] = [];
    const ctx = {
      sessionManager: {
        getEntries: () => entries,
      },
    };

    handlers.get("before_agent_start")!({}, ctx);
    expect(readActiveTurn()?.started).toBe(false);

    entries = [{ id: "user-1", type: "message", message: { role: "user" } }];
    handlers.get("turn_start")!({ timestamp: 100 }, ctx);
    vi.runAllTimers();
    expect(readActiveTurn()).toMatchObject({ turnId: "user-1", started: true });

    entries.push({ id: "user-2", type: "message", message: { role: "user" } });
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "tool-1" },
      ctx,
    );
    handlers.get("tool_execution_end")!(
      { toolName: "bash", toolCallId: "tool-1", isError: true },
      ctx,
    );
    handlers.get("agent_end")!(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readActiveTurn()).toMatchObject({
      turnId: "user-2",
      previousUserEntryId: "user-1",
      started: true,
    });
    const events = readEvents(artifactPath(root, "child"));
    expect(
      events.filter((event) => event.type === "turn_started"),
    ).toHaveLength(2);
    expect(
      events.filter(
        (event) =>
          event.type === "tool_activity" &&
          "turnId" in event &&
          event.turnId === "user-2",
      ),
    ).toMatchObject([
      { phase: "start", tool: "bash" },
      { phase: "end", summary: "bash failed" },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completion",
      turnId: "user-2",
      outcome: "done",
      source: "agent_settled",
    });
  });

  it("records an error completion and supports getBranch fallback", () => {
    const handlers = registerHandlers();
    let branch: any[] = [];
    const ctx = {
      sessionManager: {
        getBranch: () => branch,
      },
    };

    handlers.get("before_agent_start")!({}, ctx);
    branch = [{ id: "user-error", type: "message", message: { role: "user" } }];
    handlers.get("before_provider_request")!({}, ctx);
    handlers.get("agent_end")!(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider failed",
          },
        ],
      },
      ctx,
    );
    handlers.get("agent_settled")!({}, ctx);

    expect(readEvents(artifactPath(root, "child")).at(-1)).toMatchObject({
      type: "completion",
      turnId: "user-error",
      outcome: "error",
      exitCode: 1,
      errorMessage: "provider failed",
    });
  });

  it("requires ARTIFACT_DIR when registering", () => {
    delete process.env.ARTIFACT_DIR;
    expect(() => registerHandlers()).toThrow(/requires ARTIFACT_DIR/);
  });
});
