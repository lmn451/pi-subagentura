---
title: "JavaScript Runtime & Package Manager"
keywords: [npm, node, package manager, install, test, build]
---

# JavaScript Runtime & Package Manager

This project uses **Node.js** as its JavaScript runtime and **npm** as its package manager.

## Why npm?

- The default package manager that ships with Node.js
- Widely supported across all CI/CD platforms
- Deterministic installs via `package-lock.json`
- No additional runtime or tooling required

## Common Commands

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run type checking
npm run typecheck

# Run a single script
npm run <script-name>
```

## Version

This project requires Node.js >= 18.0.0. The lockfile (`package-lock.json`) ensures reproducible installs.
