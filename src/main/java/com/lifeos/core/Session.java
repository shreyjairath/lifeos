package com.lifeos.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.executor.LlmClient;
import com.lifeos.store.SessionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.UncheckedIOException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Conversation and session management. File-based JSON storage.
 *
 * Layout:
 *   .user-data/memory/conversations/{conv_id}/
 *     meta.json, sessions/{session_id}.json, summaries/{timestamp}.md, summary.md
 */
@Component
public class Session {

    private static final Logger log = LoggerFactory.getLogger(Session.class);
    private static final int DISPLAY_SESSIONS = 3;
    private static final String HAIKU_MODEL = "claude-haiku-4-5-20251001";
    private static final DateTimeFormatter DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final AppConfig config;
    private final LlmClient llmClient;
    private final SessionStore store;

    public Session(AppConfig config, LlmClient llmClient, SessionStore store) {
        this.config = config;
        this.llmClient = llmClient;
        this.store = store;
    }

    // ── Public API ───────────────────────────────────────────────────────────────

    public record RotationCheck(boolean shouldRotate, String reason) {}

    public RotationCheck checkRotation(String convId, String sessionId) {
        var tokenThreshold = config.session().tokenThreshold();
        var timeThresholdHours = config.session().timeThresholdHours();

        var meta = getSessionMeta(convId, sessionId);
        if (meta.isEmpty()) return new RotationCheck(false, "");

        var lastInputTokens = meta.containsKey("last_input_tokens")
                ? ((Number) meta.get("last_input_tokens")).intValue() : 0;
        if (lastInputTokens >= tokenThreshold) {
            return new RotationCheck(true,
                    "context window (%,d input tokens)".formatted(lastInputTokens));
        }

        if (meta.containsKey("last_message_at")) {
            var lastMsg = ((Number) meta.get("last_message_at")).doubleValue();
            var elapsed = Instant.now().getEpochSecond() - lastMsg;
            if (elapsed >= timeThresholdHours * 3600) {
                return new RotationCheck(true,
                        "inactivity (%.0fh since last message)".formatted(elapsed / 3600));
            }
        }

        return new RotationCheck(false, "");
    }

    public record ConvSession(String convId, String sessionId) {}

    public ConvSession getOrCreateMain() {
        return getOrCreateForProject("__main__");
    }

    public ConvSession createConversation(String name, String projectName) {
        lock.writeLock().lock();
        try {
            var convId = newConvId();
            var sessionId = newSessionId();
            var meta = new LinkedHashMap<String, Object>();
            meta.put("name", name);
            meta.put("project_name", projectName);
            meta.put("created_at", epochSeconds());
            meta.put("sessions", new ArrayList<>(List.of(sessionId)));
            meta.put("current_session", sessionId);
            meta.put("session_meta", new LinkedHashMap<>());
            store.saveMeta(convId, meta);
            store.saveSession(convId, sessionId, new ArrayList<>());
            return new ConvSession(convId, sessionId);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public ConvSession getOrCreateForProject(String projectName) {
        lock.writeLock().lock();
        try {
            for (var convDir : store.listConvDirs()) {
                try {
                    var convId = convDir.getFileName().toString();
                    var meta = store.loadMeta(convId);
                    if (projectName.equals(meta.get("project_name"))) {
                        var sessionId = (String) meta.getOrDefault("current_session",
                                ((List<String>) meta.get("sessions")).getLast());
                        return new ConvSession(convId, sessionId);
                    }
                } catch (Exception ignored) {}
            }
            // Create new
            var convId = newConvId();
            var sessionId = newSessionId();
            var meta = new LinkedHashMap<String, Object>();
            meta.put("name", projectName);
            meta.put("project_name", projectName);
            meta.put("created_at", epochSeconds());
            meta.put("sessions", new ArrayList<>(List.of(sessionId)));
            meta.put("current_session", sessionId);
            meta.put("session_meta", new LinkedHashMap<>());
            store.saveMeta(convId, meta);
            store.saveSession(convId, sessionId, new ArrayList<>());
            return new ConvSession(convId, sessionId);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public List<Map<String, Object>> listConversations() {
        var result = new ArrayList<Map<String, Object>>();
        for (var convDir : store.listConvDirs()) {
            var convId = convDir.getFileName().toString();
            var meta = store.loadMeta(convId);
            if (meta.isEmpty()) continue;
            result.add(Map.of(
                    "id", convId,
                    "name", meta.getOrDefault("name", convId),
                    "project_name", meta.getOrDefault("project_name", ""),
                    "created_at", meta.getOrDefault("created_at", 0),
                    "current_session", meta.getOrDefault("current_session", "")
            ));
        }
        result.sort(Comparator.comparingDouble(m -> ((Number) m.get("created_at")).doubleValue()));
        return result;
    }

    public List<Map<String, Object>> getHistory(String convId, String sessionId) {
        lock.readLock().lock();
        try {
            return new ArrayList<>(store.loadSession(convId, sessionId));
        } finally {
            lock.readLock().unlock();
        }
    }

    public void appendMessage(String convId, String sessionId, Map<String, Object> message) {
        lock.writeLock().lock();
        try {
            var messages = store.loadSession(convId, sessionId);
            messages.add(message);
            store.saveSession(convId, sessionId, messages);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public String newSession(String convId) {
        lock.writeLock().lock();
        try {
            var sessionId = newSessionId();
            var meta = store.loadMeta(convId);
            ((List<String>) meta.computeIfAbsent("sessions", k -> new ArrayList<>())).add(sessionId);
            meta.put("current_session", sessionId);
            store.saveMeta(convId, meta);
            store.saveSession(convId, sessionId, new ArrayList<>());
            return sessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public void clearSession(String convId, String sessionId) {
        lock.writeLock().lock();
        try {
            store.saveSession(convId, sessionId, new ArrayList<>());
        } finally {
            lock.writeLock().unlock();
        }
    }

    public int truncateSession(String convId, String sessionId, int fromIndex) {
        lock.writeLock().lock();
        try {
            var messages = store.loadSession(convId, sessionId);
            var truncated = new ArrayList<>(messages.subList(0, Math.min(fromIndex, messages.size())));
            store.saveSession(convId, sessionId, truncated);
            return truncated.size();
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getSessionMeta(String convId, String sessionId) {
        lock.readLock().lock();
        try {
            var meta = store.loadMeta(convId);
            var sessionMeta = (Map<String, Object>) meta.getOrDefault("session_meta", Map.of());
            var entry = (Map<String, Object>) sessionMeta.get(sessionId);
            return entry != null ? entry : Map.of();
        } finally {
            lock.readLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public void updateSessionMeta(String convId, String sessionId, int inputTokens) {
        lock.writeLock().lock();
        try {
            var meta = store.loadMeta(convId);
            var sessionMeta = (Map<String, Object>) meta.computeIfAbsent("session_meta", k -> new LinkedHashMap<>());
            var entry = (Map<String, Object>) sessionMeta.computeIfAbsent(sessionId, k -> {
                var m = new LinkedHashMap<String, Object>();
                m.put("created_at", epochSeconds());
                return m;
            });
            entry.put("last_message_at", epochSeconds());
            entry.put("last_input_tokens", inputTokens);
            store.saveMeta(convId, meta);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public String getConvSummary(String convId) {
        return store.readConvSummary(convId);
    }

    public void writeConvSummary(String convId, String content) {
        try {
            store.writeConvSummary(convId, content);
        } catch (UncheckedIOException e) {
            log.warn("Failed to write conv summary: {}", e.getMessage());
        }
    }

    public record SessionSummary(String content, String dateStr) {}

    public Optional<SessionSummary> getLastSessionSummary(String convId) {
        return store.readLastSessionSummary(convId)
                .map(s -> new SessionSummary(s.content(),
                        DATE_FMT.format(Instant.ofEpochSecond(s.epochSeconds()))));
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getAllDisplayHistory(String convId) {
        var meta = store.loadMeta(convId);
        var currentSession = (String) meta.getOrDefault("current_session", "");
        var sessions = (List<String>) meta.getOrDefault("sessions", List.of());

        int truncated = Math.max(0, sessions.size() - DISPLAY_SESSIONS);
        var visible = sessions.subList(truncated, sessions.size());

        var result = new ArrayList<Map<String, Object>>();
        for (var sid : visible) {
            var messages = store.loadSession(convId, sid);
            var display = buildDisplayMessages(messages);
            result.add(Map.of(
                    "session_id", sid,
                    "is_current", sid.equals(currentSession),
                    "total", messages.size(),
                    "messages", display
            ));
        }

        var response = new LinkedHashMap<String, Object>();
        response.put("sessions", result);
        response.put("current_session", currentSession);
        response.put("truncated_sessions", truncated);
        if (truncated > 0) {
            response.put("conv_summary", getConvSummary(convId));
        }
        return response;
    }

    public Map<String, Object> getDisplayHistory(String convId, String sessionId) {
        var history = getHistory(convId, sessionId);
        var display = buildDisplayMessages(history);
        return Map.of("messages", display, "total", history.size());
    }

    @SuppressWarnings("unchecked")
    public static String buildTranscript(List<Map<String, Object>> history) {
        var lines = new ArrayList<String>();
        var om = new ObjectMapper();
        for (var msg : history) {
            var role = ((String) msg.getOrDefault("role", "")).toUpperCase();
            var content = msg.get("content");
            if (content instanceof String text) {
                lines.add(role + ": " + text);
            } else if (content instanceof List<?> blocks) {
                for (var block : blocks) {
                    if (!(block instanceof Map<?, ?> raw)) continue;
                    var b = (Map<String, Object>) raw;
                    var btype = (String) b.get("type");
                    if ("text".equals(btype)) {
                        lines.add(role + ": " + b.get("text"));
                    } else if ("tool_use".equals(btype)) {
                        try {
                            lines.add("TOOL CALL [" + b.get("name") + "]: " +
                                    om.writeValueAsString(b.getOrDefault("input", Map.of())));
                        } catch (Exception ignored) {}
                    } else if ("tool_result".equals(btype)) {
                        lines.add("TOOL RESULT: " + b.getOrDefault("content", ""));
                    }
                }
            }
        }
        return String.join("\n\n", lines);
    }

    /** Archives the session and refreshes the rolling conversation summary. */
    public void reflect(String convId, String transcript) {
        archiveSession(convId, transcript);
        refreshConvSummary(convId, transcript);
    }

    public void archiveSession(String convId, String transcript) {
        try {
            var result = new LlmClient.LlmResult();
            llmClient.stream(HAIKU_MODEL, Knowledge.loadPromptPart("summarize-session.md"),
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 1024, result).blockLast();
            if (!result.getFullText().isEmpty()) {
                store.writeSessionSummary(convId, Instant.now().getEpochSecond(), result.getFullText());
            }
        } catch (Exception e) {
            log.warn("Session archive failed: {}", e.getMessage());
        }
    }

    public void refreshConvSummary(String convId, String transcript) {
        try {
            var existing = getConvSummary(convId);
            var userContent = "New session transcript:\n\n" + transcript;
            if (!existing.isEmpty()) {
                userContent = "Existing summary:\n\n" + existing + "\n\n---\n\n" + userContent;
            }
            var result = new LlmClient.LlmResult();
            llmClient.stream(HAIKU_MODEL, Knowledge.loadPromptPart("summarize-conv.md"),
                    List.of(Map.<String, Object>of("role", "user", "content", userContent)),
                    List.of(), 1024, result).blockLast();
            if (!result.getFullText().isEmpty()) {
                writeConvSummary(convId, result.getFullText());
            }
        } catch (Exception e) {
            log.warn("Conv summary refresh failed: {}", e.getMessage());
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> buildDisplayMessages(List<Map<String, Object>> messages) {
        var display = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < messages.size(); i++) {
            var msg = messages.get(i);
            var role = (String) msg.get("role");
            if (!"user".equals(role) && !"assistant".equals(role)) continue;

            var content = msg.get("content");
            if (content instanceof String text) {
                display.add(Map.of("role", role, "text", text, "raw_index", i));
            } else if (content instanceof List<?> blocks) {
                var textParts = new ArrayList<String>();
                for (var block : blocks) {
                    if (block instanceof Map<?, ?> b && "text".equals(b.get("type"))) {
                        textParts.add((String) b.get("text"));
                    }
                }
                var text = String.join(" ", textParts);
                if (!text.isEmpty()) {
                    display.add(Map.of("role", role, "text", text, "raw_index", i));
                }
            }
        }
        return display;
    }

    private static String newConvId() { return "conv-" + UUID.randomUUID().toString().substring(0, 12); }
    private static String newSessionId() { return "session-" + UUID.randomUUID().toString().substring(0, 12); }
    private static double epochSeconds() { return Instant.now().getEpochSecond(); }
}
