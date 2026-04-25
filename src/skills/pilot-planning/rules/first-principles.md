# Rule 1 — First-principles task framing

**Frame from intent, not from a template.**

Bad plans start with a checklist ("read AGENTS.md → write tests → write code → run tests"). Good plans start with the question: *what does the user actually want at the end of this?*

## What to ask yourself

1. **What is the working state at the end of the run?** A passing test suite that previously failed? A new endpoint serving real traffic? A refactor with zero behavior change? Different end-states demand different task shapes.

2. **What can fail?** A task that "adds an import" can't really fail. A task that "implements pagination across three layers" can fail in a hundred ways. The latter needs decomposition.

3. **What does the verify catch?** If you can't articulate the failure mode each verify command detects, the verify is decoration.

4. **What is the smallest change that ships?** Pilot is good at small surgical work. If the user wants a wholesale rewrite, pilot is the wrong tool — say so.

## Talk to the user — once

Before you spend an hour reading code, take 2 minutes to ask the user 1-3 clarifying questions:

- Scope (what's in / out of this plan?)
- Success criteria (how do we know we're done?)
- Constraints (deps to use, deps to avoid, tests to preserve)

Do this BEFORE applying rules 2-7. The cheapest mistake to fix is the one you avoid by understanding intent up front.

## Then read code

Don't ask the user things you can answer by reading code. Don't ask "what test framework do you use?" — `package.json` says. Don't ask "where does auth live?" — `grep` it. Use the user's time only for things genuinely unknown to the codebase.
