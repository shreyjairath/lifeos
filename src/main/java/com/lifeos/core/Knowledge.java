package com.lifeos.core;

import com.lifeos.executor.Executor;
import com.lifeos.executor.ToolsRegistry;
import com.lifeos.executor.events.AgentAppendEvent;
import com.lifeos.store.KnowledgeStore;
import com.lifeos.store.ProjectStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/**
 * Loads environment/ user/ project knowledge files into prompt sections.
 */
@Component
public class Knowledge {

    private static final Logger log = LoggerFactory.getLogger(Knowledge.class);
    private static final List<String> ONBOARDING_FILES = List.of();
    private static final String HAIKU_MODEL = "claude-haiku-4-5-20251001";
    private static final Set<String> REFLECT_TOOL_NAMES = Set.of(
            "list_notes", "read_note", "write_note", "delete_note",
            "create_project", "update_project", "write_file", "update_file",
            "list_projects", "read_project",
            "add_project_file", "read_project_file", "update_project_file", "delete_project_file");

    private final EventBus eventBus;
    private final Executor executor;
    private final ToolsRegistry toolsRegistry;
    private final Hooks hooks;
    private final KnowledgeStore store;
    private final ProjectStore projectStore;

    public Knowledge(EventBus eventBus, Executor executor, ToolsRegistry toolsRegistry, Hooks hooks,
                     KnowledgeStore store, ProjectStore projectStore) {
        this.eventBus = eventBus;
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
        this.hooks = hooks;
        this.store = store;
        this.projectStore = projectStore;
    }

    /**
     * Runs Haiku to update the knowledge base from the session history. Returns summary or null.
     */
    public String reflect(List<Map<String, Object>> history, String sessionId) {
        var transcript = Session.buildTranscript(history);
        if (transcript.isEmpty()) return null;

        var reflectTools = toolsRegistry.getTools().stream()
                .filter(t -> REFLECT_TOOL_NAMES.contains(t.get("name")))
                .toList();

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Conversation to reflect on:\n\n" + transcript));

        var summary = executor.runLoop("_reflect", new ArrayList<>(messages), loadPromptPart("reflect.md"), HAIKU_MODEL, reflectTools)
                .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                .cast(AgentAppendEvent.class)
                .flatMapIterable(AgentAppendEvent::content)
                .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                .map(b -> (String) ((Map<?, ?>) b).get("text"))
                .reduce(String::concat)
                .defaultIfEmpty("")
                .block();

        if (!summary.isEmpty() && !"nothing to save".equalsIgnoreCase(summary.strip())) {
            hooks.fire("on_kb_reflect", Map.of("session_id", sessionId, "summary", summary));
            return summary;
        }
        return null;
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
                parts.add("## Notes\n\n" + String.join("\n\n", sections));
            }
        }
        var projects = readProjects();
        if (!projects.isEmpty()) parts.add(projects);
        return String.join("\n\n", parts);
    }

    public List<String> incompleteOnboardingTopics() {
        var onboarding = store.readOnboardingStatus();
        for (var topic : ONBOARDING_FILES) {
            eventBus.publish(Map.of("type", "onboarding_status", "file", topic,
                    "status", onboarding.getOrDefault(topic, "pending")));
        }
        return ONBOARDING_FILES.stream()
                .filter(t -> !"done".equals(onboarding.get(t)))
                .toList();
    }

    public String getOnboardingSection(List<String> incompleteTopics) {
        return loadPromptPart("onboarding.md").replace("{pending_files}", String.join(", ", incompleteTopics));
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private String readDir(String subdir, String label) {
        var mdFiles = store.listMarkdownFiles(subdir);
        if (mdFiles.isEmpty()) return "";
        var sections = new ArrayList<String>();
        for (var mdFile : mdFiles) {
            var filename = mdFile.getFileName().toString();
            var content = store.readText(subdir, filename).strip();
            var status = content.isEmpty() ? "empty" : "loaded";
            eventBus.publish(Map.of("type", "knowledge_file", "file", stem(mdFile),
                    "label", label, "status", status, "chars", content.length()));
            if (!content.isEmpty()) {
                var title = stem(mdFile).replace("-", " ").replace("_", " ");
                title = title.substring(0, 1).toUpperCase() + title.substring(1);
                sections.add("### " + title + "\n" + content);
            }
        }
        if (sections.isEmpty()) return "";
        return "## " + label + "\n\n" + String.join("\n\n", sections);
    }

    private String readProjects() {
        var projectDirs = projectStore.listProjectDirs();
        if (projectDirs.isEmpty()) return "## Active Projects\n\nNo active projects yet.";
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
        if (projects.isEmpty()) return "## Active Projects\n\nNo active projects yet.";
        return "## Active Projects\n\n" + String.join("\n\n---\n\n", projects);
    }

    static String loadPromptPart(String name) {
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

    private static String stem(Path path) {
        var name = path.getFileName().toString();
        var dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }
}
