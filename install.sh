#!/usr/bin/env bash
# glorious-opencode — installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<you>/glorious-opencode/main/install.sh | bash
#
# Or after cloning locally:
#   ./install.sh                  # install/update (per-file symlinks)
#   ./install.sh --dry-run        # preview without writing
#   ./install.sh --prefix /tmp/x  # install into an alternate HOME (for testing)

set -Eeuo pipefail  # -E (errtrace): ERR trap inherits into shell functions

# -------- config --------
REPO_URL="${GLORIOUS_OC_REPO:-https://github.com/iceglober/glorious-opencode.git}"
# The glorious ecosystem shares a single root directory at $HOME/.glorious/.
# This tool installs itself at $HOME/.glorious/opencode/ so it sits alongside
# other glorious-* tools (worktrees, state, etc.) without taking its own $HOME-level dir.
HOME_PREFIX="${HOME}"
DRY_RUN=0

# -------- arg parsing --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --prefix) HOME_PREFIX="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,15p' "$0"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

GLORIOUS_ROOT="${HOME_PREFIX}/.glorious"
INSTALL_ROOT="${GLORIOUS_ROOT}/opencode"
CLAUDE_DIR="${HOME_PREFIX}/.claude"
OC_DIR="${HOME_PREFIX}/.config/opencode"
MANIFEST="${INSTALL_ROOT}/.manifest"

# -------- helpers --------
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_blue=$'\033[34m'

say()   { printf "%s\n" "$*"; }
info()  { printf "${c_blue}•${c_reset} %s\n" "$*"; }
ok()    { printf "${c_green}✓${c_reset} %s\n" "$*"; }
warn()  { printf "${c_yellow}!${c_reset} %s\n" "$*"; }
err()   { printf "${c_red}✗${c_reset} %s\n" "$*" >&2; }
step()  { printf "\n${c_bold}==> %s${c_reset}\n" "$*"; }

# run ARGV... — execute a command. In --dry-run mode, print it instead.
# Always pass argv (no embedded shell quoting). For commands that need a
# subshell (cd && cmd, pipes, etc.), inline the subshell with an explicit
# DRY_RUN guard — do NOT pass shell metacharacters through this helper.
run() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf "  ${c_dim}[dry-run]${c_reset} %s\n" "$*"
  else
    "$@"
  fi
}

# Fail fast with useful context when something goes wrong under set -e.
# Walks the call stack (FUNCNAME/BASH_LINENO) to report where the failure
# originated — helpful when failures happen inside helpers like run() or link_file().
_on_error() {
  local exit_code=$?
  err "install failed (exit $exit_code)"
  err "last command: ${BASH_COMMAND}"
  err "call stack (most recent first):"
  local i
  for (( i=0; i<${#FUNCNAME[@]}-1; i++ )); do
    err "    ${FUNCNAME[$i+1]:-main}:${BASH_LINENO[$i]}"
  done
  exit "$exit_code"
}
trap '_on_error' ERR

# -------- ensure $HOME/.glorious exists (shared with other glorious-* tools) --------
step "Ensuring glorious ecosystem root at ${GLORIOUS_ROOT}"
if [[ -d "${GLORIOUS_ROOT}" ]]; then
  ok "${GLORIOUS_ROOT} already exists (shared with other glorious-* tools)"
else
  info "Creating ${GLORIOUS_ROOT}"
  run mkdir -p "${GLORIOUS_ROOT}"
fi

# -------- clone or update --------
step "Cloning / updating glorious-opencode into ${INSTALL_ROOT}"

# Detect whether we're running from a local checkout vs. being piped from curl.
# Under `curl | bash`, BASH_SOURCE[0] is usually unset/empty or a non-file (like
# "bash" or a /dev/fd/N path). A local checkout always has:
#   (a) a readable BASH_SOURCE[0] that points to a real file
#   (b) a sibling `home/` directory (the source tree)
#   (c) a sibling `install.sh` — this file itself
# Require ALL THREE to claim "local checkout" mode. Otherwise we'd misfire if
# the user happens to run `curl | bash` from a CWD that has a stray `home/` dir.
SRC_ROOT=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  _candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "${_candidate}/home" && -f "${_candidate}/install.sh" ]]; then
    info "Running from a local checkout at ${_candidate}"
    SRC_ROOT="${_candidate}"
  fi
  unset _candidate
fi

if [[ -z "${SRC_ROOT}" ]]; then
  if [[ -d "${INSTALL_ROOT}/.git" ]]; then
    info "Existing install detected — git pull"
    run git -C "${INSTALL_ROOT}" pull --ff-only
    SRC_ROOT="${INSTALL_ROOT}"
  else
    info "Fresh install — git clone ${REPO_URL}"
    run git clone "${REPO_URL}" "${INSTALL_ROOT}"
    SRC_ROOT="${INSTALL_ROOT}"
  fi
fi

SRC_CLAUDE="${SRC_ROOT}/home/.claude"
SRC_OC="${SRC_ROOT}/home/.config/opencode"

# -------- prereq check --------
step "Checking prerequisites"
missing=()
if command -v git >/dev/null 2>&1; then ok "git"; else err "git (required)"; missing+=("git"); fi
for cmd in node npx uvx; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; else warn "$cmd not found — some MCP servers will not work"; fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required commands: ${missing[*]}"; exit 1
fi

# -------- symlink helper --------
# Usage: link_file SRC DST
# - If DST missing, symlink.
# - If DST is already a symlink pointing at SRC, no-op.
# - If DST is a symlink pointing elsewhere, back up and relink.
# - If DST is a real file, back up and symlink.
link_file() {
  local src="$1" dst="$2"
  local dst_dir; dst_dir="$(dirname "$dst")"
  [[ -d "$dst_dir" ]] || run mkdir -p "$dst_dir"

  if [[ -L "$dst" ]]; then
    local target; target="$(readlink "$dst")"
    if [[ "$target" == "$src" ]]; then
      say "  ${c_dim}= $dst (already linked)${c_reset}"
      return
    fi
    warn "  ! $dst points elsewhere → $target; re-linking"
    run ln -sfn "$src" "$dst"
    return
  fi
  if [[ -e "$dst" ]]; then
    local bak
    bak="${dst}.bak.$(date +%s)"
    warn "  ! $dst exists as a real file; backing up to ${bak}"
    run mv "$dst" "$bak"
    run ln -s "$src" "$dst"
    return
  fi
  ok "  + $dst"
  run ln -s "$src" "$dst"
}

# -------- merge helper for opencode.json --------
# Usage: merge_opencode_json SRC DST
#
# Non-destructive deep-merge of the shipped SRC into a user-customized DST.
# Policy codified in ../test/inline-merge.js and documented in AGENTS.md §"Rules
# when editing this repo" rule 4. Bash is a dumb dispatcher — node owns the
# transaction (backup + tempfile + rename).
#
# Symlink handling:
#   - DST missing or is our symlink      → defer to link_file (no merge).
#   - DST is a symlink pointing elsewhere → follow the chain to a real file;
#                                           merge into that target (NOT the symlink).
#                                           If the chain dead-ends at a missing path, bail.
#   - DST is a real file                  → merge in place.
#
# On scalar-vs-object collisions, node emits WARN: lines and does not mutate.
# Exit 42 from node = "no merge needed"; any other non-zero = fatal.
#
# Requires `node`. If missing while merge is needed, exits with a clear error.
#
# Portable realpath resolver (no readlink -f — BSD). Follows up to $max hops to
# avoid cycles; stops when target is not a symlink or doesn't exist.
_resolve_symlink_chain() {
  local path="$1"
  local max=16
  local hops=0
  while [[ -L "$path" ]]; do
    if (( hops >= max )); then
      err "symlink chain at $1 exceeds $max hops — refusing to resolve"
      return 1
    fi
    local target
    target="$(readlink "$path")"
    # If relative, resolve relative to the link's directory.
    if [[ "$target" != /* ]]; then
      target="$(dirname "$path")/$target"
    fi
    path="$target"
    hops=$((hops + 1))
  done
  printf "%s\n" "$path"
}

merge_opencode_json() {
  local src="$1" dst="$2"
  local dst_dir; dst_dir="$(dirname "$dst")"
  [[ -d "$dst_dir" ]] || run mkdir -p "$dst_dir"

  # Case A: DST missing. Defer to link_file.
  if [[ ! -e "$dst" && ! -L "$dst" ]]; then
    link_file "$src" "$dst"
    MANIFEST_ENTRIES+=("$dst")
    return
  fi

  # Case A (cont.): DST is our symlink already. No-op.
  if [[ -L "$dst" ]]; then
    local cur; cur="$(readlink "$dst")"
    if [[ "$cur" == "$src" ]]; then
      say "  ${c_dim}= $dst (already linked)${c_reset}"
      MANIFEST_ENTRIES+=("$dst")
      return
    fi
  fi

  # Case B / D: DST is a symlink elsewhere. Follow it.
  local merge_target="$dst"
  if [[ -L "$dst" ]]; then
    local resolved
    if ! resolved="$(_resolve_symlink_chain "$dst")"; then
      err "failed to resolve symlink chain from $dst"
      exit 1
    fi
    if [[ ! -e "$resolved" ]]; then
      err "symlink at $dst points at missing path $resolved"
      err "refusing to create files in unknown locations"
      err "fix: remove the stale symlink (rm '$dst') and re-run install.sh"
      exit 1
    fi
    # If the chain happens to terminate at our source file (e.g., a user-built
    # symlink that ultimately points back at our shipped config), that's the
    # same as Case A — no merge needed, it's already our file.
    if [[ "$resolved" == "$src" ]]; then
      say "  ${c_dim}= $dst (already links to our source via chain)${c_reset}"
      MANIFEST_ENTRIES+=("$dst")
      return
    fi
    info "  Following $dst → $resolved for merge"
    merge_target="$resolved"
  fi

  # Case C: real file at merge_target. Require node.
  if ! command -v node >/dev/null 2>&1; then
    err "opencode.json at $merge_target is a real file and needs a non-destructive merge,"
    err "but 'node' is not on PATH. Options:"
    err "  1. Install Node.js (brew install node / apt install nodejs) and re-run install.sh."
    err "  2. Restore our shipped version: mv '$merge_target' '${merge_target}.bak' && ln -s '$src' '$merge_target'"
    exit 1
  fi

  local merge_script="${SRC_ROOT}/test/inline-merge.js"
  if [[ ! -f "$merge_script" ]]; then
    err "merge script not found at $merge_script"
    err "this is a repo bug — the inline-merge.js file should ship with install.sh"
    exit 1
  fi

  if [[ "$DRY_RUN" == 1 ]]; then
    printf "  ${c_dim}[dry-run]${c_reset} node %s %s %s 1\n" "$merge_script" "$src" "$merge_target"
    # Actually run the dry-run merge — it prints proposed changes to stderr and
    # does not touch disk. Harmless to run in --dry-run.
    local rc=0
    node "$merge_script" "$src" "$merge_target" 1 || rc=$?
    case "$rc" in
      0) info "  [dry-run] merge would add keys (see above)" ;;
      42) say "  ${c_dim}= $merge_target (no merge needed)${c_reset}" ;;
      *) err "  [dry-run] merge script exited $rc"; exit "$rc" ;;
    esac
    MANIFEST_ENTRIES+=("$dst")
    return
  fi

  # Real run. Capture stdout (backup path) separately from stderr (warnings + additions).
  local bak_path
  local rc=0
  bak_path="$(node "$merge_script" "$src" "$merge_target" 0)" || rc=$?
  case "$rc" in
    0)
      if [[ -n "$bak_path" ]]; then
        ok "  Merged keys into $merge_target"
        info "  Backup: $bak_path"
        info "  To revert: mv '$bak_path' '$merge_target'"
      else
        # Scalar-only warnings case: no additions, no backup, but node exited 0.
        # Shouldn't happen given our exit-42 contract, but handle defensively.
        info "  Merge completed with warnings only (see above)"
      fi
      ;;
    42)
      say "  ${c_dim}= $merge_target (no merge needed)${c_reset}"
      ;;
    *)
      err "  merge script exited $rc; see messages above"
      exit "$rc"
      ;;
  esac
  MANIFEST_ENTRIES+=("$dst")
}

# -------- link per-file --------
declare -a MANIFEST_ENTRIES=()

step "Linking agents → ${CLAUDE_DIR}/agents/"
for f in "${SRC_CLAUDE}/agents/"*.md; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${CLAUDE_DIR}/agents/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

step "Linking commands → ${CLAUDE_DIR}/commands/"
for f in "${SRC_CLAUDE}/commands/"*.md; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${CLAUDE_DIR}/commands/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

# OpenCode does NOT read ~/.claude/commands — it discovers slash commands from
# ~/.config/opencode/commands/ (plural). Claude Code reads ~/.claude/commands.
# To get the same /ship, /autopilot, /review, /init-deep, /research, /fresh
# surface in both runtimes, we link each command .md into both locations.
step "Linking commands → ${OC_DIR}/commands/"
for f in "${SRC_CLAUDE}/commands/"*.md; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${OC_DIR}/commands/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

step "Linking skills → ${CLAUDE_DIR}/skills/"
for d in "${SRC_CLAUDE}/skills/"*/; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  dst="${CLAUDE_DIR}/skills/${name}"
  # Skills are directories — symlink whole dir
  if [[ -L "$dst" || -e "$dst" ]]; then
    link_file "${d%/}" "$dst"
  else
    [[ -d "${CLAUDE_DIR}/skills" ]] || run mkdir -p "${CLAUDE_DIR}/skills"
    ok "  + $dst"
    run ln -s "${d%/}" "$dst"
  fi
  MANIFEST_ENTRIES+=("$dst")
done

# docs/ holds long-form references extracted out of agent prompts (e.g.
# autopilot-mode.md, hashline.md) so they don't flood every session's
# system prompt. Per-file symlink discipline as elsewhere.
if [[ -d "${SRC_CLAUDE}/docs" ]]; then
  step "Linking Claude docs → ${CLAUDE_DIR}/docs/"
  for f in "${SRC_CLAUDE}/docs/"*.md; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    dst="${CLAUDE_DIR}/docs/${name}"
    link_file "$f" "$dst"
    MANIFEST_ENTRIES+=("$dst")
  done
fi

# bin/ holds shared-by-both-runtimes helper scripts (e.g. plan-check.sh).
# Executables that agents invoke via bash. Per-file symlinks.
if [[ -d "${SRC_CLAUDE}/bin" ]]; then
  step "Linking Claude bin scripts → ${CLAUDE_DIR}/bin/"
  for f in "${SRC_CLAUDE}/bin/"*; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f")"
    dst="${CLAUDE_DIR}/bin/${name}"
    link_file "$f" "$dst"
    MANIFEST_ENTRIES+=("$dst")
  done
fi

step "Linking OpenCode tools → ${OC_DIR}/tools/"
for f in "${SRC_OC}/tools/"*.ts; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${OC_DIR}/tools/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

step "Linking OpenCode plugins → ${OC_DIR}/plugins/"
for f in "${SRC_OC}/plugins/"*.ts; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${OC_DIR}/plugins/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

# bin/ holds launcher shell scripts referenced from opencode.json (e.g.
# memory-mcp-launcher.sh, which fixes per-repo MEMORY_FILE_PATH — issue #24).
# Same per-file symlink discipline as tools/ and plugins/. The `chmod *` deny
# rule blocks the installer from setting the exec bit, but launchers are
# invoked via `bash <path>` from opencode.json, so the bit is nice-to-have
# rather than required. Targets carry 100755 via `git update-index --chmod=+x`.
step "Linking OpenCode bin scripts → ${OC_DIR}/bin/"
for f in "${SRC_OC}/bin/"*.sh; do
  [[ -e "$f" ]] || continue
  name="$(basename "$f")"
  dst="${OC_DIR}/bin/${name}"
  link_file "$f" "$dst"
  MANIFEST_ENTRIES+=("$dst")
done

step "Handling ${OC_DIR}/opencode.json, AGENTS.md, package.json"
for base in "opencode.json" "AGENTS.md" "package.json"; do
  src="${SRC_OC}/${base}"
  dst="${OC_DIR}/${base}"
  # opencode.json has special non-destructive merge semantics — see
  # merge_opencode_json() above and AGENTS.md §"Rules when editing this repo" rule 4.
  if [[ "$base" == "opencode.json" ]]; then
    merge_opencode_json "$src" "$dst"
    continue
  fi
  # AGENTS.md and package.json keep the original warn-and-skip behavior.
  # Both are hard to merge safely: markdown isn't machine-mergeable, and
  # package.json deep-merge risks semver conflicts.
  if [[ ! -e "$dst" && ! -L "$dst" ]]; then
    link_file "$src" "$dst"
    MANIFEST_ENTRIES+=("$dst")
  elif [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    say "  ${c_dim}= $dst (already linked)${c_reset}"
    MANIFEST_ENTRIES+=("$dst")
  elif [[ "$base" == "package.json" ]] && ! grep -q '"opencode-hashline"' "$dst" 2>/dev/null; then
    # package.json is installer-managed scaffolding (plugin dependencies only),
    # not user-facing config. If the existing file is missing opencode-hashline,
    # adopt the managed one automatically — otherwise `bun install` runs against
    # a manifest that doesn't include hashline, and the one-line install silently
    # produces a broken setup. Users with genuine custom deps here are unlikely
    # (the file only exists to host opencode-ai plugin deps) but we still back up.
    bak="${dst}.bak.$(date +%s)"
    warn "  ! $dst exists but is missing \"opencode-hashline\" — backing up to ${bak} and adopting managed version"
    run mv "$dst" "$bak"
    run ln -s "$src" "$dst"
    MANIFEST_ENTRIES+=("$dst")
    # Wipe the lockfile so `bun install` resolves fresh against the new manifest
    # instead of pinning whatever the old package.json happened to lock.
    for lockfile in "${OC_DIR}/bun.lock" "${OC_DIR}/bun.lockb" "${OC_DIR}/package-lock.json"; do
      [[ -e "$lockfile" ]] && run rm -f "$lockfile"
    done
  else
    warn "  ! $dst exists and was not created by this installer."
    warn "    Not touching it. Compare with: diff '$src' '$dst'"
    warn "    To adopt the glorious-opencode version, run: mv '$dst' '${dst}.bak' && ln -s '$src' '$dst'"
  fi
done

# -------- install npm-delivered plugins --------
# The `plugin` array in opencode.json references npm packages (e.g. opencode-hashline)
# that must be installed inside ${OC_DIR}. We just linked package.json above; now
# run an install so node_modules is populated.
step "Installing npm-delivered OpenCode plugins into ${OC_DIR}"
if [[ ! -f "${OC_DIR}/package.json" && ! -L "${OC_DIR}/package.json" ]]; then
  warn "No package.json at ${OC_DIR} — skipping npm install. (If you kept a pre-existing opencode.json, ensure it has 'opencode-hashline' in \"plugin\".)"
elif command -v bun >/dev/null 2>&1; then
  info "Using bun"
  if [[ "$DRY_RUN" == 1 ]]; then
    printf "  ${c_dim}[dry-run]${c_reset} (cd %s && bun install --silent)\n" "$OC_DIR"
  else
    ( cd "$OC_DIR" && bun install --silent )
  fi
  ok "Plugins installed via bun"
elif command -v npm >/dev/null 2>&1; then
  info "Using npm (install bun for faster installs: 'brew install bun')"
  if [[ "$DRY_RUN" == 1 ]]; then
    printf "  ${c_dim}[dry-run]${c_reset} (cd %s && npm install --silent --no-audit --no-fund)\n" "$OC_DIR"
  else
    ( cd "$OC_DIR" && npm install --silent --no-audit --no-fund )
  fi
  ok "Plugins installed via npm"
else
  warn "Neither bun nor npm found — cannot install opencode-hashline. Install Node.js (or Bun) and re-run."
fi

# -------- symlink node_modules into the source tree --------
# Node resolves modules by walking from the *realpath* of the importing file.
# Tool/plugin files live at realpath ${SRC_ROOT}/home/.config/opencode/{tools,plugins}/*.ts,
# so their module resolution walks ancestors of that path looking for node_modules/.
# None of those ancestors currently contains one — bun/npm installed into ${OC_DIR}.
# Drop a symlink at ${SRC_ROOT}/home/.config/opencode/node_modules so both
# resolution paths (realpath-based and ${OC_DIR}-based) succeed. See issue #10.
step "Linking node_modules into source tree so tools can resolve npm deps"
SRC_NM="${SRC_ROOT}/home/.config/opencode/node_modules"
TARGET_NM="${OC_DIR}/node_modules"
_skip_nm_manifest=0
if [[ "$DRY_RUN" == 0 && ! -d "$TARGET_NM" ]]; then
  warn "  ${TARGET_NM} does not exist (npm install did not produce one) — skipping node_modules symlink"
  _skip_nm_manifest=1
elif [[ -L "$SRC_NM" ]]; then
  _nm_target="$(readlink "$SRC_NM")"
  if [[ "$_nm_target" == "$TARGET_NM" ]]; then
    say "  ${c_dim}= $SRC_NM (already linked)${c_reset}"
  else
    warn "  ! $SRC_NM points elsewhere → $_nm_target; re-linking"
    run ln -sfn "$TARGET_NM" "$SRC_NM"
  fi
  unset _nm_target
elif [[ -e "$SRC_NM" ]]; then
  warn "  ! $SRC_NM exists as a real directory/file (not a symlink); leaving alone."
  warn "    To recover: rm -rf '$SRC_NM' && re-run install.sh"
  _skip_nm_manifest=1
else
  ok "  + $SRC_NM → $TARGET_NM"
  run ln -s "$TARGET_NM" "$SRC_NM"
fi
if [[ "$_skip_nm_manifest" == 0 ]]; then
  MANIFEST_ENTRIES+=("$SRC_NM")
fi
unset _skip_nm_manifest

# -------- write manifest --------
# Written at the end so every linked path (including the node_modules symlink
# above) is captured in a single pass.
step "Writing manifest"
if [[ "$DRY_RUN" == 0 ]]; then
  mkdir -p "$INSTALL_ROOT"
  {
    # Manifest schema v1: header line + one installed path per subsequent line.
    # Future versions may add fields (hashes, source-path reverse map, install
    # version). Readers MUST check this header before parsing.
    printf "# glorious-opencode manifest v1\n"
    printf "%s\n" "${MANIFEST_ENTRIES[@]}"
  } > "$MANIFEST"
  ok "Manifest: ${MANIFEST} (${#MANIFEST_ENTRIES[@]} entries)"
else
  info "Would write ${#MANIFEST_ENTRIES[@]} manifest entries to ${MANIFEST} (schema v1)"
fi

# -------- doctor --------
step "Doctor — environment report"
if command -v node >/dev/null 2>&1;  then ok "node  $(node --version)"; else warn "node  missing — memory MCP won't launch"; fi
if command -v npm  >/dev/null 2>&1;  then ok "npm   $(npm --version)";  else warn "npm   missing — cannot install npm-delivered plugins (e.g. opencode-hashline)"; fi
if command -v bun  >/dev/null 2>&1;  then ok "bun   $(bun --version)";  else info "bun   not installed (optional — 'brew install bun' for faster plugin installs)"; fi
if command -v npx  >/dev/null 2>&1;  then ok "npx   $(npx --version)";  else warn "npx   missing — memory MCP won't launch"; fi
if command -v uvx  >/dev/null 2>&1;  then ok "uvx   $(uvx --version 2>/dev/null | head -n1)"; else warn "uvx   missing — serena and git MCPs need it (install: 'brew install uv' or 'pipx install uv')"; fi
if command -v opencode >/dev/null 2>&1; then ok "opencode $(opencode --version 2>/dev/null | head -n1)"; else warn "opencode CLI not found — OpenCode features won't work until it's installed"; fi
if command -v claude  >/dev/null 2>&1; then ok "claude   $(claude --version 2>/dev/null | head -n1)"; else info "claude CLI not found — Claude Code will still work in IDE extensions"; fi

# Verify hashline actually landed
if [[ -d "${OC_DIR}/node_modules/opencode-hashline" ]]; then
  ok "opencode-hashline installed"
else
  warn "opencode-hashline NOT installed — hashline_edit tool won't be available. Run: cd '${OC_DIR}' && npm install"
fi

# Doctor checks for the resolved opencode.json (follows symlinks). Covers both
# the fresh-install symlinked case and the user-customized-real-file case.
# Merge should have added our keys where missing, but a pre-existing scalar
# collision (user had "external_directory": "ask") is preserved-as-scalar and
# we warn here so the user sees the skipped-fix reason in the summary.
_doctor_oc_path="${OC_DIR}/opencode.json"
if [[ -L "$_doctor_oc_path" ]]; then
  _doctor_oc_resolved="$(_resolve_symlink_chain "$_doctor_oc_path" 2>/dev/null || true)"
else
  _doctor_oc_resolved="$_doctor_oc_path"
fi
if [[ -f "$_doctor_oc_resolved" ]]; then
  # hashline presence (in the "plugin" array). Substring match is sufficient —
  # jq isn't a prereq and "opencode-hashline" is unambiguous in this file.
  if ! grep -q "opencode-hashline" "$_doctor_oc_resolved"; then
    warn "opencode-hashline missing from the plugin array in '$_doctor_oc_resolved'"
    warn "  → hashline_edit will not load at runtime. Add \"opencode-hashline\" to the \"plugin\" array."
    warn "  → See: docs/installation.md#enabling-hashline"
  else
    ok "opencode-hashline present in opencode.json"
  fi
  # external_directory + worktrees glob (fixes #20). Must co-occur — either
  # key alone is suspicious.
  if grep -q "external_directory" "$_doctor_oc_resolved" \
     && grep -q ".glorious/worktrees" "$_doctor_oc_resolved"; then
    ok "worktree paths pre-authorized via permission.external_directory"
  else
    warn "permission.external_directory with '~/.glorious/worktrees/**': 'allow' missing from '$_doctor_oc_resolved'"
    warn "  → /fresh worktrees will re-prompt \"Always allow\" until this is added."
    warn "  → See: docs/permissions.md"
  fi

  # Old-style memory MCP config detection (fixes #24). Because the merge policy
  # is intentionally narrow (never overwrites user-set keys), users who did a
  # real-file merge of opencode.json before this fix landed retain the broken
  # ["npx", "-y", "@modelcontextprotocol/server-memory"] command + relative
  # MEMORY_FILE_PATH. grep can't reliably parse pretty-printed multi-line JSON
  # or gate on `enabled: false`, so use `node` for JSON traversal. If node is
  # missing we silently skip — it's a nice-to-have diagnostic, not a hard
  # requirement, and `node` already gates the merge path upstream.
  if command -v node >/dev/null 2>&1; then
    _memory_check="$(node -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const m = c && c.mcp && c.mcp.memory;
        if (!m || m.enabled === false) process.exit(0);
        const cmd = Array.isArray(m.command) ? m.command : [];
        const envPath = m.environment && m.environment.MEMORY_FILE_PATH;
        const usesLauncher = cmd.some(x => typeof x === "string" && x.indexOf("memory-mcp-launcher") !== -1);
        const directNpx = cmd.indexOf("@modelcontextprotocol/server-memory") !== -1;
        const relEnv = typeof envPath === "string" && envPath.charAt(0) !== "/" && envPath.charAt(0) !== "~";
        if (!usesLauncher && (directNpx || relEnv)) {
          console.log("OLD_MEMORY_CONFIG");
        }
      } catch (_) {}
    ' "$_doctor_oc_resolved" 2>/dev/null)"
    if [[ "$_memory_check" == "OLD_MEMORY_CONFIG" ]]; then
      warn "Old-style memory MCP config detected in '$_doctor_oc_resolved' (issue #24)"
      warn "  → memories have been going to a volatile file inside the npx cache and are likely lost."
      warn "  → Replace the 'memory' block under \"mcp\" with:"
      warn '      "memory": {'
      warn '        "type": "local",'
      # shellcheck disable=SC2016  # single quotes are intentional — the literal
      # string "$HOME" is part of the JSON snippet the user must paste verbatim
      # into opencode.json, where the outer `bash -c` at runtime does the
      # expansion. Expanding $HOME here would print the installer operator's
      # home, which is wrong for the JSON paste.
      warn '        "command": ["bash", "-c", "exec bash \"$HOME/.config/opencode/bin/memory-mcp-launcher.sh\""],'
      warn '        "enabled": true'
      warn "      }"
      warn "  → The launcher (~/.config/opencode/bin/memory-mcp-launcher.sh) resolves MEMORY_FILE_PATH per-repo."
    fi
    unset _memory_check
  fi
fi
unset _doctor_oc_path _doctor_oc_resolved

step "Done."
say ""
say "Next steps:"
say "  - Start a session with OpenCode (default agent: orchestrator) or Claude Code."
say "  - To enable Linear MCP: edit ${OC_DIR}/opencode.json and set \"linear\".enabled=true."
say "  - To update later: ${INSTALL_ROOT}/install.sh  (or: cd ${INSTALL_ROOT} && git pull)"
say "  - To uninstall:    ${INSTALL_ROOT}/uninstall.sh"
