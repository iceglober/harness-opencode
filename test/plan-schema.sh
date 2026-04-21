#!/usr/bin/env bash
# Verifies §4 plan schema updates in plan.md and plan-reviewer.md (a11).
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

echo "==> test/plan-schema.sh"

PLAN=home/.claude/agents/plan.md
PR=home/.claude/agents/plan-reviewer.md
PCS=home/.claude/bin/plan-check.sh
FIX=test/fixtures/plans

# "plan.md template contains plan-state fence example"
# The template's example uses a zero-width-space inserted in the triple
# backtick to keep markdown happy inside a markdown codefence — grep for
# the "plan-state" tag (which is unambiguous) instead.
if grep -q 'plan-state' "$PLAN" \
   && grep -q '^  intent:' "$PLAN" \
   && grep -q '^  tests:' "$PLAN" \
   && grep -q '^  verify:' "$PLAN"; then
  assert "plan.md template contains plan-state fence example" PASS
else
  assert "plan.md template contains plan-state fence example (missing a key)" FAIL
fi

# "plan-reviewer.md contains 6th criterion"
if grep -qF '6. **Plan-state fence integrity**' "$PR" \
   && grep -q 'plan-check.sh --check' "$PR"; then
  assert "plan-reviewer.md contains 6th criterion" PASS
else
  assert "plan-reviewer.md contains 6th criterion (missing header or plan-check reference)" FAIL
fi

# "plan-reviewer rejects fence missing intent"
set +e; bash "$PCS" --check "$FIX/missing-intent.md" >/dev/null 2>&1; rc=$?; set -e
if [[ "$rc" -eq 1 ]]; then
  assert "plan-reviewer rejects fence missing intent (--check exits 1)" PASS
else
  assert "plan-reviewer rejects fence missing intent (--check exited $rc)" FAIL
fi

# "plan-reviewer rejects fence missing tests"
set +e; bash "$PCS" --check "$FIX/missing-tests.md" >/dev/null 2>&1; rc=$?; set -e
if [[ "$rc" -eq 1 ]]; then
  assert "plan-reviewer rejects fence missing tests (--check exits 1)" PASS
else
  assert "plan-reviewer rejects fence missing tests (--check exited $rc)" FAIL
fi

# "plan-reviewer rejects fence missing verify"
set +e; bash "$PCS" --check "$FIX/missing-verify.md" >/dev/null 2>&1; rc=$?; set -e
if [[ "$rc" -eq 1 ]]; then
  assert "plan-reviewer rejects fence missing verify (--check exits 1)" PASS
else
  assert "plan-reviewer rejects fence missing verify (--check exited $rc)" FAIL
fi

# "plan-reviewer accepts old-format plan without fence"
# legacy plans: plan-check.sh succeeds with exit 0.
set +e; bash "$PCS" --check "$FIX/legacy-no-fence.md" >/dev/null 2>&1; rc=$?; set -e
if [[ "$rc" -eq 0 ]]; then
  assert "plan-reviewer accepts old-format plan without fence (--check exit 0)" PASS
else
  assert "plan-reviewer accepts old-format plan without fence (--check exited $rc)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
