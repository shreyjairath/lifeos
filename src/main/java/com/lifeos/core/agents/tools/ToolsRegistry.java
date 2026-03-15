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

/**
 * Tool definitions (Anthropic schema format), dispatch routing, and disabled-tool management.
 */
@Component
public class ToolsRegistry {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir")).resolve(".user-data").normalize();
    private static final Path DISABLED_FILE = USER_DATA.resolve("disabled-tools.json").normalize();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Bash ASSISTANT_BASH          = new Bash(USER_DATA.resolve("assistant"));
    private static final Bash THERAPIST_BASH          = new Bash(USER_DATA.resolve("therapist"));
    private static final Bash ASSISTANT_BASH_READONLY = new Bash(USER_DATA.resolve("assistant"), true);
    private static final Bash THERAPIST_BASH_READONLY = new Bash(USER_DATA.resolve("therapist"), true);

    private final WebSearch webSearch;
    private final Browse browse;
    private final Media media;
    private final Redfin redfin;
    private final PropertyReport propertyReport;
    private final SessionTools sessionTools;
    private final ReminderScheduler reminderScheduler;

    public ToolsRegistry(WebSearch webSearch, Browse browse, Media media,
                         Redfin redfin, PropertyReport propertyReport, SessionTools sessionTools,
                         @Lazy ReminderScheduler reminderScheduler) {
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
        this.sessionTools = sessionTools;
        this.reminderScheduler = reminderScheduler;
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(USER_DATA.resolve("assistant"));
        Files.createDirectories(USER_DATA.resolve("therapist"));
        Files.createDirectories(USER_DATA.resolve("system"));
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────────

    public Map<String, Object> dispatch(String toolName, Map<String, Object> input) {
        var sessionResult = sessionTools.dispatch(toolName, input);
        if (sessionResult != null) return sessionResult;
        return switch (toolName) {
            case "assistant_bash"          -> ASSISTANT_BASH.bash((String) input.get("command"));
            case "therapist_bash"          -> THERAPIST_BASH.bash((String) input.get("command"));
            case "assistant_bash_readonly" -> ASSISTANT_BASH_READONLY.bash((String) input.get("command"));
            case "therapist_bash_readonly" -> THERAPIST_BASH_READONLY.bash((String) input.get("command"));
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
            default -> Map.of("error", "Unknown tool: " + toolName);
        };
    }

    private static final List<Map<String, Object>> TOOLS = List.of(
            tool("assistant_bash",
                    "The assistant's personal workspace. Use this to read and write the assistant's notes and files. " +
                    "The shell starts in the assistant's workspace. " +
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

            // Therapist bash — not shown to main agent
            tool("therapist_bash",
                    "The therapist's personal workspace. Use this to read and write clinical notes and observations about the client. " +
                    "The shell starts in the therapist's workspace. " +
                    "Standard shell tools available: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, jq, python3, etc. " +
                    "Path traversal (../), absolute paths, network tools, and privilege escalation are blocked.",
                    props(prop("command", "string", "Bash command to run.")), "command"),

            // Read-only cross-agent access — for reflection use only
            tool("therapist_bash_readonly",
                    "Read-only access to the therapist's workspace. Use this to reference the therapist's notes during reflection. " +
                    "Write operations (rm, mv, echo >, tee, etc.) are blocked — use therapist_bash if you need to write. " +
                    "The shell starts in the therapist's workspace — use bare filenames only.",
                    props(prop("command", "string", "Read-only bash command (ls, cat, grep, etc.).")), "command"),
            tool("assistant_bash_readonly",
                    "Read-only access to the assistant's workspace. Use this to reference the assistant's notes during reflection. " +
                    "Write operations (rm, mv, echo >, tee, etc.) are blocked — use assistant_bash if you need to write. " +
                    "The shell starts in the assistant's workspace — use bare filenames only.",
                    props(prop("command", "string", "Read-only bash command (ls, cat, grep, etc.).")), "command")
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
