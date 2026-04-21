# Workflow-mechanics decisions

Users run this harness so they don't have to answer questions about *mechanics*. They want the agent to decide, announce, and move. If you catch yourself about to open a `question` tool prompt asking the user which branch to use, whether to open a fresh worktree, whether this work should stack on the current branch, etc. — **stop.** Apply the heuristic below, state what you did in one line of chat (no notification), keep going.

## What counts as a workflow-mechanics decision

**In scope (you decide — never ask):**
- Which branch to create or switch to for new work
- Whether to open a fresh worktree via `/fresh` or stay on the current checkout
- How to map a ticket ID to a branch name (Linear MCP → use its `branchName` field; otherwise derive a slug using the rules in the `/fresh` command: lowercase, replace non-alphanumeric runs with `-`, infer verb prefix `fix/`/`feat/`/`refactor/`/`docs/`/`chore/`, truncate to 50 chars)
- Whether to isolate unrelated work onto its own branch when the user is on a feature branch
- Which base branch to branch from (default: repo default; override only if the user's request mentions a release branch explicitly)

**Out of scope (existing rules still apply — don't confuse this section with those):**
- Deciding whether to update a plan mid-flight — existing Phase 3 rule: report and ask.
- Deciding whether to push, open a PR, or merge — always user-initiated via `/ship`. Hard rules below are the limit.
- Commit message wording — you write it; the `/ship` command offers the user a review if asked.
- Content decisions (file location, symbol naming, etc.) — follow the trivial-request defaults in Phase 1.

## The deterministic heuristic

Evaluate these rules in order. Stop at the first match. **No "it depends."** If you're picking between branches, use this table, not judgement.

1. **Trivial request** (Phase 1 "trivial" path: <20 lines, 1 file, no behavior change): stay on current branch unconditionally. No branching, no announcement. A typo fix on `main` stays on `main`.
2. **Substantial request, on default branch (`main`/`master`/repo default) with `gsag` installed** → auto-invoke `/fresh` with the work description as `$ARGUMENTS` (and a ticket ID if you have one). Announce: `→ Workflow: starting fresh worktree via /fresh (avoiding work on default branch)`.
3. **Substantial request, on default branch without `gsag`** → `git checkout -b <slug>` from current position. Announce: `→ Workflow: created branch <slug> on current worktree (gsag not installed — staying here)`.
4. **Detached HEAD** → same as rule 2 or 3 based on `gsag` availability. Treat detached HEAD as "not on a branch" → needs isolation.
5. **Substantial request, on default branch, dirty tree** → abort with a single-sentence message: *"Uncommitted changes on `<branch>`; commit or stash them, then re-run."* Do NOT stash automatically — the user's WIP is theirs.
6. **Substantial request, on a feature branch, dirty tree, work unrelated to branch** → abort: *"On feature branch `<X>` with uncommitted changes; commit or stash before starting unrelated work."*
7. **Substantial request, on a feature branch (clean), work unrelated to branch** → create a new branch from the default: `git fetch origin && git checkout -b <slug> origin/<default-branch>`. Announce: `→ Workflow: switching from <old-branch> to new branch <slug> for unrelated work`.
8. **Substantial request, on a feature branch, work plausibly matches the branch** (branch name references same ticket, or same feature keyword) → stay. No announcement (status quo is the expected default).

Announcement format: plain chat, prefixed `→ Workflow:`. No `question` tool, no notification — notifications stay reserved for "user action required." Carve-outs: `/fresh` and `/ship` are user-initiated commands; their internal prompts are legitimate. This rule governs *agent-initiated* decisions only.
