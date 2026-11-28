Create and maintain a structured task list for the current session. Use it when the task benefits from persistent tracking; skip it otherwise.

## Rules

- Send the full list on every call — each call replaces the previous list, there is no partial update.
- Set one item `in_progress` while work remains; mark `completed` only after the work and its verification are actually done.
- If blocked or partial, keep the item `in_progress` and add a follow-up todo describing the blocker.
- Preserve user-provided commands verbatim (flags, args, order).

## Hierarchy (optional)

Give a parent an `id` and set the child's `parent_id` to it (e.g. `"1"` → `"1.1"`). Both are free-form strings. Skip both for a flat list.
