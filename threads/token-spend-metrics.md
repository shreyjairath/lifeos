# Token Spend Metrics

Tracked per snapshot. Run the script below to add a new entry.

```bash
cd /Users/shreyjairath/Projects/lifeos && python3 scripts/token-metrics.py
```

---

## Snapshots

### 2026-04-19 12:28 PDT — Baseline (pre-fix behavior, post-fix data just starting)

**24h window**
| Metric | Value |
|---|---|
| Total tokens | 307,928,186 |
| Input | 304,353,505 |
| Output | 3,574,681 |
| Runs | 423 |
| Avg turns/run | 53.2 |
| p90 turns | 81 |
| Max turns | 81 |

**Top agents (24h)**
| Agent | Input | Output | Runs |
|---|---|---|---|
| nishant/cos | 48,740,597 | 434,770 | 55 |
| akanksha/resume_writer | 35,811,807 | 444,456 | 58 |
| akanksha/cos | 29,295,125 | 319,929 | 33 |
| nishant/technical_automation | 28,249,562 | 418,491 | 39 |
| akanksha/linkedin_specialist | 22,718,454 | 374,426 | 39 |
| akanksha/career_coach | 19,151,207 | 280,578 | 41 |
| shrey/chicago_childcare | 16,322,654 | 138,541 | 18 |
| shrey/portfolio | 15,956,871 | 187,798 | 22 |
| akanksha/advisor | 13,875,003 | 143,579 | 21 |
| shrey/dating_coach | 13,222,387 | 100,784 | 15 |

**Notes:** Fixes deployed this morning — basic toolkit expanded, prompt rewritten, tool descriptions updated. p90 and max both at 81 (the executor turn cap). 24h window still dominated by pre-fix runs.

---
