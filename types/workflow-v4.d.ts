export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue =
  | WorkflowJsonPrimitive
  | { readonly [key: string]: WorkflowJsonValue }
  | readonly WorkflowJsonValue[];

export interface WorkflowSchemaDefinition {
  readonly type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null"
    | readonly (
        | "object"
        | "array"
        | "string"
        | "number"
        | "integer"
        | "boolean"
        | "null"
      )[];
  readonly enum?: readonly WorkflowJsonValue[];
  readonly properties?: Readonly<Record<string, WorkflowSchemaDefinition>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: WorkflowSchemaDefinition;
  readonly minItems?: number;
  readonly maxItems?: number;
}

declare const schemaValue: unique symbol;
declare const optionalSchema: unique symbol;

export interface WorkflowSchema<T> extends WorkflowSchemaDefinition {
  readonly [schemaValue]?: T;
}

export interface OptionalWorkflowSchema<T> extends WorkflowSchema<T> {
  readonly [optionalSchema]: true;
}

export type InferWorkflowSchema<S> =
  S extends WorkflowSchema<infer T> ? T : never;

type SchemaOutput<S> = S extends WorkflowSchema<infer T> ? T : never;
type OptionalKeys<P> = {
  [K in keyof P]-?: P[K] extends OptionalWorkflowSchema<unknown> ? K : never;
}[keyof P];
type RequiredKeys<P> = Exclude<keyof P, OptionalKeys<P>>;
type ObjectSchemaOutput<P> = {
  readonly [K in RequiredKeys<P>]: SchemaOutput<P[K]>;
} & {
  readonly [K in OptionalKeys<P>]?: SchemaOutput<P[K]>;
};

export interface WorkflowSchemaBuilder {
  string(): WorkflowSchema<string>;
  number(): WorkflowSchema<number>;
  integer(): WorkflowSchema<number>;
  boolean(): WorkflowSchema<boolean>;
  null(): WorkflowSchema<null>;
  enum<const V extends readonly [WorkflowJsonValue, ...WorkflowJsonValue[]]>(
    values: V,
  ): WorkflowSchema<V[number]>;
  array<S extends WorkflowSchema<unknown>>(
    items: S,
    options?: { minItems?: number; maxItems?: number },
  ): WorkflowSchema<readonly SchemaOutput<S>[]>;
  optional<S extends WorkflowSchema<unknown>>(
    schema: S,
  ): OptionalWorkflowSchema<SchemaOutput<S>>;
  object<const P extends Record<string, WorkflowSchema<unknown>>>(
    properties: P,
    options?: { additionalProperties?: boolean },
  ): WorkflowSchema<ObjectSchemaOutput<P>>;
}

export type Awaitable<T> = T | PromiseLike<T>;
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_for_input"
  | "blocked"
  | "cancelled"
  | "skipped"
  | "restored";

export interface SerializedWorkflowError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly category?: string;
  readonly stage?: string;
  readonly path?: readonly string[];
  readonly cause?: SerializedWorkflowError;
}

export type TaskResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedWorkflowError };

export interface WorkflowFailureResult {
  readonly ok: false;
  readonly error: SerializedWorkflowError;
}

export type WorkflowStepOutcome<T> = T | WorkflowFailureResult;

export interface WorkflowStepNode<T = unknown> {
  readonly id: string;
  readonly path: readonly string[];
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly attempt: number;
  readonly generation?: number;
  readonly inputHash: string;
  readonly definitionHash: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: SerializedWorkflowError;
  readonly request?: unknown;
}

export type WorkflowEvent =
  | { readonly type: "workflow.started"; readonly workflowId: string }
  | {
      readonly type: "step.started";
      readonly path: string;
      readonly attempt: number;
    }
  | {
      readonly type: "step.progress";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly type: "step.completed";
      readonly path: string;
      readonly outputRef?: ArtifactRef;
    }
  | {
      readonly type: "step.failed";
      readonly path: string;
      readonly error: SerializedWorkflowError;
    }
  | {
      readonly type: "gate.waiting";
      readonly path: string;
      readonly request: AskRequest;
    }
  | { readonly type: "workflow.completed"; readonly resultRef?: ArtifactRef }
  | { readonly type: "workflow.cancelled"; readonly reason?: string };

export interface ArtifactRef {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface WorkflowRetryPolicy {
  readonly attempts: number;
  readonly backoff?: "fixed" | "exponential" | number;
}

export interface WorkflowStepPolicy {
  readonly timeout?: number | string;
  readonly retry?: WorkflowRetryPolicy;
  readonly failure?: "fail" | "continue" | "collect";
  readonly persist?: boolean;
  readonly resume?: boolean;
  readonly cache?: boolean;
  readonly budget?: number;
}

export interface WorkflowStepOptions extends WorkflowStepPolicy {
  readonly title?: string;
  readonly input?: unknown;
  readonly policy?: WorkflowStepPolicy;
}

export interface WorkflowAgentOptions<
  S extends WorkflowSchema<unknown> | undefined = undefined,
> extends WorkflowStepPolicy {
  readonly title?: string;
  readonly prompt: string;
  readonly output?: S;
  readonly model?: string;
  readonly persona?: string;
  readonly isolation?: "process" | "in-process";
  readonly thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
}

export interface WorkflowExecutionOptions extends WorkflowStepPolicy {
  readonly stepId?: string;
  readonly id?: string;
  readonly title?: string;
}

export interface ParallelOptions {
  readonly stepId?: string;
  readonly concurrency?: number;
  readonly failure?: "fail" | "continue" | "collect";
  readonly titles?: Readonly<Record<string, string>>;
}

export interface MapOptions<T = unknown> extends ParallelOptions {
  readonly key?: (item: T, index: number) => string;
  readonly id?: string;
  readonly title?: string;
  readonly titleForItem?: (item: T, index: number) => string;
}

export interface PipelineOptions<T = unknown> extends ParallelOptions {
  readonly id?: string;
  readonly title?: string;
  readonly key?: (item: T, index: number) => string;
}

type PipelineOutput<R, O extends PipelineOptions<any>> = [
  Extract<O["failure"], "collect" | "continue">,
] extends [never]
  ? Awaited<R>[]
  : [Extract<O["failure"], "fail" | undefined>] extends [never]
    ? TaskResult<Awaited<R>>[]
    : Awaited<R>[] | TaskResult<Awaited<R>>[];

export interface WorkflowPipelineInfo<T = unknown> {
  readonly item: T;
  readonly stage: number;
  readonly itemId: string;
  readonly index: number;
  readonly signal: AbortSignal;
}

export type RepeatTermination =
  | "condition_met"
  | "max_iterations"
  | "budget_exhausted";

export interface RepeatResult<T> {
  readonly value: T;
  readonly iterations: number;
  readonly termination: RepeatTermination;
}

export interface RepeatOptions<T> {
  readonly maxIterations: number;
  readonly until?: (state: {
    value: T;
    iteration: number;
  }) => Awaitable<boolean>;
  readonly onLimit?: "return-last" | "throw";
  readonly title?: string;
  readonly iterationTitle?: (iteration: number) => string;
}

export type AskRequest =
  | {
      readonly type: "input";
      readonly question: string;
      readonly defaultValue?: string;
    }
  | {
      readonly type: "confirm";
      readonly question: string;
      readonly defaultValue?: boolean;
    }
  | {
      readonly type: "select";
      readonly question: string;
      readonly choices: readonly string[];
    };

export interface WorkflowBudget {
  readonly total: number | null;
  spent(): number;
  remaining(): number | null;
  assertAvailable(amount: number): void;
}

export interface WorkflowContext {
  readonly signal: AbortSignal;
  readonly budget: WorkflowBudget;
  step<T>(id: string, work: () => Awaitable<T>): Promise<T>;
  step<T>(
    id: string,
    options: WorkflowStepOptions & {
      readonly policy: WorkflowStepPolicy & {
        readonly failure: "continue" | "collect";
      };
    },
    work: () => Awaitable<T>,
  ): Promise<WorkflowStepOutcome<T>>;
  step<T>(
    id: string,
    options: WorkflowStepOptions & { readonly failure: "continue" | "collect" },
    work: () => Awaitable<T>,
  ): Promise<WorkflowStepOutcome<T>>;
  step<T>(
    id: string,
    options: WorkflowStepOptions & { readonly failure?: "fail" },
    work: () => Awaitable<T>,
  ): Promise<T>;
  agent<S extends WorkflowSchema<unknown> | undefined = undefined>(
    id: string,
    options: WorkflowAgentOptions<S> & {
      readonly failure: "continue" | "collect";
    },
  ): Promise<
    | (S extends WorkflowSchema<unknown> ? SchemaOutput<S> : string)
    | WorkflowFailureResult
  >;
  agent<S extends WorkflowSchema<unknown> | undefined = undefined>(
    id: string,
    options: WorkflowAgentOptions<S> & { readonly failure?: "fail" },
  ): Promise<S extends WorkflowSchema<unknown> ? SchemaOutput<S> : string>;
  group<T>(id: string, work: () => Awaitable<T>): Promise<T>;
  group<T>(id: string, title: string, work: () => Awaitable<T>): Promise<T>;
  parallel<const B extends Record<string, () => unknown>>(
    branches: B,
    options?: ParallelOptions & { failure?: "fail" },
  ): Promise<{ [K in keyof B]: Awaited<ReturnType<B[K]>> }>;
  parallel<const B extends Record<string, () => unknown>>(
    branches: B,
    options: ParallelOptions & { failure: "continue" | "collect" },
  ): Promise<{ [K in keyof B]: TaskResult<Awaited<ReturnType<B[K]>>> }>;
  map<T, R>(
    items: readonly T[],
    work: (
      item: T,
      info: { id: string; index: number; signal: AbortSignal },
    ) => Awaitable<R>,
    options?: MapOptions<T> & { failure?: "fail" },
  ): Promise<Awaited<R>[]>;
  map<T, R>(
    items: readonly T[],
    work: (
      item: T,
      info: { id: string; index: number; signal: AbortSignal },
    ) => Awaitable<R>,
    options: MapOptions<T> & { failure: "continue" | "collect" },
  ): Promise<TaskResult<Awaited<R>>[]>;
  pipeline<T, A>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    options: PipelineOptions<T> & { readonly failure: "collect" },
  ): Promise<TaskResult<Awaited<A>>[]>;
  pipeline<T, A, O extends PipelineOptions<T>>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    options: O,
  ): Promise<PipelineOutput<A, O>>;
  pipeline<T, A>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    options?: PipelineOptions<T>,
  ): Promise<Awaited<A>[]>;
  pipeline<T, A, B>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    options: PipelineOptions<T> & { readonly failure: "collect" },
  ): Promise<TaskResult<Awaited<B>>[]>;
  pipeline<T, A, B, O extends PipelineOptions<T>>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    options: O,
  ): Promise<PipelineOutput<B, O>>;
  pipeline<T, A, B>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    options?: PipelineOptions<T>,
  ): Promise<Awaited<B>[]>;
  pipeline<T, A, B, C>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    third: (value: Awaited<B>, info: WorkflowPipelineInfo<T>) => Awaitable<C>,
    options: PipelineOptions<T> & { readonly failure: "collect" },
  ): Promise<TaskResult<Awaited<C>>[]>;
  pipeline<T, A, B, C, O extends PipelineOptions<T>>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    third: (value: Awaited<B>, info: WorkflowPipelineInfo<T>) => Awaitable<C>,
    options: O,
  ): Promise<PipelineOutput<C, O>>;
  pipeline<T, A, B, C>(
    items: readonly T[],
    first: (item: T, info: WorkflowPipelineInfo<T>) => Awaitable<A>,
    second: (value: Awaited<A>, info: WorkflowPipelineInfo<T>) => Awaitable<B>,
    third: (value: Awaited<B>, info: WorkflowPipelineInfo<T>) => Awaitable<C>,
    options?: PipelineOptions<T>,
  ): Promise<Awaited<C>[]>;
  pipeline<T>(
    items: readonly T[],
    ...stages: Array<
      | ((previous: any, info: WorkflowPipelineInfo<T>) => Awaitable<any>)
      | PipelineOptions<T>
    >
  ): Promise<any[]>;
  repeat<T>(
    id: string,
    options: RepeatOptions<T>,
    work: (state: {
      iteration: number;
      previous?: T;
      signal: AbortSignal;
    }) => Awaitable<T>,
  ): Promise<RepeatResult<T>>;
  workflow<T = unknown>(
    name: string,
    args: unknown,
    options: WorkflowExecutionOptions & {
      readonly failure: "continue" | "collect";
    },
  ): Promise<WorkflowStepOutcome<T>>;
  workflow<T = unknown>(
    name: string,
    args: unknown,
    options?: WorkflowExecutionOptions & { readonly failure?: "fail" },
  ): Promise<T>;
  ask(
    id: string,
    request: Extract<AskRequest, { type: "confirm" }>,
  ): Promise<boolean>;
  ask(
    id: string,
    request: Exclude<AskRequest, { type: "confirm" }>,
  ): Promise<string>;
  ask<T extends string | boolean>(id: string, request: AskRequest): Promise<T>;
  gate(
    id: string,
    request: {
      title: string;
      summary?: string;
      artifacts?: readonly ArtifactRef[];
    },
  ): Promise<boolean>;
  checkpoint(id: string, value: unknown): Promise<void>;
  artifact: {
    write(
      name: string,
      value: unknown,
      options?: { type?: string },
    ): Promise<ArtifactRef>;
    read(ref: ArtifactRef): Promise<WorkflowJsonValue>;
  };
  log(message: unknown): Promise<void>;
}

export interface WorkflowDefinition<
  I extends WorkflowSchema<unknown> | undefined = undefined,
  O extends WorkflowSchema<unknown> | undefined = undefined,
> {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly input?: I;
  readonly output?: O;
  readonly run: (
    ctx: WorkflowContext,
    args: I extends WorkflowSchema<unknown>
      ? SchemaOutput<I>
      : WorkflowJsonValue | undefined,
  ) => Awaitable<
    O extends WorkflowSchema<unknown>
      ? SchemaOutput<O>
      : WorkflowJsonValue | undefined
  >;
}

export type WorkflowDefinitionInput<
  I extends WorkflowSchema<unknown> | undefined,
  O extends WorkflowSchema<unknown> | undefined,
> = Omit<WorkflowDefinition<I, O>, "input" | "output"> &
  (I extends undefined ? { readonly input?: I } : { readonly input: I }) &
  (O extends undefined ? { readonly output?: O } : { readonly output: O });
