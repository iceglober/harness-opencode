/**
 * Non-destructive merge of a shipped source config into a user-owned
 * destination config. TypeScript port of test/inline-merge.js.
 *
 * Policy (see AGENTS.md rule 4):
 *   - Missing keys in dst → copy from src.
 *   - Keys present in dst → preserved verbatim, never overwritten.
 *   - Arrays: treated as leaves (user's array wins) EXCEPT the top-level
 *     `plugin` array, which is unioned-by-value (src items not already in
 *     dst are appended).
 *   - Scalar-vs-object collisions: user's scalar wins; a warning is emitted.
 *   - Parse failure on dst: throw without writing.
 *
 * Transactional semantics (when additions > 0):
 *   1. fs.copyFileSync(dst, `${dst}.bak.${Date.now()}-${pid}`)
 *   2. fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n")
 *   3. fs.renameSync(tmp, dst)
 *
 * Returns:
 *   { changed: true, bakPath: string }  — merge applied, backup written
 *   { changed: false }                  — no additions needed (no-op)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// The single union-allowlist: only these top-level keys get array-union treatment.
const UNION_ALLOWLIST = new Set(["plugin"]);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.prototype.toString.call(v) === "[object Object]"
  );
}

function deepClone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return (v as unknown[]).map(deepClone) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) {
    out[k] = deepClone((v as Record<string, unknown>)[k]);
  }
  return out as T;
}

function fmtPath(parts: string[]): string {
  return parts
    .map((p) => (/^[A-Za-z_$][\w$]*$/.test(p) ? p : `["${p.replace(/"/g, '\\"')}"]`))
    .reduce((acc, part) => {
      if (acc === "") return part;
      if (part.startsWith("[")) return acc + part;
      return acc + "." + part;
    }, "");
}

function mergeWalk(
  src: Record<string, JsonValue>,
  dst: Record<string, JsonValue>,
  pathParts: string[],
  additions: string[],
  warnings: string[],
): void {
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const newPath = pathParts.concat([key]);
    const pathStr = fmtPath(newPath);

    if (!Object.prototype.hasOwnProperty.call(dst, key)) {
      dst[key] = deepClone(sv);
      additions.push(`added: ${pathStr}`);
      continue;
    }

    const dv = dst[key];

    if (isPlainObject(sv) && isPlainObject(dv)) {
      mergeWalk(sv, dv, newPath, additions, warnings);
      continue;
    }

    if (isPlainObject(sv) && !isPlainObject(dv)) {
      warnings.push(
        `WARN: scalar-vs-object: user has non-object at ${pathStr} where we ship an object; not migrating. To adopt: ${JSON.stringify(sv)}`,
      );
      continue;
    }

    if (Array.isArray(sv)) {
      if (!Array.isArray(dv)) {
        warnings.push(
          `WARN: scalar-vs-array: user has non-array at ${pathStr} where we ship an array; not migrating. To adopt: ${JSON.stringify(sv)}`,
        );
        continue;
      }
      const joined = newPath.join(".");
      if (UNION_ALLOWLIST.has(joined)) {
        for (const item of sv) {
          const needle = JSON.stringify(item);
          const alreadyPresent = (dv as JsonValue[]).some(
            (x) => JSON.stringify(x) === needle,
          );
          if (!alreadyPresent) {
            (dv as JsonValue[]).push(deepClone(item));
            additions.push(`appended: ${pathStr}[${JSON.stringify(item)}]`);
          }
        }
      }
      // else: non-allowlisted array; dst wins verbatim.
      continue;
    }

    // src is scalar, dst has the key → user wins. No action.
  }
}

export type MergeResult =
  | { changed: true; bakPath: string; additions: string[]; warnings: string[] }
  | { changed: false; warnings: string[] };

/**
 * Merge `srcJson` (shipped defaults) into the file at `dstPath` (user config).
 *
 * @param srcJson  The shipped config object (already parsed).
 * @param dstPath  Absolute path to the user's config file.
 * @param dryRun   If true, compute the diff but do not write.
 */
export function mergeConfig(
  srcJson: Record<string, JsonValue>,
  dstPath: string,
  dryRun = false,
): MergeResult {
  let dstText: string;
  try {
    dstText = fs.readFileSync(dstPath, "utf8");
  } catch (e: any) {
    throw new Error(`Failed to read dst ${dstPath}: ${e.message}`);
  }

  let dst: Record<string, JsonValue>;
  try {
    dst = JSON.parse(dstText);
  } catch (e: any) {
    throw new Error(
      `User config at ${dstPath} has invalid JSON: ${e.message}. Not touching the file.`,
    );
  }

  if (!isPlainObject(dst)) {
    throw new Error(
      `User config at ${dstPath} is not a JSON object at the top level.`,
    );
  }

  const additions: string[] = [];
  const warnings: string[] = [];
  mergeWalk(srcJson, dst, [], additions, warnings);

  if (additions.length === 0) {
    return { changed: false, warnings };
  }

  if (dryRun) {
    return { changed: true, bakPath: "(dry-run)", additions, warnings };
  }

  // Transactional write: backup → tempfile → rename
  const suffix = `${Date.now()}-${process.pid}`;
  const bakPath = `${dstPath}.bak.${suffix}`;
  const tmpPath = `${dstPath}.merge.tmp.${suffix}`;

  try {
    fs.copyFileSync(dstPath, bakPath);
  } catch (e: any) {
    throw new Error(`Failed to write backup ${bakPath}: ${e.message}`);
  }

  const serialized = JSON.stringify(dst, null, 2) + "\n";

  try {
    fs.writeFileSync(tmpPath, serialized);
  } catch (e: any) {
    try { fs.unlinkSync(bakPath); } catch { /* ignore */ }
    throw new Error(`Failed to write tempfile ${tmpPath}: ${e.message}`);
  }

  try {
    fs.renameSync(tmpPath, dstPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(bakPath); } catch { /* ignore */ }
    throw new Error(`Failed to rename ${tmpPath} → ${dstPath}: ${e.message}`);
  }

  return { changed: true, bakPath, additions, warnings };
}

/**
 * Seed a new config file from the shipped defaults.
 * Used when the user has no opencode.json yet.
 */
export function seedConfig(
  srcJson: Record<string, JsonValue>,
  dstPath: string,
): void {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  fs.writeFileSync(dstPath, JSON.stringify(srcJson, null, 2) + "\n");
}
