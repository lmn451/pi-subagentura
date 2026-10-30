import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
  type Model,
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
  contexts: TranscriptContext[];
  thinkingLevels: Array<string | undefined>;
  completeNext(text?: string): void;
  configureTestAuth(): void;
  failNext(errorMessage?: string): void;
  reload(): Promise<void>;
  dispose(): void;
}

export async function withIsolatedPiRuntime<T>(
  run: (paths: { agentDir: string; cwd: string }) => Promise<T>,
): Promise<T> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagentura-agent-config-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagentura-agent-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "pi-subagentura-agent-home-"));
  mkdirSync(join(agentDir, "sessions"));
  mkdirSync(join(home, ".config"));
  const scopedNames = new Set([
    "PI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_SESSION_DIR",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_CONFIG_FILE",
    "CLOUDSDK_CONFIG",
    "AZURE_CONFIG_DIR",
  ]);
  for (const name of Object.keys(process.env)) {
    if (
      /(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_KEY|ACCESS_KEY_ID|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET|SECRET_ACCESS_KEY|SESSION_TOKEN|TOKEN|CREDENTIALS)$/i.test(
        name,
      ) ||
      name === "GOOGLE_APPLICATION_CREDENTIALS" ||
      name === "AWS_SHARED_CREDENTIALS_FILE"
    ) {
      scopedNames.add(name);
    }
  }
  const previous = new Map<string, string | undefined>();
  for (const name of scopedNames) {
    previous.set(name, process.env[name]);
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  for (const name of scopedNames) {
    if (
      name !== "PI_CODING_AGENT_DIR" &&
      name !== "PI_CODING_AGENT_SESSION_DIR" &&
      name !== "HOME" &&
      name !== "USERPROFILE" &&
      name !== "XDG_CONFIG_HOME"
    ) {
      delete process.env[name];
    }
  }

  try {
    return await run({ agentDir, cwd });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
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
    nativeModel?: Model<any>;
    nativeProvider?: unknown;
    onNativeSessionStart?: (ctx: any) => Promise<void> | void;
    retrySettings?: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
      maxAgentDelayMs: number;
    };
    providerErrorUrl?: string;
    missingAuth?: boolean;
  } = {},
): Promise<PiSessionHarness> {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagentura-session-"));
  const missingAuthEnvVar = `PI_SUBAGENTURA_TEST_MISSING_AUTH_${randomUUID().replaceAll("-", "")}`;
  const sessionRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  const contexts: TranscriptContext[] = [];
  const thinkingLevels: Array<string | undefined> = [];
  const pending: Array<ReturnType<typeof createAssistantMessageEventStream>> =
    [];
  const fauxProvider = {
    api: "subagentura-faux",
    apiKey: options.missingAuth ? `$${missingAuthEnvVar}` : "test",
    baseUrl: "http://127.0.0.1.invalid",
    models: [
      {
        id: "faux-model",
        name: "Faux Model",
        api: "subagentura-faux",
        reasoning: true,
        input: ["text" as const],
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
    streamSimple: (
      _model: unknown,
      context: TranscriptContext,
      requestOptions?: { reasoning?: string },
    ) => {
      contexts.push(context);
      thinkingLevels.push(requestOptions?.reasoning);
      const stream = createAssistantMessageEventStream();
      if (options.providerErrorUrl) {
        void fetch(options.providerErrorUrl).then(async (response) => {
          const errorMessage = `HTTP ${response.status}: ${await response.text()}`;
          const message: AssistantMessage = {
            ...assistant(""),
            content: [],
            stopReason: "error",
            errorMessage,
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        });
      } else {
        pending.push(stream);
      }
      return stream;
    },
  };
  const registerFauxProvider = () =>
    sessionRuntime.registerProvider("subagentura-faux", fauxProvider);
  registerFauxProvider();
  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  if (options.retrySettings) {
    settingsManager.getRetrySettings = () => ({
      ...options.retrySettings!,
      maxAgentDelayMs: 0,
    });
  }
  const extensionFactories = options.nativeProvider
    ? [
        {
          name: "test-native-provider",
          factory: (pi: any) => {
            pi.registerProvider(options.nativeProvider);
            const onNativeSessionStart = options.onNativeSessionStart;
            if (onNativeSessionStart) {
              pi.on("session_start", (_event: any, ctx: any) =>
                onNativeSessionStart(ctx),
              );
            }
          },
        },
      ]
    : [];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      join(options.extensionRoot ?? cwd, "src/subagent.ts"),
    ],
    extensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  } as any);
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
  const model =
    options.nativeModel ??
    sessionRuntime.getModel("subagentura-faux", "faux-model");
  if (!model) throw new Error("test model registration failed");
  const sessionOptions: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    model,
    modelRuntime: sessionRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: options.includeTools ? undefined : "all",
  };
  const { session } = await createAgentSession(sessionOptions);
  if (options.bindExtensionLifecycle) {
    await session.bindExtensions({ shutdownHandler: async () => {} });
  }
  return {
    session,
    sessionManager,
    contexts,
    thinkingLevels,
    configureTestAuth() {
      sessionRuntime.registerProvider("subagentura-faux", {
        ...fauxProvider,
        apiKey: "test",
      });
    },
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
