# Testing foundation report

## Scope

This milestone adds a first, bounded property-testing layer and a narrowly scoped
mutation-testing pilot. Work remains isolated in
`/private/tmp/pi-subagentura-property-mutation-testing` on branch
`feat/property-mutation-testing`. The parent worktree was not modified.

The implementation adds `fast-check@^4.9.0` and
`@stryker-mutator/core@^10.0.0` as development dependencies. The package now
requires Node.js 22.23.2 or newer, the current official Node 22 LTS patch.

## Review findings and changes

- Property inputs, run counts, collection sizes, and mutation concurrency are
  explicitly bounded.
- Routine property runs are deterministic: 100 runs with seed `424242`.
- `FC_NUM_RUNS` (maximum 10,000), `FC_SEED`, and `FC_PATH` provide exploration
  and exact replay controls. `FC_PATH` should be used with Vitest `-t` so the
  replay path applies only to the named property.
- The mutation target is only `src/completion-presentation.ts`. Its dedicated
  Vitest configuration includes only the direct unit and property test files;
  integration, process, multiplexer, and TUI suites are excluded.
- Pull-request mutation results are non-blocking: CI runs the pilot only on the
  pinned SDK leg with `continue-on-error: true`, and Stryker has
  `thresholds.break: null`.
- CI has a dedicated Node 22.23.2 minimum-runtime smoke job; the existing Pi SDK
  `0.80.6`/`latest` compatibility matrix remains unchanged on Node 24.
- Review found no production behavior defect requiring a source change. The
  sole surviving mutant is classified instead of forcing an implementation-coupled
  assertion.
- A shuffled seed exposed a test-only environment leak. The current-pane suite
  now clears pane identity variables before every test and restores the invoking
  process environment afterward.

## Property coverage

`npm run test:property` runs ten properties across two files. They cover:

- completion-label control-character normalization, output/input bounds,
  idempotence, fallback behavior, and message formatting;
- strict JSON extraction and rejection of JSON surrounded by prose;
- array `minItems`/`maxItems` schema cardinality;
- the accepted workflow-name grammar;
- workflow usage field totals, token totals, provenance, turns, and input
  immutability.

Replay example:

```bash
FC_SEED=123 FC_PATH="0:1:0" npm run test:property -- -t "property name"
```

## Random-order coverage

`npm run test:random` shuffles both test files and tests with fixed seed
`424242`. The first run exposed one order-dependent failure in
`tests/current-pane-activity.test.ts`: when its no-identity case ran first, it
inherited the invoking Pi process's `TMUX` and `TMUX_PANE` values. The suite now
snapshots the original pane environment, clears it in `beforeEach`, and restores
it in `afterEach`. The focused shuffled regression and the full shuffled suite
pass with seed `424242`.

Use an unseeded run to explore a new order and the printed seed to replay it:

```bash
npm test -- --sequence.shuffle
npm test -- --sequence.shuffle --sequence.seed=123
```

## Mutation result and survivor classification

`npm run mutation:pilot` generated 22 mutants for
`src/completion-presentation.ts`: 21 were killed, one survived, none timed out,
and none errored. The mutation score is **95.45%**.

The survivor changes:

```diff
-.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
+.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
```

This mutant is observationally equivalent. The original replaces each maximal
control-character run with one space; the mutant replaces each character with
one space. The immediately following global `\s+` replacement collapses either
intermediate result to exactly one space before trimming. No public output can
distinguish the two forms. The survivor remains visible instead of being hidden
by a broad exclusion or "killed" with a test of unobservable intermediate state.

The pilot uses Stryker 10's command runner with a dedicated Vitest configuration.
The Stryker 10 Vitest runner was evaluated but misclassified a module-initialization
arithmetic mutant as surviving under Vitest 4; the focused property kills that
mutant in a fresh Vitest process. The command runner preserves process isolation
and reports it correctly. TypeScript 7 also no longer exposes the legacy compiler
API Stryker expects while rewriting a `tsconfig`; the intentionally absent
`.stryker-unused-tsconfig.json` bypasses that unused rewrite while Vitest performs
TypeScript transpilation.

## Verification

All requested checks pass:

| Command                  | Result                                                 |
| ------------------------ | ------------------------------------------------------ |
| `npm run typecheck`      | Passed                                                 |
| Node 22.23.2 smoke       | Typecheck, properties, extension load, and pack passed |
| `npm test`               | 78 files, 1,752 tests passed                           |
| `npm run test:random`    | Seed 424242; 78 files, 1,752 tests passed              |
| `npm run format:check`   | Passed                                                 |
| `npm run pack:check`     | Passed; `pi-subagentura-3.4.2.tgz` dry run             |
| `npm run test:property`  | 2 files, 10 tests passed                               |
| `npm run mutation:pilot` | 22 mutants; 21 killed, 1 equivalent survivor; 95.45%   |
| `git diff --check`       | Passed                                                 |

## Audit findings

A full `npm audit` reports 8 development-tree findings: 5 moderate, 3 high,
and 0 critical. The sole direct entry is
`@earendil-works/pi-coding-agent` (moderate); other findings are transitive. The
high transitive entries are `brace-expansion`, `nanoid`, and `undici`.

`npm audit --omit=dev` reports **0 vulnerabilities**, so the published runtime
dependency tree is unaffected. No broad `npm audit fix` was applied because it
would exceed this milestone and may require breaking development-tool upgrades.

## Limitations and next steps

A fixed shuffled seed gives deterministic replay but exercises only one order;
periodically run without `--sequence.seed` and retain Vitest's printed seed for
failures.

1. A fixed default seed favors reproducibility over automatic input diversity;
   use periodic alternate seeds before expanding run counts.
2. The command runner executes the two selected Vitest files for every mutant;
   it lacks per-test coverage optimization but avoids the static-mutant isolation
   defect observed with the Stryker 10 Vitest runner.
3. Keep the equivalent survivor documented and visible unless the implementation
   changes enough to make it observable.
4. Reconsider the direct Vitest runner after its Vitest 4 static-mutant isolation
   is verified.
5. Add another small pure-file target only after this pilot remains stable; do
   not expand mutation into integration, process, mux, or TUI code.
6. Address development-tree audit findings in a separate dependency-maintenance
   change with compatibility testing.
