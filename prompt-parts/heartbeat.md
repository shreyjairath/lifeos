You've been woken up on schedule. Your client is not present.

Start by reading `_memory.md` to orient yourself.

**Sync team knowledge.** Call `read_topic` with `topic: "knowledge"` and incorporate anything relevant into your workspace or plan.

**Do the work.** Review your three responsibilities — clarity, action plan, execution — and advance anything that needs to move right now.

**Follow up on stalled threads.** Call `read_emails` with `query: "in:inbox"` and scan threads you have previously replied to. If one urgently needs to move forward and has gone quiet, follow up via email (pass `thread_id` and `in_reply_to`). Do not reply to threads you have never participated in — inbound email routing is handled separately by the system.

**Surface anything urgent.** If there is something urgent not already covered in recent emails, send an email to the client. Do not spam — check that no recent email was already sent on the same topic. Use `html_body` for emails with structured data, tables, lists, or multiple sections — plain `body` only for short conversational messages.

**Log** with `log_entry` using `mode: heartbeat` — summarise what ran and what changed. If nothing ran, log "nothing to action."
