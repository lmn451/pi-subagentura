---
title: "Terminal E2E Tests"
keywords:
  [terminal, e2e, tmux, tui, harness, test:tui, recording, wezterm, determinism]
---

# Terminal E2E tests

`npm run test:tui` drives the **real Pi CLI** inside an isolated tmux PTY and
asserts on what it actually paints. It is the regression source of truth for
extension registration, tool rendering, async notifications, workflow progress,
the supervisor overlay, and keyboard interaction.

```bash
npm run test:tui          # the terminal suite (needs tmux >= 3.2 and the Pi CLI)
npm test                  # unit suite; includes the provider/network-guard contracts
```

## How to run

Requirements:

- **tmux >= 3.2.** The generated config sets `extended-keys on`, which does not
  parse on older versions; the harness asserts the floor with a named error
  instead of letting `new-session` die on an opaque config error.
- **`fd` and `ripgrep`.** Pi 0.80.6 uses these commands to discover explicitly
  loaded resources for the startup screen. CI installs `fd-find` and `ripgrep`
  and exposes Ubuntu's `fdfind` binary as `fd`.
- **The Pi CLI.** Resolved from `node_modules/.bin/pi`, then `PATH`, then
  `SUBAGENTURA_E2E_REAL_PI`. Because `node_modules/.bin/pi` is a
  `#!/usr/bin/env node` script, the harness also asserts that the child
  environment can exec `node` before starting a pane.

Useful environment variables:

| Variable                      | Effect                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `SUBAGENTURA_E2E_REAL_PI`     | Absolute path to the Pi binary under test.                         |
| `SUBAGENTURA_E2E_DIAGNOSTICS` | Where failure diagnostics are written (default: the harness temp). |

Each harness picks its own tmux socket (`pid` + random), so nothing needs a
socket name from the outside and parallel runs cannot collide.

## Architecture

| Path                                        | Role                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `harness.mjs`                               | tmux server/session lifecycle, screen capture, waits, teardown. |
| `harness.d.mts`                             | Types for the harness (kept in step with the `.mjs`).           |
| `scenarios.mjs`                             | Prompt/marker/gate/expectation table for each scenario.         |
| `fixtures/mock-provider.ts`                 | Scripted provider: no LLM, no HTTP, file-gated child turns.     |
| `fixtures/deny-network.cjs`                 | `NODE_OPTIONS` preload that denies Node network APIs.           |
| `fixtures/pi-child-wrapper.sh`              | `pi` shim on the child `PATH` so children load the fixtures.    |
| `terminal.test.ts`                          | The scenario assertions.                                        |
| `harness-contract.test.ts`                  | The harness's own lifecycle/teardown guarantees.                |
| `../terminal-e2e-provider-contract.test.ts` | Scripted provider event contract (no terminal needed).          |
| `../terminal-e2e-network-guard.test.ts`     | Network guard contract (no terminal needed).                    |

The last two files need neither tmux nor Pi, so they live in `tests/` and run on
every `npm test`. `test:tui` selects on the `tests/terminal-e2e/` path prefix
rather than listing files, so a new test added to that directory runs
automatically instead of being silently excluded everywhere.

### Determinism rules

- **No fixed sleeps.** Every step waits on an observable condition — a provider
  log record, a screen string, or a pane list. Keep it that way.
- **Assert what the fixture painted, never the echo of what the test typed.**
  Pi echoes each submitted prompt into the transcript, so an expectation like
  `/error/i` after sending "Run the provider error fixture" can never fail.
  `renderedScreen()` subtracts every prompt `sendPrompt()` submitted and collapses
  whitespace runs, and `waitForScreen()` runs on that text, so this class of
  tautology is prevented structurally rather than case by case.
- **`sendPrompt()`, not `sendText()` + `pressEnter()`.** It waits for Pi to echo
  the keystrokes before submitting; input sent while the TUI is still initialising
  is discarded, and without the echo wait that surfaces 30s later as an
  unexplained gate timeout.
- **A screen assertion after a provider-log wait needs its own wait.** The child
  writes the log before the parent repaints.
- **Captures use `capture-pane -J`** so a line Pi wrapped at the pane width still
  matches a single-line expectation. Diagnostics keep the un-joined capture.

### Screen assertions are pinned to one SDK leg

The suite matches literal Pi chrome (`ctrl+c/ctrl+d clear/exit`,
`Model: subagentura-e2e/mock`, `Workflow "e2e-workflow" complete`,
`Async Subagents`). CI therefore runs `test:tui` only on the **pinned** Pi SDK
leg; a cosmetic upstream TUI change must not turn master red on the floating
`latest` leg where it would read as a flake. Unit and integration coverage stays
strict on both legs.

## Hermeticity boundary

The guards are **Node-level**, and this is a deliberate, documented limit:

- `fixtures/deny-network.cjs` is preloaded via `NODE_OPTIONS` and denies `fetch`,
  `WebSocket`, `http`/`https`/`http2`, `net`, `tls`, `dgram` and `dns`.
- It appends an `armed` record on load. `assertNoNetwork()` **requires** that
  record from every process that ran the scripted provider before asserting zero
  denials — an empty log otherwise cannot be distinguished from a preload that
  never applied, and all callers would pass vacuously forever.
- Denials are labelled `scope: "local" | "egress"`, so a future
  IPC-over-UNIX-socket failure cannot be misreported as outbound egress.
- Pi runs with `--approve`, so a tool-issued shell command (`curl`, `wget`,
  `git fetch`, `ssh`) is **not** intercepted. The harness points every proxy
  variable at a closed port (`http_proxy=http://127.0.0.1:1`, empty `no_proxy`)
  so those clients fail closed too, but this is not kernel-level isolation.

## Recording (optional, not part of CI)

`tests/terminal-e2e/recording/` holds human-facing demo and WebM tooling. It is
not exercised by `test:tui` and nothing in CI depends on it.

```bash
npm run demo:tui [scenario]     # attach to a live deterministic scenario
npm run record:tui [scenario]   # render a scenario to WebM
```

`record:tui` additionally requires:

- **wezterm** — captures the asciicast.
- **agg** — renders the cast to GIF (`brew install agg`).
- **ffmpeg with the `libvpx-vp9` encoder** — encodes the WebM.
