// Bun driver for eslint_check pure exports.
import {
  parseEslintJson,
  dedupeAndCap,
  formatRow,
  ESLINT_REMEDIATION_HINTS,
} from "../../home/.config/opencode/tools/eslint_check.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "eslint-output.json");

const mode = process.argv[2];

switch (mode) {
  case "parse-fixture": {
    const raw = readFileSync(fixturePath, "utf8");
    console.log(JSON.stringify(parseEslintJson(raw), null, 2));
    break;
  }
  case "dedupe": {
    const cap = Number(process.argv[3] ?? 50);
    const raw = readFileSync(fixturePath, "utf8");
    const rows = parseEslintJson(raw);
    console.log(JSON.stringify(dedupeAndCap(rows, cap), null, 2));
    break;
  }
  case "format-first": {
    const raw = readFileSync(fixturePath, "utf8");
    const rows = parseEslintJson(raw);
    const { rows: capped } = dedupeAndCap(rows, 50);
    for (const r of capped) console.log(formatRow(r));
    break;
  }
  case "format-all": {
    const raw = readFileSync(fixturePath, "utf8");
    const rows = parseEslintJson(raw);
    const { rows: capped } = dedupeAndCap(rows, 10000);
    for (const r of capped) console.log(formatRow(r));
    break;
  }
  case "hints-table": {
    console.log(JSON.stringify(ESLINT_REMEDIATION_HINTS, null, 2));
    break;
  }
  case "hint-lengths": {
    const out: Array<{ rule: string; length: number }> = [];
    for (const [rule, hint] of Object.entries(ESLINT_REMEDIATION_HINTS)) {
      out.push({ rule, length: hint.length });
    }
    console.log(JSON.stringify(out, null, 2));
    break;
  }
  default:
    console.error(`unknown mode: ${mode}`);
    process.exit(2);
}
