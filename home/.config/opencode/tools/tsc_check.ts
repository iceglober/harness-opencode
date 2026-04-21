import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_ROWS = 15;
const MAX_BUFFER = 2 * 1024 * 1024; // 2 MB (was 10 MB — floods context)

// Top-20 TypeScript error codes by observed frequency across the
// codebases we target. Hints are ≤ 80 chars each (enforced by
// test/tsc-check-hints.sh).
// If you add a code, keep the hint under 80 chars and note it in the
// test's expected-keys list.
export const REMEDIATION_HINTS: Record<string, string> = {
  TS2322: "Assigned type isn't assignable — narrow with a guard or widen the target type",
  TS2345: "Argument type doesn't match param — check param type & coerce or narrow",
  TS2531: "Value is possibly null — guard with `if (x)` or use optional chaining",
  TS18048: "Value is possibly undefined — guard before use or assert non-null",
  TS2307: "Module not found — install the dep or fix the import path",
  TS7006: "Implicit `any` on parameter — annotate the type explicitly",
  TS2339: "Property doesn't exist on type — check the type, widen it, or use indexing",
  TS2304: "Name not found — missing import or typo",
  TS2532: "Object possibly undefined — guard with `?.` or narrow before access",
  TS18047: "Value is possibly null — add a null guard",
  TS2769: "No overload matches — check argument types/arity against signatures",
  TS2741: "Missing required property — add it to the object literal",
  TS2739: "Missing required properties — add all listed fields",
  TS2554: "Wrong number of arguments — check the function signature",
  TS2551: "Property not found; did you mean <suggestion>? — fix the name",
  TS7016: "No type declarations — add `@types/<pkg>` or `declare module`",
  TS2367: "Comparison always false — types don't overlap; rework the check",
  TS1005: "Syntax error — check brackets/commas/semicolons near the report",
  TS1109: "Expression expected — syntax malformation; re-check the line",
  TS2420: "Class incorrectly implements interface — add/align missing members",
};

export interface ParsedError {
  code: string;
  file: string;
  line: number;
  col: number;
  message: string;
}

// Exported for testing. Parses `tsc --noEmit --pretty false` stdout.
// Line shape: `<file>(<line>,<col>): error TS<code>: <message>`
export function parseTscOutput(raw: string): ParsedError[] {
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS(\d+):\s+(.+)$/;
  const out: ParsedError[] = [];
  for (const line of raw.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      col: Number(m[3]),
      code: `TS${m[4]}`,
      message: m[5],
    });
  }
  return out;
}

// Exported for testing. Dedupe by (code, file) keeping first occurrence
// plus accumulating count. Sorts by count desc, then code asc for stability.
export function dedupeAndCap(
  errors: ParsedError[],
  cap: number,
): { rows: Array<ParsedError & { count: number }>; truncated: number } {
  const map = new Map<string, ParsedError & { count: number }>();
  for (const e of errors) {
    const key = `${e.code}::${e.file}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(key, { ...e, count: 1 });
    }
  }
  const all = [...map.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.code.localeCompare(b.code);
  });
  if (all.length <= cap) return { rows: all, truncated: 0 };
  return { rows: all.slice(0, cap), truncated: all.length - cap };
}

// Exported for testing. Formats one row with optional remediation hint.
export function formatRow(row: ParsedError & { count: number }): string {
  const hint = REMEDIATION_HINTS[row.code];
  const hintSuffix = hint ? `\n    → ${hint}` : "";
  const countSuffix = row.count > 1 ? ` (×${row.count})` : "";
  return `${row.file}:${row.line}:${row.col} ${row.code}${countSuffix}: ${row.message}${hintSuffix}`;
}

export default tool({
  description:
    "Run TypeScript compiler in noEmit mode on the project. Returns errors only. " +
    "Faster than running the full test suite for type-correctness checks.",
  args: {
    project: tool.schema
      .string()
      .default("tsconfig.json")
      .describe("Path to tsconfig.json (relative to the project directory)"),
    full: tool.schema
      .boolean()
      .default(false)
      .describe(
        "If true, bypass the 15-row (code,file) dedupe/cap and return every error",
      ),
  },
  async execute(args, context) {
    let raw: string;
    try {
      const { stdout, stderr } = await exec(
        "npx",
        ["tsc", "--noEmit", "--project", args.project, "--pretty", "false"],
        { maxBuffer: MAX_BUFFER, cwd: context.directory, encoding: "utf8" },
      );
      raw = String(stdout || "");
      if (stderr) raw += `\n[warnings]\n${String(stderr)}`;
    } catch (err) {
      const e = err as {
        stdout?: string;
        message: string;
        code?: number | string;
      };
      // tsc exits non-zero when there are errors — that's expected; the
      // stdout is still useful. ENOBUFS is the overflow case.
      if (
        e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        /\bENOBUFS\b/.test(e.message ?? "")
      ) {
        return `[tsc output overflowed ${MAX_BUFFER} byte buffer — too many errors to stream. Pass full:true is NOT recommended here; fix the top-level errors first and re-run.]`;
      }
      raw = String(e.stdout || e.message || "");
    }

    if (!raw.trim()) return "(no errors)";

    const errors = parseTscOutput(raw);
    if (errors.length === 0) {
      // Output exists but didn't parse — return raw (tsc config issue, etc.)
      return raw;
    }

    if (args.full) {
      // Full mode: no dedupe, no cap. Row-per-error with hints inline.
      const lines = errors.map((e) => formatRow({ ...e, count: 1 }));
      return `Total errors: ${errors.length}\n\n${lines.join("\n")}`;
    }

    const { rows, truncated } = dedupeAndCap(errors, MAX_ROWS);
    const lines = rows.map(formatRow);
    const footer =
      truncated > 0
        ? `\n\n… ${truncated} more (code,file) categories (pass full:true to see all). Total raw errors: ${errors.length}.`
        : `\n\nTotal raw errors: ${errors.length}.`;
    return `${lines.join("\n")}${footer}`;
  },
});
