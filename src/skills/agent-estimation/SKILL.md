---
name: agent-estimation
description: Estimate AI-agent task effort in tool-call rounds first, convert to wallclock only at the end. Use when the user asks 'how long will this take', 'estimate this', 'scope this work', 'round budget', 'effort estimate', or asks for a timeline on agent-executed work. Produces a structured module-breakdown table with risk coefficients and a final wallclock range. Avoids the systematic overestimation that happens when agents anchor to human-developer timelines from training data.
---

# Agent Work Estimation

## Why this skill exists

AI coding agents systematically overestimate task duration because they anchor to human-developer timelines absorbed from training data. A task you can complete in 30 minutes of agent time gets estimated as "2-3 days" because that's what a StackOverflow answer would say.

**The fix:** estimate in your own operational units — tool-call rounds — first. Convert to human wallclock only at the very end, as the last step.

This skill is adapted for the harness-opencode environment from the OpenClaw `hjw21century/agent-estimation` skill. Original source: https://openclawlaunch.com/skills/agent-estimation.

## Units

| Unit | Definition | Scale |
|------|------------|-------|
| **Round** | One tool-call cycle: think → write/edit → execute → read output → decide if fix needed | ~2-4 min wallclock |
| **Module** | A functional unit built from multiple rounds until it's usable on its own | 2-15 rounds |
| **Project** | Sum of modules + integration rounds | Σ(modules) + integration |

A **Round** is the atomic unit. It maps to one iteration of:

1. Agent reasons about what to do.
2. Agent writes or edits code.
3. Agent runs the code or a test.
4. Agent reads the output.
5. Agent decides if it needs to fix something. If yes → next round.

## Procedure

Follow these five steps in order. Do NOT skip step 5 — premature wallclock conversion is the failure mode.

### Step 1: Decompose into modules

Break the task into functional modules. Each module should be independently buildable and testable. Ask: "What are the distinct pieces I would build one at a time?"

### Step 2: Estimate base rounds per module

Use these anchors:

| Pattern | Typical rounds | Examples |
|---------|----------------|----------|
| **Boilerplate / known pattern** | 1-2 | CRUD endpoint, config file, standard API client, adding a file to match an existing recipe |
| **Moderate complexity** | 3-5 | Custom UI layout, state management, data pipeline, non-trivial refactor |
| **Exploratory / under-documented** | 5-10 | Unfamiliar framework, platform-specific APIs, complex integrations |
| **High uncertainty** | 8-15 | Undocumented behavior, novel algorithms, multi-system debugging |

Calibration rules:

- If you can generate the code in one shot and it will likely run → **1 round**.
- If you'll generate, run, see an error, fix → **2-3 rounds**.
- If the library/framework has sparse docs and you'll be guessing → **5+ rounds**.
- If it involves platform permissions, OS-level APIs, or environment-specific behavior the user must manually verify → add **2-3 rounds**.

### Step 3: Assign risk coefficients

Each module gets a coefficient that inflates its round count:

| Risk | Coefficient | When to apply |
|------|-------------|---------------|
| **Low** | 1.0 | Mature ecosystem, clear docs, strong pattern match |
| **Medium** | 1.3 | Minor unknowns, may need 1-2 extra debug rounds |
| **High** | 1.5 | Sparse docs, platform quirks, integration unknowns |
| **Very High** | 2.0 | Possible dead ends, may need to change approach entirely |

### Step 4: Calculate totals

```
module_effective_rounds = base_rounds × risk_coefficient
project_rounds          = Σ(module_effective_rounds) + integration_rounds
integration_rounds      = 10-20% of base total (wiring modules together)
```

### Step 5: Convert to wallclock — LAST

Only after steps 1-4 are complete:

```
wallclock = project_rounds × minutes_per_round
```

Default `minutes_per_round = 3` (agent generation + user review).

Adjust:

- Fast iteration, user barely reviews → **2 min/round**.
- Complex domain, user carefully reviews each step → **4 min/round**.
- User needs to manually test (mobile, hardware, permissions) → **5 min/round**.

## Output format

Always produce the estimation in this exact structure:

```markdown
### Task: <task name>

#### Module breakdown

| # | Module | Base rounds | Risk | Effective rounds | Notes |
|---|--------|-------------|------|------------------|-------|
| 1 | ...    | N           | 1.x  | M                | why   |
| 2 | ...    | N           | 1.x  | M                | why   |

#### Summary

- **Base rounds:** X
- **Integration:** +Y rounds
- **Risk-adjusted total:** Z rounds
- **Estimated wallclock:** A – B minutes (at N min/round)

#### Biggest risks

1. <specific risk and what could blow up the estimate>
2. <…>
```

## Anti-patterns to avoid

These are the exact failure modes this skill exists to prevent:

1. **Human-time anchoring:** "A developer would take about 2 weeks…" → NO. Start from rounds.
2. **Padding by vibes:** Adding time "just to be safe" without a specific risk rationale → NO. Use risk coefficients; each bump must have a reason.
3. **Confusing complexity with volume:** 500 lines of boilerplate ≠ hard. One line of CGEvent API ≠ easy. Estimate by uncertainty, not line count.
4. **Forgetting integration cost:** Modules work alone but break together. Always add 10-20% for integration.
5. **Ignoring user-side bottlenecks:** If the user must grant permissions, restart an app, or test on a device, that's extra round time. Adjust `minutes_per_round` upward, don't add phantom rounds.
6. **Premature wallclock conversion:** If you computed minutes before finishing step 4, start over. The whole point is to think in rounds first.

## Calibration examples

These anchor what "N rounds" feels like in this codebase. Use them as reference points when estimating similar work.

| Project | Module count | Total rounds | Notes |
|---------|--------------|--------------|-------|
| Add a new bundled skill (SKILL.md + test bump + build verify) | 1 | 2-3 | Recipe-driven, mature test suite, no new wiring |
| Add a new agent with prompt + registration + test | 2 | 4-6 | New prompt file + `createAgents()` entry + test case |
| Add a new slash command | 2 | 3-5 | Prompt file + `createCommands()` entry |
| Add a new custom tool with schema + handler + test | 3 | 8-12 | Schema design + handler logic + integration point |
| Refactor a cross-cutting concern (e.g., permission maps across all agents) | 3-5 | 15-25 | Medium-high risk due to surface area |
| Add a new sub-plugin (hook + registration + tests) | 3-4 | 12-18 | Plugin API surface, test fixtures |
| Non-trivial pilot subsystem feature (new verb, new scheduler rule) | 4-6 | 20-40 | Higher risk; SQLite schema + CLI + worker wiring |

When in doubt, pick the closest example and adjust the risk coefficient for what makes this specific task different.

## When to use this skill

- Scoping a coding task before starting implementation.
- Comparing two implementation approaches by round cost.
- Setting realistic expectations with the user on agent-executed work.
- Identifying which modules carry the most schedule risk.
- Deciding whether a task fits in one session or needs to be split.

## When NOT to use this skill

- Trivial one-line edits (typo fixes, rename). Just do it; estimating takes longer than the work.
- Open-ended research tasks where the "module breakdown" is the research itself. Estimate after the first exploratory round, not before.
- Questions that aren't about effort ("how does X work", "what's the right pattern"). Answer the actual question.
