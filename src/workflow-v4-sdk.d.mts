import type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowSchemaBuilder,
  WorkflowSchema,
} from "../types/workflow-v4.d.ts";

export declare const schema: WorkflowSchemaBuilder;

export declare function defineWorkflow<
  I extends WorkflowSchema<unknown> | undefined = undefined,
  O extends WorkflowSchema<unknown> | undefined = undefined,
>(definition: WorkflowDefinitionInput<I, O>): WorkflowDefinition<I, O>;
