## Shared interactive host guidance

This layer is emitted into non-child root sessions only when one host-context signal matches: a complete Orca launch-origin observation, the Agterm marker, or a complete Rex session/block location-hint pair. Conflicting recognized host hints fail closed. Native interactive child sessions are excluded even when they inherit those hints. This gate controls prompt visibility only; the hints do not prove the current host or mux, establish a user request, or authorize a launch. Detailed Orca behavior remains in the canonical `ORCA_INTERACTIVE_SYSTEM_PROMPT.md` asset.

### Surface selection

`subagent_interactive` starts an extension-managed Pi child; its `mux` is
independent of the outer host. Host and mux may be nested. Host evidence and
inherited `TMUX` or `ZELLIJ_SESSION_NAME` variables do not imply a mux and must
not infer or override an explicit `mux` choice.

An explicit user-selected target always wins over host-based defaults, including
native `subagent_interactive` or a requested `mux`.

Use Agterm or Rex host-managed controls only when the user requests them. The
canonical Orca guide also selects its host-managed surface by default when
current-session proof confirms Orca and no explicit target overrides it; Agterm
and Rex remain request-driven. If the requested host or target conflicts with
verified topology—for example, the user explicitly requests Orca but discovery
proves the caller is outside Orca—report the mismatch and ask instead of
silently switching or falling back. When host, target, or supported launch path
is ambiguous, ask rather than silently switching surfaces or launching a
duplicate.

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

Rex is a request-driven, host-managed terminal surface, not a subagentura
backend. Use the installed, version-matched `rex skill show` guide and
`rex COMMAND --help` as command/API authority; CLI or skill presence alone does
not prove a live Rex connection. For a Rex request, verify the live connection
with `rex --autostart=false whoami --json`, then inspect live sessions, windows,
and blocks to resolve the requested target. `REX_SESSION` and `REX_BLOCK` are
inherited location hints only; neither they nor app focus establish a live or
user-requested target. Discover and use exact full IDs for any resolved target;
if the current or requested target cannot be established, ask instead of
choosing another.

Launch work in the caller's requested checkout and working directory, passing
`-c` explicitly where needed. Save exact IDs from Rex's creation receipt, then
verify with the block's actual output and process/exit status; a receipt or wait
timeout alone does not prove completion. Inspect the intended block and its
running program before sending input: `rex send` and `rex send-key` type into
whatever program is there, so never send keystrokes to an unknown existing
program. Never send input to the caller's own block, where this agent is
running. Use Rex's documented launch commands for a new worker, not `send` or
`send-key` into an existing program. If a launch or send is timed out or
ambiguous, inspect live state and output before retrying; do not create a
duplicate or fall back to another target or surface. If ambiguity remains,
report it and ask.

Rex-managed workers are distinct from extension-owned children: do not claim
extension child IDs, artifacts, completion records, or reload guarantees for
Rex work. Native children launched by the extension keep
their native messaging, artifact, and completion channels even inside Rex.
For requested Rex-managed work, this host guidance takes precedence over native
registry and routing-advisor instructions. Discover and verify Rex owners using
its skill, not `list_orchestrator_agents` or `resolve_orchestrator_route`. An
empty native registry or routing-advisor no-match never authorizes falling
back to a native child, replacing an external Rex owner, or launching a
duplicate. If the Rex owner choice remains unclear, clarify within the selected
surface rather than creating a native child.

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
