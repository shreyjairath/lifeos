package com.lifeos.agent.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.lifeos.config.AppConfig;
import com.lifeos.agentfleet.EventBus;
import com.lifeos.agent.PromptParts;
import com.lifeos.agent.executor.LlmClient;
import com.lifeos.agent.session.SessionStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import reactor.core.scheduler.Schedulers;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.function.Consumer;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Session management and archival.
 *
 * Handles session lifecycle (create, rotate, expire), message persistence,
 * and post-close summarization (writes summary.md + title via Haiku).
 *
 * Each session lives at .user-data/sessions/{session_id}/.
 * Rotation creates a new session with parent_session_id pointing to the old one.
 */
public class SessionHandler {

    private static final Logger log = LoggerFactory.getLogger(SessionHandler.class);
    private static final DateTimeFormatter DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());
    private static final String DEFAULT_BACKGROUND_MODEL = "claude-haiku-4-5-20251001";
    private static final String SUMMARIZE_PROMPT_BASE = "agents/session_summarizer";
    private static final String SUMMARIZE_PROMPT_FILE = "summarize.md";

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final AppConfig config;
    private final SessionStore store;
    private final EventBus eventBus;
    private final LlmClient llmClient;
    private final String agentName;
    private final Consumer<String> onSessionClosed;

    public SessionHandler(AppConfig config, EventBus eventBus, String agentName,
                          Consumer<String> onSessionClosed) {
        this.config = config;
        this.eventBus = eventBus;
        this.agentName = agentName;
        this.onSessionClosed = onSessionClosed;
        this.store = new SessionStore(agentName);
        this.llmClient = new LlmClient(config.anthropicApiKey());
    }

    public void initListeners() {
        eventBus.subscribe()
                .filter(e -> "session_expiry_check_trigger".equals(e.get("type")))
                .publishOn(Schedulers.boundedElastic())
                .subscribe(
                        e -> checkExpiredSessions(),
                        err -> log.warn("SessionHandler session_expiry_check_trigger stream error: {}", err.getMessage()));
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    public String createNew(String agent) {
        lock.writeLock().lock();
        try {
            pruneEmpty();
            var sessionId = newSessionId(agent);
            var meta = buildMeta(sessionId, agent);
            store.saveMeta(sessionId, meta);
            store.saveMessages(sessionId, new ArrayList<>());
            return sessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Closes oldSessionId, creates a new session linked to it.
     * Emits `session_closed` so agents can react asynchronously.
     */
    public String rotate(String oldSessionId) {
        String newSessionId;
        String agent;
        lock.writeLock().lock();
        try {
            var oldMeta = store.loadMeta(oldSessionId);
            agent = (String) oldMeta.get("agent");
            oldMeta.put("closed", true);
            store.saveMeta(oldSessionId, oldMeta);

            newSessionId = newSessionId(agent);
            var meta = buildMeta(newSessionId, agent);
            meta.put("parent_session_id", oldSessionId);
            store.saveMeta(newSessionId, meta);
            store.saveMessages(newSessionId, new ArrayList<>());
        } finally {
            lock.writeLock().unlock();
        }
        var closedId = oldSessionId;
        Thread.ofVirtual().start(() -> {
            summarize(closedId, buildTranscript(getHistory(closedId)));
            onSessionClosed.accept(closedId);
        });
        return newSessionId;
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
                if (!meta.containsKey("title") || "New Chat".equals(meta.get("title"))) {
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

    public void delete(String sessionId) {
        lock.writeLock().lock();
        try {
            store.deleteSession(sessionId);
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

    public void pruneEmptySessions() {
        pruneEmpty();
    }

    public List<Map<String, Object>> listSessions() {
        var result = new ArrayList<Map<String, Object>>();
        for (var dir : store.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            var meta = store.loadMeta(sessionId);
            if (meta.isEmpty()) continue;
            if (Boolean.TRUE.equals(meta.get("closed"))) continue;
            if (!store.readSummary(sessionId).isEmpty()) continue; // closed session (legacy)
            result.add(Map.of(
                    "id", sessionId,
                    "title", meta.getOrDefault("title", sessionId),
                    "created_at", meta.getOrDefault("created_at", 0),
                    "last_message_at", meta.getOrDefault("last_message_at", 0),
                    "agent", meta.getOrDefault("agent", "cos")
            ));
        }
        result.sort(Comparator.comparingDouble((Map<String, Object> m) -> {
            var lm = (Number) m.get("last_message_at");
            if (lm != null && lm.doubleValue() > 0) return lm.doubleValue();
            var ca = (Number) m.get("created_at");
            return ca != null ? ca.doubleValue() : 0;
        }).reversed());
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

    /** Returns the parent session's summary, for injection into the system prompt.
     *  If summary.md hasn't been written yet (summarizer still running), falls back
     *  to a condensed transcript of the last 20 parent messages so context is never lost. */
    public Optional<SessionSummary> getParentSummary(String sessionId) {
        var meta = getSessionMeta(sessionId);
        var parentId = (String) meta.get("parent_session_id");
        if (parentId == null || parentId.isEmpty()) return Optional.empty();

        var parentMeta = store.loadMeta(parentId);
        var createdAt = parentMeta.containsKey("created_at")
                ? ((Number) parentMeta.get("created_at")).longValue() : 0L;
        var dateStr = createdAt > 0
                ? DATE_FMT.format(java.time.Instant.ofEpochSecond(createdAt)) : "unknown";

        var summary = store.readSummary(parentId);
        if (!summary.isEmpty()) {
            return Optional.of(new SessionSummary(summary, dateStr));
        }

        // Summary not ready yet — fall back to tail of parent message history
        var history = getHistory(parentId);
        if (history.isEmpty()) return Optional.empty();
        var tail = history.size() > 20 ? history.subList(history.size() - 20, history.size()) : history;
        var transcript = buildTranscript(tail);
        if (transcript.isBlank()) return Optional.empty();
        return Optional.of(new SessionSummary("*(summary pending — recent transcript)*\n\n" + transcript, dateStr));
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

    private void checkExpiredSessions() {
        for (var dir : store.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            try {
                var meta = store.loadMeta(sessionId);
                if (!store.readSummary(sessionId).isEmpty()) continue;
                if (store.loadMessages(sessionId).isEmpty()) continue;
                var rotation = checkRotation(sessionId);
                if (!rotation.shouldRotate()) continue;
                log.info("SessionHandler: session {} expired ({})", sessionId, rotation.reason());
                meta.put("closed", true);
                store.saveMeta(sessionId, meta);
                summarize(sessionId, buildTranscript(getHistory(sessionId)));
                onSessionClosed.accept(sessionId);
            } catch (Exception e) {
                log.warn("SessionHandler: error checking session {}: {}", sessionId, e.getMessage());
            }
        }
    }

    private void summarize(String sessionId, String transcript) {
        if (transcript.isBlank()) return;
        try {
            var result = new LlmClient.LlmResult();
            llmClient.stream(summaryModel(), PromptParts.load(SUMMARIZE_PROMPT_BASE, SUMMARIZE_PROMPT_FILE),
                    List.of(Map.<String, Object>of("role", "user", "content", transcript)),
                    List.of(), 1024, result).blockLast();
            var text = result.getFullText().strip();
            if (text.isEmpty()) return;

            String title = null;
            String summary = text;
            if (text.startsWith("TITLE:")) {
                var nl = text.indexOf('\n');
                if (nl > 0) {
                    title = text.substring("TITLE:".length(), nl).strip();
                    summary = text.substring(nl).strip();
                }
            }

            if (!summary.isEmpty()) {
                store.writeSummary(sessionId, summary);
            }
            if (title != null && !title.isEmpty()) {
                var meta = new LinkedHashMap<>(store.loadMeta(sessionId));
                meta.put("title", title);
                store.saveMeta(sessionId, meta);
            }
        } catch (Exception e) {
            log.warn("Session summarization failed for {}: {}", sessionId, e.getMessage());
        }
    }

    private String summaryModel() {
        var m = config.backgroundModel();
        return (m != null && !m.isBlank()) ? m : DEFAULT_BACKGROUND_MODEL;
    }

    private Map<String, Object> buildMeta(String sessionId, String agent) {
        var meta = new LinkedHashMap<String, Object>();
        meta.put("id", sessionId);
        meta.put("title", "New Chat");
        meta.put("created_at", epochSeconds());
        if (agent != null) meta.put("agent", agent);
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

    private void pruneEmpty() {
        for (var dir : store.listSessionDirs()) {
            var sessionId = dir.getFileName().toString();
            if (store.loadMessages(sessionId).isEmpty()) {
                store.deleteSession(sessionId);
                log.debug("Pruned empty session {}", sessionId);
            }
        }
    }

    private static String newSessionId(String agent) {
        var ts = java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd-HHmmss"));
        return agent != null && !agent.isBlank() ? "session-" + agent + "-" + ts : "session-" + ts;
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
