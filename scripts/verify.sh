#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f package.json ]; then
  if npm run | grep -qE '^  test'; then
    npm test
  fi
  if npm run | grep -qE '^  typecheck'; then
    npm run typecheck
  fi
  if npm run | grep -qE '^  build'; then
    npm run build
  fi
else
  echo "No package.json yet; verification limited to repository file inspection."
  test -f PLAN.md
  test -f TASKS.md
fi
