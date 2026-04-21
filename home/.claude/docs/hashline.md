# Hashline — Line Reference System

> Extracted from `~/.config/opencode/AGENTS.md` into a separately-loadable doc. The full reference is below; it is still auto-injected by the OpenCode runtime as a `<system-reminder>` when edits involve hashlines, so you'll usually have it in context even without reading this file directly. Read this file when you need to understand the edit protocol in isolation (e.g., writing a new tool that emits hashlines).


File contents are annotated with hashline prefixes in the format `#HL <line>:<hash>|<content>`.
The hash length adapts to file size: 3 chars for files ≤4096 lines, 4 chars for larger files.

### Example (small file, 3-char hashes):
```
function hello() {
  return "world";
}
```

### Example (large file, 4-char hashes):
```
import { useState } from 'react';

export function App() {
```

### How to reference lines

You can reference specific lines using their hash tags (e.g., `2:f1c` or `2:f12c`). When editing files, you may include or omit the hash prefixes — they will be stripped automatically.

### Edit operations using hash references

**Preferred tool-based edit (hash-aware):**
- Use the `hashline_edit` tool with refs like `startRef: "2:f1c"` and optional `endRef`.
- This avoids fragile old_string matching because edits are resolved by hash references.

**Replace a single line:**
- "Replace line 2:f1c" — target a specific line unambiguously

**Replace a block of lines:**
- "Replace block from 1:a3f to 3:0e7" — replace a range of lines

**Insert content:**
- "Insert after 3:0e7" — insert new lines after a specific line
- "Insert before 1:a3f" — insert new lines before a specific line

**Delete lines:**
- "Delete lines from 2:f1c to 3:0e7" — remove a range of lines

### Hash verification rules

- **Always verify** that the hash reference matches the current line content before editing.
- If a hash doesn't match, the file may have changed since you last read it — re-read the file first.
- Hash references include both the line number AND the content hash, so `2:f1c` means "line 2 with hash f1c".
- If you see a mismatch, do NOT proceed with the edit — re-read the file to get fresh references.

### File revision (`#HL REV:<hash>`)

- When files are read, the first line may contain a file revision header: `#HL REV:<8-char-hex>`.
- This is a hash of the entire file content. Pass it as the `fileRev` parameter to `hashline_edit` to verify the file hasn't changed.
- If the file was modified between read and edit, the revision check fails with `FILE_REV_MISMATCH` — re-read the file.

### Safe reapply (`safeReapply`)

- Pass `safeReapply: true` to `hashline_edit` to enable automatic line relocation.
- If a line moved (e.g., due to insertions above), safe reapply finds it by content hash.
- If exactly one match is found, the edit proceeds at the new location.
- If multiple matches exist, the edit fails with `AMBIGUOUS_REAPPLY` — re-read the file.

### Structured error codes

- `HASH_MISMATCH` — line content changed since last read
- `FILE_REV_MISMATCH` — file was modified since last read
- `AMBIGUOUS_REAPPLY` — multiple candidate lines found during safe reapply
- `TARGET_OUT_OF_RANGE` — line number exceeds file length
- `INVALID_REF` — malformed hash reference
- `INVALID_RANGE` — start line is after end line
- `MISSING_REPLACEMENT` — replace/insert operation without replacement content

### Best practices

- Use hash references for all edit operations to ensure precision.
- When making multiple edits, work from bottom to top to avoid line number shifts.
- For large replacements, use range references (e.g., `1:a3f to 10:b2c`) instead of individual lines.
- Use `fileRev` to guard against stale edits on critical files.
- Use `safeReapply: true` when editing files that may have shifted due to earlier edits.
