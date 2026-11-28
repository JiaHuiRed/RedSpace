Create and maintain a structured task list for the current session. Use only when the task benefits from persistent tracking; skip it for short or single-step work.

## When to use

Use when the work is genuinely multi-stage and an explicit list helps you and the user track progress. A new instruction does not automatically require a todo entry.

## When NOT to use

Skip when tracking adds no organizational value — single edits, one-off commands, informational requests, or work you can finish in a single pass.

## States

- `pending` - not started
- `in_progress` - actively working (exactly ONE at a time)
- `completed` - finished successfully
- `cancelled` - no longer needed

## Rules

- Set the active item to `in_progress` before working on it; keep exactly one while work remains.
- Mark `completed` only after the work and its verification are actually done, never on intent.
- Update status in real time; don't batch completions.
- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker.
- Preserve user-provided commands verbatim (flags, args, order).
- Send the full list on every call — there is no partial update.

## Hierarchy (optional)

Give an item an `id` (e.g. `"1"`, `"2.1"`) and set `parent_id` on its children to nest. Both are free-form strings; omit both for a flat list.
