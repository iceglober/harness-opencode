---
description: Self-driving orchestrator run. Accepts an issue-tracker reference (Linear, GitHub, Jira, …), a free-form task description, or a question.
---

The user wants autopilot to process: $ARGUMENTS

You are the orchestrator running in autopilot mode. Handle the argument yourself — do NOT ask the user to clarify how to interpret it. Classify and dispatch as follows.

## 0. Workflow-mechanics: decide before anything else

Before classifying the argument, apply the workflow-mechanics heuristic from `~/.claude/agents/orchestrator.md` → "Workflow-mechanics decisions". Autopilot is lights-out: the rule fires automatically and silently (single announcement line of chat, no `question` tool, no notification). Never present a menu asking the user whether to open a fresh worktree, switch branches, or stack on current — the heuristic decides.

Abort paths (dirty tree on default branch; dirty tree on feature branch with unrelated work) mean STOP autopilot and report the one-sentence reason. The user resolves and re-runs.

If you auto-invoke `/fresh`, do NOT pass `--clean`. Cleanup stays user-triggered.

## 1. Classify the argument

Examine `$ARGUMENTS` and pick ONE of these paths:

- **Issue-tracker reference** — anything that looks like a ticket identifier. Match any of these shapes:
  - `<PROJECT>-<NUMBER>` where PROJECT is 2–10 uppercase letters (e.g. `ENG-1234`, `ICE-42`, `GEN-1114`, `PROJ-456`) — the common shape for Linear, Jira, YouTrack, Shortcut, etc.
  - `#<NUMBER>` alone (e.g. `#1234`) — GitHub / GitLab issue or PR shorthand
  - A URL to a recognized issue tracker (`github.com/.../issues/123`, `github.com/.../pull/123`, `linear.app/.../issue/...`, `<company>.atlassian.net/browse/...`, etc.)
- **Free-form task description** (any natural-language request that isn't a recognized issue ref): treat the text itself as the request.
- **Question** (starts with what/why/how/when/where/which/who, or ends with `?`): treat as question-only.

## 2. Fetch issue content (only if step 1 returned "Issue-tracker reference")

Try each of these in order. Stop at the first one that returns real content. Do NOT ask the user which tracker to use — probe.

1. **Linear MCP** — if the `linear` MCP is configured and enabled, and the arg matches `<PROJECT>-<NUMBER>` shape OR is a `linear.app` URL: call `linear_get_issue` with the identifier.
2. **GitHub MCP** — if a `github` MCP is configured OR the arg is a `github.com/.../issues/...` / `github.com/.../pull/...` URL OR the arg is `#<NUMBER>` and a `gh` CLI is available: fetch via the MCP, or shell out to `gh issue view <num> --json title,body,author,labels,state,comments` (or `gh pr view` for PR URLs).
3. **Jira / Atlassian MCP** — if a `jira` or `atlassian` MCP is configured and the arg matches `<PROJECT>-<NUMBER>` OR is an `*.atlassian.net` URL.
4. **Other issue-tracker MCPs** — if any MCP with `issue` / `ticket` / `task` in its name or documented toolset is available and the ref shape plausibly matches, try it.
5. **Unrecognized ref** — if nothing above resolves: report to the user once, in a single sentence: *"I see a ref that looks like a ticket (`<arg>`), but no issue-tracker MCP is configured to fetch it. Treating as a free-form description — please paste the issue body if you want me to ground in it."* Then proceed as free-form.

If a probe returns a 404 or "not found," do NOT ask the user "did you mean …?" — fall through to the next probe, then eventually to free-form.

Treat the fetched issue's title + description + acceptance criteria (or equivalents like "Definition of Done", checklists) as the intent baseline for the orchestrator arc.

## 3. Run the orchestrator arc

Once classified and (optionally) fetched, run your normal five-phase workflow (see `orchestrator.md`):

1. **Intent** — you've already classified via step 1; skip redundant classification
2. **Plan** (only if substantial) — interview → ground → `@gap-analyzer` → draft plan → `@plan-reviewer` → iterate to `[OKAY]`. For ref-originated requests, cite the issue ID in the plan's `## Goal` section.
3. **Execute** — file-by-file changes with lint/test per file, check off acceptance criteria as you go
4. **Verify** — full suite pass + `@qa-reviewer` → iterate to `[PASS]`
5. **Handoff** — report "Done. Run `/ship <plan-path>` when ready." STOP.

## 4. Autopilot guardrails

- The autopilot plugin (`~/.config/opencode/plugins/autopilot.ts`) will inject continuation messages if your session goes idle mid-plan. Treat those messages as a "keep going" signal, not a command to restart from scratch.
- The plugin caps at 10 continuation iterations; if you hit the cap, something is stuck — report specifically and ask for help.
- NEVER commit, push, or open a PR. That's the human gate via `/ship`.
- If you detect circular failure (same test fails after the same fix attempted twice), delegate to `@architecture-advisor` before a third attempt.

## 5. Reporting

Your single handoff message should include:
- What was classified — **which tracker resolved it** (e.g., `Linear ENG-1234 "Add OAuth flow"`, `GitHub #456 "Fix timezone bug"`, `Jira PROJ-42 "Migrate to Postgres 16"`) or the free-form summary, or "question-only"
- Plan path if created
- Summary of changes (1-2 sentences)
- Exact command to ship: `/ship .agent/plans/<slug>.md`

Do not over-narrate across multiple messages. One final report.
