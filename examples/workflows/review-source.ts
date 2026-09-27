import { defineWorkflow, schema } from "pi-subagentura/workflow";

const Input = schema.object({
  files: schema.array(schema.string(), { minItems: 1, maxItems: 40 }),
});

const Findings = schema.object({
  findings: schema.array(schema.string(), { maxItems: 30 }),
});

const Review = schema.object({
  summary: schema.string(),
  findings: schema.array(schema.string(), { maxItems: 60 }),
  artifactId: schema.string(),
});

export default defineWorkflow({
  name: "review-source",
  version: 1,
  description: "Review a bounded set of source files and save the findings.",
  input: Input,
  output: Review,
  async run(ctx, args) {
    const files = await ctx.map(
      args.files,
      async (file, item) => {
        const result = await ctx.agent("review-file", {
          title: `Review ${file}`,
          prompt:
            `Read ${file} and report concrete correctness or security findings. ` +
            "Do not edit files. Return JSON with a findings string array.",
          output: Findings,
        });
        await ctx.log(`Finished review item ${item.index + 1}.`);
        return result;
      },
      {
        stepId: "review-files",
        key: (_file, index) => String(index + 1),
        concurrency: 3,
      },
    );

    const grouped = await ctx.group("synthesis", "Synthesis", async () => {
      const result = await ctx.agent("summarize", {
        title: "Summarize findings",
        prompt:
          "Combine these file reviews into a concise summary and deduplicated findings array:\n" +
          JSON.stringify(files),
        output: schema.object({
          summary: schema.string(),
          findings: schema.array(schema.string(), { maxItems: 60 }),
        }),
      });
      await ctx.checkpoint("draft-review", result);
      return result;
    });

    const approved = await ctx.ask("approval", {
      type: "confirm",
      question: "Save this review as a workflow artifact?",
      defaultValue: true,
    });
    if (!approved) throw new Error("Review artifact was declined.");

    const artifact = await ctx.artifact.write("review", grouped);
    return { ...grouped, artifactId: artifact.id };
  },
});
