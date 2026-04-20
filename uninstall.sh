#!/usr/bin/env bash
# glorious-opencode — uninstaller
#
# Removes only the symlinks that install.sh created (tracked via .manifest).
# Real files you added yourself, and backups we created, are left alone.

set -Eeuo pipefail  # -E (errtrace): ERR trap inherits into shell functions

HOME_PREFIX="${1:-$HOME}"
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

# Clean up npm artifacts created by install.sh's npm-install step
OC_DIR="${HOME_PREFIX}/.config/opencode"
for artifact in node_modules package-lock.json bun.lock; do
  path="${OC_DIR}/${artifact}"
  if [[ -e "$path" ]]; then
    read -r -p "Delete ${path}? [y/N] " yn
    case "$yn" in
      y|Y|yes|Yes) rm -rf "$path"; ok "deleted $path" ;;
      *) info "keeping $path" ;;
    esac
  fi
done

read -r -p "Also delete the install root at ${INSTALL_ROOT}? [y/N] " yn
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

info "Done. Backup files (*.bak.*) were left in place — remove manually if desired."
