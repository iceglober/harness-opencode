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
for cmd in git; do
  if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd"; else err "$cmd (required)"; missing+=("$cmd"); fi
done
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
    local bak="${dst}.bak.$(date +%s)"
    warn "  ! $dst exists as a real file; backing up to ${bak}"
    run mv "$dst" "$bak"
    run ln -s "$src" "$dst"
    return
  fi
  ok "  + $dst"
  run ln -s "$src" "$dst"
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

step "Handling ${OC_DIR}/opencode.json, AGENTS.md, package.json"
for base in "opencode.json" "AGENTS.md" "package.json"; do
  src="${SRC_OC}/${base}"
  dst="${OC_DIR}/${base}"
  if [[ ! -e "$dst" && ! -L "$dst" ]]; then
    link_file "$src" "$dst"
    MANIFEST_ENTRIES+=("$dst")
  elif [[ -L "$dst" && "$(readlink "$dst")" == "$src" ]]; then
    say "  ${c_dim}= $dst (already linked)${c_reset}"
    MANIFEST_ENTRIES+=("$dst")
  else
    warn "  ! $dst exists and was not created by this installer."
    warn "    Not touching it. Compare with: diff '$src' '$dst'"
    warn "    To adopt the glorious-opencode version, run: mv '$dst' '${dst}.bak' && ln -s '$src' '$dst'"
    # If the user kept their own opencode.json but forgot to include the
    # hashline plugin, the install "succeeds" but hashline_edit is unavailable
    # at runtime. Warn loudly. Grep-based check — jq isn't a prereq, and a
    # bare substring match is sufficient for this tripwire. See issue #3.
    if [[ "$base" == "opencode.json" ]] && ! grep -q "opencode-hashline" "$dst"; then
      warn "    Your '$dst' does not include \"opencode-hashline\" in its plugin array."
      warn "    The hashline_edit tool will not load until you add it. Minimum change:"
      warn "        \"plugin\": [\"opencode-hashline\", ...your other plugins...]"
      warn "    See: https://github.com/iceglober/glorious-opencode/blob/main/docs/installation.md#enabling-hashline"
    fi
  fi
done

# -------- write manifest --------
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

# Distinct from the check above: hashline can be on disk in node_modules
# but still unloaded at runtime if the user's own opencode.json doesn't
# list it in the "plugin" array. Both warnings can co-fire. See issue #3.
if [[ -f "${OC_DIR}/opencode.json" && ! -L "${OC_DIR}/opencode.json" ]] \
   && ! grep -q "opencode-hashline" "${OC_DIR}/opencode.json"; then
  warn "opencode-hashline missing from the plugin array in '${OC_DIR}/opencode.json'"
  warn "  → hashline_edit will not load at runtime. Add \"opencode-hashline\" to the \"plugin\" array."
  warn "  → See: docs/installation.md#enabling-hashline"
fi

step "Done."
say ""
say "Next steps:"
say "  - Start a session with OpenCode (default agent: orchestrator) or Claude Code."
say "  - To enable Linear MCP: edit ${OC_DIR}/opencode.json and set \"linear\".enabled=true."
say "  - To update later: ${INSTALL_ROOT}/install.sh  (or: cd ${INSTALL_ROOT} && git pull)"
say "  - To uninstall:    ${INSTALL_ROOT}/uninstall.sh"
