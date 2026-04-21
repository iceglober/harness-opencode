#!/usr/bin/env bash
# Verifies §6 decomposition acceptance criteria (a1, a2, a3b).
# Structural-content tests — no runtime execution, just file assertions.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC2034
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

echo "==> test/docs-decomposition.sh"

# ---- a1: autopilot-mode extraction ----

# "autopilot-mode docs file exists"
if [[ -f home/.claude/docs/autopilot-mode.md ]] \
   && head -1 home/.claude/docs/autopilot-mode.md | grep -q '^# Autopilot mode'; then
  assert "autopilot-mode docs file exists" PASS
else
  assert "autopilot-mode docs file exists" FAIL
fi

# "orchestrator.md no longer contains 'Rule 1 — Question suppression'"
if ! grep -q 'Rule 1 — Question suppression' home/.claude/agents/orchestrator.md; then
  assert "orchestrator.md no longer contains 'Rule 1 — Question suppression'" PASS
else
  assert "orchestrator.md no longer contains 'Rule 1 — Question suppression'" FAIL
fi

# "orchestrator.md contains pointer to docs/autopilot-mode.md"
if grep -q 'docs/autopilot-mode.md' home/.claude/agents/orchestrator.md; then
  assert "orchestrator.md contains pointer to docs/autopilot-mode.md" PASS
else
  assert "orchestrator.md contains pointer to docs/autopilot-mode.md" FAIL
fi

# "orchestrator.md total lines < 240"
orch_lines=$(wc -l < home/.claude/agents/orchestrator.md)
if [[ "$orch_lines" -lt 260 ]]; then
  assert "orchestrator.md total lines < 260 (actual: $orch_lines)" PASS
else
  assert "orchestrator.md total lines < 260 (actual: $orch_lines)" FAIL
fi

# ---- a2: /autopilot command inlines the rules ----

# "autopilot.md inlines autopilot-mode.md content"
# Check for the presence of each of the 8 rule headings from the docs file
# in the slash-command prompt.
all_rules_present="PASS"
for rule in \
  "Rule 1 — Question suppression" \
  "Rule 2 — Scope anchor" \
  "Rule 3 — Precedent defaults" \
  "Rule 4 — Plan-revision budget" \
  "Rule 5 — Completion-promise emission" \
  "Rule 6 — Verifier invocation" \
  "Rule 7 — Verifier verdict handling" \
  "Rule 8 — Do not call"; do
  if ! grep -q "$rule" home/.claude/commands/autopilot.md; then
    all_rules_present="FAIL: missing '$rule'"
    break
  fi
done
if [[ "$all_rules_present" == "PASS" ]]; then
  assert "autopilot.md inlines autopilot-mode.md content" PASS
else
  assert "autopilot.md inlines autopilot-mode.md content ($all_rules_present)" FAIL
fi

# ---- a3b: hashline extraction ----

# "hashline docs file exists and starts with # Hashline"
if [[ -f home/.claude/docs/hashline.md ]] \
   && head -1 home/.claude/docs/hashline.md | grep -q '^# Hashline'; then
  assert "hashline docs file exists and starts with # Hashline" PASS
else
  assert "hashline docs file exists and starts with # Hashline" FAIL
fi

# "AGENTS.md no longer contains 'Hash verification rules'"
if ! grep -q 'Hash verification rules' home/.config/opencode/AGENTS.md; then
  assert "AGENTS.md no longer contains 'Hash verification rules'" PASS
else
  assert "AGENTS.md no longer contains 'Hash verification rules'" FAIL
fi

# "AGENTS.md contains pointer to docs/hashline.md"
if grep -q 'docs/hashline.md' home/.config/opencode/AGENTS.md; then
  assert "AGENTS.md contains pointer to docs/hashline.md" PASS
else
  assert "AGENTS.md contains pointer to docs/hashline.md" FAIL
fi

# "AGENTS.md total lines < 130"
agents_lines=$(wc -l < home/.config/opencode/AGENTS.md)
if [[ "$agents_lines" -lt 130 ]]; then
  assert "AGENTS.md total lines < 130 (actual: $agents_lines)" PASS
else
  assert "AGENTS.md total lines < 130 (actual: $agents_lines)" FAIL
fi

# ---- summary ----

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
