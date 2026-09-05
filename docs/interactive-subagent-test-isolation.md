---
title: "Interactive Sub-Agent Test Isolation"
keywords:
  [interactive subagent, test isolation, Vitest, child protocol, artifacts]
---

# Interactive Sub-Agent Test Isolation

Interactive sub-agent tests touch process environment, module-level registries,
temporary artifact trees, and multiplexer backends. Keep those resources
explicitly scoped to the test or session under test.

## Vitest worker quarantine

`vitest.config.ts` removes `PI_SUBAGENTURA_CHILD` while Vitest configuration is
loaded. The setup file `tests/setup-lineage-env.ts` then calls
`clearLiveLineageEnvironment()` and removes the complete live lineage set:

```text
PI_SUBAGENTURA_CHILD
ARTIFACT_DIR
PI_SUBAGENTURA_AGENT_ID
PI_SUBAGENTURA_ROOT_ID
PI_SUBAGENTURA_LINEAGE_SESSION_ROOT
PI_SUBAGENTURA_DEPTH
PI_SUBAGENTURA_MAX_DEPTH
PI_SUBAGENTURA_MAX_NODES
PI_SUBAGENTURA_LINEAGE_BOOTSTRAP
```

This is why a normal Vitest invocation starts in parent mode even when the
process that launched it was an interactive child. The setup file deliberately
does not restore these values: each Vitest worker is treated as a disposable
quarantine. A command that bypasses Vitest configuration and setup files still
needs to provide its own environment isolation.

## Creating a child-mode Pi fixture

`tests/helpers/pi-session-harness.ts` exports `createPiSessionHarness`. It
creates a temporary agent directory, registers the deterministic
`subagentura-faux` provider, and uses an in-memory `SessionManager` unless the
caller supplies one. With the standard Vitest setup active, a normal harness
call loads the extension in parent mode:

```ts
const harness = await createPiSessionHarness(repoRoot);
```

To exercise the child protocol, create a unique artifact directory and pass it
as `childArtifactDir`:

```ts
const harness = await createPiSessionHarness(repoRoot, {
  childArtifactDir: artifactDir,
});
```

The fixture sets `PI_SUBAGENTURA_CHILD=1` and `ARTIFACT_DIR` only while
`resourceLoader.reload()` loads the extension, then restores both previous
values in a `finally` block. `harness.dispose()` disposes the session and
removes its temporary agent directory. Tests that create artifact roots still
own those roots and must remove them in their hooks; the Pi-session delivery
suite keeps both harnesses and artifact roots in arrays for this purpose.

Child lifecycle coverage lives in `tests/pi-session-delivery.integration.test.ts`
and `tests/child-protocol.test.ts`. Tests that invoke the generated CLI directly
pass an explicit artifact directory in the spawned process environment, for
example:

```ts
spawnSync(process.execPath, [cliPath, "done", "0"], {
  env: { ...process.env, ARTIFACT_DIR: artifactDir },
});
```

Do not reuse a child artifact directory between tests. The child protocol
mutates `events.ndjson`, `active-turn.json`, `output.md`, and immutable output
snapshots.

## Module and registry reset

`tests/test-utils.ts#importFresh()` calls `vi.resetModules()` and then performs
a dynamic import. Use it after changing environment values or installing a
`vi.doMock()` for `node:child_process` so the module reads the intended fixture
state. The multiplexer unit suites use this pattern to test command selection
without invoking a real backend.

Module reset does not clear state stored on `globalThis`. The interactive
registry is deliberately held at
`globalThis.__piSubagenturaInteractiveRegistry`, so it survives a module
reload. Tests that populate it clear it in `beforeEach` or `afterEach`. Session
scopes and cached mux instances need their own cleanup:

```ts
interactiveSubagentRegistry.clear();
clearSessionScopes();
__setTmuxMultiplexer(undefined);
__resetMuxInstances();
```

Use `__setTmuxMultiplexer()` or `__setZellijMultiplexer()` from
`src/multiplexer.ts` to install a fake backend with only the methods the test
needs. Restore the injected backend after each test. A fake backend makes
liveness, send, focus, and kill behavior deterministic; it does not validate
the command line accepted by a real tmux or Zellij process.

## Ownership and cancellation

`registerInteractiveSubagentState(state, scope)` inserts the same state into
both `scope.interactiveStates` and the global compatibility registry. The
owner-scoped poller and `cancelAllFlows(owner)` use the scope map; ownerless
operations can fall back to the global registry. A state left in either map can
therefore be observed or cancelled by a later test.

When testing ownership, register each fake state with its exact
`SessionScope`, pass that owner to poll/cancel helpers, and clear both scope and
global registries in teardown. Give every state a temporary artifact directory
and a fake mux whose `getPaneLiveness` and `killPane` behavior is explicit.
`tests/artifact-delivery.integration.test.ts`,
`tests/subagent-poll.test.ts`, and `tests/subagent-shutdown.test.ts` exercise
these paths. Shutdown cancellation receives a complete state snapshot because
the live registry is cleared before pane teardown; tests must not assume an id
lookup will still find it.

The cancellation path attempts to write `.cancelled`, append a parent
cancellation event, and ask the recorded mux to kill the pane. The marker and
some lifecycle cleanup are best effort, but a test that asserts cancellation
must still provide valid temporary artifact paths and a mux spy. Do not put a
real child state in a shared fixture registry merely to inspect its status.

## Real multiplexer tests

The ordinary `npm test` command excludes the real tmux, Zellij, and Herdr
integration files. Use the backend-specific scripts when command and process
behavior matters:

```bash
npm run test:tmux
npm run test:zellij
npm run test:herdr
```

`tests/tmux.integration.test.ts` installs a fake `pi` executable, forces the
detached tmux path, and routes operations through
`PI_SUBAGENTURA_TMUX_SOCKET`. The test file uses a process-specific socket by
default, kills that server in `afterEach`, resets the registry and mux cache,
restores environment variables, and removes its temporary root. For a manual
run, choose a unique socket name rather than the default tmux server:

```bash
PI_SUBAGENTURA_TMUX_SOCKET=pi-subagentura-check-$$ npm run test:tmux
```

The socket setting is consumed by `src/multiplexer-tmux.ts`, which adds
`-L <socket>` to every tmux operation. A shared socket still permits collisions,
and an abruptly terminated test process may skip hook cleanup; inspect the
named server before reusing it.

For full Pi and TUI behavior, use `npm run test:tui`. The terminal harness in
`tests/terminal-e2e/harness.mjs` creates a random per-harness tmux socket and
session, uses deterministic provider fixtures, and tears down its process
groups and tmux server. Its network guard and assertion rules are documented in
[`terminal-e2e.md`](./terminal-e2e.md).

## Test commands and boundaries

Use the smallest command that covers the behavior under change:

| Command                 | Coverage boundary                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`              | Vitest suite excluding real mux integration and `tests/terminal-e2e/**`; includes the provider and network-guard contract tests in `tests/`. |
| `npm run test:unit`     | Unit-oriented suite; also excludes Pi-session delivery, property, published-tarball, real mux, and terminal suites.                          |
| `npm run test:pi`       | Pi-session delivery integration tests using the faux provider and session harness.                                                           |
| `npm run test:property` | Fast-check property suites.                                                                                                                  |
| `npm run test:tui`      | Real Pi CLI inside the isolated terminal E2E harness; requires tmux and a resolvable Pi binary.                                              |

The Vitest environment and mux fakes isolate Node-side tests, but they do not
provide OS-level isolation. `createPiSessionHarness` defaults to an in-memory
session and faux provider, so it does not prove real pane creation, shell
quoting, process lifetime, or terminal rendering. Use the real backend or
terminal scripts for those contracts, and run the standard typecheck, format,
and package checks before delivery.
