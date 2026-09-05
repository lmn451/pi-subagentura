// ralplan-consensus — compact compatibility RALPLAN workflow
// The OCC example is canonical. This SHORT-only example shares its safety
// contract: isolated roles, fixed-snapshot independent review, bounded rounds,
// and planning-only pending results.
export const meta = {
  name: "ralplan-consensus",
  description:
    "Compact SHORT-only RALPLAN protocol example. Planner, Architect, and Critic independently review one fixed snapshot for up to five rounds; every result remains pending approval and execution-halted.",
  phases: [
    { title: "Ralplan consensus" },
    { title: "Round N - Planner" },
    { title: "Round N - Architect" },
    { title: "Round N - Critic" },
    { title: "Consolidate" },
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
const idea = typeof workflowArgs.idea === "string" ? workflowArgs.idea : "";
const maxIterations = clampRounds(workflowArgs.maxIterations);
const artifactsDir =
  typeof workflowArgs.artifactsDir === "string" && workflowArgs.artifactsDir
    ? workflowArgs.artifactsDir
    : "plans";
const requestedDeliberate =
  workflowArgs.deliberate === true || workflowArgs.deliberate === "auto";
const ignoredExecuteOnConsensus = Object.prototype.hasOwnProperty.call(
  workflowArgs,
  "executeOnConsensus",
);

const PLANNER_PERSONA = `You are the isolated Planner. Produce a SHORT RALPLAN-DR
work-plan draft only; never implement, execute, commit, push, or self-approve.
Return JSON with verdict DRAFT_READY and a draft snapshot containing principles,
decisionDrivers, options, planBody, acceptance criteria, and openQuestions.`;
const ARCHITECT_PERSONA = `You are the isolated, read-only Architect. Independently
review the fixed Planner snapshot in this prompt. Provide a steelman antithesis,
a real tradeoff tension, and any issues. Return one explicit verdict: APPROVE or
REVISION_NEEDED. Never infer approval from an empty issue list.`;
const CRITIC_PERSONA = `You are the isolated, read-only Critic. Independently review
only the fixed Planner snapshot in this prompt. Do not use another reviewer's
output. Check alternatives, risks, acceptance criteria, verification, and gaps.
Return one explicit verdict: APPROVE, ITERATE, or REJECT. Missing evidence is
non-approval.`;

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

function plannerSnapshot(output) {
  if (!output || typeof output !== "object") return null;
  if (output.draft && typeof output.draft === "object") {
    const draft = clone(output.draft);
    return Object.keys(draft).length > 0 ? draft : null;
  }
  const snapshot = clone(output);
  delete snapshot.verdict;
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function buildPlannerPrompt(round, feedback) {
  const prior = feedback.length
    ? "\n\nPRIOR ROUND REVIEWS — address both after this complete round:\n" +
      JSON.stringify(feedback, null, 2)
    : "";
  return (
    PLANNER_PERSONA +
    "\n\nTASK (round " +
    round +
    " of " +
    maxIterations +
    ")\n" +
    idea +
    prior +
    '\nReturn ONLY {verdict:"DRAFT_READY", draft:{...}, path?:string}.'
  );
}

function buildArchitectPrompt(snapshot) {
  return (
    ARCHITECT_PERSONA +
    "\n\nFIXED PLANNER SNAPSHOT (read-only):\n" +
    JSON.stringify(snapshot, null, 2) +
    "\nReturn ONLY {verdict, steelman, tradeoffTension, principleViolations, summary}."
  );
}

function buildCriticPrompt(snapshot) {
  return (
    CRITIC_PERSONA +
    "\n\nFIXED PLANNER SNAPSHOT (read-only; same value reviewed by Architect):\n" +
    JSON.stringify(snapshot, null, 2) +
    "\nReturn ONLY {verdict, findings, summary}."
  );
}

function buildConsolidatePrompt(snapshot, architect, critic) {
  return `You are a read-only planning Consolidator. Both independent reviewers
already settled. Write only a cleaned Markdown plan if the host provides a
writer, preserving the Planner snapshot and its RALPLAN-DR/ADR evidence. This
step never authorizes execution.\n\nSNAPSHOT:\n${JSON.stringify(snapshot, null, 2)}\n\nARCHITECT RESULT:\n${JSON.stringify(architect, null, 2)}\n\nCRITIC RESULT:\n${JSON.stringify(critic, null, 2)}\n\nReturn {verdict:"CONSOLIDATED", path:string, summary:string} only.`;
}

const plannerResultSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["DRAFT_READY"] },
    draft: { type: "object" },
    path: { type: "string" },
    principles: { type: "array" },
    decisionDrivers: { type: "array" },
    options: { type: "array" },
    planBody: { type: "string" },
    openQuestions: { type: "array" },
  },
};
const architectVerdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "REVISION_NEEDED"] },
    issues: { type: "array", items: { type: "string" } },
    principleViolations: { type: "array", items: { type: "string" } },
    steelman: { type: "string" },
    tradeoffTension: { type: "string" },
    summary: { type: "string" },
  },
};
const criticVerdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "ITERATE", "REJECT"] },
    gaps: { type: "array", items: { type: "string" } },
    findings: { type: "array" },
    selfAudit: { type: "string" },
    summary: { type: "string" },
  },
};
const consolidateResultSchema = {
  type: "object",
  required: ["verdict", "path"],
  properties: {
    verdict: { type: "string", enum: ["CONSOLIDATED"] },
    path: { type: "string" },
    summary: { type: "string" },
  },
};

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

function baseResult(extra) {
  return {
    consensus: false,
    mode: "SHORT",
    iterations: 0,
    capped: false,
    deliberate: {
      supported: false,
      requested: requestedDeliberate,
      note: "Use ralplan-occ for DELIBERATE-mode pre-mortem and expanded test-plan gates.",
    },
    ...(ignoredExecuteOnConsensus ? { executeOnConsensusIgnored: true } : {}),
    ...pendingFields(),
    ...extra,
  };
}

phase("Ralplan consensus");
if (!idea.trim()) {
  return baseResult({
    status: "no_idea",
    summary: "args.idea is required (string)",
  });
}

const feedback = [];
let lastDraft = null;
let lastArchitect = null;
let lastCritic = null;
let lastDraftPath = null;
let lastRoundReached = 0;
let consensusReached = false;
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

for (let round = 1; round <= maxIterations; round++) {
  lastRoundReached = round;
  log("Round " + round + "/" + maxIterations);

  phase("Round " + round + " - Planner");
  const plannerOut = await callAgent(buildPlannerPrompt(round, feedback), {
    schema: plannerResultSchema,
    phase: "Round " + round + " - Planner",
    label: "planner-" + round,
  });
  const snapshot = plannerSnapshot(plannerOut);
  if (!snapshot) {
    plannerError =
      "Planner produced no schema-valid snapshot on round " + round;
    feedback.push({
      round,
      role: "planner",
      verdict: "MISSING",
      summary: plannerError,
    });
    continue;
  }
  lastDraft = snapshot;
  lastDraftPath = plannerOut.path || lastDraftPath;
  const immutableSnapshot = freezeDeep(clone(snapshot));

  phase("Round " + round + " - Architect");
  const architectOut = await callAgent(
    buildArchitectPrompt(immutableSnapshot),
    {
      schema: architectVerdictSchema,
      label: "architect-" + round,
      phase: "Round " + round + " - Architect",
    },
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
        issues: architectOut.issues || architectOut.principleViolations || [],
        summary: architectOut.summary || "",
      }
    : {
        round,
        role: "architect",
        verdict: "MISSING",
        summary: "Architect returned no schema-valid result",
      };

  // Critic is mandatory even when Architect rejects. It receives the fixed
  // snapshot only, so the two reviews cannot become a simulated handoff.
  phase("Round " + round + " - Critic");
  const criticOut = await callAgent(buildCriticPrompt(immutableSnapshot), {
    schema: criticVerdictSchema,
    label: "critic-" + round,
    phase: "Round " + round + " - Critic",
  });
  lastCritic = criticOut;
  const criticApproval = Boolean(criticOut && criticOut.verdict === "APPROVE");
  const criticFeedback = criticOut
    ? {
        round,
        role: "critic",
        verdict: criticOut.verdict,
        gaps: criticOut.gaps || [],
        findings: criticOut.findings || [],
        summary: criticOut.summary || "",
      }
    : {
        round,
        role: "critic",
        verdict: "MISSING",
        summary: "Critic returned no schema-valid result",
      };

  if (architectApproval && criticApproval) {
    consensusReached = true;
    break;
  }
  feedback.push(architectFeedback, criticFeedback);
}

const capped = !consensusReached && lastRoundReached >= maxIterations;
let consolidatedPath = null;
let consolidateSummary = null;
if (consensusReached && lastDraft) {
  phase("Consolidate");
  const consolidated = await callAgent(
    buildConsolidatePrompt(lastDraft, lastArchitect, lastCritic),
    {
      schema: consolidateResultSchema,
      label: "consolidate",
      phase: "Consolidate",
    },
  );
  if (
    consolidated &&
    typeof consolidated.path === "string" &&
    consolidated.path
  ) {
    consolidatedPath = consolidated.path;
    consolidateSummary = consolidated.summary || null;
  } else {
    consolidatedPath = lastDraftPath || artifactsDir + "/plan.md";
    consolidateSummary =
      "Consensus reached; no consolidated artifact path was returned, so the fixed draft remains the result.";
  }
}

const result = baseResult({
  consensus: consensusReached,
  status: consensusReached
    ? "consensus"
    : lastDraft
      ? "no_consensus"
      : "no_planner_output",
  iterations: lastRoundReached,
  capped,
  draft: lastDraft || {},
  architect: lastArchitect || { verdict: "MISSING" },
  critic: lastCritic || { verdict: "MISSING" },
  planPath: consensusReached ? consolidatedPath : undefined,
  draftPath: lastDraftPath || undefined,
  ...(consolidateSummary ? { consolidateSummary } : {}),
});
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
    result.summary =
      "No consensus after the five-round cap; manual review required and execution unavailable.";
}
return result;
