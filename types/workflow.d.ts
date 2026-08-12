export type WorkflowJSONPrimitive = string | number | boolean | null;

export type WorkflowJSONValue =
  | WorkflowJSONPrimitive
  | { readonly [key: string]: WorkflowJSONValue }
  | readonly WorkflowJSONValue[];

export type WorkflowJSONSchemaType =
  "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** Plain JSON Schema subset validated by the workflow runtime. */
export interface WorkflowJSONSchema {
  readonly type?: WorkflowJSONSchemaType | readonly WorkflowJSONSchemaType[];
  readonly enum?: readonly WorkflowJSONValue[];
  readonly properties?: Readonly<Record<string, WorkflowJSONSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: WorkflowJSONSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface WorkflowPhase {
  readonly title: string;
  readonly detail?: string;
  readonly [key: string]: WorkflowJSONValue | undefined;
}

export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly phases?: readonly WorkflowPhase[];
  readonly [key: string]:
    WorkflowJSONValue | readonly WorkflowPhase[] | undefined;
}

export type WorkflowThinkingLevel =
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkflowAgentOptions {
  /** Stable durable-operation identity. Required only when the run uses durable: true. */
  readonly id?: string;
  readonly schema?: WorkflowJSONSchema;
  readonly label?: string;
  readonly phase?: string;
  readonly model?: string;
  readonly persona?: string;
  readonly isolation?: "process" | "in-process";
  readonly agentType?: string;
  readonly thinkingLevel?: WorkflowThinkingLevel;
}

export interface WorkflowCallOptions {
  /** Stable durable-operation identity. Required only when the run uses durable: true. */
  readonly id?: string;
}

export type WorkflowThunk<T> = () => T | PromiseLike<T>;

export type WorkflowPipelineStage<TItem, TPrevious, TResult> = (
  previous: TPrevious,
  item: TItem,
  index: number,
) => TResult | PromiseLike<TResult>;

export interface WorkflowBudget {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

declare global {
  function agent(
    prompt: string,
    options?: WorkflowAgentOptions & { readonly schema?: undefined },
  ): Promise<string | null>;
  function agent<T extends WorkflowJSONValue = WorkflowJSONValue>(
    prompt: string,
    options: WorkflowAgentOptions & { readonly schema: WorkflowJSONSchema },
  ): Promise<T | null>;

  function parallel<T>(
    thunks: readonly WorkflowThunk<T>[],
  ): Promise<Array<Awaited<T> | null>>;

  function pipeline<TItem, TResult>(
    items: readonly TItem[],
    stage: WorkflowPipelineStage<TItem, TItem, TResult>,
  ): Promise<Array<Awaited<TResult> | null>>;
  function pipeline<TItem, TResult1, TResult2>(
    items: readonly TItem[],
    stage1: WorkflowPipelineStage<TItem, TItem, TResult1>,
    stage2: WorkflowPipelineStage<TItem, Awaited<TResult1>, TResult2>,
  ): Promise<Array<Awaited<TResult2> | null>>;
  function pipeline<TItem, TResult1, TResult2, TResult3>(
    items: readonly TItem[],
    stage1: WorkflowPipelineStage<TItem, TItem, TResult1>,
    stage2: WorkflowPipelineStage<TItem, Awaited<TResult1>, TResult2>,
    stage3: WorkflowPipelineStage<TItem, Awaited<TResult2>, TResult3>,
  ): Promise<Array<Awaited<TResult3> | null>>;
  function pipeline<TItem>(
    items: readonly TItem[],
    ...stages: Array<WorkflowPipelineStage<TItem, any, any>>
  ): Promise<Array<any | null>>;

  function workflow(
    name: string,
    childArgs?: WorkflowJSONValue,
    options?: WorkflowCallOptions,
  ): Promise<unknown>;
  function phase(title: string): void;
  function log(message: unknown): void;

  const args: WorkflowJSONValue | undefined;
  const cwd: string;
  const budget: WorkflowBudget;
}
