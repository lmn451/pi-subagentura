# Orchestratorv2 hardening task

## Source findings

This branch handles findings 1, 3, 4, and 5 from the Orchestratorv2 verification. Finding 2 is explicitly out of scope because it is not considered a bug at this point.

1. **Router-only and workflow separation are prompt-only.** `--orchestratorv2` appends a system prompt, but the parent still registers workflow and in-process worker tools. The mode needs a runtime tool boundary, not only model compliance.
2. **No change requested.** Follow-up routing is model-directed and does not require a fresh registry lookup or deterministic responsibility matching. This is accepted for now.
3. **Metadata confirmation is asserted by the model.** The update and removal schemas accept `confirmed: true`, but the runtime does not prove that the user confirmed the exact pending change. Add a user-bound confirmation flow.
4. **A child can remain live when initial metadata persistence fails.** Spawning currently succeeds and returns a warning after the child has already launched. Make the operation fail closed by cancelling the launched child when requested routing metadata cannot be persisted.
5. **Tests overstate end-to-end coverage.** Existing scenario tests mainly exercise registered tools with mocked launch and pane operations, and prompt text is used as evidence for router behavior. Add coverage through the extension's public registration boundary that verifies the restricted tool surface and the failure behavior above. Keep real-project acceptance validation in the verification record.

## Intended outcome

- In `--orchestratorv2` mode, register only the extension tools needed for interactive routing, metadata management, model discovery, artifact access/cleanup, supervision, and cancellation. Enforce an active-tool allowlist so built-in repository tools, workflows, and in-process workers are unavailable to the parent model.
- Require a server-issued pending confirmation token and a subsequent user message containing that token before responsibility metadata can be updated or removed.
- If initial routing metadata persistence fails after launch, cancel the new child and return an error rather than a usable live runtime.
- Add regression tests for each changed behavior and a real Pi CLI integration path that observes the provider-visible tool surface, appended prompt, and routing registry tool result.
- Run `npm run typecheck`, `npm test`, `npm run format:check`, and `npm run pack:check` before committing.

## Follow-up review findings

- Cleanup originally attempted cancellation only once. Because pane liveness or teardown can throw after marking the runtime cancelled, cleanup now retries once and leaves the runtime `unknown` and explicitly retryable if both attempts fail.
- A full pending-confirmation set originally risked evicting its oldest token before validating that token. Capacity eviction now applies only when issuing a new token, and a regression test confirms the oldest of 32 pending changes remains confirmable.

## Verification record

- The real Pi CLI integration observed the exact provider-visible Orchestratorv2 tool allowlist, the appended v2 system prompt, and the public `list_orchestrator_agents` result. Built-in repository tools, workflow tools, and in-process worker tools were absent.
- Focused reviewer re-validation passed 44 tests, typecheck, and `git diff --check` with both follow-up findings closed.
- Final repository verification passed `npm run typecheck`, all 1,545 tests across 69 files, `npm run format:check`, `npm run pack:check`, and `git diff --check`.
