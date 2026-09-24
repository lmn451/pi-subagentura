import { join } from "node:path";
import * as CodingAgent from "@earendil-works/pi-coding-agent";
import * as PiAi from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

type AuthStorageFactory = {
  create(): unknown;
  inMemory?(data: Record<string, { type: "api_key"; key: string }>): unknown;
};

type ModelRegistryFactory = {
  create?(authStorage: unknown): ModelRegistry;
};
type ProviderConfig = Parameters<ModelRegistry["registerProvider"]>[1];
type ModelRuntime = {
  getModel(provider: string, modelId: string): Model<any> | undefined;
  registerProvider(provider: string, config: unknown): void;
  registerNativeProvider?(provider: unknown): void;
};

type ModelRuntimeFactory = {
  create(options?: {
    authPath?: string;
    modelsPath?: string | null;
  }): Promise<ModelRuntime>;
};

type CodingAgentCompat = typeof CodingAgent & {
  AuthStorage?: AuthStorageFactory;
  ModelRegistry: typeof CodingAgent.ModelRegistry & ModelRegistryFactory;
  ModelRuntime?: ModelRuntimeFactory;
};

const codingAgent = CodingAgent as CodingAgentCompat;

export type CompatibleSessionRuntime =
  | {
      kind: "modern";
      modelRuntime: ModelRuntime;
    }
  | {
      kind: "legacy";
      authStorage: unknown;
      modelRegistry: ModelRegistry;
    };

export interface CompatibleProviderTool {
  name: string;
}

export interface CompatibleProviderContext {
  messages: readonly unknown[];
  systemPrompt?: unknown;
  tools?: readonly CompatibleProviderTool[];
}

export interface NormalizedProviderContext {
  systemPrompt: string;
  tools: readonly CompatibleProviderTool[];
}

type ContextSystemMessage = {
  role: string;
  content?: unknown;
  toolsAdded?: readonly CompatibleProviderTool[];
};

type PiAiContextCompat = {
  getCurrentSystemPrompt?: (messages: readonly unknown[]) => string;
  getCurrentTools?: (
    messages: readonly unknown[],
  ) => readonly CompatibleProviderTool[];
};

const piAiContext = PiAi as unknown as PiAiContextCompat;

function findContextSystemMessage(
  context: CompatibleProviderContext,
): ContextSystemMessage | undefined {
  const messages = context.messages as readonly ContextSystemMessage[];
  return messages.find((message) => message.role === "system");
}

function contextText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeProviderContext(
  context: CompatibleProviderContext,
): NormalizedProviderContext {
  const systemMessage = findContextSystemMessage(context);
  const systemPrompt =
    typeof context.systemPrompt === "string"
      ? context.systemPrompt
      : (piAiContext.getCurrentSystemPrompt?.(context.messages) ??
        contextText(systemMessage?.content));
  const tools =
    context.tools ??
    piAiContext.getCurrentTools?.(context.messages) ??
    systemMessage?.toolsAdded ??
    [];
  return { systemPrompt, tools };
}

export async function createCompatibleSessionRuntime(
  options: {
    agentDir?: string;
    authStorageData?: Record<string, { type: "api_key"; key: string }>;
  } = {},
): Promise<CompatibleSessionRuntime> {
  if (codingAgent.ModelRuntime) {
    const modelRuntime = await codingAgent.ModelRuntime.create(
      options.agentDir
        ? {
            authPath: join(options.agentDir, "auth.json"),
            modelsPath: null,
          }
        : undefined,
    );
    return { kind: "modern", modelRuntime };
  }

  const authStorageFactory = codingAgent.AuthStorage;
  const modelRegistryFactory = codingAgent.ModelRegistry;
  if (!authStorageFactory || !modelRegistryFactory.create) {
    throw new Error(
      "Unsupported Pi coding-agent SDK: no session runtime API found",
    );
  }

  const authStorage = options.authStorageData
    ? authStorageFactory.inMemory?.(options.authStorageData)
    : authStorageFactory.create();
  if (!authStorage) {
    throw new Error(
      "Unsupported Pi coding-agent SDK: in-memory auth is unavailable",
    );
  }

  return {
    kind: "legacy",
    authStorage,
    modelRegistry: modelRegistryFactory.create(authStorage),
  };
}

export function buildSessionOptions(
  runtime: CompatibleSessionRuntime,
  base: Record<string, unknown>,
): Record<string, unknown> {
  if (runtime.kind === "modern") {
    return { ...base, modelRuntime: runtime.modelRuntime };
  }
  return {
    ...base,
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
  };
}

export function registerProvider(
  runtime: CompatibleSessionRuntime,
  provider: string,
  config: unknown,
): void {
  if (runtime.kind === "modern") {
    runtime.modelRuntime.registerProvider(provider, config);
  } else {
    runtime.modelRegistry.registerProvider(provider, config as ProviderConfig);
  }
}

export function findModel(
  runtime: CompatibleSessionRuntime,
  provider: string,
  modelId: string,
): Model<any> | undefined {
  if (runtime.kind === "modern") {
    return runtime.modelRuntime.getModel(provider, modelId);
  }
  return runtime.modelRegistry.find(provider, modelId) as
    Model<any> | undefined;
}

export function copyProviderConfig(
  runtime: CompatibleSessionRuntime,
  parentModelRegistry: ModelRegistry | undefined,
  provider: string,
): void {
  const registry = parentModelRegistry as unknown as {
    getRegisteredProviderConfig?: (providerId: string) => unknown;
    getRegisteredNativeProvider?: (providerId: string) => unknown;
  };
  const nativeProvider = registry.getRegisteredNativeProvider?.(provider);
  const config = registry.getRegisteredProviderConfig?.(provider);
  if (nativeProvider && runtime.kind === "modern") {
    runtime.modelRuntime.registerNativeProvider?.(nativeProvider);
    if (runtime.modelRuntime.registerNativeProvider) return;
  }
  if (config) registerProvider(runtime, provider, config);
}
