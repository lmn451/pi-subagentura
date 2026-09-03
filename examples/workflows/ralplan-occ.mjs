// ralplan-occ — a skill translated into executable workflow code
// Based on oh-my-claudecode's RALPLAN/Plan consensus contract:
// https://github.com/Yeachan-Heo/oh-my-claudecode/blob/main/skills/ralplan/SKILL.md
// The existing generic workflow tool enforces role isolation, ordering, artifact
// checks, and bounded revision. This example adds no RALPLAN-specific host tools.
// Planning agents may write bounded Markdown artifacts only. The workflow never
// edits source, executes a plan, commits, pushes, or treats consensus as consent.
export const meta = {
  name: "ralplan-occ",
  description:
    "Reference skill-to-workflow translation of OCC RALPLAN with verified artifacts, isolated reviews, bounded revision, and pending approval.",
  argumentHint: "<planning request>",
  inputSchema: {
    type: "object",
    required: ["idea"],
    properties: {
      idea: {
        type: "string",
        description: "The implementation problem to plan.",
      },
      deliberate: {
        enum: [true, false, "auto"],
        description: "Enable or auto-detect high-risk planning requirements.",
      },
      requirementsTraceability: {
        type: "boolean",
        description: "Add advisory requirement coverage analysis.",
      },
      maxIterations: {
        type: "integer",
        description: "Consensus rounds, clamped to 1–5.",
      },
      artifactsDir: { type: "string" },
      planName: { type: "string" },
      architectModel: { type: "string" },
      criticModel: { type: "string" },
    },
  },
  phases: [
    { title: "Gate" },
    { title: "Requirements" },
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
const REQUIRED_PLAN_HEADINGS = [
  "RALPLAN-DR",
  "Architecture Decision Record",
  "Task Breakdown",
  "Dependency Graph",
  "Acceptance Criteria",
  "Risk Register",
];
const REQUIRED_FINAL_HEADINGS = [
  ...REQUIRED_PLAN_HEADINGS,
  "Applied Improvements",
];
const HIGH_RISK_TRIGGERS = [
  "auth",
  "security",
  "credential",
  "secret",
  "password",
  "token",
  "migration",
  "schema",
  "database",
  "production",
  "destroy",
  "delete",
  "compliance",
  "pii",
  "gdpr",
  "hipaa",
  "public api",
  "breaking change",
];
const EXECUTION_KEYWORDS = [
  "ralph",
  "autopilot",
  "team",
  "ultrawork",
  "ultrapilot",
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
  const candidate = typeof value === "string" ? value.trim() : ".omc/plans";
  if (!candidate || candidate.includes("\0") || /[\r\n]/.test(candidate)) {
    throw new Error("artifactsDir must be a non-empty single-line path");
  }
  return candidate.replace(/\/+$/, "");
}

function safePlanName(value) {
  const candidate = typeof value === "string" && value ? value : "plan";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate)) {
    throw new Error(
      "planName must start with an alphanumeric and contain only alphanumerics, dot, underscore, or dash (max 64)",
    );
  }
  return candidate;
}

function checkGate(idea) {
  const text = String(idea || "");
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const prefix of ["force:", "!"]) {
    if (lower.startsWith(prefix)) {
      return { gated: false, reason: "escape prefix " + prefix };
    }
  }
  if (words.length > 15) {
    return { gated: false, reason: "word count above threshold" };
  }
  const anchors = [
    /\.\w{1,8}(?:\/\S+)?/,
    /#\d+/,
    /\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/,
    /\b[A-Z][a-zA-Z0-9]{2,}\b/,
    /\b[a-z]+_[a-z_]+\b/,
    /\b(?:npm|pnpm|yarn|vitest|jest|mocha|pytest|go test|cargo)\b/i,
    /```/,
    /\b(?:do:|acceptance criteria:)\b/i,
    /^\s*\d+\.\s/m,
  ];
  if (anchors.some((anchor) => anchor.test(text))) {
    return { gated: false, reason: "concrete anchor present" };
  }
  const matched = EXECUTION_KEYWORDS.filter((keyword) =>
    new RegExp("\\b" + keyword + "\\b").test(lower),
  );
  return {
    gated: true,
    reason: matched.length
      ? "short unanchored prompt contains execution keyword (" +
        matched.join(",") +
        ")"
      : "short prompt has no concrete anchor",
  };
}

function isDeliberate(idea, input) {
  if (input.deliberate === true) return true;
  if (input.deliberate === "auto") {
    const lower = String(idea || "").toLowerCase();
    return HIGH_RISK_TRIGGERS.some((trigger) => lower.includes(trigger));
  }
  return false;
}

function pendingFields() {
  return {
    pending_approval: true,
    execution_halted: true,
    statusLine:
      "Status: pending approval — verified planning artifacts are not execution consent",
    awaitingApproval: {
      draftReview: true,
      finalApproval: true,
      executionRouting: true,
    },
  };
}

function pathSet(artifactsDir, planName, round) {
  const drafts = artifactsDir + "/drafts";
  return {
    draft: drafts + "/" + planName + "_draft-r" + round + ".md",
    architect: drafts + "/architect_review-r" + round + ".md",
    critic: drafts + "/critic_review-r" + round + ".md",
    final: artifactsDir + "/" + planName + ".md",
  };
}

function requiredHeadings(mode, requirementsTraceability, finalPlan = false) {
  const headings = (
    finalPlan ? REQUIRED_FINAL_HEADINGS : REQUIRED_PLAN_HEADINGS
  ).slice();
  if (mode === "DELIBERATE") {
    headings.push("Pre-Mortem", "Expanded Test Plan");
  }
  if (requirementsTraceability) headings.push("Requirement Coverage Map");
  return headings;
}

function analystPrompt(idea) {
  return `You are an advisory requirements Analyst, not a consensus approver.
Atomize the request below into stable requirement IDs. Do not plan, review, edit
source, or authorize execution.

REQUEST:
${idea}

Return only structured JSON with requirements [{id,text}] and openQuestions.`;
}

function plannerPrompt(input) {
  const prior = input.feedback.length
    ? "\n\nPRIOR COMPLETE ROUND FEEDBACK:\n" +
      JSON.stringify(input.feedback, null, 2)
    : "";
  const requirements = input.requirements
    ? "\n\nADVISORY REQUIREMENTS (not approvals):\n" +
      JSON.stringify(input.requirements, null, 2) +
      "\nInclude a Requirement Coverage Map with COVERED, PARTIAL, UNCOVERED, or SCOPED_OUT and rationale."
    : "";
  const deliberate =
    input.mode === "DELIBERATE"
      ? "\nDELIBERATE mode requires exactly 3 actionable pre-mortem scenarios and concrete Unit, Integration, E2E, and Observability test coverage."
      : "";
  return `You are the isolated Planner. Create a bounded Markdown plan artifact;
do not implement, edit source, execute, commit, push, or self-approve.

REQUEST: ${input.idea}
MODE: ${input.mode}
ROUND: ${input.round} of ${input.maxRounds}
WRITE EXACTLY: ${input.path}

The immutable draft must include RALPLAN-DR, an Architecture Decision Record,
3-6 tasks with exact paths and acceptance criteria, a dependency graph, risks,
and open questions.${requirements}${deliberate}${prior}

Do not overwrite an earlier round. Return only {verdict:"DRAFT_READY",path,round,summary}.`;
}

function verifierPrompt(input) {
  return `You are a read-only artifact verifier. Do not write or modify anything.
Inspect the exact claimed Markdown artifact with file/stat/hash tools.

EXPECTED PATH: ${input.path}
EXPECTED KIND: ${input.kind}
EXPECTED ROUND: ${input.round}
MAX BYTES: ${MAX_ARTIFACT_BYTES}
REQUIRED HEADINGS: ${JSON.stringify(input.headings)}
${input.sourceDigest ? "REQUIRED SOURCE DRAFT SHA-256: " + input.sourceDigest : ""}

Reject missing/non-regular files, symbolic links, paths that differ from
EXPECTED PATH, wrong round/kind, empty or oversized files, missing required
headings, malformed Markdown structure, or source-digest mismatch. Compute SHA-256 from file bytes.
Return only {valid,path,round,kind,sizeBytes,sha256,headings,issues}.`;
}

function architectPrompt(input) {
  return `You are the isolated read-only Architect. Review only the immutable
Planner draft below. Do not read a Critic review or edit source.

DRAFT PATH: ${input.draftPath}
EXPECTED DRAFT SHA-256: ${input.draftDigest}
WRITE REVIEW EXACTLY: ${input.reviewPath}
ROUND: ${input.round}
MODE: ${input.mode}

Read the draft, recompute its digest, inspect referenced source read-only, then
write bounded Markdown review evidence. Return explicit APPROVE or
REVISION_NEEDED plus steelman, tradeoff tension, principle violations, the
recomputed draftDigest, and reviewPath. Never infer approval from empty issues.`;
}

function criticPrompt(input) {
  const requirements = input.requirementsTraceability
    ? " Verify requirements coverage and reject unexplained PARTIAL, UNCOVERED, or SCOPED_OUT entries."
    : "";
  return `You are the isolated read-only Critic. Independently review only the
same immutable Planner draft. You receive neither Architect output nor its path.

DRAFT PATH: ${input.draftPath}
EXPECTED DRAFT SHA-256: ${input.draftDigest}
WRITE REVIEW EXACTLY: ${input.reviewPath}
ROUND: ${input.round}
MODE: ${input.mode}

Recompute the draft digest, run gap/feasibility/risk/verification checks, and
write bounded Markdown review evidence.${requirements} Return explicit APPROVE,
ITERATE, or REJECT with findings, draftDigest, reviewPath, and summary.`;
}

function consolidatePrompt(input) {
  return `You are a planning Consolidator. Both independent reviewers explicitly
approved the verified immutable draft. Write Markdown only; never edit source or
start execution.

DRAFT: ${input.draftPath}
DRAFT SHA-256: ${input.draftDigest}
ARCHITECT REVIEW: ${input.architectPath}
CRITIC REVIEW: ${input.criticPath}
WRITE FINAL EXACTLY: ${input.finalPath}
ROUND: ${input.round}

Read both review artifacts. Collect, deduplicate, and categorize their actionable
improvements, apply every accepted improvement to the final plan, and add an
## Applied Improvements changelog (or state explicitly that none were needed).
Preserve RALPLAN-DR, ADR, 3-6 tasks with exact paths, dependency graph,
acceptance criteria, risk register, requirements coverage when present, and
DELIBERATE sections when present. Return only
{verdict:"CONSOLIDATED",path,sourceDraftDigest,summary}.`;
}

const ANALYST_SCHEMA = {
  type: "object",
  required: ["requirements", "openQuestions"],
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};
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
const idea = String(workflowArgs.idea || "");
const interactive = workflowArgs.interactive === true;
const gateEnabled = workflowArgs.gate === true;
const mode = isDeliberate(idea, workflowArgs) ? "DELIBERATE" : "SHORT";
const maxRounds = clampRounds(workflowArgs.maxIterations);
const artifactsDir = safeArtifactsDir(workflowArgs.artifactsDir);
const planName = safePlanName(workflowArgs.planName);
const requirementsTraceability = workflowArgs.requirementsTraceability === true;
const ignoredExecuteOnConsensus = Object.prototype.hasOwnProperty.call(
  workflowArgs,
  "executeOnConsensus",
);

function terminal(status, extra) {
  return {
    status,
    consensus: false,
    mode,
    iterations: 0,
    capped: false,
    artifactPaths: {
      plan: pathSet(artifactsDir, planName, 1).final,
      drafts: [],
      architectReviews: [],
      criticReviews: [],
    },
    interactive: {
      enabled: interactive,
      markersEmitted: interactive,
      blocking: false,
    },
    ...pendingFields(),
    ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
    ...extra,
  };
}

phase("Gate");
if (!idea.trim()) return terminal("no_idea", {});
const gateResult = gateEnabled
  ? checkGate(idea)
  : { gated: false, reason: "gate disabled by caller" };
if (gateResult.gated) {
  if (interactive)
    log("[pending approval] explicit RALPLAN invocation required");
  return terminal("gated", {
    gated: true,
    redirect: "ralplan",
    gate: { enabled: true, triggered: true, reason: gateResult.reason },
  });
}

let analyst = null;
if (requirementsTraceability) {
  phase("Requirements");
  analyst = await callAgent(analystPrompt(idea), {
    schema: ANALYST_SCHEMA,
    label: "analyst",
    phase: "Requirements",
  });
  if (!analyst) {
    return terminal("requirements_analysis_failed", {
      gate: {
        enabled: gateEnabled,
        triggered: false,
        reason: gateResult.reason,
      },
    });
  }
}

if (interactive) {
  log("[pending approval] markers are non-blocking; host approval is required");
}

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
  const paths = pathSet(artifactsDir, planName, round);

  phase("Round " + round + " - Planner");
  const planner = await callAgent(
    plannerPrompt({
      idea,
      mode,
      feedback,
      round,
      maxRounds,
      path: paths.draft,
      requirements: analyst,
    }),
    {
      schema: PLANNER_SCHEMA,
      label: "planner",
      phase: "Round " + round + " - Planner",
    },
  );
  lastDraft = planner;

  phase("Round " + round + " - Verify draft");
  const draftExpected = {
    path: paths.draft,
    round,
    kind: "draft",
    headings: requiredHeadings(mode, requirementsTraceability),
  };
  const draftVerification = await callAgent(verifierPrompt(draftExpected), {
    schema: VERIFIER_SCHEMA,
    label: "verify-draft",
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
  const architectOptions = {
    schema: ARCHITECT_SCHEMA,
    label: "architect",
    phase: "Round " + round + " - Architect",
  };
  if (
    typeof workflowArgs.architectModel === "string" &&
    workflowArgs.architectModel
  ) {
    architectOptions.model = workflowArgs.architectModel;
  }
  const architect = await callAgent(
    architectPrompt({
      draftPath: paths.draft,
      draftDigest: draftVerification.sha256,
      reviewPath: paths.architect,
      round,
      mode,
    }),
    architectOptions,
  );
  lastArchitect = architect;

  phase("Round " + round + " - Critic");
  const criticOptions = {
    schema: CRITIC_SCHEMA,
    label: "critic",
    phase: "Round " + round + " - Critic",
  };
  if (
    typeof workflowArgs.criticModel === "string" &&
    workflowArgs.criticModel
  ) {
    criticOptions.model = workflowArgs.criticModel;
  }
  const critic = await callAgent(
    criticPrompt({
      draftPath: paths.draft,
      draftDigest: draftVerification.sha256,
      reviewPath: paths.critic,
      round,
      mode,
      requirementsTraceability,
    }),
    criticOptions,
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
      label: "verify-architect",
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
      label: "verify-critic",
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
  plan: pathSet(artifactsDir, planName, Math.max(lastRound, 1)).final,
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
    gate: { enabled: gateEnabled, triggered: false, reason: gateResult.reason },
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
    cappedReason:
      lastRound >= maxRounds
        ? "five-round safety cap reached; manual review required and execution unavailable"
        : undefined,
    gate: { enabled: gateEnabled, triggered: false, reason: gateResult.reason },
  });
}

phase("Consolidate");
const finalPath = artifactPaths.plan;
const consolidated = await callAgent(
  consolidatePrompt({
    draftPath: lastDraft.path,
    draftDigest: lastDraftVerification.sha256,
    architectPath: lastArchitect.reviewPath,
    criticPath: lastCritic.reviewPath,
    finalPath,
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
  path: finalPath,
  round: lastRound,
  kind: "final-plan",
  headings: requiredHeadings(mode, requirementsTraceability, true),
  sourceDigest: lastDraftVerification.sha256,
};
const finalVerification = await callAgent(verifierPrompt(finalExpected), {
  schema: VERIFIER_SCHEMA,
  label: "verify-final",
  phase: "Verify final plan",
});
if (
  !consolidated ||
  consolidated.path !== finalPath ||
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
    gate: { enabled: gateEnabled, triggered: false, reason: gateResult.reason },
  });
}

return {
  status: "pending_approval",
  consensus: true,
  mode,
  iterations: lastRound,
  capped: false,
  draft: lastDraft,
  architect: lastArchitect,
  critic: lastCritic,
  analyst,
  artifactPaths,
  planDigest: finalVerification.sha256,
  sourceDraftDigest: lastDraftVerification.sha256,
  artifactVerification: finalVerification,
  gate: { enabled: gateEnabled, triggered: false, reason: gateResult.reason },
  interactive: {
    enabled: interactive,
    markersEmitted: interactive,
    blocking: false,
  },
  ...pendingFields(),
  ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
};
