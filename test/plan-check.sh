#!/usr/bin/env bash
# Verifies §4 plan-check.sh behavior (a10).
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PCS=home/.claude/bin/plan-check.sh
FIX=test/fixtures/plans

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

echo "==> test/plan-check.sh"

# "parses three-field fence correctly"
out=$(bash "$PCS" "$FIX/valid-fenced.md")
first_line=$(echo "$out" | head -1)
if [[ "$first_line" == "total=2 done=1 pending=1 invalid=0" ]]; then
  assert "parses three-field fence correctly" PASS
else
  assert "parses three-field fence correctly (got '$first_line')" FAIL
fi

# "counts done vs pending from - [x] vs - [ ]"
# valid-fenced has v1 pending and v2 done.
if echo "$out" | grep -qE '^done v2' && echo "$out" | grep -qE '^pending v1'; then
  assert "counts done vs pending from - [x] vs - [ ]" PASS
else
  assert "counts done vs pending from - [x] vs - [ ] (status tags wrong)" FAIL
fi

# "rejects items missing intent/tests/verify"
for fix_name in missing-intent missing-tests missing-verify; do
  set +e
  bash "$PCS" --check "$FIX/$fix_name.md" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ "$rc" -eq 1 ]]; then
    assert "rejects items missing intent/tests/verify ($fix_name → exit 1)" PASS
  else
    assert "rejects items missing intent/tests/verify ($fix_name → expected exit 1, got $rc)" FAIL
  fi
done

# "--run prints verify commands one per line"
run_out=$(bash "$PCS" --run "$FIX/valid-fenced.md")
run_lines=$(echo "$run_out" | wc -l | tr -d ' ')
# valid-fenced has 1 pending → 1 line
if [[ "$run_lines" == "1" ]] && [[ "$run_out" == "bash test/valid.sh" ]]; then
  assert "--run prints verify commands one per line" PASS
else
  assert "--run prints verify commands one per line (got $run_lines lines, content '$run_out')" FAIL
fi

# "--run does NOT execute commands"
# Fixture verify: `touch /tmp/plan-check-should-not-run-$$.txt` — if --run
# executes, the file will exist. Create a one-off fixture for this.
TEMP_PLAN="$(mktemp -t plan-check-test.XXXXXX).md"
CANARY="/tmp/plan-check-canary-$$.txt"
cat > "$TEMP_PLAN" <<EOF
# Canary plan
## Acceptance criteria
\`\`\`plan-state
- [ ] id: c1
  intent: canary test
  tests:
    - fake.sh::"canary"
  verify: touch $CANARY
\`\`\`
EOF
rm -f "$CANARY"
bash "$PCS" --run "$TEMP_PLAN" >/dev/null
if [[ ! -e "$CANARY" ]]; then
  assert "--run does NOT execute commands" PASS
else
  assert "--run does NOT execute commands (canary at $CANARY was created!)" FAIL
fi
rm -f "$TEMP_PLAN" "$CANARY"

# "plan without fence returns graceful (no fence, fallback)"
legacy_out=$(bash "$PCS" "$FIX/legacy-no-fence.md")
if [[ "$legacy_out" == "legacy (no plan-state fence)" ]]; then
  assert "plan without fence returns graceful (no fence, fallback)" PASS
else
  assert "plan without fence returns graceful (got '$legacy_out')" FAIL
fi

# "fence inside ## Acceptance criteria only (ignores other blocks)"
# fence-outside-ac has a fence in ## Goal — should be ignored, treated as
# legacy.
out_outside=$(bash "$PCS" "$FIX/fence-outside-ac.md")
if [[ "$out_outside" == "legacy (no plan-state fence)" ]]; then
  assert "fence inside ## Acceptance criteria only (ignores other blocks)" PASS
else
  assert "fence inside ## Acceptance criteria only (got '$out_outside')" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
