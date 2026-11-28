Performs exact string replacements in files. Two modes.

### Hashline (preferred) — `input` parameter

Self-contained patch anchored on the Read tool's `[path#TAG]` header:

```
[path#A1B2]
replace 3..4:
+   const x = 1
+   return x
insert before 9:
+ new line
delete 12..15
```

- Line numbers are 1-indexed from the Read output, and every operation in one call refers to the original file (operations apply bottom-up, so earlier numbers stay valid).
- Body lines start with `+ `. That first space is the separator, not content: a line needing N leading spaces takes N+1 spaces after the `+`. Miscounting shifts the whole line and still reports success.
- `replace 7..7` replaces a single line.
- TAG is a content hash. On mismatch the error returns the current content and its new TAG — rebuild the patch from that and retry directly; re-read only when no content came back.

### Classic — `filePath` + `oldString` + `newString`

- Requires a prior Read in this session.
- Match the exact text after the `<line>: ` prefix; never include the prefix itself.
- A miss returns a fuzzy-match suggestion — adjust from it rather than guessing again.
- If `oldString` appears multiple times, add surrounding context or set `replaceAll`.
- Prefer editing existing files; never create new files unless required.
