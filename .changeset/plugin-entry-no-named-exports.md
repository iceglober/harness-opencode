---
"@glrs-dev/harness-opencode": patch
---

**Fix: OpenCode no longer crashes at startup with `TypeError: undefined is not an object (evaluating 'V[G]' / 'S.auth' / 'M.config')` when the harness plugin is enabled.**

This has been silently broken since **v0.3.0** (~commit `e5ffb7c`). Users on v0.3.0–v0.6.0 saw one of several minified-variable error shapes depending on OpenCode version:

- `TypeError: undefined is not an object (evaluating 'V[G]')`
- `TypeError: undefined is not an object (evaluating 'f.auth')`
- `TypeError: undefined is not an object (evaluating 'M.config')`

All the same bug. The `oc` command would refuse to start in any worktree with the plugin enabled via `~/.config/opencode/opencode.json`.

## Root cause

In commit `e5ffb7c` (v0.3.0, "wire subagent permissions via TS overrides + allow scratch/XDG paths"), `applyConfig` in `src/index.ts` was changed from `function applyConfig(...)` to `export function applyConfig(...)` purely so tests could import it directly.

OpenCode's plugin loader (1.14.x line) probes named exports on the plugin module looking for `PluginModule`-shaped entries (`{ id?, server, tui? }`). When it encountered the plain `applyConfig` function as a named export, the probe crashed inside OpenCode's minified bundle — fatal at plugin-load time, which cascaded into provider init (`S.auth`) and TUI bootstrap failing entirely.

Bisect walked every published version (v0.1.2 works, v0.2.0 works, v0.3.0 onward crashes) and isolated the crash to the single `export` keyword on line 137 of `src/index.ts`.

## Fix

Moved `applyConfig` into a dedicated module `src/config-hook.ts`. `src/index.ts` now imports it as a runtime internal and has exactly **one** export — the plugin factory `default`. Tests import `applyConfig` from `src/config-hook.ts`.

## Regression guard

New test file `test/plugin-entry-single-default-export.test.ts` enforces three invariants:

1. `src/index.ts` has no `export function/const/let/var/class/enum/namespace/{...}` — only `export default`.
2. `src/index.ts` has exactly one `export default`.
3. The built `dist/index.js` exposes only `default` on its runtime surface (guards against bundler quirks that might re-surface internals).

Any future commit that adds a named export to `src/index.ts` will fail CI with a message pointing at this changelog entry.

## Bonus

Also hardens the returned `Hooks` object to omit keys whose values are `undefined` (defensive against a separate class of OpenCode-loader edge case observed while bisecting). New test file `test/plugin-hooks-no-undefined.test.ts` locks that in too.

## Upgrade path

Users on floating semver (`bun add @glrs-dev/harness-opencode`) auto-recover on next `bun update`. Users stuck on `@latest` in the OpenCode cache already benefit from the self-update mechanism added in v0.6.0 (#65) — next OpenCode restart re-installs the fixed version.

For users who can't wait for the release: edit `~/.config/opencode/opencode.json` and remove the `plugin` array temporarily, then restore it after `bun update` completes. `oc` works without the harness; you just lose the custom agents/skills until the update lands.
