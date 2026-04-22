---
"@glrs-dev/harness-opencode": minor
---

Cut qa-reviewer latency on typical diffs and preserve thorough review as an explicit opt-in. Four user-visible changes:

- **qa-reviewer dropped to Sonnet + trust-recent-green.** `qa-reviewer` now runs on `anthropic/claude-sonnet-4-6` (was Opus) and trusts the orchestrator's recent green test/lint/typecheck output within the session when the diff hasn't changed since. Semantic verification and scope-creep checks are unchanged. The trust-recent-green heuristic keys on three literal phrases the orchestrator now emits in its delegation prompt: `tests passed at <timestamp>`, `lint passed at <timestamp>`, `typecheck passed at <timestamp>`. Missing any of the three → qa-reviewer re-runs that specific command itself.

- **New `qa-thorough` subagent for high-risk cases.** Identical-shape permission block, Opus model, re-runs the full lint/test/typecheck suite unconditionally — i.e., the old qa-reviewer behavior. The orchestrator picks this variant automatically for diffs touching >10 files, >500 lines, any file marked `Risk: high` in the plan, or security/auth/crypto/billing/migration paths.

- **Orchestrator packages session-green timestamps into the qa-reviewer delegation prompt.** This is the load-bearing signal qa-reviewer's trust-recent-green heuristic keys on — without it, qa-reviewer re-runs everything. The orchestrator also now picks between fast and thorough variants deterministically via a documented heuristic in Phase 4 "Verify".

- **Orchestrator hard rule: log confirmed pre-existing failures to the plan's `## Open questions` section** via the `edit` tool before proceeding. Bullet format: `- Pre-existing failure confirmed in <file>::<test-name> — not introduced by this change. Recommend separate cleanup.` Prevents the finding from dying with the session and the next qa run re-investigating the same failure.

Plus strengthened scope-creep rules on BOTH qa variants: `git status` untracked files not in the plan must be verified via `git log --oneline -- <file>` (orchestrator's verbal "pre-existing" claim is not accepted), and modified files not in the plan's `## File-level changes` are AUTO-FAIL regardless of how "implicit" the coverage is.

13 new tests in `test/agents.test.ts` lock the load-bearing phrases on both sides of the contract (qa-reviewer, qa-thorough, orchestrator) so the two prompts cannot drift apart without test failure.
