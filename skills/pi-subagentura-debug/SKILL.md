---
name: pi-subagentura-debug
description: Diagnose pi-subagentura sub-agent launches, tool calls, missing working directories, multiplexer panes, and artifact delivery. Use when behavior is unexpected or a sub-agent starts then exits.
level: beginner
---

# Debugging pi-subagentura

Use this skill when a pi-subagentura tool behaves unexpectedly, an interactive child exits immediately, or completion/artifact delivery is unclear. Gather the exact tool name, arguments, visible error, Pi version, and whether the call was in-process or interactive before changing settings.

## Inspect arguments and the loaded extension

Press **Ctrl+O** (Pi's default tool-output expansion shortcut) to show the
**Parameters:** JSON block for pi-subagentura calls. It shows the supplied
arguments, not omitted schema defaults, and does not require debug logging.

If an expanded call still shows only its summary, check the enabled extension
source with `pi list` and `pi config`. Editing a checkout does not update a
separately installed npm package. Load the checkout and disable the npm
extension before reloading; collect running in-process/workflow results first
because `/reload` cancels those jobs.

This skill and the expanded parameter/logging additions are unreleased branch
features, not features shipped in npm version 3.6.4. The branch packages this
skill under `skills/pi-subagentura-debug/`, but its current `pi` manifest declares
only the extension. A plain package source does not automatically expose the
skill; load it explicitly with `pi --skill ./skills/pi-subagentura-debug` from the
checkout, then use `/skill:pi-subagentura-debug`.

## Enable local debug logs

Set `SUBAGENT_DEBUG_LOG_DIR` before starting Pi. It must be a directory path; the logger is inactive when it is unset.

```bash
mkdir -p .pi-debug
SUBAGENT_DEBUG_LOG_DIR="$PWD/.pi-debug" pi
```

Logs are appended to `debug-YYYY-MM-DD.jsonl`. Find the relevant records with:

```bash
jq -c 'select(.event == "extension_tool_call" or .event == "tool_start")' .pi-debug/debug-*.jsonl
```

- `extension_tool_call` records `toolName` and full `args` for pi-subagentura tool executions in the Pi process where the extension is loaded.
- `tool_start` records `toolName` and full `args` for tools invoked by **in-process** sub-agents.
- Other events record lifecycle and polling diagnostics; use their `event` and `timestamp` fields to follow a sequence.

For **interactive children**, set `SUBAGENT_DEBUG_LOG_DIR` in the multiplexer
session/server or the child's shell environment before spawning. The generated
launch script does not explicitly export it; do not assume an inline parent
setting reaches a new pane. Use an absolute path because the child's working
directory may differ. This enables local extension diagnostics in that child,
not logging of every built-in tool it invokes.

These logs can contain task/persona text, paths, and identifiers. Keep them local and private; redact them before sharing. They are local diagnostics, not anonymous telemetry.

## Interactive child starts and exits immediately

First inspect the parent tool call in `extension_tool_call`, especially its `cwd` value. The interactive launcher now checks the resolved working directory before creating a tmux, Zellij, or Herdr pane. A missing path or a path that names a file should return a clear error and should not create a pane.

Check the path from the Pi process environment:

```bash
pwd
ls -ld -- "$EXPECTED_CWD"
test -d "$EXPECTED_CWD" && test -x "$EXPECTED_CWD"
```

Confirm that the directory exists, is a directory, and can be traversed by the user running Pi. If the request refers to a newly created worktree, create it before spawning the child or pass the correct existing directory. Do not work around a bad `cwd` by opening another pane manually.

If the error still occurs with a valid path:

1. Record the exact tool name, `cwd`, error text, selected mux, and whether a pane was created.
2. Check that the selected multiplexer is available and that the child process can run Pi from that directory.
3. Use `get_interactive_subagent_status` and `list_subagent_artifacts` to inspect retained state; use `read_subagent_artifact` when an artifact reference is available.
4. Share the smallest redacted relevant log excerpt and the Pi/extension versions when reporting the issue.

`subagent_isolated` and `subagent_with_context` run in-process and do not create a multiplexer pane. For those, inspect the `extension_tool_call` parameters and returned error/result instead.

## Completion or output appears missing

For interactive children, inspect status and artifacts before retrying. A dead pane can still have useful artifact state. Distinguish a child that has not completed from one whose completion was recorded but whose delivery has not been consumed. Follow the tool's returned status and artifact references; do not infer completion from pane disappearance alone.
