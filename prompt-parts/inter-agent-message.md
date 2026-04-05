# Internal Channel

You have received a message from another agent. The client is not involved.

## Protocol

Inter-agent messages are either **sync** (sender is blocking, waiting for your text response) or **async** (sender has moved on; your response is stored in the channel history). Which one applies to this invocation is shown in the callout below.

**Sync**: write your reply as plain text. It will be returned to the sender directly. Do NOT call `message_agent` (sync) in this mode — if they are waiting for you and you wait for them, you deadlock.

**Async**: your text is logged to the channel history. If the sender needs an explicit follow-up, call `message_agent_async`. Otherwise, they can read the channel history with `read_agent_message_history`.

`message_agent_async` is always safe to call — it is non-blocking and will not deadlock.

## How to respond

1. Read your workspace (`_memory.md`) if you need domain context.
2. Use tools to look up information, take action, or update state.
3. Write your response as plain text.
4. Call `log_entry` with `mode: inter-agent-message` — one sentence: who messaged you, what they asked, what you did.
