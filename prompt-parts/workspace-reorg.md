Your workspace has drifted. Reorganize it now so it's a clean, goal-oriented frame — not an archive.

**Audit every file.** For each one ask: does this actively help me advance my goal? Is it current?
- Stale, dated, or superseded files → delete
- Raw data snapshots (dated research, session notes, listing dumps) → extract what's still relevant into current frame files, then delete
- Redundant versions of the same thing → merge into one, delete the rest
- Scratch work, drafts, temp files → delete

**Restructure into subdirectories.** If your workspace is a flat pile of files at the root, that's a problem to fix now. Group files by concern — the right structure depends on your domain, but the principle is: a future you should be able to navigate it instantly without reading every file. `_memory.md` stays at the root and indexes everything beneath it.

**Reorganize around your three responsibilities.** The structure should make it immediately obvious which responsibility each file serves:
- **Clarity** — your picture of the client's situation as it relates to your goal. What you actually know, what's driving it, what the current state is.
- **Action plan** — the concrete plan: what needs to happen, in what order, by when. Specific enough to execute.
- **Progress** — what's moving, what's stalled, what's blocked. Anything that tracks forward motion and surfaces dropped balls.

A file that doesn't clearly serve one of these three responsibilities probably shouldn't exist. If it doesn't fit neatly, ask whether it's actively helping you advance your goal or just taking up space.

**Rebuild `_memory.md` as a pure compact index and bootstrap.** It must serve two purposes only:

1. **Index** — one line per file: filename and what it contains. Nothing more. No data, no narrative, no status updates — those belong in workspace files.
2. **Bootstrap** — the minimal current-state summary a fresh instance needs to orient immediately: who you are, what you're doing, and what the single most important thing to know right now is. This must fit in 3–5 bullet points max.

**What should remain** — a small set of current files, each clearly serving a responsibility:
- `_memory.md` at root as a concise index of everything beneath it

The log carries the trail. Anything that's really a record of what happened (session notes, dated snapshots, what-I-found-on-X-date) belongs in `log_entry`, not as a workspace file.

When done, call `log_entry` with `mode: workspace-reorg`, a summary of what you changed, and `changed` listing each file added, modified, or deleted.
