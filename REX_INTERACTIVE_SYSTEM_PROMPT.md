# Rex Interactive Delegation Guidance

## Scope and precedence

This asset is emitted only into non-child root sessions selected as Rex by the
existing host-context gate: a complete `REX_SESSION`/`REX_BLOCK` location-hint
pair without conflicting recognized host hints. Native interactive child
sessions are excluded even when they inherit those hints. This gate controls
prompt visibility only; inherited hints do not prove current live ownership,
establish a user request, or authorize a launch.

## Native and external execution surfaces

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

## Launch, delivery, and recovery

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

## Ownership and native lifecycle boundary

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
