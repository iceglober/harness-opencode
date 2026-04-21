import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_ROWS = 50;
const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB (was 10 MB)

// Top-15 common house-config ESLint rules. Hints ≤ 80 chars each.
export const ESLINT_REMEDIATION_HINTS: Record<string, string> = {
  "no-unused-vars": "Remove the binding or prefix with `_` to mark intentional",
  "no-explicit-any": "Replace `any` with a real type or `unknown` + narrowing",
  "prefer-const": "Binding is never reassigned — use `const` instead of `let`",
  "no-console": "Remove the console call or route through a real logger",
  eqeqeq: "Use `===` / `!==` instead of `==` / `!=`",
  "no-empty": "Empty block — add a comment or handle the case explicitly",
  "no-shadow": "Rename to avoid shadowing the outer binding",
  "no-undef": "Missing import or typo; add to imports or declare globally",
  "no-var": "Replace `var` with `let` or `const`",
  semi: "Add or remove the trailing semicolon per the config",
  quotes: "Use the configured quote style (single vs double)",
  indent: "Re-indent to match the config; run the formatter",
  "no-restricted-syntax": "Usage blocked by config — pick an allowed alternative",
  "@typescript-eslint/no-floating-promises": "Await, `.catch()`, or `void`-prefix the promise",
  "@typescript-eslint/no-misused-promises": "Handler can't return a promise; wrap or refactor",
};

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
}

interface EslintFileReport {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

export interface ParsedLintRow {
  rule: string;
  file: string;
  line: number;
  message: string;
  severity: number;
  count: number;
}

// Exported for testing.
export function parseEslintJson(raw: string): ParsedLintRow[] {
  if (!raw.trim()) return [];
  let data: EslintFileReport[];
  try {
    data = JSON.parse(raw) as EslintFileReport[];
  } catch {
    return [];
  }
  const out: ParsedLintRow[] = [];
  for (const file of data) {
    for (const msg of file.messages) {
      out.push({
        rule: msg.ruleId ?? "<parse-error>",
        file: file.filePath,
        line: msg.line,
        message: msg.message,
        severity: msg.severity,
        count: 1,
      });
    }
  }
  return out;
}

// Exported for testing. Dedupe by (rule, file), sort errors (sev 2)
// before warnings (sev 1), then by count desc.
export function dedupeAndCap(
  rows: ParsedLintRow[],
  cap: number,
): { rows: ParsedLintRow[]; truncated: number } {
  const map = new Map<string, ParsedLintRow>();
  for (const r of rows) {
    const key = `${r.rule}::${r.file}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, { ...r });
    }
  }
  const all = [...map.values()].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (b.count !== a.count) return b.count - a.count;
    return a.rule.localeCompare(b.rule);
  });
  if (all.length <= cap) return { rows: all, truncated: 0 };
  return { rows: all.slice(0, cap), truncated: all.length - cap };
}

// Exported for testing.
export function formatRow(r: ParsedLintRow): string {
  const sev = r.severity === 2 ? "error" : "warn";
  const hint = ESLINT_REMEDIATION_HINTS[r.rule];
  const hintSuffix = hint ? `\n    → ${hint}` : "";
  const countSuffix = r.count > 1 ? ` (×${r.count})` : "";
  return `${r.file}:${r.line} [${sev}] ${r.rule}${countSuffix}: ${r.message}${hintSuffix}`;
}

export default tool({
  description: "Run eslint on specific files. Returns lint errors as JSON.",
  args: {
    files: tool.schema
      .array(tool.schema.string())
      .describe("Files or globs to lint"),
    fix: tool.schema
      .boolean()
      .default(false)
      .describe("If true, auto-fix safe issues"),
    full: tool.schema
      .boolean()
      .default(false)
      .describe(
        "If true, bypass the 50-row (rule,file) dedupe/cap and return every violation",
      ),
  },
  async execute(args, context) {
    const cmdArgs = ["eslint", "--format", "json"];
    if (args.fix) cmdArgs.push("--fix");
    cmdArgs.push(...args.files);
    let raw: string;
    try {
      const { stdout } = await exec("npx", cmdArgs, {
        maxBuffer: MAX_BUFFER,
        cwd: context.directory,
        encoding: "utf8",
      });
      raw = String(stdout || "[]");
    } catch (err) {
      const e = err as {
        stdout?: string;
        message: string;
        code?: number | string;
      };
      if (
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        /\bENOBUFS\b/.test(e.message ?? "")
      ) {
        return `[eslint output overflowed ${MAX_BUFFER} byte buffer. Fix the top-level rules first and re-run on narrower globs.]`;
      }
      raw = String(e.stdout || `eslint error: ${e.message}`);
    }

    const rows = parseEslintJson(raw);
    if (rows.length === 0) {
      // Either clean (passthrough "[]") or a parse error (passthrough raw).
      return raw;
    }

    if (args.full) {
      const lines = rows.map((r) => formatRow(r));
      return `Total violations: ${rows.length}\n\n${lines.join("\n")}`;
    }

    const { rows: capped, truncated } = dedupeAndCap(rows, MAX_ROWS);
    const lines = capped.map(formatRow);
    const footer =
      truncated > 0
        ? `\n\n… ${truncated} more (rule,file) categories (pass full:true to see all). Total raw violations: ${rows.length}.`
        : `\n\nTotal raw violations: ${rows.length}.`;
    return `${lines.join("\n")}${footer}`;
  },
});
