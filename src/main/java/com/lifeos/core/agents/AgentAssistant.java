package com.lifeos.core.agents;

import com.lifeos.config.AppConfig;
import com.lifeos.core.helpers.EventBus;
import com.lifeos.core.helpers.PromptParts;
import com.lifeos.core.managers.SessionManager;
import com.lifeos.core.agents.executor.BaseAgent;
import com.lifeos.core.agents.executor.Cancellation;
import com.lifeos.core.agents.executor.Executor;
import com.lifeos.core.agents.tools.ToolsRegistry;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;

@Component
public class AgentAssistant extends BaseAgent {

    private static final String PROMPT_BASE = "agents/agent_assistant";
    private static final String WHO_YOU_ARE_FILE = "who-you-are.md";
    private static final String INSTRUCTIONS_FILE = "instructions.md";
    private static final String REFLECT_FILE = "reflect.md";

    // Tools excluded from chat — therapist_bash (full write) must not be available; use readonly variant
    private static final Set<String> CHAT_TOOLS_EXCLUDE = Set.of("therapist_bash", "assistant_bash_readonly");

    private static final Set<String> REFLECT_TOOLS = Set.of(
            "assistant_bash", "therapist_bash_readonly", "get_current_datetime",
            "set_reminder", "list_reminders", "delete_reminder");

    public AgentAssistant(Executor executor, ToolsRegistry toolsRegistry,
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
    protected String reflectPrompt() {
        return PromptParts.load(PROMPT_BASE, REFLECT_FILE);
    }

    @Override
    protected List<Map<String, Object>> tools() {
        return toolsRegistry.getTools().stream()
                .filter(t -> !CHAT_TOOLS_EXCLUDE.contains(t.get("name")))
                .toList();
    }

    @Override
    protected List<Map<String, Object>> reflectTools() {
        return toolsRegistry.getTools().stream()
                .filter(t -> REFLECT_TOOLS.contains(t.get("name")))
                .toList();
    }
}
