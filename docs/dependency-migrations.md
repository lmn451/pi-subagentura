# Dependency maintenance

This update starts at `9da38ff64152780d54cad7d31b6274fa0c1fab66`.
The four Pi SDK development pins were already 1.5.0 at that baseline. Their
minimum peer versions remain 1.2.0, and CI continues to test minimum and latest
SDKs.

## Pi 1.5 tool validation

Read the released 1.5.0 notes for
[coding-agent](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md),
[ai](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md),
[agent](https://github.com/earendil-works/pi/blob/v1.5.0/packages/agent/CHANGELOG.md),
and [tui](https://github.com/earendil-works/pi/blob/v1.5.0/packages/tui/CHANGELOG.md),
plus [tool parameter schemas and TypeBox](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md#tool-parameter-schemas-and-typebox).
Unreleased changes are outside this migration.

Pi 1.5 validates JSON Schema through pi-schema and no longer exports TypeBox
from pi-ai's main entry. Keep importing TypeBox directly from `typebox`: this
is an explicitly supported migration path and preserves compatibility with
Pi 1.2. Our schemas use JSON Schema constraints rather than TypeBox refinements,
codecs, non-JSON types, or registered formats. Existing renderer key hints
already use the injected context helper recommended by Pi 1.5.

`tests/schema-sdk-compat.test.ts` now exercises Pi's public
`validateToolArguments`, in addition to the standalone TypeBox tests. It verifies
numeric-string coercion and rejection of out-of-range timers, unsafe group IDs,
unknown fields, invalid thinking/mux values, oversized handoffs, conflicting
context modes, and aliases without a description. It deliberately does not
assert the validator's changed error wording. Run this suite on both SDK matrix
legs to guard the actual tool validation path.

## Other direct dependencies

| Dependency                  | Baseline lock | Updated lock |
| --------------------------- | ------------- | ------------ |
| pi-extension-settings       | 0.9.1         | 0.10.0       |
| Stryker core                | 10.0.0        | 10.1.1       |
| Node types                  | 26.1.1        | 26.6.6       |
| Vitest and coverage-v8      | 5.0.0         | 5.1.0        |
| fast-check                  | 4.10.0        | 4.10.2       |
| lint-staged                 | 17.0.7        | 17.6.0       |
| oxfmt                       | 0.68.0        | 0.77.0       |
| simple-git-hooks            | 2.13.1        | 2.14.0       |
| acorn                       | 8.17.0        | 8.19.0       |
| TypeBox (peer installation) | 1.1.38        | 1.4.5        |

TypeScript 7.0.2, YAML 2.9.1, and is-path-inside 4.0.0 were
already current. YAML's manifest floor now matches the current patch.

- [Settings 0.10.0](https://github.com/juanibiapina/pi-extension-settings/blob/main/CHANGELOG.md)
  ships strict TypeScript declarations and makes a default-bearing `getSetting`
  return `string`. Existing imports and optional-default reads compile against
  the published declarations; retain defensive runtime validation because
  persisted settings can still be malformed.
- [Vitest 5.1](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0) adds
  features and fixes without another major migration. Keep coverage-v8 paired
  with Vitest. Existing setup ordering, mocks, timers, and V8 thresholds remain.
- [Stryker 10.1](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.1.0)
  adds Vitest 5 runner support; [10.1.1](https://github.com/stryker-mutator/stryker-js/releases/tag/v10.1.1)
  republishes that release after a provenance issue. Our command runner remains
  appropriate for TypeScript 7, which does not expose the legacy compiler API.
- [fast-check 4.10.1](https://github.com/dubzzz/fast-check/releases/tag/v4.10.1)
  and [4.10.2](https://github.com/dubzzz/fast-check/releases/tag/v4.10.2) fix
  interrupt-plugin timers and exceptions. No property-test API changes apply.
- [lint-staged releases](https://github.com/lint-staged/lint-staged/releases)
  through 17.6 improve worktree handling and change staging of task side effects.
  Our formatter command receives explicit staged filenames and has no task
  function that formats the whole repository. Its Node requirement remains
  below our minimum runtime.
- [simple-git-hooks 2.14](https://github.com/toplenboren/simple-git-hooks/blob/master/CHANGELOG.md)
  fixes worktree and isolated-install hook paths. Hook installation modifies
  shared Git metadata, so dependency verification does not reinstall hooks.
- [oxfmt releases](https://github.com/oxc-project/oxc/releases) 0.69–0.77 switch
  Markdown, TOML, HTML, and Vue formatting to native formatters and add config
  associations. Our configuration uses no migrated parser overrides, and the
  full repository formatting check passes with the existing configuration.
- [Acorn 8.18–8.19](https://github.com/acornjs/acorn/blob/master/acorn/CHANGELOG.md)
  adds Unicode 18 and parser fixes. Existing workflow syntax validation uses
  the supported API and remains covered by its execution/security suites.
- [YAML 2.9.1](https://github.com/eemeli/yaml/releases/tag/v2.9.1), already in the
  baseline lock, limits recursive merge aliases and simplifies quoted-string
  unfolding. No API migration applies.
- TypeBox's [1.2](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.2.0.md),
  [1.3](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.3.0.md),
  and [1.4](https://github.com/sinclairzx81/typebox/blob/main/changelog/1.4.0.md)
  notes include minor-version breaking changes: null enum members and Script's
  `Options` generic are removed, along with Base/Promise/iterator types and
  Value.Mutate. None are used here. TypeBox 1.4 shares nested schemas by
  reference; our one schema annotation mutation happens before composition and
  does not change a shared nested property. Existing schema/static-type tests
  and the public Pi validator tests cover the retained composition behavior.

## Scoped transitive security updates

Compatible transitive refreshes update Vite to 8.3.6, brace-expansion to 5.0.12,
fast-uri to 3.1.9, zod to 4.6.7, and source-map-js to 1.2.2. Upstream exact
pins leave three packages needing explicit overrides. These overrides are
limited to the reviewed parent versions/ranges; remove them when upstream
dependencies include the fixes.

- Pi coding-agent 1.5 pins Undici 8.12.3. Override it to
  [8.12.4](https://github.com/nodejs/undici/releases/tag/v8.12.4), which fixes
  six issues involving redirects, shared caches, credential stripping, replay
  errors, and integrity metadata. This is a patch update with the same
  dispatcher/proxy API Pi uses. Registry audits did not yet report these new
  release advisories, so auditing alone was insufficient.
- Stryker core 10.1 pins minimatch to `~10.2.4`, affected by
  [glob amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
  [Minimatch 11's migration notes](https://github.com/isaacs/minimatch/blob/main/changelog.md)
  remove RegExp/AST/internal methods, debug, and recursion options. Stryker uses
  only `minimatch`, `Minimatch.match`, and `Minimatch.hasMagic`, with `dot`,
  `nocase`, and `flipNegate`; those remain supported. Override Stryker's matcher
  to 11.0.5. Also update Pi's exact 11.0.3 matcher to 11.0.5: its new work budget
  rejects incomplete pathological glob expansions instead of exhausting memory.
  The new Node 20 minimum remains below the project's minimum.
- Stryker → typed-rest-client 2.3.1 pins qs 6.15.1. Override only that chain to
  [qs 6.17.1](https://github.com/ljharb/qs/blob/main/CHANGELOG.md), fixing
  comma-array stringify exceptions, non-callable `isBuffer`, and array-limit
  bypasses. typed-rest-client uses the retained `qs.stringify` API; exercise
  its `getUrl` query construction including arrays/nulls/custom separators.

Overrides belong to this development install. npm consumers do not inherit
dependency-package overrides, and the Pi SDKs are peers supplied by the host.
Host Pi installations need upstream updates for those patches too.
