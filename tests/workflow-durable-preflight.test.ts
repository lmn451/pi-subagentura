import { describe, expect, it } from "vitest";
import { inspectDurableWorkflow } from "../src/workflow-durable-preflight";

const script = (body: string) =>
  `export const meta = { name: "durable", description: "test" };\n${body}`;

describe("inspectDurableWorkflow", () => {
  it("accepts explicit literal ids and returns a stable source digest", () => {
    const source = script(
      'await agent("one", { id: "one" }); await workflow("child", {}, { id: "child" });',
    );
    const result = inspectDurableWorkflow(source);

    expect(result.durableReady).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.referencedWorkflows).toEqual(["child"]);
    expect(result.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.definitionDigest).toBe(
      inspectDurableWorkflow(source).definitionDigest,
    );
  });

  it("rejects calls without an explicit id property", () => {
    const result = inspectDurableWorkflow(
      script('await agent("one"); await workflow("child");'),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/agent\(\).*id|workflow\(\).*id/i);
  });

  it("allows computed ids used by map and pipeline callbacks", () => {
    const result = inspectDurableWorkflow(
      script(`
        const work = args.items.map((item, index) => agent(item, { id: "item/" + index }));
        return pipeline(work, (item, _, index) => agent(item, { id: \`stage/\${index}\` }));
      `),
    );

    expect(result.durableReady).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects duplicate literal ids", () => {
    const result = inspectDurableWorkflow(
      script(
        'await agent("one", { id: "same" }); await agent("two", { id: "same" });',
      ),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/duplicate.*same/i);
  });

  it("rejects invalid literal ids and aliased option objects", () => {
    const result = inspectDurableWorkflow(
      script(`
        const options = { id: "aliased" };
        await agent("one", options);
        await agent("two", { id: "bad id" });
      `),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/explicit|option/i);
    expect(result.errors.join(" ")).toMatch(/safe|invalid|1.?128/i);
  });

  it("rejects option spreads that can overwrite an explicit id", () => {
    const result = inspectDurableWorkflow(
      script('await agent("one", { id: "one", ...args.options });'),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/spread|ambiguous|explicit/i);
  });

  it("rejects non-string literal ids", () => {
    const result = inspectDurableWorkflow(
      script(
        'await agent("one", { id: 42 }); await agent("two", { id: null });',
      ),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/invalid.*id/i);
  });

  it("rejects escaped agent and workflow aliases", () => {
    const result = inspectDurableWorkflow(
      script(`
        const run = agent;
        const compose = workflow;
        await run("one", { id: "one" });
        await compose("child", {}, { id: "child" });
      `),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/alias|reference|agent|workflow/i);
  });

  it("rejects indirect identifier references to agent and workflow", () => {
    const result = inspectDurableWorkflow(
      script(`
        agent.call(null, "one");
        const api = { agent };
        api.agent("two", { id: "two" });
        await parallel([agent]);
      `),
    );

    expect(result.durableReady).toBe(false);
    expect(result.errors.join(" ")).toMatch(/reference|agent/i);
  });

  it("rejects dynamic nested workflow names", () => {
    const result = inspectDurableWorkflow(
      script('await workflow(args.childName, {}, { id: "child" });'),
    );

    expect(result.durableReady).toBe(false);
    expect(result.referencedWorkflows).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/workflow.*name.*literal/i);
  });

  it("reports parse and metadata errors without throwing", () => {
    const result = inspectDurableWorkflow("return await agent(");

    expect(result.durableReady).toBe(false);
    expect(result.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
