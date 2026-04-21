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
