---
description: Prune agent run logs to the last 10 files per agent, across all clients
---

Prune run logs to the last 10 files per agent across all clients. Files are sorted by timestamp (filename prefix) — oldest are deleted first.

!`python3 -c "
import glob, os

base = '.user-data/clients'
keep = 10
total_deleted = 0

clients = sorted(os.listdir(base)) if os.path.isdir(base) else []
for client in clients:
    agents_dir = os.path.join(base, client, 'agents')
    if not os.path.isdir(agents_dir):
        continue
    for agent in sorted(os.listdir(agents_dir)):
        runs_dir = os.path.join(agents_dir, agent, 'runs')
        if not os.path.isdir(runs_dir):
            continue
        files = sorted(glob.glob(os.path.join(runs_dir, '*.json')))
        to_delete = files[:-keep] if len(files) > keep else []
        for f in to_delete:
            os.remove(f)
        if to_delete:
            print(f'  {client}/{agent}: deleted {len(to_delete)}, kept {min(len(files), keep)}')
        total_deleted += len(to_delete)

print(f'Done. {total_deleted} file(s) deleted.')
"`
