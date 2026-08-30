# Contributing

Thanks for contributing to `pi-subagentura`.

## Local development

Node.js 22.19.0 or newer is required for local development.

```bash
npm install
npm run hooks:install
npm run typecheck
npm test
npm run pack:check
```

## Property and mutation testing

Property tests run as part of `npm test`; use the focused command while
developing them:

```bash
npm run test:property
```

The suite defaults to 100 runs with fixed seed `424242`. This keeps routine
runs deterministic and bounded. Override `FC_NUM_RUNS` (maximum 10,000) or
`FC_SEED` when exploring. When fast-check reports a failing seed and path,
replay only the named property so the path is not applied to unrelated
properties:

```bash
FC_SEED=123 FC_PATH="0:1:0" npm run test:property -- -t "property name"
```

The standard test suite can also run with files and tests shuffled.
The focused script uses a fixed seed so failures replay exactly:

```bash
npm run test:random
```

Explore another order by omitting the seed, and replay a reported order by
passing it explicitly:

```bash
npm test -- --sequence.shuffle
npm test -- --sequence.shuffle --sequence.seed=123
```

The Stryker pilot is non-gating and can be run locally:

```bash
npm run mutation:pilot
```

It mutates only `src/completion-presentation.ts` and runs that module's direct
unit and property tests. The pilot excludes integration, process, multiplexer,
and TUI suites and has no breaking score threshold. CI runs it with
`continue-on-error` only on the pinned SDK leg, so mutation results never gate a
pull request. Local configuration or test-runner failures still return a
non-zero exit code.

## Provider list

`resolveModel()` in `helpers.ts` dynamically queries all providers via `getProviders()` from the Pi SDK — no hardcoded list. When Pi adds new providers, bare model IDs resolve automatically without code changes.

## Guidelines

- Keep changes focused and minimal
- Follow existing code style
- Add or update tests when behavior changes
- Use conventional commits when preparing commits

## Release flow

The publish workflow (`.github/workflows/publish.yml`) runs when a `v*` tag is pushed
and the tag matches the version in `package.json`. It uses OIDC trusted publishing —
no `NPM_TOKEN` secret exists or should exist.

### Pre-release verification

Before cutting a release, update [CHANGELOG.md](./CHANGELOG.md) and run the full verification suite:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
```

### Release PR and merge gate

Prepare the version and changelog on a branch so the release change reaches
`master` through a reviewed pull request:

```bash
VERSION=3.4.5
git fetch origin master --tags
git switch -c "release/v$VERSION" origin/master
npm version "$VERSION" --no-git-tag-version
# Update CHANGELOG.md and move the Unreleased entries to the new version.
npm run typecheck
npm test
npm run format:check
npm run pack:check
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): prepare v$VERSION"
git push --set-upstream origin "release/v$VERSION"
gh pr create --base master --head "release/v$VERSION" \
  --title "chore(release): prepare v$VERSION"
```

The normal merge gate is required: confirm the PR has an approved review and
all required checks pass on the latest commit before merging. These commands
make that gate explicit; inspect the `reviewDecision` output for `APPROVED`:

```bash
PR=123
gh pr view "$PR" --json baseRefName,headRefName,reviewDecision,mergeStateStatus
gh pr checks "$PR" --required --watch
gh pr merge "$PR" --squash --delete-branch
```

If GitHub cannot complete a merge despite that gate, an authorized repository
administrator may deliberately use the documented administrative fallback:

```bash
# Re-check the PR above, then record the operational reason for this exception.
gh pr merge "$PR" --admin --squash --delete-branch
```

`--admin` is an exceptional bypass of branch-protection enforcement, not a
replacement for approval or checks. Never use it for convenience, combine it
with `--auto`, or change repository rulesets, branch protection, workflow
permissions, or secrets. If the required review or checks are not satisfied,
stop and fix the PR instead of using the fallback.

### Tag and publish

After the PR is merged, tag the exact current `master` commit. The tag is the
publish trigger; do not tag the release branch before the PR is merged:

```bash
VERSION=3.4.5
git fetch origin master --tags
git switch master
git pull --ff-only origin master
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
test "$(node -p \"require('./package.json').version\")" = "$VERSION"
test -z "$(git tag --list "v$VERSION")"
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"
```

The tag must be `v$VERSION`, must match `package.json`, and must point at the
merged `master` commit. The tag starts `publish.yml`, which reruns typecheck,
tests, the published-tarball smoke test, and `pack:check` before publishing to
npm and GitHub Packages. Monitor the run and verify the resulting artifacts:

```bash
gh run list --workflow publish.yml --limit 10 --json databaseId,headBranch,status,conclusion
RUN_ID=123456789 # use the databaseId for v$VERSION from the output above
gh run watch "$RUN_ID" --exit-status
test "$(npm view "pi-subagentura@$VERSION" version)" = "$VERSION"
gh release view "v$VERSION"
```

Confirm the workflow completed successfully before announcing the release. The
workflow uses OIDC for npm; do not add an `NPM_TOKEN` or other publish secret.

### Failure and recovery

- If a required check fails or the approval is missing, do not use `--admin`.
  Fix the PR and wait for the required gate to pass.
- If the tag/version check fails, do not move the tag. Inspect the workflow and
  local/remote versions, then prepare a corrective PR and a new version when
  the release commit must change.
- If a tag-triggered run fails before either registry has the version, rerun it
  only after confirming the tag still points to the intended commit and the
  version is absent from the registries. Otherwise, use a new version.
- If any registry already contains the version, do not rerun publishing blindly,
  force-push, or delete the tag. Package versions are immutable; inspect the
  completed workflow steps and have an authorized maintainer recover only the
  missing later-stage artifact.
- For a collision, fetch tags and registry versions before choosing the next
  available version:

  ```bash
  git fetch --tags origin
  git tag -l 'v*'
  npm view pi-subagentura versions
  ```

Never force-push or delete a published tag. If a tag exists only locally and
the release was aborted before it was pushed, delete that local tag and choose
the intended version again. If a patch is needed for an already-published
version, increment the patch version; npm does not allow re-publishing the same
version number.

## Reporting issues

Please include:

- what you expected
- what happened instead
- Pi version
- package version
- reproduction steps
