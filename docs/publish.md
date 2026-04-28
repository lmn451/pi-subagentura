---
title: "Publishing Workflow"
keywords: [publish, release, npm, version, tag, bun, oidc, trusted publisher]
---

# Publishing

## Trusted Publisher (OIDC)

This package uses **npm trusted publishing** — no tokens needed. The GitHub Actions workflow authenticates via OIDC, which is configured at:

```
https://www.npmjs.com/package/pi-subagentura → Settings → Trusted Publisher
```

The trusted publisher entry authorizes `lmn451/pi-subagentura` with workflow `publish.yml`.

## How It Works

1. Push a `v*` tag → triggers the publish workflow
2. GitHub Actions generates a short-lived OIDC token (`id-token: write`)
3. npm verifies the OIDC claims match the trusted publisher config
4. Package is published with provenance attestation

No `NPM_TOKEN` secret, no token rotation, nothing to leak.

## Release Process

```bash
# 1. Edit version in package.json (e.g., 1.0.2 → 1.0.3)

# 2. Commit, tag, and push
git add package.json
git commit -m "chore: bump version to X.Y.Z"
git tag vX.Y.Z
git push origin master
git push origin vX.Y.Z
```

Or use `npm version`:

```bash
npm version patch   # bumps version, commits, tags
git push origin master --follow-tags
```

## Verify

```bash
npm view pi-subagentura
```

Check GitHub Actions: https://github.com/lmn451/pi-subagentura/actions

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 404 on publish | Verify trusted publisher config on npmjs.com matches exactly |
| Workflow didn't trigger | Ensure tag matches `v*` and was pushed to remote |
