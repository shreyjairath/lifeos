#!/usr/bin/env python3
"""
Token spend metrics snapshot — appends a new entry to threads/token-spend-metrics.md.
Run from project root: python3 scripts/token-metrics.py
"""
import json, os, glob, time, datetime, sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
DATA_ROOT = ROOT / '.user-data' / 'clients'
METRICS_FILE = ROOT / 'threads' / 'token-spend-metrics.md'


def analyze_window(hours: int) -> dict:
    now = int(time.time() * 1000)
    cutoff = now - hours * 3600 * 1000

    total_in = total_out = runs = 0
    by_agent: dict[str, list] = defaultdict(lambda: [0, 0, 0])  # in, out, runs
    turn_counts: list[int] = []

    for f in glob.glob(str(DATA_ROOT / '*/agents/*/runs/*.json')):
        ts = int(os.path.basename(f).split('_')[0])
        if ts < cutoff:
            continue
        try:
            d = json.load(open(f))
            inp = d.get('inputTokens', 0) or 0
            out = d.get('outputTokens', 0) or 0
            if inp == 0:
                continue
            parts = f.split('/')
            ci = parts.index('clients')
            client, agent = parts[ci + 1], parts[ci + 3]
            key = f"{client}/{agent}"
            total_in += inp
            total_out += out
            runs += 1
            by_agent[key][0] += inp
            by_agent[key][1] += out
            by_agent[key][2] += 1
            turn_counts.append(len(d.get('turns', [])))
        except Exception:
            pass

    turn_counts.sort()
    return {
        'total_in': total_in,
        'total_out': total_out,
        'runs': runs,
        'avg_turns': sum(turn_counts) / len(turn_counts) if turn_counts else 0,
        'p90_turns': turn_counts[int(len(turn_counts) * 0.9)] if turn_counts else 0,
        'max_turns': turn_counts[-1] if turn_counts else 0,
        'by_agent': dict(by_agent),
    }


def fmt(n: int) -> str:
    return f"{n:,}"


def main():
    now_dt = datetime.datetime.now()
    label = now_dt.strftime('%Y-%m-%d %H:%M PDT')

    m24 = analyze_window(24)
    m12 = analyze_window(12)

    top_agents = sorted(m24['by_agent'].items(), key=lambda x: -(x[1][0] + x[1][1]))[:10]

    note = input("Note for this snapshot (optional, press enter to skip): ").strip()

    entry = f"""
### {label}

**24h window**
| Metric | Value |
|---|---|
| Total tokens | {fmt(m24['total_in'] + m24['total_out'])} |
| Input | {fmt(m24['total_in'])} |
| Output | {fmt(m24['total_out'])} |
| Runs | {m24['runs']} |
| Avg turns/run | {m24['avg_turns']:.1f} |
| p90 turns | {m24['p90_turns']} |
| Max turns | {m24['max_turns']} |

**12h window**
| Metric | Value |
|---|---|
| Total tokens | {fmt(m12['total_in'] + m12['total_out'])} |
| Input | {fmt(m12['total_in'])} |
| Output | {fmt(m12['total_out'])} |
| Runs | {m12['runs']} |
| Avg turns/run | {m12['avg_turns']:.1f} |
| p90 turns | {m12['p90_turns']} |
| Max turns | {m12['max_turns']} |

**Top agents (24h)**
| Agent | Input | Output | Runs |
|---|---|---|---|
"""
    for k, v in top_agents:
        entry += f"| {k} | {fmt(v[0])} | {fmt(v[1])} | {v[2]} |\n"

    if note:
        entry += f"\n**Notes:** {note}\n"

    entry += "\n---\n"

    content = METRICS_FILE.read_text()
    # Insert after the header block (after the first ---)
    insert_at = content.index('\n---\n') + 5
    updated = content[:insert_at] + entry + content[insert_at:]
    METRICS_FILE.write_text(updated)

    print(f"\nSnapshot written to {METRICS_FILE.relative_to(ROOT)}")
    print(f"24h: {fmt(m24['total_in'] + m24['total_out'])} tokens across {m24['runs']} runs, avg {m24['avg_turns']:.1f} turns")


if __name__ == '__main__':
    main()
