#!/usr/bin/env bash
# glorious-opencode — uninstaller
#
# Removes only the symlinks that install.sh created (tracked via .manifest).
# Real files you added yourself, and backups we created, are left alone.
#
# Usage:
#   ./uninstall.sh                   # uninstall from $HOME, interactive prompts
#   ./uninstall.sh --prefix /tmp/x   # uninstall from an alternate HOME (for testing)
#   ./uninstall.sh --yes             # answer yes to all prompts (non-interactive)
#   ./uninstall.sh --no-npm          # skip node_modules / package-lock / bun.lock cleanup
#   ./uninstall.sh --keep-root       # don't offer to delete the install root
#   ./uninstall.sh --help            # show this usage block and exit

set -Eeuo pipefail  # -E (errtrace): ERR trap inherits into shell functions

# -------- arg parsing --------
# Mirrors install.sh's flag surface. Positional args were supported
# historically but have been removed — they silently conflicted with
# install.sh's --prefix convention and there are no known users of the old
# form at this point.
HOME_PREFIX="${HOME}"
YES=0
NO_NPM=0
KEEP_ROOT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) HOME_PREFIX="$2"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    --no-npm) NO_NPM=1; shift ;;
    --keep-root) KEEP_ROOT=1; shift ;;
    --help|-h)
      sed -n '2,13p' "$0"
      exit 0 ;;
    --) shift; break ;;
    -*)
      echo "Unknown arg: $1" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 2 ;;
    *)
      echo "Positional prefix is no longer supported — use --prefix DIR instead." >&2
      echo "  e.g. $0 --prefix '$1'" >&2
      exit 2 ;;
  esac
done

GLORIOUS_ROOT="${HOME_PREFIX}/.glorious"
INSTALL_ROOT="${GLORIOUS_ROOT}/opencode"
MANIFEST="${INSTALL_ROOT}/.manifest"

c_reset=$'\033[0m'; c_yellow=$'\033[33m'; c_green=$'\033[32m'; c_red=$'\033[31m'
info() { printf "• %s\n" "$*"; }
ok()   { printf "${c_green}✓${c_reset} %s\n" "$*"; }
warn() { printf "${c_yellow}!${c_reset} %s\n" "$*"; }
err()  { printf "${c_red}✗${c_reset} %s\n" "$*" >&2; }

if [[ ! -f "$MANIFEST" ]]; then
  err "No manifest at $MANIFEST — nothing to remove (or already uninstalled)."
  exit 1
fi

info "Reading manifest: $MANIFEST"

# Check manifest schema version. Header format: `# glorious-opencode manifest v<N>`.
# Unknown/missing header ⇒ treat as legacy (v0) for forward compatibility; warn.
schema_header="$(head -n1 "$MANIFEST")"
case "$schema_header" in
  "# glorious-opencode manifest v1")
    # Supported. Skip the header line when reading entries.
    manifest_skip=1
    ;;
  *)
    warn "Manifest has no recognized schema header (got: '${schema_header}')."
    warn "Treating as legacy format (pre-v1). Upgrade by running install.sh again."
    manifest_skip=0
    ;;
esac

removed=0; skipped=0; lineno=0
while IFS= read -r entry; do
  lineno=$((lineno+1))
  # Skip header + blank + comment lines
  if [[ $lineno -le $manifest_skip ]]; then continue; fi
  [[ -z "$entry" || "$entry" == \#* ]] && continue
  if [[ -L "$entry" ]]; then
    rm -f "$entry"
    ok "removed symlink $entry"
    removed=$((removed+1))
  elif [[ -e "$entry" ]]; then
    warn "not a symlink, leaving alone: $entry"
    skipped=$((skipped+1))
  else
    # Already gone
    :
  fi
done < "$MANIFEST"

info "Removed $removed symlinks, skipped $skipped real files"

# Clean up npm artifacts created by install.sh's npm-install step.
# --no-npm skips this block entirely; --yes answers "delete" without prompting.
OC_DIR="${HOME_PREFIX}/.config/opencode"
if [[ "$NO_NPM" == 1 ]]; then
  info "Skipping npm-artifacts cleanup (--no-npm)"
else
  for artifact in node_modules package-lock.json bun.lock; do
    path="${OC_DIR}/${artifact}"
    if [[ -e "$path" ]]; then
      if [[ "$YES" == 1 ]]; then
        rm -rf "$path"
        ok "deleted $path (--yes)"
      else
        read -r -p "Delete ${path}? [y/N] " yn
        case "$yn" in
          y|Y|yes|Yes) rm -rf "$path"; ok "deleted $path" ;;
          *) info "keeping $path" ;;
        esac
      fi
    fi
  done
fi

# Decide whether to delete the install root. --keep-root short-circuits before
# any prompt; otherwise --yes answers "delete" non-interactively.
if [[ "$KEEP_ROOT" == 1 ]]; then
  info "Keeping $INSTALL_ROOT (--keep-root)"
else
  if [[ "$YES" == 1 ]]; then
    yn=y
  else
    read -r -p "Also delete the install root at ${INSTALL_ROOT}? [y/N] " yn
  fi
  case "$yn" in
    y|Y|yes|Yes)
      rm -rf "$INSTALL_ROOT"
      ok "Deleted $INSTALL_ROOT"
      # NEVER touch the shared ${GLORIOUS_ROOT} — other glorious-* tools may live there.
      if [[ -d "$GLORIOUS_ROOT" ]]; then
        remaining="$(find "$GLORIOUS_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
        if [[ "$remaining" == "0" ]]; then
          info "${GLORIOUS_ROOT} is empty; you can remove it manually if no other glorious-* tools use it"
        else
          info "${GLORIOUS_ROOT} still contains other glorious-* entries — leaving alone"
        fi
      fi
      ;;
    *)
      info "Keeping $INSTALL_ROOT (you can re-run install.sh to re-link)"
      ;;
  esac
fi

info "Done. Backup files (*.bak.*) were left in place — remove manually if desired."
