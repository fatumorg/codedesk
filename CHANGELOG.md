# Changelog

## 0.2.1

- Reopening a conversation shows everything from before a compaction instead of only the part after it.
- Messages sent while Claude was still working stay in the conversation after it is reopened.
- Stop shows a plain "Stopped" instead of a red diagnostic error.
- Task notifications, compaction summaries and other injected prompts no longer show up as your own messages.
- Agent results and tool errors are shown without internal wrapper text.
- When a turn ends with background tasks still running, the status says so instead of "Done", and the session is kept alive until they finish.
