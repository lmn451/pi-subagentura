---
title: "JavaScript Runtime & Package Manager"
keywords: [bun, package manager, runtime, install, test, build]
---

# JavaScript Runtime & Package Manager

This project uses **Bun** as its JavaScript runtime and package manager.

## Why Bun?

- Fast native TypeScript support (no separate tsc step needed)
- All-in-one runtime, bundler, and test runner
- Drop-in replacement for Node.js and npm/yarn/pnpm
- Significantly faster installs and test execution

## Common Commands

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Run a single script
bun run <script-name>
```

## Version

This project requires Bun >= 1.3.0. The lockfile (`bun.lock`) ensures reproducible installs.
