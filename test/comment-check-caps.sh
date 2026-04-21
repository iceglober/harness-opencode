#!/usr/bin/env bash
# Verifies §1 comment_check defaults (a7). Source-grepping tests since
# the tool calls rg internally and integration-testing requires a full
# opencode runtime.
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

echo "==> test/comment-check-caps.sh"

CC=home/.config/opencode/tools/comment_check.ts

# "default cap is 30"
# The maxResults default is a .number().default(30) schema call.
if grep -E 'maxResults: tool\.schema' "$CC" -A 3 | grep -qE '\.default\(30\)'; then
  assert "default cap is 30" PASS
else
  assert "default cap is 30 (source does not .default(30) on maxResults)" FAIL
fi

# "sort by age desc when includeAge:true"
# Source should sort rows by ageDays desc when args.includeAge is true.
if grep -q 'if (args\.includeAge) {' "$CC" \
   && grep -qE 'rows\.sort\(' "$CC" \
   && grep -qE 'b\.ageDays - a\.ageDays' "$CC"; then
  assert "sort by age desc when includeAge:true" PASS
else
  assert "sort by age desc when includeAge:true (source missing age-desc sort)" FAIL
fi

# "explicit maxResults override still works"
# The arg is still a number schema — user can pass 200 and override 30.
if grep -qE 'maxResults: tool\.schema' "$CC"; then
  assert "explicit maxResults override still works (schema arg preserved)" PASS
else
  assert "explicit maxResults override still works (schema arg missing)" FAIL
fi

# Bonus: when includeAge is false (default), no sort happens — verifies
# we preserve the legacy "iteration order" behavior for repos that rely
# on it. Expressed as: the sort call must be INSIDE the `if (args.includeAge)`.
awk 'BEGIN{inside=0; ok=0}
     /if \(args\.includeAge\) \{/{inside=1}
     inside==1 && /rows\.sort/{ok=1}
     inside==1 && /^    \}/{inside=0}
     END{exit !ok}' "$CC" && age_guards_sort=1 || age_guards_sort=0
if [[ "$age_guards_sort" == "1" ]]; then
  assert "age sort is gated on includeAge (not applied unconditionally)" PASS
else
  assert "age sort is gated on includeAge (sort appears outside guard)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
