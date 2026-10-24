import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const E2E_PROVIDER = "subagentura-e2e";
export const E2E_MODEL = "mock";
export const E2E_API = "subagentura-e2e";
const FIXED_TIMESTAMP = 1_700_000_000_000;
const GATE_TIMEOUT_MS = Number(
  process.env.SUBAGENTURA_E2E_GATE_TIMEOUT_MS ?? 30_000,
);

type Stage = "initial" | "toolIssued" | "gated" | "complete" | "failed";
type State = {
  stage: Stage;
  requestSeq: number;
  toolCallId?: string;
  toolName?: string;
};

const states = new Map<string, State>();

function observedToolResults(
  context: TranscriptContext,
): Array<Record<string, unknown>> {
  return context.messages.flatMap((entry) =>
    entry.role === "toolResult"
      ? [
          {
            toolName: entry.toolName,
            text: entry.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n"),
            details: entry.details,
          },
        ]
      : [],
  );
}

function issue(
  marker: string,
  requestSeq: number,
  call: ToolCall,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): void {
  const final = message([call], "toolUse");
  states.set(marker, {
    stage: "toolIssued",
    requestSeq,
    toolCallId: call.id,
    toolName: call.name,
  });
  emit(stream, toolEvents(final), final);
  diagnostic({
    marker,
    requestSeq,
    afterStage: "toolIssued",
    toolCallName: call.name,
    eventType: "tool_call",
  });
}

function readOnlyWorkflowRequest(
  marker: string,
  requestSeq: number,
  state: State,
  context: TranscriptContext,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): void {
  const processMode = marker === "[E2E:CHILD_WORKFLOW_READONLY_PROCESS]";
  const sourcePath = join(process.cwd(), "readonly-source.ts");
  const outputPath = processMode
    ? join(artifactDir(), "output.md")
    : join(process.cwd(), "readonly-output.md");
  const previousTool = state.toolName;
  if (!previousTool) {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-readonly-read", "read", { path: sourcePath }),
      stream,
    );
    return;
  }
  if (
    !latestToolResult(context) ||
    latestToolResult(context) !== state.toolCallId
  )
    throw new Error(`read-only fixture expected result for ${previousTool}`);
  if (previousTool === "read") {
    if (!toolResultText(context, "read").includes("READ_ONLY_SOURCE_SENTINEL"))
      throw new Error("read-only fixture did not read the temporary source");
    issue(
      marker,
      requestSeq,
      toolCall("e2e-readonly-write", "write", {
        path: outputPath,
        content: "FORBIDDEN_OUTPUT_WRITE",
      }),
      stream,
    );
    return;
  }
  if (previousTool === "write") {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-readonly-edit", "edit", {
        path: sourcePath,
        edits: [
          {
            oldText: "READ_ONLY_SOURCE_SENTINEL",
            newText: "FORBIDDEN_EDIT",
          },
        ],
      }),
      stream,
    );
    return;
  }
  if (previousTool === "edit") {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-readonly-bash", "bash", {
        command:
          `printf 'FORBIDDEN_BASH' > ${shellQuote(sourcePath)}` +
          (processMode
            ? ` && node ${shellQuote(join(artifactDir(), "cli.mjs"))} done 0`
            : ""),
      }),
      stream,
    );
    return;
  }
  if (previousTool === "bash") {
    issue(
      marker,
      requestSeq,
      toolCall(
        "e2e-readonly-spawn",
        processMode ? "subagent_interactive" : "subagent_isolated",
        {
          name: "E2E read-only forbidden nested spawn",
          task: "[E2E:CHILD_READONLY_NESTED_SPAWN] Attempt a mutation.",
          model: E2E_PROVIDER + "/" + E2E_MODEL,
          background: true,
          notifyOnComplete: "notify",
          triggerTurnOnComplete: false,
        },
      ),
      stream,
    );
    return;
  }
  if (
    previousTool === "subagent_interactive" ||
    previousTool === "subagent_isolated"
  ) {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-readonly-mcp", "mcp__e2e__mutate", {
        path: join(process.cwd(), "readonly-mcp-created.txt"),
        content: "FORBIDDEN_MCP_MUTATION",
      }),
      stream,
    );
    return;
  }
  if (previousTool === "mcp__e2e__mutate") {
    if (marker.includes("_IN_PROCESS")) {
      issue(
        marker,
        requestSeq,
        toolCall("e2e-readonly-structured", "structured_output", {
          value: { source: "READ_ONLY_SOURCE_SENTINEL" },
        }),
        stream,
      );
      diagnostic({
        marker,
        requestSeq,
        afterStage: "complete",
        eventType: "structured_output",
      });
      return;
    }
    const final = message([
      {
        type: "text",
        text: JSON.stringify({ source: "READ_ONLY_SOURCE_SENTINEL" }),
      },
    ]);
    states.set(marker, { stage: "complete", requestSeq });
    emit(stream, textEvents(final), final);
    diagnostic({
      marker,
      requestSeq,
      afterStage: "complete",
      eventType: "done",
    });
    return;
  }
  if (previousTool === "structured_output")
    throw new Error("structured_output should terminate the SDK child turn");
  throw new Error(`unexpected read-only fixture tool result: ${previousTool}`);
}

function processMcpControlRequest(
  marker: string,
  requestSeq: number,
  state: State,
  context: TranscriptContext,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
): void {
  const previousTool = state.toolName;
  const outputPath = join(artifactDir(), "output.md");
  if (!previousTool) {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-mcp-control", "mcp__e2e__mutate", {
        path: join(process.cwd(), "readonly-mcp-control.txt"),
        content: "PROCESS_MCP_CONTROL_SENTINEL",
      }),
      stream,
    );
    return;
  }
  if (
    latestToolResult(context) !== state.toolCallId ||
    (previousTool !== "mcp__e2e__mutate" &&
      previousTool !== "write" &&
      previousTool !== "bash")
  )
    throw new Error(
      `MCP control fixture expected an allowed result, got ${previousTool}`,
    );
  if (previousTool === "mcp__e2e__mutate") {
    if (
      !toolResultText(context, previousTool).includes(
        "E2E fixture file written.",
      )
    )
      throw new Error("MCP control fixture mutator did not execute");
    issue(
      marker,
      requestSeq,
      toolCall("e2e-mcp-control-output", "write", {
        path: outputPath,
        content: JSON.stringify({ written: true }),
      }),
      stream,
    );
    return;
  }
  if (previousTool === "write") {
    issue(
      marker,
      requestSeq,
      toolCall("e2e-mcp-control-done", "bash", {
        command: `node ${shellQuote(join(artifactDir(), "cli.mjs"))} done 0`,
      }),
      stream,
    );
    return;
  }
  const final = message([
    { type: "text", text: JSON.stringify({ written: true }) },
  ]);
  states.set(marker, { stage: "complete", requestSeq });
  emit(stream, textEvents(final), final);
  diagnostic({
    marker,
    requestSeq,
    afterStage: "complete",
    eventType: "done",
  });
}
function diagnostic(record: Record<string, unknown>): void {
  const path = process.env.SUBAGENTURA_E2E_LOG;
  if (!path) return;
  appendFileSync(
    path,
    `${JSON.stringify({ pid: process.pid, provider: E2E_PROVIDER, model: E2E_MODEL, ...record })}\n`,
    { mode: 0o600 },
  );
}

function markers(value: unknown): string[] {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return [...text.matchAll(/\[E2E:[A-Z0-9_:-]+\]/g)].map((match) => match[0]);
}

function newestMarker(context: TranscriptContext): string | undefined {
  const latest = context.messages.at(-1);
  if (!latest) return undefined;
  const values: unknown[] = [];
  if (latest.role === "user") values.push(latest.content);
  if (latest.role === "toolResult") {
    values.push(latest.content, latest.details);
  }
  if (latest.role === "assistant") values.push(latest.content);
  const found = values.flatMap(markers);
  return found.at(-1);
}

function latestToolResult(context: TranscriptContext): string | undefined {
  const latest = context.messages.at(-1);
  return latest?.role === "toolResult" ? latest.toolCallId : undefined;
}

function toolResultText(context: TranscriptContext, toolName: string): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const current = context.messages[index];
    if (current.role !== "toolResult" || current.toolName !== toolName)
      continue;
    return JSON.stringify([current.content, current.details]);
  }
  throw new Error(`mock provider could not find result for ${toolName}`);
}

function resultId(
  context: TranscriptContext,
  toolName: string,
  pattern: RegExp,
): string {
  const id = toolResultText(context, toolName).match(pattern)?.[0];
  if (!id) throw new Error(`mock provider could not find ${toolName} id`);
  return id;
}

const INTERACTIVE_ID = /^[a-f0-9]{16}$/;
const INTERACTIVE_LAUNCH = /^Interactive sub-agent ([a-f0-9]{16}) started \(/;

function interactiveResultId(context: TranscriptContext): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const current = context.messages[index];
    if (
      current.role !== "toolResult" ||
      current.toolName !== "subagent_interactive"
    ) {
      continue;
    }

    const details = current.details;
    if (details && typeof details === "object" && "id" in details) {
      const id = details.id;
      if (typeof id === "string" && INTERACTIVE_ID.test(id)) return id;
    }

    const launchText = current.content.find((part) => part.type === "text");
    const fallback =
      launchText?.type === "text"
        ? launchText.text.match(INTERACTIVE_LAUNCH)?.[1]
        : undefined;
    if (fallback) return fallback;

    throw new Error(
      "mock provider could not find a valid subagent_interactive id in its latest result",
    );
  }
  throw new Error(
    "mock provider could not find result for subagent_interactive",
  );
}

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: E2E_API,
    provider: E2E_PROVIDER,
    model: E2E_MODEL,
    usage: {
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: FIXED_TIMESTAMP,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function toolCall(
  id: string,
  name: string,
  args: ToolCall["arguments"],
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

const KNOWN_MARKERS = new Set([
  "[E2E:SMOKE]",
  "[E2E:TOOL_PARAMETERS]",
  "[E2E:SYNC_CONTEXT]",
  "[E2E:SYNC_ISOLATED]",
  "[E2E:ASYNC_ISOLATED]",
  "[E2E:WORKFLOW_SYNC]",
  "[E2E:WORKFLOW_ASYNC]",
  "[E2E:WORKFLOW_PROCESS]",
  "[E2E:WORKFLOW_PARTIAL]",
  "[E2E:ASYNC_STATUS]",
  "[E2E:ASYNC_RESULT]",
  "[E2E:WORKFLOW_STATUS]",
  "[E2E:WORKFLOW_RESULT]",
  "[E2E:INTERACTIVE]",
  "[E2E:INTERACTIVE_FOLLOWUP_PARENT]",
  "[E2E:INTERACTIVE_CANCEL_PARENT]",
  "[E2E:INTERACTIVE_ERROR_PARENT]",
  "[E2E:CANCEL]",
  "[E2E:ERROR]",
  "[E2E:CHILD_SMOKE]",
  "[E2E:CHILD_SYNC_CONTEXT]",
  "[E2E:CHILD_SYNC_ISOLATED]",
  "[E2E:CHILD_ASYNC_ISOLATED]",
  "[E2E:CHILD_WORKFLOW]",
  "[E2E:CHILD_WORKFLOW_PROCESS]",
  "[E2E:CHILD_WORKFLOW_READONLY_PROCESS]",
  "[E2E:CHILD_WORKFLOW_MCP_CONTROL_PROCESS]",
  "[E2E:CHILD_WORKFLOW_READONLY_IN_PROCESS]",
  "[E2E:CHILD_READONLY_NESTED_SPAWN]",
  "[E2E:WORKFLOW_READONLY_PROCESS]",
  "[E2E:WORKFLOW_READONLY_IN_PROCESS]",
  "[E2E:WORKFLOW_LIST_RUNS]",
  "[E2E:DURABLE_CANCEL_SYNC]",
  "[E2E:CHILD_DURABLE_CANCEL_PROCESS]",
  "[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS]",
  "[E2E:DURABLE_CANCEL_START]",
  "[E2E:DURABLE_CANCEL_STATUS]",
  "[E2E:CHILD_DURABLE_CANCEL_PROCESS]",
  "[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS]",
  "[E2E:CHILD_WORKFLOW_OK]",
  "[E2E:CHILD_WORKFLOW_ERROR]",
  "[E2E:CHILD_INTERACTIVE]",
  "[E2E:CHILD_INTERACTIVE_FOLLOWUP]",
  "[E2E:CHILD_PROVIDER_ERROR]",
  "[E2E:CHILD_CANCEL]",
]);

const GATES = new Map<string, string>([
  ["[E2E:CHILD_SYNC_CONTEXT]", "release-sync-context"],
  ["[E2E:CHILD_SYNC_ISOLATED]", "release-sync-isolated"],
  ["[E2E:CHILD_ASYNC_ISOLATED]", "release-async-isolated"],
  ["[E2E:CHILD_WORKFLOW_PROCESS]", "release-workflow-process"],
  ["[E2E:CHILD_DURABLE_CANCEL_PROCESS]", "release-durable-cancel-process"],
  ["[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS]", "release-durable-cancel-in-process"],
  ["[E2E:CHILD_DURABLE_CANCEL_PROCESS]", "release-durable-cancel-process"],
  ["[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS]", "release-durable-cancel-in-process"],
  ["[E2E:CHILD_WORKFLOW]", "release-workflow"],
  ["[E2E:CHILD_WORKFLOW_OK]", "release-workflow"],
  ["[E2E:CHILD_INTERACTIVE_FOLLOWUP]", "release-interactive-followup"],
  ["[E2E:CHILD_INTERACTIVE]", "release-interactive"],
  ["[E2E:CHILD_CANCEL]", "release-cancel"],
]);

function gateFor(marker: string): string | undefined {
  return GATES.get(marker);
}

/**
 * The gate a child marker waits on. Tests must release gates through this rather
 * than hardcoding the name: a rename would otherwise surface as a silent 30s
 * timeout instead of an error naming the marker.
 */
export function gateForMarker(marker: string): string {
  const gate = GATES.get(marker);
  if (!gate)
    throw new Error(`no scripted terminal E2E gate is defined for ${marker}`);
  return gate;
}

/** `ARTIFACT_DIR` is injected by the interactive sub-agent runner. Falling back
 *  to the CWD would silently write the fixture artifact somewhere the test never
 *  looks, so demand it instead. */
function artifactDir(): string {
  const directory = process.env.ARTIFACT_DIR;
  if (!directory)
    throw new Error(
      "mock provider requires ARTIFACT_DIR for the interactive fixture",
    );
  return directory;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

class AbortError extends Error {
  constructor() {
    super("The scripted provider request was aborted");
    this.name = "AbortError";
  }
}

export async function waitForGate(
  gateName: string,
  signal?: AbortSignal,
  timeoutMs = GATE_TIMEOUT_MS,
): Promise<void> {
  const directory = process.env.SUBAGENTURA_E2E_GATE_DIR;
  if (signal?.aborted) throw new AbortError();
  if (!directory) return;
  const path = join(directory, gateName);
  const started = Date.now();
  if (existsSync(path)) {
    if (signal?.aborted) throw new AbortError();
    return;
  }
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new AbortError();
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (signal?.aborted) throw new AbortError();
    if (existsSync(path)) return;
  }
  throw new Error(`timed out waiting for scripted provider gate ${gateName}`);
}

function emit(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  events: AssistantMessageEvent[],
  final: AssistantMessage,
): void {
  for (const event of events) stream.push(event);
  stream.push({
    type: "done",
    reason: final.stopReason === "toolUse" ? "toolUse" : "stop",
    message: final,
  });
  stream.end(final);
}

function textEvents(final: AssistantMessage): AssistantMessageEvent[] {
  const text = final.content.find((item) => item.type === "text")?.text ?? "";
  const split = Math.max(1, Math.ceil(text.length / 2));
  const first = text.slice(0, split);
  const second = text.slice(split);
  const started = { ...final, content: [] };
  const empty = { ...final, content: [{ type: "text" as const, text: "" }] };
  const firstPartial = {
    ...final,
    content: [{ type: "text" as const, text: first }],
  };
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: started },
    { type: "text_start", contentIndex: 0, partial: empty },
    {
      type: "text_delta",
      contentIndex: 0,
      delta: first,
      partial: firstPartial,
    },
  ];
  if (second) {
    events.push({
      type: "text_delta",
      contentIndex: 0,
      delta: second,
      partial: final,
    });
  }
  events.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: final,
  });
  return events;
}

function toolEvents(final: AssistantMessage): AssistantMessageEvent[] {
  const call = final.content.find(
    (item) => item.type === "toolCall",
  ) as ToolCall;
  const json = JSON.stringify(call.arguments);
  const partial = { ...final, content: [{ ...call, arguments: {} }] };
  return [
    { type: "start", partial: { ...final, content: [] } },
    { type: "toolcall_start", contentIndex: 0, partial },
    {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: json.slice(0, Math.ceil(json.length / 2)),
      partial,
    },
    {
      type: "toolcall_delta",
      contentIndex: 0,
      delta: json.slice(Math.ceil(json.length / 2)),
      partial: final,
    },
    { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: final },
  ];
}

export function streamTextForTest(text: string, signal?: AbortSignal) {
  const stream = createAssistantMessageEventStream();
  const final = message([{ type: "text", text }]);
  if (signal?.aborted) {
    const error = message([], "aborted", "aborted");
    stream.push({ type: "start", partial: { ...error, content: [] } });
    stream.push({ type: "error", reason: "aborted", error });
    stream.end(error);
    return stream;
  }
  emit(stream, textEvents(final), final);
  return stream;
}

export function streamThinkingForTest(text: string) {
  const stream = createAssistantMessageEventStream();
  const thinking = "stable reasoning";
  const thinkingSplit = 7;
  const textSplit = Math.max(1, Math.ceil(text.length / 2));
  const final = message([
    { type: "thinking", thinking },
    { type: "text", text },
  ]);
  const thinkingEmpty = message([{ type: "thinking", thinking: "" }]);
  const thinkingFirst = message([
    { type: "thinking", thinking: thinking.slice(0, thinkingSplit) },
  ]);
  const thinkingComplete = message([{ type: "thinking", thinking }]);
  const textEmpty = message([
    { type: "thinking", thinking },
    { type: "text", text: "" },
  ]);
  const textFirst = message([
    { type: "thinking", thinking },
    { type: "text", text: text.slice(0, textSplit) },
  ]);
  stream.push({ type: "start", partial: { ...final, content: [] } });
  stream.push({
    type: "thinking_start",
    contentIndex: 0,
    partial: thinkingEmpty,
  });
  stream.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: thinking.slice(0, thinkingSplit),
    partial: thinkingFirst,
  });
  stream.push({
    type: "thinking_delta",
    contentIndex: 0,
    delta: thinking.slice(thinkingSplit),
    partial: thinkingComplete,
  });
  stream.push({
    type: "thinking_end",
    contentIndex: 0,
    content: thinking,
    partial: thinkingComplete,
  });
  stream.push({ type: "text_start", contentIndex: 1, partial: textEmpty });
  stream.push({
    type: "text_delta",
    contentIndex: 1,
    delta: text.slice(0, textSplit),
    partial: textFirst,
  });
  stream.push({
    type: "text_delta",
    contentIndex: 1,
    delta: text.slice(textSplit),
    partial: final,
  });
  stream.push({
    type: "text_end",
    contentIndex: 1,
    content: text,
    partial: final,
  });
  stream.push({ type: "done", reason: "stop", message: final });
  stream.end(final);
  return stream;
}

async function runRequest(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<any>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  const toolResultId = latestToolResult(context);
  const explicitMarker = newestMarker(context);
  const continuationMarker = toolResultId
    ? [...states.entries()].find(
        ([, value]) => value.toolCallId === toolResultId,
      )?.[0]
    : undefined;
  const followupMarker =
    !toolResultId && !explicitMarker
      ? [...states.entries()]
          .reverse()
          .find(
            ([key, value]) =>
              !key.includes("CHILD_") && value.stage === "complete",
          )?.[0]
      : undefined;
  const marker = continuationMarker ?? explicitMarker ?? followupMarker;
  const previous = marker ? states.get(marker) : undefined;
  const requestSeq = (previous?.requestSeq ?? 0) + 1;
  if (!marker) throw new Error("mock provider could not find an E2E marker");
  if (!KNOWN_MARKERS.has(marker)) {
    throw new Error(`mock provider rejected unknown E2E marker ${marker}`);
  }
  if (
    model.provider !== E2E_PROVIDER ||
    model.id !== E2E_MODEL ||
    model.api !== E2E_API
  ) {
    throw new Error("mock provider received a provider/model/API mismatch");
  }
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages);
  diagnostic({
    marker,
    requestSeq,
    beforeStage: previous?.stage ?? "initial",
    route: "scripted",
    toolCallId: toolResultId,
    toolCallName: previous?.toolName,
    contextMarkers: [...new Set(markers(context.messages))],
    contextMessageCount: context.messages.length,
    contextRoles: context.messages.map((entry) => entry.role),
    contextHasParentSentinel: JSON.stringify([
      context.messages,
      systemPrompt,
    ]).includes("PARENT_CONTEXT_SENTINEL"),
    contextToolNames: tools.map((tool) => tool.name),
    contextWorkingDirectory: process.cwd(),
    childArtifactDir: process.env.ARTIFACT_DIR,
    contextToolResults: observedToolResults(context),
  });
  const isChild = marker.includes("CHILD_");
  let state: State = previous ?? { stage: "initial", requestSeq: 0 };
  if (state.stage === "complete" && marker !== followupMarker) {
    throw new Error(`duplicate request for completed marker ${marker}`);
  }
  if (
    marker === "[E2E:ERROR]" ||
    marker === "[E2E:CHILD_WORKFLOW_ERROR]" ||
    marker === "[E2E:CHILD_PROVIDER_ERROR]"
  ) {
    const error = message([], "error", "scripted provider error");
    state = { stage: "failed", requestSeq };
    states.set(marker, state);
    stream.push({ type: "start", partial: { ...error, content: [] } });
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
    diagnostic({
      marker,
      requestSeq,
      afterStage: state.stage,
      route: "error",
      eventType: "error",
    });
    return;
  }

  if (isChild) {
    const isInteractive = marker.includes("CHILD_INTERACTIVE");
    const interactiveTurn = marker.includes("FOLLOWUP") ? "2" : "1";
    if (marker === "[E2E:CHILD_WORKFLOW_MCP_CONTROL_PROCESS]") {
      processMcpControlRequest(marker, requestSeq, state, context, stream);
      return;
    }
    if (marker.includes("CHILD_WORKFLOW_READONLY")) {
      readOnlyWorkflowRequest(marker, requestSeq, state, context, stream);
      return;
    }
    if (isInteractive && state.stage === "initial") {
      const call = toolCall(
        `e2e-interactive-write-${interactiveTurn}`,
        "write",
        {
          path: join(artifactDir(), "output.md"),
          content:
            `interactive child artifact turn ${interactiveTurn} ` +
            `[E2E:INTERACTIVE_OUTPUT_${interactiveTurn}]\n`,
        },
      );
      const final = message([call], "toolUse");
      states.set(marker, {
        stage: "toolIssued",
        requestSeq,
        toolCallId: call.id,
      });
      emit(stream, toolEvents(final), final);
      return;
    }
    if (
      isInteractive &&
      state.stage === "toolIssued" &&
      toolResultId === state.toolCallId &&
      state.toolCallId?.includes("write")
    ) {
      const call = toolCall(`e2e-interactive-done-${interactiveTurn}`, "bash", {
        command: `node ${shellQuote(join(artifactDir(), "cli.mjs"))} done 0`,
      });
      const final = message([call], "toolUse");
      states.set(marker, {
        stage: "toolIssued",
        requestSeq,
        toolCallId: call.id,
        toolName: call.name,
      });
      emit(stream, toolEvents(final), final);
      return;
    }
    const gate = gateFor(marker);
    if (gate) {
      states.set(marker, {
        stage: "gated",
        requestSeq,
        toolCallId: state.toolCallId,
      });
      diagnostic({
        marker,
        requestSeq,
        afterStage: "gated",
        gate,
        eventType: "gate_wait",
      });
      try {
        await waitForGate(gate, options?.signal);
        if (options?.signal?.aborted) throw new AbortError();
      } catch (error) {
        const reason = error instanceof AbortError ? "aborted" : "error";
        const final = message([], reason, reason);
        states.set(marker, { stage: "failed", requestSeq });
        stream.push({ type: "start", partial: { ...final, content: [] } });
        stream.push({ type: "error", reason, error: final });
        stream.end(final);
        diagnostic({
          marker,
          requestSeq,
          afterStage: "failed",
          gate,
          abort: reason === "aborted",
          eventType: "error",
        });
        return;
      }
    }
    const final = message([
      {
        type: "text",
        text: marker.includes("INTERACTIVE")
          ? "Interactive child complete."
          : `Child result for ${marker}.`,
      },
    ]);
    states.set(marker, { stage: "complete", requestSeq });
    emit(stream, textEvents(final), final);
    diagnostic({
      marker,
      requestSeq,
      afterStage: "complete",
      eventType: "done",
    });
    return;
  }

  if (
    marker.includes("INTERACTIVE") &&
    !marker.includes("CHILD_") &&
    state.stage === "complete"
  ) {
    const final = message([
      {
        type: "text",
        text: `Interactive completion reference received for ${marker}.`,
      },
    ]);
    states.set(marker, { stage: "complete", requestSeq });
    emit(stream, textEvents(final), final);
    diagnostic({
      marker,
      requestSeq,
      afterStage: "complete",
      route: "trigger-followup",
      eventType: "done",
    });
    return;
  }

  if (marker.includes("WORKFLOW_ASYNC") && state.stage === "complete") {
    const final = message([
      { type: "text", text: `Workflow follow-up settled for ${marker}.` },
    ]);
    states.set(marker, { stage: "complete", requestSeq });
    emit(stream, textEvents(final), final);
    diagnostic({
      marker,
      requestSeq,
      afterStage: "complete",
      route: "trigger-followup",
      eventType: "done",
    });
    return;
  }
  if (state.stage === "complete" && marker === followupMarker) {
    const final = message([
      {
        type: "text",
        text: `Async completion reference received for ${marker}.`,
      },
    ]);
    states.set(marker, { stage: "complete", requestSeq });
    emit(stream, textEvents(final), final);
    diagnostic({
      marker,
      requestSeq,
      afterStage: "complete",
      route: "trigger-followup",
      eventType: "done",
    });
    return;
  }
  if (state.stage === "initial") {
    const call = parentTool(marker, context);
    const final = message([call], "toolUse");
    states.set(marker, {
      stage: "toolIssued",
      requestSeq,
      toolCallId: call.id,
    });
    emit(stream, toolEvents(final), final);
    return;
  }
  if (!toolResultId || toolResultId !== state.toolCallId) {
    throw new Error(
      `invalid transition for ${marker}: expected tool result ${state.toolCallId ?? "none"}`,
    );
  }
  const final = message([
    { type: "text", text: `Parent settled for ${marker}.` },
  ]);
  states.set(marker, { stage: "complete", requestSeq });
  emit(stream, textEvents(final), final);
  diagnostic({ marker, requestSeq, afterStage: "complete", eventType: "done" });
}

function parentTool(marker: string, context: TranscriptContext): ToolCall {
  if (marker === "[E2E:WORKFLOW_LIST_RUNS]") {
    return toolCall("e2e-workflow-list-runs", "list_workflow_runs", {});
  }
  if (marker === "[E2E:DURABLE_CANCEL_SYNC]") {
    return toolCall("e2e-durable-cancel-sync", "workflow", {
      script: `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "e2e-durable-cancel-sync",
        version: 1,
        run: async function(ctx) {
          return await Promise.all([
            ctx.agent("process-child", {
              prompt: "[E2E:CHILD_DURABLE_CANCEL_PROCESS] Wait for durable cancellation.",
              isolation: "process"
            }),
            ctx.agent("in-process-child", {
              prompt: "[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS] Wait for durable cancellation.",
              isolation: "in-process"
            })
          ]);
        }
      });`,
      async: false,
      durable: true,
    });
  }
  if (marker === "[E2E:DURABLE_CANCEL_START]") {
    return toolCall("e2e-durable-cancel-start", "workflow", {
      script: `import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "e2e-durable-cancel",
        version: 1,
        run: async function(ctx) {
          return await Promise.all([
            ctx.agent("process-child", {
              prompt: "[E2E:CHILD_DURABLE_CANCEL_PROCESS] Wait for durable cancellation.",
              isolation: "process"
            }),
            ctx.agent("in-process-child", {
              prompt: "[E2E:CHILD_DURABLE_CANCEL_IN_PROCESS] Wait for durable cancellation.",
              isolation: "in-process"
            })
          ]);
        }
      });`,
      async: true,
      durable: true,
    });
  }
  if (marker === "[E2E:DURABLE_CANCEL_STATUS]") {
    return toolCall("e2e-durable-cancel-status", "get_workflow_status", {
      workflowId: resultId(context, "workflow", /wfd_[a-f0-9]{32}/),
    });
  }
  if (marker === "[E2E:TOOL_PARAMETERS]") {
    return toolCall("e2e-tool-parameters-1", "list_available_models", {
      filter: "subagentura-e2e",
      authOnly: false,
    });
  }
  if (marker.includes("ASYNC_STATUS")) {
    return toolCall("e2e-async-status-1", "get_subagent_status", {
      jobId: resultId(context, "subagent_isolated", /\b[a-f0-9]{16}\b/),
    });
  }
  if (marker.includes("ASYNC_RESULT")) {
    return toolCall("e2e-async-result-1", "get_subagent_result", {
      jobId: resultId(context, "subagent_isolated", /\b[a-f0-9]{16}\b/),
    });
  }
  if (marker.includes("WORKFLOW_STATUS")) {
    return toolCall("e2e-workflow-status-1", "get_workflow_status", {
      workflowId: resultId(context, "workflow", /\bwf_[a-f0-9]{10}\b/),
    });
  }
  if (marker.includes("WORKFLOW_RESULT")) {
    return toolCall("e2e-workflow-result-1", "get_workflow_result", {
      workflowId: resultId(context, "workflow", /\bwf_[a-f0-9]{10}\b/),
    });
  }
  if (marker.includes("INTERACTIVE_FOLLOWUP_PARENT")) {
    return toolCall(
      "e2e-interactive-followup-parent-1",
      "send_interactive_subagent_message",
      {
        id: interactiveResultId(context),
        message:
          "[E2E:CHILD_INTERACTIVE_FOLLOWUP] Complete the follow-up fixture.",
      },
    );
  }
  if (marker.includes("INTERACTIVE_CANCEL_PARENT")) {
    return toolCall(
      "e2e-interactive-cancel-parent-1",
      "cancel_interactive_subagent",
      {
        jobId: interactiveResultId(context),
      },
    );
  }
  if (marker.includes("WORKFLOW_READONLY")) {
    const processMode = marker === "[E2E:WORKFLOW_READONLY_PROCESS]";
    const childMarker = processMode
      ? "[E2E:CHILD_WORKFLOW_READONLY_PROCESS]"
      : "[E2E:CHILD_WORKFLOW_READONLY_IN_PROCESS]";
    const controlStep = processMode
      ? `await ctx.agent("mcp-control", {
           prompt: "[E2E:CHILD_WORKFLOW_MCP_CONTROL_PROCESS] Use the fake mutator."
         });`
      : "";
    const isolation = processMode ? "" : 'isolation: "in-process",';
    return toolCall("e2e-readonly-workflow", "workflow", {
      script: `import { defineWorkflow, schema } from "pi-subagentura/workflow";
     export default defineWorkflow({
       name: "e2e-readonly-${processMode ? "process" : "in-process"}",
       version: 1,
       output: schema.object({ source: schema.string() }),
       run: async function(ctx) {
         ${controlStep}
         return await ctx.agent("inspect-source", {
           prompt: "${childMarker} Read readonly-source.ts and report its source.",
           ${isolation}
           readOnly: true,
           output: schema.object({ source: schema.string() })
         });
       }
     });`,
      async: false,
      ...(processMode ? { durable: true } : {}),
    });
  }
  if (marker.includes("WORKFLOW_PARTIAL")) {
    return toolCall("e2e-workflow-partial-1", "workflow", {
      script: `export const meta = { name: "e2e-partial", description: "partial failure fixture", phases: [{ title: "phase" }] }; phase("phase"); return await parallel([() => agent("[E2E:CHILD_WORKFLOW_OK] Return success.", { label: "ok", model: "subagentura-e2e/mock", isolation: "in-process" }), () => agent("[E2E:CHILD_WORKFLOW_ERROR] Fail deterministically.", { label: "error", model: "subagentura-e2e/mock", isolation: "in-process" })]);`,
      async: false,
    });
  }
  if (marker.includes("WORKFLOW")) {
    const childMarker = marker.includes("PROCESS")
      ? "[E2E:CHILD_WORKFLOW_PROCESS]"
      : "[E2E:CHILD_WORKFLOW]";
    return toolCall("e2e-workflow-1", "workflow", {
      script: `export const meta = { name: "e2e-workflow", description: "terminal fixture", phases: [{ title: "phase" }] }; phase("phase"); return await agent("${childMarker} Return the workflow fixture.", { label: "e2e-worker", model: "subagentura-e2e/mock", isolation: "${marker.includes("PROCESS") ? "process" : "in-process"}" });`,
      async: marker.includes("ASYNC"),
    });
  }
  if (marker === "[E2E:INTERACTIVE_ERROR_PARENT]") {
    return toolCall("e2e-interactive-error-parent-1", "subagent_interactive", {
      name: "E2E failing interactive child",
      task: "[E2E:CHILD_PROVIDER_ERROR] Fail the provider fixture.",
      model: "subagentura-e2e/mock",
      background: true,
    });
  }
  if (marker.includes("INTERACTIVE")) {
    return toolCall("e2e-interactive-parent-1", "subagent_interactive", {
      name: "E2E interactive child",
      task: "[E2E:CHILD_INTERACTIVE] Complete the artifact fixture.",
      model: "subagentura-e2e/mock",
      background: true,
    });
  }
  const isolated = marker.includes("ISOLATED");
  return toolCall(
    `e2e-${isolated ? "isolated" : "context"}-1`,
    isolated ? "subagent_isolated" : "subagent_with_context",
    {
      task: `[E2E:CHILD_${marker.replace("[E2E:", "").replace("]", "")}] Return the deterministic fixture.`,
      model: "subagentura-e2e/mock",
      async: marker.includes("ASYNC"),
    },
  );
}

export function resetMockProviderState(): void {
  states.clear();
}

export function getMockProviderState(): Map<string, State> {
  return new Map(states);
}

export function createMockProviderConfig() {
  return {
    name: "Subagentura E2E scripted provider",
    api: E2E_API,
    apiKey: "$SUBAGENTURA_E2E_API_KEY",
    baseUrl: "https://subagentura-e2e.invalid",
    models: [
      {
        id: E2E_MODEL,
        name: "E2E Mock",
        api: E2E_API,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
    streamSimple(
      model: Model<any>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) {
      const stream = createAssistantMessageEventStream();
      void runRequest(stream, model, context, options).catch((error) => {
        const messageText =
          error instanceof Error ? error.message : String(error);
        const final = message(
          [],
          options?.signal?.aborted ? "aborted" : "error",
          messageText,
        );
        stream.push({ type: "start", partial: { ...final, content: [] } });
        stream.push({
          type: "error",
          reason: final.stopReason === "aborted" ? "aborted" : "error",
          error: final,
        });
        stream.end(final);
        diagnostic({
          route: "exception",
          eventType: "error",
          error: messageText,
        });
      });
      return stream;
    },
  };
}

export default function registerMockProvider(pi: ExtensionAPI): void {
  pi.registerProvider(E2E_PROVIDER, createMockProviderConfig() as any);
  if (process.env.SUBAGENTURA_E2E_READONLY_MCP_TOOL === "1") {
    pi.registerTool({
      name: "mcp__e2e__mutate",
      label: "E2E MCP mutation probe",
      description: "Writes the requested test fixture file.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
      async execute(_toolCallId, params) {
        writeFileSync(params.path, params.content);
        return {
          content: [{ type: "text", text: "E2E fixture file written." }],
          details: { path: params.path },
        };
      },
    });
  }
  pi.on("session_start", (_event, ctx) => {
    const ui = ctx.ui as typeof ctx.ui & {
      setWorkingIndicator?: (value?: unknown) => void;
      setWorkingMessage?: (value?: string) => void;
    };
    ui.setWorkingIndicator?.({ frames: ["●"] });
    ui.setWorkingMessage?.("e2e working");
  });
}
