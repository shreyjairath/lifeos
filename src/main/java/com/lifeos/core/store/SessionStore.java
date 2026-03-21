package com.lifeos.core.store;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * Raw file I/O for the sessions subtree: .user-data/sessions/{sessionId}/
 * No locking — caller (Session) is responsible for concurrency control.
 *
 * Layout:
 *   .user-data/sessions/
 *     {session_id}/
 *       meta.json           ← {title, created_at, last_message_at,
 *                                last_input_tokens, parent_session_id, agent}
 *       messages.json       ← Anthropic message array
 *       summary.md          ← written at rotation time
 */
public class SessionStore {

    private static final Path ROOT = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/sessions").normalize();

    private final ObjectMapper mapper = new ObjectMapper();

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
        if (!Files.exists(ROOT)) return List.of();
        try (Stream<Path> dirs = Files.list(ROOT).sorted()) {
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

    public Path sessionDir(String sessionId) { return ROOT.resolve(sessionId); }
}
