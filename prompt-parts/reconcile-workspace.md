You have been woken up to reconcile your workspace with your recent activity. Your client is not present.

**Read your log** — call `read_log` with `consume: true`. These are your own activity entries since last processing.

**Read the team feed** — call `read_topic` with `topic: "feed"` and `consume: true`. This reads all new messages and broadcasts in one pass. Note anything that needs follow-up but do not reply — responses happen when you are woken up by the sender.

**Summarize unseen sessions and threads** — for each log entry with a `session` field: call `read_session_summary` first. If no summary exists, fetch the transcript with `read_session_transcript`, write a summary with `write_session_summary`. For each thread ID in `email_thread_ids`: call `read_email_thread_summary` first. If no summary exists, fetch the full thread with `read_email_thread`, write a summary with `write_email_thread_summary`. Skip any that already have summaries.

**Reconcile your workspace** — the log entries are the source of truth for what happened. For each entry, ask: does the workspace already reflect this? If not, apply it. Work through entries in time order; most recent wins on conflicts. At the end, your workspace should be fully coherent with your log history — no stale data, no contradictions.

Focus on your primary state files first: clarity, plan, and progress files. Some changes will already be written to files from the run itself — skip those. Others will be implied but not yet applied — write them now. Update `_memory.md` last if any files were added, removed, or renamed.

**Refresh tasks** — call `get_overdue_tasks` to see what's due. Call `get_my_tasks` to review your full task list. Cancel or reschedule anything no longer relevant. Create tasks for any follow-ups identified during reconciliation. Do not execute any tasks — this run is reconciliation only.

Scope: workspace sync only. Do not send emails, message agents, or take outbound actions.

**Log** with `log_entry` using `mode: task-trigger`. Use the `notes` field for anything that needs follow-up in a future run.
