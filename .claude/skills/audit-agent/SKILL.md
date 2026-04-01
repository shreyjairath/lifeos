---
description: Audit an agent's run logs and evaluate how well it's functioning
argument-hint: <agent-name>
---

Audit agent `$ARGUMENTS` and evaluate how well it's functioning.

## Step 1 — Gather data

Recent run records (newest first):
!`ls -t .user-data/agents/$ARGUMENTS/runs/ 2>/dev/null | head -10`

Mode distribution and token stats from last 10 runs:
!`python3 -c "
import json, glob
runs_dir = '.user-data/agents/$ARGUMENTS/runs'
files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)[:10]
for f in files:
    r = json.load(open(f))
    tool_turns = sum(1 for turn in r.get('turns',[]) if turn.get('tool_calls'))
    print(f'{r[\"mode\"][:40]:<42} {r[\"input_tokens\"]:>6}in {r[\"output_tokens\"]:>5}out  {r.get(\"duration_ms\",0)//1000}s  tool_turns={tool_turns}')
" 2>/dev/null || echo "(no runs found)"`

Tool usage breakdown across last 10 runs:
!`python3 -c "
import json, glob
from collections import Counter
runs_dir = '.user-data/agents/$ARGUMENTS/runs'
files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)[:10]
counts = Counter()
for f in files:
    r = json.load(open(f))
    for turn in r.get('turns', []):
        for tc in turn.get('tool_calls', []):
            counts[tc['function']['name']] += 1
for name, n in counts.most_common(15):
    print(f'  {n:>3}x  {name}')
" 2>/dev/null || echo "(no data)"`

Recent log entries (last 60 lines):
!`tail -60 .user-data/agents/$ARGUMENTS/workspace/_log.md 2>/dev/null || echo "(no log)"`

Workspace index:
!`cat .user-data/agents/$ARGUMENTS/workspace/_memory.md 2>/dev/null || echo "(no _memory.md)"`

Workspace files:
!`ls -lh .user-data/agents/$ARGUMENTS/workspace/ 2>/dev/null | grep -v "^total" || echo "(no workspace)"`

Agent goal:
!`python3 -c "
import re, pathlib
for base in ['.user-data/agents', 'src/main/resources/agents']:
    p = pathlib.Path(f'{base}/$ARGUMENTS/agent.yml')
    if p.exists():
        text = p.read_text()
        goal = re.search(r'^goal:\s*(.+)', text, re.M)
        manager = re.search(r'^manager:\s*(.+)', text, re.M)
        print('goal:', goal.group(1).strip() if goal else '(none)')
        print('manager:', manager.group(1).strip() if manager else '(none — reports to client)')
        break
else:
    print('(agent.yml not found)')
" 2>/dev/null || echo "(agent.yml not found)"`

Recent tasks:
!`python3 -c "
import json, time
try:
    tasks = json.load(open('.user-data/tasks.json'))
except:
    print('(no tasks.json)'); exit()
agent_tasks = [t for t in tasks if t.get('assignee') == '$ARGUMENTS']
now = int(time.time())
for t in sorted(agent_tasks, key=lambda x: x.get('last_modified_at', 0), reverse=True)[:8]:
    due = t.get('due_at', 0)
    last = t.get('last_run')
    status = 'done' if last else ('OVERDUE' if due <= now else 'pending')
    print(f'  [{status}] {t[\"name\"][:45]}')
" 2>/dev/null || echo "(no tasks)"`

## Step 2 — Evaluate

Using the data gathered above, produce a structured evaluation:

### Run Health
- How many runs in the last 24–48h, and is the frequency appropriate for this agent's role?
- Mode distribution: is there the right mix of chat, heartbeat, self-eval, post-session?
- Token spend per background run: lean (< 5k tokens) or bloated?
- Any signs of thrashing — many short runs, repeated tool calls yielding no state change?

### Three Responsibilities
Rate each **strong / partial / weak / missing**:
- **Clarity** — does the workspace contain a clear, current model of the client's situation as it relates to the agent's goal? Is `_memory.md` an accurate index or stale?
- **Action plan** — is there a concrete, current plan — specific tasks, order, timelines — specific enough to execute?
- **Progress tracking** — is there evidence of forward motion? Are blockers named and owned? Any dropped balls visible?

### Tool Behavior
- Are tools being called purposefully, or scattered without clear intent?
- Any tool being called repeatedly with no state change (thrashing)?
- Any tools conspicuously absent that this agent should be using?

### Log Quality
- Are log entries substantive — recording decisions and *why*, not just summaries of nothing?
- Is the agent logging correctly in background modes?
- Any pattern of rationalizing away work (repeated "no action needed", skipping tasks with excuses)?

### Task Execution
- Are overdue tasks being picked up and completed?
- Are the tasks on the board appropriate for this agent's domain and goal?

### Red Flags
List any specific concerning patterns — skip nothing.

### Overall Verdict
One sentence: how well is this agent functioning against its goal and three responsibilities?

### Recommended Actions
Up to 3 specific, actionable improvements (e.g., update a prompt, fix workspace structure, rewrite the goal, adjust task cadence).
