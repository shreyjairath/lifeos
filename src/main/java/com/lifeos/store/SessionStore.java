package com.lifeos.store;

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
 * Raw file I/O for the memory subtree: .user-data/memory/conversations/{convId}/
 * No locking — callers (Memory) are responsible for concurrency control.
 */
@Component
public class SessionStore {

    public record SessionSummary(String content, long epochSeconds) {}

    private static final Path CONV_ROOT = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/session/conversations").normalize();

    private final ObjectMapper mapper = new ObjectMapper();

    // ── Meta ──────────────────────────────────────────────────────────────────

    public Map<String, Object> loadMeta(String convId) {
        var path = convDir(convId).resolve("meta.json");
        if (!Files.exists(path)) return new LinkedHashMap<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    public void saveMeta(String convId, Map<String, Object> meta) {
        var path = convDir(convId).resolve("meta.json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(meta),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to save meta for " + convId, e);
        }
    }

    // ── Sessions ──────────────────────────────────────────────────────────────

    public List<Map<String, Object>> loadSession(String convId, String sessionId) {
        var path = convDir(convId).resolve("sessions").resolve(sessionId + ".json");
        if (!Files.exists(path)) return new ArrayList<>();
        try {
            return mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                    new TypeReference<ArrayList<Map<String, Object>>>() {});
        } catch (Exception e) {
            return new ArrayList<>();
        }
    }

    public void saveSession(String convId, String sessionId, List<Map<String, Object>> messages) {
        var path = convDir(convId).resolve("sessions").resolve(sessionId + ".json");
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(messages),
                    StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to save session " + convId + "/" + sessionId, e);
        }
    }

    // ── Summaries ─────────────────────────────────────────────────────────────

    public String readConvSummary(String convId) {
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
            throw new UncheckedIOException("Failed to write conv summary for " + convId, e);
        }
    }

    public void writeSessionSummary(String convId, long epochSeconds, String content) {
        var sdir = convDir(convId).resolve("summaries");
        try {
            Files.createDirectories(sdir);
            Files.writeString(sdir.resolve(epochSeconds + ".md"), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write session summary for " + convId, e);
        }
    }

    public Optional<SessionSummary> readLastSessionSummary(String convId) {
        var sdir = convDir(convId).resolve("summaries");
        if (!Files.exists(sdir)) return Optional.empty();
        try (Stream<Path> files = Files.list(sdir).sorted()) {
            var mdFiles = files.filter(p -> p.toString().endsWith(".md")).toList();
            if (mdFiles.isEmpty()) return Optional.empty();
            var last = mdFiles.getLast();
            var content = Files.readString(last, StandardCharsets.UTF_8).strip();
            if (content.isEmpty()) return Optional.empty();
            var ts = Long.parseLong(stem(last));
            return Optional.of(new SessionSummary(content, ts));
        } catch (Exception e) {
            return Optional.empty();
        }
    }

    // ── Directory listing ─────────────────────────────────────────────────────

    public List<Path> listConvDirs() {
        if (!Files.exists(CONV_ROOT)) return List.of();
        try (Stream<Path> dirs = Files.list(CONV_ROOT).sorted()) {
            return dirs.filter(Files::isDirectory).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Path convDir(String convId) { return CONV_ROOT.resolve(convId); }

    private static String stem(Path path) {
        var name = path.getFileName().toString();
        var dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }
}
