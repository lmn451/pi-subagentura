import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionOptions,
  createCompatibleSessionRuntime,
  findModel,
  registerProvider,
} from "../../src/pi-sdk-compat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "subagentura-faux",
    provider: "subagentura-faux",
    model: "faux-model",
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

export interface PiSessionHarness {
  session: AgentSession;
  sessionManager: SessionManager;
  contexts: Context[];
  completeNext(text?: string): void;
  failNext(errorMessage?: string): void;
  reload(): Promise<void>;
  dispose(): void;
}

export async function createPiSessionHarness(
  cwd: string,
  options: {
    childArtifactDir?: string;
    bindExtensionLifecycle?: boolean;
    extensionFlags?: Record<string, boolean | string>;
    extensionRoot?: string;
    includeTools?: boolean;
    sessionManager?: SessionManager;
    retrySettings?: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
    };
  } = {},
): Promise<PiSessionHarness> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagentura-session-"));
  const sessionRuntime = await createCompatibleSessionRuntime({
    agentDir,
    authStorageData: {
      "subagentura-faux": { type: "api_key", key: "test" },
    },
  });
  const contexts: Context[] = [];
  const pending: Array<ReturnType<typeof createAssistantMessageEventStream>> =
    [];
  const fauxProvider = {
    api: "subagentura-faux",
    apiKey: "test",
    baseUrl: "http://127.0.0.1.invalid",
    models: [
      {
        id: "faux-model",
        name: "Faux Model",
        api: "subagentura-faux",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 200_000,
        maxTokens: 4_096,
      },
    ],
    streamSimple: (_model: unknown, context: Context) => {
      contexts.push(context);
      const stream = createAssistantMessageEventStream();
      pending.push(stream);
      return stream;
    },
  };
  const registerFauxProvider = () =>
    registerProvider(sessionRuntime, "subagentura-faux", fauxProvider);
  registerFauxProvider();
  const model = findModel(sessionRuntime, "subagentura-faux", "faux-model");
  if (!model) throw new Error("faux model registration failed");
  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  if (options.retrySettings) {
    settingsManager.getRetrySettings = () => options.retrySettings!;
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      join(options.extensionRoot ?? cwd, "src/subagent.ts"),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const previousChild = process.env.PI_SUBAGENTURA_CHILD;
  const previousArtifactDir = process.env.ARTIFACT_DIR;
  if (options.childArtifactDir) {
    process.env.PI_SUBAGENTURA_CHILD = "1";
    process.env.ARTIFACT_DIR = options.childArtifactDir;
  }
  try {
    await resourceLoader.reload();
    for (const [name, value] of Object.entries(options.extensionFlags ?? {})) {
      resourceLoader.getExtensions().runtime.flagValues.set(name, value);
    }
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENTURA_CHILD;
    else process.env.PI_SUBAGENTURA_CHILD = previousChild;
    if (previousArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
    else process.env.ARTIFACT_DIR = previousArtifactDir;
  }
  const sessionOptions = buildSessionOptions(sessionRuntime, {
    cwd,
    agentDir,
    model,
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: options.includeTools ? undefined : "all",
  });
  const { session } = await createAgentSession(
    sessionOptions as unknown as Parameters<typeof createAgentSession>[0],
  );
  if (options.bindExtensionLifecycle) {
    await session.bindExtensions({ shutdownHandler: async () => {} });
  }
  return {
    session,
    sessionManager,
    contexts,
    completeNext(text = "ok") {
      const stream = pending.shift();
      if (!stream) throw new Error("no pending faux provider response");
      const message = assistant(text);
      const started = { ...message, content: [] };
      const textStarted = {
        ...message,
        content: [{ type: "text" as const, text: "" }],
      };
      stream.push({ type: "start", partial: started });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: textStarted,
      });
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
    },
    failNext(errorMessage = "rate limit, please retry your request") {
      const stream = pending.shift();
      if (!stream) throw new Error("no pending faux provider response");
      const message: AssistantMessage = {
        ...assistant(""),
        content: [],
        stopReason: "error",
        errorMessage,
      };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    },
    async reload() {
      await session.reload({
        beforeSessionStart: async () => {
          registerFauxProvider();
        },
      });
    },
    dispose() {
      session.dispose();
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
