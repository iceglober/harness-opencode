// Bun driver — imports tsc_check's pure exports and prints JSON to stdout
// so the bash test harness can assert on the results.
//
// Usage: bun run test/fixtures/run-tsc-check.ts <mode> [args...]
//
// Modes:
//   parse-fixture      Parse test/fixtures/tsc-output.txt; print errors.
//   dedupe <cap>       Parse+dedupe; print rows+truncated.
//   format-first       Parse+dedupe(15); print formatted rows.
//   hints-table        Print REMEDIATION_HINTS as JSON.
//   hint-lengths       Print {code, length} for each hint.

import {
  parseTscOutput,
  dedupeAndCap,
  formatRow,
  REMEDIATION_HINTS,
} from "../../home/.config/opencode/tools/tsc_check.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "tsc-output.txt");

const mode = process.argv[2];

switch (mode) {
  case "parse-fixture": {
    const raw = readFileSync(fixturePath, "utf8");
    const errors = parseTscOutput(raw);
    console.log(JSON.stringify(errors, null, 2));
    break;
  }
  case "dedupe": {
    const cap = Number(process.argv[3] ?? 15);
    const raw = readFileSync(fixturePath, "utf8");
    const errors = parseTscOutput(raw);
    const result = dedupeAndCap(errors, cap);
    console.log(JSON.stringify(result, null, 2));
    break;
  }
  case "format-first": {
    const raw = readFileSync(fixturePath, "utf8");
    const errors = parseTscOutput(raw);
    const { rows } = dedupeAndCap(errors, 15);
    for (const r of rows) {
      console.log(formatRow(r));
    }
    break;
  }
  case "format-all": {
    // Full mode — no cap. Used for asserting that unknown codes carry
    // no hint suffix (TS9999 in the fixture would be truncated at cap=15
    // because of low count).
    const raw = readFileSync(fixturePath, "utf8");
    const errors = parseTscOutput(raw);
    const { rows } = dedupeAndCap(errors, 10000);
    for (const r of rows) {
      console.log(formatRow(r));
    }
    break;
  }
  case "hints-table": {
    console.log(JSON.stringify(REMEDIATION_HINTS, null, 2));
    break;
  }
  case "hint-lengths": {
    const out: Array<{ code: string; length: number }> = [];
    for (const [code, hint] of Object.entries(REMEDIATION_HINTS)) {
      out.push({ code, length: hint.length });
    }
    console.log(JSON.stringify(out, null, 2));
    break;
  }
  default:
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}
