package com.lifeos.core;

import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

/**
 * Loads notes and project knowledge into prompt sections.
 */
@Component
public class Knowledge {

    private static final Path THERAPIST_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/therapist").normalize();
    private static final Path PROJECTS_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/knowledge/projects").normalize();

    private final EventBus eventBus;

    public Knowledge(EventBus eventBus) { this.eventBus = eventBus; }

    public String getKnowledgeSection() {
        var parts = new ArrayList<String>();
        var notes = readTherapistNotes();
        if (!notes.isEmpty()) parts.add(notes);
        var projects = readProjects();
        if (!projects.isEmpty()) parts.add(projects);
        return String.join("\n\n", parts);
    }

    // ── Private ──────────────────────────────────────────────────────────────────

    private String readTherapistNotes() {
        if (!Files.exists(THERAPIST_DIR)) return "";
        var sections = new ArrayList<String>();
        try (Stream<Path> s = Files.list(THERAPIST_DIR).sorted()) {
            for (var path : s.filter(Files::isRegularFile)
                             .filter(p -> p.getFileName().toString().endsWith(".md"))
                             .toList()) {
                try {
                    var content = Files.readString(path, StandardCharsets.UTF_8);
                    if (content.isBlank()) continue;
                    var filename = path.getFileName().toString();
                    var title = filename.replaceAll("\\.md$", "").replace("-", " ").replace("_", " ");
                    title = title.substring(0, 1).toUpperCase() + title.substring(1);
                    sections.add("### " + title + "\n" + content.strip());
                    eventBus.publish(Map.of("type", "knowledge_file", "file", filename,
                            "label", "Therapist", "status", "loaded", "chars", content.length()));
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        if (sections.isEmpty()) return "";
        return "## Previous Notes\n\n" + String.join("\n\n", sections);
    }

    private String readProjects() {
        if (!Files.exists(PROJECTS_DIR)) return "";
        var projects = new ArrayList<String>();
        try (Stream<Path> s = Files.list(PROJECTS_DIR).sorted()) {
            for (var dir : s.filter(Files::isDirectory).toList()) {
                var slug = dir.getFileName().toString();
                var projectMd = dir.resolve("project.md");
                if (!Files.exists(projectMd)) continue;
                try {
                    var content = Files.readString(projectMd, StandardCharsets.UTF_8).strip();
                    eventBus.publish(Map.of("type", "knowledge_file", "file", slug,
                            "label", "Projects", "status", content.isEmpty() ? "empty" : "loaded",
                            "chars", content.length()));
                    if (!content.isEmpty()) projects.add(content);
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        if (projects.isEmpty()) return "";
        return "## Active Projects\n\n" + String.join("\n\n---\n\n", projects);
    }
}
