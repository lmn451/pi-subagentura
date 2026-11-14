#!/usr/bin/env bash
set -euo pipefail

exec "$SUBAGENTURA_E2E_REAL_PI" \
  --offline \
  --approve \
  --api-key subagentura-e2e-test-key \
  --no-extensions \
  --no-skills \
  --no-prompt-templates \
  --no-themes \
  --no-context-files \
  -e "$SUBAGENTURA_E2E_REPO/src/subagent.ts" \
  -e "$SUBAGENTURA_E2E_REPO/tests/terminal-e2e/fixtures/mock-provider.ts" \
  "$@"
