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
STATE_DIR="$REPORT_DIR/state"

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
mkdir -p "$STATE_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "RABBIT_AUTOMATION_RESULT status=error reason=not-a-git-repo"
  exit 1
fi

TRACKED_RAW="$(git ls-files data/raw | grep -v '^data/raw/.gitkeep$' || true)"
if [ -n "$TRACKED_RAW" ]; then
  echo "RABBIT_AUTOMATION_RESULT status=error reason=data-raw-is-tracked"
  printf '%s\n' "$TRACKED_RAW"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "RABBIT_AUTOMATION_RESULT status=blocked reason=missing-origin-remote"
  exit 0
fi

# If a previous run committed locally but failed to push, push that work before
# asking for more code. This avoids stacking more tasks behind a transient
# network/push failure.
if git fetch --quiet origin "$UPSTREAM_BRANCH" >/dev/null 2>&1 \
  && git rev-parse --verify --quiet "origin/$UPSTREAM_BRANCH" >/dev/null; then
  AHEAD_COUNT="$(git rev-list --count "origin/$UPSTREAM_BRANCH..HEAD")"
  BEHIND_COUNT="$(git rev-list --count "HEAD..origin/$UPSTREAM_BRANCH")"
  if [ "$BEHIND_COUNT" -gt 0 ]; then
    echo "RABBIT_AUTOMATION_RESULT status=blocked reason=branch-behind remote=origin/$UPSTREAM_BRANCH"
    exit 0
  fi
  if [ "$AHEAD_COUNT" -gt 0 ]; then
    git push origin "HEAD:$UPSTREAM_BRANCH"
    echo "RABBIT_AUTOMATION_RESULT status=pushed-pending commits=$AHEAD_COUNT branch=$UPSTREAM_BRANCH"
    exit 0
  fi
fi

CODER_PROMPT="$REPORT_DIR/coder-prompt-$RUN_ID.md"
CODER_OUTPUT="$REPORT_DIR/coder-output-$RUN_ID.txt"
VERIFY_OUTPUT="$REPORT_DIR/verify-output-$RUN_ID.txt"
REVIEW_PROMPT="$REPORT_DIR/review-prompt-$RUN_ID.md"
REVIEW_OUTPUT_JSON="$REPORT_DIR/review-output-$RUN_ID.json"
REVIEW_TEXT="$REPORT_DIR/review-text-$RUN_ID.txt"
LATEST_REVIEW_TEXT="$STATE_DIR/latest-review-text.txt"
LATEST_VERIFY_OUTPUT="$STATE_DIR/latest-verify-output.txt"
LATEST_CODER_OUTPUT="$STATE_DIR/latest-coder-output.txt"
DIRTY_AT_START="$(git status --porcelain --untracked-files=normal -- . ':(exclude)data/raw' ':(exclude)reports' || true)"
RUN_MODE="task"
MODE_RULES="- Complete at least one unchecked task from TASKS.md if possible. Maximum tasks this run: $MAX_TASKS.
- Prefer the first unchecked task that can be completed safely and verified in one run."
if [ -n "$DIRTY_AT_START" ]; then
  RUN_MODE="repair"
  MODE_RULES="- Repair the existing dirty automation diff until verification and review should pass.
- Do not start a new unchecked TASKS.md item while previous dirty work is unapproved.
- Do not check off new tasks except to correct notes for files already changed.
- Use the latest review/verification failure below as acceptance criteria."
fi
LATEST_REVIEW_SNIPPET="(none)"
if [ -s "$LATEST_REVIEW_TEXT" ]; then
  LATEST_REVIEW_SNIPPET="$(tail -c 12000 "$LATEST_REVIEW_TEXT")"
fi
LATEST_VERIFY_SNIPPET="(none)"
if [ -s "$LATEST_VERIFY_OUTPUT" ]; then
  LATEST_VERIFY_SNIPPET="$(tail -c 12000 "$LATEST_VERIFY_OUTPUT")"
fi

cat > "$CODER_PROMPT" <<PROMPT
[RabbitMQ topology visualizer scheduled coding run]

You are the coding model for this repository:

$REPO_DIR

Use model role: Claude 4.7-family coding model. The launcher selected: $CODING_MODEL.

Run mode: $RUN_MODE

Dirty tree at run start (excluding data/raw and reports):
--- DIRTY TREE START ---
${DIRTY_AT_START:-clean}
--- DIRTY TREE END ---

Latest blocking review, if any:
--- LATEST REVIEW START ---
$LATEST_REVIEW_SNIPPET
--- LATEST REVIEW END ---

Latest verification failure, if any:
--- LATEST VERIFY START ---
$LATEST_VERIFY_SNIPPET
--- LATEST VERIFY END ---

Hard rules:
- Work only in this repository.
- Do not commit. The launcher will review and commit.
- Do not modify or commit data/raw/; raw topology exports may contain credentials.
- If the working tree has dirty changes, inspect them first. Continue only if they are clearly from prior automation for this same project; otherwise stop and report BLOCKED with paths.
- Read AGENTS.md, PLAN.md, and TASKS.md before editing.
$MODE_RULES
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
cp "$CODER_OUTPUT" "$LATEST_CODER_OUTPUT" 2>/dev/null || true

if [ "$CODER_EXIT" -ne 0 ]; then
  cat "$CODER_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=blocked phase=coding exit=$CODER_EXIT"
  exit 0
fi

if [ -z "$(git status --porcelain --untracked-files=normal -- . ':(exclude)data/raw' ':(exclude)reports')" ]; then
  cat "$CODER_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=idle reason=no-code-changes"
  exit 0
fi

set +e
./scripts/verify.sh > "$VERIFY_OUTPUT" 2>&1
VERIFY_EXIT=$?
set -e

if [ "$VERIFY_EXIT" -ne 0 ]; then
  cp "$VERIFY_OUTPUT" "$LATEST_VERIFY_OUTPUT" 2>/dev/null || true
  cat "$CODER_OUTPUT"
  cat "$VERIFY_OUTPUT"
  echo "RABBIT_AUTOMATION_RESULT status=blocked phase=verification exit=$VERIFY_EXIT"
  exit 0
fi
rm -f "$LATEST_VERIFY_OUTPUT" 2>/dev/null || true

# Stage safe project changes before review so untracked files are included in the review diff.
git add -A -- .
git restore --staged -- data/raw 2>/dev/null || true
if git diff --cached --name-only | grep -E '^(data/raw/|reports/)' >/dev/null; then
  echo "RABBIT_AUTOMATION_RESULT status=error reason=forbidden-path-staged"
  git diff --cached --name-only | grep -E '^(data/raw/|reports/)'
  exit 1
fi

python3 - "$REVIEW_PROMPT" <<'PY'
import pathlib, subprocess, sys
prompt_path = pathlib.Path(sys.argv[1])
stat = subprocess.run(["git", "diff", "--cached", "--stat"], text=True, capture_output=True, check=False).stdout
diff = subprocess.run(["git", "diff", "--cached"], text=True, capture_output=True, check=False).stdout
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
  cp "$REVIEW_TEXT" "$LATEST_REVIEW_TEXT" 2>/dev/null || true
  cat "$CODER_OUTPUT"
  cat "$VERIFY_OUTPUT"
  cat "$REVIEW_TEXT"
  echo "RABBIT_AUTOMATION_RESULT status=blocked phase=review"
  exit 0
fi
rm -f "$LATEST_REVIEW_TEXT" 2>/dev/null || true

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
