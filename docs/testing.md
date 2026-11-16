---
title: "Testing with Ambient Host State"
keywords: [testing, isolation, environment, host-state, multiplexers, wezterm]
---

# Testing with Ambient Host State

Test processes inherit host state. Environment variables, `PATH`, the working
directory, running processes, and sockets can change which code path a test
reaches. Use this checklist when a test depends on any of them.

## Checklist

1. Identify every ambient input read by the code under test. Search for the
   relevant environment variables and other host-dependent lookups.
2. Save the original values before changing them. Preserve missing values as
   missing; do not replace them with empty strings.
3. Set the values needed by the test explicitly. Do not rely on the developer's
   terminal or CI runner having a clean environment.
4. Restore the original state in `afterEach` or `finally`, including when an
   assertion or setup step fails.
5. Exercise both polluted/inherited and clean states when they can select
   different behavior. Inject controlled marker values for the polluted case;
   explicitly unset relevant variables for the clean case.
6. Keep production safety behavior intact. If production code correctly fails
   closed when ambient context is unverified, isolate the test instead of
   weakening that behavior.
7. Establish the baseline before editing. Compare the failing case with the
   clean case, then rerun the focused test and the project's full checks after
   the fix. Report pre-existing failures separately from regressions.

For a test suite that owns a set of environment selectors, a full snapshot
preserves both present and absent values:

```ts
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of muxEnvironmentKeys) delete process.env[key];
});

afterEach(() => {
  process.env = originalEnv;
});
```

Set any selectors required by an individual case after the setup clears them.
The snapshot must be taken before cleanup, and restoration must happen after
each case.

## WezTerm example

WezTerm can pass `WEZTERM_PANE` and `WEZTERM_UNIX_SOCKET` to child processes.
Multiplexer tests must control both variables and restore the original
environment after each case. With those markers inherited, auto-selection can
recognize a WezTerm context that cannot be verified for the test process and
fail closed rather than selecting a fallback backend.

Before both selectors were included in the fixture's cleanup list, the focused
`tests/multiplexer.test.ts` run with `WEZTERM_PANE` and `WEZTERM_UNIX_SOCKET`
set had **41 passed and 5 failed**. With both explicitly unset, it had **46
passed and 0 failed**. This was test-environment leakage; runtime fail-closed
behavior was intentional and remains unchanged.

To exercise both states:

```sh
WEZTERM_PANE=10 WEZTERM_UNIX_SOCKET=/tmp/wezterm-test.sock \
  ./node_modules/.bin/vitest run tests/multiplexer.test.ts

env -u WEZTERM_PANE -u WEZTERM_UNIX_SOCKET \
  ./node_modules/.bin/vitest run tests/multiplexer.test.ts
```

## Verification

Run the focused suite, followed by the standard repository checks:

```sh
./node_modules/.bin/vitest run tests/multiplexer.test.ts
npm run typecheck
npm test
npm run format:check
npm run pack:check
```
