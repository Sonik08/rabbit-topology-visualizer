#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/sonik/.openclaw/workspace/rabbit-topology-visualizer}"
CODING_MODEL="${CODING_MODEL:-anthropic/claude-opus-4-7}"
REVIEW_MODEL="${REVIEW_MODEL:-openai/gpt-5.6-sol}"
MAX_TASKS="${MAX_TASKS:-1}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
LOCK_DIR="$REPO_DIR/.automation.lock"
REPORT_DIR="$REPO_DIR/reports/automation"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "RABBIT_AUTOMATION_RESULT status=skipped reason=lock-held"
  exit 0
fi
cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

cd "$REPO_DIR"
mkdir -p "$REPORT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "RABBIT_AUTOMATION_RESULT status=error reason=not-a-git-repo"
  exit 1
fi

if git ls-files --error-unmatch data/raw >/dev/null 2>&1; then
  echo "RABBIT_AUTOMATION_RESULT status=error reason=data-raw-is-tracked"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "RABBIT_AUTOMATION_RESULT status=blocked reason=missing-origin-remote"
  exit 1
fi

CODER_PROMPT="$REPORT_DIR/coder-prompt-$RUN_ID.md"
CODER_OUTPUT="$REPORT_DIR/coder-output-$RUN_ID.txt"
VERIFY_OUTPUT="$REPORT_DIR/verify-output-$RUN_ID.txt"
REVIEW_PROMPT="$REPORT_DIR/review-prompt-$RUN_ID.md"
REVIEW_OUTPUT_JSON="$REPORT_DIR/review-output-$RUN_ID.json"
REVIEW_TEXT="$REPORT_DIR/review-text-$RUN_ID.txt"

cat > "$CODER_PROMPT" <<PROMPT
[RabbitMQ topology visualizer scheduled coding run]

You are the coding model for this repository:

$REPO_DIR

Use model role: Claude 4.7-family coding model. The launcher selected: $CODING_MODEL.

Hard rules:
- Work only in this repository.
- Do not commit. The launcher will review and commit.
- Do not modify or commit data/raw/; raw topology exports may contain credentials.
- If the working tree has dirty changes, inspect them first. Continue only if they are clearly from prior automation for this same project; otherwise stop and report BLOCKED with paths.
- Read AGENTS.md, PLAN.md, and TASKS.md before editing.
- Complete at least one unchecked task from TASKS.md if possible. Maximum tasks this run: $MAX_TASKS.
- Prefer the first unchecked task that can be completed safely and verified in one run.
- Add/update tests when changing parser/query/core behavior.
- Run the smallest meaningful verification gate. Use scripts/verify.sh if suitable.
- Update TASKS.md by checking off completed task(s). Add a short parenthetical note only if it helps.
- Keep changes focused.

Final response format:

RABBIT_CODING_RESULT
status: completed|blocked|idle|paused
completed_tasks:
- ...
verification: ...
notes: ...
PROMPT

set +e
openclaw agent \
  --agent main \
  --session-key agent:main:rabbit-topology-coder \
  --model "$CODING_MODEL" \
  --thinking high \
  --timeout 7200 \
  --message-file "$CODER_PROMPT" > "$CODER_OUTPUT" 2>&1
CODER_EXIT=$?
set -e

if [ "$CODER_EXIT" -ne 0 ]; then
  cat "$CODER_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=error phase=coding exit=$CODER_EXIT"
  exit "$CODER_EXIT"
fi

if git diff --quiet -- . ':!reports' ':!data/raw' && git diff --cached --quiet -- . ':!reports' ':!data/raw'; then
  cat "$CODER_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=idle reason=no-code-changes"
  exit 0
fi

set +e
./scripts/verify.sh > "$VERIFY_OUTPUT" 2>&1
VERIFY_EXIT=$?
set -e

if [ "$VERIFY_EXIT" -ne 0 ]; then
  cat "$CODER_OUTPUT"
  cat "$VERIFY_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=blocked phase=verification exit=$VERIFY_EXIT"
  exit 1
fi

python3 - "$REVIEW_PROMPT" <<'PY'
import pathlib, subprocess, sys
prompt_path = pathlib.Path(sys.argv[1])
stat = subprocess.run(["git", "diff", "--stat", "--", ".", ":!reports", ":!data/raw"], text=True, capture_output=True, check=False).stdout
diff = subprocess.run(["git", "diff", "--", ".", ":!reports", ":!data/raw"], text=True, capture_output=True, check=False).stdout
max_chars = 120_000
if len(diff) > max_chars:
    diff = diff[:max_chars] + "\n\n[DIFF TRUNCATED FOR REVIEW]\n"
prompt_path.write_text(f"""You are the OpenAI 5.6 review gate for the RabbitMQ topology visualizer repository.

Review the uncommitted diff below for correctness, safety, test adequacy, and alignment with PLAN.md/TASKS.md.

Rules:
- Be strict about accidental secrets/raw topology files.
- Reject if data/raw/ is touched or credentials appear.
- Reject if tests/build fail according to the verification summary.
- If acceptable, first line must be exactly: APPROVED
- If not acceptable, first line must start with: REJECTED:
- After the first line, include concise review notes.

Verification was already run by scripts/verify.sh and exited successfully.

Diff stat:
{stat}

Diff:
```diff
{diff}
```
""")
PY

python3 - "$REVIEW_MODEL" "$REVIEW_PROMPT" "$REVIEW_OUTPUT_JSON" <<'PY'
import json, pathlib, subprocess, sys
model, prompt_path, out_path = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
prompt = prompt_path.read_text()
cmd = ["openclaw", "infer", "model", "run", "--gateway", "--model", model, "--json", "--prompt", prompt]
res = subprocess.run(cmd, text=True, capture_output=True)
out_path.write_text((res.stdout or "") + ("\nSTDERR:\n" + res.stderr if res.stderr else ""))
if res.returncode != 0:
    print(res.stdout, end="")
    print(res.stderr, end="", file=sys.stderr)
    sys.exit(res.returncode)
try:
    data = json.loads(res.stdout)
    text = data.get("outputs", [{}])[0].get("text", "")
except Exception:
    text = res.stdout
print(text)
PY

python3 - "$REVIEW_OUTPUT_JSON" "$REVIEW_TEXT" <<'PY'
import json, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text()
try:
    data = json.loads(raw)
    text = data.get("outputs", [{}])[0].get("text", "")
except Exception:
    text = raw
pathlib.Path(sys.argv[2]).write_text(text)
print(text)
PY

FIRST_REVIEW_LINE="$(grep -m1 -E '^(APPROVED|REJECTED:)' "$REVIEW_TEXT" || true)"
if [ "$FIRST_REVIEW_LINE" != "APPROVED" ]; then
  cat "$CODER_OUTPUT"
  cat "$VERIFY_OUTPUT"
  cat "$REVIEW_TEXT"
  echo "RABBIT_AUTOMATION_RESULT status=blocked phase=review"
  exit 1
fi

# Stage only project files, never raw topology data or ignored reports.
git add -- . ':!data/raw' ':!reports'
git reset -q -- data/raw reports 2>/dev/null || true

if git diff --cached --quiet; then
  echo "RABBIT_AUTOMATION_RESULT status=idle reason=no-staged-changes-after-exclusions"
  exit 0
fi

COMMIT_SUBJECT="Complete Rabbit topology task"
git commit -m "$COMMIT_SUBJECT" -m "Automated coding run using $CODING_MODEL; review approved by $REVIEW_MODEL."
COMMIT_SHA="$(git rev-parse --short HEAD)"

git push origin "HEAD:$UPSTREAM_BRANCH"

cat "$CODER_OUTPUT"
cat "$VERIFY_OUTPUT"
cat "$REVIEW_TEXT"
echo "RABBIT_AUTOMATION_RESULT status=pushed commit=$COMMIT_SHA branch=$UPSTREAM_BRANCH coding_model=$CODING_MODEL review_model=$REVIEW_MODEL"
