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
 * Raw file I/O for the knowledge subtree: .user-data/knowledge/
 */
@Component
public class KnowledgeStore {

    private static final Path KNOWLEDGE = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/knowledge").normalize();

    private final ObjectMapper mapper = new ObjectMapper();

    // ── Text files ────────────────────────────────────────────────────────────

    public String readText(String subdir, String filename) {
        var path = KNOWLEDGE.resolve(subdir).resolve(filename);
        if (!Files.exists(path)) return "";
        try {
            return Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    public void writeText(String subdir, String filename, String content) {
        var path = KNOWLEDGE.resolve(subdir).resolve(filename);
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to write " + subdir + "/" + filename, e);
        }
    }

    // ── Directory listings ────────────────────────────────────────────────────

    public List<Path> listMarkdownFiles(String subdir) {
        var dir = KNOWLEDGE.resolve(subdir);
        if (!Files.exists(dir)) return List.of();
        try (Stream<Path> files = Files.list(dir).sorted()) {
            return files.filter(p -> p.toString().endsWith(".md")).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    public List<Path> listProjectDirs() {
        var projectsDir = KNOWLEDGE.resolve("projects");
        if (!Files.exists(projectsDir)) return List.of();
        try (Stream<Path> dirs = Files.list(projectsDir).sorted()) {
            return dirs.filter(Files::isDirectory).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    // ── Onboarding status ─────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    public Map<String, String> readOnboardingStatus() {
        var statusFile = KNOWLEDGE.resolve("status.json");
        if (!Files.exists(statusFile)) return Map.of();
        try {
            var data = mapper.readValue(Files.readString(statusFile, StandardCharsets.UTF_8),
                    new TypeReference<Map<String, Object>>() {});
            return new LinkedHashMap<>((Map<String, String>) data.getOrDefault("onboarding", Map.of()));
        } catch (Exception e) {
            return Map.of();
        }
    }

    // ── Path helpers ──────────────────────────────────────────────────────────

    public Path projectDir(String slug) {
        return KNOWLEDGE.resolve("projects").resolve(slug);
    }

    public Path knowledgeRoot() { return KNOWLEDGE; }
}
