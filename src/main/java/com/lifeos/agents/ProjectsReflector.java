package com.lifeos.agents;

import com.lifeos.core.Knowledge;
import com.lifeos.core.SessionManager;
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
 * Updates active project snapshots and next-actions after a session ends.
 * Self-contained: owns its model, prompt, and tool list.
 */
@Component
public class ProjectsReflector {

    private static final Logger log = LoggerFactory.getLogger(ProjectsReflector.class);
    private static final String MODEL = "claude-haiku-4-5-20251001";
    private static final Set<String> TOOLS = Set.of(
            "list_projects", "read_project", "create_project", "update_project",
            "add_project_file", "read_project_file", "update_project_file", "delete_project_file");

    private final Executor executor;
    private final ToolsRegistry toolsRegistry;

    public ProjectsReflector(Executor executor, ToolsRegistry toolsRegistry) {
        this.executor = executor;
        this.toolsRegistry = toolsRegistry;
    }

    /**
     * Runs the projects reflection agent over the given session history.
     * Returns a short summary of what was updated, or null if nothing.
     */
    public String run(List<Map<String, Object>> history) {
        var transcript = SessionManager.buildTranscript(history);
        if (transcript.isBlank()) return null;

        var tools = toolsRegistry.getTools().stream()
                .filter(t -> TOOLS.contains(t.get("name")))
                .toList();

        var messages = List.<Map<String, Object>>of(
                Map.of("role", "user", "content", "Conversation to reflect on:\n\n" + transcript));

        try {
            var summary = executor.runLoop("_reflect_projects", new ArrayList<>(messages),
                            Knowledge.loadPromptPart("reflect-projects.md"), MODEL, tools)
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
            log.warn("Projects reflection failed: {}", e.getMessage());
        }
        return null;
    }
}
