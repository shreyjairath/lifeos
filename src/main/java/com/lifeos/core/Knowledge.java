package com.lifeos.core;

import com.lifeos.store.AgentNotesStore;
import com.lifeos.store.ProjectStore;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/**
 * Loads notes and project knowledge into prompt sections.
 */
@Component
public class Knowledge {

    private final EventBus eventBus;
    private final AgentNotesStore store;
    private final ProjectStore projectStore;

    public Knowledge(EventBus eventBus, AgentNotesStore store, ProjectStore projectStore) {
        this.eventBus = eventBus;
        this.store = store;
        this.projectStore = projectStore;
    }

    public String getKnowledgeSection() {
        var parts = new ArrayList<String>();
        var noteFiles = store.listNotes();
        if (!noteFiles.isEmpty()) {
            var sections = new ArrayList<String>();
            for (var filename : noteFiles) {
                var content = store.readNote(filename);
                if (content == null || content.isBlank()) continue;
                var title = filename.replaceAll("\\.md$", "").replace("-", " ").replace("_", " ");
                title = title.substring(0, 1).toUpperCase() + title.substring(1);
                sections.add("### " + title + "\n" + content.strip());
                eventBus.publish(Map.of("type", "knowledge_file", "file", filename,
                        "label", "Notes", "status", "loaded", "chars", content.length()));
            }
            if (!sections.isEmpty()) {
                parts.add("## Previous Notes\n\n" + String.join("\n\n", sections));
            }
        }
        var projects = readProjects();
        if (!projects.isEmpty()) parts.add(projects);
        return String.join("\n\n", parts);
    }

    public static String loadPromptPart(String name) {
        var override = Path.of(System.getProperty("user.dir")).resolve(".user-data/prompt-parts/" + name);
        if (Files.exists(override)) {
            try { return Files.readString(override, StandardCharsets.UTF_8).strip(); } catch (IOException ignored) {}
        }
        try (var stream = Knowledge.class.getResourceAsStream("/prompt-parts/" + name)) {
            if (stream == null) return "";
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            return "";
        }
    }

    /** Returns the active instructions filename, falling back to the default. */
    public static String loadActiveInstructions() {
        var pointer = Path.of(System.getProperty("user.dir")).resolve(".user-data/prompt-parts/.active-instructions");
        if (Files.exists(pointer)) {
            try {
                var name = Files.readString(pointer, StandardCharsets.UTF_8).strip();
                if (!name.isEmpty()) return name;
            } catch (IOException ignored) {}
        }
        return "assistant-instructions.md";
    }

    /** Writes the active instructions pointer. */
    public static void saveActiveInstructions(String name) throws IOException {
        var dir = Path.of(System.getProperty("user.dir")).resolve(".user-data/prompt-parts");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve(".active-instructions"), name, StandardCharsets.UTF_8);
    }

    // ── Private ──────────────────────────────────────────────────────────────────

    private String readProjects() {
        var projectDirs = projectStore.listProjectDirs();
        if (projectDirs.isEmpty()) return "";
        var projects = new ArrayList<String>();
        for (var dir : projectDirs) {
            var slug = dir.getFileName().toString();
            var content = projectStore.readProjectMd(slug).strip();
            eventBus.publish(Map.of("type", "knowledge_file", "file", slug,
                    "label", "Projects", "status", content.isEmpty() ? "empty" : "loaded",
                    "chars", content.length()));
            if (!content.isEmpty()) {
                projects.add(content);
            }
        }
        if (projects.isEmpty()) return "";
        return "## Active Projects\n\n" + String.join("\n\n---\n\n", projects);
    }
}
