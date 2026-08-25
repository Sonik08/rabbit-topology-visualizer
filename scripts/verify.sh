#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

errors = []

tracked = subprocess.run(["git", "ls-files", "data/raw"], text=True, capture_output=True, check=False)
tracked_raw = [p for p in tracked.stdout.splitlines() if p != "data/raw/.gitkeep"]
if tracked_raw:
    errors.append("data/raw contains tracked non-placeholder files; raw topology exports must stay untracked/local")

text_suffixes = {".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".sh", ".html", ".css"}
scan_roots = [
    Path("src"),
    Path("test"),
    Path("scripts"),
    Path("docs"),
    Path("AGENTS.md"),
    Path("PLAN.md"),
    Path("TASKS.md"),
    Path("package.json"),
    Path("index.html"),
]
seen = set()
amqp_credential_re = re.compile(r"amqps?://([^\s'\"<>`]+@)", re.IGNORECASE)

for root in scan_roots:
    if not root.exists():
        continue
    candidates = root.rglob("*") if root.is_dir() else [root]
    for path in candidates:
        if path in seen or not path.is_file() or path.suffix not in text_suffixes:
            continue
        seen.add(path)
        raw = path.read_bytes()
        if b"\x00" in raw:
            errors.append(f"{path}: text file contains NUL bytes; re-save as UTF-8 text")
            continue
        text = raw.decode("utf-8", errors="replace")
        for match in amqp_credential_re.finditer(text):
            user_info = match.group(1)[:-1]
            if user_info == "REDACTED" or "${" in user_info:
                continue
            errors.append(f"{path}: literal AMQP URI contains unredacted user info near {match.group(0)!r}")

if errors:
    print("Repository safety preflight failed:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    sys.exit(1)
PY

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
