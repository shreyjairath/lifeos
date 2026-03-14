package com.lifeos.agents;

import com.lifeos.core.Knowledge;
import com.lifeos.agents.executor.Executor;
import com.lifeos.agents.executor.ToolsRegistry;
import com.lifeos.agents.executor.events.AgentAppendEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;


/**
 * Persists new facts about the user to the notes directory after a session ends.
 * Self-contained: owns its model, prompt, and tool list.
 */
@Component
public class NotesReflector {

    private static final Logger log = LoggerFactory.getLogger(NotesReflector.class);
    private static final String MODEL = "claude-haiku-4-5-20251001";
    private static final Set<String> TOOLS = Set.of(
            "list_notes", "read_note", "write_note", "delete_note", "grep_notes",
            "get_current_datetime");

    private final Executor executor;
    private final ToolsRegistry toolsRegistry;

    public NotesReflector(Executor executor, ToolsRegistry toolsRegistry) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
    }

    /**
     * Runs the notes reflection agent over the given transcript.
     * Returns a short summary of what was saved, or null if nothing.
     */
    public String run(String transcript) {
        if (transcript.isBlank()) return null;

        var tools = toolsRegistry.getTools().stream()
                .filter(t -> TOOLS.contains(t.get("name")))
                .toList();

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Conversation to reflect on:\n\n" + transcript));

        try {
            var summary = executor.runLoop("_reflect_notes", new ArrayList<>(messages),
                            Knowledge.loadPromptPart("reflect-notes.md"), MODEL, tools)
                    .filter(e -> e instanceof AgentAppendEvent ae && "assistant".equals(ae.role()))
                    .cast(AgentAppendEvent.class)
                    .flatMapIterable(AgentAppendEvent::content)
                    .filter(b -> b instanceof Map<?, ?> m && "text".equals(m.get("type")))
                    .map(b -> (String) ((Map<?, ?>) b).get("text"))
                    .reduce(String::concat)
                    .defaultIfEmpty("")
                    .block();

            if (summary != null && !summary.isBlank() && !"nothing to save".equalsIgnoreCase(summary.strip())) {
                return summary;
            }
        } catch (Exception e) {
            log.warn("Notes reflection failed: {}", e.getMessage());
        }
        return null;
    }
}
