import {
  defineWorkflow,
  schema,
  type RepeatResult,
  type TaskResult,
  type WorkflowContext,
  type WorkflowFailureResult,
  type WorkflowJsonValue,
  type WorkflowStepNode,
} from "pi-subagentura/workflow";

const Input = schema.object({
  path: schema.string(),
  includeTests: schema.optional(schema.boolean()),
});
const Review = schema.object({
  approved: schema.boolean(),
  issues: schema.array(schema.string()),
});

const definition = defineWorkflow({
  name: "typed-review",
  version: 1,
  input: Input,
  output: Review,
  async run(ctx, args) {
    const path: string = args.path;
    const includeTests: boolean | undefined = args.includeTests;
    // @ts-expect-error unknown schema properties are not inferred
    const missing = args.notInInput;
    const result = await ctx.agent("security", {
      prompt: `Review ${path}`,
      output: Review,
      retry: { attempts: 2, backoff: "exponential" },
    });
    const fanout = await ctx.parallel(
      {
        security: () => result,
        tests: () => ({ approved: includeTests ?? false, issues: [] }),
      },
      { concurrency: 2, failure: "collect" },
    );
    const security: TaskResult<{
      approved: boolean;
      issues: readonly string[];
    }> = fanout.security;
    const cycle: RepeatResult<{
      approved: boolean;
      issues: readonly string[];
    }> = await ctx.repeat(
      "critic-cycle",
      { maxIterations: 2, until: ({ value }) => value.approved },
      async ({ previous }) => previous ?? result,
    );
    const fileResult = await ctx.map(
      [path],
      (file, item) => ctx.agent(item.id, { prompt: `Review ${file}` }),
      { stepId: "files", failure: "collect" },
    );
    const pipelineResult = await ctx.pipeline(
      [path],
      (file, item) => `${item.itemId}:${file}`,
      (value) => ({ value }),
      (value, info) => ({ value, stage: info.stage }),
      { stepId: "pipeline" },
    );
    const confirmation: Promise<boolean> = ctx.ask("approve", {
      type: "confirm",
      question: "Proceed?",
    });
    const answer: Promise<string> = ctx.ask("answer", {
      type: "input",
      question: "What should change?",
    });
    const gate: Promise<boolean> = ctx.gate("gate", { title: "Approve" });
    const logged: Promise<void> = ctx.log("progress");
    const recoverable: Promise<number | WorkflowFailureResult> = ctx.step(
      "recoverable",
      { failure: "collect" },
      () => 1,
    );
    const keyed = await ctx.map([{ key: "one" }], (item) => item.key, {
      key: (item) => item.key,
    });
    const pipelineKey = await ctx.pipeline(
      [{ key: "one" }],
      (item) => item.key,
      (value) => value,
      (value) => value,
      { key: (item) => item.key },
    );
    const artifact = await ctx.artifact.write("report", {
      cycle,
      pipelineResult,
      keyed,
      pipelineKey,
    });
    await ctx.checkpoint("saved", { artifact: artifact.id });
    void security;
    void fileResult;
    void confirmation;
    void answer;
    void gate;
    void logged;
    void recoverable;
    return result;
  },
});

const context = {} as WorkflowContext;
const result: import("../types/workflow-v4").Awaitable<{
  readonly approved: boolean;
  readonly issues: readonly string[];
}> = definition.run(context, { path: "src/auth" });

void result;

const noInputDefinition = defineWorkflow({
  name: "optional-args",
  version: 1,
  run(_ctx, args) {
    const optional: WorkflowJsonValue | undefined = args;
    // @ts-expect-error args may be undefined when no input schema is declared
    const required: WorkflowJsonValue = args;
    void optional;
    void required;
    return undefined;
  },
});
void noInputDefinition;

const node: WorkflowStepNode = {
  id: "review",
  path: ["review"],
  title: "Review",
  kind: "step",
  status: "running",
  attempt: 1,
  inputHash: "hash",
  definitionHash: "hash",
  startedAt: Date.now(),
};
void node;
