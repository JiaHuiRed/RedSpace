Read the current session's task list from persistent storage. Use after compaction or a reset to restore what is done and what remains, or when the list is no longer visible in the conversation.

Returns every todo with `content`, `status`, `priority`, and optional `id`/`parent_id`, plus a summary of totals.
