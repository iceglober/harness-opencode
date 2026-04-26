# src/skills — bundled skills

Each subdirectory here is a skill that ships in the npm tarball and is registered with OpenCode at runtime.

## Layout

```
skills/
├── paths.ts                          # getSkillsRoot() — resolves to dist/skills/ at runtime
├── agent-estimation/                 # Each subdir is one skill
│   └── SKILL.md
├── pilot-planning/                   # Methodology for pilot-planner agent
│   ├── SKILL.md
│   └── rules/*.md                    # Supporting rule files
├── review-plan/
│   └── SKILL.md
├── vercel-composition-patterns/      # Vercel-provided skill (see landmine below)
│   ├── SKILL.md
│   ├── AGENTS.md                     # ← THIS IS SKILL CONTENT, NOT REPO CONTEXT
│   ├── README.md
│   └── rules/
├── vercel-react-best-practices/      # Same
│   ├── SKILL.md
│   ├── AGENTS.md                     # ← Same
│   └── rules/
└── web-design-guidelines/
    └── SKILL.md
```

## Convention

- Directory name === `frontmatter.name` in `SKILL.md` (enforced by `test/skills-bundle.test.ts`).
- Required frontmatter: `name` (kebab-case matching dirname), `description` (1-1024 chars, used for skill-triggering keywords).
- No registration code required — `tsup.config.ts`'s `onSuccess` hook copies `src/skills/**` → `dist/skills/**`, and `config-hook.ts` pushes the dir onto `config.skills.paths`. Directory-scanned, not per-skill enumerated.

## Landmine: `AGENTS.md` inside Vercel skills is *skill content*

`src/skills/vercel-composition-patterns/AGENTS.md` and `src/skills/vercel-react-best-practices/AGENTS.md` are Vercel's published skill-content files (900+ and 1700+ lines respectively — React docs, not repo-context guidance for agents editing those directories). **Never overwrite them.** If `/init-deep` or a similar tool proposes writing per-skill repo-context guidance, route that guidance to this file (`src/skills/AGENTS.md`) instead.

## Adding a new skill

1. Create `src/skills/<name>/SKILL.md` with frontmatter (`name: <name>`, `description: <triggering-keywords>`).
2. If the skill has supporting files, put them in `src/skills/<name>/rules/` or a sibling subdirectory — the build copies the whole tree.
3. Update `test/skills-bundle.test.ts`: bump the skill-count assertion and insert the name in the sorted array.
4. Add a changeset (`bunx changeset`, pick `minor` — new skills are user-visible additions).
5. `bun run build && bun run typecheck && bun test`.

## Gotchas

- `test/skills-bundle.test.ts` enforces: name-matches-dirname, kebab-case regex, description 1-1024 chars. Your skill won't bundle cleanly if any of these fail.
- Skills are **read-only by design**. The plugin-registers-via-`skills.paths` precedence means plugin skills shadow user overrides — customization = fork the package. See root AGENTS.md rule 5.
- Paths inside `SKILL.md` must not reference the forbidden patterns enforced by `test/prompts-no-dangling-paths.test.ts` (home-relative claude/opencode dirs, legacy per-worktree plan paths). See that test file for the authoritative list.
