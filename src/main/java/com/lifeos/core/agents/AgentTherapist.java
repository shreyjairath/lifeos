package com.lifeos.core.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.agents.executor.BaseAgent;
import com.lifeos.core.agents.executor.Cancellation;
import com.lifeos.core.agents.executor.Executor;
import com.lifeos.core.agents.tools.ToolsRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * The therapist agent.
 *
 * Two modes:
 *   chat()    — user-facing conversation; reads therapist notes + session history, does not write notes
 *   reflect() — post-session background job; updates .user-data/therapist/ based on transcript
 */
@Component
public class AgentTherapist extends BaseAgent {

    private static final Logger log = LoggerFactory.getLogger(AgentTherapist.class);
    private static final String PROMPT_BASE = "agents/agent_therapist";
    private static final String WHO_YOU_ARE_FILE = "who-you-are.md";
    private static final String INSTRUCTIONS_FILE = "instructions.md";
    private static final String REFLECT_FILE = "reflect.md";

    static final Path THERAPIST_DIR = Path.of(System.getProperty("user.dir"))
            .resolve(".user-data/therapist").normalize();

    // Tools available during conversation — therapist dir (write) + assistant dir (read-only) + session recall + reminders
    private static final Set<String> CHAT_TOOLS = Set.of(
            "therapist_bash", "assistant_bash_readonly", "list_sessions", "read_session_summary",
            "read_session_transcript", "get_current_datetime",
            "set_reminder", "list_reminders", "delete_reminder");

    // Tools available during reflection — full bash access to therapist dir, read-only to assistant + reminders
    private static final Set<String> REFLECT_TOOLS = Set.of(
            "therapist_bash", "assistant_bash_readonly", "get_current_datetime",
            "set_reminder", "list_reminders", "delete_reminder");

    public AgentTherapist(Executor executor, ToolsRegistry toolsRegistry,
                          SessionManager session, EventBus eventBus,
                          Cancellation cancellation, AppConfig config) {
        super(executor, toolsRegistry, session, eventBus, cancellation, config);
    }

    @Override
    protected String persona() {
        return PromptParts.load(PROMPT_BASE, WHO_YOU_ARE_FILE) + "\n\n"
                + PromptParts.load(PROMPT_BASE, INSTRUCTIONS_FILE);
    }

    @Override
    protected List<Map<String, Object>> tools() {
        return toolsRegistry.getTools().stream()
                .filter(t -> CHAT_TOOLS.contains(t.get("name")))
                .toList();
    }

    // ── Reflection mode ───────────────────────────────────────────────────────

    @Override
    protected String reflectPrompt() {
        return PromptParts.load(PROMPT_BASE, WHO_YOU_ARE_FILE) + "\n\n"
                + PromptParts.load(PROMPT_BASE, REFLECT_FILE);
    }

    @Override
    protected List<Map<String, Object>> reflectTools() {
        return toolsRegistry.getTools().stream()
                .filter(t -> REFLECT_TOOLS.contains(t.get("name")))
                .toList();
    }

    // ── Shared knowledge loader ───────────────────────────────────────────────

    public static String loadNotes() {
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
                } catch (IOException ignored) {}
            }
        } catch (IOException ignored) {}
        if (sections.isEmpty()) return "";
        return String.join("\n\n", sections);
    }
}
