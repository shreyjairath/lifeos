package com.lifeos.core.managers.tools;

import com.lifeos.core.store.SessionStore;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * Tool definitions and dispatch for session recall tools:
 * list_sessions, read_session_summary, read_session_transcript.
 */
public class SessionTools {

    private static final DateTimeFormatter DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());

    private final SessionStore sessionStore;

    public SessionTools() {
        this.sessionStore = new SessionStore();
    }

    public Map<String, Object> dispatch(String toolName, Map<String, Object> input) {
        return switch (toolName) {
            case "list_sessions"            -> listSessions();
            case "read_session_summary"     -> readSessionSummary((String) input.get("session_id"));
            case "read_session_transcript"  -> readSessionTranscript((String) input.get("session_id"));
            default -> null;
        };
    }

    // ── Handlers ─────────────────────────────────────────────────────────────────

    private Map<String, Object> listSessions() {
        record Entry(long createdAt, Map<String, Object> data) {}
        var entries = new ArrayList<Entry>();
        for (var dir : sessionStore.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            var meta = sessionStore.loadMeta(sessionId);
            if (meta.isEmpty()) continue;
            var createdAt = meta.containsKey("created_at")
                    ? ((Number) meta.get("created_at")).longValue() : 0L;
            entries.add(new Entry(createdAt, Map.of(
                    "session_id", sessionId,
                    "title", meta.getOrDefault("title", meta.getOrDefault("name", sessionId)),
                    "date", createdAt > 0 ? DATE_FMT.format(Instant.ofEpochSecond(createdAt)) : "unknown",
                    "has_summary", !sessionStore.readSummary(sessionId).isEmpty()
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

    // ── Definitions ──────────────────────────────────────────────────────────────

    static final List<Map<String, Object>> DEFINITIONS = List.of(
            tool("list_sessions",
                    "List past sessions with their date and title. Use this to find relevant past conversations before reading a specific session summary.",
                    Map.of(), new String[]{}),
            tool("read_session_summary",
                    "Read the summary of a past session by its session_id.",
                    props(prop("session_id", "string", "Session ID from list_sessions")),
                    "session_id"),
            tool("read_session_transcript",
                    "Read the conversation transcript of a past session (user and assistant messages only, no tool calls). Use after list_sessions to recall the actual conversation.",
                    props(prop("session_id", "string", "Session ID from list_sessions")),
                    "session_id")
    );

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
        for (var e : entries) map.put(e.getKey(), e.getValue());
        return map;
    }

    private static Map.Entry<String, Map<String, Object>> prop(String name, String type, String description) {
        return Map.entry(name, Map.of("type", type, "description", description));
    }
}
