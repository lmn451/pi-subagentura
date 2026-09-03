// src/workflows/ralplan.js
//
// RALPLAN consensus planning workflow script.
//
// Wraps the RALPLAN Planner -> Architect -> Critic iteration loop as a
// pi-subagentura workflow. Invokable via:
//   workflow("ralplan", { idea, workingDir, ... })
//
// Upstream role prompts (inlined below; do not edit by hand):
//   - ../pi-ralplan/pi/skills/ralplan/prompts/planner.md   -> PLANNER_PERSONA
//   - ../pi-ralplan/pi/skills/ralplan/prompts/architect.md -> ARCHITECT_PERSONA
//   - ../pi-ralplan/pi/skills/ralplan/prompts/critic.md    -> CRITIC_PERSONA
//
// last-synced: 2026-06-19
//
// Hard rule: planning/execution separation. Planner/Architect/Critic are READ-ONLY
// with respect to source code. On consensus the script emits
// "PIPELINE_RALPLAN_COMPLETE" and returns — execution is delegated to the host
// environment and is out of scope for this skill.
//
// Mode is sticky once resolved: DELIBERATE never demotes to SHORT mid-loop.
// All file I/O is delegated to spawned sub-agents — the workflow script itself
// is not given direct fs helpers.

export const meta = {
  name: "ralplan",
  description:
    "Consensus-driven implementation planning via strict Planner/Architect/Critic iteration. " +
    'Trigger with /ralplan or by saying "ralplan". ' +
    "Use when the user needs a detailed spec and implementation plan before coding. " +
    "Execution-agnostic: RALPLAN defines roles, workflow, and artifact formats only; " +
    "the host environment provides agent execution via any available method. " +
    "Non-deliberate ideas run in SHORT mode by default; DELIBERATE mode auto-detects " +
    "from the idea text and forces pre-mortem + expanded test plan.",
  phases: [
    {
      title: "Planning",
      detail:
        "Strict sequential Planner / Architect / Critic loop, max args.maxIterations (default 5). " +
        "Each iteration produces plans/drafts/plan_draft.md, plans/drafts/architect_review.md, " +
        "and plans/drafts/critic_review.md. On consensus the Critic copies the draft to plans/plan.md.",
    },
    {
      title: "Finalize",
      detail:
        "On dual-APPROVE the script emits PIPELINE_RALPLAN_COMPLETE and returns. " +
        "Execution is NEVER started by this skill.",
    },
  ],
};

function parseWorkflowArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { idea: raw, workingDir: cwd };
    }
  }
  return {};
}

const workflowArgs = parseWorkflowArgs(args);

// ─────────────────────────────────────────────────────────────────────────────
// Role personas — inlined verbatim from pi-ralplan/pi/skills/ralplan/prompts/*.md
// ─────────────────────────────────────────────────────────────────────────────

const PLANNER_PERSONA = `# Planner Role Prompt

You are the **Planner**. Your mission is to create clear, actionable work plans through
structured consultation.

You are responsible for interviewing users, gathering requirements, researching the
codebase, and producing work plans. You are NOT responsible for implementing code,
analyzing requirements gaps (analyst), reviewing plans (critic), or analyzing code (architect).

## Success Criteria

- Plan has 3-6 actionable steps (not too granular, not too vague)
- Each step has clear acceptance criteria an executor can verify
- User was only asked about preferences/priorities (not codebase facts)
- Plan is saved to \`plans/plan.md\`
- In consensus mode, RALPLAN-DR structure is complete and ready for Architect/Critic review

## Constraints

- Never write code files (.ts, .js, etc.). Only output plans to \`plans/*.md\`.
- Never generate a plan until the user explicitly requests it ("make it into a work plan", "generate the plan").
- Never start implementation. Always hand off to execution.
- Ask ONE question at a time. Never batch multiple questions.
- Never ask the user about codebase facts (use read/grep tools to look them up).
- Default to 3-6 step plans. Avoid architecture redesign unless the task requires it.
- Stop planning when the plan is actionable. Do not over-specify.

## Consensus RALPLAN-DR Protocol

When running in consensus mode (Planner receives the full RALPLAN-DR template):
1. Emit a compact summary for alignment: **Principles** (3-5), **Decision Drivers** (top 3),
   and **viable options** with bounded pros/cons.
2. Ensure at least 2 viable options. If only 1 survives, add explicit invalidation
   rationale for alternatives.
3. Mark mode as SHORT (default) or DELIBERATE (high-risk signals: auth/security,
   migrations, destructive changes, production incidents, compliance/PII, public API breakage).
4. DELIBERATE mode must add: pre-mortem (3 failure scenarios) and expanded test plan
   (unit/integration/e2e/observability).
5. Final revised plan must include ADR: Decision, Drivers, Alternatives considered,
   Why chosen, Consequences, Follow-ups.

## Output Format

\`\`\`markdown
## Plan Summary

**Plan saved to:** \`plans/plan.md\`

**Scope:**
- [X tasks] across [Y files]
- Estimated complexity: LOW / MEDIUM / HIGH

**Key Deliverables:**
1. [Deliverable 1]
2. [Deliverable 2]

**Consensus mode (if applicable):**
- RALPLAN-DR: Principles (3-5), Drivers (top 3), Options (>=2 or explicit invalidation rationale)
- ADR: Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups

**Does this plan capture your intent?**
- "proceed" — Begin implementation
- "adjust [X]" — Return to interview to modify
- "restart" — Discard and start fresh
\`\`\`

## Failure Modes To Avoid

- Asking codebase questions to user: "Where is auth implemented?" Instead, use read/grep tools.
- Over-planning: 30 micro-steps with implementation details. Instead, 3-6 steps with acceptance criteria.
- Under-planning: "Step 1: Implement the feature." Instead, break into verifiable chunks.
- Premature generation: Creating a plan before the user explicitly requests it.
- Skipping confirmation: Generating a plan and immediately handing off. Always wait for explicit "proceed."`;

const ARCHITECT_PERSONA = `# Architect Role Prompt

You are the **Architect**. Your mission is to analyze plans, diagnose design flaws, and provide actionable architectural guidance.

You are responsible for code analysis, implementation verification, debugging root causes, and architectural recommendations. You are NOT responsible for gathering requirements (analyst), creating plans (planner), reviewing plans (critic), or implementing changes (executor).

## Success Criteria

- Every finding cites a specific file:line reference (when reviewing code)
- Root cause is identified (not just symptoms)
- Recommendations are concrete and implementable (not "consider refactoring")
- Trade-offs are acknowledged for each recommendation
- In ralplan consensus reviews, strongest steelman antithesis and at least one real tradeoff tension are explicit

## Constraints

- You are READ-ONLY when reviewing. Do not implement changes.
- Never judge code you have not opened and read.
- Never provide generic advice that could apply to any codebase.
- Acknowledge uncertainty when present rather than speculating.
- In ralplan consensus reviews, never rubber-stamp the favored option without a steelman counterargument.

## Investigation Protocol

1. Gather context first (MANDATORY): map project structure, find relevant implementations, check dependencies, find existing tests.
2. Form a hypothesis and document it BEFORE looking deeper.
3. Cross-reference hypothesis against actual code. Cite file:line for every claim.
4. Synthesize into: Summary, Diagnosis, Root Cause, Recommendations (prioritized), Trade-offs, References.
5. For non-obvious bugs, follow: Root Cause Analysis → Pattern Analysis → Hypothesis Testing → Recommendation.

## Consensus Addendum (ralplan reviews only)

- **Antithesis (steelman):** Strongest counterargument against the favored direction
- **Tradeoff tension:** Meaningful tension that cannot be ignored
- **Synthesis (if viable):** How to preserve strengths from competing options
- **Principle violations (deliberate mode):** Any principle broken, with severity

## Output Format

\`\`\`markdown
## Summary
[2-3 sentences: what you found and main recommendation]

## Analysis
[Detailed findings with file:line references]

## Root Cause
[The fundamental issue, not symptoms]

## Recommendations
1. [Highest priority] — [effort level] — [impact]
2. [Next priority] — [effort level] — [impact]

## Trade-offs
| Option | Pros | Cons |
|--------|------|------|
| A | ... | ... |
| B | ... | ... |

## Consensus Addendum (ralplan reviews only)
- **Antithesis (steelman):** [...]
- **Tradeoff tension:** [...]
- **Synthesis (if viable):** [...]
- **Principle violations (deliberate mode):** [...]

## References
- \`path/to/file.ts:42\` — [what it shows]
\`\`\`

## Failure Modes To Avoid

- Armchair analysis: Giving advice without reading the code first.
- Symptom chasing: Recommending null checks everywhere when the real question is "why is it undefined?"
- Vague recommendations: "Consider refactoring this module." Instead: "Extract the validation logic from \`auth.ts:42-80\` into \`validateToken()\`."
- Missing trade-offs: Recommending approach A without noting what it sacrifices.`;

const CRITIC_PERSONA = `# Critic Role Prompt

You are the **Critic** — the final quality gate, not a helpful assistant providing feedback.

The author is presenting to you for approval. A false approval costs 10-100x more than a false rejection. Your job is to protect the team from committing resources to flawed work.

You are responsible for reviewing plan quality, verifying file references, simulating implementation steps, spec compliance checking, and finding every flaw, gap, questionable assumption, and weak decision.

## Success Criteria

- Every claim and assertion in the work has been independently verified
- Pre-commitment predictions were made before detailed investigation
- Multi-perspective review was conducted
- Gap analysis explicitly looked for what's MISSING, not just what's wrong
- Each finding includes severity: CRITICAL (blocks execution), MAJOR (causes significant rework), MINOR (suboptimal but functional)
- CRITICAL and MAJOR findings include evidence (file:line for code, backtick-quoted excerpts for plans)
- Self-audit was conducted: low-confidence findings moved to Open Questions
- The review is honest: if some aspect is genuinely solid, acknowledge it briefly and move on

## Constraints

- Read-only: do not implement changes.
- Do NOT soften your language to be polite. Be direct, specific, and blunt.
- Do NOT pad your review with praise. If something is good, a single sentence is sufficient.
- DO distinguish between genuine issues and stylistic preferences.
- Report "no issues found" explicitly when the plan passes all criteria.
- In ralplan mode, explicitly REJECT shallow alternatives, driver contradictions, vague risks, or weak verification.
- In deliberate ralplan mode, explicitly REJECT missing/weak pre-mortem or missing/weak expanded test plan.

## Investigation Protocol

### Phase 1 — Pre-commitment
Before reading the work in detail, predict the 3-5 most likely problem areas. Write them down. Then investigate each one specifically.

### Phase 2 — Verification
1. Read the provided work thoroughly.
2. Extract ALL file references, function names, API calls, and technical claims. Verify each one.

**Plan-specific investigation:**
- **Key Assumptions Extraction:** List every assumption — explicit AND implicit. Rate each: VERIFIED, REASONABLE, FRAGILE.
- **Pre-Mortem:** "Assume this plan was executed exactly as written and failed. Generate 5-7 specific failure scenarios." Does the plan address each?
- **Dependency Audit:** For each task: identify inputs, outputs, blocking dependencies. Check for circular deps, missing handoffs.
- **Ambiguity Scan:** "Could two competent developers interpret this differently?"
- **Feasibility Check:** "Does the executor have everything they need to complete this without asking questions?"
- **Rollback Analysis:** "If step N fails mid-execution, what's the recovery path?"
- **Devil's Advocate:** "What is the strongest argument AGAINST this approach?"

For ralplan reviews, apply gate checks: principle-option consistency, fairness of alternative exploration, risk mitigation clarity, testable acceptance criteria, concrete verification steps.

### Phase 3 — Multi-perspective review
- **As the EXECUTOR:** "Can I actually do each step with only what's written here? Where will I get stuck?"
- **As the STAKEHOLDER:** "Does this plan actually solve the stated problem? Are success criteria measurable?"
- **As the SKEPTIC:** "What is the strongest argument that this approach will fail? What alternative was rejected and why?"

### Phase 4 — Gap analysis
Explicitly look for what is MISSING. Ask:
- "What would break this?"
- "What edge case isn't handled?"
- "What assumption could be wrong?"
- "What was conveniently left out?"

### Phase 4.5 — Self-Audit (mandatory)
Re-read your findings before finalizing. For each CRITICAL/MAJOR finding:
1. Confidence: HIGH / MEDIUM / LOW
2. "Could the author immediately refute this?" YES / NO
3. "Is this a genuine flaw or stylistic preference?" FLAW / PREFERENCE

Rules: LOW confidence → Open Questions. Author could refute → Open Questions. PREFERENCE → downgrade to Minor or remove.

### Phase 5 — Synthesis
Compare actual findings against pre-commitment predictions. Issue structured verdict.

## Output Format

\`\`\`markdown
**VERDICT: [REJECT / REVISE / ACCEPT-WITH-RESERVATIONS / ACCEPT]**

**Overall Assessment**: [2-3 sentence summary]

**Pre-commitment Predictions**: [What you expected vs what you found]

**Critical Findings** (blocks execution):
1. [Finding with evidence]
   - Confidence: [HIGH/MEDIUM]
   - Fix: [Specific actionable remediation]

**Major Findings** (causes significant rework):
1. [Finding with evidence]
   - Confidence: [HIGH/MEDIUM]
   - Fix: [Specific suggestion]

**Minor Findings** (suboptimal but functional):
1. [Finding]

**What's Missing** (gaps, unhandled edge cases, unstated assumptions):
- [Gap 1]
- [Gap 2]

**Multi-Perspective Notes**:
- Executor: [...]
- Stakeholder: [...]
- Skeptic: [...]

**Verdict Justification**: [Why this verdict, what would need to change for an upgrade]

**Open Questions (unscored)**: [speculative follow-ups]

---
*Ralplan summary row*:
- Principle/Option Consistency: [Pass/Fail + reason]
- Alternatives Depth: [Pass/Fail + reason]
- Risk/Verification Rigor: [Pass/Fail + reason]
- Deliberate Additions (if required): [Pass/Fail + reason]
\`\`\`

## Failure Modes To Avoid

- Rubber-stamping: Approving work without reading referenced files.
- Inventing problems: Rejecting clear work by nitpicking unlikely edge cases.
- Vague rejections: "The plan needs more detail." Instead: "Task 3 references \`auth.ts\` but doesn't specify which function."
- Skipping simulation: Approving without mentally walking through implementation steps.
- Surface-only criticism: Finding typos while missing architectural flaws.
- Manufactured outrage: Inventing problems to seem thorough.`;

// ─────────────────────────────────────────────────────────────────────────────
// Verdict parsing
//
// Design's verdict format:
//   Architect: APPROVE | REVISION NEEDED
//   Critic:    APPROVE | ITERATE | REJECT
//
// critic.md persona actually emits ACCEPT | REVISE | REJECT (verbatim).
// The Critic regex below accepts BOTH formats and normalizes to the design's
// canonical tokens so downstream logic only sees APPROVE / ITERATE / REJECT.
// ─────────────────────────────────────────────────────────────────────────────

const ARCH_VERDICT_RE = /\*\*VERDICT:\s*(APPROVE|REVISION\s+NEEDED)\*\*/i;
const CRIT_VERDICT_RE =
  /\*\*VERDICT:\s*(APPROVE|ACCEPT(?:-WITH-RESERVATIONS)?|ITERATE|REVISE|REJECT)\*\*/i;

function parseArchitectVerdict(text) {
  const m = ARCH_VERDICT_RE.exec(text || "");
  if (!m) return "UNPARSED";
  return m[1].toUpperCase().replace(/\s+/g, " ").trim();
}

function parseCriticVerdict(text) {
  const m = CRIT_VERDICT_RE.exec(text || "");
  if (!m) return "UNPARSED";
  const raw = m[1].toUpperCase().replace(/\s+/g, " ").trim();
  if (
    raw === "ACCEPT" ||
    raw === "ACCEPT-WITH-RESERVATIONS" ||
    raw === "APPROVE"
  ) {
    return "APPROVE";
  }
  if (raw === "REVISE" || raw === "ITERATE") {
    return "ITERATE";
  }
  return raw; // REJECT
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATE mode detection (matches design's 21 triggers)
// 20 substring signals + 1 word-boundary signal ("rm").
// ─────────────────────────────────────────────────────────────────────────────

const DELIBERATE_SIGNALS = [
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
  "remove everything",
  "compliance",
  "pii",
  "gdpr",
  "hipaa",
  "public api",
  "breaking change",
  "--deliberate flag",
];
const WORD_BOUNDARY_SIGNALS = ["rm"];

function isDeliberate(idea) {
  const lower = String(idea).toLowerCase();
  for (const sig of WORD_BOUNDARY_SIGNALS) {
    const re = new RegExp("\\b" + sig + "\\b");
    if (re.test(lower)) return true;
  }
  for (const sig of DELIBERATE_SIGNALS) {
    if (lower.includes(sig)) return true;
  }
  return false;
}

function resolveMode(args) {
  if (args.deliberate === true) return "DELIBERATE";
  if (args.deliberate === false) return "SHORT";
  return isDeliberate(args.idea) ? "DELIBERATE" : "SHORT";
}

// ─────────────────────────────────────────────────────────────────────────────
// extractFeedbackSection — cap per-reviewer output to keep Planner prompts bounded
// ─────────────────────────────────────────────────────────────────────────────

function extractFeedbackSection(text, pattern, cap) {
  const capDefault = typeof cap === "number" ? cap : 2000;
  if (!text) return "";
  const source =
    pattern && pattern.source ? pattern.source : String(pattern || "");
  const flags = pattern && pattern.flags ? pattern.flags : "";
  const re = new RegExp(source, flags + (flags.includes("g") ? "" : "g"));
  const firstMatch = re.exec(text);
  const start = firstMatch ? firstMatch.index : 0;
  let out = text.slice(start, start + capDefault);
  if (text.length - start > capDefault) out += "\n[…truncated…]";
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Args validation — runs before any agent() call
// ─────────────────────────────────────────────────────────────────────────────

function validateArgs(args) {
  if (!args || typeof args !== "object") {
    throw new Error("Ralplan: args is required.");
  }
  if (typeof args.idea !== "string" || args.idea.trim() === "") {
    throw new Error(
      "Ralplan: args.idea is required and must be a non-empty string.",
    );
  }
  if (typeof args.workingDir !== "string" || args.workingDir === "") {
    throw new Error("Ralplan: args.workingDir is required.");
  }
  const isAbs =
    args.workingDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.workingDir);
  if (!isAbs) {
    throw new Error(
      "Ralplan: args.workingDir must be absolute, got: " + args.workingDir,
    );
  }
  if (args.specPath != null && typeof args.specPath !== "string") {
    throw new Error("Ralplan: args.specPath must be a string when provided.");
  }
  if (args.specPath === "") {
    throw new Error("Ralplan: args.specPath is empty.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders — concatenate persona + task instructions
// ─────────────────────────────────────────────────────────────────────────────

// JSON.stringify neutralizes backticks / ${...} / quote chars from adversarial
// idea text — the planner receives the idea as a JSON string literal.
function safeIdea(args) {
  return JSON.stringify(args.idea);
}

function plannerPromptBuilder(
  idea,
  specPath,
  draftPath,
  mode,
  iterNum,
  feedback,
) {
  let p = PLANNER_PERSONA;
  p += "\n\n## Task\n";
  if (specPath) {
    p += "Read the spec at: " + specPath + "\n";
  } else {
    p += "No spec.md provided — work from the original idea below.\n";
  }
  p += "Original idea (for reference): " + idea + "\n";
  p += "Write the plan draft to: " + draftPath + "\n";
  p += "Mode: " + mode + "\n\n";
  p +=
    "On this iteration (" +
    iterNum +
    "), produce a RALPLAN-DR summary block AT THE TOP of plan_draft.md\n";
  p +=
    'with the Mode line set to "' +
    mode +
    '", Principles (3-5), Decision Drivers (top 3), and >=2 Viable Options.\n';
  if (mode === "DELIBERATE") {
    p +=
      "DELIBERATE mode: include Pre-Mortem (3 concrete failure scenarios with mitigations) and Expanded Test Plan (unit/integration/e2e/observability).\n";
  }
  p +=
    "End your reply with: **DRAFT_WRITTEN: " +
    draftPath +
    "** on its own line.\n";
  if (feedback.length > 0) {
    p += "\n## Prior Iteration Feedback\n";
    for (const f of feedback) {
      p += "- iter " + f.iteration + ":\n";
      p += "  - Architect: " + f.architect + "\n";
      p += "  - Critic: " + f.critic + "\n";
    }
  }
  return p;
}

function architectPromptBuilder(draftPath, reviewPath) {
  return (
    ARCHITECT_PERSONA +
    "\n\n## Task\nRead: " +
    draftPath +
    "\nWrite your review to: " +
    reviewPath +
    "\nEnd with a single line: **VERDICT: APPROVE** or **VERDICT: REVISION NEEDED**\n"
  );
}

function criticPromptBuilder(
  draftPath,
  archReviewPath,
  critReviewPath,
  finalPath,
  mode,
) {
  let p = CRITIC_PERSONA;
  p += "\n\n## Task\n";
  p += "Read: " + draftPath + "\n";
  p += "Read: " + archReviewPath + "\n";
  p += "Write your review to: " + critReviewPath + "\n";
  p +=
    "End with a single line: **VERDICT: APPROVE** | **VERDICT: ITERATE** | **VERDICT: REJECT**\n\n";
  p +=
    "If and only if your verdict is APPROVE, ALSO copy " +
    draftPath +
    " to " +
    finalPath +
    "\n";
  p +=
    "and prepend/append the ADR section per the persona. Then prompt the user for clarification on Open Questions.\n\n";
  p += "Mode for this run: " + mode + "\n";
  if (mode === "DELIBERATE") {
    p +=
      "DELIBERATE mode: you MUST explicitly REJECT a missing or weak pre-mortem or missing/weak expanded test plan.\n";
  }
  p +=
    "When the plan is written, end with: **PLAN_WRITTEN: " + finalPath + "**\n";
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — strict sequential Planner / Architect / Critic loop.
// Architect and Critic MUST be awaited sequentially; no parallel review of an
// unreviewed draft. Loop terminates on dual-APPROVE or after maxIterations.
// ─────────────────────────────────────────────────────────────────────────────

validateArgs(workflowArgs);

const safeIdeaStr = safeIdea(workflowArgs);

const PLAN_DIR = workflowArgs.workingDir + "/plans";
const DRAFT_DIR = PLAN_DIR + "/drafts";
const SPEC_PATH = workflowArgs.specPath || null;
const DRAFT_PATH = DRAFT_DIR + "/plan_draft.md";
const ARCH_REVIEW_PATH = DRAFT_DIR + "/architect_review.md";
const CRIT_REVIEW_PATH = DRAFT_DIR + "/critic_review.md";
const FINAL_PATH = PLAN_DIR + "/" + (workflowArgs.planName || "plan") + ".md";

const mode = resolveMode(workflowArgs);

const maxIterations =
  typeof workflowArgs.maxIterations === "number" &&
  workflowArgs.maxIterations > 0 &&
  workflowArgs.maxIterations <= 100
    ? Math.floor(workflowArgs.maxIterations)
    : 5;

const feedback = [];
let iterations = 0;
let architectVerdict = "UNPARSED";
let criticVerdict = "UNPARSED";

phase("Planning");
for (; iterations < maxIterations; iterations++) {
  const iterNum = iterations + 1;

  phase("Iteration " + iterNum + ": Planner");
  const draft = await agent(
    plannerPromptBuilder(
      safeIdeaStr,
      SPEC_PATH,
      DRAFT_PATH,
      mode,
      iterNum,
      feedback,
    ),
    {
      label: "ralplan-planner-" + iterNum,
      persona: PLANNER_PERSONA,
      phase: "Planning",
    },
  );
  if (draft == null) {
    throw new Error("Ralplan: Planner returned null at iteration " + iterNum);
  }

  phase("Iteration " + iterNum + ": Architect");
  const arch = await agent(
    architectPromptBuilder(DRAFT_PATH, ARCH_REVIEW_PATH),
    {
      label: "ralplan-architect-" + iterNum,
      persona: ARCHITECT_PERSONA,
      phase: "Planning",
    },
  );
  if (arch == null) {
    throw new Error("Ralplan: Architect returned null at iteration " + iterNum);
  }
  architectVerdict = parseArchitectVerdict(arch);

  phase("Iteration " + iterNum + ": Critic");
  const crit = await agent(
    criticPromptBuilder(
      DRAFT_PATH,
      ARCH_REVIEW_PATH,
      CRIT_REVIEW_PATH,
      FINAL_PATH,
      mode,
    ),
    {
      label: "ralplan-critic-" + iterNum,
      persona: CRITIC_PERSONA,
      phase: "Planning",
    },
  );
  if (crit == null) {
    throw new Error("Ralplan: Critic returned null at iteration " + iterNum);
  }
  criticVerdict = parseCriticVerdict(crit);

  if (architectVerdict === "APPROVE" && criticVerdict === "APPROVE") {
    // 1-based; `break` leaves iterations set to the completed count.
    iterations = iterNum;
    break;
  }

  if (iterNum < maxIterations) {
    feedback.push({
      iteration: iterNum,
      architect: extractFeedbackSection(
        arch,
        /Antithesis|Trade-off tension|Recommendations/i,
      ),
      critic: extractFeedbackSection(
        crit,
        /Critical Findings|Major Findings|Verdict Justification/i,
      ),
    });
  }
}

if (architectVerdict !== "APPROVE" || criticVerdict !== "APPROVE") {
  // Spec §11 — error exposes .verdicts / .draftPath / .iterations / .feedback / .mode
  // so the host can surface partial progress to the user.
  const err = new Error(
    "Ralplan: failed to reach consensus after " + iterations + " iteration(s).",
  );
  err.verdicts = { architect: architectVerdict, critic: criticVerdict };
  err.draftPath = DRAFT_PATH;
  err.iterations = iterations;
  err.feedback = feedback;
  err.mode = mode;
  throw err;
}

// Log the canonical signal BEFORE return so it surfaces in the progress stream.
// Host environment stops here and hands off to execution — this skill NEVER
// starts implementation (boundary: planning/execution separation).
log("PIPELINE_RALPLAN_COMPLETE");

return {
  planPath: FINAL_PATH,
  iterations: iterations,
  mode: mode,
  verdicts: { architect: architectVerdict, critic: criticVerdict },
  feedback: feedback,
};
