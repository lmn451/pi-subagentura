import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/pi-ai";
import {
  E2E_API,
  E2E_MODEL,
  E2E_PROVIDER,
  createMockProviderConfig,
  getMockProviderState,
  resetMockProviderState,
  streamTextForTest,
  streamThinkingForTest,
  waitForGate,
} from "./terminal-e2e/fixtures/mock-provider";

const model = { provider: E2E_PROVIDER, id: E2E_MODEL, api: E2E_API } as any;
let gateDir: string;

async function events(stream: AsyncIterable<any>): Promise<any[]> {
  const result: any[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function context(...messages: any[]): Context {
  return { messages } as Context;
}

function assistantTool(id: string, marker: string) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "subagent_isolated",
        arguments: { task: marker },
      },
    ],
    timestamp: 0,
  };
}

function toolResult(id: string) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "subagent_isolated",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 0,
  };
}

afterEach(() => {
  resetMockProviderState();
  if (gateDir) rmSync(gateDir, { recursive: true, force: true });
  delete process.env.SUBAGENTURA_E2E_GATE_DIR;
});

describe("scripted terminal provider contract", () => {
  it("emits complete text events in order with fixed metadata", async () => {
    const result = await events(streamTextForTest("stable"));
    expect(result.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const deltas = result.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.delta)).toEqual(["sta", "ble"]);
    expect(deltas.map((event) => event.partial.content[0].text)).toEqual([
      "sta",
      "stable",
    ]);
    expect(result.at(-1).message.usage.cost.total).toBe(0);
    expect(result.at(-1).message.timestamp).toBe(1_700_000_000_000);
  });

  it("emits thinking events before text and has one terminal done", async () => {
    const result = await events(streamThinkingForTest("stable answer"));
    expect(result.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const thinkingDeltas = result.filter(
      (event) => event.type === "thinking_delta",
    );
    const textDeltas = result.filter((event) => event.type === "text_delta");
    expect(thinkingDeltas.map((event) => event.delta)).toEqual([
      "stable ",
      "reasoning",
    ]);
    expect(textDeltas.map((event) => event.delta)).toEqual([
      "stable ",
      "answer",
    ]);
    expect(result.filter((event) => event.type === "done")).toHaveLength(1);
  });

  it("emits fragmented JSON tool arguments and continues after the tool result", async () => {
    const config = createMockProviderConfig() as any;
    const initial = await events(
      config.streamSimple(
        model,
        context({ role: "user", content: "[E2E:SYNC_ISOLATED]" }),
      ),
    );
    expect(initial.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const fragments = initial
      .filter((event) => event.type === "toolcall_delta")
      .map((event) => event.delta)
      .join("");
    expect(JSON.parse(fragments).task).toContain("CHILD_SYNC_ISOLATED");
    const id = initial.find((event) => event.type === "toolcall_end").toolCall
      .id;
    const next = await events(
      config.streamSimple(
        model,
        context(
          { role: "user", content: "[E2E:SYNC_ISOLATED]" },
          assistantTool(id, "[E2E:SYNC_ISOLATED]"),
          toolResult(id),
        ),
      ),
    );
    expect(next.at(-1).message.content[0].text).toContain("Parent settled");
    expect(getMockProviderState().get("[E2E:SYNC_ISOLATED]")?.stage).toBe(
      "complete",
    );
  });

  it("waits on a gate and aborts without a done event", async () => {
    gateDir = mkdtempSync(join(tmpdir(), "subagentura-e2e-gates-"));
    process.env.SUBAGENTURA_E2E_GATE_DIR = gateDir;
    const config = createMockProviderConfig() as any;
    const controller = new AbortController();
    const stream = config.streamSimple(
      model,
      context({ role: "user", content: "[E2E:CHILD_SYNC_CONTEXT]" }),
      { signal: controller.signal },
    );
    // Poll for the gate-wait state instead of sleeping: this tree has no fixed
    // sleeps and adding one here would make the test time-dependent.
    await vi.waitFor(() =>
      expect(
        getMockProviderState().get("[E2E:CHILD_SYNC_CONTEXT]")?.stage,
      ).toBe("gated"),
    );
    controller.abort();
    const result = await events(stream);
    expect(result.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.at(-1).reason).toBe("aborted");
    expect(result.some((event) => event.type === "done")).toBe(false);
  });

  it("rejects an already-aborted request even when its gate exists", async () => {
    gateDir = mkdtempSync(join(tmpdir(), "subagentura-e2e-gates-"));
    process.env.SUBAGENTURA_E2E_GATE_DIR = gateDir;
    writeFileSync(join(gateDir, "already-released"), "release\n");
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForGate("already-released", controller.signal),
    ).rejects.toThrow("aborted");
  });

  it("selects the newest marker instead of a retained historical marker", async () => {
    const config = createMockProviderConfig() as any;
    const stream = config.streamSimple(
      model,
      context(
        { role: "user", content: "old [E2E:SYNC_CONTEXT]" },
        { role: "user", content: "new [E2E:SYNC_ISOLATED]" },
      ),
    );
    const result = await events(stream);
    expect(
      result.find((event) => event.type === "toolcall_end").toolCall.arguments
        .task,
    ).toContain("CHILD_SYNC_ISOLATED");
  });

  it("routes async and workflow lookups with their typed result ids", async () => {
    const config = createMockProviderConfig();
    const jobId = "0123456789abcdef";
    const workflowId = "wf_0123456789";
    const routes = [
      {
        marker: "[E2E:ASYNC_STATUS]",
        resultTool: "subagent_isolated",
        details: { jobId },
        callName: "get_subagent_status",
        argument: "jobId",
        value: jobId,
      },
      {
        marker: "[E2E:ASYNC_RESULT]",
        resultTool: "subagent_isolated",
        details: { jobId },
        callName: "get_subagent_result",
        argument: "jobId",
        value: jobId,
      },
      {
        marker: "[E2E:WORKFLOW_STATUS]",
        resultTool: "workflow",
        details: { workflowId },
        callName: "get_workflow_status",
        argument: "workflowId",
        value: workflowId,
      },
      {
        marker: "[E2E:WORKFLOW_RESULT]",
        resultTool: "workflow",
        details: { workflowId },
        callName: "get_workflow_result",
        argument: "workflowId",
        value: workflowId,
      },
    ] as const;

    for (const route of routes) {
      const result = await events(
        config.streamSimple(
          model,
          context(
            {
              role: "toolResult",
              toolCallId: `result-${route.marker}`,
              toolName: route.resultTool,
              content: [{ type: "text", text: "Lookup result ready." }],
              details: route.details,
              isError: false,
              timestamp: 0,
            },
            { role: "user", content: route.marker },
          ),
        ),
      );
      const call = result.find(
        (event) => event.type === "toolcall_end",
      ).toolCall;
      expect(call.name).toBe(route.callName);
      expect(call.arguments[route.argument]).toBe(route.value);
    }
  });

  it("routes interactive follow-up and cancel to the launched id", async () => {
    const config = createMockProviderConfig();
    const interactiveId = "1234567890abcdef";
    const competingOwnership = {
      parentSessionId: "019faf8a-0000-4000-8000-000000000000",
      sessionId: "deadbeef-1111-4111-8111-111111111111",
    };
    const request = async (
      marker:
        | "[E2E:INTERACTIVE_FOLLOWUP_PARENT]"
        | "[E2E:INTERACTIVE_CANCEL_PARENT]",
      details: Record<string, unknown>,
    ) => {
      const result = await events(
        config.streamSimple(
          model,
          context(
            {
              role: "toolResult",
              toolCallId: "e2e-interactive-parent-1",
              toolName: "subagent_interactive",
              content: [
                {
                  type: "text",
                  text: `Interactive sub-agent ${interactiveId} started (visible split) in tmux pane %42.`,
                },
              ],
              details,
              isError: false,
              timestamp: 0,
            },
            { role: "user", content: marker },
          ),
        ),
      );
      return result.find((event) => event.type === "toolcall_end").toolCall;
    };

    const followUp = await request("[E2E:INTERACTIVE_FOLLOWUP_PARENT]", {
      ...competingOwnership,
      id: interactiveId,
    });
    expect(followUp.name).toBe("send_interactive_subagent_message");
    expect(followUp.arguments.id).toBe(interactiveId);

    const cancel = await request("[E2E:INTERACTIVE_CANCEL_PARENT]", {
      ...competingOwnership,
      id: interactiveId,
    });
    expect(cancel.name).toBe("cancel_interactive_subagent");
    expect(cancel.arguments.jobId).toBe(interactiveId);
  });

  it("fails with one terminal error for an explicit scripted error", async () => {
    const config = createMockProviderConfig() as any;
    const result = await events(
      config.streamSimple(
        model,
        context({ role: "user", content: "[E2E:ERROR]" }),
      ),
    );
    expect(result.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.at(-1).error.stopReason).toBe("error");
  });

  it("rejects unknown E2E markers instead of using a generic route", async () => {
    const config = createMockProviderConfig() as any;
    const result = await events(
      config.streamSimple(
        model,
        context({ role: "user", content: "[E2E:MISSPELLED_ROUTE]" }),
      ),
    );

    expect(result.map((event) => event.type)).toEqual(["start", "error"]);
    expect(result.at(-1).error.errorMessage).toContain(
      "rejected unknown E2E marker",
    );
  });
});
