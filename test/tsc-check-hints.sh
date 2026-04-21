#!/usr/bin/env bash
# Verifies §7 remediation hints on tsc_check (a8).
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

echo "==> test/tsc-check-hints.sh"

if [[ ! -d home/.config/opencode/node_modules/@opencode-ai ]]; then
  (cd home/.config/opencode && bun install >/dev/null 2>&1 || npm install >/dev/null 2>&1)
fi

EXPECTED_CODES=(TS2322 TS2345 TS2531 TS18048 TS2307 TS7006 TS2339 TS2304 TS2532 TS18047 TS2769 TS2741 TS2739 TS2554 TS2551 TS7016 TS2367 TS1005 TS1109 TS2420)

HINTS_JSON=$(bun run test/fixtures/run-tsc-check.ts hints-table 2>/dev/null)

# "hint table exports all 20 codes"
missing=""
for code in "${EXPECTED_CODES[@]}"; do
  has=$(echo "$HINTS_JSON" | python3 -c "import sys,json; print('$code' in json.load(sys.stdin))")
  if [[ "$has" != "True" ]]; then
    missing="$missing $code"
  fi
done
if [[ -z "$missing" ]]; then
  assert "hint table exports all 20 codes" PASS
else
  assert "hint table exports all 20 codes (missing:$missing)" FAIL
fi

# "every hint is <= 80 chars"
LENGTHS=$(bun run test/fixtures/run-tsc-check.ts hint-lengths 2>/dev/null)
over80=$(echo "$LENGTHS" | python3 -c '
import sys, json
data = json.load(sys.stdin)
over = [d for d in data if d["length"] > 80]
for d in over:
  print("{0}={1}".format(d["code"], d["length"]))
')
if [[ -z "$over80" ]]; then
  assert "every hint is <= 80 chars" PASS
else
  assert "every hint is <= 80 chars (over: $over80)" FAIL
fi

# "TS2322 row carries remediation hint" — format-first pipeline should
# produce a row with an inline hint for TS2322.
FORMAT_OUT=$(bun run test/fixtures/run-tsc-check.ts format-first 2>/dev/null)
if echo "$FORMAT_OUT" | grep -q 'TS2322' \
   && echo "$FORMAT_OUT" | grep -qE '→ Assigned type'; then
  assert "TS2322 row carries remediation hint" PASS
else
  assert "TS2322 row carries remediation hint (format-first output lacks hint arrow)" FAIL
fi

# "unknown code has no hint suffix" — TS9999 is in the fixture and has no
# entry in REMEDIATION_HINTS; its row must not carry '    → '.
# Use format-all (no cap) since TS9999 has count=1 and would be truncated
# by the default cap=15 after higher-count codes.
FORMAT_ALL=$(bun run test/fixtures/run-tsc-check.ts format-all 2>/dev/null)
TS9999_LINE=$(echo "$FORMAT_ALL" | grep 'TS9999' || true)
if [[ -n "$TS9999_LINE" ]]; then
  # Look at whether the NEXT line (the hint suffix) starts with '    →'.
  HINT_AFTER_TS9999=$(echo "$FORMAT_ALL" | awk '/TS9999/{found=1; next} found && /^    →/{print; exit}')
  if [[ -z "$HINT_AFTER_TS9999" ]]; then
    assert "unknown code has no hint suffix" PASS
  else
    assert "unknown code has no hint suffix (TS9999 row has hint: $HINT_AFTER_TS9999)" FAIL
  fi
else
  assert "unknown code has no hint suffix (TS9999 not in format-all output; fixture dropped?)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
