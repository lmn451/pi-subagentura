export const meta = {
  name: "durable-review",
  description:
    "Repeatable read-only review with bounded retries and synthesis.",
  phases: [{ title: "Review" }, { title: "Synthesize" }],
};

if (typeof args?.path !== "string" || !args.path.trim()) {
  throw new Error("args.path must identify the code to review.");
}
const areas = ["correctness", "tests", "security"];
phase("Review");
const findings = await parallel(
  areas.map(
    (area) => () =>
      retry(
        (attempt) =>
          agent(
            `Review ${args.path} for ${area}. Read-only: do not edit files or delegate. ` +
              "Report verified findings with paths and evidence, or explicitly report no findings.",
            { id: `review/${area}/${attempt}`, label: area },
          ),
        { attempts: 2 },
      ),
  ),
);
phase("Synthesize");
return await agent(
  `Produce a concise review of ${args.path}. Do not edit or delegate. ` +
    "Distinguish missing reviews from clean reviews. Findings:\n" +
    JSON.stringify(areas.map((area, i) => ({ area, result: findings[i] }))),
  { id: "synthesis", label: "Synthesis" },
);
