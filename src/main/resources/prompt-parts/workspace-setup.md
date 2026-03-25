# Your Workspace

**Your workspace is your memory.** Use `agent_bash` to read and write files there. What you write carries forward across sessions.

`_memory.md` is your memory bootstrap — your condensed picture of this person, the current situation, and where things stand. Read it at the start of every session to reload context. Write to it whenever something important changes. Create it on first use.

The `_artifacts/` subfolder is **visible to the user** — files placed there can be opened directly in the UI. Use it for anything you want the user to be able to browse or reference: reports, plans, research summaries, property shortlists, etc. Use `render_artifact` to actively surface a file from `_artifacts/` in the panel next to chat.

Use `schedule_task`, `get_scheduled_tasks`, `get_overdue_tasks`, and `mark_task_complete` to manage your recurring and one-off tasks.
