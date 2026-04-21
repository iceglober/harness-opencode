---
description: Generate hierarchical AGENTS.md files. Root plus complexity-scored subdirectories.
---

Generate or refresh hierarchical `AGENTS.md` files.

**Arguments:** `$ARGUMENTS` — optional flags:
- `--create-new` — read existing AGENTS.md files (capture context), then delete all, then regenerate from scratch
- `--max-depth=N` — limit directory depth (default: 3)
- `--dry-run` — produce the inclusion list + size estimates, but do not write files

Default (no flags): update mode. Modify existing files in-place; create new ones where a directory's score warrants it.

---

## Phase 1 — Discovery + Analysis (concurrent)

**Subagent choice: route to `@code-searcher` explicitly (not the built-in `general` subagent).** The code-searcher has Serena allowed and is prompted to use it first; the built-in `general` is more generic and may default to grep. When invoking via the task tool, specify the subagent name exactly.

**Mandate Serena in each subagent prompt.** Don't just say "explore conventions" — tell them which Serena tool to call. Examples below include the explicit Serena call each subagent should use.

Fire these in parallel via the task tool (they can run concurrently since they don't depend on each other):

- `@code-searcher` — "Map project structure. Call `serena_get_symbols_overview` on `apps/` and `packages/` top-level directories to inventory module boundaries and symbol counts. Supplement with bash `find` for file counts per directory. Skip node_modules, dist, .next, .turbo, build, coverage, .serena."
- `@code-searcher` — "Find entry points. Call `serena_find_symbol` for common entry-point names (index, main, App, page). Supplement with glob for apps/*/src/index.ts, apps/*/src/main.ts, apps/*/src/app/page.tsx, packages/*/src/index.ts. Return paths + the symbol kind (function, class, default export)."
- `@code-searcher` — "Find project conventions. Read tsconfig files, eslint configs, prettier configs, turbo.json, pnpm-workspace.yaml, .*rc files. Report non-default settings only. This is config-file work — Serena isn't useful here; use `read` directly."
- `@code-searcher` — "Find anti-patterns in existing AGENTS.md files: `find . -name AGENTS.md -not -path '*/node_modules/*'` then read each. Extract any NEVER/ALWAYS/DO NOT rules. Consolidate. This is markdown prose; use `grep` / `read`."
- `@code-searcher` — "Find build/CI patterns: .github/workflows, .husky, scripts/sh, any Makefile. Use `read` — these are mostly YAML/shell. Report non-standard patterns only."
- `@code-searcher` — "Find test patterns. Call `serena_find_symbol` for `describe`, `it`, `test`, `beforeEach` to measure test density per directory. Read vitest/jest/playwright configs via `read`. Report unique conventions only."

While the subagents run, YOU do:

### Structural bash analysis
```bash
# Directory depth + files per dir (top 30)
find . -type d \
  -not -path '*/node_modules/*' -not -path '*/.git/*' \
  -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/.turbo/*' \
  | awk -F/ '{print NF-1}' | sort -n | uniq -c

find . -type f \
  -not -path '*/node_modules/*' -not -path '*/.git/*' \
  -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/.turbo/*' \
  | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

# Code concentration by extension
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# Existing AGENTS.md / CLAUDE.md
find . -type f \( -name "AGENTS.md" -o -name "CLAUDE.md" \) -not -path '*/node_modules/*'
```

### Read every existing AGENTS.md
Capture their contents into a per-path map. These are the manual authoring we must preserve (if update mode) or extract context from before deletion (if `--create-new`).

### Serena symbol density (LSP-grade codemap) — REQUIRED

For each candidate top-level directory (every `apps/*` and `packages/*`), call `serena_get_symbols_overview` with the directory path. Record:
- Total symbol count per directory
- Top 5 exports by name
- Whether an `index.ts` entry point exists

Then for the top-3 symbol-densest directories, call `serena_find_referencing_symbols` on their 1-2 most load-bearing exports to measure reference centrality across the repo.

This data feeds the Phase 2 scoring (symbol density ×2, export count ×2, reference centrality ×3). Skipping Serena here means those three factors are zero, which collapses the score-based decision. **Do not skip.**

### Dynamic agent scaling
After bash analysis, if the project is large, spawn more `@code-searcher` tasks:

| Factor | Threshold | Additional agents |
|---|---|---|
| Total source files | >500 | +1 per 500 |
| Large files (>500 lines) | >10 | +1 focused on complexity hotspots |
| Directory depth | ≥5 | +2 for deep exploration |
| Monorepo packages | each | +1 per workspace package |

For monorepos with many packages, spawn one more `@code-searcher` per major package (`apps/*`, `packages/*`, workspace members from `pnpm-workspace.yaml` / `package.json` `workspaces`).

### Merge
Collect results from all subagents + bash + Serena. Build a single consolidated view of the repo.

---

## Phase 2 — Score & Decide

Score each candidate directory using these weighted factors:

| Factor | Weight | High threshold | Source |
|---|---|---|---|
| File count | 3× | >20 | bash |
| Subdirectory count | 2× | >5 | bash |
| Code ratio (code files / total) | 2× | >70% | bash |
| Unique patterns (own eslint/tsconfig/etc.) | 1× | has own config | code-searcher |
| Module boundary (index.ts / main.py) | 2× | has entry | bash |
| Symbol density | 2× | >30 symbols | Serena |
| Export count | 2× | >10 exports | Serena |
| Reference centrality (imports in other dirs) | 3× | >20 refs | Serena |

**Decision:**
- **Root (`.`)** — always create/update
- **Score >15** — create/update AGENTS.md
- **Score 8-15** — create if it's a distinct domain (distinct config OR distinct import-graph cluster); otherwise skip
- **Score <8** — skip (parent covers)

Produce the inclusion list:

```
[
  { path: ".", type: "root", existing: true },
  { path: "apps/api", score: 24, existing: true, reason: "API app, own tsconfig, high symbol density" },
  { path: "packages/core", score: 22, existing: true, reason: "Shared domain logic, distinct import cluster" },
  ...
]
```

---

## Phase 3 — Show the user + gate

Before writing anything, print the inclusion list to the user with scores, existing-or-new, and estimated size (30-80 for subdirs, 50-150 for root). Ask: **"Proceed with this plan? (yes/edit/cancel)"**

This is a deliberate gate. `/init-deep` is destructive-adjacent on `--create-new` and touches many files in update mode. Do NOT skip the confirmation.

---

## Phase 4 — Generate (parallel)

On user approval:

1. **Root first.** Write/Edit the root `AGENTS.md` yourself (not a subagent) — 50-150 lines covering: OVERVIEW, STRUCTURE (non-obvious purpose only), WHERE TO LOOK (task → location table), CODE MAP (top exports from Serena), CONVENTIONS (deviations from standard TS only), ANTI-PATTERNS (this project's NEVERs), UNIQUE STYLES, COMMANDS, NOTES.

2. **Subdirectories in parallel.** For each non-root inclusion-list entry, delegate to `@agents-md-writer`:
   ```
   task(agents-md-writer, "Generate AGENTS.md for <directory>. Reason: <score breakdown>. Root AGENTS.md content (for dedup reference): <inlined>.")
   ```
   Fire them all at once.

**Edit-vs-Write discipline:** If the target `AGENTS.md` already exists, use Edit (preserve manual additions). If not, Write. Never Write over an existing file.

---

## Phase 5 — Review & dedupe

Once all writers have returned:

- Read each generated/updated file
- Remove any bullet that duplicates content from the parent AGENTS.md (exact text match or equivalent claim)
- Trim to size caps (30-80 subdirs, 50-150 root)
- Scan for verbose prose or generic advice ("this directory contains TypeScript code", "follow best practices") — delete
- Delegate to `@plan-reviewer` for a final coherence pass if >5 files were written

---

## Report

```
=== /init-deep complete ===

Mode: update | create-new
Dirs analyzed: N
AGENTS.md created: M
AGENTS.md updated: K
AGENTS.md skipped (low score): J

Files:
  [UPDATED] ./AGENTS.md (N lines)
  [CREATED] ./packages/ui/AGENTS.md (N lines)
  [UPDATED] ./packages/core/AGENTS.md (N lines)
  ...

Hierarchy:
  ./AGENTS.md
  ├── apps/api/AGENTS.md
  ├── apps/web/AGENTS.md
  └── packages/
      ├── core/AGENTS.md
      ├── ui/AGENTS.md
      └── ...

Suggested commit: chore: refresh per-directory AGENTS.md
```

---

## Anti-patterns (things that fail this command)

- **Static agent count** — must scale agents to project size (see dynamic scaling above).
- **Sequential execution** — Phase 1 agents must fire concurrently.
- **Ignoring existing** — always read existing AGENTS.md first, even on `--create-new` (to capture context before overwrite).
- **Over-documenting** — not every directory gets an AGENTS.md. Score-gate is the whole point.
- **Child duplicating parent** — Phase 5 dedup is mandatory, not optional.
- **Generic content** — "use TypeScript strict mode" applies to every TS project; remove it.
- **Verbose prose** — telegraphic. Bullets over paragraphs.
- **Skipping the Phase 3 gate** — users must see the plan before you write files.
