import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgents } from "../src/agents/index.js";
import { createCommands } from "../src/commands/index.js";
import { applyConfig } from "../src/config-hook.js";

describe("createAgents", () => {
  const agents = createAgents();

  it("returns exactly 12 agents", () => {
    expect(Object.keys(agents).length).toBe(12);
  });

  it("has the 3 primary agents with mode=primary", () => {
    for (const name of ["orchestrator", "plan", "build"]) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]!.mode).toBe("primary");
    }
  });

  it("has the 9 subagents with mode=subagent", () => {
    const subagents = [
      "qa-reviewer",
      "qa-thorough",
      "plan-reviewer",
      "code-searcher",
      "gap-analyzer",
      "architecture-advisor",
      "docs-maintainer",
      "lib-reader",
      "agents-md-writer",
    ];
    for (const name of subagents) {
      expect(agents[name]).toBeDefined();
      expect(agents[name]!.mode).toBe("subagent");
    }
  });

  it("every agent has a non-empty prompt", () => {
    for (const [name, cfg] of Object.entries(agents)) {
      expect(typeof cfg.prompt).toBe("string");
      expect((cfg.prompt as string).length).toBeGreaterThan(10);
    }
  });

  it("every agent has a non-empty description", () => {
    for (const [name, cfg] of Object.entries(agents)) {
      expect(typeof cfg.description).toBe("string");
      expect((cfg.description as string).length).toBeGreaterThan(0);
    }
  });

  it("orchestrator has correct model and temperature", () => {
    const orch = agents["orchestrator"]!;
    expect(orch.model).toBe("anthropic/claude-opus-4-7");
    expect(orch.temperature).toBe(0.2);
  });

  it("build has correct model and temperature", () => {
    const build = agents["build"]!;
    expect(build.model).toBe("anthropic/claude-sonnet-4-6");
    expect(build.temperature).toBe(0.1);
  });

  it("qa-reviewer model is sonnet-4-6", () => {
    expect(agents["qa-reviewer"]!.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("qa-thorough subagent is registered with opus model", () => {
    const qt = agents["qa-thorough"]!;
    expect(qt).toBeDefined();
    expect(qt.model).toBe("anthropic/claude-opus-4-7");
    expect(qt.mode).toBe("subagent");
    expect((qt.description as string).toLowerCase()).toContain("re-run");
  });

  it("no agent prompt contains dangling ~/.claude or home/.claude paths", () => {
    const FORBIDDEN = [
      "~/.claude",
      "home/.claude",
      "~/.config/opencode",
      "home/.config/opencode",
    ];
    for (const [name, cfg] of Object.entries(agents)) {
      const prompt = cfg.prompt as string;
      for (const pattern of FORBIDDEN) {
        expect(prompt).not.toContain(pattern);
      }
    }
  });

  it("user-wins precedence: user agent overrides plugin agent", () => {
    // Simulate what src/index.ts does: { ...ourAgents, ...(input.agent ?? {}) }
    const userOverride = {
      orchestrator: {
        model: "anthropic/claude-haiku-4-5",
        prompt: "custom prompt",
        mode: "primary" as const,
      },
    };
    const merged = { ...agents, ...userOverride };
    expect(merged["orchestrator"]!.model).toBe("anthropic/claude-haiku-4-5");
    expect(merged["orchestrator"]!.prompt).toBe("custom prompt");
    // Other agents unaffected
    expect(merged["plan"]).toEqual(agents["plan"]);
  });
});

describe("subagent permissions", () => {
  const agents = createAgents();

  const subagentsWithPerms = [
    "qa-reviewer",
    "qa-thorough",
    "plan-reviewer",
    "code-searcher",
    "gap-analyzer",
    "architecture-advisor",
    "lib-reader",
    "agents-md-writer",
  ];

  it("subagents with perms have a non-empty permission block", () => {
    for (const name of subagentsWithPerms) {
      const cfg = agents[name];
      expect(cfg).toBeDefined();
      expect((cfg as any).permission).toBeDefined();
      expect(typeof (cfg as any).permission).toBe("object");
    }
  });

  it("docs-maintainer has no permission override", () => {
    // Explicitly unchanged — it never had frontmatter perms, so overrides
    // pass nothing, and the AgentConfig has no permission key set.
    const cfg = agents["docs-maintainer"];
    expect(cfg).toBeDefined();
    expect((cfg as any).permission).toBeUndefined();
  });

  it("qa-reviewer bash is plain \"allow\" string", () => {
    // Regression target for the permission-ask bug: the agent-level bash
    // permission must be the plain string "allow", not an object rule-map.
    // A global bash rule-map was also observed to cause ask-prompts to
    // leak through even when the agent scalar was "allow" — so
    // applyConfig intentionally ships NO global permission.bash default.
    // Destructive-command safety for reviewers relies on their read-only
    // role (system prompt forbids destructive ops) and they never reach
    // for `rm -rf`, `sudo`, etc. Primary agents (orchestrator, build)
    // carry their own agent-level object-form deny rules.
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    expect(bash).toBe("allow");
  });

  it("qa-thorough bash is plain \"allow\" string", () => {
    const bash = (agents["qa-thorough"] as any).permission.bash;
    expect(bash).toBe("allow");
  });

  it("qa-thorough permission block matches qa-reviewer shape", () => {
    const qr = (agents["qa-reviewer"] as any).permission;
    const qt = (agents["qa-thorough"] as any).permission;
    // Flat-keyed tool perms must match
    for (const key of [
      "edit",
      "webfetch",
      "ast_grep",
      "tsc_check",
      "eslint_check",
      "todo_scan",
      "comment_check",
      "question",
      "serena",
      "memory",
      "git",
      "playwright",
      "linear",
    ]) {
      expect(qt[key]).toBe(qr[key]);
    }
    // Bash is now a plain string; assert both are the same string value.
    expect(qt.bash).toBe(qr.bash);
    expect(qr.bash).toBe("allow");
  });

  it("src/agents/index.ts no longer contains NONDESTRUCTIVE_BASH_RULES", () => {
    // Lock in the dead-code removal: the per-subagent object-form rule-map
    // was replaced by the plain-string form, and the shared constant was
    // deleted. Guards against accidental reintroduction.
    const sourcePath = path.join(
      import.meta.dir,
      "..",
      "src",
      "agents",
      "index.ts",
    );
    const source = fs.readFileSync(sourcePath, "utf8");
    expect(source).not.toContain("NONDESTRUCTIVE_BASH_RULES");
  });

  it("read-only subagents have bash: deny", () => {
    for (const name of [
      "plan-reviewer",
      "gap-analyzer",
      "code-searcher",
      "architecture-advisor",
      "lib-reader",
    ]) {
      const perm = (agents[name] as any).permission;
      expect(perm.bash).toBe("deny");
    }
  });

  it("plan agent bash rules: deny-all except the plan-dir CLI subcommand", () => {
    // The plan agent needs to resolve the repo-shared plan dir before
    // writing plans there. It does that via the harness's own CLI
    // subcommand. Everything else remains denied, preserving the
    // "plan writes only plan files" invariant.
    const bash = (agents["plan"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash["*"]).toBe("deny");
    expect(bash["bunx @glrs-dev/harness-opencode plan-dir"]).toBe("allow");
    expect(bash["bunx @glrs-dev/harness-opencode plan-dir *"]).toBe("allow");
  });

  it("plan agent description references the repo-shared plan directory (not .agent/plans)", () => {
    const desc = (agents["plan"] as any).description as string;
    expect(desc).toContain("plan-dir");
    // Legacy path reference must not linger in the description.
    expect(desc).not.toContain(".agent/plans");
  });

  it("agents-md-writer preserves bash: ask and edit: allow", () => {
    const perm = (agents["agents-md-writer"] as any).permission;
    expect(perm.bash).toBe("ask");
    expect(perm.edit).toBe("allow");
  });

  it("no subagent .md file contains a permission: frontmatter block", () => {
    // Guards against the "dead frontmatter decoration" footgun returning.
    const promptsDir = path.join(
      import.meta.dir,
      "..",
      "src",
      "agents",
      "prompts",
    );
    const files = fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(promptsDir, f), "utf8");
      // Only scan frontmatter — split on the closing ---.
      if (!content.startsWith("---")) continue;
      const end = content.indexOf("\n---", 3);
      if (end === -1) continue;
      const fm = content.slice(3, end);
      expect(fm).not.toContain("permission:");
    }
  });
});

describe("prompt content assertions", () => {
  const agents = createAgents();
  const qaReviewer = agents["qa-reviewer"]!.prompt as string;
  const qaThorough = agents["qa-thorough"]!.prompt as string;
  const orchestrator = agents["orchestrator"]!.prompt as string;

  // ---- qa-reviewer (fast variant) ----

  it("qa-reviewer prompt contains trust-recent-green clause", () => {
    expect(qaReviewer).toContain("tests passed at");
    expect(qaReviewer).toContain("lint passed at");
    expect(qaReviewer).toContain("typecheck passed at");
  });

  it("qa-reviewer prompt requires git log verification for untracked-in-plan files", () => {
    expect(qaReviewer).toContain("git log --oneline -- <file>");
  });

  it("qa-reviewer prompt contains plan-drift auto-fail rule", () => {
    expect(qaReviewer.toLowerCase()).toContain("plan drift");
    expect(qaReviewer.toLowerCase()).toContain("auto-fail");
    expect(qaReviewer).toContain("## File-level changes");
  });

  it("qa-reviewer prompt retains plan-state verify step", () => {
    expect(qaReviewer).toContain("plan-check --run");
  });

  it("qa-reviewer prompt guards full-suite re-run behind trust-recent-green", () => {
    expect(qaReviewer.toLowerCase()).toMatch(
      /skip re-running|skip running|skip these|skip this step/,
    );
  });

  // ---- qa-thorough (opus variant) ----

  it("qa-thorough prompt contains strengthened scope and plan-drift rules", () => {
    expect(qaThorough).toContain("git log --oneline -- <file>");
    expect(qaThorough.toLowerCase()).toContain("plan drift");
    expect(qaThorough.toLowerCase()).toContain("auto-fail");
  });

  it("qa-thorough prompt unconditionally re-runs full suite", () => {
    expect(qaThorough.toLowerCase()).toContain("re-run");
  });

  it("qa-thorough prompt does NOT contain trust-recent-green clause", () => {
    expect(qaThorough).not.toContain("tests passed at");
    expect(qaThorough).not.toContain("trust-recent-green");
  });

  // ---- orchestrator (picker + delegation + pre-existing-failure rule) ----

  it("orchestrator prompt contains qa-fast-vs-thorough heuristic", () => {
    expect(orchestrator).toContain("@qa-thorough");
    expect(orchestrator).toContain("@qa-reviewer");
    expect(orchestrator).toMatch(/>10 files|>500 lines/);
    expect(orchestrator.toLowerCase()).toContain("risk: high");
    expect(orchestrator.toLowerCase()).toMatch(
      /auth|security|crypto|billing|migration/,
    );
  });

  it("orchestrator prompt requires session-green summary for qa-reviewer delegation", () => {
    expect(orchestrator).toContain("tests passed at");
    expect(orchestrator).toContain("lint passed at");
    expect(orchestrator).toContain("typecheck passed at");
  });

  it("orchestrator prompt requires logging pre-existing failures to plan Open questions", () => {
    expect(orchestrator).toContain("## Open questions");
    expect(orchestrator.toLowerCase()).toContain("pre-existing failure");
    expect(orchestrator.toLowerCase()).toContain(
      "not introduced by this change",
    );
  });

  it("orchestrator subagent reference lists both qa-reviewer and qa-thorough", () => {
    expect(orchestrator).toMatch(/- `@qa-reviewer`/);
    expect(orchestrator).toMatch(/- `@qa-thorough`/);
  });

  // ---- Plan-storage migration regression guards (a7 in the
  // plans-repo-shared-storage plan) ----
  //
  // These tests lock in that prompts reference the repo-shared plan
  // directory via the resolver CLI rather than the legacy per-worktree
  // `.agent/plans/<slug>.md` path. CI's dangling-paths guard catches the
  // literal string; these tests go further and assert the POSITIVE
  // presence of the new integration point so a future prompt edit that
  // silently removes the CLI reference is caught too.

  const planPrompt = agents["plan"]!.prompt as string;
  const autopilotCommand = createCommands()["autopilot"]!.template as string;

  it("plan agent prompt body mentions GLORIOUS_PLAN_DIR or bunx harness-opencode plan-dir helper", () => {
    // The plan agent must know how to resolve the new plan dir. One of
    // these references must appear so the agent actually invokes the
    // resolver rather than writing to a hardcoded path.
    const hasResolver =
      planPrompt.includes("bunx @glrs-dev/harness-opencode plan-dir") ||
      planPrompt.includes("GLORIOUS_PLAN_DIR");
    expect(hasResolver).toBe(true);
  });

  it("orchestrator Phase 0 probe references new plan dir (or a shell snippet that resolves it)", () => {
    // Phase 0 bootstrap should probe for plans using the resolver, not
    // the legacy `ls .agent/plans/`.
    expect(orchestrator).toContain("bunx @glrs-dev/harness-opencode plan-dir");
    // Legacy probe must be gone.
    expect(orchestrator).not.toContain("ls .agent/plans/");
  });

  it("autopilot command prompt handoff uses <plan-path> or absolute shape, not .agent/plans/<slug>", () => {
    // The user-facing `/ship` handoff line in the autopilot command
    // prompt must not print the legacy path shape. Either the abstract
    // `<plan-path>` placeholder (when dynamic) or the annotated absolute
    // template (when pedagogical) is acceptable.
    expect(autopilotCommand).not.toMatch(/\/ship\s+\.agent\/plans\/<slug>\.md/);
    // Must reference one of the new shapes in the ship example.
    const hasNewShape =
      autopilotCommand.includes("/ship <plan-path>") ||
      autopilotCommand.includes("/ship ~/.glorious/opencode/");
    expect(hasNewShape).toBe(true);
  });
});

describe("applyConfig — permission.bash behavior", () => {
  // Regression: we intentionally do NOT ship a global permission.bash
  // default. An earlier object-form rule-map at this layer caused
  // OpenCode's permission resolver to emit ask-prompts for trivial
  // read-only commands (e.g. `git branch --show-current`) under
  // subagents that declared `bash: "allow"` as a scalar — the global
  // pattern map was re-evaluated on top of the agent-level allow and
  // fell through to "ask" for some command shapes.
  //
  // Safety for destructive commands is preserved via:
  //   1. Per-agent object-form bash maps on primary agents that run
  //      destructive ops (orchestrator, build) — they explicitly deny
  //      `rm -rf /`, `rm -rf ~`, `sudo`, `chmod`, `chown`,
  //      `git push --force`, `git push * main`, `git push * master`.
  //      Tests for these live in "orchestrator bash deny rules" etc.
  //   2. Read-only subagents declaring `bash: "deny"` entirely
  //      (plan-reviewer, code-searcher, gap-analyzer, …).
  //   3. Reviewer system prompts that forbid destructive operations
  //      by role (qa-reviewer, qa-thorough).

  it("applyConfig does NOT set a global permission.bash default", () => {
    const config: any = {};
    applyConfig(config);
    // No global bash rule-map should be injected — the resolution
    // ambiguity it created was the root cause of reviewer ask-prompts.
    expect(config.permission?.bash).toBeUndefined();
  });

  it("applyConfig preserves user-supplied permission.bash without overwriting", () => {
    // User-wins semantics: if the user sets permission.bash in their
    // opencode.json, our defaults must NOT overwrite it.
    const userBash = { "*": "ask", "git status *": "allow" };
    const config: any = { permission: { bash: userBash } };
    applyConfig(config);
    expect(config.permission.bash).toBe(userBash);
    expect(config.permission.bash["*"]).toBe("ask");
  });

  it("orchestrator agent keeps object-form destructive denies (primary-agent safety net)", () => {
    // The safety net moved from global → orchestrator's own agent config.
    // Lock in the critical denies here so they can't be removed without
    // touching a test that explicitly names them.
    const agents = createAgents();
    const bash = (agents["orchestrator"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash["*"]).toBe("allow");
    expect(bash["git push --force*"]).toBe("deny");
    expect(bash["git push -f *"]).toBe("deny");
    expect(bash["rm -rf /*"]).toBe("deny");
    expect(bash["rm -rf ~*"]).toBe("deny");
    expect(bash["chmod *"]).toBe("deny");
    expect(bash["chown *"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
    // --force-with-lease remains allowed (safe force-push).
    expect(bash["git push --force-with-lease*"]).toBe("allow");
  });

  it("build agent keeps object-form destructive denies (primary-agent safety net)", () => {
    const agents = createAgents();
    const bash = (agents["build"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash["*"]).toBe("allow");
    expect(bash["git push --force*"]).toBe("deny");
    expect(bash["rm -rf /*"]).toBe("deny");
    expect(bash["rm -rf ~*"]).toBe("deny");
    expect(bash["chmod *"]).toBe("deny");
    expect(bash["chown *"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
    expect(bash["git push --force-with-lease*"]).toBe("allow");
  });
});
