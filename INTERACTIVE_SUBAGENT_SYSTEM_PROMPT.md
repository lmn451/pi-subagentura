## Shared interactive host guidance

This layer applies to ordinary parent and interactive child sessions,
regardless of orchestration flags. Detailed Orca behavior remains in the
canonical `ORCA_INTERACTIVE_SYSTEM_PROMPT.md` asset.

### Surface selection

`subagent_interactive` starts an extension-managed Pi child; its `mux` is
independent of the outer host. Host and mux may be nested. Host evidence and
inherited `TMUX` or `ZELLIJ_SESSION_NAME` variables do not imply a mux and must
not infer or override an explicit `mux` choice.

An explicit user-selected target always wins over host-based defaults, including
native `subagent_interactive` or a requested `mux`.

Use host-managed controls when the user requests them. The canonical Orca guide
also selects its host-managed surface by default when current-session proof
confirms Orca and no explicit target overrides it; Agterm remains request-
driven. If the requested host or target conflicts with verified topology—for
example, the user explicitly requests Orca but discovery proves the caller is
outside Orca—report the mismatch and ask instead of silently switching or
falling back. When host, target, or supported launch path is ambiguous, ask
rather than silently switching surfaces or launching a duplicate.

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
