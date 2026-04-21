#!/usr/bin/env bash
# memory-mcp-launcher.sh — resolve per-repo MEMORY_FILE_PATH and exec the memory MCP server.
#
# Fixes glorious-opencode issue #24: the stock @modelcontextprotocol/server-memory
# invocation via `npx -y ... ` with a RELATIVE MEMORY_FILE_PATH resolves inside the
# npx cache directory (because OpenCode does not set cwd for MCP launches), so every
# project silently shares one volatile file buried in ~/.npm/_npx/<hash>/.
#
# This launcher resolves the project root via git (worktree-aware, submodule-aware,
# bare-repo-aware), sets an ABSOLUTE MEMORY_FILE_PATH, ensures the target directory
# exists, adds a narrow entry to <repo>/.agent/.gitignore so memory.json is not
# accidentally committed, then execs the real memory server.
#
# CONSTRAINTS (do not break these):
# - Must be bash 3.2 compatible (macOS default /bin/bash).
# - MUST NOT write anything to stdout before the final `exec npx`. MCP uses stdio
#   JSON-RPC; any stdout noise corrupts the handshake. All diagnostics go to stderr.
# - Called via `bash "$HOME/.config/opencode/bin/memory-mcp-launcher.sh"` from the
#   opencode.json `command` array. The executable bit is nice-to-have (stored as
#   100755 in git via `git update-index --chmod=+x`) but not required.
#
# ENV CONTRACT:
# - MEMORY_MCP_LAUNCHER_DEBUG=1
#     After resolving MEMORY_FILE_PATH, log it to stderr as
#     `[memory-mcp-launcher] MEMORY_FILE_PATH=<path>` and still exec npx. Useful
#     when a user asks "where is my memory going?".
# - MEMORY_MCP_LAUNCHER_PRINT_AND_EXIT=1
#     Test-only. After resolving MEMORY_FILE_PATH, print it to stderr and exit 0
#     (skipping the npx exec). Enables launcher behavior tests without needing
#     an actual MCP handshake. Intentionally undocumented to end users.

set -Eeuo pipefail

# Init under -u so we can do `[[ -n "$target_path" ]]` later without risk.
target_path=""
fallback_path="${HOME}/.config/opencode/memory/fallback.json"

# -------- resolve target --------
# Only attempt git-based resolution if git is on PATH. If anything goes wrong in
# this block, we drop through to the fallback path — never hard-fail on a git
# edge case (bare repo, damaged .git, submodule, worktree with missing main, etc).
if command -v git >/dev/null 2>&1; then

  # Bare-repo check FIRST, before any path resolution. A bare repo has no
  # working tree so per-repo memory has no sensible location — fall back.
  _is_bare="$(git rev-parse --is-bare-repository 2>/dev/null || printf "")"
  if [[ "$_is_bare" != "true" ]]; then

    # Get the current repo's working-tree root. Always returns an absolute path.
    # Returns empty (stderr suppressed) when:
    #   - not in a git repo
    #   - CWD inside the .git directory itself
    #   - git is too old / broken
    _toplevel="$(git rev-parse --show-toplevel 2>/dev/null || printf "")"

    if [[ -n "$_toplevel" ]]; then
      target_path="$_toplevel"

      # Worktree-share rewrite. For a `git worktree`, the per-worktree toplevel
      # differs from the MAIN worktree — but we want all worktrees of the same
      # repo to share one memory.json. `--git-common-dir` points at the shared
      # .git dir. Its parent is the main working tree.
      #
      # Resolution is CWD-sensitive (common-dir may be relative), so canonicalize
      # inside a subshell via `cd -P && pwd -P`. Failures fall back to _toplevel.
      _common_dir_raw="$(git rev-parse --git-common-dir 2>/dev/null || printf "")"
      if [[ -n "$_common_dir_raw" ]]; then
        _common_abs="$(cd -P "$_common_dir_raw" 2>/dev/null && pwd -P || printf "")"
        if [[ -n "$_common_abs" ]]; then
          _main_candidate="$(dirname "$_common_abs")"
          # Only rewrite if:
          #   (a) candidate differs from current toplevel (i.e., we're in a worktree)
          #   (b) candidate has a .git entry (real working tree — gitfile OR dir)
          # Submodules: their common-dir is <super>/.git/modules/<name>, parent is
          # .git/modules which has no .git entry, so (b) rejects and we keep the
          # submodule's own toplevel. Bare repos were already skipped above.
          if [[ "$_main_candidate" != "$_toplevel" ]] \
             && [[ -e "$_main_candidate/.git" ]]; then
            target_path="$_main_candidate"
          fi
        fi
      fi
    fi
  fi
  unset _is_bare _toplevel _common_dir_raw _common_abs _main_candidate
fi

# -------- validate target, create dir + narrow gitignore --------
MEMORY_FILE_PATH=""
if [[ -n "$target_path" ]]; then
  if mkdir -p "${target_path}/.agent" 2>/dev/null; then
    MEMORY_FILE_PATH="${target_path}/.agent/memory.json"

    # Narrow gitignore: only ignore `memory.json`. Do NOT touch the file if it
    # already exists — the user (or an earlier run) may have set their own rules
    # and we refuse to clobber sibling tracked content like `.agent/plans/`.
    _gi="${target_path}/.agent/.gitignore"
    if [[ ! -e "$_gi" ]]; then
      _tmp_gi="$(mktemp "${target_path}/.agent/.gitignore.XXXXXX" 2>/dev/null || printf "")"
      if [[ -n "$_tmp_gi" ]]; then
        if printf "memory.json\n" > "$_tmp_gi" 2>/dev/null; then
          mv "$_tmp_gi" "$_gi" 2>/dev/null || rm -f "$_tmp_gi" 2>/dev/null || true
        else
          rm -f "$_tmp_gi" 2>/dev/null || true
        fi
      fi
      unset _tmp_gi
    fi
    unset _gi
  else
    # mkdir failed (read-only mount, perms). Fall through to fallback.
    target_path=""
  fi
fi

# -------- fallback path --------
if [[ -z "$MEMORY_FILE_PATH" ]]; then
  # Use bash parameter expansion instead of `dirname` so the launcher works on
  # restricted PATHs (e.g., when the environment is so bare that coreutils isn't
  # on PATH, such as a session started with env -i + a minimal PATH).
  _fb_dir="${fallback_path%/*}"
  if ! mkdir -p "$_fb_dir" 2>/dev/null; then
    printf "[memory-mcp-launcher] ERROR: cannot create %s — memory server cannot run\n" "$_fb_dir" >&2
    exit 1
  fi
  MEMORY_FILE_PATH="$fallback_path"
  unset _fb_dir
fi

# -------- debug/test hooks --------
if [[ "${MEMORY_MCP_LAUNCHER_DEBUG:-0}" == "1" ]]; then
  printf "[memory-mcp-launcher] MEMORY_FILE_PATH=%s\n" "$MEMORY_FILE_PATH" >&2
fi

if [[ "${MEMORY_MCP_LAUNCHER_PRINT_AND_EXIT:-0}" == "1" ]]; then
  printf "%s\n" "$MEMORY_FILE_PATH" >&2
  exit 0
fi

# Intentionally override any pre-existing MEMORY_FILE_PATH in the env. The whole
# purpose of this launcher is to set the correct path — if a user wants a
# project-local override, they should set it in their project's opencode.json.
export MEMORY_FILE_PATH

exec npx -y @modelcontextprotocol/server-memory "$@"
