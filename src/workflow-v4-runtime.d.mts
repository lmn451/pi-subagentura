import type {
  ArtifactRef,
  WorkflowDefinition,
  WorkflowJsonValue,
} from "../types/workflow-v4.d.ts";

export interface WorkflowRuntimeBridge {
  readonly signal?: AbortSignal;
  readonly budget?: {
    readonly total: number | null;
    spent(): number;
    remaining(): number;
  };
  validate?(value: unknown, schema: unknown): string[] | PromiseLike<string[]>;
  request(action: string, payload: any, signal?: AbortSignal): Promise<any>;
  agent(
    prompt: string,
    options: Record<string, unknown>,
    signal?: AbortSignal,
    onUsage?: (tokens: number) => void,
  ): Promise<unknown>;
  workflow(
    name: string,
    args: unknown,
    options: Record<string, unknown>,
  ): Promise<unknown>;
  log?(message: unknown, path: readonly string[]): unknown;
}

export class WorkflowStepError extends Error {
  readonly category: string;
  readonly stage: string;
  readonly path: readonly string[];
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      category?: string;
      stage?: string;
      path?: readonly string[];
    },
  );
}

export class WorkflowCancelledError extends WorkflowStepError {
  constructor(path?: readonly string[], cause?: unknown);
}

export class WorkflowTimeoutError extends WorkflowStepError {
  constructor(path: readonly string[], timeout: string | number);
}

export function runWorkflowDefinition(
  definition: WorkflowDefinition<any, any>,
  args: WorkflowJsonValue,
  bridge: WorkflowRuntimeBridge,
): Promise<WorkflowJsonValue>;
