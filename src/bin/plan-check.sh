#!/usr/bin/env bash
# plan-check.sh — parse a plan file's plan-state fence and report on it.
#
# Modes:
#   plan-check.sh <path>        Prints a summary line then one line per item:
#                               `total=N done=M pending=K invalid=I`
#                               `STATUS ID VERIFY`  (one per item)
#
#   plan-check.sh --run <path>  Prints the verify command of each PENDING
#                               item on stdout, one per line, raw. The
#                               caller is responsible for executing them.
#                               This script NEVER executes verify commands
#                               itself — that would bypass the caller's
#                               bash-permission scope.
#
#   plan-check.sh --check <path>
#                               Structural validation only. Exits 1 if any
#                               fence item is missing a required field.
#
# Fence format, inside `## Acceptance criteria`:
#
#   ```plan-state
#   - [ ] id: a1
#     intent: Prose description of business intent (one line).
#     tests:
#       - path/to/test.sh::"some test name"
#       - path/to/other.ts::"another test"
#     verify: bash path/to/test.sh
#
#   - [x] id: a2
#     ...
#   ```
#
# Backward compat: a plan without a ```plan-state fence emits the line
# `legacy` and exits 0 — callers treat it as "old format, fall back".
#
# Portability: POSIX bash + awk + grep only. No sed -i.

set -eu

MODE=""
PLAN_PATH=""

case "${1:-}" in
  --run)   MODE=run;    PLAN_PATH="${2:-}" ;;
  --check) MODE=check;  PLAN_PATH="${2:-}" ;;
  -h|--help|"")
    sed -n '2,34p' "$0"
    exit 0
    ;;
  *)       MODE=summary; PLAN_PATH="${1:-}" ;;
esac

if [[ -z "${PLAN_PATH:-}" ]]; then
  echo "plan-check.sh: missing plan path" >&2
  exit 2
fi

if [[ ! -f "$PLAN_PATH" ]]; then
  echo "plan-check.sh: file not found: $PLAN_PATH" >&2
  exit 2
fi

# Extract the plan-state fence body into a temp file. awk state machine:
# enter `## Acceptance criteria`, enter ``` plan-state, exit on next ```.
FENCE_BODY="$(awk '
  /^## Acceptance criteria/ { in_ac = 1; next }
  /^## / && in_ac && !in_fence { in_ac = 0 }
  in_ac && /^```plan-state[[:space:]]*$/ { in_fence = 1; next }
  in_fence && /^```[[:space:]]*$/ { in_fence = 0; next }
  in_fence { print }
' "$PLAN_PATH")"

if [[ -z "$FENCE_BODY" ]]; then
  # No fence found — legacy plan. Report and exit cleanly.
  if [[ "$MODE" == "summary" ]]; then
    echo "legacy (no plan-state fence)"
  fi
  # --run on a legacy plan emits nothing (no commands to run).
  # --check on a legacy plan succeeds (we're accepting legacy plans).
  exit 0
fi

# Parse items. awk state machine:
# - A line `- [ ] id: ID` or `- [x] id: ID` starts a new item.
# - While inside an item, indented keys `intent:`, `tests:`, `verify:` set
#   fields. Under `tests:`, subsequent `  - ...` lines extend the list
#   until the next key or the next item.
# - Items are separated by one or more blank lines OR by the next `- [`.
#
# We emit a tab-delimited record per item:
#   STATUS<TAB>ID<TAB>INTENT<TAB>TESTS<TAB>VERIFY
# TESTS is a `|`-delimited list. Missing fields are the empty string.
PARSED="$(echo "$FENCE_BODY" | awk '
  function flush() {
    if (cur_id != "") {
      # Trim trailing/leading whitespace on each field
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", cur_intent)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", cur_verify)
      gsub(/^\||\|$/, "", cur_tests)
      printf "%s\t%s\t%s\t%s\t%s\n", cur_status, cur_id, cur_intent, cur_tests, cur_verify
    }
    cur_status = ""; cur_id = ""; cur_intent = ""; cur_tests = ""; cur_verify = ""
    in_tests = 0
  }

  /^-[[:space:]]+\[[[:space:]xX[:space:]]\][[:space:]]+id:/ {
    flush()
    status = $0
    sub(/^-[[:space:]]+\[[[:space:]]*/, "", status)
    sub(/\].*$/, "", status)
    # status is either empty/space (" ") -> pending, or "x"/"X" -> done
    if (status ~ /[xX]/) cur_status = "done"; else cur_status = "pending"
    # Capture id
    id_part = $0
    sub(/^.*id:[[:space:]]*/, "", id_part)
    cur_id = id_part
    next
  }

  /^[[:space:]]*intent:/ {
    field = $0
    sub(/^[[:space:]]*intent:[[:space:]]*/, "", field)
    cur_intent = field
    in_tests = 0
    next
  }

  /^[[:space:]]*intent\b/ {
    # already handled
    next
  }

  /^[[:space:]]*tests:/ {
    in_tests = 1
    next
  }

  /^[[:space:]]*verify:/ {
    field = $0
    sub(/^[[:space:]]*verify:[[:space:]]*/, "", field)
    cur_verify = field
    in_tests = 0
    next
  }

  # Continuation lines inside tests: list
  in_tests && /^[[:space:]]+-[[:space:]]/ {
    line = $0
    sub(/^[[:space:]]+-[[:space:]]+/, "", line)
    if (cur_tests == "") cur_tests = line
    else cur_tests = cur_tests "|" line
    next
  }

  # Continuation line for intent (indented without `-`, after intent is set
  # and before another key). Append with a space separator.
  !in_tests && /^[[:space:]]{4,}[^-[:space:]]/ && cur_id != "" && cur_intent != "" && cur_verify == "" {
    line = $0
    sub(/^[[:space:]]+/, "", line)
    cur_intent = cur_intent " " line
    next
  }

  END { flush() }
' 2>&1)"

# If PARSED contains awk errors, surface them as invalid.
if echo "$PARSED" | grep -q '^awk:'; then
  echo "plan-check.sh: parser error" >&2
  echo "$PARSED" >&2
  exit 3
fi

# Count totals.
total=0
done_count=0
pending_count=0
invalid_count=0
invalid_reasons=()

while IFS=$'\t' read -r status id intent tests verify; do
  [[ -z "$status" ]] && continue
  total=$((total + 1))
  if [[ -z "$id" ]]; then
    invalid_count=$((invalid_count + 1))
    invalid_reasons+=("missing id")
    continue
  fi
  if [[ -z "$intent" ]]; then
    invalid_count=$((invalid_count + 1))
    invalid_reasons+=("$id: missing intent")
    continue
  fi
  if [[ -z "$tests" ]]; then
    invalid_count=$((invalid_count + 1))
    invalid_reasons+=("$id: missing tests")
    continue
  fi
  if [[ -z "$verify" ]]; then
    invalid_count=$((invalid_count + 1))
    invalid_reasons+=("$id: missing verify")
    continue
  fi
  if [[ "$status" == "done" ]]; then
    done_count=$((done_count + 1))
  else
    pending_count=$((pending_count + 1))
  fi
done <<< "$PARSED"

case "$MODE" in
  summary)
    printf 'total=%d done=%d pending=%d invalid=%d\n' \
      "$total" "$done_count" "$pending_count" "$invalid_count"
    while IFS=$'\t' read -r status id intent tests verify; do
      [[ -z "$status" ]] && continue
      # For the summary-per-item line, prefer displaying the verify
      # command (truncated) so the reader sees what gates each item.
      v="${verify:0:60}"
      if [[ -n "$verify" && ${#verify} -gt 60 ]]; then v="${v}…"; fi
      printf '%s %s %s\n' "$status" "$id" "$v"
    done <<< "$PARSED"
    if [[ "$invalid_count" -gt 0 ]]; then
      echo "invalid:"
      for r in "${invalid_reasons[@]}"; do
        echo "  $r"
      done
    fi
    ;;

  run)
    # Emit verify command per PENDING item, one per line. Skip done items,
    # skip invalid items. Caller executes via their own bash permission.
    while IFS=$'\t' read -r status id intent tests verify; do
      [[ -z "$status" ]] && continue
      [[ "$status" == "done" ]] && continue
      [[ -z "$verify" ]] && continue
      [[ -z "$intent" || -z "$tests" ]] && continue
      echo "$verify"
    done <<< "$PARSED"
    ;;

  check)
    # Structural validation. Exit 1 if anything invalid.
    if [[ "$invalid_count" -gt 0 ]]; then
      echo "plan-check: $invalid_count invalid item(s):" >&2
      for r in "${invalid_reasons[@]}"; do
        echo "  $r" >&2
      done
      exit 1
    fi
    printf 'ok: %d item(s) pass structural validation\n' "$total"
    ;;
esac
