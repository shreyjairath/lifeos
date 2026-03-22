# Getting Started: Bootstrap a New App on agentfleet

This guide walks through creating a minimal app on top of agentfleet with two agents — a generalist assistant and a specialist — from a blank slate.

---

## What You're Building

```
my-app/
├── src/main/java/com/example/
│   └── MyApp.java                  # @SpringBootApplication entry point
├── src/main/resources/
│   ├── application.yml             # Config: model, API key, schedules
│   └── agents/
│       ├── assistant/
│       │   ├── agent.yml
│       │   └── identity.md
│       └── researcher/
│           ├── agent.yml
│           ├── identity.md
│           └── heartbeat.md
└── build.gradle.kts
```

Two agents:
- **assistant** — generalist chat agent, all tools, no background modes
- **researcher** — specialist with scoped tools and a periodic heartbeat run

---

## Step 1 — Entry Point

```java
package com.example;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(scanBasePackages = {"com.lifeos", "com.example"})
@ConfigurationPropertiesScan
@EnableScheduling
public class MyApp {
    public static void main(String[] args) {
        SpringApplication.run(MyApp.class, args);
    }
}
```

Three annotations are required:
- `@SpringBootApplication` — component scan, auto-config, embedded server. Pass `scanBasePackages` to include both `com.lifeos` (the framework) and your own package.
- `@ConfigurationPropertiesScan` — binds `AppConfig` from `application.yml`.
- `@EnableScheduling` — activates `@Scheduled` methods and `DynamicEventScheduler`.

---

## Step 2 — application.yml

```yaml
server:
  port: 8080

lifeos:
  model: claude-sonnet-4-6
  background-model: claude-haiku-4-5-20251001   # cheaper model for background runs
  anthropic-api-key: ${ANTHROPIC_API_KEY}
  session:
    token-threshold: 50000    # rotate session after 50k input tokens
    time-threshold-hours: 4   # rotate session after 4h of inactivity
  session-expiry-check:
    cron: "0 0 * * * *"       # scan for stale sessions every hour
  scheduled-triggers:
    - type: heartbeat_trigger
      cron: "0 0 */6 * * *"   # fire heartbeat_trigger at midnight, 6am, noon, 6pm
```

`scheduled-triggers` is a list — add as many event types as you need. Each entry's `type` string must match the `trigger` field in agent `background-modes` (see Step 4). The cron format is standard Spring (6 fields: `seconds minutes hours day-of-month month day-of-week`).

---

## Step 3 — Agent 1: assistant

**`src/main/resources/agents/assistant/agent.yml`**

```yaml
name: assistant
title: Assistant
description: Generalist chat agent.
identity:
  - identity.md
# tools: omitted → agent gets all tools
# background-modes: omitted → no event-triggered background runs
```

**`src/main/resources/agents/assistant/identity.md`**

```markdown
You are a helpful assistant. Answer clearly and concisely.
```

That's it. Omitting `tools` gives the agent the full tool catalogue. Omitting `background-modes` means no event subscriptions are registered — the agent only runs when a user sends a message.

---

## Step 4 — Agent 2: researcher

**`src/main/resources/agents/researcher/agent.yml`**

```yaml
name: researcher
title: Researcher
description: Specialist agent for web research and synthesis.
identity:
  - identity.md
tools:
  mode: include
  names:
    - agent_bash       # read/write workspace at .user-data/agents/researcher/workspace/
    - web_search
    - browse_page
    - get_current_datetime
background-modes:
  - trigger: heartbeat_trigger   # fires when DynamicEventScheduler publishes "heartbeat_trigger"
    mode: heartbeat
    prompt: heartbeat.md
```

**`src/main/resources/agents/researcher/identity.md`**

```markdown
You are a research specialist. When asked to investigate a topic, search the web
thoroughly, synthesise what you find, and save a clear summary to your workspace.
```

**`src/main/resources/agents/researcher/heartbeat.md`**

```markdown
Check your workspace for any open research tasks. If there are items marked TODO,
work through them now and update the files with your findings.
```

`tools.mode: include` limits the agent to the named tools only. `tools.mode: exclude` does the inverse — starts from all tools and removes the named ones.

The `heartbeat_trigger` string in `background-modes` must match exactly the `type` declared in `application.yml → scheduled-triggers`. When `DynamicEventScheduler` fires the event, `BaseAgent` filters the event bus by that string and calls `handleSystemMessage("heartbeat", null)`, which loads `heartbeat.md` as the system prompt.

---

## Step 5 — Controllers (optional, copy from app)

agentfleet exposes everything through `AgentFleet`. Wire it into controllers however your app requires:

```java
@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private final AgentFleet agentFleet;

    public ChatController(AgentFleet agentFleet) {
        this.agentFleet = agentFleet;
    }

    @PostMapping
    public Flux<ServerSentEvent<String>> chat(@RequestBody ChatRequest req) {
        return agentFleet.handleMessage(req.sessionId(), req.message(), req.agent());
    }
}

record ChatRequest(String sessionId, String message, String agent) {}
```

`handleMessage` returns a `Flux<ServerSentEvent<String>>` that Spring WebFlux streams directly to the client. If `agent` doesn't match any registered agent, `AgentRegistry.get()` falls back to the first loaded agent.

Other useful `AgentFleet` methods:

```java
agentFleet.all()                                        // Collection<Agent> — list agents
agentFleet.createSession(agentName)                     // String sessionId
agentFleet.listSessions(agentName)                      // List<Map<String,Object>>
agentFleet.cancel(agentName, sessionId)                 // abort in-progress run
agentFleet.trigger(eventType, null)                     // manually fire an event
```

---

## Step 6 — Run

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./gradlew bootRun
```

On startup, `AgentRegistry.load()` scans `classpath*:agents/*/agent.yml` and `.user-data/agents/*/agent.yml`. Both agents are loaded, their workspaces provisioned at `.user-data/agents/{name}/workspace/`, and their event listeners registered. `DynamicEventScheduler` reads `scheduled-triggers` from `application.yml` and registers the cron tasks.

Verify agents loaded:

```bash
curl http://localhost:8080/api/agents
# [{"name":"assistant","title":"Assistant"},{"name":"researcher","title":"Researcher"}]
```

Manually fire the heartbeat to test the researcher's background mode:

```bash
curl -X POST http://localhost:8080/api/agents/trigger/heartbeat_trigger
# {"triggered":"heartbeat_trigger"}
```

Check `.user-data/agents/researcher/_runs.json` to confirm the run was recorded.

---

## Adding More Agents

Drop a new directory under `src/main/resources/agents/` with `agent.yml` and prompt files, then restart. No Java changes. For agents that should run without restarting, write to `.user-data/agents/{name}/agent.yml` — AgentRegistry's `register()` method is also callable at runtime via the `create_agent` tool.

---

## agent.yml Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique identifier; used in API routes and session filenames |
| `title` | string | same as `name` | Human-readable name shown in the UI |
| `description` | string | `""` | Shown in agent list; also injected into other agents' tool catalogue |
| `identity` | list of filenames | `[]` | Prompt files loaded in every mode (chat, heartbeat, etc.) |
| `tools.mode` | `include` / `exclude` | — | Omit the whole `tools` block to give the agent all tools |
| `tools.names` | list of strings | `[]` | Tool names to include or exclude |
| `disabled-modes` | list of strings | `[]` | Mode names to skip even if triggered (e.g. `heartbeat`) |
| `background-modes` | list of objects | `[]` | Each entry: `trigger`, `mode`, `prompt` |

**`background-modes` entry:**

| Field | Description |
|-------|-------------|
| `trigger` | Event type string to subscribe to (must match a `scheduled-triggers[].type` in `application.yml`) |
| `mode` | Arbitrary mode name; used only to identify the run internally |
| `prompt` | Filename of the prompt to load from the agent's resource directory |
