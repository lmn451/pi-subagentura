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
  isolation: "process",
  agentType: "reviewer",
  thinkingLevel: "high",
} satisfies WorkflowAgentOptions;

const reusableOptions = {
  isolation: "process",
  reusable: true,
} satisfies WorkflowAgentOptions;

async function authorWorkflow(): Promise<unknown> {
  phase(meta.phases?.[0]?.title ?? "Scan");
  log({ cwd, args, remaining: budget.remaining() });

  const text = await agent("Inspect the repository", { label: "inspect" });
  const reusable = await agent("Retain this context", reusableOptions);
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

  return { text, reusable, structured, parallelResults, piped, nested };
}

// @ts-expect-error cwd is an immutable workflow global.
cwd = "/different";

void authorWorkflow;
