#!/usr/bin/env bash
# Verifies §7 remediation hints on eslint_check (a9).
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

echo "==> test/eslint-check-hints.sh"

if [[ ! -d home/.config/opencode/node_modules/@opencode-ai ]]; then
  (cd home/.config/opencode && bun install >/dev/null 2>&1 || npm install >/dev/null 2>&1)
fi

EXPECTED_RULES=(
  "no-unused-vars"
  "no-explicit-any"
  "prefer-const"
  "no-console"
  "eqeqeq"
  "no-empty"
  "no-shadow"
  "no-undef"
  "no-var"
  "semi"
  "quotes"
  "indent"
  "no-restricted-syntax"
  "@typescript-eslint/no-floating-promises"
  "@typescript-eslint/no-misused-promises"
)

HINTS_JSON=$(bun run test/fixtures/run-eslint-check.ts hints-table 2>/dev/null)

# "hint table exports all 15 rules"
missing=""
for rule in "${EXPECTED_RULES[@]}"; do
  has=$(echo "$HINTS_JSON" | python3 -c "import sys,json; print('$rule' in json.load(sys.stdin))")
  if [[ "$has" != "True" ]]; then
    missing="$missing $rule"
  fi
done
if [[ -z "$missing" ]]; then
  assert "hint table exports all 15 rules" PASS
else
  assert "hint table exports all 15 rules (missing:$missing)" FAIL
fi

# "every hint is <= 80 chars"
LENGTHS=$(bun run test/fixtures/run-eslint-check.ts hint-lengths 2>/dev/null)
over80=$(echo "$LENGTHS" | python3 -c '
import sys, json
data = json.load(sys.stdin)
over = [d for d in data if d["length"] > 80]
for d in over:
  print("{0}={1}".format(d["rule"], d["length"]))
')
if [[ -z "$over80" ]]; then
  assert "every hint is <= 80 chars" PASS
else
  assert "every hint is <= 80 chars (over: $over80)" FAIL
fi

# "no-unused-vars row carries hint"
FORMAT_ALL=$(bun run test/fixtures/run-eslint-check.ts format-all 2>/dev/null)
if echo "$FORMAT_ALL" | grep -q 'no-unused-vars' \
   && echo "$FORMAT_ALL" | grep -qE '→ Remove the binding'; then
  assert "no-unused-vars row carries hint" PASS
else
  assert "no-unused-vars row carries hint (arrow/hint missing)" FAIL
fi

# "unknown rule has no hint suffix"
# The fixture has an 'unknown-rule-no-hint' entry that should not carry
# a hint. Check via awk: line immediately after unknown-rule should NOT
# start with `    →`.
UNKNOWN_LINE=$(echo "$FORMAT_ALL" | grep 'unknown-rule-no-hint' || true)
if [[ -n "$UNKNOWN_LINE" ]]; then
  HINT_AFTER=$(echo "$FORMAT_ALL" | awk '/unknown-rule-no-hint/{found=1; next} found && /^    →/{print; exit}')
  if [[ -z "$HINT_AFTER" ]]; then
    assert "unknown rule has no hint suffix" PASS
  else
    assert "unknown rule has no hint suffix (got hint: $HINT_AFTER)" FAIL
  fi
else
  assert "unknown rule has no hint suffix (unknown-rule-no-hint missing from fixture output)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
