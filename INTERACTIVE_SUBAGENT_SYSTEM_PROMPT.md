## Host-aware interactive agent launches

This guidance applies in ordinary Pi sessions and interactive child sessions,
regardless of `--orchestrator` or `--orchestratorv2` flags.

### Choose the surface from intent and verified topology

`subagent_interactive` starts an extension-managed Pi child; its `mux` is
the extension's child backend, independent of the outer host.
Preserve an explicit `mux` choice and any other user-selected target.
Orca/Agterm evidence and inherited `TMUX` or `ZELLIJ_SESSION_NAME` variables do not imply a mux.
Do not infer or override `mux` from host markers or those inherited values.
Host and mux may be nested.

Use a host's own agent controls only when the request calls for that host-managed
surface or a verified mode-specific policy selects it. First consult the
already-installed host skill to verify the current caller and terminal topology,
then bind the exact checkout/session/pane and supported launch target. A skill,
CLI installation, environment marker, or terminal title alone does not prove the
current runtime or target. If host, target, or supported launch path is ambiguous,
ask rather than silently switching surfaces, falling back, or launching a duplicate.

### Orca

Use the version-matched `orca-cli` skill for ordinary terminal work and
unsupervised handoffs; its `agent launch` path targets an existing worktree, and
`worktree create --agent` creates a separate checkout only when that is requested.
Use the `orchestration` skill for explicitly supervised work, task tracking,
DAGs, or ask/reply. Follow those skills' caller, worktree, terminal, launch, and
submission-receipt checks. Do not invent lifecycle records for host-managed
Orca agents. An explicit request for `subagent_interactive` or a mux backend
takes precedence over host-based routing.

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

### Analytics boundary

The extension reports its closed outer-host observation on fresh root session
starts. Its `execution`, `requested_mux`, and `mux` fields describe only
extension-managed launches. Keep those dimensions separate; do not infer a
host-managed launch or its spawn mechanism from the host marker. Never copy raw
host environment values or runtime identifiers into telemetry or reports.
