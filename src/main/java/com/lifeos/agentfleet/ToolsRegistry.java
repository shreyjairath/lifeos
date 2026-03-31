package com.lifeos.agentfleet;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.agentfleet.schedulers.ReminderScheduler;
import com.lifeos.agentfleet.tools.AgentChannels;
import com.lifeos.agentfleet.tools.AgentLog;
import com.lifeos.agentfleet.tools.AgentTools;
import com.lifeos.agentfleet.tools.AgentTopics;
import com.lifeos.agentfleet.tools.Bash;
import com.lifeos.agentfleet.tools.Notifications;
import com.lifeos.agentfleet.tools.Browse;
import com.lifeos.agentfleet.tools.McpToolsClient;
import com.lifeos.agentfleet.tools.Media;
import com.lifeos.agentfleet.tools.PropertyReport;
import com.lifeos.agentfleet.tools.Redfin;
import com.lifeos.agentfleet.tools.ScheduledTasks;
import com.lifeos.agentfleet.tools.SessionTools;
import com.lifeos.agentfleet.tools.WebSearch;
import com.lifeos.agentfleet.EventBus;
import jakarta.annotation.PostConstruct;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tool definitions (Anthropic schema format), dispatch routing, and disabled-tool management.
 */
@Component
public class ToolsRegistry {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir")).resolve(".user-data").normalize();
    public  static final Path AGENTS_DIR  = USER_DATA.resolve("agents");
    private static final Path DISABLED_FILE = USER_DATA.resolve("disabled-tools.json").normalize();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ConcurrentHashMap<String, Bash>     agentBashInstances         = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Bash>     agentBashReadonlyInstances = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AgentLog> agentLogInstances          = new ConcurrentHashMap<>();
    private final ScheduledTasks sharedTasks = new ScheduledTasks(USER_DATA.resolve("tasks.json"));

    private final WebSearch webSearch;
    private final Browse browse;
    private final Media media;
    private final Redfin redfin;
    private final PropertyReport propertyReport;
    private final SessionTools sessionTools;
    private final ReminderScheduler reminderScheduler;
    private final AgentTools agentTools;
    private final AgentChannels agentChannels;
    private final EventBus eventBus;
    private final McpToolsClient mcpToolsClient;
    private final Notifications notifications;
    private final AgentTopics agentTopics;

    public ToolsRegistry(WebSearch webSearch, Browse browse, Media media,
                         Redfin redfin, PropertyReport propertyReport,
                         @Lazy ReminderScheduler reminderScheduler, AgentTools agentTools,
                         AgentChannels agentChannels, EventBus eventBus,
                         McpToolsClient mcpToolsClient, Notifications notifications,
                         AgentTopics agentTopics) {
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
        this.reminderScheduler = reminderScheduler;
        this.agentTools = agentTools;
        this.agentChannels = agentChannels;
        this.eventBus = eventBus;
        this.mcpToolsClient = mcpToolsClient;
        this.notifications = notifications;
        this.agentTopics = agentTopics;
        this.sessionTools = new SessionTools();
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(USER_DATA.resolve("system"));
    }

    /** Register a dynamic agent's bash workspace. Called by AgentRegistry when an agent is loaded. */
    public void registerAgentWorkspace(String name, Path workspace) {
        agentBashInstances.put(name, new Bash(workspace));
        agentBashReadonlyInstances.put(name, new Bash(workspace, true));
        agentLogInstances.put(name, new AgentLog(workspace));
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────────

    public Map<String, Object> dispatch(String toolName, Map<String, Object> input, String agentName) {
        var sessionResult = sessionTools.dispatch(toolName, input, agentName);
        if (sessionResult != null) return sessionResult;
        return switch (toolName) {
            case "agent_bash" -> {
                var bash = agentBashInstances.get(agentName);
                yield bash != null ? bash.bash((String) input.get("command"))
                                   : Map.of("error", "No workspace registered for agent: " + agentName);
            }
            case "set_reminder"    -> reminderScheduler.store().set((String) input.get("time"), (String) input.get("message"));
            case "list_reminders"  -> reminderScheduler.store().list();
            case "delete_reminder" -> reminderScheduler.store().delete((String) input.get("id"));
            case "notify_user" -> notifications.notifyUser(
                    agentName,
                    (String) input.get("message"),
                    (String) input.get("urgency"),
                    (String) input.get("context"));
            case "web_search"     -> webSearch.search((String) input.get("query"));
            case "browse_page"    -> browse.fetch((String) input.get("url"));
            case "parse_redfin_listing" -> redfin.parseListing((String) input.get("url"));
            case "parse_redfin_search"  -> redfin.parseSearch((String) input.get("url"));
            case "property_report"      -> propertyReport.report((String) input.get("address"));
            case "show_image"     -> media.showImage((String) input.get("url"), (String) input.getOrDefault("caption", ""));
            case "get_current_datetime" -> Map.of(
                    "datetime", ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z")),
                    "iso8601",  ZonedDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME));
            case "read_agent_workspace" -> {
                var target = (String) input.get("agent");
                var bash = agentBashReadonlyInstances.get(target);
                yield bash != null ? bash.bash((String) input.get("command"))
                                   : Map.of("error", "No workspace registered for agent: " + target);
            }
            case "create_task" -> sharedTasks.upsert(
                    agentName,
                    (String) input.get("name"),
                    (String) input.get("description"),
                    input.get("cadence_hours") != null ? ((Number) input.get("cadence_hours")).doubleValue() : null,
                    (String) input.get("due_at"),
                    (String) input.get("assignee"));
            case "get_my_tasks"  -> sharedTasks.list(agentName);
            case "get_tasks"     -> sharedTasks.list((String) input.get("assignee"));
            case "get_overdue_tasks" -> sharedTasks.getOverdue(agentName);
            case "mark_task_complete" -> sharedTasks.markComplete((String) input.get("id"), agentName);
            case "delete_task"   -> sharedTasks.delete((String) input.get("id"));
            case "log_entry" -> {
                var log = agentLogInstances.get(agentName);
                yield log != null
                        ? log.append((String) input.get("mode"), (String) input.get("summary"),
                                (String) input.get("changed"), (String) input.get("notes"))
                        : Map.of("error", "No workspace registered for agent: " + agentName);
            }
            case "read_log" -> {
                var log = agentLogInstances.get(agentName);
                yield log != null
                        ? log.read(input.get("entries") != null ? ((Number) input.get("entries")).intValue() : null)
                        : Map.of("error", "No workspace registered for agent: " + agentName);
            }
            case "read_agent_message_history" -> agentChannels.readChannel(agentName, (String) input.get("agent"));
            case "message_agent" -> agentTools.messageAgent(agentName, (String) input.get("agent"), (String) input.get("message"));
            case "message_agent_async" -> agentTools.messageAgentAsync(agentName, (String) input.get("agent"), (String) input.get("message"));
            case "write_to_topic" -> agentTopics.writeTopic(agentName, (String) input.get("topic"), (String) input.get("message"));
            case "read_topic"     -> agentTopics.readTopic(agentName, (String) input.get("topic"));
            case "list_topics"    -> agentTopics.listTopics(agentName);
            case "read_agent_definition" -> agentTools.readAgentDefinition((String) input.get("agent"));
            case "update_agent" -> agentTools.updateAgent(
                    (String) input.get("name"),
                    (String) input.get("title"),
                    (String) input.get("description"),
                    (String) input.get("goal"),
                    (String) input.get("manager"),
                    (String) input.get("identity"),
                    (String) input.get("chat_instructions"),
                    input.get("tools") instanceof List<?> rawList
                            ? rawList.stream().map(Object::toString).toList()
                            : null);
            case "list_agents" -> agentTools.listAgents(agentName);
            case "list_tools" -> Map.of("tools", getTools().stream()
                        .map(t -> Map.of("name", t.get("name"), "description", t.get("description")))
                        .toList());
            case "create_agent" -> agentTools.createAgent(
                    (String) input.get("name"),
                    (String) input.get("title"),
                    (String) input.get("description"),
                    (String) input.get("goal"),
                    (String) input.get("manager"),
                    (String) input.get("identity"),
                    (String) input.get("chat_instructions"),
                    input.get("tools") instanceof List<?> rawList
                            ? rawList.stream().map(Object::toString).toList()
                            : List.of());
            case "render_artifact" -> {
                var path = (String) input.get("path");
                var title = (String) input.getOrDefault("title", "");
                if (path == null || path.isBlank())
                    yield Map.of("error", "path is required");
                if (path.startsWith("http://") || path.startsWith("https://"))
                    yield Map.of("url", path, "title", title, "path", path);
                var artifacts = AGENTS_DIR.resolve(agentName).resolve("workspace").resolve("_artifacts").normalize();
                var file = artifacts.resolve(path).normalize();
                if (!file.startsWith(artifacts))
                    yield Map.of("error", "Path outside _artifacts folder: " + path);
                if (!Files.exists(file))
                    yield Map.of("error", "File not found in _artifacts/: " + path);
                var url = "/api/artifacts/" + agentName + "/" + path;
                eventBus.publish(Map.of("type", "artifact_updated", "agent", agentName,
                                        "url", url, "title", title, "path", path));
                yield Map.<String, Object>of("url", url, "title", title, "path", path);
            }
            default -> {
                if (toolName.startsWith("mcp_"))
                    yield mcpToolsClient.callTool(toolName, input);
                yield Map.of("error", "Unknown tool: " + toolName);
            }
        };
    }

    private static final List<Map<String, Object>> TOOLS = List.of(
            tool("agent_bash",
                    "Your personal workspace. Use this to read and write your notes and files. " +
                    "The shell starts in your workspace — use relative paths (e.g. ls, cat file.md). " +
                    "Do not use ~/, $HOME, or absolute paths. " +
                    "Standard shell tools available: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, jq, python3, etc. " +
                    "Path traversal (../), ~/, $HOME, network tools, and privilege escalation are blocked.",
                    props(prop("command", "string", "Bash command to run.")), "command"),
            tool("browse_page",
                    "Fetch and read the content of a web page. " +
                    "Use to read a specific URL in full. For discovery, use web_search first.",
                    props(prop("url", "string", "Full URL to fetch")), "url"),
            tool("parse_redfin_listing",
                    "Parse a Redfin listing URL and return structured property data: price, beds/baths, sq ft, HOA, year built, amenities, coordinates, MLS number, description, and photo URLs.",
                    props(prop("url", "string", "Redfin listing URL")), "url"),
            tool("parse_redfin_search",
                    "Parse a Redfin search results page and return all listed properties with price, beds, baths, sq ft, and URL. " +
                    "IMPORTANT: Use zipcode URLs (e.g. redfin.com/zipcode/60614/filter/...) — neighborhood URLs (/neighborhood/...) do not work and return wrong results. " +
                    "Filters can be appended: /filter/property-type=condo,min-beds=2,max-price=700k",
                    props(prop("url", "string", "Redfin zipcode or city search URL (e.g. redfin.com/zipcode/60614 or redfin.com/city/6331/IL/Chicago). Do NOT use /neighborhood/ URLs.")), "url"),
            tool("property_report",
                    "Generate a comprehensive property report for any address. Includes building obstruction analysis (distances to adjacent buildings in each cardinal direction), sun exposure, corner unit detection, floor number, street noise, neighborhood walkability, transit access, parks, flood zone, and elevation. Best used before evaluating a condo or apartment.",
                    props(prop("address", "string", "Full street address including unit number if applicable (e.g. '123 Main St #4N, Chicago, IL')")),
                    "address"),
            tool("web_search",
                    "Search the web for information. " +
                    "Use for discovery and finding URLs. Follow up with browse_page to read specific pages in full.",
                    props(prop("query", "string", "Search query")), "query"),
            tool("show_image", "Display an image inline in the chat.",
                    props(prop("url", "string", "Image URL"), prop("caption", "string", "Optional caption")),
                    "url"),
            tool("get_current_datetime",
                    "Get the current date and time. " +
                    "Call before set_reminder, create_task with due_at, or any time-relative calculation.",
                    props(), new String[]{}),
            tool("notify_user",
                    "Send an immediate notification to the user. " +
                    "Use this when you find something genuinely important — a risk, a time-sensitive finding, or something requiring their attention. " +
                    "Available in background modes only (heartbeat, post-session). Do NOT use for routine updates or progress reports. " +
                    "Fires a push notification (works even when browser is closed) and an in-app toast when browser is open.",
                    props(prop("message", "string", "Short, direct message — treat it like a text. No preamble, no pleasantries. 1–3 sentences max."),
                          Map.entry("urgency", Map.of("type", "string",
                                  "enum", List.of("low", "medium", "high"),
                                  "description", "low=informational, medium=action needed soon, high=time-sensitive/urgent")),
                          prop("context", "string", "Optional additional detail shown in-app (not in the OS push notification)")),
                    "message"),
            tool("set_reminder",
                    "Schedule a reminder that fires at a specific future time. " +
                    "Use for time-based alerts (e.g. 'remind user to book flights tomorrow at 9am'). " +
                    "For immediate notifications, use notify_user instead. " +
                    "Always call get_current_datetime first to know the current time before computing the target time. " +
                    "time must be a full ISO-8601 datetime with timezone offset (e.g. 2026-03-15T15:00:00-05:00).",
                    props(prop("time", "string", "ISO-8601 datetime with timezone offset when the reminder should fire (e.g. 2026-03-15T15:00:00-05:00)"),
                          prop("message", "string", "Reminder message shown to the user")),
                    "time", "message"),
            tool("list_reminders", "List all pending (not yet fired) reminders.",
                    props(), new String[]{}),
            tool("delete_reminder", "Cancel a pending reminder by id.",
                    props(prop("id", "string", "Reminder id from list_reminders")), "id"),

            tool("create_task",
                    "Create or update a task on the shared task board. " +
                    "Internal only — no user notification is sent. For user-facing time-based alerts, use set_reminder instead. " +
                    "Upserts by name within your namespace (same name + you = update). " +
                    "assignee: who owns the task — \"user\" (the client), an agent name, or omit for self. " +
                    "User-assigned tasks should be surfaced to the client in heartbeat when overdue; " +
                    "agent-assigned tasks should be messaged to that agent when overdue. " +
                    "due_at is always required. Add cadence_hours to make it recurring — after each completion, " +
                    "next due = last_run + cadence_hours. Omit cadence_hours for a one-off task.",
                    props(prop("name", "string", "Short task name (unique per creator — upsert)"),
                          prop("description", "string", "What needs to be done"),
                          prop("assignee", "string", "Who is responsible: \"user\", an agent name, or omit for self"),
                          prop("due_at", "string", "ISO-8601 due datetime (e.g. 2026-04-01T09:00:00-05:00). Required."),
                          prop("cadence_hours", "number", "Recurring interval in hours (e.g. 24, 168). Omit for one-off.")),
                    "name", "description", "due_at"),
            tool("get_my_tasks",
                    "List tasks assigned to you on the shared board. " +
                    "Each task includes created_by — check with the creator agent via message_agent for richer context on any task.",
                    props(), new String[]{}),
            tool("get_tasks",
                    "List tasks on the shared board across all agents. " +
                    "Optionally filter by assignee to see tasks for a specific person or agent " +
                    "(e.g. assignee: \"user\" for client tasks, assignee: \"cos\" for cos tasks). " +
                    "Each task includes created_by — check with the creator agent via message_agent for richer context on any task.",
                    props(prop("assignee", "string", "Filter by assignee: \"user\", an agent name, or omit for all")),
                    new String[]{}),
            tool("get_overdue_tasks",
                    "List overdue tasks assigned to you. " +
                    "Recurring tasks are overdue past their interval; one-off tasks are overdue once due_at has passed. " +
                    "Each task includes created_by — check with the creator agent via message_agent for richer context before acting.",
                    props(), new String[]{}),
            tool("mark_task_complete",
                    "Mark a task as completed now. " +
                    "For recurring tasks, this resets the clock — the task won't be overdue again until the next interval. " +
                    "For one-off tasks, this permanently marks them done.",
                    props(prop("id", "string", "Task id from get_my_tasks or get_overdue_tasks")),
                    "id"),
            tool("delete_task",
                    "Permanently remove a task from the board. Use for cancelled or irrelevant tasks. " +
                    "For completion, use mark_task_complete instead.",
                    props(prop("id", "string", "Task id from get_my_tasks or get_tasks")),
                    "id"),

            tool("log_entry",
                    "Append a structured log entry to _log.md. " +
                    "Call at the end of every background run: post-session, heartbeat, self-eval, and inter-agent-message. " +
                    "Call even if nothing changed — but if nothing happened, use a single-line summary (e.g. \"nothing to action\") rather than a full structured entry. " +
                    "The timestamp is set automatically — do not include it in summary or notes.",
                    props(prop("mode", "string", "Run mode: chat, post-session, heartbeat, self-eval, or inter-agent-message"),
                          prop("summary", "string", "1–3 sentence summary of what happened"),
                          prop("changed", "string", "Files changed and what changed in each (omit if nothing changed)"),
                          prop("notes", "string", "Additional context, findings, or decisions (optional)")),
                    "mode", "summary"),

            tool("read_log",
                    "Read your own _log.md — past activity recorded by log_entry. " +
                    "Call at the start of heartbeat and self-eval runs to understand your recent activity before deciding what to do next. " +
                    "Returns recent entries newest-last. Defaults to last 10 entries — increase only if you need to look further back.",
                    props(prop("entries", "number", "Number of recent entries to return (default: 10)")),
                    new String[]{}),

            tool("read_agent_message_history",
                    "Read the message history between you and another agent (last 10 exchanges). " +
                    "Returns a chronological log of prior exchanges in this agent pair's private channel. " +
                    "Call this before message_agent or message_agent_async to review prior context before writing your next message. " +
                    "Entries are labeled \"sender → receiver\" so you can orient to who said what.",
                    props(prop("agent", "string", "Agent name (e.g. 'therapist'). Use list_agents to see available agents.")),
                    "agent"),

            tool("message_agent",
                    "Send a message to another agent and receive their response synchronously. " +
                    "This is an internal agent-to-agent channel — separate from the user-facing chat. " +
                    "Always call read_agent_message_history first to review prior exchanges before sending a new message. " +
                    "BLOCKING: waits for the full response before returning — up to 90 seconds. " +
                    "NEVER call this during user chat — it blocks the thread and stalls the user for up to 90 seconds. " +
                    "Use message_agent_async for all chat-mode outreach. This tool is for background modes only: " +
                    "post-session, heartbeat, self-eval, inter-agent-message.",
                    props(prop("agent", "string", "Agent name to message (e.g. 'therapist'). Use list_agents to see available agents."),
                          prop("message", "string", "Message to send to the agent.")),
                    "agent", "message"),

            tool("message_agent_async",
                    "Send a non-blocking message to another agent. Returns immediately — safe to use during user chat. " +
                    "Always call read_agent_message_history first to review prior exchanges before sending a new message. " +
                    "The agent processes your message in the background. " +
                    "Do not poll immediately — the target agent may take 30–90 seconds. " +
                    "Check read_agent_message_history at the end of your current run or during your next heartbeat. " +
                    "Keep exchanges meaningful: share what's new, what changed, or what you specifically need.",
                    props(prop("agent", "string", "Agent name to message (e.g. 'therapist'). Use list_agents to see available agents."),
                          prop("message", "string", "Message to send to the agent.")),
                    "agent", "message"),

            tool("write_to_topic",
                    "Post a message to the shared team knowledge board. " +
                    "Use topic 'knowledge' for all team-wide sharing — every agent reads this at heartbeat. " +
                    "Post here whenever you have something other agents should know: a clinical development, " +
                    "a strategic shift, a context change, a finding that affects the team's work. " +
                    "Topics are persistent and append-only. topic must be lowercase letters, digits, underscores, or hyphens.",
                    props(prop("topic", "string", "Topic name — use 'knowledge' for standard team-wide sharing"),
                          prop("message", "string", "Message to post — be specific. State what changed, what it means, and what (if anything) others should do with it.")),
                    "topic", "message"),

            tool("read_topic",
                    "Read new messages on a topic since your last check. " +
                    "On first read: returns up to the last 20 entries. " +
                    "On subsequent reads: returns only messages published after your previous read. " +
                    "Cursor is advanced automatically — calling twice returns different results. " +
                    "Use topic 'knowledge' to read the shared team knowledge board.",
                    props(prop("topic", "string", "Topic name — use 'knowledge' for the shared team board")),
                    "topic"),

            tool("list_topics",
                    "List all topics on the knowledge board with their subscriber lists. " +
                    "Use this to discover what topics exist and which agents are subscribed.",
                    props(), new String[]{}),

            tool("read_agent_workspace",
                    "Read-only access to another agent's workspace. " +
                    "Use this to inspect what a specialist agent has stored — its notes, files, and knowledge base. " +
                    "Write operations are blocked. The shell starts in the target agent's workspace — use bare filenames only.",
                    props(prop("agent", "string", "Agent name (e.g. 'therapist', 'pm_coach'). Use list_agents to see available agents."),
                          prop("command", "string", "Read-only bash command (ls, cat, grep, etc.)")),
                    "agent", "command"),

            tool("read_agent_definition",
                    "Read the full definition of a dynamic agent — its agent.yml config and all prompt files " +
                    "(identity.md, chat.md, post-session.md, self-eval.md, heartbeat.md). Use this before update_agent to see the current state.",
                    props(prop("agent", "string", "Agent name (e.g. 'pm_coach')")),
                    "agent"),

            tool("update_agent",
                    "Update a dynamic agent's definition. Only the fields you provide are changed — omitted fields keep their current values. " +
                    "The agent is re-registered immediately after updating. Use read_agent_definition first to see current values.",
                    props(prop("name", "string", "Agent slug to update"),
                          prop("title", "string", "New display name"),
                          prop("description", "string", "New one-sentence description"),
                          prop("goal", "string", "Durable, concrete purpose statement — what this agent is trying to achieve for the client. The agent will be evaluated against this goal in self-eval and post-session. Make it specific enough to measure against."),
                          prop("manager", "string", "Agent name of the manager (e.g. 'cos', 'advisor')"),
                          prop("identity", "string", "New identity prompt"),
                          prop("chat_instructions", "string", "New session-mode instructions"),
                          Map.entry("tools", Map.of("type", "array", "items", Map.of("type", "string"),
                                  "description", "New tool list (replaces current list)"))),
                    "name"),

            tool("list_agents",
                    "List all agents currently registered in the system with their name and title. " +
                    "Use this before calling create_agent to see what agents already exist.",
                    props(), new String[]{}),

            tool("list_tools",
                    "List all tools available in the system with their names and descriptions. " +
                    "Use this before calling create_agent to know which tools can be granted to a new dynamic agent.",
                    props(), new String[]{}),

            tool("render_artifact",
                    "Display a file in a persistent panel next to the chat. " +
                    "Use this instead of chat for anything long-form: reports, summaries, plans, analyses, structured documents, HTML visualizations, or any content that benefits from its own space. " +
                    "Keep chat responses short — offload depth and detail here. " +
                    "Accepts a path relative to your workspace/_artifacts/ folder (e.g. 'report.md', 'viz.html') or a full URL (https://...) to embed directly. " +
                    "For workspace files, write them to workspace/_artifacts/ first using agent_bash, then pass just the filename (e.g. 'report.md'). " +
                    "The artifact stays visible while the conversation continues.",
                    props(prop("path", "string", "Filename within workspace/_artifacts/ (e.g. 'report.md', 'chart.html') or a full https:// URL"),
                          prop("title", "string", "Optional title shown in the artifact panel header")),
                    "path"),

            tool("create_agent",
                    "Create a new specialist agent and register it immediately. " +
                    "The agent will persist across server restarts. " +
                    "After creation, let the user know it's ready — they can meet them anytime.",
                    props(prop("name", "string", "Agent slug: lowercase letters, digits, underscores (e.g. 'pm_coach')"),
                          prop("title", "string", "Display name shown in the UI (e.g. 'PM Coach')"),
                          prop("description", "string", "One-sentence description of what this agent does (shown in list_agents)."),
                          prop("goal", "string", "Durable, concrete purpose statement — what this agent is trying to achieve for the client. The agent will be evaluated against this goal in self-eval and post-session. Make it specific enough to measure against."),
                          prop("manager", "string", "Agent name of the manager who hired this agent (e.g. 'cos', 'advisor'). Omit if hired directly by the client."),
                          prop("identity", "string",
                                  "Durable identity prompt. Keep it lean — purpose, not operating procedures. Cover: " +
                                  "(1) Who the agent is — their role, domain, and what they own. Be specific about why they exist and what they're accountable for. " +
                                  "(2) Workspace — the agent has a personal workspace accessible via agent_bash. " +
                                  "Instruct them to use it as institutional memory: build it up over time, update it as things change. " +
                                  "_memory.md is the entry point — the index of what files exist and the current operating picture. " +
                                  "On first use, create it. Before every session, read it. Keep it current as the workspace evolves. " +
                                  "Do not prescribe a framework or file structure — the agent should figure out what works through use and self-evaluation."),
                          prop("chat_instructions", "string",
                                  "Session-mode instructions — how the agent shows up when the user is present. " +
                                  "Start with reading _memory.md. " +
                                  "Focus on interactive posture: how the agent engages, what it surfaces, how it drives things forward in its domain. " +
                                  "Keep it short — this is not a re-statement of identity."),
                          Map.entry("tools", Map.of("type", "array", "items", Map.of("type", "string"),
                                  "description", "Tool names to expose to this agent in addition to agent_bash (always included automatically). " +
                                          "Examples: get_current_datetime, web_search, browse_page, set_reminder, list_sessions, read_session_transcript. " +
                                          "Include message_agent if the agent should reach other agents or escalate to cos."))),
                    "name", "identity", "chat_instructions", "tools")
    );

    // ── Schema ───────────────────────────────────────────────────────────────────

    public AgentChannels agentChannels() { return agentChannels; }

    public List<Map<String, Object>> getTools() {
        var all = new ArrayList<>(TOOLS);
        all.addAll(SessionTools.DEFINITIONS);
        all.addAll(mcpToolsClient.getTools());
        var disabled = loadDisabledTools();
        if (disabled.isEmpty()) return List.copyOf(all);
        return all.stream().filter(t -> !disabled.contains(t.get("name"))).toList();
    }

    public List<String> allToolNames() {
        var all = new ArrayList<>(TOOLS);
        all.addAll(SessionTools.DEFINITIONS);
        return all.stream().map(t -> (String) t.get("name")).toList();
    }

    public static Set<String> loadDisabledTools() {
        if (!Files.exists(DISABLED_FILE)) return Set.of();
        try {
            return MAPPER.readValue(Files.readString(DISABLED_FILE, StandardCharsets.UTF_8),
                    new TypeReference<LinkedHashSet<String>>() {});
        } catch (Exception e) {
            return Set.of();
        }
    }

    public static void saveDisabledTools(Set<String> names) throws IOException {
        Files.createDirectories(DISABLED_FILE.getParent());
        Files.writeString(DISABLED_FILE, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(names),
                StandardCharsets.UTF_8);
    }

    // ── Definition builders ──────────────────────────────────────────────────────

    private static Map<String, Object> tool(String name, String description,
                                             Map<String, Object> properties, String... required) {
        var schema = new LinkedHashMap<String, Object>();
        schema.put("type", "object");
        schema.put("properties", properties);
        if (required.length > 0) schema.put("required", List.of(required));
        return Map.of("name", name, "description", description, "input_schema", schema);
    }

    @SafeVarargs
    private static Map<String, Object> props(Map.Entry<String, Map<String, Object>>... entries) {
        var map = new LinkedHashMap<String, Object>();
        for (var entry : entries) map.put(entry.getKey(), entry.getValue());
        return map;
    }

    private static Map.Entry<String, Map<String, Object>> prop(String name, String type, String description) {
        return Map.entry(name, Map.of("type", type, "description", description));
    }
}
