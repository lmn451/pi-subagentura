---
name: pi-subagentura-debug
description: Diagnose pi-subagentura sub-agent launches, tool calls, working-directory and multiplexer problems, and artifact delivery. Use when a tool call fails, an interactive child fails before or after pane creation, `.pi/subagentura-state.json` cannot be read or mutated, an unsupported interactive state schema or persistence errors are reported, or completion/artifacts are missing, including suspected nested-Pi artifact-identity contamination.
level: beginner
---

# Debugging pi-subagentura

Use this skill for pi-subagentura tool failures, interactive children that fail to spawn or exit, unsupported state-schema or persistence errors, and missing completion or artifacts. If the skill is exposed but not loaded, explicitly invoke `/skill:pi-subagentura-debug`; skill discovery is model guidance, not a runtime error-interception hook. Gather the exact tool name, arguments, visible error, Pi version, and whether the call was in-process or interactive before changing settings.

## Root-cause workflow

1. State the exact symptom and expected behavior; record exact versions and meaningful ambient inputs.
2. Before proposing a fix, seek a minimal safe reproduction in an isolated scratch/test context, with a control when useful.
3. At the first failing boundary, list plausible causes and choose distinguishing observations. Change one factor at a time; record each as supported, ruled out, or still untested, with evidence.
4. A recovered rerun, correlation, vanished error, or workaround does not establish root cause. Verify that a suspected cause explains the observed failure; where safe, show the same reproduction failing before and passing after an isolated correction. Do not risk live state or exhaustively test unrelated possibilities.
5. If reproduction or verification is blocked, say **root cause unconfirmed**, name the exact blocker, evidence collected or ruled out, and the next discriminating check; do not guess or default to restart advice.

## Inspect arguments and the loaded extension

In the Pi terminal UI, press **Ctrl+O** to expand the tool call. The
**Parameters:** block shows the arguments supplied to the tool. It does not
show omitted defaults.

If the block is missing, check `pi list` and `pi config` after you verify that
your Pi version supports them. Confirm the enabled extension path and package
version. A source checkout and an installed npm package are separate copies.

## Enable local debug logs

Before starting a scratch Pi process, set `SUBAGENT_DEBUG_LOG_DIR` to a private
absolute directory. For an interactive child, set it in the isolated
multiplexer environment that starts the child. A setting on the parent Pi
command does not necessarily reach the child.

The extension appends logs to `debug-YYYY-MM-DD.jsonl`. `extension_tool_call`
records calls to this extension in the Pi process that loaded it. `tool_start`
records tools that in-process subagents call. Logs can contain prompts and
arguments. Keep them private. For example, if the log directory is `.pi-debug`:

```bash
jq -c 'select(.event == "extension_tool_call" or .event == "tool_start")' .pi-debug/debug-*.jsonl
```

Use each event's `event` and `timestamp` fields to follow a sequence.

## Interactive child launch triage

Do not blame the host/backend or ask for a restart before locating the failure
boundary. Do not stop/restart anything or launch a probe child in a live Core,
Herdr, or other terminal.

1. **Capture the invocation and provenance.** Expand the Pi-subagentura tool
   call with Ctrl+O; record the tool name, exact supplied arguments, error,
   whether a terminal was allocated, Pi version, package version, and loaded
   extension source. Check the installed Pi help before using `pi list` or
   `pi config`. Ctrl+O shows supplied arguments, not
   omitted defaults. In versions where `mux` defaults to `auto`, note whether
   it was omitted or explicitly set.
2. **Prove process and terminal identity.** From read-only process inspection
   of the affected Pi PID and its ancestry, record PID, PPID, TTY, and command
   name. On Darwin/Linux, the runtime's process snapshot uses
   `ps -axo pid=,ppid=,tty=,comm=`; follow PPID links from the affected Pi PID.
   Keep raw output private. Check optional host markers by presence only, not
   by value: for example `HC_TERMINAL_ID` / `HC_TERMINAL_SOCKET`, `HERDR_ENV` /
   `HERDR_SOCKET_PATH` / `HERDR_PANE_ID`, and relevant `TMUX*`, `ZELLIJ*`,
   `REX_*`, or `WEZTERM_*` selectors. Check the installed host CLI version and
   help before using a query; use only its documented read-only query for the
   inherited terminal. Confirm that its reported live PID matches the Pi
   process or an ancestor in the observed process chain; compare TTY where
   available. If ownership cannot be tied to the process chain, report it as
   unproven. Do not share marker values, full environments, prompt-bearing
   arguments, or terminal identifiers.
3. **Separate UI brand from runtime backend.** A Core window or Core marker
   does not prove that pi-subagentura selected the Herdr backend. Record the
   explicit `mux` value or that it was omitted; verify the loaded extension's
   selector/API and the live PID/TTY proof. Auto selection and an explicit
   backend request are different paths. An explicit `mux=herdr` context error
   does not prove that auto selected Herdr. Do not assume Core and classic
   Herdr use the same CLI or protocol.
4. **Locate the failing stage.**
   - No terminal was created: confirm this from the launch result, not from a
     terminal's current absence. If confirmed, the call failed before backend
     allocation; inspect its arguments, `cwd`, and launch context. This is not
     a child-process exit.
     Check the supplied `cwd` from the affected Pi environment, replacing the
     placeholder below with the exact supplied path:

     ```bash
     pwd
     ls -ld -- "$EXPECTED_CWD"
     test -d "$EXPECTED_CWD" && test -x "$EXPECTED_CWD"
     ```

     If the path is a new worktree, create it before spawning. Do not work
     around a bad `cwd` by opening another pane manually.

   - Terminal allocated, but Pi did not open or no child turn began: allocation
     succeeded. Inspect the existing wrapper/launcher result and the runtime
     available in that launch environment (including `node`/`PATH`); do not
     assume the multiplexer failed. An exit code alone may not identify why.
   - Pi opened: use `get_interactive_subagent_status` and
     `list_subagent_artifacts`; use `read_subagent_artifact` when a reference is
     available. Distinguish a running child, recorded completion, and parent-side
     delivery/consumption. For suspicious output, compare the child's persisted
     user-entry identity with `turnId` in `turn_started` and `completion`, in
     physical NDJSON order. Timestamps do not establish identity or order.

For a report, give only the minimal evidence chain: versions and loaded source →
tool and redacted arguments/mux choice → marker presence and PID/TTY ownership
result → terminal allocation → wrapper/child-start status and exit code →
turn/completion/delivery state. Name the next missing observation. Keep raw
traces, prompts, credentials, full environments, and identifiers private. For
controlled reproductions, save the original mux selectors and `PATH`. Set or
unset them for each case. Restore the original values after the test, even if
the test fails. Do not test against a live user terminal or mux server.

If the failure occurred with an installed extension, reproduce it with the
same npm package version in a temporary Pi profile, project, and mux session.
To test a release candidate, install its `npm pack` archive. Confirm that Pi
loads the installed package, not the source checkout or a second copy. Use the
registered `subagent_interactive` tool and a mock provider. Verify terminal
allocation, the first `turn_started` event, and successful `completion` with
the same `turnId` and expected saved output. Record the last stage that passed.

`subagent_isolated` and `subagent_with_context` run in-process and do not create
a multiplexer pane. For those, inspect the `extension_tool_call` parameters and
returned error/result instead.

## Completion or output appears missing

For interactive children, inspect status and artifacts before retrying. A dead pane can still have useful artifact state. Distinguish a child that has not completed from one whose completion was recorded but whose delivery has not been consumed. Follow the tool's returned status and artifact references; do not infer completion from pane disappearance alone.

## Nested Pi process contaminates child artifacts

Older versions had an artifact-ownership gap. A nested
`pi --no-session --mode json --print` process started by an interactive child
could inherit `PI_SUBAGENTURA_CHILD=1` and `ARTIFACT_DIR`. The nested process
could register lifecycle hooks against the outer child's artifacts, replace its
active turn, and append a false `done` completion with zero-byte output. The
parent might consume that completion and cancel the real child before its
handoff. An empty snapshot does not establish provider, authentication, or
model failure. Treat an earlier authentication error as separate unless
independent evidence links it.

For retained historical cases:

1. Start from the parent session's reference to the interactive child, then
   compare the parent and child Pi session histories. The parent history may
   show launch, messages, artifact reads, or cancellation; the child history
   may show a Bash/Python subprocess starting nested Pi. A nested
   `--no-session` process may have no persisted Pi session of its own.
2. Compare the child's persisted user-entry identity with `turnId` in artifact
   `turn_started` and `completion` events, and inspect the captured output. A
   completion without a matching persisted child turn is evidence of an
   artifact-identity or lifecycle mismatch; it does not prove the nested
   process produced an answer.
3. Read artifact NDJSON events in physical file order. Use `eventId` plus the
   Pi-derived `turnId` to associate a completion with its output snapshot.
   Timestamps are display/TTL metadata; they do not establish order or identity.
4. If the child launched nested JSON-print Pi, check the recorded Bash/Python
   subprocess call and wrapper's temporary-file setup for a JSON trace path. A
   trace may be in a temporary location or removed by an `EXIT` trap. Preserve
   any surviving trace privately; its absence is inconclusive.

Do not paste raw session JSONL, prompts, assistant/provider output, credentials,
or user-specific paths into a report. Report only whether child-turn and
artifact identities matched, the physical event order, and whether a trace was
retained.

Current versions use an artifact-specific, one-use bootstrap that the child
consumes before registering lifecycle hooks. `PI_SUBAGENTURA_CHILD` and
`ARTIFACT_DIR` alone do not grant authority. Artifact ownership and recursive
lineage use separate bootstraps; lineage expires after 60 seconds and does not
grant artifact ownership.
This prevents accidental environment inheritance; it is not an OS security
boundary against malicious code running as the same user. Historical artifacts
may still need investigation. This skill is guidance; it does not add automatic
logging or repair.

## Unsupported interactive state or persistence errors

`.pi/subagentura-state.json` is a per-working-directory recovery index, not the child process, artifact store, or Pi session history. For an unsupported schema/removed-field error or state read/write failure:

1. Stop retrying mutations. Record the exact error and Pi/extension versions; do not paste state-file contents or identifiers into a report.
2. If the file exists, make a private backup before cleanup. Never hand-edit schema versions, cursors, delivery intents, or receipts. The current reader preserves unsupported bytes and mutations fail closed; `/reload` and restarts do not migrate them.
3. Treat child liveness as unknown. A child whose record could not be loaded may still have a running pane or process and may be absent from status/artifact listings. Do not infer it is dead or spawn a duplicate solely because the registry cannot show it.
4. Do not use `/new` or deleting the state file as a repair. `/new` is destructive and can only attempt cleanup for panes enumerable in the current process scope; children hidden by unreadable state may remain. Deleting the index does not stop existing panes or processes, remove artifact directories, or delete Pi session histories; it discards records needed to rehydrate or poll those children.
5. Ask whether the user needs to preserve existing agents or state, and obtain explicit user confirmation before deleting the file, using `/new`, or performing another destructive reset. If legacy data needs inspection, retain a copy and consult the last release that supported it; the current runtime has no importer or migration tool.
