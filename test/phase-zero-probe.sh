#!/usr/bin/env bash
# Verifies §5 Phase 0 bootstrap probe acceptance criteria (a4).
# Structural-content tests: the probe is prompt text in orchestrator.md,
# not runnable code. We verify its presence, content, and ordering.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
FAIL_MSGS=()

assert() {
  local desc="$1"
  local result="$2"
  if [[ "$result" == "PASS" ]]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
    FAIL_MSGS+=("$desc")
  fi
}

echo "==> test/phase-zero-probe.sh"

ORCH=home/.claude/agents/orchestrator.md

# "orchestrator.md contains Phase 0 section before Phase 1"
phase0_line=$(grep -n '^## Phase 0' "$ORCH" | head -1 | cut -d: -f1 || true)
phase1_line=$(grep -n '^## Phase 1' "$ORCH" | head -1 | cut -d: -f1 || true)
if [[ -n "$phase0_line" ]] && [[ -n "$phase1_line" ]] && [[ "$phase0_line" -lt "$phase1_line" ]]; then
  assert "orchestrator.md contains Phase 0 section before Phase 1" PASS
else
  assert "orchestrator.md contains Phase 0 section before Phase 1 (p0=$phase0_line, p1=$phase1_line)" FAIL
fi

# "Phase 0 references the four probe commands"
# Check: pwd, git status --short, git log --oneline -5, ls .agent/plans/
all_probes="PASS"
for probe in 'pwd' 'git status --short' 'git log --oneline -5' 'ls .agent/plans/'; do
  if ! grep -qF "$probe" "$ORCH"; then
    all_probes="FAIL: missing '$probe'"
    break
  fi
done
if [[ "$all_probes" == "PASS" ]]; then
  assert "Phase 0 references the four probe commands" PASS
else
  assert "Phase 0 references the four probe commands ($all_probes)" FAIL
fi

# "Phase 0 handles missing .agent/plans gracefully"
# Check: the probe uses `2>/dev/null` on the ls command (quiet on missing dir)
if grep -q 'ls \.agent/plans/ 2>/dev/null' "$ORCH"; then
  assert "Phase 0 handles missing .agent/plans gracefully" PASS
else
  assert "Phase 0 handles missing .agent/plans gracefully (no 2>/dev/null redirect on ls)" FAIL
fi

# "Phase 0 staleness check uses merge-base, not branch --merged"
# Rationale: `git branch --merged` is unreliable across detached HEAD / fresh
# clones. `git merge-base --is-ancestor` is the robust primitive.
if grep -qF 'merge-base --is-ancestor' "$ORCH"; then
  if ! grep -qF 'branch --merged' "$ORCH"; then
    assert "Phase 0 staleness check uses merge-base, not branch --merged" PASS
  else
    assert "Phase 0 staleness check uses merge-base, not branch --merged (found branch --merged — should use merge-base)" FAIL
  fi
else
  assert "Phase 0 staleness check uses merge-base, not branch --merged (merge-base not found)" FAIL
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
