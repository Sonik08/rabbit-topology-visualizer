#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

has_npm_script() {
  local script_name="$1"
  node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); process.exit(pkg.scripts && pkg.scripts[process.argv[1]] ? 0 : 1);' "$script_name"
}

if [ -f package.json ]; then
  if has_npm_script test; then
    npm test
  fi
  if has_npm_script typecheck; then
    npm run typecheck
  fi
  if has_npm_script build; then
    npm run build
  fi
else
  echo "No package.json yet; verification limited to repository file inspection."
  test -f PLAN.md
  test -f TASKS.md
fi
