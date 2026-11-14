import type {
  WorkflowAgentOptions,
  WorkflowJSONSchema,
  WorkflowMeta,
} from "pi-subagentura/workflow";

const meta: WorkflowMeta = {
  name: "typed-workflow",
  description: "Exercises the published workflow globals.",
  phases: [{ title: "Scan", detail: "Inspect inputs" }],
};

const schema: WorkflowJSONSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

const options = {
  schema,
  label: "scan",
  phase: "Scan",
  model: "provider/model",
  persona: "Careful reviewer",
  isolation: "in-process",
  agentType: "reviewer",
  thinkingLevel: "high",
} satisfies WorkflowAgentOptions;

async function authorWorkflow(): Promise<unknown> {
  phase(meta.phases?.[0]?.title ?? "Scan");
  log({ cwd, args, remaining: budget.remaining() });

  const text = await agent("Inspect the repository", { label: "inspect" });
  const structured = await agent<{ ok: boolean }>("Return status", options);
  const parallelResults = await parallel([
    () => agent("Task A"),
    () => agent("Task B"),
  ]);
  const piped = await pipeline(
    [1, 2],
    (value) => value * 2,
    (value, item, index) => ({ value, item, index }),
  );
  const nested = await workflow("child", { parentCwd: cwd });

  return { text, structured, parallelResults, piped, nested };
}

// @ts-expect-error cwd is an immutable workflow global.
cwd = "/different";

void authorWorkflow;

async function pipelineContracts() {
  const unchanged: Array<number | null> = await pipeline([1]);
  const awaitedUnchanged = await pipeline([Promise.resolve("input")]);
  const zeroStageStrings: Array<string | null> = awaitedUnchanged;
  // @ts-expect-error Zero-stage pipelines preserve awaited input types.
  const zeroStageNumbers: Array<number | null> = awaitedUnchanged;
  void unchanged;
  void zeroStageStrings;
  void zeroStageNumbers;
  const increment = async (value: number) => value + 1;
  const longResult = await pipeline(
    [1],
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    (value: number) => `${value}`,
  );
  const longStrings: Array<string | null> = longResult;
  // @ts-expect-error Variadic results retain the final string type.
  const longNumbers: Array<number | null> = longResult;
  pipeline(
    [1],
    // @ts-expect-error The variadic path rejects a mismatched final stage.
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    increment,
    (value: string) => value,
  );
  void longStrings;
  void longNumbers;
  const result = await pipeline(
    [1],
    async (value) => `${value}`,
    (value) => value.length,
    async (value) => ({ count: value }),
    (value, item, index) => {
      // @ts-expect-error Awaited intermediate objects retain their exact shape.
      value.notARealProperty;
      // @ts-expect-error The original item remains numeric at every stage.
      item.toUpperCase();
      // @ts-expect-error The index remains numeric at every stage.
      index.toUpperCase();
      return value.count + item + index;
    },
    (value) => value.toFixed(),
    async (value) => value.length,
  );
  const numbers: Array<number | null> = result;
  // @ts-expect-error The final numeric result must not degrade to any.
  result[0]?.notARealMethod();
  // @ts-expect-error The final result is not a string array.
  const strings: Array<string | null> = result;
  pipeline(
    [1],
    // @ts-expect-error Adjacent stages must accept the awaited previous result.
    (value) => `${value}`,
    (value: number) => value + 1,
    (value: number) => value,
    (value: number) => value,
  );
  void numbers;
  void strings;
}

void pipelineContracts;
