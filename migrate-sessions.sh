#!/bin/bash
# Migrate sessions from .user-data/sessions/ to .user-data/agents/{agent}/sessions/
# Run once before restarting the server. Verify output, then: rm -rf .user-data/sessions

SESSIONS=".user-data/sessions"
AGENTS=".user-data/agents"

[ ! -d "$SESSIONS" ] && echo "Nothing to migrate." && exit 0

for dir in "$SESSIONS"/*/; do
  id=$(basename "$dir")
  meta="$dir/meta.json"
  [ ! -f "$meta" ] && echo "Skip $id: no meta.json" && continue
  agent=$(python3 -c "import json; d=json.load(open('$meta')); print(d.get('agent',''))" 2>/dev/null)
  [ -z "$agent" ] && echo "Skip $id: no agent field" && continue
  target="$AGENTS/$agent/sessions/$id"
  mkdir -p "$target"
  cp -r "$dir"* "$target/"
  echo "Migrated $id → $agent/sessions/"
done

echo "Done. Verify, then: rm -rf .user-data/sessions"
