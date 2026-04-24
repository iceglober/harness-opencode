/**
 * CI regression test: no dangling path references in prompt files.
 *
 * Greps src/agents/prompts/, src/commands/prompts/, and src/skills/**\/*.md
 * for patterns that reference paths that no longer exist post-pivot.
 * Any match fails CI.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

const FORBIDDEN_PATTERNS = [
  "~/.claude",
  "home/.claude",
  "~/.config/opencode",
  "home/.config/opencode",
  // Legacy per-worktree plan storage path. Plans now live in
  // `~/.glorious/opencode/<repo>/plans/` — resolved at runtime via
  // `bunx @glrs-dev/harness-opencode plan-dir`. A prompt that references
  // `.agent/plans` is pointing at a directory agents no longer write to,
  // which means the plan they describe will be invisible from sibling
  // worktrees and wiped by `/fresh`. See src/plan-paths.ts.
  ".agent/plans",
];

function findMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

const SEARCH_DIRS = [
  path.join(ROOT, "src", "agents", "prompts"),
  path.join(ROOT, "src", "commands", "prompts"),
  path.join(ROOT, "src", "skills"),
];

describe("prompts-no-dangling-paths", () => {
  const allMdFiles = SEARCH_DIRS.flatMap(findMdFiles);

  it("finds at least some markdown files to check", () => {
    expect(allMdFiles.length).toBeGreaterThan(0);
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`no file contains "${pattern}"`, () => {
      const violations: string[] = [];
      for (const filePath of allMdFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        if (content.includes(pattern)) {
          const relPath = path.relative(ROOT, filePath);
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]!.includes(pattern)) {
              violations.push(`${relPath}:${i + 1}: ${lines[i]!.trim()}`);
            }
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `Found dangling path references (${pattern}):\n${violations.join("\n")}`,
        );
      }
    });
  }
});

/**
 * OpenCode textually substitutes `$ARGUMENTS` with the full user input
 * wherever the token appears in a slash-command prompt. When a prompt
 * embeds `$ARGUMENTS` multiple times as self-reference ("Parse $ARGUMENTS",
 * "If $ARGUMENTS is empty"), long inputs (URLs, sentences) corrupt the
 * rendered prompt into nonsense. Keeping exactly one substitution site at
 * the top of the file and using semantic referents elsewhere ("the user's
 * input") keeps the render coherent regardless of input length.
 *
 * See issue #54 for the failure this test guards against.
 */
describe("$ARGUMENTS occurs at most once per command prompt", () => {
  const commandPromptsDir = path.join(ROOT, "src", "commands", "prompts");
  const commandMdFiles = findMdFiles(commandPromptsDir);

  it("finds at least one command prompt to check", () => {
    expect(commandMdFiles.length).toBeGreaterThan(0);
  });

  for (const filePath of commandMdFiles) {
    const relPath = path.relative(ROOT, filePath);
    it(`${relPath} contains $ARGUMENTS at most once`, () => {
      const raw = fs.readFileSync(filePath, "utf8");
      // Strip YAML frontmatter before counting — metadata is never substituted,
      // and a future `description:` field could otherwise over-count.
      const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
      const matches = body.match(/\$ARGUMENTS/g) ?? [];
      if (matches.length > 1) {
        const lines = body.split("\n");
        const locations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes("$ARGUMENTS")) {
            locations.push(`  line ${i + 1}: ${lines[i]!.trim()}`);
          }
        }
        throw new Error(
          `${relPath} contains $ARGUMENTS ${matches.length} times (expected ≤1):\n${locations.join("\n")}`,
        );
      }
      expect(matches.length).toBeLessThanOrEqual(1);
    });
  }
});
