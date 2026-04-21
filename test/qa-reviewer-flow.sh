#!/usr/bin/env bash
# Verifies §4 qa-reviewer.md and build.md updates, plus autopilot.ts
# invariance (a12).
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
FAIL_MSGS=()

assert() {
  local desc="$1" result="$2"
  if [[ "$result" == "PASS" ]]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
    FAIL_MSGS+=("$desc")
  fi
}

echo "==> test/qa-reviewer-flow.sh"

QA=home/.claude/agents/qa-reviewer.md
BUILD=home/.claude/agents/build.md
AUTOPILOT=home/.config/opencode/plugins/autopilot.ts

# "qa-reviewer.md references plan-check.sh"
if grep -q 'plan-check.sh' "$QA" && grep -q 'plan-check.sh --run' "$QA"; then
  assert "qa-reviewer.md references plan-check.sh" PASS
else
  assert "qa-reviewer.md references plan-check.sh (missing tool reference or --run flag)" FAIL
fi

# qa-reviewer must mention that it executes commands via bash (its own
# permission scope), not via the tool.
if grep -q 'your own bash permission' "$QA" \
   || grep -q 'via `bash`' "$QA" \
   || grep -q 'via bash' "$QA"; then
  assert "qa-reviewer.md clarifies bash execution is its own (not plan-check's)" PASS
else
  assert "qa-reviewer.md clarifies bash execution is its own (phrasing missing)" FAIL
fi

# "build.md references TDD order for fenced items"
if grep -q 'TDD order' "$BUILD"; then
  assert "build.md references TDD order for fenced items" PASS
else
  assert "build.md references TDD order for fenced items (phrase absent)" FAIL
fi

# "autopilot.ts has no diff in this plan"
# We want to ensure plan §4 did not modify autopilot.ts — the fence uses
# - [ ] on item first lines so the existing regex still works. Check
# against the commit that introduced this plan's autopilot-sensitive
# changes (the head of main at plan time was bab9ff6). Compare our
# current autopilot.ts against bab9ff6's version.
#
# If bab9ff6 is not reachable in this worktree, skip with a warning.
if git rev-parse --verify bab9ff6 >/dev/null 2>&1; then
  diff_output=$(git diff bab9ff6 -- "$AUTOPILOT" 2>/dev/null)
  if [[ -z "$diff_output" ]]; then
    assert "autopilot.ts has no diff in this plan (vs bab9ff6)" PASS
  else
    assert "autopilot.ts has no diff in this plan (diff present vs bab9ff6)" FAIL
  fi
else
  echo "  ⚠ bab9ff6 not reachable; skipping autopilot.ts diff check"
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
