---
title: "Herdr Core Multiplexer"
keywords: [herdr-core, hc, multiplexer, interactive, terminal]
---

# Herdr Core terminals

Start Pi with `herdr-core run pi` (or `hc run pi`), then use
`subagent_interactive` with `mux: "auto"` or `mux: "herdr-core"`.
Herdr Core is a separate backend from the older `herdr` multiplexer.
Install it from [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core).

Automatic selection requires `HC_TERMINAL_ID` and an absolute `HC_TERMINAL_SOCKET`,
then checks the live terminal's root PID against Pi's process ancestry on
macOS/Linux. Inherited selectors, a reachable socket, and a foreground process
alone do not prove ownership. An incomplete or stale context fails closed.
The injected owning socket takes precedence over `HC_SOCKET`, which is a CLI
override. `HC_SOCKET` is a fallback when no injected socket is available.
Explicit selection requires the same terminal/socket identity and validates it
before launch. No automatic detached fallback starts a core.

Children run in persistent bash terminals with unique names. Both `background`
values create a terminal: Core has no window/split layout API. Use the supervisor's
attach action or its generated `HC_SOCKET=... herdr-core attach t...` command to
view a child. Press Ctrl+\\ to detach. Structured focus and native overlays are
unavailable; attention and attached-client probes return unknown.

New terminals use the calling Pi session's `PATH` to find Pi and Node, even if
the Core service started with an older environment. Other parent environment
variables are not forwarded by the backend.

The backend persists each terminal ID and socket as `paneId` and `muxServer`.
Input, capture, cancellation, lineage, and reload/rehydration use that endpoint
even when the parent's environment changes. Children suppress Core's automatic
parent notes so Pi's existing artifact/completion protocol controls delivery.
They outlive the parent terminal to preserve the extension's reload/quit behavior;
fresh-session transitions and explicit cancellation still kill them normally.

The transport implements the public [generation-1 API](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md),
verified against Core 0.1.21. Literal input uses a short-lived framed attach with
DATA and a CLOSE acknowledgement; submitting Enter remains a separate operation.
It does not use `terminal.send`, which submits automatically. Socket reads,
response sizes, input sizes, and subprocess execution are bounded. Only explicit
`not_found` or a finished terminal proves death; connectivity/protocol failures
leave liveness unknown. Capture preserves Core's incomplete-read marker and
applies the requested line/byte limits locally. Core may return only the screen
while a full-screen program is working.

For a real-binary test, start a separate core with scratch `HC_SESSION`,
`HC_SOCKET`, and XDG directories, keeping its Unix socket inside your workspace.
Pass only that isolated endpoint as `HERDR_CORE_TEST_SOCKET` to
`npx vitest run tests/herdr-core.integration.test.ts`. Stop that test session
afterward. The regular suite includes wire-format and backend tests and skips
the real-binary test unless explicitly configured.
