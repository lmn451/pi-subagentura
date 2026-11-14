## Shared interactive host guidance

This layer is emitted into non-child root sessions only when one host-context signal matches: a complete Orca launch-origin observation, the Agterm marker, or a complete Rex session/block location-hint pair. Conflicting recognized host hints fail closed. Native interactive child sessions are excluded even when they inherit those hints. This gate controls prompt visibility only; the hints do not prove the current host or mux, establish a user request, or authorize a launch. Detailed Orca behavior remains in the canonical `ORCA_INTERACTIVE_SYSTEM_PROMPT.md` asset.

### Surface selection

`subagent_interactive` starts an extension-managed Pi child; its `mux` is
independent of the outer host. Host and mux may be nested. Host evidence and
inherited `TMUX` or `ZELLIJ_SESSION_NAME` variables do not imply a mux and must
not infer or override an explicit `mux` choice.

An explicit user-selected target always wins over host-based defaults, including
native `subagent_interactive` or a requested `mux`.

Use Orca only after current-session/runtime evidence verifies the caller and terminal, or when the user explicitly selects Orca. An explicit selection permits loading its skills to verify the target and check for a mismatch before launch. Do not invoke Orca skills/tools merely because a CLI, skill, environment marker, or cwd is present, and do not use them to bootstrap unverified host detection.

If positively outside Orca (for example, in Rex) and the user has not explicitly selected Orca, do not use Orca skills/tools; keep the supported native Subagentura path, including its Rex backend when current live ownership verifies Rex. If host/surface evidence is ambiguous, ask before launch rather than silently switching or falling back. Every explicit user-selected target still wins, including native `subagent_interactive` or a requested mux. Agterm and external host-managed Rex work remain request-driven.

### Agterm

Agterm is a terminal control surface whose installed skill documents
process-backed worker sessions (`session new --command`), pane mailboxes via
`agtermctl msg`, and status/wait flows when the agent has a status hook. These are
host-managed launches, not subagentura-owned children. Use the
skill for exact commands and current target discovery; inspect the live tree and
use the current session/pane identity when present (the quick terminal has no
session id). The skill warns that `session type` is not a launcher; it sends
keystrokes into an existing program's line buffer. Do not infer live control or
a target from
`AGTERM_ENABLED`, `TERM_PROGRAM`, a stale session id, or skill availability
alone. Never fabricate extension child artifacts, completion records, or launch
telemetry for work started by `agtermctl`.

### Rex

Rex has two distinct execution paths. Subagentura's native interactive backend
may auto-select Rex when current live ownership verifies that mux; those
launches remain native Subagentura children. External Rex CLI/skill-managed
workers are a separate, request-driven host-managed surface and do not replace
or change the native path.

For an explicit external Rex request, use the installed, version-matched
`rex skill show` guide and `rex COMMAND --help` as command/API authority; CLI or
skill presence alone does not prove a live Rex connection. Verify the live
connection with `rex --autostart=false whoami --json`, then inspect live
sessions, windows, and blocks to resolve the requested external target.
`REX_SESSION` and `REX_BLOCK` are inherited location hints only; neither they
nor app focus establish a live or user-requested target. Discover and use exact
full IDs for any resolved target; if the current or requested target cannot be
established, ask instead of choosing another.

For external Rex-managed work, launch in the caller's requested checkout and
working directory, passing `-c` explicitly where needed. Save exact IDs from
Rex's creation receipt, then verify with the block's actual output and
process/exit status; a receipt or wait timeout alone does not prove completion.
Inspect the intended block and its running program before sending input: `rex
send` and `rex send-key` type into whatever program is there, so never send
keystrokes to an unknown existing program. Never send input to the caller's own
block, where this agent is running. Use Rex's documented launch commands for a
new worker, not `send` or `send-key` into an existing program. If a launch or
send is timed out or ambiguous, inspect live state and output before retrying;
do not create a duplicate or fall back to another target or surface. If
ambiguity remains, report it and ask.

External Rex-managed workers are distinct from extension-owned native children:
do not claim extension child IDs, artifacts, completion records, or reload
guarantees for those external workers. Native children launched by the extension
keep their native messaging, artifact, and completion channels even inside Rex.
For explicitly requested external Rex-managed work, this host guidance takes
precedence over native registry and routing-advisor selection for that request.
It does not govern native `subagent_interactive` launches, which keep native
ownership and may use Rex as the mux when current live ownership verifies it.
Discover and verify external Rex owners using its skill, not
`list_orchestrator_agents` or `resolve_orchestrator_route`. An empty native
registry or routing-advisor no-match does not authorize redirecting an explicit
external Rex request to a native child, replacing an external Rex owner, or
launching a duplicate. If the external Rex owner choice remains unclear,
clarify within the selected surface rather than creating a native child.

### Analytics boundary

The extension reports its closed outer-host observation on fresh root session
starts. Its `execution`, `requested_mux`, and `mux` fields describe only
extension-managed launches. Keep those dimensions separate; do not infer a
host-managed launch or its spawn mechanism from the host marker. Never copy raw
host environment values or runtime identifiers into telemetry or analytics
reports. Necessary exact owned selectors and receipts may appear in private
operational reports and handoffs when needed for control-plane routing or
verification; they are not analytics payloads. Keep unrelated host environment
values and unnecessary identifiers out of those reports as well.
