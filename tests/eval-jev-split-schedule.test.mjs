import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/eval-jev-split.mjs", import.meta.url),
);
const datasets = [
  ["pilot", "pilot"],
  ["fresh", "refined"],
];

test("counterbalances each label group with paired requests and no extras", () => {
  let totalRequests = 0;

  for (const [dataset, comparisonVariant] of datasets) {
    const result = JSON.parse(
      execFileSync("bun", [script, "--dry-run", dataset], { encoding: "utf8" }),
    );
    const { cases, schedule, variants, maxRequests } = result;
    totalRequests += schedule.length;

    assert.deepEqual(variants, ["current", comparisonVariant], dataset);
    assert.equal(schedule.length, cases.length * variants.length, dataset);
    assert.equal(maxRequests, schedule.length, `${dataset} request cap`);

    for (const [index, [label, task]] of cases.entries()) {
      const pair = schedule.filter((request) => request.case === index + 1);
      const labelIndex = cases
        .slice(0, index)
        .filter(([priorLabel]) => priorLabel === label).length;
      const labelCount = cases.filter(
        ([caseLabel]) => caseLabel === label,
      ).length;
      assert.deepEqual(
        pair.map(({ variant }) => variant),
        labelIndex < labelCount / 2 ? variants : [...variants].reverse(),
        `${dataset} case ${index + 1} order`,
      );
      assert.ok(pair.every((request) => request.label === label));
      assert.ok(pair.every((request) => request.task === task));
    }

    for (const label of ["none", "split"]) {
      const firstVariants = cases
        .map((_, index) =>
          schedule.find((request) => request.case === index + 1),
        )
        .filter((request) => request.label === label)
        .map((request) => request.variant);
      assert.equal(
        firstVariants.filter((variant) => variant === "current").length,
        3,
        `${dataset} ${label}: current first exactly three times`,
      );
      assert.equal(
        firstVariants.filter((variant) => variant !== "current").length,
        3,
        `${dataset} ${label}: comparison first exactly three times`,
      );
    }
  }

  assert.equal(totalRequests, 48, "12 paired requests per dataset; no extras");
});
