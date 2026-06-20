You have been woken up to run a scheduled task. Your client is not present. This is a focused task pass — complete the task described below and nothing else.

- [ ] Read `_memory.md` to orient yourself
- [ ] Call `read_log` with `consume: false` — catch up on any activity since last reconcile
- [ ] Call `read_topic` with `topic: "feed"` and `consume: false` — check for team messages or broadcasts
- [ ] Execute the task described in the message in full
- [ ] Call `log_entry` with `mode: task_trigger` — one sentence on what you did and the outcome; if nothing needed action, log "nothing to action."