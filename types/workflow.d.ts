export type WorkflowJSONPrimitive = string | number | boolean | null;

export type WorkflowJSONValue =
  | WorkflowJSONPrimitive
  | { readonly [key: string]: WorkflowJSONValue }
  | readonly WorkflowJSONValue[];

export type WorkflowJSONSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

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
    | WorkflowJSONValue
    | readonly WorkflowPhase[]
    | undefined;
}

export type WorkflowThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface WorkflowAgentOptions {
  readonly schema?: WorkflowJSONSchema;
  readonly label?: string;
  readonly phase?: string;
  readonly model?: string;
  readonly persona?: string;
  readonly isolation?: "process" | "in-process";
  /** Accepted for compatibility with callers; the workflow runtime ignores it. */
  readonly agentType?: string;
  readonly thinkingLevel?: WorkflowThinkingLevel;
}

export type WorkflowThunk<T> = () => T | PromiseLike<T>;

export type WorkflowPipelineStage<TItem, TPrevious, TResult> = (
  previous: TPrevious,
  item: TItem,
  index: number,
) => TResult | PromiseLike<TResult>;

export type WorkflowPipelineFunction = (...args: never[]) => unknown;

export type WorkflowPipelineStages<
  TItem,
  TPrevious,
  TStages extends readonly WorkflowPipelineFunction[],
> = TStages extends readonly [
  infer THead extends WorkflowPipelineFunction,
  ...infer TTail extends readonly WorkflowPipelineFunction[],
]
  ? readonly [
      (previous: TPrevious, item: TItem, index: number) => ReturnType<THead>,
      ...WorkflowPipelineStages<TItem, Awaited<ReturnType<THead>>, TTail>,
    ]
  : readonly [];

export type WorkflowPipelineResult<
  TStages extends readonly WorkflowPipelineFunction[],
> = TStages extends readonly [
  ...WorkflowPipelineFunction[],
  infer TLast extends WorkflowPipelineFunction,
]
  ? Awaited<ReturnType<TLast>>
  : never;

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

  function pipeline<TItem>(
    items: readonly TItem[],
  ): Promise<Array<Awaited<TItem> | null>>;
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
  // Contextual overloads keep inline callbacks ergonomic. The variadic overload
  // below also validates longer, explicitly typed stage tuples.
  function pipeline<TItem, TResult1, TResult2, TResult3, TResult4>(
    items: readonly TItem[],
    stage1: WorkflowPipelineStage<TItem, TItem, TResult1>,
    stage2: WorkflowPipelineStage<TItem, Awaited<TResult1>, TResult2>,
    stage3: WorkflowPipelineStage<TItem, Awaited<TResult2>, TResult3>,
    stage4: WorkflowPipelineStage<TItem, Awaited<TResult3>, TResult4>,
  ): Promise<Array<Awaited<TResult4> | null>>;
  function pipeline<TItem, TResult1, TResult2, TResult3, TResult4, TResult5>(
    items: readonly TItem[],
    stage1: WorkflowPipelineStage<TItem, TItem, TResult1>,
    stage2: WorkflowPipelineStage<TItem, Awaited<TResult1>, TResult2>,
    stage3: WorkflowPipelineStage<TItem, Awaited<TResult2>, TResult3>,
    stage4: WorkflowPipelineStage<TItem, Awaited<TResult3>, TResult4>,
    stage5: WorkflowPipelineStage<TItem, Awaited<TResult4>, TResult5>,
  ): Promise<Array<Awaited<TResult5> | null>>;
  function pipeline<
    TItem,
    TResult1,
    TResult2,
    TResult3,
    TResult4,
    TResult5,
    TResult6,
  >(
    items: readonly TItem[],
    stage1: WorkflowPipelineStage<TItem, TItem, TResult1>,
    stage2: WorkflowPipelineStage<TItem, Awaited<TResult1>, TResult2>,
    stage3: WorkflowPipelineStage<TItem, Awaited<TResult2>, TResult3>,
    stage4: WorkflowPipelineStage<TItem, Awaited<TResult3>, TResult4>,
    stage5: WorkflowPipelineStage<TItem, Awaited<TResult4>, TResult5>,
    stage6: WorkflowPipelineStage<TItem, Awaited<TResult5>, TResult6>,
  ): Promise<Array<Awaited<TResult6> | null>>;
  function pipeline<
    TItem,
    const TStages extends readonly WorkflowPipelineFunction[],
  >(
    items: readonly TItem[],
    ...stages: TStages & WorkflowPipelineStages<TItem, TItem, TStages>
  ): Promise<Array<WorkflowPipelineResult<TStages> | null>>;

  function workflow(
    name: string,
    childArgs?: WorkflowJSONValue,
  ): Promise<unknown>;
  function phase(title: string): void;
  function log(message: unknown): void;

  const args: WorkflowJSONValue | undefined;
  const cwd: string;
  const budget: WorkflowBudget;
}
