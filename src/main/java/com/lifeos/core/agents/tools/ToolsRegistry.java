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

    public ToolsRegistry(WebSearch webSearch, Browse browse, Media media,
                         Redfin redfin, PropertyReport propertyReport, SessionTools sessionTools,
                         @Lazy ReminderScheduler reminderScheduler, AgentTools agentTools) {
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
        this.sessionTools = sessionTools;
        this.reminderScheduler = reminderScheduler;
        this.agentTools = agentTools;
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
            case "message_agent" -> agentTools.messageAgent(agentName, (String) input.get("agent"), (String) input.get("message"));
            case "read_agent_definition" -> agentTools.readAgentDefinition((String) input.get("agent"));
            case "update_agent" -> agentTools.updateAgent(
                    (String) input.get("name"),
                    (String) input.get("title"),
                    (String) input.get("description"),
                    (String) input.get("who_you_are"),
                    (String) input.get("chat_instructions"),
                    (String) input.get("reflect_instructions"),
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
                    (String) input.get("reflect_instructions"),
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
                    "The shell starts in your workspace. " +
                    "Standard shell tools available: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, jq, python3, etc. " +
                    "Path traversal (../), absolute paths, network tools, and privilege escalation are blocked.",
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

            tool("message_agent",
                    "Send a message to another agent and receive their response. " +
                    "This is an internal agent-to-agent channel — separate from the user-facing chat. " +
                    "Each sender-recipient pair has its own dedicated session, so conversations stay isolated. " +
                    "Use this to delegate tasks, request analysis, escalate to cos, or check in with a specialist.",
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
                    "(who-you-are.md, chat.md, reflect.md, heartbeat.md). Use this before update_agent to see the current state.",
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
                          prop("reflect_instructions", "string", "New post-session reflection instructions"),
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
                    "Before calling this, use read_agent_definition on an existing agent (e.g. 'therapist') to see the prompt style and structure to follow. " +
                    "The agent will persist across server restarts. " +
                    "After creation, let the user know it's ready — they can meet them anytime.",
                    props(prop("name", "string", "Agent slug: lowercase letters, digits, underscores (e.g. 'pm_coach')"),
                          prop("title", "string", "Display name shown in the UI (e.g. 'PM Coach')"),
                          prop("description", "string", "One-sentence description of what this agent does (shown in list_agents). E.g. 'Tracks your finances — income, expenses, investments, and net worth.'"),
                          prop("who_you_are", "string",
                                  "Durable identity prompt. Must cover: " +
                                  "(1) Who the agent is — role, domain expertise, and purpose. Be specific about what they own and why they exist. " +
                                  "(2) Workspace — introduce the agent_bash tool (automatically provided to every agent), give full freedom to create any files and directory structure they see fit. " +
                                  "(3) Framework — instruct the agent to ground itself in an established framework from its professional field, not invent one. " +
                                  "The framework should reflect how practitioners in that domain actually think — e.g. for a therapist: biopsychosocial, Five P's, psychodynamic, CBT, or ACT; for a finance agent: balance sheet + income statement + cash flow; for a coach: periodization + load management. " +
                                  "Instruct the agent to choose the framework that best fits this specific user's situation, document the choice and rationale in _orientation.md, and switch if it stops fitting as the work deepens. " +
                                  "The workspace file structure should reflect the chosen framework — not the other way around. " +
                                  "On first run, the agent should read any existing workspace files, decide on a framework, build out the file structure, and write _orientation.md as an index and introduction to the workspace: what files exist, what each one contains, and how to navigate the workspace. " +
                                  "(4) Orientation ritual — instruct the agent to always read _orientation.md before doing anything, in every mode (chat, reflect, heartbeat). " +
                                  "_orientation.md is the entry point to the workspace — it must always be kept current as files are added or changed."),
                          prop("chat_instructions", "string",
                                  "Session-mode instructions — what the agent does when the user is present. " +
                                  "Should read as a natural continuation of who_you_are (not a separate document). " +
                                  "Focus only on interactive posture and behavior — the orientation ritual is already established in who_you_are. " +
                                  "Describe how the agent actively helps the user move things forward in its domain. " +
                                  "Should define the agent's interactive posture: e.g. ask clarifying questions, surface gaps or open threads, " +
                                  "challenge when warranted, take notes during the session. " +
                                  "Keep it focused — this is the agent in action, not a re-statement of identity."),
                          prop("reflect_instructions", "string",
                                  "Post-session reflection instructions. Omit if the agent has no persistent state to maintain. " +
                                  "If provided, should instruct a three-pass reflection: " +
                                  "Pass 1 — update domain-specific notes and files in the workspace based on what happened this session (new decisions, new data, changed state). " +
                                  "Pass 2 — zoom out: review whether the current framework and file structure still fits. Restructure, rename, or consolidate files if the domain has evolved. Keep _orientation.md current after any structural changes. " +
                                  "Pass 3 — message the Chief of Staff (agent=cos) if anything from this session has operational implications: a pattern blocking forward motion, a commitment being avoided, a shift in capacity or priorities, or something the CoS should factor into how they're supporting the user. Only message if it would genuinely change how CoS operates — not every session warrants one. " +
                                  "The agent should defer to _orientation.md for what files exist and what to update — not hardcode filenames in the prompt."),
                          prop("heartbeat_instructions", "string",
                                  "Proactive check-in prompt — runs on a schedule even without user input. Omit if not needed. " +
                                  "The orientation ritual is already established in who_you_are — focus only on what to do during a heartbeat. " +
                                  "Instruct the agent to scan its workspace for anything that warrants proactive attention (deadlines, stale items, anomalies, things the user should know); " +
                                  "then either send a message to the user or stay silent. " +
                                  "Should define the signal-to-noise bar clearly — only surface things that are genuinely actionable or time-sensitive. " +
                                  "If nothing warrants attention, the agent should do nothing."),
                          Map.entry("tools", Map.of("type", "array", "items", Map.of("type", "string"),
                                  "description", "Tool names to expose to this agent in addition to agent_bash (which is always included automatically). " +
                                          "Examples: get_current_datetime, web_search, browse_page, set_reminder, list_sessions, read_session_transcript. " +
                                          "Include message_agent if the agent should be able to reach other agents or escalate to cos."))),
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
