// ralplan-consensus — compact SHORT-only compatibility workflow.
// ralplan-occ.mjs is canonical. This example shares the verified immutable
// artifact, independent-review, bounded-loop, and pending-approval contracts.
export const meta = {
  name: "ralplan-consensus",
  description:
    "Compact SHORT-only RALPLAN with verified immutable Markdown artifacts, independent same-draft review, five-round cap, and pending host approval.",
  phases: [
    { title: "Ralplan consensus" },
    { title: "Round N - Planner" },
    { title: "Round N - Verify draft" },
    { title: "Round N - Architect" },
    { title: "Round N - Critic" },
    { title: "Round N - Verify reviews" },
    { title: "Consolidate" },
    { title: "Verify final plan" },
  ],
};

const MAX_ARTIFACT_BYTES = 1_000_000;
const PLAN_HEADINGS = [
  "RALPLAN-DR",
  "Architecture Decision Record",
  "Task Breakdown",
  "Dependency Graph",
  "Acceptance Criteria",
  "Risk Register",
];

function parseWorkflowArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return { idea: raw };
    }
  }
  return {};
}

function clampRounds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.min(Math.max(Math.floor(numeric), 1), 5);
}

function safeArtifactsDir(value) {
  const candidate = typeof value === "string" ? value.trim() : "plans";
  if (!candidate || candidate.includes("\0") || /[\r\n]/.test(candidate)) {
    throw new Error("artifactsDir must be a non-empty single-line path");
  }
  return candidate.replace(/\/+$/, "");
}

function safePlanName(value) {
  const candidate = typeof value === "string" && value ? value : "plan";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate)) {
    throw new Error("planName contains unsafe characters");
  }
  return candidate;
}

function pathsFor(artifactsDir, planName, round) {
  const drafts = artifactsDir + "/drafts";
  return {
    draft: drafts + "/" + planName + "_draft-r" + round + ".md",
    architect: drafts + "/architect_review-r" + round + ".md",
    critic: drafts + "/critic_review-r" + round + ".md",
    final: artifactsDir + "/" + planName + ".md",
  };
}

function pendingFields() {
  return {
    pending_approval: true,
    execution_halted: true,
    statusLine:
      "Status: pending approval — verified planning artifacts are not execution consent",
  };
}

function plannerPrompt(input) {
  const prior = input.feedback.length
    ? "\n\nPRIOR COMPLETE ROUND FEEDBACK:\n" +
      JSON.stringify(input.feedback, null, 2)
    : "";
  return `You are the isolated Planner. Write a bounded SHORT-mode RALPLAN
Markdown draft only; never edit source, execute, commit, push, or self-approve.

REQUEST: ${input.idea}
ROUND: ${input.round} of ${input.maxRounds}
WRITE EXACTLY: ${input.path}

Include RALPLAN-DR, ADR, 3-6 tasks with exact paths and acceptance criteria,
dependency graph, risk register, and open questions.${prior}
Do not overwrite prior rounds. Return only
{verdict:"DRAFT_READY",path,round,summary}.`;
}

function verifierPrompt(input) {
  return `You are a read-only artifact verifier. Inspect but never modify the
exact Markdown artifact using file/stat/hash tools.

EXPECTED PATH: ${input.path}
EXPECTED KIND: ${input.kind}
EXPECTED ROUND: ${input.round}
MAX BYTES: ${MAX_ARTIFACT_BYTES}
REQUIRED HEADINGS: ${JSON.stringify(input.headings)}
${input.sourceDigest ? "REQUIRED SOURCE DRAFT SHA-256: " + input.sourceDigest : ""}

Reject missing/non-regular, symbolic-link, empty, oversized, malformed,
wrong-path, wrong-round, wrong-kind, missing-heading, or source-digest mismatch
artifacts. Compute SHA-256
from bytes. Return only
{valid,path,round,kind,sizeBytes,sha256,headings,issues}.`;
}

function architectPrompt(input) {
  return `You are the isolated read-only Architect. Review only this immutable
Planner artifact; do not read Critic output or edit source.

DRAFT PATH: ${input.draftPath}
EXPECTED DRAFT SHA-256: ${input.draftDigest}
WRITE REVIEW EXACTLY: ${input.reviewPath}
ROUND: ${input.round}

Recompute the digest, inspect referenced source, write bounded Markdown review,
and return explicit APPROVE or REVISION_NEEDED with draftDigest, reviewPath,
steelman, tradeoffTension, principleViolations, and summary.`;
}

function criticPrompt(input) {
  return `You are the isolated read-only Critic. Independently review only the
same immutable Planner artifact. You receive neither Architect output nor path.

DRAFT PATH: ${input.draftPath}
EXPECTED DRAFT SHA-256: ${input.draftDigest}
WRITE REVIEW EXACTLY: ${input.reviewPath}
ROUND: ${input.round}

Recompute the digest, perform gap/risk/feasibility/verification checks, write a
bounded Markdown review, and return explicit APPROVE, ITERATE, or REJECT with
draftDigest, reviewPath, findings, and summary.`;
}

function consolidatePrompt(input) {
  return `You are a planning Consolidator. Both independent reviewers approved.
Write Markdown only and never start implementation.

DRAFT: ${input.draftPath}
DRAFT SHA-256: ${input.draftDigest}
ARCHITECT REVIEW: ${input.architectPath}
CRITIC REVIEW: ${input.criticPath}
WRITE FINAL EXACTLY: ${input.finalPath}
ROUND: ${input.round}

Preserve all required plan sections. Return only
{verdict:"CONSOLIDATED",path,sourceDraftDigest,summary}.`;
}

const PLANNER_SCHEMA = {
  type: "object",
  required: ["verdict", "path", "round", "summary"],
  properties: {
    verdict: { type: "string", enum: ["DRAFT_READY"] },
    path: { type: "string" },
    round: { type: "integer" },
    summary: { type: "string" },
  },
};
const VERIFIER_SCHEMA = {
  type: "object",
  required: [
    "valid",
    "path",
    "round",
    "kind",
    "sizeBytes",
    "sha256",
    "headings",
    "issues",
  ],
  properties: {
    valid: { type: "boolean" },
    path: { type: "string" },
    round: { type: "integer" },
    kind: { type: "string" },
    sizeBytes: { type: "integer" },
    sha256: { type: "string" },
    headings: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
  },
};
const ARCHITECT_SCHEMA = {
  type: "object",
  required: [
    "verdict",
    "draftDigest",
    "reviewPath",
    "steelman",
    "tradeoffTension",
    "principleViolations",
    "summary",
  ],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REVISION_NEEDED"] },
    draftDigest: { type: "string" },
    reviewPath: { type: "string" },
    steelman: { type: "string" },
    tradeoffTension: { type: "string" },
    principleViolations: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};
const CRITIC_SCHEMA = {
  type: "object",
  required: ["verdict", "draftDigest", "reviewPath", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "ITERATE", "REJECT"] },
    draftDigest: { type: "string" },
    reviewPath: { type: "string" },
    findings: { type: "array" },
    summary: { type: "string" },
  },
};
const CONSOLIDATE_SCHEMA = {
  type: "object",
  required: ["verdict", "path", "sourceDraftDigest", "summary"],
  properties: {
    verdict: { type: "string", enum: ["CONSOLIDATED"] },
    path: { type: "string" },
    sourceDraftDigest: { type: "string" },
    summary: { type: "string" },
  },
};

function artifactValid(report, expected) {
  return Boolean(
    report &&
    report.valid === true &&
    report.path === expected.path &&
    report.round === expected.round &&
    report.kind === expected.kind &&
    Number.isInteger(report.sizeBytes) &&
    report.sizeBytes > 0 &&
    report.sizeBytes <= MAX_ARTIFACT_BYTES &&
    typeof report.sha256 === "string" &&
    report.sha256.length > 0 &&
    Array.isArray(report.issues) &&
    report.issues.length === 0 &&
    expected.headings.every((heading) => report.headings.includes(heading)),
  );
}

async function callAgent(prompt, options) {
  try {
    return await agent(prompt, { ...options, isolation: "process" });
  } catch (error) {
    if (/aborted|cancelled|canceled/i.test(String(error))) throw error;
    log(options.label + " failed: " + String(error));
    return null;
  }
}

const workflowArgs = parseWorkflowArgs(args);
const idea = typeof workflowArgs.idea === "string" ? workflowArgs.idea : "";
const maxRounds = clampRounds(workflowArgs.maxIterations);
const artifactsDir = safeArtifactsDir(workflowArgs.artifactsDir);
const planName = safePlanName(workflowArgs.planName);
const ignoredExecuteOnConsensus = Object.prototype.hasOwnProperty.call(
  workflowArgs,
  "executeOnConsensus",
);

function terminal(status, extra) {
  return {
    status,
    consensus: false,
    mode: "SHORT",
    iterations: 0,
    capped: false,
    artifactPaths: {
      plan: pathsFor(artifactsDir, planName, 1).final,
      drafts: [],
      architectReviews: [],
      criticReviews: [],
    },
    ...pendingFields(),
    ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
    ...extra,
  };
}

phase("Ralplan consensus");
if (!idea.trim()) return terminal("no_idea", {});

const feedback = [];
const drafts = [];
const architectReviews = [];
const criticReviews = [];
let lastDraft = null;
let lastDraftVerification = null;
let lastArchitect = null;
let lastCritic = null;
let lastRound = 0;
let reviewConsensus = false;
let artifactFailure = null;
const artifactFailures = [];

for (let round = 1; round <= maxRounds; round++) {
  lastRound = round;
  artifactFailure = null;
  const paths = pathsFor(artifactsDir, planName, round);

  phase("Round " + round + " - Planner");
  const planner = await callAgent(
    plannerPrompt({
      idea,
      round,
      maxRounds,
      path: paths.draft,
      feedback,
    }),
    {
      schema: PLANNER_SCHEMA,
      label: "planner-" + round,
      phase: "Round " + round + " - Planner",
    },
  );
  lastDraft = planner;

  phase("Round " + round + " - Verify draft");
  const draftExpected = {
    path: paths.draft,
    round,
    kind: "draft",
    headings: PLAN_HEADINGS,
  };
  const draftVerification = await callAgent(verifierPrompt(draftExpected), {
    schema: VERIFIER_SCHEMA,
    label: "verify-draft-" + round,
    phase: "Round " + round + " - Verify draft",
  });
  lastDraftVerification = draftVerification;
  if (
    !planner ||
    planner.path !== paths.draft ||
    planner.round !== round ||
    !artifactValid(draftVerification, draftExpected)
  ) {
    artifactFailure = {
      stage: "draft",
      round,
      expectedPath: paths.draft,
      claimedPath: planner && planner.path,
      verification: draftVerification,
    };
    artifactFailures.push(artifactFailure);
    feedback.push({
      round,
      role: "artifact-verifier",
      verdict: "INVALID",
      summary: "Draft artifact validation failed",
      issues: (draftVerification && draftVerification.issues) || [],
    });
    continue;
  }
  drafts.push(paths.draft);

  phase("Round " + round + " - Architect");
  const architect = await callAgent(
    architectPrompt({
      draftPath: paths.draft,
      draftDigest: draftVerification.sha256,
      reviewPath: paths.architect,
      round,
    }),
    {
      schema: ARCHITECT_SCHEMA,
      label: "architect-" + round,
      phase: "Round " + round + " - Architect",
    },
  );
  lastArchitect = architect;

  phase("Round " + round + " - Critic");
  const critic = await callAgent(
    criticPrompt({
      draftPath: paths.draft,
      draftDigest: draftVerification.sha256,
      reviewPath: paths.critic,
      round,
    }),
    {
      schema: CRITIC_SCHEMA,
      label: "critic-" + round,
      phase: "Round " + round + " - Critic",
    },
  );
  lastCritic = critic;

  phase("Round " + round + " - Verify reviews");
  const architectExpected = {
    path: paths.architect,
    round,
    kind: "architect-review",
    headings: [],
  };
  const architectVerification = await callAgent(
    verifierPrompt({
      ...architectExpected,
      sourceDigest: draftVerification.sha256,
    }),
    {
      schema: VERIFIER_SCHEMA,
      label: "verify-architect-" + round,
      phase: "Round " + round + " - Verify reviews",
    },
  );
  const criticExpected = {
    path: paths.critic,
    round,
    kind: "critic-review",
    headings: [],
  };
  const criticVerification = await callAgent(
    verifierPrompt({
      ...criticExpected,
      sourceDigest: draftVerification.sha256,
    }),
    {
      schema: VERIFIER_SCHEMA,
      label: "verify-critic-" + round,
      phase: "Round " + round + " - Verify reviews",
    },
  );

  if (
    !architect ||
    !critic ||
    architect.reviewPath !== paths.architect ||
    critic.reviewPath !== paths.critic ||
    architect.draftDigest !== draftVerification.sha256 ||
    critic.draftDigest !== draftVerification.sha256 ||
    !artifactValid(architectVerification, architectExpected) ||
    !artifactValid(criticVerification, criticExpected)
  ) {
    artifactFailure = {
      stage: "reviews",
      round,
      architectVerification,
      criticVerification,
    };
    artifactFailures.push(artifactFailure);
    feedback.push(
      {
        round,
        role: "architect",
        verdict: architect ? architect.verdict : "MISSING",
        summary: architect ? architect.summary : "Architect output missing",
      },
      {
        round,
        role: "critic",
        verdict: critic ? critic.verdict : "MISSING",
        summary: critic ? critic.summary : "Critic output missing",
      },
    );
    continue;
  }
  architectReviews.push(paths.architect);
  criticReviews.push(paths.critic);

  if (architect.verdict === "APPROVE" && critic.verdict === "APPROVE") {
    reviewConsensus = true;
    break;
  }
  feedback.push(
    {
      round,
      role: "architect",
      verdict: architect.verdict,
      summary: architect.summary,
      issues: architect.principleViolations,
    },
    {
      round,
      role: "critic",
      verdict: critic.verdict,
      summary: critic.summary,
      findings: critic.findings,
    },
  );
}

const artifactPaths = {
  plan: pathsFor(artifactsDir, planName, Math.max(lastRound, 1)).final,
  drafts,
  architectReviews,
  criticReviews,
};
if (artifactFailure) {
  return terminal("artifact_validation_failed", {
    iterations: lastRound,
    capped: lastRound >= maxRounds,
    artifactPaths,
    artifactFailure,
    artifactFailures,
  });
}
if (!reviewConsensus || !lastDraft || !lastDraftVerification) {
  return terminal("no_consensus", {
    iterations: lastRound,
    capped: lastRound >= maxRounds,
    artifactPaths,
    draft: lastDraft,
    architect: lastArchitect || { verdict: "MISSING" },
    critic: lastCritic || { verdict: "MISSING" },
    summary:
      lastRound >= maxRounds
        ? "No consensus after the five-round cap; manual review required and execution unavailable."
        : "Consensus not reached; execution unavailable.",
  });
}

phase("Consolidate");
const consolidated = await callAgent(
  consolidatePrompt({
    draftPath: lastDraft.path,
    draftDigest: lastDraftVerification.sha256,
    architectPath: lastArchitect.reviewPath,
    criticPath: lastCritic.reviewPath,
    finalPath: artifactPaths.plan,
    round: lastRound,
  }),
  {
    schema: CONSOLIDATE_SCHEMA,
    label: "consolidate",
    phase: "Consolidate",
  },
);

phase("Verify final plan");
const finalExpected = {
  path: artifactPaths.plan,
  round: lastRound,
  kind: "final-plan",
  headings: PLAN_HEADINGS,
  sourceDigest: lastDraftVerification.sha256,
};
const finalVerification = await callAgent(verifierPrompt(finalExpected), {
  schema: VERIFIER_SCHEMA,
  label: "verify-final",
  phase: "Verify final plan",
});
if (
  !consolidated ||
  consolidated.path !== artifactPaths.plan ||
  consolidated.sourceDraftDigest !== lastDraftVerification.sha256 ||
  !artifactValid(finalVerification, finalExpected)
) {
  return terminal("artifact_validation_failed", {
    iterations: lastRound,
    artifactPaths,
    artifactFailure: {
      stage: "final",
      round: lastRound,
      verification: finalVerification,
    },
  });
}

return {
  status: "pending_approval",
  consensus: true,
  mode: "SHORT",
  iterations: lastRound,
  capped: false,
  draft: lastDraft,
  architect: lastArchitect,
  critic: lastCritic,
  artifactPaths,
  planPath: artifactPaths.plan,
  planDigest: finalVerification.sha256,
  sourceDraftDigest: lastDraftVerification.sha256,
  artifactVerification: finalVerification,
  ...pendingFields(),
  ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
};
