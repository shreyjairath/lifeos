# system-check Spec

Expectations that the system-check skill must verify. Each item names the check, the data source, and the pass/fail condition.

---

## Run Volume

- Every active agent should have at least 1 run in the last 48h
  - *Source: section 1 (run volume per agent)*
  - *Fail: agent appears in agent list but has zero runs*

---

## Tool Errors

- No agent should have a tool error in its last 10 runs
  - *Source: section 2 (tool errors)*
  - *Fail: any tool result containing "error"*

---

## Token Bloat

- No non-chat run should exceed 15,000 tokens
  - *Source: section 3 (token spend)*
  - *Fail: any run flagged BLOATED*

---

## Thrashing

- No run should have 8+ turns with no state change
  - *Source: section 4 (thrashing)*
  - *Fail: any run matching high-turn + no state-change keywords*

---

## Task Health

- No task should be overdue (due_at passed, never run)
  - *Source: section 6 (task health — overdue)*
  - *Fail: any task in the OVERDUE list*

- No task should run more frequently than every 2h
  - *Source: section 6 (task health — very frequent)*
  - *Fail: any task with cadence_hours <= 2*

---

## Workspace Health

- Every agent's workspace should have been written to within the last 12h
  - *Source: section 7 (workspace file freshness)*
  - *Fail: newest file older than 12h*

---

## Information Flow

- Every agent should have a feed cursor (i.e. has consumed the feed at least once)
  - *Source: section 8 (cursor per agent)*
  - *Fail: agent listed with "(none — never read)"*

---

## Log Trail

- Every agent should call `log_entry` in at least 70% of background runs (over a window of 3+ runs)
  - *Source: section 9 (log trail coverage)*
  - *Fail: bg coverage flagged LOW*

- Every agent should call `log_entry` in at least 30% of chat runs (over a window of 3+ runs)
  - *Source: section 9 (log trail coverage)*
  - *Fail: chat coverage flagged LOW*
