# Optimizing Agent Costs

**Status:** Active  
**Started:** 2026-04-19

## Problem

Token spend is very high — 108M tokens in a 12h window across all clients, all on deepseek/deepseek-v3.2. The core driver is quadratic context growth: each API call within a run includes the full conversation history, so N turns costs O(N²) input tokens. Runs were regularly hitting 100–161 turns.

## Root Causes Identified

### 1. Missing file I/O tools (fixed)
Agents didn't have `write_file`, `read_file`, or `patch_file` in their basic toolkit. They fell back to bash heredoc/printf to write files, which failed silently or required 8–15 extra turns of retry/workaround per script.

### 2. Prompt actively instructed the wrong pattern (fixed)
`lifeos-prompt.md` line 107 said: *"write the full content in a single agent_bash call using a heredoc or printf"* — directly teaching agents to use the broken pattern.

### 3. Multi-patch loops (partially fixed)
Agents patch the same file 6–13 times per run instead of reading once and writing once. A single `status.md` update consumed 8 `patch_file` calls (16 turns with interleaved reads).

### 4. Redundant reads within a run
Agents re-read logs, feed, and workspace files they already read earlier in the same run. Adds 2–4 wasted tool calls per run.

### 5. Chunked file reads via bash
Agents used `cat` (truncated at 2001 chars) → `sed -n '180,400p'` → `sed -n '400,500p'` → `read_file offset=7000` → ... to read a single 24k-char file across 13 tool calls. `read_file` default is 100k chars.

## Changes Made

### Code
- **`agent-registry.ts`**: Expanded `ALWAYS_INCLUDE` from `[agent_bash, shared_bash]` to the full basic toolkit (22 tools including `read_file`, `write_file`, `patch_file`, planning tools, log tools, comms tools, email tools)
- **`agent-tools.ts`**: Removed `BASIC_TOOLS` list — no longer written into agent.yml since runtime enforcement is authoritative

### Prompts
- **`lifeos-prompt.md`**: Replaced heredoc/printf instruction with `read_file`/`write_file`/`patch_file` as primary file I/O tools. Added explicit rules:
  - Call `read_file` with no offset first (100k default covers most files)
  - Batch all edits: read once → write once, never patch in a loop
  - Don't re-read what's already in context in the same run
  - `update_plan` once per completed step, not after every micro-action

### Tool descriptions (`tools-registry.ts`)
- `agent_bash`: "do NOT use for file reads or writes"
- `read_file`: leads with 100k default, chunk only if total_chars exceeds it
- `write_file`: "always use instead of bash" + multi-patch warning
- `patch_file`: "for multiple edits, use read_file + write_file instead of looping"
- `save_plan`: replaced "edit via agent_bash" with "use update_plan"
- `create_agent`: updated tools description to reflect full basic toolkit

## Observed Impact

Before: resume_writer runs hitting 153–161 turns (2.0–2.8M tokens each)  
After (same day): runs at 7–33 turns, worst case 81 (still being investigated)

The 81-turn runs remain — multi-patch loops and re-reads are still occurring. Prompt and description changes need to propagate through agent behavior over subsequent runs.

## Open Questions

- Should there be a hard per-run turn cap enforced at the executor level (e.g. 40 tool calls is the stated limit but agents ignore it)?
- Are agents reading the updated prompt immediately or only on next server restart?
- Which agents still have restricted tool lists that exclude basic toolkit tools?

## Next Steps

- Monitor turn counts over next 24h to see if prompt changes take effect
- If multi-patch loops persist, consider a tool-level guard that warns when patch_file is called >3x on the same file in a run
- Audit other high-spend agents (nishant/cos at 19.7M tokens in 12h) for similar patterns
