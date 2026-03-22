package com.lifeos.agent.session;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * Raw file I/O for one agent's sessions subtree: .user-data/agents/{agent}/sessions/{sessionId}/
 * No locking — caller (SessionHandler) is responsible for concurrency control.
 *
 * Layout:
 *   .user-data/agents/{agent}/sessions/
 *     {session_id}/
 *       meta.json           ← {title, created_at, last_message_at,
 *                                last_input_tokens, parent_session_id, agent}
 *       messages.json       ← Anthropic message array
 *       summary.md          ← written at rotation time
 */
public class SessionStore {

    private static final Path AGENTS_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/agents").normalize();

    private final Path root;
    private final ObjectMapper mapper = new ObjectMapper();

    public SessionStore(String agentName) {
        this.root = AGENTS_DIR.resolve(agentName).resolve("sessions");
    }

    // ── Meta ──────────────────────────────────────────────────────────────────

    public Map<String, Object> loadMeta(String sessionId) {
        var path = sessionDir(sessionId).resolve("meta.json");
        if (!Files.exists(path)) return new LinkedHashMap<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    public void saveMeta(String sessionId, Map<String, Object> meta) {
        var path = sessionDir(sessionId).resolve("meta.json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path,
                    mapper.writerWithDefaultPrettyPrinter().writeValueAsString(meta),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to save meta for " + sessionId, e);
        }
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    public List<Map<String, Object>> loadMessages(String sessionId) {
        var path = sessionDir(sessionId).resolve("messages.json");
        if (!Files.exists(path)) return new ArrayList<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<ArrayList<Map<String, Object>>>() {});
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    public void saveMessages(String sessionId, List<Map<String, Object>> messages) {
        var path = sessionDir(sessionId).resolve("messages.json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path,
                    mapper.writerWithDefaultPrettyPrinter().writeValueAsString(messages),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to save messages for " + sessionId, e);
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    public String readSummary(String sessionId) {
        var path = sessionDir(sessionId).resolve("summary.md");
        if (!Files.exists(path)) return "";
        try {
            return Files.readString(path, StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            return "";
        }
    }

    public void writeSummary(String sessionId, String content) {
        var path = sessionDir(sessionId).resolve("summary.md");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write summary for " + sessionId, e);
        }
    }

    // ── Listing ───────────────────────────────────────────────────────────────

    public List<Path> listSessionDirs() {
        if (!Files.exists(root)) return List.of();
        try (Stream<Path> dirs = Files.list(root).sorted()) {
            return dirs.filter(Files::isDirectory).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    public void deleteSession(String sessionId) {
        var dir = sessionDir(sessionId);
        if (!Files.exists(dir)) return;
        try (Stream<Path> files = Files.walk(dir)) {
            files.sorted(Comparator.reverseOrder()).forEach(p -> {
                try { Files.delete(p); } catch (IOException ignored) {}
            });
        } catch (IOException ignored) {}
    }

    // ── Path helpers ──────────────────────────────────────────────────────────

    public Path sessionDir(String sessionId) { return root.resolve(sessionId); }
}
