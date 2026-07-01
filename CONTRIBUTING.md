# Contributing

Thanks for contributing to `pi-subagentura`.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

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

Before cutting a release, run the full verification suite:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
```

### Normal release

```bash
# 1. Bump version and create the git tag
npm version patch          # or minor, or major

# 2. Push the commit and tag to trigger publish.yml
git push origin master --follow-tags
```

GitHub Actions runs typecheck, tests, published-tarball smoke, and pack:check
before publishing. If any step fails, the package is not published — fix the
issue and retry.

### Version / tag collision recovery

If `npm version patch` fails because the target version or tag already exists:

1. **Check remote tags** — `git fetch --tags origin` then `git tag -l 'v*'`
   to see what has already been tagged and published. `npm view
pi-subagentura versions` shows versions on the registry.

2. **Choose the next available version** — if `v2.3.4` exists, bump to
   `v2.3.5` (or whatever the appropriate next version is). You can also use
   `npm version <exact-version>` to set a specific version, e.g.
   `npm version 2.3.5`.

3. **Never force-push or delete a published tag.** The publish workflow uses
   OIDC trusted publishing and the tag—version match as its release gate.
   Force-pushing moves a tag that npm already published, creating a confusing
   mismatch between the Git ref and the published package. If the tag exists
   locally but the release was aborted before the git push, delete just the
   local tag (`git tag -d v2.3.4`) and re-run `npm version patch`.

4. **If a patch is needed on an already-released version**, you must bump to
   a new version — npm does not allow re-publishing the same version number.
   Release a patch-level increment: `npm version patch` produces `v2.3.5` if
   `v2.3.4` is current.

## Reporting issues

Please include:

- what you expected
- what happened instead
- Pi version
- package version
- reproduction steps
