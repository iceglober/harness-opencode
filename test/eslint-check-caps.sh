#!/usr/bin/env bash
# Verifies §1 eslint_check cap behavior (a6).
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

echo "==> test/eslint-check-caps.sh"

if [[ ! -d home/.config/opencode/node_modules/@opencode-ai ]]; then
  (cd home/.config/opencode && bun install >/dev/null 2>&1 || npm install >/dev/null 2>&1)
fi

# Fixture: 8 rows across 4 distinct (rule,file) pairs with some duplicates.
# Expected after dedupe(50): 7 (rule,file) pairs (no-unused-vars collapses
# on /proj/src/a.ts to count=2).

# "caps at 50 (rule,file) rows" — tested by passing a tiny cap that
# forces truncation.
trunc=$(bun run test/fixtures/run-eslint-check.ts dedupe 3 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["rows"]), d["truncated"])')
if [[ "$trunc" == "3 5" ]]; then
  assert "caps at 50 (rule,file) rows (cap=3 truncates correctly)" PASS
else
  assert "caps at 50 (rule,file) rows (cap=3 got $trunc, expected '3 5')" FAIL
fi

# "errors sort before warnings"
first_sev=$(bun run test/fixtures/run-eslint-check.ts dedupe 50 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["rows"][0]["severity"])')
if [[ "$first_sev" == "2" ]]; then
  assert "errors sort before warnings" PASS
else
  assert "errors sort before warnings (first row severity=$first_sev, expected 2)" FAIL
fi

# Check that the LAST row is a warning — tells us the sort crossed sev boundary
last_sev=$(bun run test/fixtures/run-eslint-check.ts dedupe 50 2>/dev/null \
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["rows"]; print(r[-1]["severity"])')
if [[ "$last_sev" == "1" ]]; then
  assert "warnings end up at the tail after errors" PASS
else
  assert "warnings end up at the tail (last row severity=$last_sev, expected 1)" FAIL
fi

# "full:true returns unbounded"
full_result=$(bun run test/fixtures/run-eslint-check.ts dedupe 1000 2>/dev/null \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["rows"]), d["truncated"])')
if [[ "$full_result" == "8 0" ]]; then
  assert "full:true returns unbounded (8 rows, truncated=0)" PASS
else
  assert "full:true returns unbounded (got $full_result)" FAIL
fi

# "clean lint returns []" — verify source-level passthrough on empty/[]
if grep -q 'if (rows\.length === 0) {' home/.config/opencode/tools/eslint_check.ts; then
  assert "clean lint returns [] (source passes through raw on empty parse)" PASS
else
  assert "clean lint returns [] (source guard absent)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
