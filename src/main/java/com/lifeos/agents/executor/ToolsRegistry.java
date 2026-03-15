package com.lifeos.agents.executor;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.store.SessionStore;
import com.lifeos.agents.shared_tools.*;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Tool definitions (Anthropic format) and dispatch routing.
 */
@Component
public class ToolsRegistry {

    private static final Path USER_DATA = Path.of(System.getProperty("user.dir")).resolve(".user-data").normalize();

    private static final Bash NOTES_BASH     = new Bash(USER_DATA.resolve("knowledge/notes"));
    private static final Bash THERAPIST_BASH = new Bash(USER_DATA.resolve("therapist"));

    private final FileSystem fileSystem;
    private final Projects projects;
    private final WebSearch webSearch;
    private final Browse browse;
    private final Media media;
    private final Redfin redfin;
    private final PropertyReport propertyReport;
    private final SessionStore sessionStore;

    public ToolsRegistry(
            FileSystem fileSystem, Projects projects, WebSearch webSearch, Browse browse,
            Media media, Redfin redfin, PropertyReport propertyReport, SessionStore sessionStore
    ) {
        this.fileSystem = fileSystem;
        this.projects = projects;
        this.webSearch = webSearch;
        this.browse = browse;
        this.media = media;
        this.redfin = redfin;
        this.propertyReport = propertyReport;
        this.sessionStore = sessionStore;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> dispatch(String toolName, Map<String, Object> input) {
        return switch (toolName) {
            // Projects
            case "create_project" -> projects.create(
                    (String) input.get("name"), (String) input.get("goal"),
                    (String) input.getOrDefault("context", ""));
            case "list_projects" -> projects.list();
            case "update_project" -> projects.update(
                    (String) input.get("name"), (String) input.get("section"), (String) input.get("content"));
            case "read_project" -> projects.read((String) input.get("name"));
            case "add_project_file" -> projects.addFile(
                    projName(input), (String) input.get("filename"),
                    (String) input.getOrDefault("description", ""), (String) input.getOrDefault("content", ""));
            case "read_project_file" -> projects.readFile(projName(input), (String) input.get("filename"));
            case "update_project_file" -> projects.updateFile(
                    projName(input), (String) input.get("filename"), (String) input.getOrDefault("content", ""));
            case "delete_project_file" -> projects.deleteFile(projName(input), (String) input.get("filename"));

            // Notes bash (main agent — scoped to .user-data/knowledge/notes/)
            case "notes_bash" -> NOTES_BASH.bash((String) input.get("command"));

            // Therapist bash (reflector-only — scoped to .user-data/therapist/)
            case "therapist_bash" -> THERAPIST_BASH.bash((String) input.get("command"));

            // Filesystem
            case "write_file" -> fileSystem.writeFile((String) input.get("path"), (String) input.get("content"));
            case "read_file" -> fileSystem.readFile((String) input.get("path"));
            case "update_file" -> fileSystem.updateFile(
                    (String) input.get("path"), (String) input.get("old_str"), (String) input.get("new_str"));
            case "list_dir" -> fileSystem.listDir((String) input.getOrDefault("path", "."));

            // Web
            case "web_search" -> webSearch.search((String) input.get("query"));
            case "browse_page" -> browse.fetch((String) input.get("url"));
            case "parse_redfin_listing" -> redfin.parseListing((String) input.get("url"));
            case "parse_redfin_search" -> redfin.parseSearch((String) input.get("url"));
            case "property_report" -> propertyReport.report((String) input.get("address"));

            // Media
            case "show_image" -> media.showImage((String) input.get("url"), (String) input.getOrDefault("caption", ""));

            // Sessions
            case "list_sessions" -> listSessions();
            case "read_session_summary" -> readSessionSummary((String) input.get("session_id"));
            case "read_session_transcript" -> readSessionTranscript((String) input.get("session_id"));

            // Utility
            case "get_current_datetime" -> Map.of(
                    "datetime", ZonedDateTime.now().format(DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy h:mm a z")),
                    "iso8601", ZonedDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME));

            default -> Map.of("error", "Unknown tool: " + toolName);
        };
    }

    public List<Map<String, Object>> getTools() {
        var disabled = loadDisabledTools();
        if (disabled.isEmpty()) return TOOLS;
        return TOOLS.stream().filter(t -> !disabled.contains(t.get("name"))).toList();
    }

    // ── Disabled tools persistence ────────────────────────────────────────────

    private static final Path DISABLED_FILE = USER_DATA.resolve("disabled-tools.json").normalize();
    private static final ObjectMapper MAPPER = new ObjectMapper();

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

    public List<String> allToolNames() {
        return TOOLS.stream().map(t -> (String) t.get("name")).toList();
    }


    // ── Helpers ──────────────────────────────────────────────────────────────────

    private static String projName(Map<String, Object> input) {
        var name = input.get("project");
        if (name == null) name = input.get("name");
        return (String) name;
    }


    // ── Tool definitions ─────────────────────────────────────────────────────────

    private static final List<Map<String, Object>> TOOLS = List.of(
            tool("create_project",
                    "Create a new project with a goal and optional context.",
                    props(
                            prop("name", "string", "Short project name"),
                            prop("goal", "string", "What success looks like"),
                            prop("context", "string", "Background, constraints (optional)")
                    ), "name", "goal"),
            tool("list_projects", "List all active projects with their status and goals.",
                    props(), new String[]{}),
            tool("update_project",
                    "Update a specific section of a project.",
                    props(
                            prop("name", "string", "Project name or slug"),
                            propEnum("section", List.of("context", "snapshot", "next_action", "waiting_on", "files", "log"), "Which section"),
                            prop("content", "string", "New content for the section")
                    ), "name", "section", "content"),
            tool("read_project", "Read the full details of a specific project.",
                    props(prop("name", "string", "Project name or slug")), "name"),
            tool("add_project_file",
                    "Attach a named document to a project.",
                    props(
                            prop("name", "string", "Project name or slug"),
                            prop("filename", "string", "Document name"),
                            prop("description", "string", "One-line description"),
                            prop("content", "string", "Full document content")
                    ), "name", "filename", "description", "content"),
            tool("read_project_file", "Read a document attached to a project.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name")),
                    "name", "filename"),
            tool("update_project_file", "Overwrite a project document.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name"),
                            prop("content", "string", "New content")),
                    "name", "filename", "content"),
            tool("delete_project_file", "Remove a document from a project.",
                    props(prop("name", "string", "Project name"), prop("filename", "string", "Document name")),
                    "name", "filename"),
            tool("notes_bash",
                    "Run a bash command scoped to your notes directory (.user-data/knowledge/notes/). " +
                    "Use standard shell tools: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, etc. " +
                    "Path traversal (../), network tools, and privilege escalation are blocked.",
                    props(prop("command", "string", "Bash command to run")), "command"),
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
            tool("write_file", "Create or overwrite a file under .user-data/.",
                    props(prop("path", "string", "Relative path"), prop("content", "string", "File content")),
                    "path", "content"),
            tool("read_file", "Read a file under .user-data/.",
                    props(prop("path", "string", "Relative path")), "path"),
            tool("update_file", "Edit a file by replacing a specific string.",
                    props(prop("path", "string", "Relative path"), prop("old_str", "string", "String to find"),
                            prop("new_str", "string", "Replacement")),
                    "path", "old_str", "new_str"),
            tool("list_dir", "List files and subdirectories.",
                    props(prop("path", "string", "Relative path (defaults to root)")), new String[]{}),
            tool("show_image", "Display an image inline in the chat.",
                    props(prop("url", "string", "Image URL"), prop("caption", "string", "Optional caption")),
                    "url"),
            tool("get_current_datetime", "Get the current date and time.",
                    props(), new String[]{}),
            tool("list_sessions",
                    "List past sessions with their date and title. Use this to find relevant past conversations before reading a specific session summary.",
                    props(), new String[]{}),
            tool("read_session_summary",
                    "Read the summary of a past session by its session_id.",
                    props(prop("session_id", "string", "Session ID from list_sessions")),
                    "session_id"),
            tool("read_session_transcript",
                    "Read the conversation transcript of a past session (user and assistant messages only, no tool calls). Use after list_sessions to recall the actual conversation.",
                    props(prop("session_id", "string", "Session ID from list_sessions")),
                    "session_id"),

            // Therapist bash — reflector-only, not shown to main agent
            tool("therapist_bash",
                    "Run a bash command scoped to the therapist notes directory (.user-data/therapist/). " +
                    "Use standard shell tools: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, etc. " +
                    "Path traversal (../), network tools, and privilege escalation are blocked.",
                    props(prop("command", "string", "Bash command to run")), "command")
    );


    // ── Session tools ────────────────────────────────────────────────────────────

    private static final DateTimeFormatter SESSION_DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());

    private Map<String, Object> listSessions() {
        record Entry(long createdAt, Map<String, Object> data) {}
        var entries = new ArrayList<Entry>();
        for (var dir : sessionStore.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            var meta = sessionStore.loadMeta(sessionId);
            if (meta.isEmpty()) continue;
            var createdAt = meta.containsKey("created_at")
                    ? ((Number) meta.get("created_at")).longValue() : 0L;
            var hasSummary = !sessionStore.readSummary(sessionId).isEmpty();
            entries.add(new Entry(createdAt, Map.of(
                    "session_id", sessionId,
                    "title", meta.getOrDefault("title", meta.getOrDefault("name", sessionId)),
                    "date", createdAt > 0 ? SESSION_DATE_FMT.format(Instant.ofEpochSecond(createdAt)) : "unknown",
                    "has_summary", hasSummary
            )));
        }
        entries.sort(Comparator.comparingLong(e -> -e.createdAt()));
        return Map.of("sessions", entries.stream().map(Entry::data).toList());
    }

    private Map<String, Object> readSessionSummary(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) return Map.of("error", "session_id required");
        var summary = sessionStore.readSummary(sessionId);
        if (summary.isEmpty()) return Map.of("error", "No summary found for session: " + sessionId);
        return Map.of("session_id", sessionId, "summary", summary);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readSessionTranscript(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) return Map.of("error", "session_id required");
        var messages = sessionStore.loadMessages(sessionId);
        if (messages.isEmpty()) return Map.of("error", "No messages found for session: " + sessionId);
        var lines = new ArrayList<String>();
        for (var msg : messages) {
            var role = (String) msg.getOrDefault("role", "");
            if (!"user".equals(role) && !"assistant".equals(role)) continue;
            var content = msg.get("content");
            if (content instanceof String text && !text.isBlank()) {
                lines.add(role.toUpperCase() + ": " + text);
            } else if (content instanceof List<?> blocks) {
                for (var block : blocks) {
                    if (!(block instanceof Map<?, ?> b)) continue;
                    if ("text".equals(b.get("type"))) {
                        var text = (String) b.get("text");
                        if (text != null && !text.isBlank()) lines.add(role.toUpperCase() + ": " + text);
                    }
                }
            }
        }
        return Map.of("session_id", sessionId, "transcript", String.join("\n\n", lines));
    }


    // ── Definition builders ──────────────────────────────────────────────────────

    private static Map<String, Object> tool(String name, String description,
                                             Map<String, Object> properties, String... required) {
        var schema = new java.util.LinkedHashMap<String, Object>();
        schema.put("type", "object");
        schema.put("properties", properties);
        if (required.length > 0) {
            schema.put("required", List.of(required));
        }
        return Map.of("name", name, "description", description, "input_schema", schema);
    }

    private static Map<String, Object> props(Map.Entry<String, Map<String, Object>>... entries) {
        var map = new java.util.LinkedHashMap<String, Object>();
        for (var entry : entries) {
            map.put(entry.getKey(), entry.getValue());
        }
        return map;
    }

    private static Map.Entry<String, Map<String, Object>> prop(String name, String type, String description) {
        return Map.entry(name, Map.of("type", type, "description", description));
    }

    private static Map.Entry<String, Map<String, Object>> propEnum(String name, List<String> values, String description) {
        return Map.entry(name, Map.of("type", "string", "enum", values, "description", description));
    }
}
