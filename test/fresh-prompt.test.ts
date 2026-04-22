/**
 * Static assertions for the `/fresh` command prompt and registration.
 *
 * The /fresh command implements a dispatcher-model reset: a project-committed
 * .glorious/hooks/fresh-reset (if present + executable) owns the reset
 * strategy; otherwise the built-in long-running-worktree flow runs. These
 * tests pin down load-bearing tokens in the prompt and catch accidental
 * regression on the hook-first dispatch semantics.
 *
 * Assertions target concrete tokens the prompt MUST carry (paths, flag
 * names, handoff-brief field labels) rather than narrative prose, so the
 * test is stable across innocuous rewording.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const FRESH_PROMPT_PATH = path.join(
  ROOT,
  "src",
  "commands",
  "prompts",
  "fresh.md",
);
const COMMANDS_INDEX_PATH = path.join(ROOT, "src", "commands", "index.ts");

describe("fresh prompt contract", () => {
  const freshPrompt = fs.readFileSync(FRESH_PROMPT_PATH, "utf8");
  const commandsIndex = fs.readFileSync(COMMANDS_INDEX_PATH, "utf8");

  it("references .glorious/hooks/fresh-reset at least twice (dispatch + hook contract)", () => {
    const token = ".glorious/hooks/fresh-reset";
    const occurrences = freshPrompt.split(token).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("documents the --skip-hook escape hatch", () => {
    expect(freshPrompt).toContain("--skip-hook");
  });

  it("defines the handoff-brief **Reset status:** field", () => {
    expect(freshPrompt).toContain("**Reset status:**");
  });

  it("defines the handoff-brief **Branch now:** field", () => {
    expect(freshPrompt).toContain("**Branch now:**");
  });

  it("does not reference the deleted docs/fresh.md", () => {
    expect(freshPrompt).not.toContain("docs/fresh.md");
  });

  it("fresh command description does not contain stale 'gsag' or 'Create a fresh worktree' wording", () => {
    // Narrow to the fresh: { ... } block so we don't false-match other
    // commands. The block is small and string-quoted; a simple slice works.
    const freshBlockStart = commandsIndex.indexOf("fresh: {");
    expect(freshBlockStart).toBeGreaterThan(-1);
    // Pull the next ~400 chars, which comfortably covers a multi-line
    // description and the closing brace.
    const freshBlock = commandsIndex.slice(
      freshBlockStart,
      freshBlockStart + 400,
    );
    expect(freshBlock).not.toMatch(/gsag/i);
    expect(freshBlock).not.toMatch(/Create a fresh worktree/i);
  });
});
