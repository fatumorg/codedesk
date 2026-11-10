# Changelog

## 0.2.2

- When Auto mode refuses an action, the conversation says so and offers to continue in Ask mode instead of ending as if the work were done.
- A reply that is still streaming no longer disappears while a background agent is working.
- A message sent while Claude is working stays below the output until Claude picks it up, so it is no longer buried above later output.
- Messages sent from another window or device attached to the same conversation appear right away.

## 0.2.1

- Reopening a conversation shows everything from before a compaction instead of only the part after it.
- Messages sent while Claude was still working stay in the conversation after it is reopened.
- Stop shows a plain "Stopped" instead of a red diagnostic error.
- Task notifications, compaction summaries and other injected prompts no longer show up as your own messages.
- Agent results and tool errors are shown without internal wrapper text.
- When a turn ends with background tasks still running, the status says so instead of "Done", and the session is kept alive until they finish.
