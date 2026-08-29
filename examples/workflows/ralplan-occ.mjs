// ralplan-occ — canonical OCC-facing RALPLAN workflow
// Planner, Architect, and Critic are isolated role invocations. This workflow
// produces planning evidence only; it never executes, commits, or mutates code.
export const meta = {
  name: "ralplan-occ",
  description:
    "Canonical OCC RALPLAN consensus: isolated Planner/Architect/Critic review of one fixed snapshot, bounded to five rounds, always pending approval and execution-halted.",
  phases: [
    { title: "Gate" },
    { title: "Ralplan consensus" },
    { title: "Round N - Planner" },
    { title: "Round N - Architect" },
    { title: "Round N - Critic" },
  ],
};

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
      return {};
    }
  }
  return {};
}

const workflowArgs = parseWorkflowArgs(args);
const PLANNER_PERSONA = `You are the isolated Planner in a RALPLAN workflow.
Create or revise a plan; never implement code, execute a skill, commit, push, or
approve your own work. Return structured JSON only. Include RALPLAN-DR:
3-5 principles, exactly 3 decision drivers, at least 2 viable options with
bounded pros/cons, and an actionable 3-6 step plan with acceptance criteria.
The host workflow, not the Planner, owns approval and execution routing.`;
const ARCHITECT_PERSONA = `You are the isolated Architect, a read-only technical
reviewer. Review only the Planner snapshot supplied in this prompt. You are not
the Planner or Critic, and you must not implement changes. Independently state
the strongest steelman antithesis, a meaningful tradeoff tension, and explicit
architectural principle violations. Approval is never inferred from an empty
violations list: return exactly one explicit verdict, APPROVE or REVISION_NEEDED.`;
const CRITIC_PERSONA = `You are the isolated Critic and final quality gate. Review
only the fixed Planner snapshot supplied in this prompt, independently of every
other review. You do not receive or rely on Architect output. Check alternatives,
risk mitigation, acceptance criteria, verification, gaps, and deliberate-mode
requirements. Return exactly one explicit verdict: APPROVE, ITERATE, or REJECT.
Missing, invalid, or uncertain evidence is non-approval.`;

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

function checkGate(idea) {
  const text = String(idea || "");
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean);
  for (const prefix of ["force:", "!"]) {
    if (lower.startsWith(prefix))
      return { gated: false, reason: "escape prefix " + prefix };
  }
  if (words.length > 15)
    return { gated: false, reason: "word count above threshold" };
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
    /\b(?:TypeError|ReferenceError|SyntaxError|ENOENT|EACCES)\b/,
  ];
  for (const anchor of anchors) {
    if (anchor.test(text))
      return { gated: false, reason: "concrete anchor present" };
  }
  const matched = EXECUTION_KEYWORDS.filter((keyword) =>
    new RegExp("\\b" + keyword + "\\b").test(lower),
  );
  const reason = matched.length
    ? "prompt has " +
      words.length +
      " words and execution keyword (" +
      matched.join(",") +
      ")"
    : "prompt has " + words.length + " words and no concrete anchors";
  return { gated: true, reason };
}

function isDeliberate(idea, input) {
  if (input.deliberate === true) return true;
  if (input.deliberate === "auto") {
    const lower = String(idea || "").toLowerCase();
    return HIGH_RISK_TRIGGERS.some((trigger) => lower.includes(trigger));
  }
  return false;
}

function clampRounds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.min(Math.max(Math.floor(numeric), 1), 5);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function deliberateValidation(draft, mode) {
  if (mode !== "DELIBERATE") return { valid: true, issues: [] };
  const issues = [];
  const scenarios = draft && draft.preMortem;
  if (!Array.isArray(scenarios) || scenarios.length !== 3) {
    issues.push("preMortem must contain exactly 3 scenarios");
  } else {
    const fields = [
      "trigger",
      "blastRadius",
      "earlySignal",
      "mitigation",
      "detection",
    ];
    scenarios.forEach((scenario, index) => {
      for (const field of fields) {
        if (!scenario || !nonEmpty(scenario[field]))
          issues.push("preMortem[" + index + "]." + field + " is required");
      }
    });
  }
  const testPlan = draft && draft.expandedTestPlan;
  for (const pillar of ["unit", "integration", "e2e", "observability"]) {
    if (
      !testPlan ||
      !Array.isArray(testPlan[pillar]) ||
      testPlan[pillar].length === 0 ||
      testPlan[pillar].some((item) => !nonEmpty(item))
    ) {
      issues.push(
        "expandedTestPlan." + pillar + " must contain actionable entries",
      );
    }
  }
  return { valid: issues.length === 0, issues };
}

function plannerSnapshot(output) {
  if (!output || typeof output !== "object") return null;
  if (output.draft && typeof output.draft === "object") {
    const draft = clone(output.draft);
    return Object.keys(draft).length > 0 ? draft : null;
  }
  const draft = clone(output);
  delete draft.verdict;
  return Object.keys(draft).length > 0 ? draft : null;
}

function buildPlannerPrompt(idea, mode, feedback, round, maxRounds) {
  const prior = feedback.length
    ? "\n\nPRIOR ROUND REVIEWS (address both independently):\n" +
      JSON.stringify(feedback, null, 2)
    : "";
  const deliberate =
    mode === "DELIBERATE"
      ? "\nDELIBERATE HARD REQUIREMENTS: preMortem must have exactly 3 actionable scenarios with trigger, blastRadius, earlySignal, mitigation, detection. expandedTestPlan must contain non-empty unit, integration, e2e, and observability arrays."
      : "";
  return (
    PLANNER_PERSONA +
    "\n\nTASK\nIdea: " +
    idea +
    "\nMode: " +
    mode +
    "\nRound: " +
    round +
    " of " +
    maxRounds +
    prior +
    deliberate +
    '\nReturn JSON {verdict:"DRAFT_READY", draft:{principles, decisionDrivers, options, planBody, openQuestions, ...}} only.'
  );
}

function buildArchitectPrompt(snapshot, mode) {
  const deliberate =
    mode === "DELIBERATE"
      ? "\nIn DELIBERATE mode, treat missing or weak preMortem/test-plan fields as explicit principle violations."
      : "";
  return (
    ARCHITECT_PERSONA +
    "\n\nFIXED PLANNER SNAPSHOT (read-only; do not alter):\n" +
    JSON.stringify(snapshot, null, 2) +
    deliberate +
    "\nReturn JSON {verdict, steelman, tradeoffTension, synthesis, principleViolations, summary} only."
  );
}

function buildCriticPrompt(snapshot, mode) {
  const deliberate =
    mode === "DELIBERATE"
      ? "\nDELIBERATE HARD GATES: reject missing/weak preMortem or any missing unit, integration, e2e, or observability test pillar."
      : "";
  return (
    CRITIC_PERSONA +
    "\n\nFIXED PLANNER SNAPSHOT (read-only; same value reviewed by Architect):\n" +
    JSON.stringify(snapshot, null, 2) +
    deliberate +
    "\nReturn JSON {verdict, findings, summary, preMortemStatus, testPlanStatus} only."
  );
}

const PLANNER_SCHEMA = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["DRAFT_READY"] },
    draft: { type: "object" },
    principles: { type: "array", items: { type: "string" } },
    decisionDrivers: { type: "array", items: { type: "string" } },
    options: { type: "array" },
    planBody: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
  },
};
const ARCHITECT_SCHEMA = {
  type: "object",
  required: ["verdict", "steelman", "tradeoffTension", "principleViolations"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REVISION_NEEDED"] },
    steelman: { type: "string" },
    tradeoffTension: { type: "string" },
    synthesis: { type: "string" },
    principleViolations: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};
const CRITIC_SCHEMA = {
  type: "object",
  required: ["verdict", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "ITERATE", "REJECT"] },
    findings: { type: "array" },
    summary: { type: "string" },
    preMortemStatus: { type: "string" },
    testPlanStatus: { type: "string" },
  },
};

const idea = String(workflowArgs.idea || "");
const interactive = workflowArgs.interactive !== false;
const gateEnabled = workflowArgs.gate !== false;
const mode = isDeliberate(idea, workflowArgs) ? "DELIBERATE" : "SHORT";
const maxRounds = clampRounds(workflowArgs.maxIterations);
const ignoredExecuteOnConsensus = Object.prototype.hasOwnProperty.call(
  workflowArgs,
  "executeOnConsensus",
);

function pendingFields() {
  return {
    pending_approval: true,
    execution_halted: true,
    statusLine:
      "Status: pending approval — workflow is read-only and halted before execution",
    awaitingApproval: {
      draftReview: true,
      finalApproval: true,
      executionRouting: true,
    },
  };
}

function emitCheckpoint(message) {
  if (interactive) log("[pending approval] " + message);
}

function emptyResult(status, extra) {
  return {
    status,
    consensus: false,
    algorithm: "ralplan-occ-v1",
    mode,
    iterations: 0,
    capped: false,
    gate: {
      enabled: gateEnabled,
      triggered: false,
      reason: "gate bypassed or passed",
    },
    interactive: { enabled: interactive, markersEmitted: interactive },
    ...pendingFields(),
    ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
    ...extra,
  };
}

phase("Gate");
if (!idea.trim()) {
  log("no idea provided; planning cannot proceed");
  return emptyResult("no_idea", {
    gate: {
      enabled: gateEnabled,
      triggered: false,
      reason: "idea is required",
    },
  });
}
const gateResult = gateEnabled
  ? checkGate(idea)
  : { gated: false, reason: "gate disabled by caller" };
if (gateResult.gated) {
  emitCheckpoint(
    "gate requires explicit planning invocation: " + gateResult.reason,
  );
  return emptyResult("gated", {
    gated: true,
    redirect: "ralplan",
    gate: { enabled: true, triggered: true, reason: gateResult.reason },
    mode: "SHORT",
    interactive: { enabled: interactive, markersEmitted: interactive },
    statusLine:
      "Status: pending approval — gate redirected to explicit RALPLAN invocation",
  });
}

phase("Ralplan consensus");
if (interactive) {
  emitCheckpoint("draft review checkpoint is non-blocking in the workflow VM");
  emitCheckpoint("final approval and execution routing belong to the host");
}
log(
  "mode=" +
    mode +
    "; maxRounds=" +
    maxRounds +
    "; gate=" +
    (gateEnabled ? "enabled" : "disabled"),
);

const feedback = [];
let lastDraft = null;
let lastArchitect = null;
let lastCritic = null;
let lastRoundReached = 0;
let consensusReached = false;
let deliberateResult = { valid: mode !== "DELIBERATE", issues: [] };
let plannerError = null;

async function callAgent(prompt, options) {
  try {
    return await agent(prompt, { ...options, isolation: "process" });
  } catch (error) {
    if (/aborted|cancelled|canceled/i.test(String(error))) throw error;
    log(options.label + " failed: " + String(error));
    return null;
  }
}

for (let round = 1; round <= maxRounds; round++) {
  lastRoundReached = round;
  phase("Round " + round + " - Planner");
  const plannerOut = await callAgent(
    buildPlannerPrompt(idea, mode, feedback, round, maxRounds),
    {
      schema: PLANNER_SCHEMA,
      phase: "Round " + round + " - Planner",
      label: "planner",
    },
  );
  const snapshot = plannerSnapshot(plannerOut);
  if (!snapshot) {
    plannerError =
      "Planner returned no schema-valid snapshot on round " + round;
    feedback.push({
      round,
      role: "planner",
      verdict: "MISSING",
      summary: plannerError,
    });
    continue;
  }
  lastDraft = snapshot;
  deliberateResult = deliberateValidation(snapshot, mode);

  phase("Round " + round + " - Architect");
  const architectOptions = {
    schema: ARCHITECT_SCHEMA,
    phase: "Round " + round + " - Architect",
    label: "architect",
  };
  if (
    typeof workflowArgs.architectModel === "string" &&
    workflowArgs.architectModel
  ) {
    architectOptions.model = workflowArgs.architectModel;
  }
  const immutableSnapshot = freezeDeep(clone(snapshot));
  const architectOut = await callAgent(
    buildArchitectPrompt(immutableSnapshot, mode),
    architectOptions,
  );
  lastArchitect = architectOut;
  const architectApproval = Boolean(
    architectOut && architectOut.verdict === "APPROVE",
  );
  const architectFeedback = architectOut
    ? {
        round,
        role: "architect",
        verdict: architectOut.verdict,
        summary: architectOut.summary || "",
        issues: architectOut.principleViolations || [],
      }
    : {
        round,
        role: "architect",
        verdict: "MISSING",
        summary: "Architect returned no schema-valid result",
      };

  phase("Round " + round + " - Critic");
  const criticOptions = {
    schema: CRITIC_SCHEMA,
    phase: "Round " + round + " - Critic",
    label: "critic",
  };
  if (
    typeof workflowArgs.criticModel === "string" &&
    workflowArgs.criticModel
  ) {
    criticOptions.model = workflowArgs.criticModel;
  }
  // Deliberately pass only the immutable Planner snapshot. Architect output is
  // recorded for the next Planner, never used as Critic input.
  const criticOut = await callAgent(
    buildCriticPrompt(immutableSnapshot, mode),
    criticOptions,
  );
  lastCritic = criticOut;
  const criticApproval = Boolean(criticOut && criticOut.verdict === "APPROVE");
  const criticFeedback = criticOut
    ? {
        round,
        role: "critic",
        verdict: criticOut.verdict,
        summary: criticOut.summary || "",
        findings: criticOut.findings || [],
      }
    : {
        round,
        role: "critic",
        verdict: "MISSING",
        summary: "Critic returned no schema-valid result",
      };

  if (architectApproval && criticApproval && deliberateResult.valid) {
    consensusReached = true;
    log("explicit Architect and Critic approval reached on round " + round);
    break;
  }
  feedback.push(architectFeedback, criticFeedback);
  if (round < maxRounds)
    log("non-approval; starting complete Planner → Architect → Critic round");
}

const capped = !consensusReached && lastRoundReached >= maxRounds;
const status = consensusReached
  ? "consensus"
  : lastDraft
    ? "no_consensus"
    : "no_planner_output";
const result = {
  status,
  consensus: consensusReached,
  algorithm: "ralplan-occ-v1",
  mode,
  iterations: lastRoundReached,
  capped,
  gate: { enabled: gateEnabled, triggered: false, reason: gateResult.reason },
  interactive: { enabled: interactive, markersEmitted: interactive },
  draft: lastDraft || {},
  architect: lastArchitect || { verdict: "MISSING", principleViolations: [] },
  critic: lastCritic || { verdict: "MISSING", findings: [] },
  deliberate: deliberateResult,
  artifactPaths: {
    plan:
      (workflowArgs.artifactsDir || ".omc/plans") +
      "/" +
      (workflowArgs.planName || "ralplan") +
      ".md",
    drafts: [],
  },
  ...pendingFields(),
  ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
  fidelityGaps: {
    interactiveCheckpointsUnsupported: true,
    hostApprovalRequired: true,
    note: "interactive markers are non-blocking; the workflow VM cannot suspend for user input or invoke execution skills",
  },
};
if (plannerError) result.plannerError = plannerError;
if (!consensusReached) {
  result.lastVerdict = {
    architect:
      lastArchitect && lastArchitect.verdict
        ? lastArchitect.verdict
        : "MISSING",
    critic: lastCritic && lastCritic.verdict ? lastCritic.verdict : "MISSING",
  };
  if (capped)
    result.cappedReason =
      "five-round safety cap reached; manual review required and execution unavailable";
}
return result;
