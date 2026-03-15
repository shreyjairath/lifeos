package com.lifeos.core.managers;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.core.store.SessionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Session management. Flat session model — no conversation wrapper.
 *
 * Each session lives at .user-data/sessions/{session_id}/.
 * Sessions are ordered chronologically by created_at.
 * Rotation creates a new session with parent_session_id pointing to the old one.
 * Pointers.json maps logical keys ("main", "chat-{id}") to current session IDs.
 */
@Component
public class SessionManager {

    private static final Logger log = LoggerFactory.getLogger(SessionManager.class);
    private static final DateTimeFormatter DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final AppConfig config;
    private final SessionStore store;

    public SessionManager(AppConfig config, SessionStore store) {
        this.config = config;
        this.store = store;
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    /** Gets or creates the session for a given pointer key (e.g. "main"). */
    public String getOrCreate(String pointerKey) {
        lock.writeLock().lock();
        try {
            var pointers = store.loadPointers();
            var sessionId = pointers.get(pointerKey);
            if (sessionId != null && store.sessionDir(sessionId).toFile().isDirectory()) {
                return sessionId;
            }
            sessionId = newSessionId();
            var meta = buildMeta(pointerKey, null);
            store.saveMeta(sessionId, meta);
            store.saveMessages(sessionId, new ArrayList<>());
            pointers.put(pointerKey, sessionId);
            store.savePointers(pointers);
            return sessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public String createNew() {
        lock.writeLock().lock();
        try {
            pruneEmpty();
            var sessionId = newSessionId();
            var meta = buildMeta("chat-" + sessionId, null);
            store.saveMeta(sessionId, meta);
            store.saveMessages(sessionId, new ArrayList<>());
            return sessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Creates a new session linked to the parent (called on rotation).
     * Updates the pointer so future requests go to the new session.
     */
    @SuppressWarnings("unchecked")
    public String rotate(String oldSessionId) {
        lock.writeLock().lock();
        try {
            var oldMeta = store.loadMeta(oldSessionId);
            var pointerKey = (String) oldMeta.getOrDefault("pointer_key", "main");

            var newSessionId = newSessionId();
            var meta = buildMeta(pointerKey, oldSessionId);
            store.saveMeta(newSessionId, meta);
            store.saveMessages(newSessionId, new ArrayList<>());

            var pointers = store.loadPointers();
            pointers.put(pointerKey, newSessionId);
            store.savePointers(pointers);
            return newSessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public record RotationCheck(boolean shouldRotate, String reason) {}

    public RotationCheck checkRotation(String sessionId) {
        var meta = getSessionMeta(sessionId);
        if (meta.isEmpty()) return new RotationCheck(false, "");

        var tokenThreshold = config.session().tokenThreshold();
        var timeThresholdHours = config.session().timeThresholdHours();

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
                        "inactivity (%.0fh since last message)".formatted(elapsed / 3600.0));
            }
        }

        return new RotationCheck(false, "");
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    public List<Map<String, Object>> getHistory(String sessionId) {
        lock.readLock().lock();
        try {
            return new ArrayList<>(store.loadMessages(sessionId));
        } finally {
            lock.readLock().unlock();
        }
    }

    public void appendMessage(String sessionId, Map<String, Object> message) {
        lock.writeLock().lock();
        try {
            var messages = store.loadMessages(sessionId);
            if (messages.isEmpty() && "user".equals(message.get("role"))) {
                var meta = store.loadMeta(sessionId);
                if (!meta.containsKey("title")) {
                    meta.put("title", extractTitle(message));
                    store.saveMeta(sessionId, meta);
                }
            }
            var tagged = new LinkedHashMap<>(message);
            tagged.putIfAbsent("_ts", epochSeconds());
            messages.add(tagged);
            store.saveMessages(sessionId, messages);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public void clearSession(String sessionId) {
        lock.writeLock().lock();
        try {
            store.saveMessages(sessionId, new ArrayList<>());
        } finally {
            lock.writeLock().unlock();
        }
    }

    public int truncateSession(String sessionId, int fromIndex) {
        lock.writeLock().lock();
        try {
            var messages = store.loadMessages(sessionId);
            var truncated = new ArrayList<>(messages.subList(0, Math.min(fromIndex, messages.size())));
            store.saveMessages(sessionId, truncated);
            return truncated.size();
        } finally {
            lock.writeLock().unlock();
        }
    }

    // ── Meta ──────────────────────────────────────────────────────────────────

    public Map<String, Object> getSessionMeta(String sessionId) {
        lock.readLock().lock();
        try {
            return new LinkedHashMap<>(store.loadMeta(sessionId));
        } finally {
            lock.readLock().unlock();
        }
    }

    public void updateSessionMeta(String sessionId, int inputTokens) {
        lock.writeLock().lock();
        try {
            var meta = store.loadMeta(sessionId);
            meta.put("last_message_at", epochSeconds());
            meta.put("last_input_tokens", inputTokens);
            store.saveMeta(sessionId, meta);
        } finally {
            lock.writeLock().unlock();
        }
    }

    // ── Listing ───────────────────────────────────────────────────────────────

    public List<Map<String, Object>> listSessions() {
        var result = new ArrayList<Map<String, Object>>();
        for (var dir : store.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            var meta = store.loadMeta(sessionId);
            if (meta.isEmpty()) continue;
            if (store.loadMessages(sessionId).isEmpty()) continue;
            result.add(Map.of(
                    "id", sessionId,
                    "name", meta.getOrDefault("name", sessionId),
                    "title", meta.getOrDefault("title", meta.getOrDefault("name", sessionId)),
                    "pointer_key", meta.getOrDefault("pointer_key", ""),
                    "created_at", meta.getOrDefault("created_at", 0),
                    "parent_session_id", meta.getOrDefault("parent_session_id", "")
            ));
        }
        result.sort(Comparator.comparingDouble(m -> {
            var ca = (Number) ((Map<?,?>) m).get("created_at");
            if (ca != null && ca.doubleValue() > 0) return ca.doubleValue();
            var lm = (Number) ((Map<?,?>) m).get("last_message_at");
            return lm != null ? lm.doubleValue() : 0;
        }));
        return result;
    }

    // ── Display history ───────────────────────────────────────────────────────

    public Map<String, Object> getDisplayHistory(String sessionId) {
        var history = getHistory(sessionId);
        var messages = buildDisplayMessages(history);
        return Map.of("messages", messages, "total", history.size(), "session_id", sessionId);
    }

    // ── Summary / context ─────────────────────────────────────────────────────

    public record SessionSummary(String content, String dateStr) {}

    /** Returns the parent session's summary, for injection into the system prompt. */
    public Optional<SessionSummary> getParentSummary(String sessionId) {
        var meta = getSessionMeta(sessionId);
        var parentId = (String) meta.get("parent_session_id");
        if (parentId == null || parentId.isEmpty()) return Optional.empty();

        var content = store.readSummary(parentId);
        if (content.isEmpty()) return Optional.empty();

        var parentMeta = store.loadMeta(parentId);
        var createdAt = parentMeta.containsKey("created_at")
                ? ((Number) parentMeta.get("created_at")).longValue() : 0L;
        var dateStr = createdAt > 0
                ? DATE_FMT.format(java.time.Instant.ofEpochSecond(createdAt)) : "unknown";
        return Optional.of(new SessionSummary(content, dateStr));
    }

    // ── Transcript ────────────────────────────────────────────────────────────

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

    // ── Private ───────────────────────────────────────────────────────────────

    private Map<String, Object> buildMeta(String pointerKey, String parentSessionId) {
        var meta = new LinkedHashMap<String, Object>();
        meta.put("pointer_key", pointerKey);
        meta.put("name", displayName(pointerKey));
        meta.put("created_at", epochSeconds());
        if (parentSessionId != null) meta.put("parent_session_id", parentSessionId);
        return meta;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> buildDisplayMessages(List<Map<String, Object>> messages) {
        var display = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < messages.size(); i++) {
            var msg = messages.get(i);
            var role = (String) msg.get("role");
            if (!"user".equals(role) && !"assistant".equals(role)) continue;
            var content = msg.get("content");
            var ts = msg.containsKey("_ts") ? ((Number) msg.get("_ts")).longValue() : 0L;
            if (content instanceof String text) {
                display.add(Map.of("role", role, "text", text, "raw_index", i, "ts", ts));
            } else if (content instanceof List<?> blocks) {
                var textParts = new ArrayList<String>();
                for (var block : blocks) {
                    if (block instanceof Map<?, ?> b && "text".equals(b.get("type"))) {
                        textParts.add((String) b.get("text"));
                    }
                }
                var text = String.join(" ", textParts);
                if (!text.isEmpty()) display.add(Map.of("role", role, "text", text, "raw_index", i, "ts", ts));
            }
        }
        return display;
    }

    private static String displayName(String pointerKey) {
        if ("main".equals(pointerKey)) return "Main";
        return pointerKey;
    }

    /** Deletes session directories that have no messages. Called before creating a new session. */
    private void pruneEmpty() {
        for (var dir : store.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            if (store.loadMessages(sessionId).isEmpty()) {
                store.deleteSession(sessionId);
                log.debug("Pruned empty session {}", sessionId);
            }
        }
    }

    private static String newSessionId() {
        return "session-" + UUID.randomUUID().toString().substring(0, 12);
    }

    @SuppressWarnings("unchecked")
    private static String extractTitle(Map<String, Object> message) {
        var content = message.get("content");
        String text = null;
        if (content instanceof String s) {
            text = s;
        } else if (content instanceof List<?> blocks) {
            for (var block : blocks) {
                if (block instanceof Map<?, ?> b && "text".equals(b.get("type"))) {
                    text = (String) b.get("text");
                    break;
                }
            }
        }
        if (text == null || text.isBlank()) return "New session";
        text = text.strip();
        return text.length() <= 50 ? text : text.substring(0, 47) + "…";
    }

    private static double epochSeconds() { return Instant.now().getEpochSecond(); }
}
