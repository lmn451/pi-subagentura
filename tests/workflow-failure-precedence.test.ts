import { expect, it } from "vitest";
import { runWorkflow } from "../src/workflow-worker";
import { zeroUsage } from "../src/usage";

const meta = 'export const meta = { name: "diagnostics", description: "d" };\n';

it("classifies an ordinary failed agent turn without exposing its output", async () => {
  const result = await runWorkflow(
    meta + 'return await agent("private-task");',
    {
      runAgent: async () => ({
        isError: true,
        output: "private-error",
        errorMessage: "private-error",
        usage: zeroUsage(),
      }),
    },
  );
  expect(result.failure).toEqual({
    errorCategory: "unknown",
    errorStage: "turn",
  });
});

it("prefers concrete schema evidence over an earlier generic turn failure", async () => {
  const result = await runWorkflow(
    meta +
      'await agent("ordinary"); return await agent("schema", { schema: { type: "object" } });',
    {
      runAgent: async ({ prompt }) =>
        prompt === "ordinary"
          ? {
              isError: true,
              output: "private-error",
              errorMessage: "private-error",
              usage: zeroUsage(),
            }
          : { isError: false, output: "not JSON", usage: zeroUsage() },
    },
  );
  expect(result.failure).toEqual({
    errorCategory: "schema",
    errorStage: "schema_validation",
  });
});
