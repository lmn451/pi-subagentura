# Failure diagnostics

This guide explains the local diagnostic codes shown by interactive artifact and
workflow results. Codes describe structured evidence, not a provider's exact
message or a guaranteed root cause. Detailed user-visible error text remains in
the local artifact/result; anonymous telemetry never sends that text.

## Failure codes

| Code                       | Evidence                                                                                                     | What to check                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_error`           | First-slice coverage: Pi reports a structured provider/assistant error stop.                                 | Check provider credentials, model availability, and service status. This code does not identify authentication/rate-limit/provider subcodes; exact provider text remains local. |
| `workflow_schema_invalid`  | A typed workflow schema definition or output-validation branch failed.                                       | Review the schema and expected output shape; align the agent's response with that contract.                                                                                     |
| `workflow_timeout`         | The workflow runner's typed wall-clock timeout fired.                                                        | Reduce the workflow scope or split slow work into smaller runs.                                                                                                                 |
| `workflow_capacity_limit`  | The typed workflow agent-attempt lifetime cap was reached.                                                   | Split the workflow or remove redundant agent calls. Retained-job capacity has separate failure reporting.                                                                       |
| `interactive_process_exit` | An interactive child process exit was observed; this code alone does not say whether its task had completed. | Inspect the local supervisor artifact and child session output, then retry the task. Use process phase/kind to distinguish early exit from later teardown.                      |
| `unknown`                  | No recognized structured failure evidence was available.                                                     | Inspect local error and artifact details; do not infer a cause from anonymous telemetry.                                                                                        |

## Interactive process context

`task_completed` keeps the lifecycle outcome (`status` and `terminal_reason`)
separate from process context. For `terminal_reason=process_exit` only, telemetry
may include these closed values:

- `process_exit_phase`: `active_tool`, `active_turn`, `after_completion`, or
  `unknown`.
- `process_exit_kind`: `normal`, `nonzero`, `signal`, `cancelled`, or `unknown`.

If an authoritative successful completion is recorded before a later nonzero
process exit, remote `task_completed` remains `success`; the `after_completion`
exit stays local process context and does not create or count another task failure.

The phase says what the child was doing when the wrapper observed exit; it does
not prove that the active tool caused the exit. A signal is reported only when
its source is authoritative. Shell `$?` alone is not enough to distinguish a
signal from a program that explicitly returned a signal-like numeric code. The
local artifact may also show its closed `terminationReason` when available.

`read_subagent_artifact` and `get_workflow_result` show the matching static code
explanation and suggested action. Expanded supervisor details show the literal
code and compact process context; this runbook maps those values to next steps.
Tool names, call IDs, arguments, output, paths, and session identifiers are never
added to remote telemetry.

## Telemetry privacy and opt-outs

Schema v4 shipped in 3.6.2. Schema v5 adds only the closed failure-code and
process-exit context dimensions described above. Failure codes are assigned from
typed or otherwise structured source evidence; error text is never parsed to
select a code. Invalid codes/categories become `unknown`; invalid optional
process context is omitted. `failure_code` is present only for `error` task
status and `error`/`partial` workflow status. Cancellation is not an error. The
existing telemetry opt-outs and their precedence are unchanged.
