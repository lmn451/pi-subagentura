---
name: pi-subagentura-debug
description: Diagnose pi-subagentura sub-agent launches, tool calls, working-directory and multiplexer problems, and artifact delivery. Use when a tool call fails, an interactive child fails before or after pane creation, `.pi/subagentura-state.json` cannot be read or mutated, an unsupported interactive state schema or persistence errors are reported, or completion/artifacts are missing.
level: beginner
---

# Debugging pi-subagentura

Use this skill for pi-subagentura tool failures, interactive children that fail to spawn or exit, unsupported state-schema or persistence errors, and missing completion or artifacts. If the skill is exposed but not loaded, explicitly invoke `/skill:pi-subagentura-debug`; skill discovery is model guidance, not a runtime error-interception hook. Gather the exact tool name, arguments, visible error, Pi version, and whether the call was in-process or interactive before changing settings.

## Inspect arguments and the loaded extension

See [Inspecting tool arguments in the README](../../README.md#inspecting-tool-arguments)
for the expanded-call behavior and its limits.

If the call still shows only its summary, follow the README's
[checkout instructions](../../README.md#testing-the-checkout-in-pi) to confirm
which extension source Pi loaded.

## Enable local debug logs

Use the README's [debug logging instructions](../../README.md#debug-logging) to
configure the log directory and understand which process produces each event.

Logs are appended to `debug-YYYY-MM-DD.jsonl`. Find the relevant records with:

```bash
jq -c 'select(.event == "extension_tool_call" or .event == "tool_start")' .pi-debug/debug-*.jsonl
```

Use each event's `event` and `timestamp` fields to follow a sequence.

## Interactive child starts and exits immediately

First inspect the parent tool call in `extension_tool_call`, especially its `cwd` value. The [README's debug logging section](../../README.md#debug-logging) documents the interactive working-directory validation contract.

Check the path from the Pi process environment:

```bash
pwd
ls -ld -- "$EXPECTED_CWD"
test -d "$EXPECTED_CWD" && test -x "$EXPECTED_CWD"
```

Confirm that the directory exists, is a directory, and can be traversed by the user running Pi. If the request refers to a newly created worktree, create it before spawning the child or pass the correct existing directory. Do not work around a bad `cwd` by opening another pane manually.

If the error still occurs with a valid path:

1. Record the exact tool name, `cwd`, error text, selected mux, and whether a pane was created. A spawn error before pane creation is a launch failure, not an immediate child exit.
2. Check that the selected multiplexer is available and that the child process can run Pi from that directory.
3. Use `get_interactive_subagent_status` and `list_subagent_artifacts` to inspect retained state; use `read_subagent_artifact` when an artifact reference is available.
4. Share the smallest redacted relevant log excerpt and the Pi/extension versions when reporting the issue.

`subagent_isolated` and `subagent_with_context` run in-process and do not create a multiplexer pane. For those, inspect the `extension_tool_call` parameters and returned error/result instead.

## Completion or output appears missing

For interactive children, inspect status and artifacts before retrying. A dead pane can still have useful artifact state. Distinguish a child that has not completed from one whose completion was recorded but whose delivery has not been consumed. Follow the tool's returned status and artifact references; do not infer completion from pane disappearance alone.

## Unsupported interactive state or persistence errors

`.pi/subagentura-state.json` is a per-working-directory recovery index, not the child process, artifact store, or Pi session history. For an unsupported schema/removed-field error or state read/write failure:

1. Stop retrying mutations. Record the exact error and Pi/extension versions; do not paste state-file contents or identifiers into a report.
2. If the file exists, make a private backup before cleanup. Never hand-edit schema versions, cursors, delivery intents, or receipts. The current reader preserves unsupported bytes and mutations fail closed; `/reload` and restarts do not migrate them.
3. Treat child liveness as unknown. A child whose record could not be loaded may still have a running pane or process and may be absent from status/artifact listings. Do not infer it is dead or spawn a duplicate solely because the registry cannot show it.
4. Do not use `/new` or deleting the state file as a repair. `/new` is destructive and can only attempt cleanup for panes enumerable in the current process scope; children hidden by unreadable state may remain. Deleting the index does not stop existing panes or processes, remove artifact directories, or delete Pi session histories; it discards records needed to rehydrate or poll those children.
5. Ask whether the user needs to preserve existing agents or state, and obtain explicit user confirmation before deleting the file, using `/new`, or performing another destructive reset. If legacy data needs inspection, retain a copy and consult the last release that supported it; the current runtime has no importer or migration tool.
