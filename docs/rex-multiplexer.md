---
title: "Rex Multiplexer"
keywords: [rex, multiplexer, interactive, terminal, capture]
---

# Superlogical Rex multiplexer

`rex` is a supported internal backend for `subagent_interactive`; it does not
replace the extension's native child lifecycle, registry, artifacts, completion,
cancellation, or reload/rehydration behavior. The child remains a native
pi-subagentura child, with its Rex block treated only as the terminal transport.

## Selection and safety

An explicit `mux` value overrides automatic detection, while retaining that
backend's own launch validation. With `mux: "auto"`, inherited environment
markers identify candidate panes, not a fixed backend priority. Bounded live
backend queries and a process ancestry/TTY snapshot must tie a candidate pane
to the current Pi process. In nested muxes the nearest verified owner wins.
Equally close matches, stale selectors, missing proof, or an unverified nearer
mux fail closed rather than selecting an unrelated or outer backend. Current
UI focus is not evidence that a pane owns this process.

Rex candidates require the complete `REX_SESSION`, `REX_BLOCK`, and `REX_SERVER`
context. Backend validation also checks the CLI's documented help contract,
confirms `rex whoami --json` reports the same session and block, and verifies the
block is present in that session's JSON listing. A Rex process ancestor is
classified as Rex, not Herdr. Neither a reachable server nor inherited Rex
markers alone establish ownership of the current process.

A partial/malformed Rex context, an unsupported Rex CLI contract, or a failed
live probe is an error; automatic selection does not fall through to another
multiplexer. `TERM_PROGRAM=rex` alone is not sufficient to launch, but it is a
recognized host hint: without a verifiable Rex context, auto selection fails
closed instead of silently choosing an unrelated backend. An explicit Rex
choice outside a verified live Rex context also fails clearly; the backend does
not create an unrelated default Rex session. With no recognized host context,
the existing relaxed tmux-then-Zellij fallback remains unchanged.

Rex block IDs, session IDs, and the canonical server endpoint are persisted on
interactive state and lineage records. Every later focus, send, capture, liveness,
and cancellation operation uses those saved values rather than ambient Rex
variables, so a reload cannot redirect an old child to a different server.

## Live ownership evidence and limits

Automatic detection reads a bounded process snapshot on macOS and Linux, then
queries candidate backends without creating panes or starting servers.
Current-pane activity uses asynchronous process inspection and concurrent bounded
backend queries, so slow inherited backends do not block Pi's event loop.
Synchronous launch discovery uses the same validation and response parsers. tmux's
pane PID and TTY, Herdr's shell PID, and a local Rex block's child/foreground PID
are compared with this process's ancestry. Rex endpoints that do not identify a
local Unix socket cannot supply comparable local PIDs for automatic detection.

Zellij's public `list-panes --json` does not expose the pane PID. Detection checks
that the selected terminal pane exists and that the nearest recognized mux
process ancestor is Zellij. This verifies the enclosing mux type, not the exact
pane-to-PID association if same-mux session or pane markers were overwritten.
Unsupported CLI responses, unavailable process evidence, and unresolved host
conflicts require an explicit `mux` choice rather than a guessed backend.

## Verified and unavailable capabilities

- **Structured focus:** supported using the documented Rex block/session target.
- **Liveness:** tri-state, based on the public JSON block listing. Command or
  response failures remain `unknown`, never a false `dead` result.
- **Capture:** Rex exposes screen plus scrollback without a server-side byte or
  line limit. The backend sets a 1 MiB subprocess `maxBuffer` and then applies
  the requested line/byte limits. If Rex output exceeds that hard read ceiling,
  capture rejects rather than returning a stale prefix or buffering more data.
- **Current-user activity / attached client:** `unknown` / unavailable. The
  public CLI does not provide a verified focused-client probe. User-attention
  decisions must remain conservative when activity is unknown.
- **Native content viewer:** unavailable.

The backend uses documented public CLI operations: `rex run --json`, `rex send`
(stdin for literal text), `rex send-key enter`, `rex block ls --json`, `rex
capture --trim`, `rex focus`, and `rex block close`. Arguments are passed as
argv, with bounded subprocess timeouts. The available command/flag contract is
checked before auto-selection.

Rex being the outer terminal host and `mux: "rex"` being the selected child
backend are distinct observations. Runtime routing never uses telemetry. The
closed child `mux` and `requested_mux` dimensions can report `rex`; the
measurement-only `parent_mux` value records only a complete Rex environment
marker set and resolves nested/multiple markers to `unknown`.

## Public references

- [The CLI](https://www.superlogical.com/rex/docs/automate/cli) — context
  variables, stable IDs, targets, and machine-readable output.
- [CLI Commands](https://www.superlogical.com/rex/docs/reference/cli) — command
  syntax and flags, including `run`, `send`, `capture`, `focus`, and `block`.
- [Server API](https://www.superlogical.com/rex/docs/automate/server-api) —
  version-matched JSON schemas and response shapes.

Unit tests mock the public CLI and cover argument safety, selection, fail-closed
routing, bounds, persistence, and reload state. Any real-binary integration
must be opt-in and use an isolated Rex session; it must never create or operate
on a user's working session.
