#!/usr/bin/env bash
set -euo pipefail

pi_args=(--offline)
if [[ "${SUBAGENTURA_E2E_CHILD_OMIT_API_KEY:-}" != "1" ]]; then
  pi_args+=(--api-key subagentura-e2e-test-key)
fi
pi_args+=(
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-themes
  --no-context-files
  -e "$SUBAGENTURA_E2E_REPO/src/subagent.ts"
  -e "$SUBAGENTURA_E2E_REPO/tests/terminal-e2e/fixtures/mock-provider.ts"
)
exec "$SUBAGENTURA_E2E_REAL_PI" "${pi_args[@]}" "$@"
