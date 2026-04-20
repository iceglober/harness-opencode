# Deep Codebase Research

Given a topic or question, deeply explore the codebase using subagents to produce a comprehensive understanding with specific code references.

**Research Topic:** $ARGUMENTS

## Instructions

### Core Principle

You are an **orchestrator only**. You MUST delegate ALL exploration and analysis to subagents. Your role is to:

1. Break down the research into discrete tasks
2. Launch subagents in parallel where possible
3. Synthesize their findings into a coherent response

**NEVER** use Glob, Grep, or Read tools directly. Always delegate to Explore or Task subagents.

### Phase 1: Decompose the Research Topic

Analyze the provided topic and identify 3-6 distinct research questions that need to be answered. For each question, determine:

1. What specific aspect of the codebase needs exploration
2. What patterns, files, or concepts are likely relevant
3. What the expected output should be

Write these questions to the todo list using TodoWrite before proceeding.

### Phase 2: Parallel Exploration

Launch **Explore subagents IN PARALLEL** for each research question identified in Phase 1. Use this prompt template for each:

```
Research Topic: [ORIGINAL TOPIC]
Specific Question: [QUESTION FROM PHASE 1]

Thoroughly explore the codebase to answer this question. Provide:

1. **Relevant Files**: List all files with full paths and line numbers for key code
2. **Code Patterns**: Identify patterns, conventions, or idioms used
3. **Data Flow**: Trace how data moves through the relevant code paths
4. **Dependencies**: Note what this code depends on and what depends on it
5. **Key Insights**: Any non-obvious findings, gotchas, or important context

Be extremely thorough. Read actual code, not just file names. Follow imports and references.
```

**IMPORTANT**: Launch ALL Explore subagents in a SINGLE message to maximize parallelism.

### Phase 3: Deep Dive (If Needed)

If Phase 2 reveals areas requiring deeper investigation, launch additional **Explore subagents** for:

- Complex code paths that need line-by-line analysis
- Cross-cutting concerns that span multiple packages
- Historical patterns (how similar problems were solved elsewhere)

Again, launch these in parallel where possible.

### Phase 4: Synthesize Findings

Launch a **Task subagent (general-purpose)** to synthesize all findings:

```
Synthesize the following codebase research into a comprehensive summary.

**Original Research Topic:**
[TOPIC]

**Research Findings:**
[ALL FINDINGS FROM EXPLORE SUBAGENTS]

Create a structured summary with these sections:

## Overview
A 2-3 sentence summary of what was learned about the topic.

## Architecture
How the relevant code is structured:
- Key components and their responsibilities
- How they interact
- Design patterns used

## Code Locations
Organized list of relevant files with:
- Full paths with line numbers (format: `path/to/file.ts:123`)
- Brief description of what each file/section does
- Importance level (critical, important, reference)

## Data Flow
How data moves through the system for this topic:
- Entry points
- Transformations
- Exit points

## Patterns & Conventions
Coding patterns and conventions observed:
- Naming conventions
- Error handling approaches
- Testing patterns

## Dependencies
- Internal dependencies (other packages/modules)
- External dependencies (packages / libraries, system services, third-party APIs)

## Gotchas & Edge Cases
Non-obvious things discovered:
- Edge cases in the code
- Potential issues or tech debt
- Things that might surprise someone new

## Related Areas
Other parts of the codebase that relate to this topic but weren't the main focus.

## Open Questions
Things that couldn't be fully answered or need human clarification.
```

### Phase 5: Report Results

Present the synthesized findings to the user. Include:

1. The structured summary from Phase 4
2. A brief "quick reference" of the most important file paths
3. Suggestions for follow-up research if applicable

Mark all todos as completed.

## Usage Examples

```
/research How does authentication work in this codebase?
```

```
/research What is the data flow for a request from API to database?
```

```
/research How are background workers structured and how do they execute jobs?
```

```
/research What testing patterns are used and how do I write tests for a new feature?
```

## Subagent Guidelines

### When to Use Explore Subagent

- Finding files and code patterns
- Understanding code structure
- Tracing data flow
- Discovering dependencies

### When to Use Task (general-purpose) Subagent

- Synthesizing information from multiple sources
- Creating structured documentation
- Analyzing complex relationships
- Generating summaries

### Parallelization Rules

- Launch ALL independent explorations in a single message
- Only sequence subagents when one depends on another's output
- Prefer 4-6 parallel subagents over sequential exploration

## Notes

- If no topic is provided as an argument, ask the user what they want to research
- If the topic is too broad, ask clarifying questions before proceeding
- Always provide specific file paths with line numbers in the final output
- The goal is to leave the user with a complete mental model of how the topic works in this codebase
