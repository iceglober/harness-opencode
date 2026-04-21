# glorious-opencode — repo context for agents working on this repo

You are editing the **glorious-opencode** harness itself — the repo that gets installed into other engineers' home directories to configure their OpenCode + Claude Code setup. This is meta-work: changes here propagate to every user on their next `install.sh` or `git pull`.

## What this repo is

A curl-installable agent harness. Not an npm package. Not a binary. Just git + bash + symlinks.

```
glorious-opencode/
├── install.sh / uninstall.sh / update.sh   # the installer lifecycle
├── home/                                    # files that get symlinked into user $HOME
│   ├── .claude/{agents,commands,skills}/
│   └── .config/opencode/
│       ├── tools/                           # local .ts tool files (ast_grep, tsc_check, etc.)
│       ├── plugins/                         # local .ts plugin files (notify, autopilot)
│       ├── AGENTS.md
│       ├── opencode.json                    # has "plugin": ["opencode-hashline"] for npm-delivered plugins
│       └── package.json                     # dependencies for the npm-delivered plugins above
├── docs/
│   ├── installation.md                      # fetched by agents when user says "install this"
│   └── claude-code-fallbacks.md
├── README.md
└── AGENTS.md                                # this file
```

### Two kinds of plugins — important distinction

OpenCode loads plugins two different ways, and this repo uses **both**:

| | Local file plugins | npm-delivered plugins |
|---|---|---|
| Where they live | `home/.config/opencode/plugins/*.ts` | Listed in `opencode.json` `"plugin": [...]` array, installed via npm into `~/.config/opencode/node_modules/` |
| Examples (ours) | `notify.ts`, `autopilot.ts` | `opencode-hashline` |
| Installed by | The installer's symlink step | The installer's `npm install` / `bun install` step (after linking `package.json`) |
| To add a new one | Drop a `.ts` file in `home/.config/opencode/plugins/` | Add the package to `home/.config/opencode/package.json` dependencies AND add the name to the `plugin` array in `home/.config/opencode/opencode.json` |

## Install layout on user machines

- `~/.glorious/opencode/` — this repo checked out (shared parent with other `glorious-*` tools)
- `~/.claude/*` and `~/.config/opencode/*` — per-file symlinks back into `~/.glorious/opencode/home/`

## Rules when editing this repo

1. **Everything under `home/` must be generic.** No `@kn/` imports, no repo-specific paths, no company-private idioms. Illustrative examples in prompts should use generic names (`createUser`, `src/lib/auth`, etc.). If you find a kn-eng / company-specific reference, either genericize it or move it out.

2. **Never break backward compatibility of the `.manifest` format.** The uninstaller reads this line-by-line. It's intentionally dumb. Keep it as one path per line.

3. **Per-file symlinks only.** Never symlink whole directories (except `skills/<name>/` which are logical units). Users must be able to drop their own `~/.claude/agents/custom.md` without the installer fighting them.

4. **`opencode.json` is merged non-destructively on install.** The installer adds missing keys from our shipped version, preserves all user values verbatim, and writes an `opencode.json.bak.<epoch>-<pid>` sibling before every mutation. It never overwrites a key the user has set, and never deletes keys. Arrays are treated as leaves (user's array wins) except for the top-level `plugin` array, which is unioned-by-value so `opencode-hashline` lands even when a user has a custom plugin list. Scalar-vs-object collisions (user set a string where we ship an object) preserve the user's scalar and emit a `WARN:` line — we do not auto-migrate. If you're tempted to widen the merge policy (deep-merge arbitrary arrays, auto-remove deprecated keys, auto-migrate scalar-vs-object collisions), STOP and ask. The current policy is intentionally narrow. The merge logic lives at `test/inline-merge.js` and is codified by the fixture suite at `test/fixtures/opencode-json/`; `bash test/merge-opencode-json.sh` runs the tests. The `install.sh` helper `merge_opencode_json` is just a dispatcher — node owns the transaction (backup + tempfile + atomic rename).

5. **`~/.glorious/` is shared with other tools in the ecosystem.** Never `rm -rf` it. Uninstall only removes `~/.glorious/opencode/`, and only after checking if other siblings exist.

6. **Scripts must be POSIX-bash portable.** No zsh-only syntax, no GNU-only flag variants (e.g., `sed -i` behaves differently on BSD/macOS — prefer temp files and `mv`). Test on macOS + Linux when in doubt.

7. **Dry-run must be honored everywhere.** Every state-changing command in `install.sh` goes through the `run` helper, which prints instead of executing when `--dry-run` is set.

## Testing changes

```bash
# Dry-run against a scratch prefix
bash install.sh --dry-run --prefix /tmp/goc-test

# Real install into a scratch prefix
bash install.sh --prefix /tmp/goc-test
ls -la /tmp/goc-test/.claude/agents/
ls -la /tmp/goc-test/.config/opencode/
cat /tmp/goc-test/.glorious/opencode/.manifest

# Idempotency (re-run should produce no "+ " lines, all "= already linked")
bash install.sh --prefix /tmp/goc-test

# Uninstall
echo y | bash uninstall.sh /tmp/goc-test

# Clean up
rm -rf /tmp/goc-test
```

## Things that commonly go wrong

- **Paths in `opencode.json`.** The `{file:...}` references resolve relative to the config file's directory (`~/.config/opencode/`). To point at `~/.claude/agents/orchestrator.md`, use `../../.claude/agents/orchestrator.md`. Don't use `./` — that's wrong.

- **macOS `readlink` differences.** `readlink -f` doesn't exist on BSD. Use plain `readlink "$path"` and never assume `-f`.

- **`chmod +x` in Git.** If scripts lose the executable bit, users will hit "permission denied". Check with `git ls-files --stage install.sh` — it should show `100755`. The README documents `bash install.sh` as a workaround.

- **Agent prompt paths in user-visible config.** When a user adds project-local overrides to their `opencode.json`, they may reference the globally-installed agents. Keep the paths stable — if you rename `orchestrator.md`, it's a breaking change.

## When adding a new agent / command / skill

1. Put the file in `home/.claude/agents/<name>.md` (or `commands/` or `skills/<name>/SKILL.md`)
2. If it has an OpenCode `agent` block with permissions, add it to `home/.config/opencode/opencode.json`
3. Update `README.md` "What you get" section
4. Dry-run the installer to verify the file appears in the symlink plan
5. No other changes needed — the installer globs `*.md` (agents/commands) and `*/` (skills), so new entries are picked up automatically

## When adding a new plugin

**Local file plugin** (a `.ts` file you wrote):
1. Drop it in `home/.config/opencode/plugins/<name>.ts`
2. Done — the installer globs `*.ts` and symlinks it

**npm-delivered plugin** (published to the npm registry):
1. Add to `home/.config/opencode/package.json` dependencies: `"opencode-foo": "^1.0.0"`
2. Add to `home/.config/opencode/opencode.json` `"plugin"` array: `"opencode-foo"`
3. The installer's npm-install step picks it up on next run. Existing users get it on their next `update.sh`.

## When removing an agent / command / skill

1. Delete the file under `home/`
2. If it had an OpenCode `agent` block, remove it from `opencode.json`
3. Existing users on older installs will still have the symlink on next `update.sh`; the installer doesn't currently prune removed files. (If this becomes a problem, we'll add a prune step that reads the old manifest.)

## Philosophy

This is meant to feel inevitable, not clever. If you're tempted to add a "cool" feature, ask: does it reduce the friction of getting a fresh engineer running the five-phase workflow? If no, leave it out. The value is in the defaults being good and the install being boring.
