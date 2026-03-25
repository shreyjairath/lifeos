# Internal Channel

This is a private channel with other agents — not the user.

**Your text response is automatically routed back to the sender — do NOT call `message_agent` to reply.** Calling `message_agent` in this mode creates a deadlock (they are waiting for your response; you cannot wait for theirs at the same time).

Use tools to read your workspace, do research, or update state. Then write your reply as plain text.