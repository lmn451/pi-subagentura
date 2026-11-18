---
title: "Herdr Core interactive sub-agents"
keywords:
  [herdr-core, Herdr Core, hc, interactive sub-agents, terminal ownership]
---

# Herdr Core interactive sub-agents

Herdr Core (`hc`) is a separate backend from classic Herdr (`herdr`). This
integration was tested with Herdr Core 0.1.21 on macOS. Start Pi **inside a
local Core terminal**, with `hc`, `pi`, and `node` on your PATH. Use automatic
selection or set `mux: "herdr-core"`. Leave `background` at its default `true`.

```json
{
  "task": "Review the latest changes and report findings.",
  "mux": "herdr-core"
}
```

The `HC_TERMINAL_ID` and `HC_TERMINAL_SOCKET` markers identify a candidate.
The extension checks the local socket, the live terminal address and program PID,
and Pi's process ancestry and controlling terminal. It does not use the active
window or working directory as ownership evidence. If Core evidence is stale,
incomplete, or ambiguous, automatic selection refuses the launch instead of
starting a child in tmux or Zellij. Identity checks use a read-only socket
request; they do not start a Core on a stale socket. An explicit `herdr-core`
selection still requires proof. Remote addresses are not supported.

The extension starts the Pi wrapper directly in a new Core terminal in the
requested working directory. It passes only the parent PATH as an environment
override to the program; other values come from Core and the normal Pi launch
files. Standalone children can outlive the parent terminal and be rehydrated in
the same Pi session. Workflow children do not outlive their parent terminal;
Pi also cleans them up on workflow/session shutdown.

Use the returned attach command to watch or interact with the child. It checks
that the original local Core still owns the terminal address before invoking
`hc attach`. Press *_Ctrl+\*_ to detach. You can also use Pi's status, follow-up,
cancel, and artifact tools. Core does not provide visible splits, structured
focus, current-pane activity, or supervisor terminal capture in this integration.

## Diagnose a launch

- **Context refused**: Start Pi in a live local Core terminal. A copied terminal
  marker, a remote address, or an attached viewer outside that terminal is not
  sufficient.
- **Allocation unconfirmed**: Check `hc server status` and `hc ls --all` on the
  original Core before retrying. A command timeout can leave a terminal allocated
  even if Pi did not receive its address.
- **Terminal exited before the first turn**: Check that both `pi` and `node`
  resolve on the parent Pi PATH. Use `get_interactive_subagent_status` for the
  exit code, if available. A terminal exit is not proof that a provider failed.
- **A turn started but has no result**: Use `read_subagent_artifact` to check the
  requested turn. The terminal and its protocol-v2 result are separate: terminal
  output, an exit code, or a successful attach does not substitute for a result.

See [Ownership boundaries](ownership.md) for artifact and session authority.

## Verify the local integration

With `hc` installed, run the optional local smoke test:

```sh
PI_SUBAGENTURA_TEST_HERDR_CORE=1 npx vitest run tests/herdr-core.integration.test.ts
```

The test uses its own short Unix socket, session name, HOME, and XDG directories.
It does not use your existing Core server or terminals.
