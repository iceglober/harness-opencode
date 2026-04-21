#!/usr/bin/env bash
# Fixture-based tests for test/inline-merge.js.
#
# Each scenario has:
#   test/fixtures/opencode-json/scenario-N-<name>.input.json     — user's starting config
#   test/fixtures/opencode-json/scenario-N-<name>.expected.json  — expected output (for successful merges)
#
# Plus cross-scenario shared:
#   test/fixtures/opencode-json/src.json                         — the shipped (source) config
#
# Per-scenario expectations (exit code, stderr substrings) are encoded inline below.
#
# Usage:
#   bash test/merge-opencode-json.sh
#
# Exits 0 if all scenarios pass, 1 on the first failure.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/fixtures/opencode-json"
MERGE="$HERE/inline-merge.js"
SRC="$FIXTURES/src.json"

if [[ ! -f "$MERGE" ]]; then
  echo "FAIL: merge script not found at $MERGE" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "FAIL: fixture src not found at $SRC" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: 'node' is required to run these tests" >&2
  exit 1
fi

c_reset=$'\033[0m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_bold=$'\033[1m'

pass_count=0
fail_count=0

# Shared tmpdir; each scenario gets a subdir. Cleanup on exit.
TMPROOT="$(mktemp -d)"
trap 'find "$TMPROOT" -mindepth 1 -delete 2>/dev/null; rmdir "$TMPROOT" 2>/dev/null || true' EXIT

_fail() {
  printf "${c_red}✗ FAIL${c_reset} %s: %s\n" "$SCENARIO" "$1" >&2
  fail_count=$((fail_count + 1))
}
_pass() {
  printf "${c_green}✓ PASS${c_reset} %s\n" "$SCENARIO"
  pass_count=$((pass_count + 1))
}

# Normalize a JSON file via node: parse → re-serialize with 2-space indent + trailing newline.
# Matches the inline-merge.js output format, which is what we diff against.
_normalize_json() {
  local in="$1" out="$2"
  node -e '
    const fs = require("fs");
    const s = fs.readFileSync(process.argv[1], "utf8");
    fs.writeFileSync(process.argv[2], JSON.stringify(JSON.parse(s), null, 2) + "\n");
  ' "$in" "$out"
}

# Run a scenario.
#   $1 — scenario name (matches fixture prefix)
#   $2 — expected exit code
#   $3 — "yes" | "no" — whether a .expected.json should be compared
#   $4 — stderr substring that MUST appear (empty = no check)
_run() {
  SCENARIO="$1"
  local expected_exit="$2"
  local compare_expected="$3"
  local stderr_must_contain="$4"

  local workdir="$TMPROOT/$SCENARIO"
  mkdir -p "$workdir"

  local input="$FIXTURES/${SCENARIO}.input.json"
  local expected="$FIXTURES/${SCENARIO}.expected.json"
  local actual="$workdir/actual.json"
  local stderr_capture="$workdir/stderr.txt"
  local stdout_capture="$workdir/stdout.txt"

  if [[ ! -f "$input" ]]; then
    _fail "missing input fixture at $input"
    return
  fi

  cp "$input" "$actual"

  local actual_exit=0
  node "$MERGE" "$SRC" "$actual" 0 > "$stdout_capture" 2> "$stderr_capture" || actual_exit=$?

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    _fail "expected exit $expected_exit, got $actual_exit. stderr:"
    sed 's/^/    /' "$stderr_capture" >&2
    return
  fi

  if [[ -n "$stderr_must_contain" ]]; then
    if ! grep -q "$stderr_must_contain" "$stderr_capture"; then
      _fail "expected stderr to contain '$stderr_must_contain'. Actual stderr:"
      sed 's/^/    /' "$stderr_capture" >&2
      return
    fi
  fi

  if [[ "$compare_expected" == "yes" ]]; then
    if [[ ! -f "$expected" ]]; then
      _fail "missing expected fixture at $expected"
      return
    fi
    # Normalize both sides to defeat incidental formatting differences in the
    # hand-written expected file (trailing whitespace, non-standard indent).
    # The inline-merge.js output is canonical JSON.stringify(…, null, 2) + "\n".
    local expected_norm="$workdir/expected.json"
    local actual_norm="$workdir/actual.norm.json"
    _normalize_json "$expected" "$expected_norm"
    _normalize_json "$actual" "$actual_norm"
    if ! diff -u "$expected_norm" "$actual_norm" > "$workdir/diff.out"; then
      _fail "actual output differs from expected:"
      sed 's/^/    /' "$workdir/diff.out" >&2
      return
    fi
    # Also verify no stray .bak.* or .merge.tmp.* files were left alongside.
    local strays
    strays="$(find "$workdir" -name "*.bak.*" -o -name "*.merge.tmp.*" 2>/dev/null | head -5)"
    if [[ -n "$strays" ]]; then
      # Note: a backup is expected if the scenario mutated. Just verify there's
      # no tempfile debris (the rename should have cleaned that up).
      local tmp_debris
      tmp_debris="$(find "$workdir" -name "*.merge.tmp.*" 2>/dev/null)"
      if [[ -n "$tmp_debris" ]]; then
        _fail "tempfile debris left behind: $tmp_debris"
        return
      fi
    fi
  else
    # compare_expected=="no" → scenario expected not to mutate. Verify actual is
    # unchanged from input.
    if ! cmp -s "$input" "$actual"; then
      _fail "input was modified when it should have been left alone:"
      diff -u "$input" "$actual" | sed 's/^/    /' >&2
      return
    fi
    # And verify no backup was created.
    if find "$workdir" -name "*.bak.*" 2>/dev/null | grep -q .; then
      _fail "a backup was created when it should not have been:"
      find "$workdir" -name "*.bak.*" | sed 's/^/    /' >&2
      return
    fi
  fi

  _pass
}

printf "${c_bold}Running merge-opencode-json scenarios${c_reset}\n"
printf "  MERGE: %s\n" "$MERGE"
printf "  SRC:   %s\n" "$SRC"
echo

# Scenario 1: vanilla user missing external_directory + plugin ok → full merge, exit 0.
_run "scenario-1-vanilla" 0 "yes" ""

# Scenario 2: heavily customized → merge preserves user keys, adds ours. Exit 0.
_run "scenario-2-heavily-customized" 0 "yes" ""

# Scenario 3: user has external_directory with own glob → ours appended alongside. Exit 0.
_run "scenario-3-has-external-directory-object" 0 "yes" ""

# Scenario 4: scalar-vs-object collision → no mutation, warning to stderr, exit 0.
_run "scenario-4-scalar-collision" 0 "no" "WARN: scalar-vs-object"

# Scenario 5: malformed JSON → exit 1, stderr mentions "invalid JSON", no write.
_run "scenario-5-malformed" 1 "no" "invalid JSON"

echo
if [[ $fail_count -eq 0 ]]; then
  printf "${c_green}${c_bold}All %d scenarios passed.${c_reset}\n" "$pass_count"
  exit 0
fi
printf "${c_red}${c_bold}%d/%d scenarios failed.${c_reset}\n" "$fail_count" "$((pass_count + fail_count))" >&2
exit 1
