// Workflow: code-review a PR with 3 parallel interactive sub-agents
//
// Spawns three tmux/zellij-backed sub-agents (isolation: "process" — real
// process isolation, attachable panes), each with a focused review persona
// and a JSON-Schema-validated structured output. The aggregator phase
// merges the three reports into a single markdown review.
//
// Expected args:
//   {
//     diff: string,        // full unified diff (caller runs `git diff`)
//     fileStats: string,   // `git diff --stat` output
//     prTitle?: string,
//     prBody?: string,
//     changedFiles?: string[]   // optional, for the design reviewer
//   }
//
// Output:
//   { markdown: string, totals: { blocker, major, minor, nit } }

export const meta = {
  name: "pr-review-interactive",
  description:
    "Code-review a PR with 3 parallel interactive (tmux/zellij) sub-agents: correctness, tests, design",
  phases: [
    { title: "Gather context" },
    { title: "Review in parallel" },
    { title: "Aggregate report" },
  ],
};

// ── Shared finding schema (all three reviewers return this shape) ──────────
// Hand-rolled JSON Schema subset (matches the workflow tool's validateSchema).
// severity: "blocker" must-fix, "major" should-fix, "minor" nice-to-have, "nit" cosmetic.
const findingSchema = {
  type: "object",
  required: ["severity", "file", "summary", "detail"],
  additionalProperties: false,
  properties: {
    severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
    file: {
      type: "string",
      description: "Repo-relative path, or '(general)' for cross-cutting",
    },
    line: {
      type: "string",
      description: 'Line or line range, e.g. "123" or "123-128"',
    },
    summary: { type: "string" },
    detail: { type: "string" },
  },
};

const reviewReportSchema = {
  type: "object",
  required: ["angle", "findings", "summary"],
  additionalProperties: false,
  properties: {
    angle: { type: "string", enum: ["correctness", "tests", "design"] },
    findings: { type: "array", items: findingSchema },
    summary: {
      type: "string",
      description: "1-3 sentence overall verdict for this angle",
    },
  },
};

phase("Gather context");

const diff = args.diff || "";
const fileStats = args.fileStats || "";
const prTitle = args.prTitle || "(untitled PR)";
const prBody = args.prBody || "";
const changedFiles = args.changedFiles || [];

if (!diff) {
  throw new Error(
    "pr-review-interactive: args.diff is required (the unified diff).",
  );
}

const contextBlock = [
  `PR title: ${prTitle}`,
  prBody ? `\nPR description:\n${prBody}\n` : "",
  `\nFile stats:\n${fileStats}\n`,
  `\nChanged files: ${changedFiles.length ? changedFiles.join(", ") : "(see diff)"}`,
  `\nUnified diff:\n\`\`\`diff\n${diff}\n\`\`\``,
].join("");

phase("Review in parallel");

// Each sub-agent runs in its own tmux/zellij pane (real isolation, attachable).
// The user can `tmux attach` to watch any of them live. If the multiplexer is
// unavailable, the workflow falls back to in-process sub-agents.
const personas = {
  correctness:
    "You are a senior TypeScript reviewer focused on CORRECTNESS. Look hard for: bugs, race conditions, " +
    "TOCTOU between state files (events.ndjson, state.json, output.md), unhandled errors or silent `catch {}`, " +
    "Temporal Dead Zone (const/let used before declaration in a branch that returns early), misuse of the " +
    "events.ndjson cursor (advance eventByteCursor using complete NDJSON line offsets; timestamps are display-only), schemaVersion " +
    "validation gaps, JSON.parse on untrusted input without try/catch, file system races (rename vs append), " +
    "and any violation of the protocol invariants documented in src/subagent.ts. " +
    "Output JSON matching the schema. Be specific: file path and line number for every finding.",
  tests:
    "You are a TEST-COVERAGE reviewer for a vitest codebase. Tests live in `tests/` as `*.test.ts`. " +
    "For every behavior change in the diff, check whether a test exercises it. Flag: (1) untested new code " +
    "paths, (2) missing edge cases (empty files, partial writes, concurrent writers, missing files, " +
    "corrupt JSON), (3) tests that only exercise the happy path, (4) tests that don't actually assert " +
    "the behavior they claim to, (5) regressions in the existing test files (`tests/*.test.ts`) " +
    "that might mask a behavior break. " +
    "Output JSON matching the schema.",
  design:
    "You are a senior software architect reviewing for DESIGN and CONVENTIONS. The project guidelines " +
    "live in AGENTS.md. Specifically check: (1) Code Organization — are all variables declared BEFORE " +
    "conditional blocks that may return early (TDZ safety), (2) Safety — no hardcoded secrets, explicit " +
    "error handling (no silent failures), (3) Git — conventional commit style, one concern per commit, " +
    "(4) Code Style — two-space indentation, double quotes, semicolons, trailing commas, ~80-char lines, (5) Workflow " +
    "— minimal changes (no unrelated refactors), (6) Comments only for non-obvious logic / protocol " +
    "invariants. Read AGENTS.md before reviewing. " +
    "Output JSON matching the schema.",
};

const labels = {
  correctness: "review/correctness",
  tests: "review/tests",
  design: "review/design",
};

const prompts = {
  correctness: `Review the following PR diff for correctness, bugs, race conditions, and protocol invariants. Read the relevant source files in full before commenting. Cite file + line for every finding.\n\n${contextBlock}`,
  tests: `Review the following PR diff for test coverage. For every behavior change, find the test that exercises it (or note its absence). Pay special attention to edge cases and the existing test files in src/.\n\n${contextBlock}`,
  design: `Review the following PR diff for compliance with the project's AGENTS.md guidelines. Read AGENTS.md first, then audit the diff line-by-line. Cite the AGENTS.md section you reference for every finding.\n\n${contextBlock}`,
};

const [correctness, tests, design] = await parallel([
  () =>
    agent(prompts.correctness, {
      isolation: "process",
      persona: personas.correctness,
      schema: reviewReportSchema,
      label: labels.correctness,
      phase: "Review in parallel",
    }),
  () =>
    agent(prompts.tests, {
      isolation: "process",
      persona: personas.tests,
      schema: reviewReportSchema,
      label: labels.tests,
      phase: "Review in parallel",
    }),
  () =>
    agent(prompts.design, {
      isolation: "process",
      persona: personas.design,
      schema: reviewReportSchema,
      label: labels.design,
      phase: "Review in parallel",
    }),
]);

phase("Aggregate report");

const reports = [correctness, tests, design].filter(Boolean);

if (reports.length === 0) {
  return {
    markdown:
      "## PR review\n\nAll three reviewers failed to produce a report. Re-run individually to diagnose.",
    totals: { blocker: 0, major: 0, minor: 0, nit: 0 },
  };
}

const totals = { blocker: 0, major: 0, minor: 0, nit: 0 };
for (const r of reports) {
  for (const f of r.findings || []) {
    if (totals[f.severity] != null) totals[f.severity]++;
  }
}

const angleTitle = {
  correctness: "🐛 Correctness, bugs, and protocol invariants",
  tests: "🧪 Test coverage and edge cases",
  design: "🏛️ Design and AGENTS.md compliance",
};

const severityEmoji = { blocker: "🚫", major: "⚠️", minor: "💡", nit: "✏️" };

const lines = [];
lines.push(`# PR review: ${prTitle}`);
lines.push("");
lines.push(`**File stats:** \`${fileStats.replace(/\n/g, " ").trim()}\``);
lines.push(
  `**Total findings:** ${totals.blocker} blocker · ${totals.major} major · ${totals.minor} minor · ${totals.nit} nit`,
);
lines.push("");
lines.push(
  "**Reviewers:** 3 parallel interactive sub-agents (tmux/zellij panes). Use `tmux attach -t <session>` to watch any of them live.",
);
lines.push("");

// Verdict section: lead with blockers, then majors
const allFindings = [];
for (const r of reports) {
  for (const f of r.findings || []) {
    allFindings.push({ ...f, angle: r.angle });
  }
}
const order = { blocker: 0, major: 1, minor: 2, nit: 3 };
allFindings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

if (allFindings.length > 0) {
  lines.push("## Findings (sorted by severity)");
  lines.push("");
  for (const f of allFindings) {
    const loc = f.line ? `:${f.line}` : "";
    lines.push(
      `### ${severityEmoji[f.severity]} [${f.severity}] \`${f.file}${loc}\` — ${f.summary}`,
    );
    lines.push(`*Reviewer: ${f.angle}*`);
    lines.push("");
    lines.push(f.detail);
    lines.push("");
  }
} else {
  lines.push("## Findings");
  lines.push("");
  lines.push("_No findings across any reviewer._ LGTM.");
  lines.push("");
}

// Per-angle summaries
lines.push("## Per-angle summaries");
lines.push("");
for (const r of reports) {
  lines.push(`### ${angleTitle[r.angle] || r.angle}`);
  lines.push("");
  lines.push(r.summary);
  lines.push("");
}

lines.push("---");
lines.push(
  `_Generated by \`pr-review-interactive\` workflow (3 parallel agents, isolation: process)._`,
);

return {
  markdown: lines.join("\n"),
  totals,
  findings: allFindings,
};
