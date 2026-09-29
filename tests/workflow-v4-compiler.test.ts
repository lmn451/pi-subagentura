import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { compileWorkflowScript } from "../src/workflow-script.mjs";
import { defineWorkflow, schema } from "../src/workflow-v4-sdk.mjs";

describe("v4 workflow compiler", () => {
  it("strips erasable TypeScript and evaluates a definition with injected SDK bindings", async () => {
    const compiled = compileWorkflowScript(`
      import type { LocalReview } from "unresolved-types-only";
      import { defineWorkflow, schema } from "pi-subagentura/workflow";

      type Args = { path: string };
      const Input = schema.object({ path: schema.string() });
      const Output = schema.object({ ok: schema.boolean() });

      export default defineWorkflow({
        name: "review-auth",
        version: 1,
        description: "Review auth",
        input: Input,
        output: Output,
        async run(ctx, args: Args): Promise<{ ok: boolean }> {
          return { ok: args.path.length > 0 };
        }
      });
    `);

    expect(compiled).toMatchObject({
      format: "definition",
      meta: {
        name: "review-auth",
        version: 1,
        description: "Review auth",
      },
    });

    const invoke = runInNewContext(
      compiled.body,
      {},
      {
        contextCodeGeneration: { strings: false, wasm: false },
      },
    ) as (
      run: (definition: unknown) => Promise<unknown>,
      define: typeof defineWorkflow,
      schemas: typeof schema,
    ) => Promise<unknown>;
    const captured = vi.fn(async (definition: any) => definition);
    const definition = (await invoke(captured, defineWorkflow, schema)) as any;

    expect(captured).toHaveBeenCalledOnce();
    expect(definition.name).toBe("review-auth");
    await expect(definition.run({}, { path: "src/auth.ts" })).resolves.toEqual({
      ok: true,
    });
  });

  it("keeps the legacy meta format available", () => {
    const compiled = compileWorkflowScript(`
      export const meta = { name: "legacy", description: "Old format" };
      return args;
    `);
    expect(compiled).toMatchObject({
      format: "legacy",
      meta: { name: "legacy", description: "Old format" },
      body: expect.stringContaining("return args"),
    });
  });

  it("accepts and executes an arrow-function run property", async () => {
    const compiled = compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "arrow-run",
        version: 1,
        run: async (ctx, args) => ({ value: args.value }),
      });
    `);
    const invoke = runInNewContext(compiled.body) as (
      run: (definition: unknown) => Promise<unknown>,
      define: typeof defineWorkflow,
      schemas: typeof schema,
    ) => Promise<{
      run(ctx: unknown, args: { value: number }): Promise<unknown>;
    }>;
    const definition = await invoke(
      vi.fn(async (value) => value),
      defineWorkflow,
      schema,
    );
    await expect(definition.run({}, { value: 7 })).resolves.toEqual({
      value: 7,
    });
  });

  it("evaluates the rest of the module before invoking the definition", async () => {
    const compiled = compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "later-binding",
        version: 1,
        run: () => later,
      });
      const later = "initialized after export";
    `);
    const invoke = runInNewContext(compiled.body) as (
      run: (definition: { run(): string }) => Promise<string>,
      define: typeof defineWorkflow,
      schemas: typeof schema,
    ) => Promise<string>;

    await expect(
      invoke(
        (definition) => Promise.resolve(definition.run()),
        defineWorkflow,
        schema,
      ),
    ).resolves.toBe("initialized after export");
  });

  it("keeps generated SDK parameters clear of valid top-level bindings", async () => {
    const compiled = compileWorkflowScript(`
      import { defineWorkflow as define, schema as sdkSchema } from "pi-subagentura/workflow";
      const schema = "local schema binding";
      const Input = sdkSchema.object({ value: sdkSchema.string() });
      export default define({
        name: "schema-collision",
        version: 1,
        input: Input,
        run(_ctx, args) { return { value: args.value, local: schema }; },
      });
    `);
    const invoke = runInNewContext(compiled.body) as (
      run: (definition: unknown) => Promise<any>,
      define: typeof defineWorkflow,
      schemas: typeof schema,
    ) => Promise<any>;
    const definition = await invoke(
      (value) => Promise.resolve(value),
      defineWorkflow,
      schema,
    );

    expect(definition.run({}, { value: "ok" })).toEqual({
      value: "ok",
      local: "local schema binding",
    });
  });

  it("rejects top-level return while preserving returns inside functions", async () => {
    expect(() =>
      compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      return 1;
      export default defineWorkflow({ name: "bad-return", version: 1, run() {} });
    `),
    ).toThrow(/top-level return/i);

    const compiled = compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "function-return",
        version: 1,
        run() { return 2; },
      });
    `);
    const invoke = runInNewContext(compiled.body) as (
      run: (definition: { run(): number }) => Promise<number>,
      define: typeof defineWorkflow,
      schemas: typeof schema,
    ) => Promise<number>;
    await expect(
      invoke(
        (definition) => Promise.resolve(definition.run()),
        defineWorkflow,
        schema,
      ),
    ).resolves.toBe(2);
  });

  it("accepts an empty description literal", () => {
    expect(
      compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({ name: "short", version: 1, description: "", run() {} });
    `).meta.description,
    ).toBe("");
  });

  it.each([
    ["arbitrary runtime module", `import fs from "node:fs";`],
    [
      "namespace SDK import",
      `import * as workflow from "pi-subagentura/workflow";`,
    ],
    ["unknown SDK binding", `import { run } from "pi-subagentura/workflow";`],
    ["dynamic import", `const later = import("pi-subagentura/workflow");`],
    ["extra runtime export", `export const helper = 1;`],
  ])("rejects %s", (_label, prefix) => {
    expect(() =>
      compileWorkflowScript(`${prefix}
      import { defineWorkflow } from "pi-subagentura/workflow";
      export default defineWorkflow({
        name: "safe",
        version: 1,
        run: async () => null
      });
    `),
    ).toThrow();
  });

  it.each([
    ["missing definition export", `const workflow = { name: "x" };`],
    [
      "non-literal name",
      `const name = "x"; export default defineWorkflow({ name, version: 1, run() {} });`,
    ],
    [
      "invalid version",
      `export default defineWorkflow({ name: "x", version: "1", run() {} });`,
    ],
    [
      "non-function run",
      `export default defineWorkflow({ name: "x", version: 1, run: getRun() });`,
    ],
  ])("rejects invalid definition source: %s", (_label, code) => {
    expect(() =>
      compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      ${code}
    `),
    ).toThrow();
  });

  it("rejects TypeScript syntax that needs code generation", () => {
    expect(() =>
      compileWorkflowScript(`
      import { defineWorkflow } from "pi-subagentura/workflow";
      enum State { Pending, Done }
      export default defineWorkflow({ name: "x", version: 1, run() {} });
    `),
    ).toThrow();
  });
});
