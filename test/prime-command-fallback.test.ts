/**
 * Static assertions for the PRIME agent's slash-command fallback section.
 *
 * When OpenCode's TUI fails to dispatch a plugin-registered slash command,
 * the raw text (e.g. `/fresh meeting prep`) flows into the prime agent
 * as a plain user message. The prime prompt carries a fallback
 * contract: recognize the command, read the template from the bundled
 * plugin cache, substitute `$ARGUMENTS`, and execute inline.
 *
 * These tests pin the load-bearing tokens of that section — the command
 * allowlist, the announcement template, the cache read path, the edge
 * cases, and the scope-replacement rule — so future prompt edits can't
 * silently delete the fallback contract. All assertions are scoped to
 * the section body (between its heading and the next `# ` top-level
 * heading) to avoid false-positive matches elsewhere in the prompt.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const ORCH_PATH = path.join(
  ROOT,
  "src",
  "agents",
  "prompts",
  "prime.md",
);
const ORCH = fs.readFileSync(ORCH_PATH, "utf8");

const SECTION_HEADING = "# Slash-command fallback";

function extractSection(): string {
  const start = ORCH.indexOf(SECTION_HEADING);
  expect(start).toBeGreaterThan(-1);
  // Find the next top-level `# ` heading (not `## ` or deeper) after our section.
  const afterHeading = start + SECTION_HEADING.length;
  const nextTopLevel = ORCH.slice(afterHeading).search(/\n# [^\n]/);
  const end = nextTopLevel === -1 ? ORCH.length : afterHeading + nextTopLevel;
  return ORCH.slice(start, end);
}

describe("prime slash-command fallback section", () => {
  it("section exists", () => {
    expect(ORCH).toContain(SECTION_HEADING);
  });

  it("section appears before ## Phase 0", () => {
    const secIdx = ORCH.indexOf(SECTION_HEADING);
    const phase0Idx = ORCH.indexOf("## Phase 0");
    expect(secIdx).toBeGreaterThan(-1);
    expect(phase0Idx).toBeGreaterThan(-1);
    expect(secIdx).toBeLessThan(phase0Idx);
  });

  it("section lists all seven recognized commands", () => {
    const body = extractSection();
    for (const cmd of [
      "/fresh",
      "/ship",
      "/review",
      "/autopilot",
      "/research",
      "/init-deep",
      "/costs",
    ]) {
      expect(body).toContain(cmd);
    }
  });

  it("section documents the announcement template", () => {
    const body = extractSection();
    expect(body).toContain("→ Slash command");
    expect(body.toLowerCase()).toContain("tui dispatch missed");
  });

  it("section mentions $ARGUMENTS substitution", () => {
    const body = extractSection();
    expect(body).toContain("$ARGUMENTS");
  });

  it("section documents the cache read path", () => {
    const body = extractSection();
    expect(body).toContain(
      "~/.cache/opencode/packages/@glrs-dev/harness-opencode",
    );
  });

  it("section covers the five edge cases", () => {
    const body = extractSection();
    const lc = body.toLowerCase();
    // (a) no args → $ARGUMENTS empty
    expect(lc).toContain("no args");
    // (b) unknown /<token> falls through
    expect(lc).toContain("unknown");
    // (c) mid-message or later line is plain text
    expect(lc).toMatch(/mid-message|later line/);
    // (d) multiple recognized → only first counts
    expect(lc).toContain("first counts");
    // (e) template read failure → announce + fall through
    expect(lc).toMatch(/template read fail|not found|file missing/);
  });

  it("section states the five-phase arc is replaced on fallback", () => {
    const body = extractSection();
    const lc = body.toLowerCase();
    expect(lc).toContain("replace");
    expect(lc).toContain("phase 0");
  });

  it("section mentions frontmatter stripping", () => {
    const body = extractSection();
    expect(body.toLowerCase()).toContain("frontmatter");
  });

  it("section body contains no forbidden paths", () => {
    const body = extractSection();
    for (const pat of [
      "~/.claude",
      "home/.claude",
      "~/.config/opencode",
      "home/.config/opencode",
    ]) {
      expect(body).not.toContain(pat);
    }
  });
});
