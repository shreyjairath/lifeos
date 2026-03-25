# lifeos Backlog

Items are roughly ordered by priority within each section.

## In Progress
<!-- Items actively being worked on -->

## To Do

### Agent Monitor
- [ ] Trigger buttons per-agent (not just global heartbeat/self-eval)
- [ ] Show last-run time for platform triggers (session_closed, heartbeat, self-eval)
- [ ] Run card: link to the session that triggered a post-session or chat run

### Chat
- [ ] Session search / filter in sidebar
- [ ] Pin sessions to top of sidebar

### Agent System
- [ ] Per-agent `post-session.md` prompt override (currently uses global)
- [ ] Agent-to-agent task delegation visibility in monitor

### Tools
- [ ] `write_memory` tool — agent-callable tool that updates the user's memory reference files (identity, goals, context); should follow the same 3-tier override chain as PromptParts
- [ ] HTML/Markdown/iframe render tool — tool that returns rich content (HTML, MD, or a URL) the frontend renders inline in chat via an iframe or rendered block

### Infrastructure
- [ ] Graceful server restart without losing active sessions

## Done (recent)
- [x] Dynamic agents: add heartbeat + self-eval background modes
- [x] Agent monitor: merge DEFINITION section into header
- [x] Agent monitor: post-session shown as platform trigger in scheduled tasks
- [x] Chat sidebar: token count badge + relative time on session items
- [x] Session context token threshold bumped to 100k
- [x] Agent monitor: DEFINITION section (identity + bg-mode prompt viewer)
- [x] Agent monitor: SCHEDULED TASKS section (platform triggers + workspace tasks)
- [x] Agent monitor: per-agent stats (runs, tokens, cost)
- [x] All dynamic agents: add message_agent + read_agent_channel tools
