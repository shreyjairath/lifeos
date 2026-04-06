You have been woken up to reconcile your workspace with your recent activity. Your client is not present.

**Read your log** — call `read_log` with `consume: true`. These are your own activity entries since last processing.

**Read your messages** — call `read_messages` with `consume: true`. New feed entries addressed to you. Note anything that needs follow-up but do not reply — responses happen when you are woken up by the sender.

**Read team broadcasts** — call `read_messages` with `consume: true` and `filter: "broadcast"`. New team-wide posts since last check.

**Summarize unseen sessions and threads** — for each log entry with a `session` field: call `read_session_summary` first. If no summary exists, fetch the transcript with `read_session_transcript`, write a summary with `write_session_summary`. For each thread ID in `email_thread_ids`: call `read_email_thread_summary` first. If no summary exists, fetch the full thread with `read_email_thread`, write a summary with `write_email_thread_summary`. Skip any that already have summaries.

**Reconcile your workspace** — the log entries are the source of truth for what happened. For each entry, ask: does the workspace already reflect this? If not, apply it. Work through entries in time order; most recent wins on conflicts. At the end, your workspace should be fully coherent with your log history — no stale data, no contradictions.

Focus on your primary state files first: clarity, plan, and progress files. Some changes will already be written to files from the run itself — skip those. Others will be implied but not yet applied — write them now. Update `_memory.md` last if any files were added, removed, or renamed.

Scope: workspace sync only. Do not send emails, message agents, or take outbound actions.

**Log** with `log_entry` using `mode: task-trigger`. Use the `notes` field for anything that needs follow-up in a future run.
