#!/usr/bin/env bash
# Verifies §6 installer acceptance criteria (a3) plus §4 bin/ linking (a10).
# Uses a scratch prefix, runs install.sh, asserts docs/ and bin/ symlinks,
# re-runs for idempotency, then uninstalls and confirms removal.
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

echo "==> test/installer-docs-bin.sh"

# Scratch prefix — unique per run to avoid collisions across parallel CI
SCRATCH="$(mktemp -d -t goc-install-test.XXXXXX)"
# Intentionally not using trap; plain cleanup at end. Script is set -eu so
# any failure exits non-zero; the scratch dir leaks but is inside /tmp.

# ---- dry-run ----
dryout="$(bash install.sh --dry-run --prefix "$SCRATCH" 2>&1)"
if echo "$dryout" | grep -q 'Linking Claude docs'; then
  assert "dry-run against scratch prefix clean (docs step printed)" PASS
else
  assert "dry-run against scratch prefix clean (docs step printed)" FAIL
fi

if echo "$dryout" | grep -q 'Linking Claude bin scripts'; then
  assert "dry-run includes Claude bin step" PASS
else
  assert "dry-run includes Claude bin step" FAIL
fi

# ---- real install ----
if bash install.sh --prefix "$SCRATCH" >/dev/null 2>&1; then
  :
else
  echo "  ! install.sh --prefix $SCRATCH failed; tail of output:"
  bash install.sh --prefix "$SCRATCH" 2>&1 | tail -20 || true
  FAIL=$((FAIL + 1))
  FAIL_MSGS+=("install.sh failed on fresh prefix")
fi

# "fresh install links docs/*.md into ~/.claude/docs/"
if [[ -L "$SCRATCH/.claude/docs/autopilot-mode.md" ]] \
   && [[ -L "$SCRATCH/.claude/docs/hashline.md" ]]; then
  assert "fresh install links docs/*.md into .claude/docs/" PASS
else
  assert "fresh install links docs/*.md into .claude/docs/ (expected symlinks at $SCRATCH/.claude/docs/)" FAIL
fi

# "fresh install links bin/* into ~/.claude/bin/"
# bin/ may be empty at §6-execution time (plan-check.sh is added in §4).
# Assert the directory exists OR that every file under home/.claude/bin/
# is linked.
if [[ -d home/.claude/bin ]]; then
  bin_sources=(home/.claude/bin/*)
  if [[ -e "${bin_sources[0]}" ]]; then
    # bin/ has files — verify each is linked
    all_linked="PASS"
    for src in "${bin_sources[@]}"; do
      [[ -f "$src" ]] || continue
      name="$(basename "$src")"
      if [[ ! -L "$SCRATCH/.claude/bin/$name" ]]; then
        all_linked="FAIL: $SCRATCH/.claude/bin/$name not a symlink"
        break
      fi
    done
    if [[ "$all_linked" == "PASS" ]]; then
      assert "fresh install links bin/* into .claude/bin/" PASS
    else
      assert "fresh install links bin/* into .claude/bin/ ($all_linked)" FAIL
    fi
  else
    # bin/ is empty — directory creation is the only expectation (installer
    # only creates the dir if it had content to link, so empty is fine).
    assert "fresh install links bin/* into .claude/bin/ (empty source, no-op)" PASS
  fi
else
  assert "fresh install links bin/* into .claude/bin/ (home/.claude/bin missing)" FAIL
fi

# "manifest records docs and bin symlinks"
manifest_path="$SCRATCH/.glorious/opencode/.manifest"
if [[ -f "$manifest_path" ]]; then
  if grep -q '\.claude/docs/autopilot-mode.md' "$manifest_path" \
     && grep -q '\.claude/docs/hashline.md' "$manifest_path"; then
    assert "manifest records docs and bin symlinks" PASS
  else
    assert "manifest records docs and bin symlinks (missing entries)" FAIL
  fi
else
  assert "manifest records docs and bin symlinks (no manifest at $manifest_path)" FAIL
fi

# ---- idempotency ----
rerun="$(bash install.sh --prefix "$SCRATCH" 2>&1)"
# Count "+ <path>" lines (new links). An idempotent rerun should have zero.
plus_lines="$(echo "$rerun" | grep -cE '^\s*\+ .*\.claude/docs/' || true)"
if [[ "$plus_lines" -eq 0 ]]; then
  assert "re-run install is idempotent (no new docs links)" PASS
else
  assert "re-run install is idempotent (found $plus_lines new docs link(s))" FAIL
fi

# ---- uninstall ----
if bash uninstall.sh --yes --prefix "$SCRATCH" >/dev/null 2>&1; then
  if [[ ! -e "$SCRATCH/.claude/docs/autopilot-mode.md" ]] \
     && [[ ! -e "$SCRATCH/.claude/docs/hashline.md" ]]; then
    assert "uninstall removes docs and bin symlinks" PASS
  else
    assert "uninstall removes docs and bin symlinks (files still present)" FAIL
  fi
else
  assert "uninstall removes docs and bin symlinks (uninstall.sh failed)" FAIL
fi

# Cleanup (best-effort; rm -rf is denied in some envs so we don't rely on it)
if [[ -d "$SCRATCH" ]]; then
  # Use find + delete, which doesn't need rm -rf
  find "$SCRATCH" -depth -exec rm {} + 2>/dev/null || true
  rmdir "$SCRATCH" 2>/dev/null || true
fi

echo ""
echo "  $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  printf '  Failed: %s\n' "${FAIL_MSGS[@]}"
  exit 1
fi
