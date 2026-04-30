# Contributing

Thanks for contributing to `pi-subagentura`.

## Local development

```bash
bun install
bun run typecheck
bun test
bun run pack:check
```

## Provider list

`resolveModel()` in `helpers.ts` dynamically queries all providers via `getProviders()` from the Pi SDK — no hardcoded list. When Pi adds new providers, bare model IDs resolve automatically without code changes.

## Guidelines

- Keep changes focused and minimal
- Follow existing code style
- Add or update tests when behavior changes
- Use conventional commits when preparing commits

## Release flow

The publish workflow runs when a `v*` tag is pushed and the tag matches the version in `package.json`.

Typical release flow:

```bash
npm version patch
git push origin master --follow-tags
```

## Reporting issues

Please include:

- what you expected
- what happened instead
- Pi version
- package version
- reproduction steps
