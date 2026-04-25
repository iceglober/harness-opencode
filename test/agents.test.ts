import { describe, it, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAgents } from "../src/agents/index.js";
import { createCommands } from "../src/commands/index.js";
import { applyConfig } from "../src/config-hook.js";

describe("createAgents", () => {
  const agents = createAgents();

  it("returns exactly 14 agents", () => {
    // 3 original primary + 9 subagents + 2 pilot primaries (Phase F1+F2)
    expect(Object.keys(agents).length).toBe(14);
  });

  it("has 5 primary agents with mode=primary", () => {
    // 3 originals + pilot-planner + pilot-builder
    for (const name of [
      "prime",
      "plan",
      "build",
      "pilot-builder",
      "pilot-planner",
    ]) {
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

  it("prime has correct model and temperature", () => {
    const orch = agents["prime"]!;
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
      prime: {
        model: "anthropic/claude-haiku-4-5",
        prompt: "custom prompt",
        mode: "primary" as const,
      },
    };
    const merged = { ...agents, ...userOverride };
    expect(merged["prime"]!.model).toBe("anthropic/claude-haiku-4-5");
    expect(merged["prime"]!.prompt).toBe("custom prompt");
    // Other agents unaffected
    expect(merged["plan"]).toEqual(agents["plan"]);
  });
});

// --- Pilot agents (Phase F1 + F2) ----------------------------------------

describe("pilot agents", () => {
  const agents = createAgents();

  test("pilot-builder is registered with mode=primary", () => {
    const a = agents["pilot-builder"];
    expect(a).toBeDefined();
    expect(a!.mode).toBe("primary");
    expect(a!.model).toBe("anthropic/claude-sonnet-4-6");
    expect(a!.temperature).toBe(0.1);
  });

  test("pilot-planner is registered with mode=primary", () => {
    const a = agents["pilot-planner"];
    expect(a).toBeDefined();
    expect(a!.mode).toBe("primary");
    expect(a!.model).toBe("anthropic/claude-opus-4-7");
    expect(a!.temperature).toBe(0.3);
  });

  test("pilot-builder denies destructive git operations (commit / push / branch)", () => {
    const perm = agents["pilot-builder"]!.permission as Record<
      string,
      unknown
    >;
    const bash = perm.bash as Record<string, string>;
    expect(bash["git commit*"]).toBe("deny");
    expect(bash["git push*"]).toBe("deny");
    expect(bash["git tag*"]).toBe("deny");
    expect(bash["git checkout *"]).toBe("deny");
    expect(bash["git switch *"]).toBe("deny");
    expect(bash["git branch *"]).toBe("deny");
    expect(bash["gh pr *"]).toBe("deny");
    expect(bash["gh release *"]).toBe("deny");
  });

  test("pilot-builder denies the question tool (unattended invariant)", () => {
    const perm = agents["pilot-builder"]!.permission as Record<
      string,
      unknown
    >;
    expect(perm.question).toBe("deny");
  });

  test("pilot-builder still allows general bash through CORE_BASH_ALLOW_LIST", () => {
    const perm = agents["pilot-builder"]!.permission as Record<
      string,
      unknown
    >;
    const bash = perm.bash as Record<string, string>;
    // A few representative entries from CORE_BASH_ALLOW_LIST.
    expect(bash["bun test *"]).toBe("allow");
    expect(bash["ls *"]).toBe("allow");
    expect(bash["git status *"]).toBe("allow");
    expect(bash["git diff *"]).toBe("allow");
  });

  test("pilot-planner denies bash by default but allows pilot validate / plan-dir", () => {
    const perm = agents["pilot-planner"]!.permission as Record<
      string,
      unknown
    >;
    const bash = perm.bash as Record<string, string>;
    expect(bash["*"]).toBe("deny");
    expect(bash["bunx @glrs-dev/harness-opencode pilot validate"]).toBe(
      "allow",
    );
    expect(bash["bunx @glrs-dev/harness-opencode pilot validate *"]).toBe(
      "allow",
    );
    expect(bash["bunx @glrs-dev/harness-opencode pilot plan-dir"]).toBe(
      "allow",
    );
  });

  test("pilot-planner allows the question tool (interactive planning)", () => {
    const perm = agents["pilot-planner"]!.permission as Record<
      string,
      unknown
    >;
    expect(perm.question).toBe("allow");
  });

  test("pilot agents have non-empty descriptions", () => {
    expect(
      (agents["pilot-builder"]!.description as string).length,
    ).toBeGreaterThan(20);
    expect(
      (agents["pilot-planner"]!.description as string).length,
    ).toBeGreaterThan(20);
  });

  test("pilot-builder prompt mentions STOP protocol", () => {
    const prompt = agents["pilot-builder"]!.prompt as string;
    expect(prompt).toMatch(/STOP:/);
    expect(prompt.toLowerCase()).toMatch(/never commit/);
  });

  test("pilot-planner prompt references the pilot-planning skill", () => {
    const prompt = agents["pilot-planner"]!.prompt as string;
    expect(prompt).toMatch(/pilot-planning/);
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

  // ---- bash object-form shape lock-in (root-cause fix, v0.7.0) ----
  //
  // Live log evidence (user's kn-eng session, 2026-04-24) proved that
  // scalar `bash: "allow"` on subagents loses to an upstream OpenCode
  // rule injecting `{bash, *, ask}` via last-match-wins. The fix: use
  // object-form bash maps with SPECIFIC-PATTERN allows that sort
  // AFTER upstream wildcard keys in `Permission.fromConfig`, winning
  // via the same last-match-wins evaluation. See the big comment near
  // CORE_BASH_ALLOW_LIST in src/agents/index.ts and the architecture
  // doc for the full rationale.
  //
  // Do NOT simplify back to scalar. These tests lock that constraint.

  // Commands from the user's actual bug reports — every one of these
  // triggered a permission-ask prompt in the wild. The fix must make
  // each one evaluate to "allow" via the specific-pattern rules in
  // CORE_BASH_ALLOW_LIST (sorted LATER in fromConfig than the upstream
  // wildcard `bash * ask`).
  const PAIN_POINT_COMMANDS = [
    "pnpm lint",
    "pnpm lint --filter @kn/core",
    "tail -n 20 foo.log",
    "tail -30",
    "ls apps/api-server/AGENTS.md apps/web-app/AGENTS.md",
    "ls -la",
    "cat package.json",
    "head -50 foo.ts",
    "git status",
    "git diff HEAD~1 --stat",
    "git log --oneline -20",
    "git merge-base main HEAD",
    "git merge-base HEAD origin/main",
    "git rev-parse HEAD",
    "git branch --show-current",
    "git show HEAD:package.json",
    "grep -rn foo src",
    "rg foo src",
    "find src -name '*.ts'",
    "wc -l foo.ts",
    "bunx @glrs-dev/harness-opencode plan-dir",
    "bun test test/agents.test.ts",
    "pnpm --filter @kn/core test",
    "pnpm test foo.test.ts",
  ];

  // Commands that MUST be denied across every allow-list'd agent.
  const DESTRUCTIVE_COMMANDS = [
    "rm -rf /",
    "rm -rf /tmp/anything",
    "rm -rf ~/secret",
    "chmod +x evil.sh",
    "chown root file",
    "sudo rm -f foo",
    "git push --force origin main",
    "git push -f origin main",
    "git push origin --force main",
    "git push origin --force-with-lease main", // explicit re-allow
  ];

  /**
   * Simulates OpenCode's `Permission.fromConfig` → `Permission.evaluate`
   * path for a given bash rule-map. Mirrors the upstream implementation
   * in `packages/opencode/src/permission/index.ts` and
   * `packages/opencode/src/util/wildcard.ts`. Any mismatch between this
   * simulator and the real OpenCode runtime would be a bug in one of the
   * two — the live log trace in the docs confirms this simulator lines
   * up with observed behavior.
   */
  function evaluateBash(
    bashMap: Record<string, string>,
    command: string,
  ): "allow" | "deny" | "ask" {
    // fromConfig sorts top-level keys so wildcards-in-name sort first.
    // Inside the `bash` permission, every sub-key's pattern is a
    // bash-command glob; none contains the literal `*` in the KEY-NAME
    // sense fromConfig sorts on (that sort is on the PERMISSION name,
    // not the pattern). But we're already inside one permission here,
    // so sort is a no-op — we just flatten the entries in order.
    const rules: Array<{ pattern: string; action: string }> = [];
    for (const [pattern, action] of Object.entries(bashMap)) {
      rules.push({ pattern, action });
    }

    // Wildcard match, mirroring src/util/wildcard.ts::match.
    function match(str: string, pattern: string): boolean {
      let escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      if (escaped.endsWith(" .*")) {
        escaped = escaped.slice(0, -3) + "( .*)?";
      }
      return new RegExp("^" + escaped + "$", "s").test(str);
    }

    const matched = rules.findLast((r) => match(command, r.pattern));
    if (!matched) return "ask";
    if (matched.action === "allow") return "allow";
    if (matched.action === "deny") return "deny";
    return "ask";
  }

  it("qa-reviewer bash is object-form with enumerated allow-list", () => {
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash).not.toBeNull();
    expect(bash["*"]).toBe("allow");
    // Spot-check a handful of enumerated entries — the exhaustive
    // pain-point coverage is in the next test.
    expect(bash["tail *"]).toBe("allow");
    expect(bash["pnpm lint *"]).toBe("allow");
    expect(bash["git merge-base *"]).toBe("allow");
    expect(bash["ls *"]).toBe("allow");
    // Core denies must be present.
    expect(bash["rm -rf /*"]).toBe("deny");
    expect(bash["rm -rf ~*"]).toBe("deny");
    expect(bash["chmod *"]).toBe("deny");
    expect(bash["chown *"]).toBe("deny");
    expect(bash["sudo *"]).toBe("deny");
    expect(bash["git push --force*"]).toBe("deny");
    expect(bash["git push --force-with-lease*"]).toBe("allow");
  });

  it("qa-reviewer bash object form allows all reported pain-point commands", () => {
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of PAIN_POINT_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      if (action !== "allow") {
        mismatches.push(`  "${cmd}" → ${action}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `qa-reviewer bash map fails to allow pain-point commands:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("qa-reviewer bash object form denies destructive commands", () => {
    const bash = (agents["qa-reviewer"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of DESTRUCTIVE_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      // --force-with-lease is the explicit re-allow exception.
      const expected = cmd.includes("--force-with-lease") ? "allow" : "deny";
      if (action !== expected) {
        mismatches.push(`  "${cmd}" → ${action} (expected ${expected})`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `qa-reviewer bash map fails destructive-command check:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("qa-thorough bash is object-form with enumerated allow-list", () => {
    const bash = (agents["qa-thorough"] as any).permission.bash;
    expect(typeof bash).toBe("object");
    expect(bash).not.toBeNull();
    expect(bash["*"]).toBe("allow");
    expect(bash["tail *"]).toBe("allow");
    expect(bash["pnpm lint *"]).toBe("allow");
    expect(bash["git merge-base *"]).toBe("allow");
    expect(bash["rm -rf /*"]).toBe("deny");
  });

  it("qa-thorough bash object form allows all reported pain-point commands", () => {
    const bash = (agents["qa-thorough"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of PAIN_POINT_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      if (action !== "allow") {
        mismatches.push(`  "${cmd}" → ${action}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `qa-thorough bash map fails to allow pain-point commands:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("qa-thorough bash shape matches qa-reviewer", () => {
    // They share a role (read-only adversarial review). Any divergence
    // would cause the fast/thorough dispatch to have different
    // allowlists — a foot-gun. Fail noisily if someone drifts one
    // without the other.
    const qr = (agents["qa-reviewer"] as any).permission.bash;
    const qt = (agents["qa-thorough"] as any).permission.bash;
    expect(qt).toEqual(qr);
  });

  it("qa-thorough permission block matches qa-reviewer shape (non-bash keys)", () => {
    const qr = (agents["qa-reviewer"] as any).permission;
    const qt = (agents["qa-thorough"] as any).permission;
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
  });

  it("prime bash object-form includes enumerated allow-list", () => {
    const bash = (agents["prime"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of PAIN_POINT_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      if (action !== "allow") {
        mismatches.push(`  "${cmd}" → ${action}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `prime bash map fails to allow pain-point commands:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("prime bash object-form keeps destructive denies", () => {
    const bash = (agents["prime"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of DESTRUCTIVE_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      const expected = cmd.includes("--force-with-lease") ? "allow" : "deny";
      if (action !== expected) {
        mismatches.push(`  "${cmd}" → ${action} (expected ${expected})`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `prime bash map fails destructive-command check:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("build bash object-form includes enumerated allow-list", () => {
    const bash = (agents["build"] as any).permission.bash;
    const mismatches: string[] = [];
    for (const cmd of PAIN_POINT_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      if (action !== "allow") {
        mismatches.push(`  "${cmd}" → ${action}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `build bash map fails to allow pain-point commands:\n${mismatches.join("\n")}`,
      );
    }
  });

  it("build bash object-form keeps destructive denies and build-specific deny/ask rules", () => {
    const bash = (agents["build"] as any).permission.bash;
    // Standard destructive denies.
    for (const cmd of DESTRUCTIVE_COMMANDS) {
      const action = evaluateBash(bash, cmd);
      const expected = cmd.includes("--force-with-lease") ? "allow" : "deny";
      expect(action).toBe(expected);
    }
    // Build-specific rules: git clean denied (stricter than prime),
    // git reset --hard must prompt (ask).
    expect(bash["git clean *"]).toBe("deny");
    expect(bash["git reset --hard*"]).toBe("ask");
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
  const prime = agents["prime"]!.prompt as string;

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

  // ---- prime (picker + delegation + pre-existing-failure rule) ----

  it("prime prompt contains qa-fast-vs-thorough heuristic", () => {
    expect(prime).toContain("@qa-thorough");
    expect(prime).toContain("@qa-reviewer");
    expect(prime).toMatch(/>10 files|>500 lines/);
    expect(prime.toLowerCase()).toContain("risk: high");
    expect(prime.toLowerCase()).toMatch(
      /auth|security|crypto|billing|migration/,
    );
  });

  it("prime prompt requires session-green summary for qa-reviewer delegation", () => {
    expect(prime).toContain("tests passed at");
    expect(prime).toContain("lint passed at");
    expect(prime).toContain("typecheck passed at");
  });

  it("prime prompt requires logging pre-existing failures to plan Open questions", () => {
    expect(prime).toContain("## Open questions");
    expect(prime.toLowerCase()).toContain("pre-existing failure");
    expect(prime.toLowerCase()).toContain(
      "not introduced by this change",
    );
  });

  it("prime subagent reference lists both qa-reviewer and qa-thorough", () => {
    expect(prime).toMatch(/- `@qa-reviewer`/);
    expect(prime).toMatch(/- `@qa-thorough`/);
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

  it("prime Phase 0 probe references new plan dir (or a shell snippet that resolves it)", () => {
    // Phase 0 bootstrap should probe for plans using the resolver, not
    // the legacy `ls .agent/plans/`.
    expect(prime).toContain("bunx @glrs-dev/harness-opencode plan-dir");
    // Legacy probe must be gone.
    expect(prime).not.toContain("ls .agent/plans/");
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
  //      destructive ops (prime, build) — they explicitly deny
  //      `rm -rf /`, `rm -rf ~`, `sudo`, `chmod`, `chown`,
  //      `git push --force`, `git push * main`, `git push * master`.
  //      Tests for these live in "prime bash deny rules" etc.
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

  it("prime agent keeps object-form destructive denies (primary-agent safety net)", () => {
    // The safety net moved from global → prime's own agent config.
    // Lock in the critical denies here so they can't be removed without
    // touching a test that explicitly names them.
    const agents = createAgents();
    const bash = (agents["prime"] as any).permission.bash;
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
