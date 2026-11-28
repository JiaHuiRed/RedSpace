Read a file or directory from the local filesystem.

- `filePath` is absolute. Defaults to the first 2000 lines; continue later sections with `offset` (1-indexed).
- Output lines are prefixed `<line>: <content>`; lines over 2000 characters are truncated.
- Directories list one entry per line, with a trailing `/` on subdirectories.
- Use grep for specific content or long lines, glob when the path is unknown.
- Batch parallel reads instead of tiny repeated slices (30-line chunks) — read a larger window.
- Images and PDFs come back as attachments.
- TS/JS, Python, Go, Rust output includes a `<snippets>` section; re-read one symbol with the `snippet` tool.
