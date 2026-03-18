package com.lifeos.core.agents.tools;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.core.managers.ReminderScheduler;
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

    private final ConcurrentHashMap<String, Bash> agentBashInstances         = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Bash> agentBashReadonlyInstances = new ConcurrentHashMap<>();

    private final WebSearch webSearch;
    private final Browse browse;
    private final Media media;
    private final Redfin redfin;
    private final PropertyReport propertyReport;
    private final SessionTools sessionTools;
    private final ReminderScheduler reminderScheduler;
    private final AgentTools agentTools;
    private final AgentChannels agentChannels;

    public ToolsRegistry(WebSearch webSearch, Browse browse, Media media,
                         Redfin redfin, PropertyReport propertyReport, SessionTools sessionTools,
                         @Lazy ReminderScheduler reminderScheduler, AgentTools agentTools,
                         AgentChannels agentChannels) {
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
        this.sessionTools = sessionTools;
        this.reminderScheduler = reminderScheduler;
        this.agentTools = agentTools;
        this.agentChannels = agentChannels;
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(USER_DATA.resolve("system"));
    }

    /** Register a dynamic agent's bash workspace. Called by AgentRegistry when an agent is loaded. */
    public void registerAgentWorkspace(String name, Path workspace) {
        agentBashInstances.put(name, new Bash(workspace));
        agentBashReadonlyInstances.put(name, new Bash(workspace, true));
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────────

    public Map<String, Object> dispatch(String toolName, Map<String, Object> input, String agentName) {
        var sessionResult = sessionTools.dispatch(toolName, input);
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
            case "read_agent_channel" -> agentChannels.readChannel(agentName, (String) input.get("agent"));
            case "message_agent" -> agentTools.messageAgent(agentName, (String) input.get("agent"), (String) input.get("message"));
            case "read_agent_definition" -> agentTools.readAgentDefinition((String) input.get("agent"));
            case "update_agent" -> agentTools.updateAgent(
                    (String) input.get("name"),
                    (String) input.get("title"),
                    (String) input.get("description"),
                    (String) input.get("who_you_are"),
                    (String) input.get("chat_instructions"),
                    (String) input.get("post_session_instructions"),
                    (String) input.get("self_eval_instructions"),
                    (String) input.get("heartbeat_instructions"),
                    input.get("tools") instanceof List<?> rawList
                            ? rawList.stream().map(Object::toString).toList()
                            : null);
            case "list_agents" -> agentTools.listAgents(agentName);
            case "list_tools" -> {
                var all = new ArrayList<>(TOOLS);
                all.addAll(SessionTools.DEFINITIONS);
                var disabled = loadDisabledTools();
                yield Map.of("tools", all.stream()
                        .filter(t -> !disabled.contains(t.get("name")))
                        .map(t -> Map.of("name", t.get("name"), "description", t.get("description")))
                        .toList());
            }
            case "create_agent" -> agentTools.createAgent(
                    (String) input.get("name"),
                    (String) input.get("title"),
                    (String) input.get("description"),
                    (String) input.get("who_you_are"),
                    (String) input.get("chat_instructions"),
                    (String) input.get("post_session_instructions"),
                    (String) input.get("self_eval_instructions"),
                    (String) input.get("heartbeat_instructions"),
                    input.get("tools") instanceof List<?> rawList
                            ? rawList.stream().map(Object::toString).toList()
                            : List.of());
            default -> Map.of("error", "Unknown tool: " + toolName);
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
                    "Fetch and read the content of a web page.",
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
                    "Search the web for information.",
                    props(prop("query", "string", "Search query")), "query"),
            tool("show_image", "Display an image inline in the chat.",
                    props(prop("url", "string", "Image URL"), prop("caption", "string", "Optional caption")),
                    "url"),
            tool("get_current_datetime", "Get the current date and time.",
                    props(), new String[]{}),
            tool("set_reminder",
                    "Schedule a reminder that fires at a specific time. " +
                    "The reminder will appear as a chat message and a push notification (even if the browser is backgrounded or closed). " +
                    "Always call get_current_datetime first to know the current time before computing the target time. " +
                    "time must be a full ISO-8601 datetime with timezone offset (e.g. 2026-03-15T15:00:00-05:00).",
                    props(prop("time", "string", "ISO-8601 datetime with timezone offset when the reminder should fire (e.g. 2026-03-15T15:00:00-05:00)"),
                          prop("message", "string", "Reminder message shown to the user")),
                    "time", "message"),
            tool("list_reminders", "List all pending (not yet fired) reminders.",
                    props(), new String[]{}),
            tool("delete_reminder", "Cancel a pending reminder by id.",
                    props(prop("id", "string", "Reminder id from list_reminders")), "id"),

            tool("read_agent_channel",
                    "Read the message history between you and another agent (last 10 exchanges). " +
                    "Returns a chronological log of prior exchanges in this agent pair's private channel.",
                    props(prop("agent", "string", "Agent name (e.g. 'therapist'). Use list_agents to see available agents.")),
                    "agent"),

            tool("message_agent",
                    "Send a message to another agent and receive their response. " +
                    "This is an internal agent-to-agent channel — separate from the user-facing chat. " +
                    "Always call read_agent_channel first to review prior exchanges before sending a new message. " +
                    "BLOCKING: waits for the full response before returning — avoid in chat mode for research-heavy tasks, as it will stall the user. " +
                    "Best used in post-session and heartbeat modes, or for short targeted exchanges in chat.",
                    props(prop("agent", "string", "Agent name to message (e.g. 'therapist'). Use list_agents to see available agents."),
                          prop("message", "string", "Message to send to the agent.")),
                    "agent", "message"),

            tool("read_agent_workspace",
                    "Read-only access to another agent's workspace. " +
                    "Use this to inspect what a specialist agent has stored — its notes, files, and knowledge base. " +
                    "Write operations are blocked. The shell starts in the target agent's workspace — use bare filenames only.",
                    props(prop("agent", "string", "Agent name (e.g. 'therapist', 'pm_coach'). Use list_agents to see available agents."),
                          prop("command", "string", "Read-only bash command (ls, cat, grep, etc.)")),
                    "agent", "command"),

            tool("read_agent_definition",
                    "Read the full definition of a dynamic agent — its agent.yml config and all prompt files " +
                    "(who-you-are.md, chat.md, post-session.md, self-eval.md, heartbeat.md). Use this before update_agent to see the current state.",
                    props(prop("agent", "string", "Agent name (e.g. 'pm_coach')")),
                    "agent"),

            tool("update_agent",
                    "Update a dynamic agent's definition. Only the fields you provide are changed — omitted fields keep their current values. " +
                    "The agent is re-registered immediately after updating. Use read_agent_definition first to see current values.",
                    props(prop("name", "string", "Agent slug to update"),
                          prop("title", "string", "New display name"),
                          prop("description", "string", "New one-sentence description"),
                          prop("who_you_are", "string", "New identity prompt"),
                          prop("chat_instructions", "string", "New session-mode instructions"),
                          prop("post_session_instructions", "string", "New post-session update instructions"),
                          prop("self_eval_instructions", "string", "New self-evaluation instructions"),
                          prop("heartbeat_instructions", "string", "New heartbeat instructions"),
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

            tool("create_agent",
                    "Create a new specialist agent and register it immediately. " +
                    "The agent will persist across server restarts. " +
                    "After creation, let the user know it's ready — they can meet them anytime.",
                    props(prop("name", "string", "Agent slug: lowercase letters, digits, underscores (e.g. 'pm_coach')"),
                          prop("title", "string", "Display name shown in the UI (e.g. 'PM Coach')"),
                          prop("description", "string", "One-sentence description of what this agent does (shown in list_agents)."),
                          prop("who_you_are", "string",
                                  "Durable identity prompt. Keep it lean — purpose, not operating procedures. Cover: " +
                                  "(1) Who the agent is — their role, domain, and what they own. Be specific about why they exist and what they're accountable for. " +
                                  "(2) Workspace — the agent has a personal workspace accessible via agent_bash. " +
                                  "Instruct them to use it as institutional memory: build it up over time, update it as things change. " +
                                  "_orientation.md is the entry point — the index of what files exist and the current operating picture. " +
                                  "On first use, create it. Before every session, read it. Keep it current as the workspace evolves. " +
                                  "Do not prescribe a framework or file structure — the agent should figure out what works through use and self-evaluation."),
                          prop("chat_instructions", "string",
                                  "Session-mode instructions — how the agent shows up when the user is present. " +
                                  "Start with reading _orientation.md. " +
                                  "Focus on interactive posture: how the agent engages, what it surfaces, how it drives things forward in its domain. " +
                                  "Keep it short — this is not a re-statement of identity."),
                          prop("post_session_instructions", "string",
                                  "Post-session workspace update. Omit if the agent has no persistent state. " +
                                  "Should instruct the agent to: read _orientation.md first, update workspace to reflect current state " +
                                  "(not a log — an accurate picture of where things stand), then append an entry to session-log.md with what changed."),
                          prop("self_eval_instructions", "string",
                                  "Scheduled self-evaluation — runs independently on a 24h schedule. Omit if not needed. " +
                                  "Should instruct the agent to: read _orientation.md, assess how well it's doing the job " +
                                  "(is its picture complete? are the right things moving? what would a great specialist do differently?), " +
                                  "fix what's off by updating the workspace, and surface anything the user needs to know. " +
                                  "This is the feedback loop — how the agent course-corrects over time without being told to."),
                          prop("heartbeat_instructions", "string",
                                  "Proactive wake-up prompt — runs on a schedule even without user input. Omit if not needed. " +
                                  "Should instruct the agent to: read _orientation.md, check _schedule.md for any recurring tasks that are due and execute them, " +
                                  "then scan the workspace for anything genuinely urgent. " +
                                  "Only surface something to the user if it's actionable right now — otherwise stay silent."),
                          Map.entry("tools", Map.of("type", "array", "items", Map.of("type", "string"),
                                  "description", "Tool names to expose to this agent in addition to agent_bash (always included automatically). " +
                                          "Examples: get_current_datetime, web_search, browse_page, set_reminder, list_sessions, read_session_transcript. " +
                                          "Include message_agent if the agent should reach other agents or escalate to cos."))),
                    "name", "who_you_are", "chat_instructions", "tools")
    );

    // ── Schema ───────────────────────────────────────────────────────────────────

    public List<Map<String, Object>> getTools() {
        var all = new ArrayList<>(TOOLS);
        all.addAll(SessionTools.DEFINITIONS);
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
