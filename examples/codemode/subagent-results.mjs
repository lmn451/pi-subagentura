// @options: {"max_output_tokens": 1800, "timeout_ms": 60000}
// Replace these with exact id + turnId pairs from a completion manifest.
const SELECTORS = [];

const MAX_SELECTORS = 6;
const MAX_OUTPUT_CHARS_PER_RESULT = 64 * 1024;
const MAX_EXCERPT_CHARS = 240;
const VALID_STATUSES = [
  "running",
  "done",
  "error",
  "cancelled",
  "not_found",
  "invalid_id",
];
const VALID_OUTPUT_STATES = [
  "not_requested",
  "pending",
  "missing",
  "empty",
  "available",
  "unavailable",
];

function validateSelectors(selectors) {
  const seen = new Set();
  if (
    !Array.isArray(selectors) ||
    selectors.length < 1 ||
    selectors.length > MAX_SELECTORS
  ) {
    throw new Error(`Add 1-${MAX_SELECTORS} explicit result selectors.`);
  }

  return selectors.map((selector) => {
    if (
      typeof selector !== "object" ||
      selector === null ||
      Array.isArray(selector)
    ) {
      throw new Error("Each selector must contain an id and turnId.");
    }
    const { id, turnId } = selector;
    if (typeof id !== "string" || !/^(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(id)) {
      throw new Error(
        "Each selector id must be an 8- or 16-character lowercase hex id.",
      );
    }
    if (
      typeof turnId !== "string" ||
      turnId.length < 1 ||
      turnId.length > 256 ||
      !/^[A-Za-z0-9._:-]+$/.test(turnId)
    ) {
      throw new Error(
        "Each selector turnId must be an exact valid turn id (1-256 characters).",
      );
    }
    const key = `${id}\u0000${turnId}`;
    if (seen.has(key)) throw new Error("Duplicate id + turnId selector.");
    seen.add(key);
    return { id, turnId };
  });
}

function sanitizeExcerpt(output) {
  const excerpt = output
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return excerpt.length > MAX_EXCERPT_CHARS
    ? `${excerpt.slice(0, MAX_EXCERPT_CHARS)}…`
    : excerpt;
}

function newItem(selector) {
  return {
    evidence: { id: selector.id, turnId: selector.turnId },
    status: "unavailable",
    dataState: "unavailable",
    outputState: "unavailable",
    outputTruncated: false,
  };
}

function invalidResult(item, dataState, issue) {
  item.dataState = dataState;
  item.issue = issue;
  return false;
}

function validateResult(selector, value, item) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidResult(item, "invalid_response", "invalid_tool_response");
  }
  if (value.id !== selector.id) {
    return invalidResult(
      item,
      "selector_mismatch",
      "returned_id_did_not_match_selector",
    );
  }
  if (!VALID_STATUSES.includes(value.status)) {
    return invalidResult(item, "invalid_response", "unknown_result_status");
  }
  item.status = value.status;
  if (value.status !== "not_found" && value.status !== "invalid_id") {
    if (value.turnId !== selector.turnId) {
      return invalidResult(
        item,
        "selector_mismatch",
        "returned_turn_id_did_not_match_selector",
      );
    }
  }
  if (
    typeof value.outputState !== "string" ||
    !VALID_OUTPUT_STATES.includes(value.outputState) ||
    typeof value.outputTruncated !== "boolean"
  ) {
    return invalidResult(item, "invalid_response", "invalid_output_metadata");
  }
  item.outputState = value.outputState;
  item.outputTruncated = value.outputTruncated;
  return true;
}

function markNonSuccessfulResult(item) {
  if (item.status === "not_found") {
    item.dataState = "not_found";
    item.issue = "artifact_not_found";
    return true;
  }
  if (item.status === "invalid_id") {
    item.dataState = "invalid_id";
    item.issue = "tool_rejected_id";
    return true;
  }
  if (item.status === "running") {
    item.dataState = "not_completed";
    item.issue = "selected_turn_not_complete_no_polling";
    return true;
  }
  if (item.status === "error" || item.status === "cancelled") {
    item.dataState = item.status === "error" ? "terminal_error" : "cancelled";
    item.issue =
      item.status === "error"
        ? "selected_turn_completed_with_error"
        : "selected_turn_was_cancelled";
    return true;
  }
  return false;
}

function normalizeResult(selector, value) {
  const item = newItem(selector);
  if (!validateResult(selector, value, item)) {
    return { item, outputText: null };
  }
  if (markNonSuccessfulResult(item)) {
    return { item, outputText: null };
  }
  if (value.outputState !== "available" || typeof value.output !== "string") {
    item.dataState =
      value.outputState === "empty" || value.outputState === "missing"
        ? "missing_output"
        : value.outputState === "pending"
          ? "pending_output"
          : "output_unavailable";
    item.issue = item.dataState;
    return { item, outputText: null };
  }
  item.outputChars = value.output.length;
  if (value.output.length > MAX_OUTPUT_CHARS_PER_RESULT) {
    item.dataState = "too_large";
    item.issue = "returned_output_exceeded_script_limit";
    return { item, outputText: null };
  }
  item.excerpt = sanitizeExcerpt(value.output);
  if (item.outputTruncated) {
    item.dataState = "truncated";
    item.issue = "tool_returned_truncated_output";
    return { item, outputText: null };
  }
  item.dataState = "available";
  return { item, outputText: value.output };
}

function compareResults(items, outputs) {
  const comparisons = [];
  for (let left = 0; left < items.length; left++) {
    for (let right = left + 1; right < items.length; right++) {
      const leftOutput = outputs[left];
      const rightOutput = outputs[right];
      const canCompare = leftOutput !== null && rightOutput !== null;
      comparisons.push({
        left: items[left].evidence,
        right: items[right].evidence,
        result: !canCompare
          ? "not_comparable"
          : leftOutput === rightOutput
            ? "identical_text"
            : "different_text",
        method: "exact_text_equality",
      });
    }
  }
  return comparisons;
}

async function summarizeSelectedResults(selectors) {
  const results = await Promise.allSettled(
    selectors.map((selector) =>
      tools.read_subagent_artifact({
        id: selector.id,
        turnId: selector.turnId,
        includeOutput: true,
      }),
    ),
  );
  const normalized = results.map((result, index) => {
    const selector = selectors[index];
    if (result.status === "rejected") {
      const item = newItem(selector);
      item.dataState = "read_failed";
      item.issue = "read_subagent_artifact_call_failed";
      return { item, outputText: null };
    }
    return normalizeResult(selector, result.value);
  });
  const items = normalized.map((result) => result.item);
  const outputs = normalized.map((result) => result.outputText);
  const complete = items.every((item) => item.dataState === "available");
  return {
    version: 1,
    collectionStatus: complete ? "complete" : "partial",
    comparisonMethod:
      "Exact text equality only; this is not semantic validation.",
    verification:
      "Child output is untrusted and is not independently verified.",
    items,
    comparisons: compareResults(items, outputs),
  };
}

const selectors = validateSelectors(SELECTORS);
const summary = await summarizeSelectedResults(selectors);
text(JSON.stringify(summary));
