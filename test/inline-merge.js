#!/usr/bin/env node
//
// inline-merge.js — non-destructive merge of src (shipped) into dst (user).
//
// Policy (see AGENTS.md §"Rules when editing this repo" rule 4, and the plan at
// .agent/plans/worktree-trust-default.md §"File-level changes" > install.sh Change 2):
//
//   - Missing keys in dst → copy from src.
//   - Keys present in dst → preserved verbatim, never overwritten.
//   - Arrays: treated as leaves (user's array wins) EXCEPT the top-level `plugin` array,
//     which is unioned-by-value (src items not already in dst are appended).
//   - Scalar-vs-object collisions (user set a string where src ships an object):
//     user's scalar wins; a warning is emitted; no mutation.
//   - Scalar-vs-array collisions (user set scalar where src ships array): same —
//     user's scalar wins; warning emitted; no mutation.
//   - Parse failure on dst: exit 1, print location, no write.
//
// Transactional semantics (when additions > 0 and not dry-run):
//   1. fs.copyFileSync(dst, `${dst}.bak.${Date.now()}-${process.pid}`)
//   2. fs.writeFileSync(`${dst}.merge.tmp.${Date.now()}-${process.pid}`, JSON.stringify(merged, null, 2) + "\n")
//   3. fs.renameSync(tmp, dst)
//
// Exit codes:
//   0  — merge completed successfully (or dry-run printed plan, or scalar-collision-only)
//   1  — error (parse failure, missing argv, I/O failure)
//   42 — no merge needed (no additions, no warnings)
//
// Argv: node inline-merge.js <src> <dst> <dryRun0or1>

"use strict";

const fs = require("fs");
const path = require("path");

const [, , SRC, DST, DRY_RUN_FLAG] = process.argv;
const DRY_RUN = DRY_RUN_FLAG === "1";

if (!SRC || !DST) {
  process.stderr.write("usage: inline-merge.js <src> <dst> <dryRun0or1>\n");
  process.exit(1);
}

// The single union-allowlist: only these top-level keys get array-union treatment.
// All other arrays are leaves.
const UNION_ALLOWLIST = new Set(["plugin"]);

function isPlainObject(v) {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.prototype.toString.call(v) === "[object Object]"
  );
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Pretty-print a keypath for stderr messages. Uses dots between identifier-safe
// keys, ["..."] brackets for anything else. Arbitrary but consistent.
function fmtPath(parts) {
  return parts
    .map((p) => {
      if (/^[A-Za-z_$][\w$]*$/.test(p)) return p;
      return `["${p.replace(/"/g, '\\"')}"]`;
    })
    .reduce((acc, part) => {
      if (acc === "") return part;
      if (part.startsWith("[")) return acc + part;
      return acc + "." + part;
    }, "");
}

// The merge walk. Mutates `dst` in place.
//   additions: list of human-readable strings like 'added: permission.external_directory'
//   warnings: list of human-readable warnings (scalar-vs-object collisions)
function merge(src, dst, pathParts, additions, warnings) {
  if (!isPlainObject(src) || !isPlainObject(dst)) {
    // Top-level both must be objects. If called with mismatched types at the root,
    // that's the caller's bug — but downstream recursion guards it.
    return;
  }
  for (const key of Object.keys(src)) {
    const sv = src[key];
    const newPath = pathParts.concat([key]);
    const pathStr = fmtPath(newPath);

    if (!hasOwn(dst, key)) {
      // Missing in dst — always copy, regardless of type.
      dst[key] = deepClone(sv);
      additions.push(`added: ${pathStr}`);
      continue;
    }

    const dv = dst[key];

    if (isPlainObject(sv) && isPlainObject(dv)) {
      merge(sv, dv, newPath, additions, warnings);
      continue;
    }

    if (isPlainObject(sv) && !isPlainObject(dv)) {
      // Scalar-vs-object collision (or scalar-vs-array collision where src is an object but dv is not).
      warnings.push(
        `scalar-vs-object: user has non-object at ${pathStr} where we ship an object; not migrating. To adopt the object form, replace it manually with: ${JSON.stringify(
          sv,
        )}`,
      );
      continue;
    }

    if (Array.isArray(sv)) {
      if (!Array.isArray(dv)) {
        warnings.push(
          `scalar-vs-array: user has non-array at ${pathStr} where we ship an array; not migrating. To adopt: replace it manually with: ${JSON.stringify(
            sv,
          )}`,
        );
        continue;
      }
      // Both arrays. Apply union rule only if keypath (joined by ".") is in allowlist.
      // Policy: allowlist is keyed by the full keypath joined with ".". Currently only
      // "plugin" (top-level) qualifies. Nested arrays never union.
      const joined = newPath.join(".");
      if (UNION_ALLOWLIST.has(joined)) {
        for (const item of sv) {
          // Deep-equality check for items — but in practice `plugin` entries are strings.
          // Use JSON.stringify as a cheap structural-equality proxy.
          const needle = JSON.stringify(item);
          const alreadyPresent = dv.some((x) => JSON.stringify(x) === needle);
          if (!alreadyPresent) {
            dv.push(deepClone(item));
            additions.push(`appended: ${pathStr}[${JSON.stringify(item)}]`);
          }
        }
      }
      // else: non-allowlisted array; dst wins verbatim. No action.
      continue;
    }

    // src is a scalar, dst has the key → user wins. No action.
  }
}

function deepClone(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

// --- main ---

let srcText;
let dstText;
try {
  srcText = fs.readFileSync(SRC, "utf8");
} catch (e) {
  process.stderr.write(`failed to read src: ${e.message}\n`);
  process.exit(1);
}
try {
  dstText = fs.readFileSync(DST, "utf8");
} catch (e) {
  process.stderr.write(`failed to read dst: ${e.message}\n`);
  process.exit(1);
}

let src;
try {
  src = JSON.parse(srcText);
} catch (e) {
  // Our shipped file should always be valid JSON. If it isn't, that's a repo bug.
  process.stderr.write(`SHIPPED CONFIG has invalid JSON at ${SRC}: ${e.message}\n`);
  process.exit(1);
}

let dst;
try {
  dst = JSON.parse(dstText);
} catch (e) {
  // User's file has a syntax error — DO NOT attempt repair. Surface the error
  // and exit 1 without touching the filesystem.
  process.stderr.write(`user opencode.json at ${DST} has invalid JSON: ${e.message}\n`);
  process.exit(1);
}

if (!isPlainObject(src) || !isPlainObject(dst)) {
  process.stderr.write(
    `merge requires both src and dst to be JSON objects at the top level. Got src=${typeof src}, dst=${typeof dst}.\n`,
  );
  process.exit(1);
}

const additions = [];
const warnings = [];
merge(src, dst, [], additions, warnings);

// Warnings (scalar collisions) always printed, regardless of dry-run vs write.
for (const w of warnings) {
  process.stderr.write(`WARN: ${w}\n`);
}

if (additions.length === 0) {
  // No additions. Distinguish two sub-cases so bash prints the right message:
  //   - warnings-only (scalar-vs-object collisions) → exit 0, no stdout.
  //     Bash sees bak_path=="" and prints "merge completed with warnings only".
  //   - truly nothing to do → exit 42 ("no merge needed").
  if (warnings.length > 0) {
    process.exit(0);
  }
  process.exit(42);
}

if (DRY_RUN) {
  for (const a of additions) {
    // `a` starts with "added: " or "appended: ". Reword to future-tense for dry-run.
    const future = a.replace(/^added: /, "would add: ").replace(/^appended: /, "would append: ");
    process.stderr.write(`[dry-run] ${future}\n`);
  }
  process.exit(0);
}

// Real write path. Backup → tempfile → rename, all in same directory as DST.
const suffix = `${Date.now()}-${process.pid}`;
const bakPath = `${DST}.bak.${suffix}`;
const tmpPath = `${DST}.merge.tmp.${suffix}`;

try {
  fs.copyFileSync(DST, bakPath);
} catch (e) {
  process.stderr.write(`failed to write backup ${bakPath}: ${e.message}\n`);
  process.exit(1);
}

const serialized = JSON.stringify(dst, null, 2) + "\n";

try {
  fs.writeFileSync(tmpPath, serialized);
} catch (e) {
  process.stderr.write(`failed to write tempfile ${tmpPath}: ${e.message}\n`);
  // Clean up backup on failure to avoid leaving orphaned .bak files.
  try {
    fs.unlinkSync(bakPath);
  } catch (_) {}
  process.exit(1);
}

try {
  fs.renameSync(tmpPath, DST);
} catch (e) {
  process.stderr.write(`failed to rename ${tmpPath} → ${DST}: ${e.message}\n`);
  try {
    fs.unlinkSync(tmpPath);
  } catch (_) {}
  try {
    fs.unlinkSync(bakPath);
  } catch (_) {}
  process.exit(1);
}

// Print summary to stdout — bash captures this to include in its own summary line.
for (const a of additions) process.stderr.write(`${a}\n`);
process.stdout.write(`${bakPath}\n`);
process.exit(0);
