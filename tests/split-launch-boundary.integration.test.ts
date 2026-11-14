import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiSessionHarness,
  type PiSessionHarness,
  withIsolatedPiRuntime,
} from "./helpers/pi-session-harness";
import { clearSessionScopes, getSessionScopes } from "../src/session-scope";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const disposedHarnesses: PiSessionHarness[] = [];

async function withHarness<T>(
  extensionFlags: Record<string, boolean | string>,
  run: (
    harness: PiSessionHarness,
    provider: ControlledProvider,
    previousScopeIds: ReadonlySet<number>,
  ) => Promise<T>,
): Promise<T> {
  return withIsolatedPiRuntime(async ({ cwd }) => {
    const previousScopeIds = new Set(getSessionScopes().map(({ id }) => id));
    const harness = await createPiSessionHarness(cwd, {
      extensionFlags,
      extensionRoot: repoRoot,
    });
    disposedHarnesses.push(harness);
    const provider = installControlledProvider(harness);
    return run(harness, provider, previousScopeIds);
  });
}

afterEach(() => {
  for (const harness of disposedHarnesses.splice(0)) harness.dispose();
  clearSessionScopes();
});

interface ControlledProvider {
  dispatchedContexts: TranscriptContext[];
}

function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function completedStream(
  model: Model<Api>,
  text: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, text);
  const textStarted = {
    ...message,
    content: [{ type: "text" as const, text: "" }],
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "text_start", contentIndex: 0, partial: textStarted });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: message,
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: message,
  });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

function abortedStream(model: Model<Api>): AssistantMessageEventStream {
  const message: AssistantMessage = {
    ...assistantMessage(model, ""),
    content: [],
    stopReason: "aborted",
    errorMessage: "Request was aborted",
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "aborted", error: message });
  stream.end(message);
  return stream;
}

function installControlledProvider(
  harness: PiSessionHarness,
): ControlledProvider {
  const model = harness.session.model;
  if (!model) throw new Error("test session has no selected model");
  const provider: ControlledProvider = {
    dispatchedContexts: [],
  };
  harness.session.modelRuntime.registerProvider(model.provider, {
    api: model.api,
    streamSimple: (requestModel, context, options) => {
      if (options?.signal?.aborted) return abortedStream(requestModel);
      provider.dispatchedContexts.push(context);
      return completedStream(requestModel, "isolated provider response");
    },
  });
  return provider;
}

type RequestKind = "user prompt" | "custom message";
type RequestOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown };

function startRequest(harness: PiSessionHarness, kind: RequestKind) {
  if (kind === "user prompt") {
    return harness.session.prompt("Exercise the split launch boundary.");
  }
  return harness.session.sendCustomMessage(
    {
      customType: "split-launch-regression",
      content: "Exercise the split launch boundary.",
      display: true,
    },
    { triggerTurn: true },
  );
}

async function runRequest(
  harness: PiSessionHarness,
  provider: ControlledProvider,
  kind: RequestKind,
  extensionErrors: string[],
) {
  const settledEvents: boolean[] = [];
  const unsubscribe = harness.session.subscribe((event) => {
    if (event.type === "agent_settled") settledEvents.push(event.aborted);
  });
  let outcome: RequestOutcome | undefined;
  const request = startRequest(harness, kind).then(
    () => {
      outcome = { status: "fulfilled" };
    },
    (error: unknown) => {
      outcome = { status: "rejected", error };
    },
  );

  try {
    await request;
    await harness.session.waitForIdle();

    return {
      context: provider.dispatchedContexts[0],
      outcome: outcome!,
      aborted: settledEvents.at(-1) === true,
      validationReported: extensionErrors.some((message) =>
        message.includes("--split"),
      ),
    };
  } finally {
    unsubscribe();
  }
}
const noOrchestration = {
  orchestrator: false,
  orchestratorv2: false,
  split: false,
};

describe("split configuration at the Pi launch boundary", () => {
  it.each([
    {
      name: "ordinary sessions",
      flags: noOrchestration,
      expected: "ordinary",
    },
    {
      name: "Orchestratorv2 sessions",
      flags: { ...noOrchestration, orchestratorv2: true },
      expected: "v2",
    },
    {
      name: "Orchestratorv2 split sessions",
      flags: { ...noOrchestration, orchestratorv2: true, split: true },
      expected: "v2-split",
    },
    {
      name: "legacy orchestration without split",
      flags: { ...noOrchestration, orchestrator: true },
      expected: "legacy",
    },
  ] as const)(
    "preserves execution and prompts for $name",
    async ({ flags, expected }) => {
      await withHarness(flags, async (harness, provider) => {
        const extensionErrors: string[] = [];
        const unsubscribe = harness.session.extensionRunner.onError((error) => {
          extensionErrors.push(error.error);
        });
        try {
          const run = await runRequest(
            harness,
            provider,
            "user prompt",
            extensionErrors,
          );
          expect(provider.dispatchedContexts).toHaveLength(1);
          expect(run.outcome.status).toBe("fulfilled");
          expect(run.aborted).toBe(false);
          expect(
            extensionErrors.some((message) => message.includes("--split")),
          ).toBe(false);

          const prompt = getCurrentSystemPrompt(run.context!.messages);
          if (expected === "ordinary") {
            expect(prompt).not.toContain("# Orchestrator System Prompt");
            expect(prompt).not.toContain(
              "# Orchestratorv2 Thin Router System Prompt",
            );
            expect(prompt).not.toContain("# Orchestratorv2 Split Policy");
          } else if (expected === "v2") {
            expect(prompt).toContain(
              "# Orchestratorv2 Thin Router System Prompt",
            );
            expect(prompt).not.toContain("# Orchestratorv2 Split Policy");
          } else if (expected === "v2-split") {
            expect(prompt).toContain(
              "# Orchestratorv2 Thin Router System Prompt",
            );
            expect(prompt).toContain("# Orchestratorv2 Split Policy");
          } else {
            expect(prompt).toContain("# Orchestrator System Prompt");
            expect(prompt).not.toContain(
              "# Orchestratorv2 Thin Router System Prompt",
            );
            expect(prompt).not.toContain("# Orchestratorv2 Split Policy");
          }
        } finally {
          unsubscribe();
        }
      });
    },
  );

  it("does not partially start a session for invalid split flags", async () => {
    await withHarness(
      { ...noOrchestration, split: true },
      async (harness, _provider, previousScopeIds) => {
        const startupErrors: string[] = [];
        await harness.session.bindExtensions({
          onError: (error) => startupErrors.push(error.error),
        });
        expect(
          startupErrors.some((message) => message.includes("--split")),
        ).toBe(true);

        const scope = getSessionScopes().find(
          ({ id }) => !previousScopeIds.has(id),
        );
        expect(scope).toBeDefined();
        expect(scope?.workflowAdmissionClosed).toBe(true);
        expect(scope?.lifecycle).toBe("registered");
        expect(scope?.generation).toBe(0);
        expect(scope?.cwd).toBeUndefined();
        expect(scope?.sessionManager).toBeUndefined();
        expect(scope?.telemetry).toBeUndefined();
      },
    );
  });

  it.each([
    {
      name: "split without Orchestratorv2",
      flags: { ...noOrchestration, split: true },
      kind: "user prompt" as const,
    },
    {
      name: "split with legacy orchestration",
      flags: {
        ...noOrchestration,
        orchestrator: true,
        orchestratorv2: true,
        split: true,
      },
      kind: "user prompt" as const,
    },
    {
      name: "split without Orchestratorv2 during a custom-message turn",
      flags: { ...noOrchestration, split: true },
      kind: "custom message" as const,
    },
    {
      name: "split with legacy orchestration during a custom-message turn",
      flags: {
        ...noOrchestration,
        orchestrator: true,
        orchestratorv2: true,
        split: true,
      },
      kind: "custom message" as const,
    },
  ])("rejects $name before provider execution", async ({ flags, kind }) => {
    await withHarness(flags, async (harness, provider) => {
      const extensionErrors: string[] = [];
      const unsubscribe = harness.session.extensionRunner.onError((error) => {
        extensionErrors.push(error.error);
      });
      try {
        const run = await runRequest(harness, provider, kind, extensionErrors);
        expect(provider.dispatchedContexts).toHaveLength(0);
        expect(
          run.validationReported &&
            (run.outcome.status === "rejected" || run.aborted),
        ).toBe(true);
      } finally {
        unsubscribe();
      }
    });
  });
});
