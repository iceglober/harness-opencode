---
"@glrs-dev/harness-opencode": minor
---

Make `/fresh` faster and lower-friction. Three user-visible changes:

- **`/fresh` now wipes by default in interactive mode.** Previously, a dirty working tree triggered a mandatory `question`-tool prompt ("Worktree is dirty. /fresh will hard-discard ALL uncommitted changes. Proceed?") before any reset ran. The new default trusts the human who typed `/fresh` — if you ran the command, you've already decided you want a fresh workspace. The wipe happens silently; the post-hoc summary in §7 lists what was discarded so there's still a visible receipt. `--confirm` is a new flag that restores the old ask-first behavior for paranoid runs. `--yes` (autopilot) semantics are unchanged — it stays strict, aborting on tracked changes or non-gitignored untracked files to protect unattended loops from silent data loss.

- **`/fresh` auto-continues into the orchestrator on the new task.** New §8 "Kick off the orchestrator on the new task (in the SAME turn)": after printing the summary, `/fresh` reads the handoff brief it just wrote and enters the orchestrator arc inline (Phase 0 → Phase 1 → …) on the new request. You no longer have to type "work on it" after `/fresh`; the re-key and the start-working are one uninterrupted turn. The autopilot plugin's "session idle → nudge to read handoff brief" path becomes a fallback for the interrupted-continuation case rather than the primary mechanism — autopilot loops gain one round-trip saved per issue.

- **Permission defaults relax for `git reset --hard` and `git clean`.** Shipped defaults in `src/index.ts` now `allow` both patterns (previously `ask` and `deny` respectively). The old defaults blocked `/fresh`'s own built-in reset flow and produced a permission prompt on every `git reset --hard` anywhere — exactly the "answer a question every time" friction that `/fresh` is supposed to eliminate. Destructive-push patterns (`git push --force`, `git push -f`, `rm -rf /`, `sudo`, `chmod`, `chown`) remain denied.

Existing tests all pass (146 tests, 513 expects). The interactive-default flip is a behavior change for humans at the terminal — if you rely on the old ask-first prompt as a safety gate, add `--confirm` to your `/fresh` invocations or (for the habitual case) alias `/fresh` in your own notes to `/fresh --confirm`.
