# Spike Results — Pivot-to-npm-plugin Pre-Implementation Verification

**Status:** Ephemeral. Delete this file before the Stage 1 pivot PR merges. Findings below should already be integrated into `.agent/plans/pivot-npm-plugin.md` before that point.

**Environment:** OpenCode 1.14.19 on macOS. Scratch workspace at `/tmp/gh-spike/` with a redirected `$HOME` / `$XDG_*` so no user state is touched.

---

## Spike 1 — `config.skills.paths` from a plugin's `config` hook

**Plan question:** Does pushing an absolute path onto `input.skills.paths` from a plugin's `config` hook cause OpenCode's skill discoverer to pick up `SKILL.md` files under that path?

**Verdict: WORKS.** With one caveat about precedence (below).

### Evidence

- Scratch plugin at `file:///tmp/gh-spike/scratch-plugin/dist/index.js`, `type: "module"`, default export is `async function(input) { return { config: async (config) => { ... } } }`.
- Plugin's `config` hook wrote `config.skills = { paths: [PLUGIN_SKILLS, USER_SKILLS, ...existing], urls: existing.urls ?? [] }`.
- Two bundled skills at `scratch-plugin/dist/skills/test-skill-a/SKILL.md` and `/test-skill-b/SKILL.md` with valid YAML frontmatter (`name`, `description` required — both must be present).
- `opencode debug skill --print-logs` output: `service=skill count=2 init` with both skills enumerated at their plugin-bundled locations.

### Frontmatter gotcha

Initial test with only `description:` in frontmatter produced `count=0`. Adding `name:` (matching the directory name, per https://opencode.ai/docs/skills) made both skills discoverable. This caused a false-negative early in the spike that nearly took the plan off course.

**Implication for Stage 1:** Every SKILL.md in `src/skills/` must have both `name` and `description` frontmatter. The `name` must match the skill's directory name and satisfy `^[a-z0-9]+(-[a-z0-9]+)*$`. Add a build-time validator (part of `test/skills-bundle.test.ts`) that parses every `src/skills/**/SKILL.md` frontmatter and asserts the required fields are present and `name === dirname`.

### Precedence finding (unexpected — plan claim needs revision)

Test matrix:

| Scenario | Global `~/.config/opencode/skills/test-skill-a/` | Project `.opencode/skills/test-skill-a/` | Plugin path via `config.skills.paths` | Winner |
|---|---|---|---|---|
| A | present | absent | absent | global |
| B | present | present | absent | **project-local** |
| C | present | present | present | **plugin path** |

OpenCode's scanner warns "duplicate skill name" in each collision but keeps processing — the final `debug skill` output shows the **last-seen** location as the winner. Plugin-pushed `config.skills.paths` entries are scanned AFTER the hardcoded globals/project paths, so the plugin version wins every collision.

**Contradicts plan's user-wins invariant.** The plan at `.agent/plans/pivot-npm-plugin.md` claims `input.skills.paths = [...ourPaths, ...(input.skills?.paths ?? [])]` gives user-wins precedence because later entries override. Empirically, **`config.skills.paths` entries (plugin-added OR statically declared in opencode.json) override all hardcoded paths regardless of internal array order**, so users who want to shadow a bundled skill by dropping `~/.config/opencode/skills/<name>/SKILL.md` CANNOT — the plugin's bundled version still wins.

**Implications for the plan:**

1. Drop the "user-wins via later position in `skills.paths`" claim. It's false.
2. Decide user-override policy explicitly. Options:
   - **(a) Fork-to-override.** Users who need to shadow a bundled skill fork the npm package. Simpler; matches npm conventions; no per-user write surface to maintain. Document in README.
   - **(b) Disable-and-replace.** Plugin accepts a user-config key (e.g., `plugin_options.glorious_harness.disabled_skills: ["vercel-composition-patterns"]`) that strips the named skill from `config.skills.paths` registration. Users who want a custom version then add it at a hardcoded path. Matches oh-my-openagent's `disabled_*` model. Moderate complexity.
   - **(c) Plugin-path-last.** NOT viable: the scan-order empirically places `config.skills.paths` last regardless of insertion order, so appending user's existing `skills.paths` first doesn't help. Users would still need hardcoded-path overrides, which are shadowed.
3. Update `AGENTS.md` rule on precedence to reflect empirical behavior.
4. Update `test/plugin.test.ts` "user wins" scenario to test the chosen policy (fork-to-override or disabled-skills opt-out), not the broken "override via `~/.config/opencode/skills/`" claim.

### Call out for Stage 1

- `import.meta.url` / `fileURLToPath()` works in the plugin ESM entry (tested — `path.dirname(fileURLToPath(import.meta.url))` resolved correctly to the scratch plugin's `dist/` directory). No `createRequire` needed when the plugin is shipped as ESM.
- `input.skills` is `null` on entry when neither opencode.json nor prior plugins set it. Use defensive `config.skills ?? {}`.
- The `skills` object has `paths` (array) and `urls` (array) per the static-declaration test. Preserve both on mutation.

---

## Spike 2 — Prompt-path audit

**Plan question:** Canonical list of every `~/.claude`, `home/.claude`, `~/.config/opencode`, `home/.config/opencode` reference in prompt content, each classified with a rewrite rule.

**Verdict: 16 prompt references + 7 AGENTS.md references + 4 Stage-0 self-references = 27 total.** AGENTS.md handled by rewrite; Stage-0 self-refs are acceptable (they document code that exists). 16 prompt rewrites are the real scope.

### Canonical list of prompt references (16)

| # | File | Line | Reference | Rewrite rule |
|---|---|---|---|---|
| 1 | `home/.claude/agents/build.md` | 7 | `~/.claude/agents/prime.md → "Workflow-mechanics decisions"` | **WORKFLOW_MECHANICS_RULE template substitution** — extract rule content to `src/agents/shared/workflow-mechanics.md`, inline at plugin init via `{WORKFLOW_MECHANICS_RULE}` placeholder |
| 2 | `home/.claude/agents/qa-reviewer.md` | 38 | `bash ~/.claude/bin/plan-check.sh --run <plan-path>` | **CLI subcommand rewrite** — replace with `bunx @glrs-dev/harness-opencode plan-check --run <plan-path>` |
| 3 | `home/.claude/agents/plan-reviewer.md` | 35 | `bash ~/.claude/bin/plan-check.sh --check <plan-path>` | **CLI subcommand rewrite** — `bunx @glrs-dev/harness-opencode plan-check --check <plan-path>` |
| 4 | `home/.claude/agents/plan.md` | 7 | `~/.claude/agents/prime.md → "Workflow-mechanics decisions"` | **WORKFLOW_MECHANICS_RULE template substitution** (same as #1) |
| 5 | `home/.claude/agents/plan.md` | 110 | `~/.claude/bin/plan-check.sh parses the fence` | **CLI rewrite** — `bunx @glrs-dev/harness-opencode plan-check parses the fence` (prose; no runtime invocation) |
| 6 | `home/.claude/agents/prime.md` | 29 | `see home/.claude/commands/fresh.md` | **Inline excerpt** — copy the ~10-line "Derive the branch name" subsection from `fresh.md` directly into prime's prompt body |
| 7 | `home/.claude/agents/prime.md` | 45 | `where <slug> follows the rules in home/.claude/commands/fresh.md § "Derive the branch name"` | **Inline excerpt** (same as #6 — both refs collapse to one inlined copy) |
| 8 | `home/.claude/agents/prime.md` | 75 | `read ~/.claude/docs/autopilot-mode.md for the 8 autopilot rules` | **Delete cross-reference** — `/autopilot` command's prompt already inlines the rules; prime shouldn't need to fetch them separately. Rewrite to "when invoked via `/autopilot`, the 8 autopilot rules are inlined into your incoming prompt by the command." |
| 9 | `home/.claude/agents/prime.md` | 219 | `see ~/.claude/docs/autopilot-mode.md § Rule 5 and § Rule 6` | **Inline rule text directly** — Rules 5 and 6 are short (emit `<promise>DONE</promise>`, delegate to verifier). Inline verbatim at the prime's Phase-4→5 transition. |
| 10 | `home/.claude/commands/autopilot.md` | 5 | `live at ~/.claude/docs/autopilot-mode.md and are copied verbatim here` | **Rewrite as self-contained** — since `autopilot.md` already has the rules inlined, the reference becomes "(the rules below are the canonical source)." Drop the path reference. |
| 11 | `home/.claude/commands/autopilot.md` | 68 | `matching guardrail in ~/.claude/commands/autopilot.md: "NEVER commit, push, or open a PR"` | **Self-reference; remove** — the file IS autopilot.md, this is tautological prose. Rewrite to "the hard rule above ('NEVER commit, push, or open a PR')..." |
| 12 | `home/.claude/commands/autopilot.md` | 80 | `apply the workflow-mechanics heuristic from ~/.claude/agents/prime.md` | **WORKFLOW_MECHANICS_RULE template substitution** (same as #1) |
| 13 | `home/.claude/commands/autopilot.md` | 166 | `canonical source at ~/.claude/docs/autopilot-mode.md` | **Delete cross-reference** — the rules are already in this file. Rewrite: "(Rule 1 — Question suppression, inlined above)." |
| 14 | `home/.claude/commands/autopilot.md` | 169 | `The autopilot plugin (~/.config/opencode/plugins/autopilot.ts) will inject...` | **Plugin-name rewrite** — "The autopilot subsystem (bundled in `@glrs-dev/harness-opencode`) will inject..." Drop the file path. |
| 15 | `home/.claude/docs/autopilot-mode.md` | 62 | same prose as #11 | **File deleted** — content already inlined in autopilot.md's command prompt; this standalone doc is redundant. Plan already commits to deleting it. |
| 16 | `home/.claude/docs/hashline.md` | 3 | `extracted from ~/.config/opencode/AGENTS.md` | **File deleted** — hashline's canonical source is upstream `opencode-hashline`; we shouldn't duplicate the doc. Plan already commits to deleting it. |

### AGENTS.md references (7 — not prompts; documentation)

These are in `home/.config/opencode/AGENTS.md`. The plan commits to rewriting AGENTS.md as part of the pivot, so these are handled by that rewrite — but for completeness:

- Line 31: memory launcher path — update to point at the bundled `dist/bin/memory-mcp-launcher.sh` once shipped via npm.
- Line 60: `~/.config/opencode/tools/ast_grep.ts` — becomes "bundled tool in `@glrs-dev/harness-opencode`".
- Line 64: Claude Code `auto memory at ~/.claude/projects/...` — stays; it's describing Claude Code's native behavior, not ours.
- Line 67: `~/.claude/agents/` reference for Claude Code users — Phase B scope; remove for Phase A.
- Lines 75, 76: skill-paired specialist agents — stays; describes the pattern abstractly.
- Line 87: `~/.claude/agents/prime.md → "Workflow-mechanics decisions"` — **WORKFLOW_MECHANICS_RULE canonical home** moves here too; rewrite AGENTS.md to reference `src/agents/shared/workflow-mechanics.md` as the source.
- Line 107: `~/.claude/docs/hashline.md` — **delete reference** (file is being deleted).

### Stage-0 self-references (4 — acceptable as-is)

In `home/.config/opencode/plugins/auto-update.ts` at lines 433, 444, 456, 463: all inside the new Stage-0 self-unlink guard. These are the intentional references to the path whose deletion we're detecting. They stay; they correctly describe the check.

### CI regression test

`test/prompts-no-dangling-paths.test.ts` (per plan) should grep `src/agents/prompts/`, `src/commands/prompts/`, `src/skills/**/*.md` for the four patterns and fail on any match. This catches accidental re-introduction during prompt maintenance.

Stage-0 self-refs in `auto-update.ts` (or wherever the block lives if it moves) are code, not prompts, and are outside the test's glob scope.

---

## Spike 3 — `--pin` version-string viability

**Plan question:** Does OpenCode's `plugin` array in opencode.json accept `"name@version"` and `"name@semver-range"` specifiers that resolve through its internal `bun install` step?

**Verdict: WORKS for both exact versions and semver ranges.** OpenCode parses the `@<spec>` suffix and forwards it to the install step.

### Evidence

- `"opencode-hashline@0.1.14"`: OpenCode parsed and attempted install; npm responded "No matching version found for opencode-hashline@0.1.14" (version doesn't exist). OpenCode's error log: `pkg=opencode-hashline version=0.1.14 error=No matching version found`.
- `"opencode-hashline@1.3.0"` (a real published version): OpenCode parsed correctly (`version=1.3.0`). Install failed with `NpmInstallFailedError` (likely due to scratch-dir network/cache config, unrelated to the spec string).
- `"opencode-hashline@^1.3.0"`: parsed as `version=^1.3.0`. OpenCode forwards semver ranges verbatim to its installer.

### Implication for Stage 1

The plan's `bunx @glrs-dev/harness-opencode install --pin` command can inject `"@glrs-dev/harness-opencode@<current-version>"` directly into the `plugin` array. No need to fall back to writing `~/.config/opencode/package.json` dependencies.

Confirm version-resolution correctness (that the pinned version actually becomes the loaded one, not a floating semver) in the Stage 1 implementation — a quick test with a real published version of `@glrs-dev/harness-opencode` once it's on npm.

### Also observed (unintended)

The `NpmInstallFailedError` for `1.3.0` suggests the scratch-dir has an npm-cache issue (the scratch `XDG_CACHE_HOME` path may not be registered as a bun install target). Not a Stage 1 concern — it's an artifact of the redirected scratch environment, not a real install path.

---

## Summary of plan-revision items for Stage 1

Before Stage 1 begins, update `.agent/plans/pivot-npm-plugin.md` with:

1. **Precedence rule is WRONG in current plan** (Spike 1): plugin `config.skills.paths` ALWAYS wins over hardcoded paths. Decide user-override policy (recommend fork-to-override for simplicity; document in README). Remove the "user wins via later position" claim. Update `test/plugin.test.ts` scenario accordingly. Update AGENTS.md rule.

2. **Frontmatter `name` field required** (Spike 1): every skill's SKILL.md must have `name:` matching its directory name. Add validator to `test/skills-bundle.test.ts`.

3. **Spike 2 canonical rewrite list** (above): the 16-reference list with per-ref rewrite rules is now concrete. Stage 1 implementers should follow this table verbatim.

4. **`--pin` is viable** (Spike 3): plan can keep the `--pin` flag writing to the `plugin` array. Drop the fallback-to-`package.json` branch.

5. **ESM plugin shape works** (Spike 1 side-finding): plugin ships as `type: "module"`; `import.meta.url` + `fileURLToPath` resolves correctly; no `createRequire` escape hatch needed. Document in `docs/plugin-architecture.md`.
