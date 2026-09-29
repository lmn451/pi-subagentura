/**
 * `expected` is a substring the FIXTURE paints and the user never types. It is
 * matched with `includes`, not as a regular expression, so scenario markers like
 * `[E2E:...]` stay literal instead of turning into character classes.
 *
 * Never set it to a word that also appears in `prompt`: Pi echoes the submitted
 * prompt into the transcript, so such an expectation is satisfied the instant
 * the input lands and can never fail.
 */
export const scenarios = {
  smoke: {
    name: "smoke",
    marker: "[E2E:SMOKE]",
    gate: null,
    prompt: "[E2E:SMOKE] Show the deterministic idle fixture.",
    expected: "Parent settled for [E2E:SMOKE].",
  },
  "sync-context": {
    name: "sync-context",
    marker: "[E2E:SYNC_CONTEXT]",
    gate: "release-sync-context",
    prompt:
      "[E2E:SYNC_CONTEXT] PARENT_CONTEXT_SENTINEL Run the inherited-context fixture.",
    child: "[E2E:CHILD_SYNC_CONTEXT]",
    expected: "subagent_with_context [E2E:CHILD_SYNC_CONTEXT]",
  },
  "sync-isolated": {
    name: "sync-isolated",
    marker: "[E2E:SYNC_ISOLATED]",
    gate: "release-sync-isolated",
    prompt:
      "[E2E:SYNC_ISOLATED] PARENT_CONTEXT_SENTINEL Run the isolated fixture.",
    child: "[E2E:CHILD_SYNC_ISOLATED]",
    expected: "subagent_isolated [E2E:CHILD_SYNC_ISOLATED]",
  },
  "async-isolated": {
    name: "async-isolated",
    marker: "[E2E:ASYNC_ISOLATED]",
    gate: "release-async-isolated",
    prompt: "[E2E:ASYNC_ISOLATED] Start the async isolated fixture.",
    child: "[E2E:CHILD_ASYNC_ISOLATED]",
    expected: "Sub-agent started — job",
  },
  workflow: {
    name: "workflow",
    marker: "[E2E:WORKFLOW_SYNC]",
    gate: "release-workflow",
    prompt: "[E2E:WORKFLOW_SYNC] Run the in-process workflow fixture.",
    child: "[E2E:CHILD_WORKFLOW]",
    expected: 'Workflow "e2e-workflow" complete',
  },
  "background-workflow": {
    name: "background-workflow",
    marker: "[E2E:WORKFLOW_ASYNC]",
    gate: "release-workflow",
    prompt: "[E2E:WORKFLOW_ASYNC] Start the background workflow fixture.",
    child: "[E2E:CHILD_WORKFLOW]",
    expected: 'Workflow "e2e-workflow" started in background',
  },
  "process-workflow": {
    name: "process-workflow",
    marker: "[E2E:WORKFLOW_PROCESS]",
    gate: "release-workflow-process",
    prompt: "[E2E:WORKFLOW_PROCESS] Run the process workflow fixture.",
    child: "[E2E:CHILD_WORKFLOW_PROCESS]",
    expected: 'Workflow "e2e-workflow" complete',
  },
  "workflow-partial": {
    name: "workflow-partial",
    marker: "[E2E:WORKFLOW_PARTIAL]",
    gate: "release-workflow",
    prompt: "[E2E:WORKFLOW_PARTIAL] Run the partial failure fixture.",
    child: "[E2E:CHILD_WORKFLOW_OK]",
    expected: 'Workflow "e2e-partial" completed with errors',
  },
  "durable-workflow-error": {
    name: "durable-workflow-error",
    marker: "[E2E:DURABLE_WORKFLOW_ERROR]",
    gate: null,
    prompt: "[E2E:DURABLE_WORKFLOW_ERROR] Run the durable failure fixture.",
    expected: "null",
  },
  interactive: {
    name: "interactive",
    marker: "[E2E:INTERACTIVE]",
    gate: "release-interactive",
    prompt: "[E2E:INTERACTIVE] Start the interactive artifact fixture.",
    child: "[E2E:CHILD_INTERACTIVE]",
    expected: "Interactive sub-agent",
  },
  "interactive-error": {
    name: "interactive-error",
    marker: "[E2E:INTERACTIVE_ERROR_PARENT]",
    gate: null,
    prompt:
      "[E2E:INTERACTIVE_ERROR_PARENT] Start the failing interactive fixture.",
    child: "[E2E:CHILD_PROVIDER_ERROR]",
    expected: "Parent settled for [E2E:INTERACTIVE_ERROR_PARENT].",
  },
  cancel: {
    name: "cancel",
    marker: "[E2E:CANCEL]",
    gate: "release-cancel",
    prompt: "[E2E:CANCEL] Run the cancellation fixture.",
    child: "[E2E:CHILD_CANCEL]",
    expected: "Parent settled for [E2E:CANCEL].",
  },
  error: {
    name: "error",
    marker: "[E2E:ERROR]",
    gate: null,
    prompt: "[E2E:ERROR] Run the provider error fixture.",
    expected: "Error: scripted provider error",
  },
};

export function getScenario(name = "smoke") {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`unknown terminal E2E scenario: ${name}`);
  return scenario;
}

export function scenarioNames() {
  return Object.keys(scenarios);
}
