---
description: Analyze recent agent runs across the fleet — tool errors, missed tasks, cadence issues, token bloat, thrashing
---

Analyze the agent fleet for health issues. Gather the data below, then produce a structured report.

## Data collection

**1. Recent run volume per agent (last 48h)**
!`python3 -c "
import json, glob, time, os
from collections import Counter
now = time.time()
cutoff = now - 48 * 3600
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)
    recent = []
    for f in files:
        ts = int(os.path.basename(f).split('_')[0]) / 1000
        if ts < cutoff: break
        try:
            r = json.load(open(f))
            recent.append(r)
        except: pass
    if not recent: continue
    modes = Counter(r.get('mode','?') for r in recent)
    mode_str = ', '.join(f'{v}x{k}' for k,v in modes.most_common())
    print(f'{agent:<28} {len(recent):>3} runs  [{mode_str}]')
" 2>/dev/null || echo "(no runs found)"`

**2. Tool errors across recent runs (last 5 per agent)**
!`python3 -c "
import json, glob, os, re
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
found = False
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)[:5]
    for f in files:
        try:
            r = json.load(open(f))
        except: continue
        for turn in r.get('turns', []):
            content = turn.get('content')
            if not isinstance(content, list): continue
            for block in content:
                if not isinstance(block, dict): continue
                if block.get('type') != 'tool_result': continue
                rc = block.get('content', '')
                text = rc if isinstance(rc, str) else json.dumps(rc)
                if 'error' in text.lower():
                    # Find the tool name from previous block
                    tool_name = '?'
                    prev = [b for b in content if b.get('type') == 'tool_use']
                    if prev: tool_name = prev[-1].get('name', '?')
                    snippet = text[:120].replace('\n', ' ')
                    print(f'  [{agent}] {tool_name}: {snippet}')
                    found = True
if not found:
    print('  (no tool errors detected)')
" 2>/dev/null || echo "(error scanning runs)"`

**3. Background run token spend (last 48h, non-chat)**
!`python3 -c "
import json, glob, time, os
now = time.time()
cutoff = now - 48 * 3600
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
rows = []
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)
    for f in files:
        ts = int(os.path.basename(f).split('_')[0]) / 1000
        if ts < cutoff: break
        try:
            r = json.load(open(f))
        except: continue
        if r.get('mode') == 'chat': continue
        tok = (r.get('inputTokens') or 0) + (r.get('outputTokens') or 0)
        if tok == 0: continue
        flag = '  *** BLOATED' if tok > 15000 else ''
        rows.append((tok, f'  {agent:<28} {r[\"mode\"]:<30} {tok:>6} tokens{flag}'))
rows.sort(reverse=True)
for _, line in rows[:30]:
    print(line)
if not rows:
    print('  (no token data available)')
" 2>/dev/null || echo "(error)"`

**4. Task health**
!`python3 -c "
import json, time, datetime
try:
    tasks = json.load(open('.user-data/tasks.json'))
except:
    print('(no tasks.json)'); exit()
now = int(time.time())

overdue = [t for t in tasks if t.get('due_at', now+1) < now and not t.get('last_run')]
frequent = [t for t in tasks if (t.get('cadence_hours') or 999) <= 2]
never_run = [t for t in tasks if not t.get('last_run') and t.get('created_at', now) < now - 48*3600]

print('--- OVERDUE (due passed, never run) ---')
for t in sorted(overdue, key=lambda x: x.get('due_at',0)):
    due = datetime.datetime.fromtimestamp(t['due_at']).strftime('%b %d %H:%M')
    print(f'  [{t.get(\"assignee\",\"?\")}] {t[\"name\"][:50]}  due {due}')
if not overdue: print('  (none)')

print('--- VERY FREQUENT (cadence <= 2h) ---')
for t in frequent:
    print(f'  [{t.get(\"assignee\",\"?\")}] {t[\"name\"][:50]}  every {t[\"cadence_hours\"]}h')
if not frequent: print('  (none)')

print('--- NEVER RUN (created > 48h ago) ---')
for t in never_run:
    created = datetime.datetime.fromtimestamp(t['created_at']).strftime('%b %d')
    print(f'  [{t.get(\"assignee\",\"?\")}] {t[\"name\"][:50]}  created {created}')
if not never_run: print('  (none)')
" 2>/dev/null || echo "(error)"`

**5. Agent-submitted system feedback**
!`python3 -c "
import re, os
f = '.user-data/topics/system_feedback.md'
if not os.path.exists(f):
    print('  (no system_feedback entries yet)')
else:
    content = open(f).read()
    entries = [e.strip() for e in content.split('\n---\n') if e.strip()]
    for entry in entries[-20:]:
        lines = entry.strip().split('\n')
        header = lines[0] if lines else ''
        body = '\n'.join(lines[2:]).strip()[:200] if len(lines) > 2 else ''
        print(f'{header}')
        if body: print(f'  {body[:150]}')
        print()
" 2>/dev/null || echo "(error)"`

**6. Thrashing detection (many turns, no apparent output)**
!`python3 -c "
import json, glob, os, time
now = time.time()
cutoff = now - 48 * 3600
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
found = False
state_keywords = ['updated', 'wrote', 'created', 'sent', 'logged', 'saved', 'deleted', 'completed', 'scheduled']
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)
    for f in files:
        ts = int(os.path.basename(f).split('_')[0]) / 1000
        if ts < cutoff: break
        try:
            r = json.load(open(f))
        except: continue
        turns = r.get('turns', [])
        if len(turns) < 8: continue
        result = (r.get('result') or '').lower()
        if not any(kw in result for kw in state_keywords):
            print(f'  [{agent}] {r[\"mode\"]} — {len(turns)} turns, result appears stateless')
            print(f'    result snippet: {result[:120]}')
            found = True
if not found:
    print('  (no thrashing detected)')
" 2>/dev/null || echo "(error)"`

---

## Analysis

Using the data above, produce a structured fleet health report with these sections:

### Tool Errors
Which tools are failing, what errors are they returning, and which agents are affected? Is any agent working around a broken tool (repeated retries, skipping tool use)?

### Overdue / Missed Tasks
Which tasks are past due and never executed? Is this a scheduling bug, or did the agent never get triggered?

### Cadence Issues
Any tasks running too often (wasteful) or cadences that seem mismatched with the agent's role?

### Token Bloat
Which background runs are spending disproportionate tokens? What's causing it — long system prompts, excessive tool calls, reading large files?

### Thrashing
Any agents looping through many turns without producing observable state change? What's the likely cause?

### Agent Feedback
Summarize what agents themselves have flagged via `system_feedback`. Group by severity and category. Highlight anything actionable.

### Recommended Actions
Up to 5 specific, concrete fixes — ranked by impact. Examples: "fix X tool's Y parameter", "reduce Z agent's reconcile cadence from 2h to 4h", "add N to agent's tool list". Be specific enough to act on immediately.
