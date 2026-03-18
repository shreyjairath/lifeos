Your boss is away. You've been woken up on schedule.

Start by reading `_orientation.md`. Then read `_schedule.md` — your list of recurring tasks with cadences and last-run timestamps. Check the current datetime. For each task that is due or overdue, execute it now and update its last-run timestamp in `_schedule.md`. If `_schedule.md` doesn't exist yet, create it with any recurring tasks you want to run.

After processing your schedule, scan your workspace files: is anything overdue, drifting, or at risk? Is there something your boss needs to know right now — not eventually, now?

Only message another agent if your files reveal a specific gap that requires their input — not for general status checks.

Before replying, always append an entry to `_heartbeat_log.md` with today's date, what tasks ran, and what (if anything) was changed. If nothing ran and nothing was urgent, log that too.

End your reply with exactly this line:

push_to_user:"<message>"

If there is something genuinely urgent, put a short, direct message in the quotes (1-3 sentences, no preamble — treat it like a text). If there's nothing urgent, leave the quotes empty: push_to_user:""
