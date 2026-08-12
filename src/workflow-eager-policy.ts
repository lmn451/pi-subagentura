import {
  validateWorkflowPlan,
  type WorkflowPlanDefinition,
} from "./workflow-plan";

export type WorkflowEagerMode = "off" | "preferred" | "always";

export interface WorkflowEagerDecision {
  readonly route: boolean;
  readonly reason: string;
  readonly slices: readonly string[];
}

export type EagerPlanDraftFactory = (
  task: string,
  slices: readonly string[],
  attempt: 0 | 1,
  previousError?: string,
) => unknown;

const MAX_EXTRACTED_SLICES = 8;
const MAX_EAGER_TASKS = 16;
const MAX_TASK_TEXT_LENGTH = 4096;
const MAX_TASK_CONTENT_LENGTH = 256;

const ACTION_START =
  /^(?:add|apply|audit|build|change|check|clean|compare|complete|configure|convert|create|debug|delete|deploy|document|edit|ensure|execute|find|fix|generate|help|implement|improve|inspect|install|investigate|make|migrate|move|optimize|plan|prepare|publish|read|refactor|release|remove|rename|repair|replace|research|resolve|review|rewrite|run|set\s+up|ship|test|trace|update|upgrade|use|validate|verify|write)\b/i;
const QUESTION_START =
  /^(?:am|are|can|could|did|do|does|had|has|have|how|is|may|might|should|was|were|what|when|where|which|who|why|will|would)\b/i;
const INFORMATION_REQUEST_START =
  /^(?:describe|explain|help me understand|tell me)\b/i;
const EXPLICIT_PHASE_CUE =
  /(?:\b(?:in|across)\s+(?:(?:two|three|four|\d+)\s+)?phases?\b|\bmulti[- ]phase\b)/i;
const BULLET_SLICE =
  /^\s*(?:(?:[-*+]\s+)|(?:\d{1,3}[.)]\s+)|(?:(?:phase|step)\s+\d{1,3}\s*[:.)-]\s+))(.+?)\s*$/i;
const INLINE_PHASE_SEPARATOR =
  /\b(?:then|next|finally|after\s+that|afterwards?)\b\s*[:,]?\s*/i;
const COMPOUND_ACTION_SEPARATOR = /\s+(?:and(?:\s+then)?|plus)\s+/i;

const SOCIAL_MESSAGES: Readonly<Record<string, true>> = {
  "good afternoon": true,
  "good evening": true,
  "good morning": true,
  "got it": true,
  great: true,
  hello: true,
  "hello there": true,
  hey: true,
  hi: true,
  "looks good": true,
  "looks good to me": true,
  nice: true,
  ok: true,
  okay: true,
  "sounds good": true,
  "thank you": true,
  thanks: true,
  "thanks for your help": true,
  "that's all": true,
};

export function resolveWorkflowEagerMode(value: unknown): {
  mode: WorkflowEagerMode;
  error?: string;
} {
  if (value === undefined || value === null) {
    return { mode: "off" };
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "off" ||
      normalized === "preferred" ||
      normalized === "always"
    ) {
      return { mode: normalized };
    }
  }

  return {
    mode: "off",
    error:
      `Invalid workflow-eager value ${describeValue(value)}; ` +
      'expected "off", "preferred", or "always".',
  };
}

export function decideWorkflowEagerRequest(
  prompt: string,
  mode: WorkflowEagerMode,
): WorkflowEagerDecision {
  if (mode === "off") {
    return decision(false, "disabled");
  }

  const normalized = typeof prompt === "string" ? prompt.trim() : "";
  if (normalized.length === 0) {
    return decision(false, "empty-request");
  }
  if (isWorkflowManagementRequest(normalized)) {
    return decision(false, "workflow-management");
  }
  if (isSocialMessage(normalized)) {
    return decision(false, "social");
  }
  if (isAwaitingUserInput(normalized)) {
    return decision(false, "awaiting-user-input");
  }
  if (isPlanOnlyRequest(normalized)) {
    return decision(false, "plan-only");
  }
  if (isPureQuestion(normalized)) {
    return decision(false, "pure-question");
  }

  const listedSlices = extractListedSlices(normalized);
  const phasedSlices = extractInlinePhasedSlices(normalized);
  const compoundSlices = extractCompoundActionSlices(normalized);
  const slices = [listedSlices, phasedSlices, compoundSlices].reduce(
    (best, candidate) => (candidate.length > best.length ? candidate : best),
    [] as readonly string[],
  );
  const executable = slices.length > 0 || containsExecutableClause(normalized);

  if (!executable) {
    return decision(false, "not-executable", slices);
  }

  if (mode === "preferred") {
    if (slices.length >= 2) {
      return decision(
        true,
        listedSlices.length >= 2 ? "explicit-multi-slice" : "phased-complex",
        slices,
      );
    }
    if (EXPLICIT_PHASE_CUE.test(normalized)) {
      return decision(
        true,
        "phased-complex",
        slices.length === 0 ? [normalized] : slices,
      );
    }
    return decision(false, "preferred-simple", slices);
  }

  return decision(
    true,
    "always-executable",
    slices.length === 0 ? [normalized] : slices,
  );
}

export function createValidatedEagerWorkflowPlan(
  task: string,
  slices: readonly string[],
  draftFactory: EagerPlanDraftFactory = createDefaultDraft,
): WorkflowPlanDefinition {
  const bounded = normalizeBoundedPlanInputs(task, slices);
  const failures: string[] = [];

  for (const attempt of [0, 1] as const) {
    try {
      const draft = draftFactory(
        bounded.task,
        bounded.slices,
        attempt,
        failures[attempt - 1],
      );
      preflightDraftBounds(draft);
      return validateEagerWorkflowPlan(draft);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  throw new Error(
    "Unable to create a valid eager workflow plan after 2 attempts. " +
      `Attempt 0: ${failures[0]}. Attempt 1: ${failures[1]}.`,
  );
}

function decision(
  route: boolean,
  reason: string,
  slices: readonly string[] = [],
): WorkflowEagerDecision {
  return { route, reason, slices };
}

function stripRequestWrapper(value: string): string {
  let candidate = value.trim();
  candidate = candidate.replace(/^(?:hello|hey|hi)\s*[,!.:-]\s*/i, "");
  candidate = candidate.replace(/^(?:please|kindly)\s+/i, "");
  candidate = candidate.replace(
    /^(?:(?:can|could|will|would)\s+you|(?:i|we)\s+(?:need|want)\s+you\s+to|let(?:'s| us))\s+/i,
    "",
  );
  candidate = candidate.replace(/^(?:please|kindly)\s+/i, "");
  return candidate.trim();
}

function stripPhasePrefix(value: string): string {
  return value
    .replace(/^[\s,;:.-]+/, "")
    .replace(/^(?:first(?:ly)?|phase\s+\d+|step\s+\d+)\s*[:,.)-]?\s*/i, "")
    .trim();
}

function isExecutableClause(value: string): boolean {
  return ACTION_START.test(stripPhasePrefix(stripRequestWrapper(value)));
}

function containsExecutableClause(prompt: string): boolean {
  if (isExecutableClause(prompt)) {
    return true;
  }

  const clauses = prompt.split(/(?:\r?\n|[.!?;]\s+)/);
  return clauses.some((clause) => {
    const bullet = clause.match(BULLET_SLICE);
    return isExecutableClause(bullet?.[1] ?? clause);
  });
}

function isWorkflowManagementRequest(prompt: string): boolean {
  const candidate = stripRequestWrapper(prompt);
  if (
    /^\/(?:workflow|workflow-plan|workflow-status|workflow-cancel)\b/i.test(
      candidate,
    )
  ) {
    return true;
  }
  return /^(?:approve|cancel|continue|create|inspect|list|open|pause|reject|restart|resume|retry|show|start|status|stop)\s+(?:(?:the|this|that|an?)\s+)?(?:(?:active|current|durable)\s+)?(?:workflow|workflow\s+run|run\s+(?:status|[a-z0-9_-]+))\b/i.test(
    candidate,
  );
}

function isSocialMessage(prompt: string): boolean {
  const normalized = prompt
    .toLowerCase()
    .replace(/[!,.:;?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return SOCIAL_MESSAGES[normalized] === true;
}

function isAwaitingUserInput(prompt: string): boolean {
  const candidate = stripRequestWrapper(prompt);
  return (
    /^(?:do nothing|don't do anything|hold on|not yet|one moment|stand by|wait)\b/i.test(
      candidate,
    ) ||
    /\b(?:await|wait for)\s+(?:my|the user's?|further)\s+(?:approval|confirmation|details|input|instructions|response)\b/i.test(
      candidate,
    ) ||
    /\b(?:do not|don't)\s+(?:act|begin|implement|make changes|proceed|start)\s+(?:yet|until)\b/i.test(
      candidate,
    ) ||
    /\bi(?:'ll| will)\s+(?:confirm|let you know|provide|send|share|tell you)\b/i.test(
      candidate,
    )
  );
}

function isPlanOnlyRequest(prompt: string): boolean {
  const candidate = stripRequestWrapper(prompt);
  if (
    /\b(?:analysis|planning|recommendations?)\s+only\b/i.test(candidate) ||
    /\b(?:do not|don't)\s+(?:apply|build|change|edit|execute|implement|make|modify|run|start)\b/i.test(
      candidate,
    ) ||
    /\b(?:no changes|no implementation|without (?:changing|editing|implementation|implementing|making changes|modifying))\b/i.test(
      candidate,
    )
  ) {
    return true;
  }

  const beginsWithPlan =
    /^(?:(?:create|develop|draft|make|prepare|produce|write)\s+)?(?:an?\s+)?(?:(?:implementation|migration|project|release)\s+)?(?:outline|plan|proposal|roadmap)\b|^design\s+(?:an?\s+)?plan\b/i.test(
      candidate,
    );
  if (!beginsWithPlan) {
    return false;
  }

  return !/\b(?:and(?:\s+then)?|then)\s+(?:add|apply|build|change|create|deploy|edit|execute|fix|implement|make|migrate|modify|refactor|remove|run|test|update|verify|write)\b/i.test(
    candidate,
  );
}

function isPureQuestion(prompt: string): boolean {
  if (containsExecutableClause(prompt)) {
    return false;
  }

  const candidate = stripRequestWrapper(prompt);
  return (
    QUESTION_START.test(prompt.trim()) ||
    INFORMATION_REQUEST_START.test(candidate) ||
    prompt.trimEnd().endsWith("?")
  );
}

function extractListedSlices(prompt: string): readonly string[] {
  const slices: string[] = [];
  const seen = new Set<string>();

  for (const line of prompt.split(/\r?\n/)) {
    const match = line.match(BULLET_SLICE);
    if (match === null) {
      continue;
    }
    const slice = match[1].replace(/^\[[ xX]\]\s+/, "").trim();
    if (
      slice.length === 0 ||
      slice.length > MAX_TASK_TEXT_LENGTH ||
      !isExecutableClause(slice)
    ) {
      continue;
    }
    const key = slice.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slices.push(slice);
    if (slices.length === MAX_EXTRACTED_SLICES) {
      break;
    }
  }

  return slices;
}

function extractInlinePhasedSlices(prompt: string): readonly string[] {
  if (!INLINE_PHASE_SEPARATOR.test(prompt)) {
    return [];
  }

  const parts = prompt.split(INLINE_PHASE_SEPARATOR);
  if (parts.length < 2) {
    return [];
  }

  const slices: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    let slice = part.trim().replace(/^[\s,;:.-]+|[\s,;:.]+$/g, "");
    const firstMarker = slice.match(/\bfirst(?:ly)?\b\s*[:,]?\s*/i);
    if (firstMarker?.index !== undefined) {
      slice = slice.slice(firstMarker.index + firstMarker[0].length).trim();
    }
    if (
      slice.length === 0 ||
      slice.length > MAX_TASK_TEXT_LENGTH ||
      !isExecutableClause(slice)
    ) {
      continue;
    }
    const key = slice.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slices.push(slice);
    if (slices.length === MAX_EXTRACTED_SLICES) {
      break;
    }
  }

  return slices.length >= 2 ? slices : [];
}

function extractCompoundActionSlices(prompt: string): readonly string[] {
  if (!COMPOUND_ACTION_SEPARATOR.test(prompt)) {
    return [];
  }

  const slices: string[] = [];
  const seen = new Set<string>();
  for (const part of prompt.split(COMPOUND_ACTION_SEPARATOR)) {
    const slice = part.trim().replace(/^[\s,;:.-]+|[\s,;:.]+$/g, "");
    if (
      slice.length === 0 ||
      slice.length > MAX_TASK_TEXT_LENGTH ||
      !isExecutableClause(slice)
    ) {
      continue;
    }
    const key = slice.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slices.push(slice);
    if (slices.length === MAX_EXTRACTED_SLICES) {
      break;
    }
  }

  return slices.length >= 2 ? slices : [];
}

function normalizeBoundedPlanInputs(
  task: string,
  slices: readonly string[],
): { task: string; slices: readonly string[] } {
  const normalizedTask = boundedText(task, "task", MAX_TASK_TEXT_LENGTH);
  if (!Array.isArray(slices)) {
    throw new Error("Eager workflow slices must be an array.");
  }
  if (slices.length > MAX_EAGER_TASKS) {
    throw new Error(
      `Eager workflow plan exceeds the ${MAX_EAGER_TASKS}-task limit.`,
    );
  }

  const normalizedSlices =
    slices.length === 0
      ? [normalizedTask]
      : slices.map((slice, index) =>
          boundedText(slice, `slices[${index}]`, MAX_TASK_TEXT_LENGTH),
        );
  return { task: normalizedTask, slices: normalizedSlices };
}

function boundedText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${path} must not be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${path} exceeds the ${maxLength}-character limit.`);
  }
  return normalized;
}

function createDefaultDraft(
  task: string,
  slices: readonly string[],
  _attempt: 0 | 1,
  _previousError?: string,
): unknown {
  return {
    name: "Automatic workflow plan",
    description: task,
    phases: slices.map((slice, index) => ({
      id: `phase-${index + 1}`,
      name: `Phase ${index + 1}`,
      mode: "sequence",
      tasks: [
        {
          id: `task-${index + 1}`,
          content: shortTaskContent(slice),
          instruction: slice,
          agent: { isolation: "in-process" },
        },
      ],
    })),
  };
}

function shortTaskContent(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_TASK_CONTENT_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, MAX_TASK_CONTENT_LENGTH - 3).trimEnd()}...`;
}

function preflightDraftBounds(input: unknown): void {
  if (!isRecord(input) || !Array.isArray(input.phases)) {
    return;
  }

  let taskCount = 0;
  for (const phase of input.phases) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) {
      continue;
    }
    taskCount += phase.tasks.length;
    if (taskCount > MAX_EAGER_TASKS) {
      throw new Error(
        `Eager workflow plan exceeds the ${MAX_EAGER_TASKS}-task limit.`,
      );
    }
    for (const task of phase.tasks) {
      if (!isRecord(task)) {
        continue;
      }
      preflightTextField(task.content, "task.content", MAX_TASK_CONTENT_LENGTH);
      preflightTextField(
        task.instruction,
        "task.instruction",
        MAX_TASK_TEXT_LENGTH,
      );
    }
  }
}

function preflightTextField(
  value: unknown,
  path: string,
  maxLength: number,
): void {
  if (typeof value === "string" && value.length > maxLength) {
    throw new Error(`${path} exceeds the ${maxLength}-character limit.`);
  }
}

function validateEagerWorkflowPlan(input: unknown): WorkflowPlanDefinition {
  const validated = validateWorkflowPlan(input);
  for (const phase of validated.phases) {
    if (phase.mode !== "sequence") {
      throw new Error(
        "Durable workflow preview supports sequential phases only.",
      );
    }
    for (const task of phase.tasks) {
      if (
        task.agent?.isolation !== undefined &&
        task.agent.isolation !== "in-process"
      ) {
        throw new Error(
          `Durable workflow task ${task.id} requests unsupported process isolation.`,
        );
      }
    }
  }

  return validateWorkflowPlan({
    name: validated.name,
    description: validated.description,
    phases: validated.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      mode: phase.mode,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        content: task.content,
        instruction: task.instruction,
        agent: { ...(task.agent ?? {}), isolation: "in-process" },
      })),
    })),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length === 0 ? error.name : error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return `of type ${typeof value}`;
}
