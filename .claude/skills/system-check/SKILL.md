---
description: System health check for the agent fleet — tools, triggers, prompts, thrashing, information flow
---

System health check for the agent fleet. Collect the data below, then produce a structured diagnostic report. Every finding should be framed as a system issue with a probable cause and a concrete fix — not a behavioral observation.

The expectations this check must satisfy are defined in `SPEC.md` alongside this file.

## Data collection

**1. Run volume per agent (last 48h)**
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

**2. Tool errors (last 10 runs per agent)**
!`python3 -c "
import json, glob, os
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
found = False
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)[:10]
    for f in files:
        try:
            r = json.load(open(f))
        except: continue
        turns = r.get('turns', [])
        for i, turn in enumerate(turns):
            content = turn.get('content')
            if not isinstance(content, list): continue
            for block in content:
                if not isinstance(block, dict): continue
                if block.get('type') != 'tool_result': continue
                rc = block.get('content', '')
                text = rc if isinstance(rc, str) else json.dumps(rc)
                if 'error' in text.lower():
                    tool_name = '?'
                    for b in content:
                        if isinstance(b, dict) and b.get('type') == 'tool_use':
                            tool_name = b.get('name', '?')
                    snippet = text[:150].replace('\n', ' ')
                    print(f'  [{agent}] {r[\"mode\"]} / {tool_name}: {snippet}')
                    found = True
if not found:
    print('  (no tool errors detected)')
" 2>/dev/null || echo "(error scanning runs)"`

**3. Token spend — non-chat runs (last 48h)**
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
        turns = len(r.get('turns', []))
        if tok == 0: continue
        flag = '  *** BLOATED' if tok > 15000 else ''
        rows.append((tok, f'  {agent:<28} {r[\"mode\"]:<30} {tok:>7} tokens  {turns} turns{flag}'))
rows.sort(reverse=True)
for _, line in rows[:30]:
    print(line)
if not rows:
    print('  (no token data available)')
" 2>/dev/null || echo "(error)"`

**4. Thrashing — high-turn runs with no state change (last 48h)**
!`python3 -c "
import json, glob, os, time
from collections import Counter
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
            all_tool_calls = [tc.get('name','?') for t in turns for tc in (t.get('tool_calls') or [])]
            tool_counts = Counter(all_tool_calls)
            top_tools = ', '.join(f'{n}x{t}' for t,n in tool_counts.most_common(5))
            print(f'  [{agent}] {r[\"mode\"]} — {len(turns)} turns, no state change')
            print(f'    tools: {top_tools}')
            print(f'    result: {result[:120]}')
            found = True
if not found:
    print('  (no thrashing detected)')
" 2>/dev/null || echo "(error)"`

**5. Per-agent tool usage (last 10 runs)**
!`python3 -c "
import json, glob, os
from collections import Counter
agents_dir = '.user-data/agents'
agents = sorted(os.listdir(agents_dir)) if os.path.isdir(agents_dir) else []
for agent in agents:
    runs_dir = f'{agents_dir}/{agent}/runs'
    if not os.path.isdir(runs_dir): continue
    files = sorted(glob.glob(f'{runs_dir}/*.json'), reverse=True)[:10]
    counts = Counter()
    for f in files:
        try:
            r = json.load(open(f))
        except: continue
        for turn in r.get('turns', []):
            for tc in (turn.get('tool_calls') or []):
                counts[tc.get('name','?')] += 1
    if not counts: continue
    top = ', '.join(f'{n}x{t}' for t,n in counts.most_common(10))
    print(f'  {agent}: {top}')
" 2>/dev/null || echo "(error)"`

**6. Task health**
!`python3 -c "
import json, time, datetime
try:
    tasks = json.load(open('.user-data/tasks.json'))
except:
    print('(no tasks.json)'); exit()
now = int(time.time())

overdue = [t for t in tasks if t.get('due_at', now+1) < now and not t.get('last_run')]
frequent = [t for t in tasks if (t.get('cadence_hours') or 999) <= 2]
print('--- OVERDUE (due passed, never run) ---')
for t in sorted(overdue, key=lambda x: x.get('due_at',0)):
    due = datetime.datetime.fromtimestamp(t['due_at']).strftime('%b %d %H:%M')
    print(f'  [{t.get(\"assignee\",\"?\")}] {t[\"name\"][:50]}  due {due}')
if not overdue: print('  (none)')

print('--- VERY FREQUENT (cadence <= 2h) ---')
for t in frequent:
    print(f'  [{t.get(\"assignee\",\"?\")}] {t[\"name\"][:50]}  every {t[\"cadence_hours\"]}h')
if not frequent: print('  (none)')
" 2>/dev/null || echo "(error)"`

**7. Workspace & reconciliation health**
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
import os, time, glob
now = time.time()
topics_dir = '.user-data/topics'
cursors_dir = f'{topics_dir}/.cursors'

feed_path = f'{topics_dir}/feed.md'
feed_entries = 0
if os.path.exists(feed_path):
    content = open(feed_path).read()
    feed_entries = len([e for e in content.split('\n---\n\n') if e.strip()])

print(f'--- FEED TOPIC ---')
print(f'  Total entries: {feed_entries}')
print()
print('--- CURSOR PER AGENT ---')
if not os.path.isdir(cursors_dir):
    print('  (no cursors directory)')
else:
    for agent_dir in sorted(os.listdir(cursors_dir)):
        agent_cursor_path = os.path.join(cursors_dir, agent_dir)
        if not os.path.isdir(agent_cursor_path): continue
        feed_cursor_file = os.path.join(agent_cursor_path, 'feed')
        if os.path.exists(feed_cursor_file):
            ts = open(feed_cursor_file).read().strip()
            print(f'  {agent_dir:<28} feed cursor: {ts}')
        else:
            print(f'  {agent_dir:<28} feed cursor: (none — never read)')

print()
print('--- UNREAD BROADCASTS ---')
broadcast_path = f'{topics_dir}/broadcast.md'
if not os.path.exists(broadcast_path):
    print('  (no broadcast topic)')
else:
    content = open(broadcast_path).read()
    entries = [e for e in content.split('\n---\n\n') if e.strip()]
    print(f'  Total broadcast entries: {len(entries)}')
    for entry in entries[-3:]:
        lines = entry.strip().split('\n')
        print(f'    {lines[0][:80]}')
" 2>/dev/null || echo "(error)"`

**9. Log trail coverage (last 48h)**
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
    chat_logged = chat_total = bg_logged = bg_total = 0
    for f in files:
        ts = int(os.path.basename(f).split('_')[0]) / 1000
        if ts < cutoff: break
        try:
            r = json.load(open(f))
        except: continue
        mode = r.get('mode', '')
        all_tool_calls = [tc.get('name') for t in r.get('turns',[]) for tc in (t.get('tool_calls') or [])]
        logged = 'log_entry' in all_tool_calls
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

**10. Agent system feedback (new since last check)**
!`bun -e "
import { AgentTopics } from './packages/server/src/agentfleet/tools/agent-topics.js';
const topics = new AgentTopics();
const result = topics.readTopic('analyze_fleet_skill', 'system_feedback', true);
if (!result.messages || result.messages.length === 0) {
  console.log('  (no new system_feedback since last fleet check)');
} else {
  for (const m of result.messages) {
    console.log('## ' + m.timestamp + ' | ' + m.from);
    console.log('');
    const lines = m.message.split('\n');
    for (const line of lines) {
      if (line === '---') break;
      console.log(line);
    }
    console.log('');
  }
}
" 2>/dev/null || echo "(error reading system_feedback)"`

---

## Analysis

Using the data above, produce a structured system diagnostic. Every section is a system check — objective, factual, with a probable cause and concrete fix for each issue found. No behavioral judgments.

### Tool Errors & Missing Tools
Which tools are erroring and why? Is any agent attempting to call a tool not in its tool list (prompt/config mismatch)? Cross-reference the tool usage data (section 5) with errors (section 2) — if a tool appears in errors but not in usage, the agent is being blocked before it can call it. If a tool is in errors but does appear in usage, the tool implementation is broken.

### Thrashing
For each thrashing run (section 4), identify the probable system cause: missing tool forcing retry loops, over-frequent trigger producing no-op runs, broken prompt instructing impossible actions, or message history growing too large. The tool usage breakdown (section 4's tool list + section 5) is the primary signal — repeated calls to the same tool with no state change points to a specific broken tool or missing capability.

### Trigger & Cadence Issues
Are triggers firing at the right frequency? Any duplicate fires (same task dispatched twice)? Any tasks never running despite being created? Reconcile task cadence against actual run volume from section 1.

### Token Bloat
Which runs are spending disproportionate tokens? Cross-reference turn count (section 3) with thrashing (section 4) — bloat caused by thrashing has a system fix. Bloat from high turn counts with real output may indicate prompt verbosity or large file reads.

### Workspace Health
Is reconcile running on cadence? Are workspace files being updated? Stale workspaces (>12h) combined with low log trail coverage suggests the reconcile prompt is broken or the agent is consistently finding nothing to do (trigger frequency issue).

### Information Flow
Are agents reading the feed? Any agent with no cursor or a stale cursor is missing inter-agent coordination signals. Flag agents that have never consumed the feed.

### Log Trail Gaps
Agents below 70% background coverage have a system issue — either the prompt doesn't instruct logging, or runs are erroring before the log_entry call. Chat coverage below 30% over many sessions suggests the chat prompt isn't instructing substantive logging.

### Agent Feedback
Summarize new feedback from section 10. Group by category (tool / trigger / prompt / capability). Each item should map to a specific system fix.

### System Fixes Required
Up to 5 concrete fixes, ranked by impact. Be specific: name the file, the tool, the agent, the line. Examples: "add `read_messages` to advisor's tool list in agents/advisor/agent.yml", "reduce relocation reconcile cadence from 4h to 12h in tasks.json", "fix reconcile-workspace.md prompt reference to nonexistent `write_session_summary`".
