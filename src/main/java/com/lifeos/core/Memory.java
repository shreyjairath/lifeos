package com.lifeos.core;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.stream.Stream;

/**
 * Conversation and session management. File-based JSON storage.
 *
 * Layout:
 *   .user-data/conversations/{conv_id}/
 *     meta.json, sessions/{session_id}.json, summaries/{timestamp}.md, summary.md
 */
@Component
public class Memory {

    private static final Logger log = LoggerFactory.getLogger(Memory.class);
    private static final Path USER_DATA = Path.of(System.getProperty("user.dir"))
            .resolve("../.user-data").normalize();
    private static final Path CONV_ROOT = USER_DATA.resolve("conversations");
    private static final int DISPLAY_SESSIONS = 3;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    // ── Public API ───────────────────────────────────────────────────────────────

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
            saveMeta(convId, meta);
            saveSession(convId, sessionId, new ArrayList<>());
            return new ConvSession(convId, sessionId);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public ConvSession getOrCreateForProject(String projectName) {
        lock.writeLock().lock();
        try {
            if (Files.exists(CONV_ROOT)) {
                try (Stream<Path> dirs = Files.list(CONV_ROOT).sorted()) {
                    for (var convDir : dirs.toList()) {
                        if (!Files.isDirectory(convDir)) continue;
                        try {
                            var meta = loadMeta(convDir.getFileName().toString());
                            if (projectName.equals(meta.get("project_name"))) {
                                var convId = convDir.getFileName().toString();
                                var sessionId = (String) meta.getOrDefault("current_session",
                                        ((List<String>) meta.get("sessions")).getLast());
                                return new ConvSession(convId, sessionId);
                            }
                        } catch (Exception ignored) {}
                    }
                } catch (IOException ignored) {}
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
            saveMeta(convId, meta);
            saveSession(convId, sessionId, new ArrayList<>());
            return new ConvSession(convId, sessionId);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public List<Map<String, Object>> listConversations() {
        if (!Files.exists(CONV_ROOT)) return List.of();
        var result = new ArrayList<Map<String, Object>>();
        try (Stream<Path> dirs = Files.list(CONV_ROOT)) {
            for (var convDir : dirs.toList()) {
                if (!Files.isDirectory(convDir)) continue;
                var meta = loadMeta(convDir.getFileName().toString());
                if (meta.isEmpty()) continue;
                result.add(Map.of(
                        "id", convDir.getFileName().toString(),
                        "name", meta.getOrDefault("name", convDir.getFileName().toString()),
                        "project_name", meta.getOrDefault("project_name", ""),
                        "created_at", meta.getOrDefault("created_at", 0),
                        "current_session", meta.getOrDefault("current_session", "")
                ));
            }
        } catch (IOException ignored) {}
        result.sort(Comparator.comparingDouble(m -> ((Number) m.get("created_at")).doubleValue()));
        return result;
    }

    public List<Map<String, Object>> getHistory(String convId, String sessionId) {
        lock.readLock().lock();
        try {
            return new ArrayList<>(loadSession(convId, sessionId));
        } finally {
            lock.readLock().unlock();
        }
    }

    public void appendMessage(String convId, String sessionId, Map<String, Object> message) {
        lock.writeLock().lock();
        try {
            var messages = loadSession(convId, sessionId);
            messages.add(message);
            saveSession(convId, sessionId, messages);
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public String newSession(String convId) {
        lock.writeLock().lock();
        try {
            var sessionId = newSessionId();
            var meta = loadMeta(convId);
            ((List<String>) meta.computeIfAbsent("sessions", k -> new ArrayList<>())).add(sessionId);
            meta.put("current_session", sessionId);
            saveMeta(convId, meta);
            saveSession(convId, sessionId, new ArrayList<>());
            return sessionId;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public void clearSession(String convId, String sessionId) {
        lock.writeLock().lock();
        try {
            saveSession(convId, sessionId, new ArrayList<>());
        } finally {
            lock.writeLock().unlock();
        }
    }

    public int truncateSession(String convId, String sessionId, int fromIndex) {
        lock.writeLock().lock();
        try {
            var messages = loadSession(convId, sessionId);
            var truncated = new ArrayList<>(messages.subList(0, Math.min(fromIndex, messages.size())));
            saveSession(convId, sessionId, truncated);
            return truncated.size();
        } finally {
            lock.writeLock().unlock();
        }
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getSessionMeta(String convId, String sessionId) {
        lock.readLock().lock();
        try {
            var meta = loadMeta(convId);
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
            var meta = loadMeta(convId);
            var sessionMeta = (Map<String, Object>) meta.computeIfAbsent("session_meta", k -> new LinkedHashMap<>());
            var entry = (Map<String, Object>) sessionMeta.computeIfAbsent(sessionId, k -> {
                var m = new LinkedHashMap<String, Object>();
                m.put("created_at", epochSeconds());
                return m;
            });
            entry.put("last_message_at", epochSeconds());
            entry.put("last_input_tokens", inputTokens);
            saveMeta(convId, meta);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public String getConvSummary(String convId) {
        var path = convDir(convId).resolve("summary.md");
        if (!Files.exists(path)) return "";
        try {
            return Files.readString(path, StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            return "";
        }
    }

    public void writeConvSummary(String convId, String content) {
        var path = convDir(convId).resolve("summary.md");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.warn("Failed to write conv summary: {}", e.getMessage());
        }
    }

    public Path summariesDir(String convId) {
        return convDir(convId).resolve("summaries");
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> getAllDisplayHistory(String convId) {
        var meta = loadMeta(convId);
        var currentSession = (String) meta.getOrDefault("current_session", "");
        var sessions = (List<String>) meta.getOrDefault("sessions", List.of());

        int truncated = Math.max(0, sessions.size() - DISPLAY_SESSIONS);
        var visible = sessions.subList(truncated, sessions.size());

        var result = new ArrayList<Map<String, Object>>();
        for (var sid : visible) {
            var messages = loadSession(convId, sid);
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


    // ── Private ──────────────────────────────────────────────────────────────────

    private Path convDir(String convId) { return CONV_ROOT.resolve(convId); }

    private Map<String, Object> loadMeta(String convId) {
        var path = convDir(convId).resolve("meta.json");
        if (!Files.exists(path)) return new LinkedHashMap<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    private void saveMeta(String convId, Map<String, Object> meta) {
        var path = convDir(convId).resolve("meta.json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(meta),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.error("Failed to save meta for {}: {}", convId, e.getMessage());
        }
    }

    private List<Map<String, Object>> loadSession(String convId, String sessionId) {
        var path = convDir(convId).resolve("sessions").resolve(sessionId + ".json");
        if (!Files.exists(path)) return new ArrayList<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<ArrayList<Map<String, Object>>>() {});
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    private void saveSession(String convId, String sessionId, List<Map<String, Object>> messages) {
        var path = convDir(convId).resolve("sessions").resolve(sessionId + ".json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(messages),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.error("Failed to save session {}/{}: {}", convId, sessionId, e.getMessage());
        }
    }

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
