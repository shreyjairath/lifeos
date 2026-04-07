---
description: Analyze recent agent runs across the fleet — tool errors, missed tasks, cadence issues, token bloat, thrashing, workspace reconciliation health, information flow
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

**7. Workspace reconciliation health**
!`python3 -c "
import json, glob, os, time, datetime
now = time.time()
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []

print('--- RECONCILE_WORKSPACE CADENCE ---')
try:
    tasks = json.load(open('.user-data/tasks.json'))
except:
    tasks = []

for agent in agents:
    agent_tasks = [t for t in tasks if t.get('assignee') == agent and 'reconcile_workspace' in t.get('name','')]
    for t in agent_tasks:
        last = t.get('last_run')
        due = t.get('due_at', 0)
        cadence = t.get('cadence_hours', '?')
        last_str = datetime.datetime.fromtimestamp(last).strftime('%b %d %H:%M') if last else 'NEVER'
        overdue_by = max(0, now - due) / 3600 if due else 0
        flag = f'  *** OVERDUE by {overdue_by:.1f}h' if overdue_by > 1 else ''
        print(f'  {agent:<28} last={last_str}  cadence={cadence}h{flag}')

print()
print('--- WORKSPACE FILE FRESHNESS ---')
for agent in agents:
    ws = f'{agents_dir}/{agent}/workspace'
    if not os.path.isdir(ws): continue
    files = glob.glob(f'{ws}/**/*', recursive=True) + glob.glob(f'{ws}/*')
    files = [f for f in files if os.path.isfile(f)]
    if not files:
        print(f'  {agent:<28} workspace empty')
        continue
    newest = max(os.path.getmtime(f) for f in files)
    age_h = (now - newest) / 3600
    flag = '  *** STALE (>12h)' if age_h > 12 else ''
    newest_str = datetime.datetime.fromtimestamp(newest).strftime('%b %d %H:%M')
    print(f'  {agent:<28} newest file: {newest_str}  ({age_h:.1f}h ago){flag}')
" 2>/dev/null || echo "(error)"`

**8. Information flow (feed cursors and inbox health)**
!`python3 -c "
import os, re, time, datetime, glob
now = time.time()
topics_dir = '.user-data/topics'
cursors_dir = f'{topics_dir}/.cursors'

feed_path = f'{topics_dir}/feed.md'
feed_entries = 0
if os.path.exists(feed_path):
    content = open(feed_path).read()
    feed_entries = len([e for e in content.split('\n---\n') if e.strip()])

print(f'--- FEED TOPIC ---')
print(f'  Total entries: {feed_entries}')

print()
print('--- CURSOR ADVANCEMENT PER AGENT ---')
if not os.path.isdir(cursors_dir):
    print('  (no cursors directory)')
else:
    for cursor_file in sorted(glob.glob(f'{cursors_dir}/*.json')):
        try:
            import json
            c = json.load(open(cursor_file))
            agent = os.path.basename(cursor_file).replace('.json','')
            feed_pos = c.get('feed', 0)
            broadcast_pos = c.get('broadcast', 0)
            total = max(feed_pos, 1)
            pct = int(100 * feed_pos / max(feed_entries, 1))
            flag = '  *** BEHIND' if feed_entries > 0 and pct < 50 else ''
            print(f'  {agent:<28} feed={feed_pos}/{feed_entries} ({pct}%)  broadcast={broadcast_pos}{flag}')
        except Exception as e:
            print(f'  {os.path.basename(cursor_file)}: error reading cursor')

print()
print('--- UNREAD BROADCASTS ---')
broadcast_path = f'{topics_dir}/broadcast.md'
if not os.path.exists(broadcast_path):
    print('  (no broadcast topic)')
else:
    content = open(broadcast_path).read()
    entries = [e for e in content.split('\n---\n') if e.strip()]
    total_broadcasts = len(entries)
    print(f'  Total broadcast entries: {total_broadcasts}')
    # Last 3
    for entry in entries[-3:]:
        lines = entry.strip().split('\n')
        print(f'    {lines[0][:80]}')
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

**9. Log entry trail coverage (last 48h)**
!`python3 -c "
import json, glob, os, time
now = time.time()
cutoff = now - 48 * 3600
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []

for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)

    chat_logged = chat_total = 0
    bg_logged = bg_total = 0

    for f in files:
        ts = int(os.path.basename(f).split('_')[0]) / 1000
        if ts < cutoff: break
        try:
            r = json.load(open(f))
        except: continue
        mode = r.get('mode', '')
        turns = r.get('turns', [])
        tool_calls = [tc.get('name') for t in turns if t.get('role') == 'assistant' for tc in (t.get('tool_calls') or [])]
        logged = 'log_entry' in tool_calls
        if mode == 'chat':
            chat_total += 1
            if logged: chat_logged += 1
        else:
            bg_total += 1
            if logged: bg_logged += 1

    if chat_total == 0 and bg_total == 0: continue
    chat_pct = int(100 * chat_logged / chat_total) if chat_total else 0
    bg_pct = int(100 * bg_logged / bg_total) if bg_total else 0
    chat_flag = '  *** LOW' if chat_total >= 3 and chat_pct < 30 else ''
    bg_flag = '  *** LOW' if bg_total >= 3 and bg_pct < 70 else ''
    print(f'  {agent:<28} chat={chat_logged}/{chat_total} ({chat_pct}%){chat_flag}   bg={bg_logged}/{bg_total} ({bg_pct}%){bg_flag}')
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

### Workspace Reconciliation Health
Is `reconcile_workspace` running on the expected 4h cadence for each agent? Are workspace files being updated (modification timestamps within the last 12h)? Flag any agents with stale workspaces or missed reconciliation runs.

### Information Flow
Are feed cursors advancing for all agents? Any agents significantly behind on the feed (reading <50% of entries)? Are broadcasts being picked up? Identify agents that appear to be ignoring their inbox or whose cursors haven't moved.

### Log Entry Trail
For non-chat runs: are agents consistently calling `log_entry`? Flag any agent below 70% coverage — background runs should always leave a trail. For chat runs: flag agents below 30% — the bar is lower since agents should skip if nothing substantive surfaced, but zero over many sessions is a red flag.

### Agent Feedback
Summarize what agents themselves have flagged via `system_feedback`. Group by severity and category. Highlight anything actionable.

### Recommended Actions
Up to 5 specific, concrete fixes — ranked by impact. Examples: "fix X tool's Y parameter", "reduce Z agent's reconcile cadence from 2h to 4h", "add N to agent's tool list". Be specific enough to act on immediately.
