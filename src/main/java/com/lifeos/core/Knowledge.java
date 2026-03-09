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
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Stream;

/**
 * Load environment/ and user/ knowledge base files into a system prompt.
 */
@Component
public class Knowledge {

    private static final Logger log = LoggerFactory.getLogger(Knowledge.class);
    private static final Path USER_DATA = Path.of(System.getProperty("user.dir"))
            .resolve("../.user-data").normalize();
    private static final List<String> ONBOARDING_FILES = List.of(
            "identity", "routines", "tools", "services", "integrations");
    private static final DateTimeFormatter DATE_FMT =
            DateTimeFormatter.ofPattern("MMM dd, yyyy HH:mm").withZone(ZoneId.systemDefault());

    private final EventBus eventBus;
    private final Memory memory;
    private final ObjectMapper mapper = new ObjectMapper();

    public Knowledge(EventBus eventBus, Memory memory) {
        this.eventBus = eventBus;
        this.memory = memory;
    }

    public String prepareSystemPrompt(String convId) {
        eventBus.publish(Map.of("type", "boot_start"));

        var knowledge = prepareKnowledge();
        var incompleteTopics = incompleteOnboardingTopics();
        var sessionContext = loadSessionContext(convId);

        var persona = loadPart("persona.md");
        String system;

        if (!incompleteTopics.isEmpty()) {
            var onboarding = onboardingPrompt(incompleteTopics);
            system = persona + "\n\n" + knowledge + "\n\n" + onboarding;
        } else {
            system = persona + "\n\n" + knowledge;
        }

        if (!sessionContext.isEmpty()) {
            system += "\n\n" + sessionContext;
        }

        system = system.strip();
        eventBus.publish(Map.of("type", "system_prompt", "chars", system.length()));
        eventBus.publish(Map.of("type", "boot_done"));
        return system;
    }


    // ── Private ──────────────────────────────────────────────────────────────────

    private String loadPart(String name) {
        try (var stream = getClass().getResourceAsStream("/prompt-parts/" + name)) {
            if (stream == null) return "";
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8).strip();
        } catch (IOException e) {
            log.warn("Failed to load prompt part {}: {}", name, e.getMessage());
            return "";
        }
    }

    private String prepareKnowledge() {
        var parts = new ArrayList<String>();
        var env = readDir(USER_DATA.resolve("environment"), "Environment");
        if (!env.isEmpty()) parts.add(env);
        var user = readDir(USER_DATA.resolve("user"), "About User");
        if (!user.isEmpty()) parts.add(user);
        var projects = readProjects(USER_DATA.resolve("projects"));
        if (!projects.isEmpty()) parts.add(projects);
        return String.join("\n\n", parts);
    }

    private String readDir(Path dirPath, String label) {
        if (!Files.exists(dirPath)) return "";
        var sections = new ArrayList<String>();
        try (Stream<Path> files = Files.list(dirPath).sorted()) {
            for (var mdFile : files.filter(p -> p.toString().endsWith(".md")).toList()) {
                try {
                    var content = Files.readString(mdFile, StandardCharsets.UTF_8).strip();
                    var status = content.isEmpty() ? "empty" : "loaded";
                    eventBus.publish(Map.of("type", "knowledge_file", "file", stem(mdFile),
                            "label", label, "status", status, "chars", content.length()));
                    if (!content.isEmpty()) {
                        var title = stem(mdFile).replace("-", " ").replace("_", " ");
                        title = title.substring(0, 1).toUpperCase() + title.substring(1);
                        sections.add("### " + title + "\n" + content);
                    }
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        if (sections.isEmpty()) return "";
        return "## " + label + "\n\n" + String.join("\n\n", sections);
    }

    private String readProjects(Path projectsPath) {
        if (!Files.exists(projectsPath)) return "";
        var projects = new ArrayList<String>();
        try (Stream<Path> files = Files.list(projectsPath).sorted()) {
            for (var mdFile : files.filter(p -> p.toString().endsWith(".md")).toList()) {
                try {
                    var content = Files.readString(mdFile, StandardCharsets.UTF_8).strip();
                    eventBus.publish(Map.of("type", "knowledge_file", "file", stem(mdFile),
                            "label", "Projects", "status", content.isEmpty() ? "empty" : "loaded",
                            "chars", content.length()));
                    if (!content.isEmpty()) {
                        projects.add("### " + stem(mdFile) + "\n" + content);
                    }
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        if (projects.isEmpty()) return "## Active Projects\n\nNo active projects yet.";
        return "## Active Projects\n\n" + String.join("\n\n", projects);
    }

    private String loadSessionContext(String convId) {
        if (convId == null || convId.isEmpty()) return "";
        var sections = new ArrayList<String>();

        var convSummary = memory.getConvSummary(convId);
        if (!convSummary.isEmpty()) {
            eventBus.publish(Map.of("type", "knowledge_file", "file", "conv_summary",
                    "label", "Conversation Summary", "status", "loaded", "chars", convSummary.length()));
            sections.add("## Conversation Summary\n\n" + convSummary);
        }

        var sdir = memory.summariesDir(convId);
        if (Files.exists(sdir)) {
            try (Stream<Path> files = Files.list(sdir).sorted()) {
                var mdFiles = files.filter(p -> p.toString().endsWith(".md")).toList();
                if (!mdFiles.isEmpty()) {
                    var last = mdFiles.getLast();
                    var content = Files.readString(last, StandardCharsets.UTF_8).strip();
                    if (!content.isEmpty()) {
                        var ts = Long.parseLong(stem(last));
                        var dateStr = DATE_FMT.format(Instant.ofEpochSecond(ts));
                        eventBus.publish(Map.of("type", "knowledge_file", "file", "last_session",
                                "label", "Last Session", "status", "loaded", "chars", content.length()));
                        sections.add("## Last Session — " + dateStr + "\n\n" + content);
                    }
                }
            } catch (Exception ignored) {}
        }

        if (sections.isEmpty()) return "";
        return "# Session Context\n\n" + String.join("\n\n", sections);
    }

    private List<String> incompleteOnboardingTopics() {
        var onboarding = readOnboardingStatus();
        for (var topic : ONBOARDING_FILES) {
            eventBus.publish(Map.of("type", "onboarding_status", "file", topic,
                    "status", onboarding.getOrDefault(topic, "pending")));
        }
        return ONBOARDING_FILES.stream()
                .filter(t -> !"done".equals(onboarding.get(t)))
                .toList();
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> readOnboardingStatus() {
        var statusFile = USER_DATA.resolve("status.json");
        if (!Files.exists(statusFile)) {
            var m = new LinkedHashMap<String, String>();
            ONBOARDING_FILES.forEach(f -> m.put(f, "pending"));
            return m;
        }
        try {
            var data = mapper.readValue(Files.readString(statusFile, StandardCharsets.UTF_8),
                    new TypeReference<Map<String, Object>>() {});
            var ob = (Map<String, String>) data.getOrDefault("onboarding", Map.of());
            return new LinkedHashMap<>(ob);
        } catch (Exception e) {
            var m = new LinkedHashMap<String, String>();
            ONBOARDING_FILES.forEach(f -> m.put(f, "pending"));
            return m;
        }
    }

    private String onboardingPrompt(List<String> incompleteTopics) {
        var topicsList = String.join(", ", incompleteTopics);
        return loadPart("onboarding.md").replace("{pending_files}", topicsList);
    }

    private static String stem(Path path) {
        var name = path.getFileName().toString();
        var dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }
}
