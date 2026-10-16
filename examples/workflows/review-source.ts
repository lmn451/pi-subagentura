import { defineWorkflow, schema } from "pi-subagentura/workflow";
import type { InferWorkflowSchema, TaskResult } from "pi-subagentura/workflow";

const ASPECT_IDS = [
  "intent-design",
  "compatibility",
  "behavior-change",
  "correctness-quality",
] as const;

const ASPECTS = [
  {
    id: ASPECT_IDS[0],
    title: "Intent and design alignment",
    focus:
      "Check whether the implementation matches the stated intent and design, including whether the chosen approach solves the requested problem without drifting from it.",
  },
  {
    id: ASPECT_IDS[1],
    title: "Compatibility",
    focus:
      "Check public APIs, persisted data, configuration, protocol behavior, and supported runtime compatibility for breaking changes.",
  },
  {
    id: ASPECT_IDS[2],
    title: "Unintended behavior changes",
    focus:
      "Look for side effects or behavior changes outside the intended scope, including regressions in existing callers and workflows.",
  },
  {
    id: ASPECT_IDS[3],
    title: "Correctness and quality",
    focus:
      "Check correctness, edge cases, error handling, and maintainability in the changed code.",
  },
] as const;

const Aspect = schema.enum(ASPECT_IDS);
const Verdict = schema.enum([
  "pass",
  "concern",
  "blocking",
  "uncertain",
] as const);
const Severity = schema.enum(["critical", "high", "medium", "low"] as const);

const Input = schema.object({
  files: schema.array(schema.string(), { minItems: 1, maxItems: 40 }),
  intendedChange: schema.string(),
});

const FindingFields = {
  severity: Severity,
  location: schema.string(),
  evidence: schema.string(),
  explanation: schema.string(),
};

const Finding = schema.object(FindingFields);

const AspectReview = schema.object({
  verdict: Verdict,
  findings: schema.array(Finding, { maxItems: 15 }),
});

const ReviewOutcome = schema.object({
  aspect: Aspect,
  outcome: schema.enum(["completed", "failed"] as const),
  verdict: Verdict,
  failure: schema.optional(
    schema.object({
      name: schema.string(),
      message: schema.string(),
    }),
  ),
});

const AggregateFinding = schema.object({
  aspect: Aspect,
  ...FindingFields,
});

const SeverityCounts = schema.object({
  critical: schema.integer(),
  high: schema.integer(),
  medium: schema.integer(),
  low: schema.integer(),
});

const Review = schema.object({
  status: Verdict,
  reviews: schema.array(ReviewOutcome, { minItems: 4, maxItems: 4 }),
  findings: schema.array(AggregateFinding, { maxItems: 60 }),
  severityCounts: SeverityCounts,
  artifactId: schema.optional(schema.string()),
});

type AspectId = InferWorkflowSchema<typeof Aspect>;
type SeverityValue = InferWorkflowSchema<typeof Severity>;
type AspectReviewValue = InferWorkflowSchema<typeof AspectReview>;
type ReviewTaskResult = TaskResult<AspectReviewValue>;
type AggregateFindingValue = InferWorkflowSchema<typeof AggregateFinding>;
type ReviewOutcomeValue = InferWorkflowSchema<typeof ReviewOutcome>;
type ReviewReport = InferWorkflowSchema<typeof Review>;
type ReviewStatus = ReviewReport["status"];

const ASPECT_ORDER: Record<AspectId, number> = {
  [ASPECT_IDS[0]]: 0,
  [ASPECT_IDS[1]]: 1,
  [ASPECT_IDS[2]]: 2,
  [ASPECT_IDS[3]]: 3,
};

const severityOrder: Record<SeverityValue, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function requireBoundedText(
  value: string,
  label: string,
  maximum: number,
): void {
  if (value.trim().length === 0 || value.length > maximum) {
    throw new Error(
      `${label} must be non-empty and at most ${maximum} characters.`,
    );
  }
}

function validateInput(args: {
  files: readonly string[];
  intendedChange: string;
}): void {
  requireBoundedText(args.intendedChange, "intendedChange", 12_000);
  let totalFileChars = 0;
  for (const file of args.files) {
    requireBoundedText(file, "file path", 512);
    totalFileChars += file.length;
  }
  if (totalFileChars > 8_192) {
    throw new Error("Combined file paths must be at most 8192 characters.");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregate(results: readonly ReviewTaskResult[]): ReviewReport {
  if (!Array.isArray(results) || results.length !== ASPECTS.length) {
    throw new Error(
      "Aspect review collection did not return all four results.",
    );
  }
  const reviews: ReviewOutcomeValue[] = [];
  const findings: AggregateFindingValue[] = [];
  for (let index = 0; index < results.length; index++) {
    const aspectAtIndex = ASPECTS[index];
    if (!aspectAtIndex) {
      throw new Error(
        "Review result count did not match the requested aspects.",
      );
    }
    const aspect = aspectAtIndex.id;
    const result = results[index];
    if (!result.ok) {
      reviews.push({
        aspect,
        outcome: "failed",
        verdict: "uncertain",
        failure: {
          name: result.error.name || "ReviewError",
          message: String(
            result.error.message || "Review did not complete.",
          ).slice(0, 1_200),
        },
      });
      continue;
    }

    const review = result.value;
    reviews.push({
      aspect,
      outcome: "completed",
      verdict: review.verdict,
    });
    for (const finding of review.findings) {
      findings.push({ aspect, ...finding });
    }
  }

  findings.sort((left, right) => {
    let order = severityOrder[left.severity] - severityOrder[right.severity];
    if (order !== 0) return order;
    order = ASPECT_ORDER[left.aspect] - ASPECT_ORDER[right.aspect];
    if (order !== 0) return order;
    order = compareText(left.location, right.location);
    if (order !== 0) return order;
    order = compareText(left.evidence, right.evidence);
    if (order !== 0) return order;
    return compareText(left.explanation, right.explanation);
  });

  const severityCounts: Record<SeverityValue, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let blocking = false;
  let uncertain = false;
  let concern = findings.length > 0;
  for (const finding of findings) {
    severityCounts[finding.severity] =
      (severityCounts[finding.severity] ?? 0) + 1;
    if (finding.severity === "critical" || finding.severity === "high") {
      blocking = true;
    }
  }
  for (const review of reviews) {
    if (review.verdict === "blocking") blocking = true;
    if (review.outcome === "failed" || review.verdict === "uncertain") {
      uncertain = true;
    }
    if (review.verdict === "concern") concern = true;
  }

  const status: ReviewStatus = blocking
    ? "blocking"
    : uncertain
      ? "uncertain"
      : concern
        ? "concern"
        : "pass";
  return { status, reviews, findings, severityCounts };
}

export default defineWorkflow({
  name: "review-source",
  version: 1,
  description:
    "Independently review bounded source inputs across four aspects and aggregate evidence-backed findings.",
  input: Input,
  output: Review,
  async run(ctx, args) {
    validateInput(args);
    let fileList = "";
    for (const file of args.files) {
      fileList += `${fileList ? "\n" : ""}- ${file}`;
    }

    const collected = await ctx.map(
      ASPECTS,
      async (aspect) => {
        const review = await ctx.agent(`review-${aspect.id}`, {
          title: aspect.title,
          prompt:
            `Review the requested files against the intended change/design. Focus on ${aspect.title}.\n\n` +
            `${aspect.focus}\n\n` +
            `Files:\n${fileList}\n\n` +
            `Intended change/design:\n${args.intendedChange}\n\n` +
            "Do not edit files. Return at most 15 concrete findings. Each finding must include " +
            "severity (critical, high, medium, or low), a precise location, direct evidence from " +
            "the source, and an explanation of the impact. Use an empty findings array when no " +
            "material issue is found. Use uncertain when the available evidence is insufficient; " +
            "do not invent evidence. Return JSON matching the supplied schema.",
          output: AspectReview,
        });
        for (const finding of review.findings) {
          requireBoundedText(finding.location, "finding location", 512);
          requireBoundedText(finding.evidence, "finding evidence", 1_200);
          requireBoundedText(finding.explanation, "finding explanation", 1_200);
        }
        return review;
      },
      {
        stepId: "review-aspects",
        title: "Review source aspects",
        concurrency: 4,
        failure: "collect",
      },
    );

    const report = await ctx.group(
      "aggregate",
      "Aggregate review",
      async () => {
        const result = aggregate(collected);
        await ctx.checkpoint("review-report", result);
        return result;
      },
    );

    const save = await ctx.ask("save-review", {
      type: "confirm",
      question: "Save this completed review report as a workflow artifact?",
      defaultValue: true,
    });
    if (!save) return report;

    const artifact = await ctx.artifact.write("review", report);
    return { ...report, artifactId: artifact.id };
  },
});
